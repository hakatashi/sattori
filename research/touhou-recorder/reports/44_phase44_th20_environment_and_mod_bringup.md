# フェーズ44: th20(錦上京)のCDリッピング版での起動確認・自動化MOD実装

日付: 2026-08-05

## 背景

フェーズ4でth13以降のタイトルがSteam版データではDRMチェックにより起動不能と判明していた。th20については、Steam版データを`games/th20_steam/`へ退避し、インストールメディア(CD)からリッピングした非Steam版データを新たに`games/th20/`へ配置した状態で、th06/07/08/11と同様の手法での録画検証を行う。

## th20の新規仕様

- th14以降、内部描画解像度が480pから960p相当(4:3で1280×960)に変更されている
- th125以降、設定ファイルの配置場所が`games/th20/th20.cfg`(ゲーム本体ディレクトリ)ではなく`%APPDATA%/ShanghaiAlice/th20/th20.cfg`に変更されている
- リプレイ保存場所も同様に`%APPDATA%/ShanghaiAlice/th20/replay/`に変更されている

## 起動確認

`prefixes/th11-wined3d-gl`(MSゴシック・MS明朝導入済み)を複製して`prefixes/th20-wined3d-gl`を作成し、そのままth20.exeを起動した。

- cfgを配置せずに起動すると、「解像度を選択してください」という初回起動時ダイアログが表示される(ボーダーレスウィンドウDOT by DOT/最大表示、フルスクリーン各種、ウィンドウ各種のラジオボタン)。Xvfbの画面サイズが800x600のままだと1280×960以上の選択肢がグレーアウトして選べない
- `games/th20/th20.cfg`を`%APPDATA%/ShanghaiAlice/th20/th20.cfg`に配置すると、このダイアログをスキップして直接ウィンドウモード1280×960で起動することを確認した。Xvfbの画面サイズは1400x1100に拡大が必要(1280×960 + ウィンドウ装飾分の余白)
- 起動後のタイトル画面デモ(自動再生)で60fps前後(61.2fps)の描画を確認、動作自体は良好

## リプレイ配置場所の検証

`games/th20_steam/replay/th20_01.rpy`を`%APPDATA%/ShanghaiAlice/th20/replay/th20_ud0000.rpy`に配置することで、th11と同様「ユーザーリプレイ」タブの1番目のスロットとして認識されることを確認した(命名規則はth11と同一の`th20_ud0000.rpy`)。

## 自動化MOD(`mods/th20_replay_autoplay/`)

th20.exeのインポートテーブルを確認したところ、th11と同様`DINPUT8.dll`(DirectInput8Create)と`USER32.dll`のGetKeyboardState/SetKeyboardStateの両方を持つ(TH10+系エンジン)。加えてth20固有で`GetRawInputData`/`RegisterRawInputDevices`(Raw Input API)・`XINPUT1_4.dll`・`gdiplus.dll`が新規に依存に加わっている。

th11のMOD(`mods/th11_replay_autoplay/dllmain.cpp`)をベースに、ユーザー指定のキー操作(Down×3 → Enter → Right → Enter → Enter)をそのまま実装し、mingw-w64(`i686-w64-mingw32-g++`)でクロスビルドした。ビルド時は`-static-libgcc -static-libstdc++ -static`が必須(付けないとwine実行時に`libgcc_s_dw2-1.dll`/`libstdc++-6.dll`が見つからずDLL注入が失敗する。既存th11_hook.dll等は同じmingwビルドでも問題なかったため、th20固有で気づいたビルドオプション漏れ)。

### 発見した不具合1: タイトルロゴアニメーションの待機不足

th11の実装をそのまま5000ms待機で流用したところ、Down押下がメニュー項目に反映されない現象が発生した。マーカーログ+タイミング同期スクリーンショットで調査した結果、**th20はタイトルロゴアニメーションが完了してメニュー項目(Game Start等)が実際に操作可能になるまでth11より大幅に長い時間(7.5秒経過時点でもまだメニュー未表示、9秒程度で表示済み)を要する**ことが判明した。待機を10000msに延長することで、Down×3が正しく「Replay」に到達することを確認した(Extra Startが無効化されており、カーソル移動時にスキップされる動作も確認)。

### 発見した不具合2: DirectInput8Create二重呼び出しによるスタックオーバーフロー(共通コードのバグ)

Down×3→Enter→Right→Enter→Enterのシーケンス自体は正常に完了したが、直後にゲームプロセスがクラッシュ(`wine: Unhandled stack overflow`、注入したDLLのモジュール内アドレスで発生)していることが判明した。

原因は`mods/common/dinput_hook.cpp`の`MyDirectInput8Create`が、2回目の`DirectInput8Create`呼び出し(th20はメニュー用とリプレイ再生開始後のゲームプレイ用で2回呼ぶ)に対して無条件に`PatchVTable`を実行していたこと。2回目のインスタンスも1回目と同じ静的vtableを共有しているため、既に`MyCreateDevice`にパッチ済みのvtable[3]を「オリジナル」として`g_origCreateDevice`に保存してしまい、次回`CreateDevice`呼び出し時に`MyCreateDevice`が自分自身を呼ぶ無限再帰でスタックオーバーフローしていた。

`MyCreateDevice`側(vtable[9]、GetDeviceStateのフック)には既にこの対策(`if (vtable[9] != (void*)MyGetDeviceState)`)が実装済み・コメントでも明記されていたが、`MyDirectInput8Create`側(vtable[3])には同じチェックが漏れていた。th06/07/08/11ではDirectInput8Createがセッション中1回しか呼ばれない構成だったため表面化していなかった潜在バグと考えられる。同じチェックをvtable[3]にも追加して修正した。

この修正で、Down×3→Enter→Right→Enter→Enterの自動操作でクラッシュなくリプレイ(th20_01.rpy、HARD相当)が実際に自動再生されることを確認した(スコア・スペルカード・グレイズ数が時間経過で正常に増加、60.0〜60.1fps安定)。

## 影響範囲

`mods/common/dinput_hook.cpp`は全タイトル共通のコードだが、今回の修正はth06/07/08/11の既存ビルド済み`*_hook.dll`には反映されない(再ビルドしていない)。これらのタイトルがDirectInput8Createを2回以上呼ぶ場面が実在するかは未確認だが、もし将来同様の多重呼び出しが起きるシーンがあれば同じスタックオーバーフローが起こりうるため、次にこれらのMODを触る際は本修正込みで再ビルドすることを推奨する。

## 次のステップ

- `scripts/25_record_replay_e2e_multigame.py`にth20用GAME_CONFIGSエントリを追加(display, wineprefix, instance_dir, game_exe, hook_dll, replay_dest_filename="th20_ud0000.rpy"等)
- リプレイ終了後も2箇所(左上(68,245)幅406高さ604、左上(851,488)幅420高さ420)でアニメーションが継続する仕様への対応(`still_detect_exclude_rect`は単一矩形のみ対応のため複数矩形対応への拡張が必要)
- 負荷検証(`--record-seconds`)・フル尺録画・重複フレーム率計測
