# フェーズ30: th06(紅魔郷)のwined3d白画面ハング解消

日付: 2026-07-23

## 背景

`reports/01_phase1_th06_baseline.md`で、th06はCRD(実Xサーバー)上でwined3d(llvmpipe)を使うと画面が終始白一色のまま固まり、`wined3d_swapchain_*`系のPresent呼び出しが一度もトレースされないという原因不明のハングが報告されていた。フェーズ2でth07がXvfb+wined3dで完全動作することを確認したため「th06固有の問題」と結論づけられたが、**th06自体はXvfb上で一度も再検証されていなかった**。

今回、ユーザーが`games/th06`のゲームデータをver1.02hに更新し、不要ファイル整理・ファイル名の大文字→小文字修正を行ったうえで、Xvfb環境での再検証を依頼した。

## 発見1: フルスクリーン設定によるハング(cfgファイルのロケール依存読み込み失敗)

新データでXvfb(`:50`、DRI3無し)上で`東方紅魔郷.exe`を素朴に起動したところ、th08のフェーズ9/22で既知の「`NtUserChangeDisplaySettings`無限リトライ」エラーが再現した。ユーザーの確認により、**`東方紅魔郷.cfg`はWindows実機で既にウィンドウモードに設定済み**であることが判明していたため、cfg自体ではなく「ゲームがcfgを正しく読み込めていない」可能性を疑った。

同梱の設定ツール`custom.exe`をLANGを指定せず起動したところ、設定保存時に`東方紅魔郷.cfg`ではなく文字化けしたファイル名(`“Œ•ûg–‚‹½.cfg`)の別ファイルが新規作成されることを確認した。**`LANG=ja_JP.UTF-8`を設定してwineプロセスを起動すると、custom.exeのウィンドウタイトルも正しく日本語表示され、正しいファイル名(`東方紅魔郷.cfg`)への保存も成功する**ことを確認した。

`LANG=ja_JP.UTF-8`を設定して`東方紅魔郷.exe`を起動し直すと、`NtUserChangeDisplaySettings`エラーは完全に消え、ウィンドウタイトルも正しい日本語で表示されるようになった。**th06はwineプロセスの起動時ロケールにja_JP.UTF-8を指定しないと、既存のcfgファイルを正しく参照できずデフォルト(フルスクリーン相当)の挙動にフォールバックする**ことが根本原因だったと考えられる。

## 発見2: フルスクリーン問題解消後も白画面ハングは再現(フェーズ1の問題は実在した)

ロケール修正後も、ウィンドウは640x480で正常に出現するが**画面は白一色のまま更新されず、CPU使用率は約100%で張り付き続ける**症状が再現した。`WINEDEBUG=+d3d,+d3d_caps`でトレースしたところ、フェーズ1の記録と同様、536個のテクスチャロードの後にd3dトレースの出力が完全に停止し(ログの増加が止まる)、それ以降Presentは一度も呼ばれなかった。`strace`で確認したところ、あるスレッドがsocket 2本へのpoll(タイムアウト0)+1msの`clock_nanosleep`を無限に繰り返すビジーループに入っていることを確認したが、d3d/dinput/joystick/timerいずれのWINEDEBUGチャンネルにも対応する動作が記録されず、原因箇所の特定には至らなかった。

## 解決: VsyncPatch(vpatch)の適用で完全解消

th06はWine/最新Windows環境で頻発する既知の互換性バグ(D3D8のvsync検出関連)を持つことが東方コミュニティでは広く知られており、ファン製パッチ「VsyncPatch」(`vpatch.exe`+`vpatch_th06.dll`+`vpatch.ini`、CreateProcess(SUSPENDED)+DLL注入方式。th08で使われている`vpatch_th08.dll`と同じツール群の一部)が標準的な対策として存在する(`reports/23_phase23_th08_ver100d_vsync_fix.md`でth08向けに導入経緯があるのと同一ツール)。

ユーザーが`games/th06/vpatch.exe`・`vpatch.ini`・`vpatch_th06.dll`を配置し、`wine vpatch.exe`(実体は`東方紅魔郷.exe`をSUSPENDED起動しDLL注入)で起動したところ、**白画面ハングが完全に解消し、タイトル画面のデモプレイが60.00fpsで完全に正常描画される**ことを確認した(`reports/assets/th06_vpatch_title.png`, `th06_vpatch_demoplay.png`)。デモプレイの得点・Graze・弾幕パターンいずれも破綻なし。

## 副次的な確認: Direct3Dレジストリ設定は不要

調査過程で`HKCU\Software\Wine\Direct3D`に`OffscreenRenderingMode=backbuffer`・`StrictDrawOrdering=enabled`を設定して白画面解消を試みたが、これ単体では効果がなかった(vpatch無しでは白画面のまま)。vpatch導入後にこれらのレジストリ値を削除(デフォルトのFBOレンダリングモードに戻す)しても、タイトル画面は問題なく60.00fpsで描画されることを確認した。**th06の白画面ハングの真因はレンダリングモードではなくvpatchが修正する既知のvsync/タイミングバグであり、Direct3Dレジストリの特殊設定は不要**と結論づけた。

## 結論・次のステップ

- th06は**`LANG=ja_JP.UTF-8`環境変数 + vpatch(`vpatch_th06.dll`)経由での起動**という2つの条件を満たせば、Xvfb + wined3d(llvmpipe)で他タイトル同様に正常動作することが確認できた
- 次のステップ: th07/th08と同様のリプレイ自動再生MOD(`mods/th06_replay_autoplay/`)の実装。ユーザー提供のキー操作手順(タイトル表示待ち→Enter→下×2→Enter→ウェイト→Enter→ウェイト→Enter)を元に`mods/th07_replay_autoplay/`をベースに移植する。ただしth06はvpatch経由の起動(SUSPENDED作成+DLL注入)が前提となるため、MOD注入もvpatchのプロセス生成後に行うか、あるいはvpatchとMODの2段階DLL注入(th08のVsyncPatch+MODの前例と同様)の方式を検討する必要がある
- リプレイ自動再生・E2E録画(ffmpeg)の検証は未着手
