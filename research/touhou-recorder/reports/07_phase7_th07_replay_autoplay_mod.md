# フェーズ7: th07 リプレイ自動再生MODの実装・検証

日付: 2026-07-15

## 背景

フェーズ3(`03_phase3_input_reliability.md`)・フェーズ6(`06_replay_automation_mod_feasibility.md`)を受け、xdotoolによるメニュー操作の信頼性不足を解決するため、DirectInput `GetDeviceState` vtableフック方式によるDLLインジェクションMODをWindows実機上で実装した。技術方式の詳細は`docs/touhou_menu_automation.md`を参照。

本フェーズはth07(妖々夢)のみを対象とする。th08への移植は`reports/08_*.md`で扱う。

## 環境確認

- `findstr /i dinput th07.exe`で`DINPUT8.dll`・`DirectInput8Create`のインポートを確認(TH09での前例通り)
- ビルド環境: Visual Studio 18 Community + MSVC 14.50.35717、x86(32bit)ターゲット。`th07.exe`本体もPE machine種別`014C`(x86)であることを確認し一致させた

## 成果物

- `mods/common/`: 共通のDirectInputフック(`dinput_hook.cpp`)、ファイルログ(`logging.cpp`)、ウィンドウ安定待機(`window_wait.cpp`)、汎用DLLインジェクター(`injector.cpp`、`CreateProcess(SUSPENDED)`→`WriteProcessMemory`→`CreateRemoteThread(LoadLibraryA)`→`ResumeThread`)
- `mods/th07_replay_autoplay/dllmain.cpp`: th07固有のキーシーケンス(下×3→Enter×4)を実装したDLL本体
- ビルドスクリプト(`build.bat`, `build_injector.bat`, `setup_vcvars.bat`)。ビルド成果物(`build/`以下)は`.gitignore`済み

## 発見・修正したバグ: vtable二重パッチによる無限再帰クラッシュ

初回実装をそのまま実機テストしたところ、**注入直後(ウィンドウ出現から1秒未満)に毎回確実にプロセスが無応答になることなく消滅する**現象が発生した。イベントログにもクラッシュ報告が残らず、ログは`CreateDevice: hooked GetDeviceState (vtable[9])`が**2回**出力された直後で途切れていた。

原因を切り分けるため、フック処理を1段ずつ無効化した最小構成DLLを3種類作って個別に注入検証した:

| 検証段階 | 内容 | 結果 |
|---|---|---|
| stage1 | フックなし(DLL_PROCESS_ATTACHでログ出力のみ) | 生存(問題なし) |
| stage2 | フルフック(IAT→vtable[3]→vtable[9])だがスレッドなし | **クラッシュ**(vtable[9]の2回目パッチ直後) |
| stage3 | IAT→vtable[3]のみ、vtable[9]はパッチせず素通し | 生存(問題なし) |

これにより「vtable[9](GetDeviceState)のパッチ自体」が原因と判明した。th07.exeのDirectInput実装では、キーボードデバイスとマウスデバイスが**同一の静的vtableを共有**しており、`CreateDevice`が2回(キーボード用・マウス用)呼ばれるたびに`vtable[9]`へのパッチを無条件に実行していた。1回目のパッチで正しいオリジナル関数ポインタを`g_origGetDeviceState`に保存できるが、**2回目のパッチ時には、その時点で既に`vtable[9]`が自分のフック関数(`MyGetDeviceState`)に書き換わっているため、「オリジナル」として保存される値が実質`MyGetDeviceState`自身になってしまう**。結果、次に`GetDeviceState`が呼ばれた瞬間に`MyGetDeviceState`が自分自身を呼び出す無限再帰に陥り、スタックオーバーフローで即座にクラッシュしていた。

### 修正

`mods/common/dinput_hook.cpp`の`MyCreateDevice`に、パッチ前に「既にフック済みか」を判定するガードを追加した:

```cpp
if (vtable[9] != (void*)MyGetDeviceState) {
    PatchVTable(vtable, 9, (void*)MyGetDeviceState, (void**)&g_origGetDeviceState);
} else {
    // 既にフック済み(vtable共有デバイス)なのでスキップ
}
```

これにより、vtableを共有するデバイスが複数あっても初回のみパッチが適用され、`g_origGetDeviceState`が正しく保持されるようになった。

## 検証結果

修正後、以下を確認した:

1. **フック発火の確認**(ログベース): `InstallDinputHook`→IATフックOK→`DirectInput8Create`フック発火→`CreateDevice`フック発火(2回、うち2回目はスキップ)→`GetDeviceState`呼び出し回数が起動後1秒程度で60回超に到達、という一連の流れがログに毎回記録されることを確認
2. **目視確認**(スクリーンショット): PowerShellの`System.Drawing`で全画面スクリーンショットを撮影し、シーケンス完了後に実際にリプレイ再生画面(スコア・パワーゲージ・弾幕が表示されゲームプレイが進行している状態)に到達していることを2回(別々の起動)で確認した。スコア・弾幕パターンが毎回異なっており、静止画面ではなく実際にリプレイが再生されていることが裏付けられる
3. **再現性確認**: 同一のシーケンスでth07を**8回連続で起動し直し**、毎回「ウィンドウ安定→フック発火→キーシーケンス完走→プロセス生存」を自動判定するPowerShellスクリプトで検証した。**8/8回全て成功**。クラッシュ・タイムアウトは1回も発生しなかった

## 現在のキーシーケンス実装

`mods/th07_replay_autoplay/dllmain.cpp`:

1. HWND出現待ち→800ms安定待ち→`GetDeviceState`フック発火待ち→1500msバッファ待機
2. 下×3(各押下100ms保持+250ms待機) — 「Replay」選択
3. Enter(1番目のリプレイファイル選択画面へ) — 700ms待機
4. Enter(1番目のリプレイファイルを選択) — 700ms待機
5. Enter(開始ステージ選択、デフォルトのまま) — 700ms待機
6. Enter(通常再生モードを選択、再生開始) — 700ms待機

## 結論・次のアクション

th07については「素のタイトル画面からノーインタラクションで1番目のリプレイの再生開始まで到達する」ことを、複数回の実機起動で再現性高く確認できた。次はth08への移植(`reports/08_*.md`で報告予定)を行う。共通コード(`mods/common/`)は今回の修正込みでそのまま流用できる見込み。
