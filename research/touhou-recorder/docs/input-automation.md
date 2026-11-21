# 入力オートメーション・MOD仕様

東方Projectの各タイトルでリプレイ自動再生やスコア監視を行うための入力オートメーションおよびMODの実装仕様をまとめます。

## 入力注入の仕組み

メニュー操作の自動化には、ゲームプロセスにDLLをインジェクトして入力APIをフックするDLLインジェクション方式を採用しています（`mods/<title>_replay_autoplay/`）。

タイトルにより入力ポーリングのAPIが異なります：
- **DirectInput 方式**: `GetDeviceState` をフックしてDIKコードを注入（th06, th07, th08, th09, th10, th15）。
- **Win32 GetKeyboardState 方式**: `GetKeyboardState` をフックしてVKコードを注入（th11, th20等）。
- **動的解決 GetKeyboardState 方式**: `GetProcAddress` をフックして自前関数ポインタを返却（th06c）。

※新規タイトル対応時は、決め打ちせず `PressKey`（DIKコード）と `PressVKey`（VKコード）の両方を実機検証して動作する方式を確認してください。

詳細なフック連鎖や技術解説は [docs/touhou_menu_automation.md](docs/touhou_menu_automation.md) を参照してください。

## MODコード共通の注意点

- **DirectInput8Create の多重呼び出し対応**:
  - `mods/common/dinput_hook.cpp` は、`DirectInput8Create` がセッション中に複数回呼ばれるタイトルで無限再帰スタックオーバーフローを起こさないよう修正済みです。
- **クロスコンパイル環境**:
  - `mods/` 配下のDLLは mingw-w64 (`i686-w64-mingw32-g++`) を用いてLinux上でビルド可能です。
  - mingwでビルドする際は `-static-libgcc -static-libstdc++ -static` を必ず付与してください（付与しないとDLL注入が失敗します）。
  - ※正式なビルド手順はMSVC想定（`build.bat`）です。

## スコア監視とリプレイ完走検証

リプレイ再生が記録時と同じ結果までデシンクせずに完走したかどうかは、`scripts/53_verify_replay_score.py` で機械判定できます。

```bash
python3 scripts/53_verify_replay_score.py --game <title> <replay.rpy> <autoplay.log> --record-log <record.log>
```

- **スコア倍率換算**:
  - MODがログ出力する `score` はゲーム内部の生値です。リプレイファイルの記録スコア（画面表示値）と比較する際は、タイトルごとの倍率換算が必要です。
  - th06, th06c: 等倍（×1）
  - th07, th08, th11, th20: ×10
  - 新規タイトル対応時は、必ずフル尺録画での完全一致検証を行って倍率を決定してください。
- **メモリ解放時のゴミ値対策**:
  - ポインタ間接参照方式のタイトル（th07/th08等）では、リプレイ開始直後や終了直後に一時的なゴミ値がログに出力されることがあります。`scripts/53_verify_replay_score.py` は記録全体のどこかに完全一致するサンプルがあるかで判定するため、末尾のゴミ値に左右されません。
- **リプレイ単体スコアの確認**:
  - リプレイの記録スコア単体を確認したい場合は、`node scripts/53_get_replay_score.mjs <replay.rpy>`（`@sattori/touhou-replay-parser` を利用）を使用します。

## 参照レポート

- `reports/03_phase3_input_reliability.md`
- `reports/06_phase6_th07_mod_implementation.md`
- `reports/35_phase35_th11_wine_investigation.md`
- `reports/44_phase44_th20_environment_and_mod_bringup.md`
- `reports/50_phase50_th20_thprac_replay_desync_fix.md`
- `reports/53_phase53_score_monitor_all_titles.md`
- `reports/54_phase54_th07_ver100b_reverification.md`
