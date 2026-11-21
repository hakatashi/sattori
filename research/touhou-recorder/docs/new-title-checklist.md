# 新規タイトル対応時の検証チェックリスト

新しいタイトルをこのリポジトリに追加する（録画パイプラインに乗せる）際は、以下の全ステップを実施してください。どれか1つでも欠けた状態で「対応完了」と判断しないでください。

## 10ステップ検証手順

1. **設定確認**:
   - 対象タイトルの `.cfg` がウィンドウモードになっているか確認する（フルスクリーンのままだとXvfb環境でプロセスが応答しなくなります）。
   - 設定バイトの意味はバージョンにより反転しうるため、実機で再検証する。
2. **起動確認**:
   - Xvfb上でゲームが正常に起動し、ウィンドウが安定して表示されることを確認する。
3. **MOD開発・動作確認**:
   - リプレイ自動再生MOD（`mods/<title>_replay_autoplay/`）を実装する。
   - 入力ポーリングAPIを確認し、DirectInput (`GetDeviceState`) または Win32 (`GetKeyboardState`) の適切な方式を実装する。
   - メニュー操作シーケンスが不明な場合はユーザーに確認する。
4. **リプレイ録画確認**:
   - **必ずフル尺の録画を1度以上行う**。
   - 通常ステージ（Easy/Normal/Hard/Lunaticのいずれか）とExtraステージの**両方**で録画検証を行う。
5. **録画品質確認**:
   - 録画動画の重複フレーム率および理論尺超過率を確認し、処理落ちがないかを検証する（詳細は [docs/recording-pipeline.md](docs/recording-pipeline.md) 参照）。
6. **音ズレ確認**:
   - 音声トラックと映像の同期がずれていないか確認する（プロセス分離と後muxの動作確認）。
7. **低速録画機能**:
   - 処理落ちが激しいタイトル向けに、2分の1倍速録画機能（タイムスケール・動的閾値スケール）を実装・検証する。画面上のfps表示の補正は項目10で行う。
8. **内部データ取得機能**:
   - ゲーム内スコア・ステージ番号・残機・グレイズ等の内部データ取得フックを実装・検証する。
   - thpracのソースコード（`../thprac/thprac/src/thprac/thprac_<title>.cpp`）を活用してRVA・構造体オフセットを特定する（`mods/common/score_monitor.*` 参照）。
   - フル尺録画での完全一致検証を行い、スコア倍率（等倍または×10）を決定する。
9. **クラウド実機検証**:
   - AWS等のクラウド環境で実機録画を確認し、安定した滑らかな描画に必要な推奨スペック（4 vCPU / 8 vCPU / 16 vCPU / GPU）を確定する。
10. **画面上fps表示の補正**（低速・倍速録画時。reports/48, 64, 69, 90, 93）:
   - 項目7の低速録画（および倍速録画）とあわせて実施し、項目9のクラウド検証の録画でも表示を確認する。項目番号は過去レポートの参照（項目8・9）を保つため末尾に追加している。
   - **目的**: 低速・倍速録画でも、ゲーム画面右下のfpsカウンタが等倍換算（60fps前後）で表示されるようにする。未補正だと1/2倍速で30fps、2倍速で120fpsと表示され、配信版で処理落ちや異常に見える（録画内容そのものには影響しない）。
   - **確認**: 補正なしの状態で1/2倍速（`FPS_LIMIT_TARGET_HZ=30`）と2倍速の短尺録画（`--record-seconds 60`程度）を撮り、ゲームプレイ区間のfps表示を目視する。`speed_hack_hook`のQPC偽装だけで60fps前後になるタイトルもある（th07/th11/th06c/th06ncの倍速など、`docs/known-limitations.md`の「画面上fps表示の補正」参照）。低速・倍速の両方で確認すること（th12/th20は低速用の補正が倍速で二重掛けになり30fps表示になった、reports/90）。
   - **呼び出し元の特定**: fps計算に使われるタイマー呼び出し（QueryPerformanceCounter / timeGetTime）の戻り先RVAを特定する。
     - 静的解析: `python3 scripts/90_find_fps_timer_callsites.py <exe>`でfps書式文字列（`%.02ffps`等）を参照する命令とタイマーIATの呼び出し元（戻り先RVA付き）を列挙し、`--disasm <開始RVA> <終了RVA>`でfps計算関数を読む（reports/90 §1.4）。
     - 動的解析: `mods/common/timer_probe_hook`を一時的に組み込み、`TIMER_PROBE=1`で呼び出し元ごとの頻度をログに出す。Present頻度と1:1（低速時30Hz）で相関するものが候補だが、フレームペーシング用の呼び出しも同じ傾向を示すので、候補ごとに実機で試す（reports/48, 69）。
   - **実装**: `mods/<title>_replay_autoplay/dllmain.cpp`で`mods/common/fps_display_hook.h`の関数を**`InstallSpeedHackHook()`の後**に呼び、`build.bat`・`build_mingw.sh`に`fps_display_hook.cpp`を追加する。
     - QPCで計算: `InstallFpsDisplayCorrectionHook(rva)`（th12/th20）
     - timeGetTimeで計算: `InstallFpsDisplayCorrectionHookTimeGetTime(rva)`（th09）
     - 基準時刻と現在時刻を別の`call`で取る場合: 複数RVA版（`{rva1, rva2}`、th06/th08）。両方を同じ写像で偽装しないと初回の差分が狂う。
     - 時刻取得関数がメインループなど多数の箇所から共有されている場合: `InstallFpsDisplayCorrectionHookViaCaller(qpcReturnRva, callerReturnRva)`で呼び出し元の戻り先まで一致したときだけ偽装する（th15、reports/93）。
     - VsyncPatchのfps表示（`vpatch.ini`の`CalcFPS = 1`）を使うタイトルは、`recorder/instance.py`の`_apply_vpatch_game_fps()`が等倍以外で`CalcFPS = 0`を書き込み、ゲーム本来の計算に戻す（th06/th10）。
   - **注意**:
     - 呼び出し元を限定せずに全てのタイマー呼び出しを偽装しない。フレームペーシングの判定まで偽装され、th20では完全にハングした（reports/48）。
     - `timer_probe_hook`と`fps_display_hook`を同時に有効にしない。同じIATスロットを二重にフックすると呼び出し元の判定が狂い、補正が効いていないように見える（reports/48）。
     - FpsMonitor（`GetDeviceState`等の呼び出し頻度）とCPU使用率が補正前後で変わらないこと、つまり表示だけが変わりゲーム進行に影響しないことを確認する。
   - **記録**: 特定したRVAはexeのバイナリ固有なので、`docs/titles/<title>.md`と`docs/known-limitations.md`の「画面上fps表示の補正」のRVA一覧に、対象バージョンとあわせて記載する（バイナリが変わると補正されないだけで実害はない）。

## 既存タイトルの対応状況・記録

既存タイトル（th06, th06c, th06nc, th07, th08, th09, th10, th11, th12, th128, th13, th14, th15, th20）の個別仕様は [docs/titles/](docs/titles/) を参照してください。
