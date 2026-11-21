# フェーズ74: th06c(東方紅魔郷: Classic)の環境構築・Steam要求回避・自動操作MOD実装

## 背景

2026年9月10日に『東方紅魔郷：New Classic』がSteam等で発売され、これに同梱される形で
オリジナル再現版『東方紅魔郷: Classic』(以下th06c)が配信された。ゲーム内バージョン表記は
**ver 1.03**(従来の東方紅魔郷の最新は ver 1.02h)。本フェーズではth06cを録画パイプラインに
乗せるための環境構築・Steam要求の回避・リプレイ自動再生MODの実装までを行った。

ユーザーがゲーム資産を `games/th06c/` に配置済み(Steam経由で配布されているデータのコピー)。
検証用リプレイも `games/th06c/replay/` に配置済み。

作業開始前に `sudo systemctl stop sattori-home-worker` を実行し、本マシンで録画ジョブが
走っていないことを確認した(直前のジョブ `310fcb06-...` は14:11:50に正常終了済み、
`docker ps --filter name=sattori-job` が空であることも確認)。

## 1. th06c.exeの静的解析

`games/th06c/` の構成(抜粋):

```
th06c.exe          4,039,168 bytes   PE32+ executable (GUI) x86-64
steam_api64.dll      317,080 bytes   PE32+ DLL x86-64(正規のSteamworks再頒布物)
th06CM/ED/FN/IN/MD/ST/TL.dat         オリジナルth06と同名のデータアーカイブ
bgm/th06_01.wav 〜 th06_17.wav        非圧縮WAVのBGM(オリジナルはCD-DA/MIDI)
th06.cfg (28 bytes)  th06.env (12 bytes)
replay/th6_01.rpy 〜 th6_06.rpy      ユーザー提供の検証用リプレイ
score.dat            Extraモード解放済みのセーブデータ
```

### 1.1 アーキテクチャ

`th06c.exe` は **PE32+ (x86-64)**。既存の全MOD・injectorは32bit(`i686-w64-mingw32`)
ビルドなので、**そのままでは一切流用できない**。本フェーズで64bit版を新規に用意した。

PEセクションは `.text/.rdata/.data/.pdata/.rsrc/.reloc` の標準MSVC構成で、
Steam CEG特有の `.bind` セクションは無く、エントリポイント(RVA 0x284290)も `.text` 内。
つまり**実行ファイル自体はDRMラッパーで包まれていない**。

### 1.2 インポート

静的インポートは `steam_api64.dll` / `KERNEL32` / `USER32` / `MSVCP140` / `WINMM` /
`VCRUNTIME140(_1)` / `api-ms-win-crt-*` のみ。**D3D系・DirectInput系の静的インポートは無い**。

`steam_api64.dll` からは以下9関数のみをインポートしている:

```
SteamInternal_ContextInit            SteamInternal_FindOrCreateUserInterface
SteamAPI_RestartAppIfNecessary       SteamAPI_RegisterCallback
SteamInternal_SteamAPI_Init          SteamAPI_GetHSteamUser
SteamAPI_Shutdown                    SteamAPI_RunCallbacks
SteamAPI_UnregisterCallback
```

USER32の静的インポートは18関数のみで、`CreateWindowEx`・`PeekMessage` 等が含まれない。
文字列テーブルには `User32.dll` / `CreateWindowExW` / `PeekMessageW` / `GetKeyboardState` /
`GetAsyncKeyState` / `XInputGetState` / `joyGetPosEx` 等が並んでおり、**多くのWin32 APIを
`LoadLibrary` + `GetProcAddress` で動的に解決している**ことが分かる。これは後述する入力
フック方式の選定に直結する。

### 1.3 レンダラ・エンジン

文字列から `D3D11CreateDevice` / `CreateDXGIFactory(1,2)` / `Direct3DCreate9(Ex)` /
`DSound.DLL` / `Mfplat.dll` / `Mfreadwrite.dll` / `usp10.dll` / `Base_VERTEX2DSHADER.vso` /
`Gauss_16Pixel_PS.pso` / `data/title/th06logo.dds` などが見つかる。**DXライブラリ(DxLib)系の
エンジンでオリジナルth06を再実装したもの**と考えてよい。D3D11を優先し、D3D9にフォールバック
する構成。

実機ではWine 9.0のwined3d経由で**D3D11/DXGI経路が選択された**(ウィンドウツリーに
`"DXGI device window"` が出現することで確認)。

## 2. Steamクライアント要求の回避

### 2.1 症状の確認

64bitのWINEPREFIXを作って素で起動すると即座に終了する:

```bash
WINEARCH=win64 WINEPREFIX=$PWD/prefixes/th06c-wined3d-gl wineboot -u
cd instances/th06c-test && WINEPREFIX=... DISPLAY=:90 wine th06c.exe
# -> SteamAPI_Init() failed. Steam must be running to play this game.
# -> exit=255
```

Steamworks SDKの公式仕様どおり `steam_appid.txt` を置いても変化なし
(`SteamAPI_RestartAppIfNecessary` は回避できても `SteamAPI_Init` 自体がSteamクライアントの
常駐を要求するため)。

なお、当初Web検索から得たAppID `4924840` は誤りで、**実機で `SteamAPI_RestartAppIfNecessary`
に渡される実際のAppIDは `4771400`** だった(スタブのログで判明)。

### 2.2 選択肢の比較とユーザー判断

| 案 | 内容 | 可否 |
|---|---|---|
| A | Proton + ネイティブSteamクライアント(本機に導入済み・ログイン済み) | 正規ルートだがSteam常駐必須。Docker/AWS化困難、同時プレイ制約で並列録画不可 |
| B | WINEPREFIX内にWindows版Steamを導入 | 同上。さらに重くログインも必要 |
| C | **Steamworks APIスタブに差し替え** | plain wine 9.0で完結。**ユーザーがCを選択** |

ユーザーの判断によりCを採用した。実行ファイル自体は暗号化・パックされておらず、
「9関数を実装したDLLを置くだけ」で起動する。

### 2.3 スタブの実装

`mods/th06c_steam_stub/steam_api_stub.cpp`(x86-64、約200行)。要点:

* 9関数をそのままエクスポートする(x64のextern "C"なので装飾なし)。
* `SteamAPI_RestartAppIfNecessary` -> `false`、`SteamInternal_SteamAPI_Init` -> `0`
  (`k_ESteamAPIInitResult_OK`)。
* `SteamInternal_ContextInit` はSDKの `s_CallbackCounterAndContext`(`void*[3]` =
  {初期化関数, カウンタ, コンテキスト})を受け取る仕様なので、カウンタが古ければ
  `pFn(&ctx)` を呼んでから `&ctx` を返す、という本家と同じ挙動を再現する。
* `SteamInternal_FindOrCreateUserInterface` は、**全スロットが0を返すダミーvtable**
  (256スロット)を持つフェイクオブジェクトをバージョン文字列ごとに返す。
  どのインターフェースの何番スロットが呼ばれたかは
  `instances/th06c-test/th06c_steam_stub.log` に残る。

実機でth06cが要求したインターフェースは3つだけだった:

```
SteamInternal_SteamAPI_Init(versions=SteamUtils010)
SteamAPI_RegisterCallback(id=331)     # GameOverlayActivated_t (k_iSteamFriendsCallbacks+31)
SteamInput006                         # slot0 = Init(bool) -> false でOK
STEAMAPPS_INTERFACE_VERSION009        # slot4 = GetCurrentGameLanguage()
SteamUtils010                         # slot34 -> 0 でOK
```

**`ISteamApps::GetCurrentGameLanguage()`(vtable slot 4)がNULLを返すとゲームが即座に
逆参照してページフォルトする**(`Unhandled page fault on read access to 0000000000000000`)。
そのため戻り値オーバーライド機構 `ResolveOverride()` を設け、以下を個別に返している:

| インターフェース | slot | メソッド | 返す値 |
|---|---|---|---|
| STEAMAPPS_INTERFACE_VERSION009 | 0 | `BIsSubscribed` | `1` |
| STEAMAPPS_INTERFACE_VERSION009 | 4 | `GetCurrentGameLanguage` | `"japanese"` |
| STEAMAPPS_INTERFACE_VERSION009 | 5 | `GetAvailableGameLanguages` | `"japanese"` |
| SteamUtils010 | 4 | `GetIPCountry` | `"JP"` |
| SteamUtils010 | 9 | `GetAppID` | `4771400` |

これでゲームは正常に起動するようになった。新たに0を返すと不都合なメソッドが出てきた場合は、
スタブのログでslot番号を特定して `ResolveOverride()` に足す運用とする。

## 3. WINEPREFIXの構築

```bash
WINEARCH=win64 WINEPREFIX=$PWD/prefixes/th06c-wined3d-gl wineboot -u
WINEPREFIX=$PWD/prefixes/th06c-wined3d-gl wineserver -w
bash ../sattori/worker/setup_wineprefix.sh "$PWD/prefixes/th06c-wined3d-gl" \
    games/assets/msgothic.ttc games/assets/msmincho.ttc
# クラッシュ時にwinedbgのGUIが残るとXvfb上に居座るので無効化する
WINEPREFIX=... wine reg add 'HKCU\Software\Wine\WineDbg' /v ShowCrashDialog /t REG_DWORD /d 0 /f
```

* **`WINEARCH=win64` が必須**(`setup_wineprefix.sh` は新規作成時に win32 を強制するので、
  先に自分で win64 プレフィックスを作ってから同スクリプトを呼ぶ。既存ディレクトリがあれば
  スクリプトは初期化をスキップしてフォント登録だけ行う)。
* Wine 9.0 の win64 プレフィックスには `msvcp140` / `vcruntime140(_1)` / `mfplat` /
  `mfreadwrite` / `d3d11` / `dxgi` / `d3d9` がすべて同梱されており、**追加のDLL導入は不要**。
* Xvfbは `:90`、画面サイズは `1400x1100x24`。

## 4. 起動時「解像度を選択してください」ダイアログ

th06cはオリジナルth06と違い、`th06.cfg` に焼き込む方式ではなく、**起動のたびに
`USER32!DialogBoxIndirectParamW` によるモーダルダイアログを表示する**。これを閉じないと
ゲーム本体が始まらない。ユーザールール上xdotoolによる外部入力は使えないため、
MOD内のワーカースレッドからダイアログのコントロールを直接操作して閉じる方式にした。

`EnumWindows`(クラス `#32770`、自プロセス)+ `EnumChildWindows` で実機列挙した結果:

| ID | クラス | テキスト |
|---|---|---|
| 100 | Static | 解像度を選択してください |
| 200 | Button(radio) | ボーダーレスウィンドウ |
| 201〜205 | Button(radio) | フルスクリーン(最大 / 3840x2160 / 2560x1440 / 1920x1080 / 1280x720) |
| 206〜210 | Button(radio) | ウィンドウ(2560x1920 / 1920x1440 / 1280x960 / 960x720 / **640x480**) |
| 400 | Button(checkbox) | VSyncを有効 |
| 1 | Button(IDOK) | ゲーム起動 |

解像度のラベル(`最大`・`640x480` 等)はラジオボタン本体ではなく**隣接する別のStatic
コントロール**(id=102〜111)になっている点に注意。テキストでラジオを探すと全部
「フルスクリーン」「ウィンドウ」に見えるので、**IDで指定すること**。

MODでは `CheckRadioButton(dlg, 200, 210, 210)` で「ウィンドウ 640x480」を明示的に選び、
`BM_SETCHECK` でVSyncをONにしてから、
`PostMessageW(dlg, WM_COMMAND, MAKEWPARAM(1, BN_CLICKED), hButton)` で「ゲーム起動」を押す。

選択状態は `th06.env`(12バイト)に永続化されるが、ダイアログ自体は毎回出るため、
**どの環境でも同じ設定になるよう毎回明示的に選び直す**実装にしている。

## 5. 入力オートメーション

### 5.1 IATフックが効かない問題

th06c.exeは `GetAsyncKeyState` を静的インポートしているのでIATフックは掛かるが、
**実機では一度も呼ばれなかった**(60秒間 poll count = 0)。1.2節のとおり、th06cは
User32を動的にロードして `GetProcAddress` で入力APIを解決しているためである。

### 5.2 GetProcAddressフック方式

そこで **`KERNEL32!GetProcAddress` の方をIATフック**し、
`"GetKeyboardState"` / `"GetAsyncKeyState"` の解決要求に対して自前の関数ポインタを返す方式に
した(`mods/th06c_replay_autoplay/dllmain.cpp`)。injectorが `CREATE_SUSPENDED` で起動して
DllMainを先に走らせるため、ゲームがAPIを解決するより先にフックを仕掛けられる。

実機で確認できた解決順:

```
joyGetPosEx / joyGetDevCapsW -> GetKeyboardState -> GetRawInputDeviceList
-> RegOpenKeyEx* -> XInputGetState / XInputSetState
```

**th06cが実際に使う入力経路は `GetKeyboardState`**(`GetAsyncKeyState` は最後まで
呼ばれず、累計0のまま)。`MapVirtualKeyExW` もIATフックして観測したが、方向キー関連の
スキャンコード(0x48/0x4B/0x4D/0x50/0xC8〜0xD0/0xE048/0xE050)では一度も呼ばれなかった。

### 5.3 ポーリングレートの実測

`GetKeyboardState` の呼び出し回数を1秒ごとにログした結果:

| 局面 | 呼び出し回数 |
|---|---|
| 起動直後〜タイトルロード中(約4秒) | **1〜2 回/秒** |
| タイトル画面・メニュー・リプレイ再生中 | **60〜77 回/秒**(描画フレームと1:1) |

つまり**ロード中だけポーリングが極端に遅い**。既存タイトルのように「ポーリング回数=フレーム数」
としてキー押下時間を決める方式(`mods/common/dinput_hook.h` の設計)はth06cでもそのまま
使えるが、**ロード中に押すキー(最初のEnter)だけは1回の押下に1秒以上かかる**ことに
留意が必要。

### 5.4 メニュー操作シーケンスの訂正

ユーザー提供の手順は「Enter -> Down x2 -> Enter」だったが、実機で確認したth06cの
メインメニューは**オリジナルth06から項目が増えている**(Extra解放済みセーブデータの場合):

```
Start / Extra Start / Practice Start / Replay / Score / Music Room / Option / License / Quit
```

`Practice Start` と `License` が追加された9項目構成のため、**Replayに到達するには Down x3**
が必要。Down x2のままだと `Practice Start` に止まり、そのままEnterを送ると
難易度選択 -> 自機選択 -> 御札選択へ進んでしまう(実機で3回再現した)。

なお切り分けの過程で、「Downが効いていない」ように見えた症状は**すべてこのメニュー項目数の
違いが原因**であり、`GetKeyboardState` への `VK_DOWN` 注入自体は正常に機能していた
(診断モード `TH06C_SEQ=enterdown` で、Enter後にDownを1回だけ押すと
カーソルが `Start` -> `Extra Start` へ1つだけ動くことを画面キャプチャで確認)。

最終的なシーケンス:

```
起動ダイアログを閉じる -> 入力ポーリング開始を待つ -> 2000ms待機
-> Enter(メニュー表示) -> 500ms
-> Down x3(250ms間隔、Replayを選択)
-> Enter(Replay確定) -> 2000ms
-> Enter(1番目のリプレイを選択) -> 1000ms
-> Enter(再生開始)
```

### 5.5 診断モード

切り分け用に環境変数 `TH06C_SEQ` を用意した(MOD内で分岐):

| 値 | 動作 |
|---|---|
| `none` | ダイアログを閉じるだけで60秒放置。放置してもデモが終わらないことの確認に使う |
| `enter` | Enterを1回だけ押して30秒放置 |
| `enterdown` | Enter -> 5秒 -> Down 1回 -> 20秒放置。方向キー注入の可否確認 |
| (未設定) | 通常のフルシーケンス |

## 6. 実機動作確認

```bash
./mods/th06c_replay_autoplay/build_mingw.sh
cp mods/th06c_replay_autoplay/build/th06c_hook.dll \
   mods/th06c_steam_stub/build/steam_api64.dll \
   mods/common/build/injector64.exe instances/th06c-test/
scripts/74_run_th06c.sh --timeout 30 --wait 50 injector64.exe th06c.exe th06c_hook.dll
```

`th6_01.rpy`(koyi / Reimu A / Hard / 記録スコア 114,250,700 / 93,403フレーム)の再生に成功。
画面右上の「最高得点」が **114250700** と表示され、リプレイの記録スコアと一致することを確認した
(`runs/th06c_verification/74_replay_playing.png`)。**60.00fps安定**。

### 検証用リプレイの内容(`@sattori/touhou-replay-parser` で取得)

`node ../sattori/packages/replay-parser/dist/cli/index.js games/th06c/replay/th6_0*.rpy`

| ファイル | 難易度 | 自機 | スコア | フレーム数 | 尺 |
|---|---|---|---|---|---|
| th6_01.rpy | Hard | Reimu A | 114,250,700 | 93,403 | 25m56s |
| th6_02.rpy | Easy | Reimu A | 1,407,360 | 4,589 | 1m16s |
| th6_03.rpy | Lunatic | Reimu B | 247,920 | 1,660 | 27s |
| th6_04.rpy | **Extra** | Reimu A | 84,613,650 | 36,849 | 10m14s |
| th6_05.rpy | Normal | Reimu A | 1,126,970 | 3,847 | 1m04s |
| th6_06.rpy | Hard | Marisa B | 1,332,850 | 2,426 | 40s |

**`@sattori/touhou-replay-parser` はth06c形式をすでに認識できる**(`Game: 東方紅魔郷: Classic
～ the Embodiment of Scarlet Devil. (th06c)` と表示される)。フル尺検証には
通常ステージ用に `th6_01.rpy`(Hard、25m56s)、Extra用に `th6_04.rpy`(10m14s)が使える。

## 7. 成果物

| パス | 内容 |
|---|---|
| `mods/th06c_steam_stub/steam_api_stub.cpp` | Steamworks APIスタブ(x64) |
| `mods/th06c_replay_autoplay/dllmain.cpp` | リプレイ自動再生MOD(x64) |
| `mods/th06c_replay_autoplay/build_mingw.sh` | 上記2つ+injector64のmingwクロスビルド |
| `scripts/74_run_th06c.sh` | 起動実験用ヘルパー(Xvfb :90 + wine後片付け付き) |
| `prefixes/th06c-wined3d-gl/` | 64bit WINEPREFIX(gitignore) |
| `instances/th06c-test/` | 検証用ゲームディレクトリコピー(gitignore) |

## 8. 次フェーズ以降の課題

* `scripts/25_record_replay_e2e_multigame.py` への `GAME_CONFIGS["th06c"]` 追加
  (64bit injector・起動ダイアログ待ち・ウィンドウタイトルが
  `東方紅魔郷　～ the Embodiment of Scarlet Devil` である点への対応)
* フル尺録画(通常ステージ・Extraの両方)と録画品質・音ズレの確認
* `mods/common/score_monitor.*` のth06c対応(RVA特定)。th06cは完全な再実装のため
  **thpracのth06用RVAは一切流用できない**見込み
* 低速録画(1/2倍速)機能。D3D11経路なので `fps_limiter_hook.h`(D3D9専用)・
  `fps_limiter_hook_d3d8.h` のいずれも使えず、新規実装が必要
* リプレイ終了検知方式の決定(画面静止検知 / テンプレート照合)
