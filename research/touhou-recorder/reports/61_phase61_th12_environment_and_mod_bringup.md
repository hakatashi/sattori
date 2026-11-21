# フェーズ61: th12(東方星蓮船)の環境構築・自動操作MOD実装(メニュー操作確立まで)

日付: 2026-08-31

## 位置づけ

新規タイトル th12(東方星蓮船 / Undefined Fantastic Object)をリポジトリの録画パイプラインに追加する作業の第1弾。AGENTS.mdの「新規タイトル対応時の検証チェックリスト」のうち、項目1(設定確認)〜3(MOD開発・動作確認)を完了。項目4(フル尺録画)以降は未着手。**このフェーズだけでは「対応完了」を報告しない**こと。

## 前提確認

- 作業開始前に`systemctl status sattori-home-worker`を確認したところ、想定に反して**稼働中(8時間前からactive、直近ジョブは01:48完了済みで待機中)**だったため、ユーザー確認の上で`sudo systemctl stop sattori-home-worker`を実行して停止した。以降`ps aux`でwine/ffmpeg残存プロセスが無いことを都度確認しながら作業した。

## ゲーム資産・バージョン確認

- `games/th12/`にth12.exe・th12.cfg(ウィンドウモード設定済みとユーザー申告)・VsyncPatch一式(`vpatch.exe`/`vpatch.ini`/`vpatch_th12.dll`、不具合時のみ使用)が配置された状態で作業開始。
- **当初配置されていたth12.exe(737,280バイト、PEタイムスタンプ1249084983=2009-08-01)は文字列上`ver 1.00a`であり、`../thprac/thprac/src/thprac/thprac_identify.cpp`の`ID_TH12`エントリが期待するタイムスタンプ`1251344348`(2009-08-27)と不一致だった**。ユーザーに報告したところ、ユーザーが最新版データに差し替え。差し替え後のth12.exe(MD5=`212f187591f4f1fa99eb2845d1b3cf20`)はPEタイムスタンプが`1251344348`と完全一致し、文字列も`ver 1.00b`に変わっていることを確認した。以降このデータで作業。
- 同梱の`th12_update100b.exe`(公式アップデータ本体)は未使用のまま(差し替えは別途ユーザー側で実施)。

## リプレイファイルの内容確認(`@sattori/touhou-replay-parser`使用)

`node ../sattori/packages/replay-parser/dist/cli/index.js -j <file>`で`games/th12/replay/th12_01.rpy`〜`th12_25.rpy`(25本)を全件パースした。フル尺録画の検証対象として以下を選定:

- **通常ステージ(全クリア)候補**: `th12_02.rpy`(ReimuB / Hard / Stage All Clear / score=183,240,710 / 102,326フレーム≒1705秒≒28.4分)。`splits`のstageが`[1,2,3,4,5,6]`で6面通しクリアであることを確認済み。
- **Extraステージ(クリア)候補**: `th12_01.rpy`(MarisaA / Extra Stage Clear / score=195,699,630 / 41,454フレーム≒691秒≒11.5分)。`splits`が`[7]`のみ(Extra面単体のリプレイ)であることを確認済み。

いずれも`cleared: true`かつ必要なステージ構成を満たしており、Silent Seleneからの追加取得は不要だった。

## WINEPREFIXの構築

`../sattori/worker/setup_wineprefix.sh`(ユーザー指示で参照)を使い、新規WINEPREFIXを作成:

```bash
setup_wineprefix.sh prefixes/th12-wined3d-gl games/assets/msgothic.ttc games/assets/msmincho.ttc
```

th11と同様MS明朝も登録(将来のNPC会話シーン等での文字化け対策、reports/38と同じ理由で予防的に実施)。`WINEARCH=win32`で新規初期化、フォントレジストリ登録まで正常完了。

## 自動化MOD(`mods/th12_replay_autoplay/`)

### メニュー操作シーケンス

ユーザー指示により、th11の`Down x2 -> Enter(Replay) -> Right(ユーザーリプレイタブへ切替) -> Enter(1番目選択) -> Enter(再生確定)`をそのまま踏襲。タイトルロゴ待機は6000ms(暫定、実機で問題があれば延長するようユーザーから事前示唆あり)。

### score_monitor用RVAの特定

`../thprac/thprac/src/thprac/thprac_th12.cpp`の`THAdvOptWnd`内、プラクティスモードパラメータ書き込みコード(1735行目付近)から絶対VA(image base 0x400000)を収集し、スコアアドレス`0x4b0c44`を基点としたオフセットに整理:

| 項目 | 絶対VA | 基点(0x4b0c44)からのオフセット |
|---|---|---|
| score(表示値の1/10) | 0x4b0c44 | +0x00 |
| stage(STAGE_NUM) | 0x4b0cb0 | +0x6c |
| lives | 0x4b0c98 | +0x54 |
| graze | 0x4b0cdc | +0x98 |

th11・th10と同じくポインタ間接参照は不要(`baseIsPointer=false`)。フル尺録画での記録スコア完全一致検証は次フェーズ以降の課題。

### 発見した不具合1: 入力注入方式の誤り(GetKeyboardStateではなくGetDeviceStateが実ポーリング経路)

th11をベースに`PressVKey`(`GetKeyboardState`フック経由)で実装したところ、ビルド・注入・「sequence complete」ログ出力までは正常に完了したが、**実際にはメニュー操作が一切反映されていなかった**。FpsMonitorログが起動直後から一貫して57〜60Hzで`GetDeviceState`呼び出しを記録しており、th11(0Hzのまま)とは異なりth12は**th10と同じく古典的なDirectInput `GetDeviceState`ポーリングを実際に使うタイトルだった**と判明。`WaitForHookActive()`は`GetDeviceState`/`GetKeyboardState`いずれかの呼び出しがあれば成立してしまうため、この誤りは実行時エラーとしては検出されない(録画したフレームをt=40秒地点で目視確認し、タイトル画面のアトラクトデモ「Demo Play」表示のままであることで発覚)。

対策として`PressVKey`を全廃し、`mods/th10_replay_autoplay/dllmain.cpp`と同じ`PressKey`(DIKスキャンコード経由、`DIK_DOWN=0xD0`・`DIK_RIGHT=0xCD`・`DIK_RETURN=0x1C`)に置き換えたところ、実際にリプレイ再生(HARD表示・スコア増加・「Demo Play」表示消失)が開始されることをt=40秒のフレーム目視で確認した。**キー操作シーケンス自体はth11と同一だが、入力注入の技術的経路はth10と同一というハイブリッドな構成である点に注意**。

### 発見した不具合2: ゲームウィンドウが最小化(Iconic)状態で作成される

MOD側の`WaitForStableWindow`は成功する(hwnd取得・800ms安定確認までクリア)一方、`scripts/25`側の`find_window()`(`xwininfo`の`IsViewable`判定に依存)が20秒間ずっとタイムアウトする現象が発生。`xprop -id <winid>`で調査したところ`WM_STATE: window state: Iconic`(最小化状態)であることが判明した。手動で`xdotool windowmap <winid>`を実行すると即座に`IsViewable`に遷移し、正しく640x480でレンダリングされたタイトル画面(デモプレイ)が表示された。cfgのウィンドウモード設定自体は正しく機能しており(誤って`th12.cfg`のbyte0を`0x01`→`0x03`に書き換えて検証したところ「画面モードの選択」初回起動ダイアログに退行したため、`0x01`が正しいウィンドウモード値であると確認・復元した)、**th12固有でウィンドウが最小化状態のまま作成される**という他タイトルでは未確認の挙動が原因だった。

対策として、`scripts/25_record_replay_e2e_multigame.py`の`GAME_CONFIGS["th12"]`に`"force_window_map": True`を追加し、ウィンドウ検出ループ内で毎回`xdotool search --pid <game_pid>`で得た全ウィンドウIDに対し`xdotool windowmap`を発行してから`find_window()`を呼ぶよう変更した(該当箇所: `scripts/25_record_replay_e2e_multigame.py`の`geom = find_window(...)`ループ)。

## ビルド方法

```bash
cd mods/th12_replay_autoplay
i686-w64-mingw32-g++ -shared -O2 -o build/th12_hook.dll \
    dllmain.cpp \
    ../common/dinput_hook.cpp ../common/window_wait.cpp ../common/logging.cpp \
    ../common/fps_monitor.cpp ../common/score_monitor.cpp \
    -static-libgcc -static-libstdc++ -static -luser32
```

MSVC用`build.bat`も新規作成済み(`mods/th11_replay_autoplay/build.bat`と同型)。

## `scripts/25_record_replay_e2e_multigame.py`への統合

- `GAME_CONFIGS`に`"th12"`エントリを追加(`display=":93"`、`wineprefix=prefixes/th12-wined3d-gl`、`replay_dest_filename="th12_ud0000.rpy"`、`default_replay="th12_02.rpy"`)
- `--game`の`choices`に`"th12"`を追加
- ユーザー指示により終了検知は画面静止検知のみを使用(`end_template`は設定しない)。マスク領域は`still_detect_exclude_rect=(48, 214, 203, 430)`(画面左上を(0,0)として(48,214)から幅155px・高さ216px)
- 上記の最小化ウィンドウ対策として`force_window_map=True`を追加し、ウィンドウ検出ループを拡張

## 動作検証結果

`--record-seconds 60 --no-audio`での短時間録画検証(`runs/th12_verification/`、`.gitignore`済みのため成果物自体は非コミット):

1. **PressVKey版(誤り)**: セットアップは全工程成功しウィンドウ検出・録画開始まで到達したが、重複フレーム率35.2%(タイトル画面アトラクトデモのまま静止的な描画が続いていたため)。t=40s時点のフレームで「Demo Play」表示を確認し、リプレイ未開始と判明。
2. **PressKey版(修正後)**: 同条件で重複フレーム率0.0%。t=40s時点のフレームでHARD表示・スコア122,840・「Demo Play」表示消失を確認し、リプレイ再生が正常に進行していることを確認した。

## 未実施(次フェーズ以降の課題)

AGENTS.mdの新規タイトル対応チェックリストのうち、以下が未着手:

4. フル尺録画(通常ステージ・Extraステージ両方)
5. 録画品質・fps確認(フル尺での重複フレーム率評価)
6. 音ズレ確認
7. 低速録画機能の実装・検証
8. 内部データ取得機能(score_monitorのRVA)のフル尺録画での記録スコア完全一致検証
9. AWSクラウド実機検証

これらが完了するまで「th12対応完了」を報告しないこと。
