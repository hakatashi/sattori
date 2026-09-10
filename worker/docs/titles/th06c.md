# th06c（東方紅魔郷: Classic）対応の技術的背景（Issue #240、touhou-recorder reports/74〜77）

Steamworks APIスタブ・64bit専用録画経路という設計判断の根拠は
[`decisions/0044`](../../../docs/decisions/0044-th06c-steam-drm-stub-and-64bit-title.md)。
sattori本体コードでのローカル実機検証・AWSクラウドE2E検証の結果は
[`docs/reports/2026-09-10-th06c-recording-verification.md`](../../../docs/reports/2026-09-10-th06c-recording-verification.md)。

2026-09-10発売の「東方紅魔郷: Classic」（以下th06c）はオリジナルth06の完全な再実装で、
**録画パイプラインの構造が他の7タイトルと大きく異なる唯一のタイトル**。`GameConfig`・
MODを触る前に必ずここを読むこと。th06とはリプレイ形式のバージョンが非互換（th06
1.02hはth06cのリプレイ（ver. 1.03）を読み込めない、`docs/known-limitations.md`参照）
なので、**th06として受け付けてはならない**（`packages/shared/src/games.ts`で別`GameId`
として管理済み）。

touhou-recorderでの事前検証（reports/74〜77）を踏まえた設計:

- **th06c.exeはPE32+（x86-64）**: 既存7タイトルはすべて32bit。MOD
  （`mods/th06c_replay_autoplay/`）・Steamworks APIスタブ（`mods/th06c_steam_stub/`）・
  injectorのいずれも64bitでビルドする必要がある（`build-mods` skill）。
  `record_th06c.py`は`GameConfig.for_game()`の`injector`/`injector_path`を
  `injector64.exe`へ明示的に上書きする——他タイトルは共通の32bit`injector.exe`を暗黙に
  使うため、この上書きが必要になったのはth06cが最初（`recording/config.py`の
  `for_game()`が`overrides`で`defaults`のキーを上書きできるよう対応済み）。
- **Steamworks APIの初期化が必須**: th06cはSteam版でのみ配布されており、
  `steam_api64.dll`の`SteamAPI_Init`が失敗すると起動直後に`exit(255)`する。Xvfb環境では
  Steamクライアントを常駐させられないため、`mods/th06c_steam_stub/`の最小限スタブ
  （9関数のみ実装、全インターフェースがダミーvtableを返す）を正規の`steam_api64.dll`の
  代わりに`games/th06c/`へ同梱する（`upload-title-assets` skill）。**録画パイプライン側
  での差し替え処理は無い**——タイトル資産アーカイブに最初からスタブだけを入れておく
  方式なので、`recording/instance.py`に特別な分岐は要らない。
- **入力ポーリングはGetKeyboardState（GetProcAddressフック経由）**: th06c.exeは
  DXライブラリ系エンジンで、User32を`LoadLibrary`+`GetProcAddress`で動的に解決してから
  `GetKeyboardState`を呼ぶため、他タイトルが使うIATフック（DirectInputの
  `GetDeviceState`、またはth11/th20の`GetKeyboardState`直接IATフック）はいずれも
  引っかからない（実機でpoll count=0を確認）。`KERNEL32!GetProcAddress`自体をIATフック
  し、`"GetKeyboardState"`の解決要求に対して自前の関数ポインタを返す方式にしている
  （`mods/th06c_replay_autoplay/dllmain.cpp`）。
- **起動のたびに解像度選択ダイアログが出る**: `th06.cfg`に焼き込む方式ではなく、
  `USER32!DialogBoxIndirectParamW`によるモーダルダイアログ（クラス`#32770`）が毎回
  表示される。MOD内のワーカースレッドから直接コントロールを操作して「ウィンドウ
  640x480」+VSyncを選び「ゲーム起動」ボタンを押す（コントロールIDは実機列挙済み、
  `dllmain.cpp`参照）。**ウィンドウ検出はこのダイアログを誤認しないよう独自実装**
  （`mods/common/window_wait.cpp`は使わない。DirectInputのGetDeviceStateフックに依存
  しているうえ、起動ダイアログを除外するロジックが無いため）。
- **Xvfb画面を1400x1100x24へ拡大する**（`record_th06c.py`の`xvfb_screen`）:
  既定の800x600のままだと、openboxの初期配置で640x480ウィンドウが画面内に収まらず
  `recording/pipeline.py`の`_settle_crop_geometry()`が(0,0)への強制移動を行う。この
  移動自体はxdotoolで正しく行われるが、th06cは移動後にタイトルバー分の描画ズレが
  録画に写り込む事例が確認されている（th09の既知不具合と同じ症状、touhou-recorder
  reports/75）。画面を広げてそもそも移動が発生しないようにする対策を踏襲する。
- **メインメニューのカーソルはセーブデータの解放状況でスキップする**: メニュー項目は
  常に9つ（Start / Extra Start / Practice Start / Replay / Score / Music Room /
  Option / License / Quit）表示されるが、Extra未解放だと"Extra Start"にカーソルが
  止まらず1つ飛ばして進む。固定回数のDownでは行き先が変わってしまうため、メニュー
  カーソル位置を保持する変数（`module+0x00B5C168`）を読みながら"Replay"（index=3）に
  一致するまでDownを送る（`NavigateToReplay()`、touhou-recorder reports/75の
  `menuprobe`診断で特定）。
- **リプレイ一覧はディレクトリ列挙方式**: th06cは`FindFirstFileA`/`FindNextFileA`で
  `./replay`配下を列挙し、常に1番目を選ぶ。th10/th12のような固定スロット名の慣習は
  無く、**配置するリプレイのファイル名は何でもよい**（`th6_ud0000.rpy`のような
  New Classic形式の命名でも問題なく認識される、touhou-recorder reports/75で確認）。
  `record_th06c.py`の`canonical_slot`は単なる仮の名前。
- **終了検知はテンプレート照合（見出し帯のみに絞り込み）**: リプレイ選択画面
  「瀟洒なるリプレイを見よう!」は背景を含めて完全に静止する（th09/th10のような
  常時アニメーションが無い）が、一覧行はリプレイ本数に応じて内容が変わるため、
  タイトル文言＋列見出しの帯（`(20, 78, 560, 152)`、640x480座標系）だけに絞り込む
  （`end_template_rect`、touhou-recorder reports/76）。閾値は既定値
  （`END_TEMPLATE_MAD_THRESHOLD`）のままでよい。
- **スコア監視RVAはメモリ全域探索で特定**: th06cはオリジナルth06の完全な再実装であり
  **thpracのth06用RVAは一切流用できない**。64bitのため32bit専用の`score_probe_hook.*`
  も使えず、touhou-recorder側で「既知の値（記録スコア）を全コミット済みRWメモリから
  探す」プローブで内部スコア（即時加算される真の値、`module+0x003A3B4C`）を特定した
  （touhou-recorder reports/75）。画面表示用の追いかけ値（`+0x003A3B50`、集計アニメ
  中は遅れる）ではなく内部スコア側を使うこと。**ステージ番号・残機・グレイズのRVAは
  未特定**なので`mods/common/score_monitor.h`の`ScoreMonitorConfig`は`scoreWidth=4`
  のみ指定し、他は既定の`width=0`（無効化）のままにする。倍率は等倍
  （`recording/modlog.py`の`GAME_SCORE_MULTIPLIERS["th06c"] = 1`、th06と同じ）。
- **理論尺比較は「超過方向」のみで判定する**: th06cのリプレイ`frameCount`合計は
  ステージ数に比例して実測再生時間より系統的に大きい値になる（1ステージあたり
  約1〜3秒、原因はリプレイ記録上のステージ末尾フレームが実際には描画されないためと
  見られる、touhou-recorder reports/75）。理論尺**未満**であること自体は処理落ちの
  兆候ではない——`docs/known-limitations.md`§3の一般則（重複フレーム率と理論尺比較の
  併用）に加え、th06cは理論尺比較を超過方向のみで見るという追加の注意が要る。
- **低速録画（Issue #68）は未対応**: th06cはD3D11経由で描画しており、`fps_limiter_hook.h`
  （D3D9専用）・`fps_limiter_hook_d3d8.h`のいずれも使えない。`SLOW_MOTION_SUPPORTED_GAME_IDS`
  には登録しない。
- **自動リトライ・音声/映像の別プロセス録画**は他タイトルと共通の実装
  （`recording/`パッケージ）をそのまま使う。

## 残っているリスク

- ステージ番号・残機・グレイズが監視できないため、リプレイずれの事後検証はスコアの
  一致判定のみに限られる（デシンクの検知手段としては他タイトルよりやや弱い）。
- 低速録画は技術的に未実装（MOD側にPresentフックが無い）。
- Steamworks APIスタブは実機で観測された呼び出しにのみ対応しているため、将来の
  ゲームアップデートで新しいインターフェース/メソッドが呼ばれるとNULL逆参照で
  クラッシュしうる（`mods/th06c_steam_stub/steam_api_stub.cpp`のログでスロット番号を
  特定し`ResolveOverride()`に追加する運用）。
