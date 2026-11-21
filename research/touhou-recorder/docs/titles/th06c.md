# 東方紅魔郷: Classic (th06c)

## 基本情報

- 画面解像度: 640x480 (4:3)
- 描画API: 64bit DXライブラリ系エンジン
- 推奨クラウドアスペクト: 4 vCPU (`c7i.xlarge` 等)

## 固有仕様・運用ルール

th06cは他タイトルと前提が大きく異なります（詳細は `reports/74`〜`77` 参照）。

- **PE32+ (x86-64) アーキテクチャ**: `th06c.exe` は64bitバイナリです。MOD・injectorともに64bitでビルドします（`mods/th06c_replay_autoplay/build_mingw.sh` が `th06c_hook.dll`・スタブ `steam_api64.dll`・`injector64.exe` を一括生成）。既存の32bitツール・フックコードは流用できません。
- **Steamworks API スタブ**: Steamworks APIが初期化できないと即 `exit(255)` するため、`mods/th06c_steam_stub/` のスタブDLLを正規の `steam_api64.dll` へ上書き配置することが必須です（`recorder/games.py` の `extra_files` で自動化済み）。`ISteamApps::GetCurrentGameLanguage()` のようにNULLを返すとクラッシュするメソッドは `ResolveOverride()` に個別追加します。
- **起動時解像度ダイアログの自動操作**: 起動のたびに「解像度を選択してください」モーダルダイアログが表示されます。設定ファイルに保存できないため、MODがプロセス内からコントロールを操作して自動で閉じます（ウィンドウ640x480 = id 210、VSync = id 400、ゲーム起動 = id 1）。
- **GetProcAddressフックによる入力注入**: 入力ポーリングは動的解決（`GetProcAddress`）された `GetKeyboardState` で行われます。IATフックでは捕捉できないため、`KERNEL32!GetProcAddress` 自体をフックして自前の関数ポインタを返します。
- **メインメニュー操作**: 未解放の項目はカーソルがスキップするため、Down回数を決め打ちせずカーソル位置（`module+0x00B5C168`）を読み取り、`Replay`（index=3）に一致するまでDownを送信します。
- **仮想画面サイズ**: `xvfb_screen` は `1400x1100x24` + `skip_origin_move_if_fits` を使用します（800x600だと(0,0)への強制移動時にタイトルバーがずれて写り込みます）。
- **リプレイファイル名**: `FindFirstFileA`/`FindNextFileA` で `./replay` を列挙する実装のため、`th6_ud0000.rpy` などのファイル名でもそのまま認識されます（正規化不要）。
- **スコア監視**: スコアのRVAは `module+0x003A3B4C`（内部値）、倍率は等倍（×1）。ステージ番号・残機・グレイズのRVAは未特定です。
- **理論尺比較**: リプレイの `frameCount` 合計が実再生時間よりステージあたり1〜3秒多い系統差があるため、理論尺比較は「超過方向」の検出にのみ使用します。
- **倍速録画**: th06ncと同じく、`GetProcAddress`フックでQPC(`speed_hack_hook`)を偽装し、音声はWASAPIのレート偽装・同期マーカー(`wasapi_hook`)で対応(reports/90)。g6f.2xlarge(GPU描画+NVENC)で2倍速は実用品質(Hard全6面・Extraとも試行1回目成功・スコア一致、復元後の落ち1.0%、等倍0.4%)。3倍速3.4%・4倍速8.6%はキャプチャ律速。画面上のfps表示は補正なしで60fps前後になる。
- **アトラクトデモ**: メニュー表示のまま20〜30秒放置するとアトラクトデモに戻るため、タイムアウト設計時に注意が必要です。

## 参照レポート

- `reports/74_phase74_th06c_environment_and_steam_stub.md`
- `reports/75_phase75_th06c_mod_and_e2e_recording.md`
- `reports/76_phase76_th06c_score_probe_and_end_detection.md`
- `reports/77_phase77_th06c_aws_cloud_verification.md`
- `reports/90_phase90_fps_display_fix_and_th06c_speedup.md`
