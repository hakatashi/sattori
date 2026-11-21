# 東方Projectゲームへの自動メニュー操作MOD技術ノート

## 概要

東方花映塚 (TH09) に対して DLL インジェクションでキー入力を自動化した際に得られた技術的知見をまとめる。他の東方Projectシリーズ作品 (TH06〜TH18系) への応用を念頭に置いている。

---

## 1. 東方Projectゲームの入力アーキテクチャ

### キー状態の二層構造

東方ゲームはキー入力を **二段階** で処理する。

```
[DirectInput GetDeviceState] → [BYTE[256] 生バッファ]
         ↓
  [ゲーム独自の変換関数]
         ↓
  [key_states 構造体] ← ゲームプレイ AI はここを読む
```

| 場面 | 入力を読む場所 |
|------|--------------|
| **メニュー** | DirectInput の生バッファ (`GetDeviceState` が返す `BYTE[256]`) |
| **ゲームプレイ中** | ゲーム独自の `key_states` 構造体 |

この二層構造が存在するため、**メニューとゲームプレイで有効な注入手法が異なる**。

### `key_states` 構造体 (TH09 ver 1.5a の例)

| フィールド | 説明 |
|-----------|------|
| `keys` | 現フレームで押されているキーのビットマスク |
| `prev_keys` | 前フレームのキー状態 |
| `start_pushing_keys` | 今フレームで新たに押されたキー (`keys & ~prev_keys`) |
| `start_leaving_keys` | 今フレームで離されたキー |

ゲームプレイ AI はこの構造体に直接 OR 書き込みする。  
**メニューはこの構造体を読まない** ため、`key_states` への書き込みはメニュー操作に効果がない。

---

## 2. 採用手法: DirectInput vtable フック

### フック連鎖の構造

```
IAT フック                   vtable フック                vtable フック
DirectInput8Create  →  IDirectInput8::CreateDevice  →  IDirectInputDevice8::GetDeviceState
      ↓                           ↓                              ↓
  IDirectInput8* 取得       IDirectInputDevice8* 取得      バッファに DIK_ キーを注入
```

### なぜこの手法が機能するか

`GetDeviceState` はゲームのフレームループ内で毎フレーム呼ばれ、その返値バッファをゲームが直接読む。フックを挟んでオリジナル関数の呼び出し後にバッファを改ざんすることで、**メニュー・ゲームプレイの両方**で確実にキー入力として認識させられる。

### 実装の骨格

```cpp
// 1. IAT フックのインストール (DLL_PROCESS_ATTACH 時点で実施)
//    ゲームが DirectInput8Create を呼ぶ前に IAT を書き換える
void InstallIATHook() {
    // PE ヘッダを走査して DINPUT8.dll の IAT エントリを書き換える
    // → g_orig_DI8Create に本物の関数ポインタを保存
    HookIATEntry("DINPUT8.dll", "DirectInput8Create",
                 (void*)MyDirectInput8Create, (void**)&g_orig_DI8Create);
}

// 2. DirectInput8Create フック
//    IDirectInput8 の vtable[3] (CreateDevice) を書き換える
HRESULT WINAPI MyDirectInput8Create(...) {
    HRESULT hr = g_orig_DI8Create(...);
    if (SUCCEEDED(hr)) {
        void** vtable = *(void***)*ppvOut;
        PatchVTable(vtable, 3, (void*)MyCreateDevice, (void**)&g_orig_CreateDevice);
    }
    return hr;
}

// 3. CreateDevice フック
//    キーボードデバイスの vtable[9] (GetDeviceState) を書き換える
HRESULT __stdcall MyCreateDevice(IDirectInput8A* pThis, REFGUID rguid, ...) {
    HRESULT hr = g_orig_CreateDevice(pThis, rguid, lplpDevice, pUnk);
    if (SUCCEEDED(hr) && *lplpDevice) {
        void** vtable = *(void***)*lplpDevice;
        PatchVTable(vtable, 9, (void*)MyGetDeviceState, (void**)&g_orig_GetDeviceState);
    }
    return hr;
}

// 4. GetDeviceState フック
//    オリジナルの後でバッファを改ざんする
HRESULT __stdcall MyGetDeviceState(IDirectInputDevice8A* pThis, DWORD cbData, LPVOID lpvData) {
    HRESULT hr = g_orig_GetDeviceState(pThis, cbData, lpvData);
    if (SUCCEEDED(hr) && cbData >= 256) {
        BYTE* buf = (BYTE*)lpvData;
        // 注入したいキーのバイトを 0x80 にする
        // 例: buf[0xD0] = 0x80;  // DIK_DOWN
        //     buf[0x2C] = 0x80;  // DIK_Z
    }
    return hr;
}
```

### vtable インデックス (IDirectInput8A / IDirectInputDevice8A)

| インターフェース | vtable インデックス | メソッド名 |
|----------------|------------------|-----------|
| `IDirectInput8A` | 3 | `CreateDevice` |
| `IDirectInputDevice8A` | 7 | `Acquire` |
| `IDirectInputDevice8A` | 8 | `Unacquire` |
| `IDirectInputDevice8A` | **9** | **`GetDeviceState`** ← 注入ポイント |

### vtable パッチの実装

```cpp
static void PatchVTable(void** vtable, int index, void* newFunc, void** outOld)
{
    DWORD oldProt;
    VirtualProtect(&vtable[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
    if (outOld) *outOld = vtable[index];
    vtable[index] = newFunc;
    VirtualProtect(&vtable[index], sizeof(void*), oldProt, &oldProt);
}
```

---

## 3. IAT フックの実装

PE ヘッダの Import Address Table を走査して書き換える。

```cpp
static bool HookIATEntry(const char* dllName, const char* funcName,
                         void* newFunc, void** outOld)
{
    HMODULE hExe = GetModuleHandle(NULL);  // メインの .exe
    BYTE* base = (BYTE*)hExe;
    auto* dos = (IMAGE_DOS_HEADER*)base;
    auto* nt  = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress);

    for (; imp->Name; imp++) {
        if (_stricmp((char*)(base + imp->Name), dllName) != 0) continue;

        auto* thunk  = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
            if (_stricmp(byName->Name, funcName) != 0) continue;

            DWORD oldProt;
            VirtualProtect(&thunk->u1.Function, sizeof(void*),
                           PAGE_EXECUTE_READWRITE, &oldProt);
            if (outOld) *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}
```

**重要**: IAT フックは `DLL_PROCESS_ATTACH` (最初期) に行うこと。ゲームが `DirectInput8Create` を呼ぶ前に書き換えなければならない。

---

## 4. DIK スキャンコード早見表

東方ゲームでよく使うキーの DirectInput スキャンコード:

| キー | DIK コード | 説明 |
|------|-----------|------|
| Z | `0x2C` | ショット・決定 |
| X | `0x2D` | ボム・キャンセル |
| Shift | `0x2A` | 低速移動 |
| Esc | `0x01` | メニュー・ポーズ |
| ↑ | `0xC8` | 上 (拡張キー) |
| ↓ | `0xD0` | 下 (拡張キー) |
| ←| `0xCB` | 左 (拡張キー) |
| → | `0xCD` | 右 (拡張キー) |
| Enter | `0x1C` | 決定 (一部作品) |

---

## 5. ゲーム起動完了の検出

固定時間待ちは環境依存で不安定。代わりに以下を組み合わせる:

1. **HWND の出現を待つ**: ゲームウィンドウが作成されるまでポーリング
2. **HWND の安定を待つ**: 多くの東方ゲームは起動直後にウィンドウを再作成する。800ms 程度変化がなければ安定と判断
3. **DI フック活性を確認**: `GetDeviceState` のフックが設定された = ゲームが DirectInput を初期化した
4. **追加バッファ (1〜2秒)**: タイトル画面のアニメーション等を待つ

```
起動    HWND出現  HWND再作成  HWND安定  DI初期化  バッファ  ナビ開始
  |        |          |          |          |         |        |
  0s      0.7s       2.5s       3.5s      <4s        5.5s   (旧: 9s)
```

---

## 6. キー入力のタイミング

`GetDeviceState` のバッファに書き込んだキーは **次の `GetDeviceState` 呼び出しまで** しか有効でない (次回呼び出しで上書きされる)。

- **保持時間**: ゲームが 60fps なら 1フレーム = 16ms。確実に認識させるには **80〜150ms** 程度セットし続ける
- **キー間のウェイト**: カーソル移動は **200〜300ms**、画面遷移を伴う確定 (Z) は **500〜800ms**
- **実装**: フラグ (`g_inject_dik[]`) をセットし、`Sleep` でその時間保持した後クリアする

```cpp
void PressKey(BYTE dik, unsigned int hold_ms = 80) {
    g_inject_dik[dik] = 1;    // GetDeviceState フックが buf[dik]=0x80 を返す
    Sleep(hold_ms);
    g_inject_dik[dik] = 0;
    Sleep(80);                  // リリース期間 (次フレームでキーなしとして処理させる)
}
```

---

## 7. 他タイトルへの移植チェックリスト

1. **DirectInput バージョン確認**: TH06〜TH09 は `dinput8.dll` (DirectInput 8)。TH06 以前は `dinput.dll` (DirectInput 7 以前) の可能性あり
2. **exe の import 確認**: `strings th1X.exe | grep -i dinput` で使用 DLL を確認
3. **グローバル変数アドレス**: IDA Pro / Ghidra で `key_states` 相当の構造体アドレスを特定 (ゲームプレイ AI を作る場合)
4. **メニュー構造の把握**: 各作品でメニュー階層・選択肢の数・カーソル初期位置を実機確認
5. **ウィンドウ再作成タイミング**: 起動後に HWND が変わるかどうかを確認。変わる場合は安定検出を使う
6. **難易度選択の有無**: 作品によって難易度選択画面の位置が異なる

---

## 8. DLL インジェクション環境

本プロジェクトでは [ka_ai_duka](https://github.com/kory33/ka_ai_duka) の DLL インジェクタを使用。独自インジェクタを作る場合:

- `CreateProcess` → `WriteProcessMemory` → `CreateRemoteThread` (LoadLibrary) が標準的
- または `SetWindowsHookEx` でプロセスに DLL を注入
- 32bit ゲームには 32bit DLL が必要 (東方シリーズは全て 32bit)
- `DLL_PROCESS_ATTACH` で IAT フックまで完了させること (ゲームの初期化より前)

---

## まとめ

東方Projectゲームのメニュー自動操作には **DirectInput `GetDeviceState` の vtable フック** を採用している。IAT フック → vtable フック (CreateDevice → GetDeviceState) の3段フックでバッファを改ざんすることで、確実なキー操作が実現できる。

この手法はメニュー・ゲームプレイ両方で機能し、他の東方シリーズ作品でも同じアーキテクチャが使われている限り同様に適用できる。
