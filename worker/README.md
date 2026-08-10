# worker — Sattori 録画ワーカー

東方紅魔郷(th06)・東方妖々夢(th07)・東方永夜抄(th08)・東方地霊殿(th11)・
東方錦上京(th20)のリプレイを
Wine + Xvfb + ffmpeg でヘッドレス録画し、S3 へアップロードする Python ワーカー。AWS EC2
Spot インスタンス、または自宅サーバー(`home-worker/`)上で Docker コンテナとして実行される。
技術的背景は `touhou-recorder` の
PoC レポート(th07: `reports/11`, `reports/13`, `reports/14`, `reports/16`, `reports/17`,
`reports/21`。th08: `reports/22`〜`reports/26`、Issue #13。th06: `reports/30`〜`reports/32`。
th11: `reports/35`〜`reports/39`。th20: `reports/44`〜`reports/48`、Issue #87。
低速録画: `reports/47`・`reports/48`、Issue #68)を参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `entrypoint.py` | ジョブ全体の制御。DynamoDBのチェックポイント確認 → (再開でなければ)S3 DL →
  録画 → 生動画をS3へチェックポイントUP → 720p変換 → S3 UP → DynamoDB/taskToken 通知。
  GAME環境変数に応じて `record_th06.py` / `record_th07.py` / `record_th08.py` /
  `record_th11.py` を呼び分ける |
| `recording_common.py` | th06・th07・th08・th11共通の録画パイプライン本体(Issue #13でth08
  対応時に共通化)。Xvfb起動・クロップ座標の確定(座標が安定するまで待ってから確定し、
  画面外へのはみ出しは`windowmove`再試行ループで補正する。後述
  「クロップ座標の確定手順」参照)・録画・終了検知
  (リプレイ選択画面テンプレートとの照合。テンプレート未整備のゲームは画面静止のMAD判定に
  フォールバック、reports/33・34。静止判定は`GameConfig.still_detect_exclude_rect`で
  指定した矩形をMAD計算から除外できる、th11のPause Menu明滅カーソル対策、reports/37・38)・
  fps暴走/処理落ちの早期検知・自動リトライ(既定3回)・映像/音声を別プロセスで録画し
  後でmuxする処理(reports/26)・フックDLLより前に追加DLLを注入する処理
  (`GameConfig.extra_dlls`、th06のVsyncPatch用)を担う。進捗スクリーンショット/状態も
  書き出す。音声はジョブ専用のPulseAudio sinkへ分離する(後述「並列録画時の音声分離」) |
| `pulse.py` | ジョブ専用のPulseAudio null-sinkの作成・破棄(Issue #48)。同一ホストで
  複数ジョブを並列録画したときに音声が混ざらないようにするためのもの(後述) |
| `record_th06.py` / `record_th07.py` / `record_th08.py` / `record_th11.py` /
  `record_th20.py` | タイトル
  固有のパス設定(`GameConfig`)を組み立てて `recording_common.record_with_retry()` を
  呼ぶだけの薄いラッパー |
| `descale.py` | 低速録画(Issue #68)の生データを等倍相当へ戻す後処理(映像のPTS圧縮＋
  音声のリサンプル)。`recording_common.attempt_recording()` が mux 直後に呼ぶため、
  以降の工程は等倍の動画だけを見ればよい(後述「低速録画」) |
| `upscale.py` | 録画動画をアスペクト比を保って720pへアップスケールする後処理(reports/21)。
  進捗コールバック対応 |
| `status.py` | DynamoDB へのジョブ状態・進捗反映、チェックポイント確認用のジョブ取得。status の書き込みは `attribute_not_exists(stopRequestedAt)` を条件にする（管理画面から緊急停止されたジョブを`done`へ戻さないため。下記） |
| `interruption_watcher.py` | Spot中断通知/リバランス推奨をIMDS経由で監視するバックグラウンドスレッド |
| `task_heartbeat.py` | Step Functionsへ60秒ごとに`SendTaskHeartbeat`を送るバックグラウンドスレッド(Issue #49)。ワーカーの死活監視で、15分途絶えるとタスクが失敗し`HandleFailure`が後始末に入る。主目的は自宅ワーカー(`home-worker/`)の停電・回線断の検知だが、EC2でもハング時の失敗検知が90分→15分に縮まる |
| `progress_reporter.py` | 録画中の進捗スクリーンショットをS3へアップロードするバックグラウンドスレッド |
| `title_assets.py` | GAME環境変数に応じたタイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)を
  S3からダウンロード・展開する(Issue #22)。ECRストレージコストがタイトル数に比例して
  増大する問題への対応として、ワーカーイメージ自体はタイトル数に依存しない共通部分
  のみで構成する |
| `Dockerfile` | 実行イメージ定義 |
| `mods/common/` | DLL インジェクタ(`injector.exe`。複数DLLの順次注入に対応、th06の
  VsyncPatch+MOD本体の共存に使う)・共通フック処理・fps計測スレッド(`fps_monitor.*`、
  th08のfps暴走検知用、reports/22)のソース(C++, MSVC) |
| `mods/th06_replay_autoplay/` | th06 自動再生フック DLL(`th06_hook.dll`)のソース(C++, MSVC) |
| `mods/th07_replay_autoplay/` | th07 自動再生フック DLL(`th07_hook.dll`)のソース(C++, MSVC) |
| `mods/th08_replay_autoplay/` | th08 自動再生フック DLL(`th08_hook.dll`)のソース(C++, MSVC) |
| `mods/th11_replay_autoplay/` | th11 自動再生フック DLL(`th11_hook.dll`)のソース(C++, MSVC)。
  DirectInput GetDeviceStateではなくGetKeyboardStateフック(`PressVKey`)でキー入力を
  注入する(TH10以降のエンジン向け、reports/35) |
| `mods/th20_replay_autoplay/` | th20 自動再生フック DLL(`th20_hook.dll`)のソース(C++, MSVC)。
  th11と同じGetKeyboardStateフック経路に加え、以下3つの共通フックを組み込む
  (後述「th20対応の技術的背景」) |
| `mods/common/fps_limiter_hook.*` | `IDirect3DDevice9::Present`のvtableフックによる
  フレームレート制限(reports/46)。AWS実機でth20のfpsが75fps前後へ暴走しリプレイが
  早回しになる不具合の対策で、同時に低速録画(Issue #68)の実装基盤でもある。
  目標fpsは`FPS_LIMIT_TARGET_HZ`(既定60) |
| `mods/common/dsound_hook.*` | DirectSoundセカンダリバッファの`SetFrequency`フック
  (reports/47)。低速録画時、Presentのスロットルに連動しない音声を同じ比率で
  スローダウンさせる |
| `mods/common/fps_display_hook.*` | 画面に焼き付くfpsカウンター表示だけを等倍相当へ
  補正するフック(reports/48)。低速録画の動画に「30.0fps」と焼き付いてしまうのを防ぐ |

`mods/` 配下はソース・ビルドスクリプトのみリポジトリで管理する
(元は `touhou-recorder` の PoC で作成したもの)。ビルド方法は後述。

## th08対応の技術的背景(Issue #13)

touhou-recorderでの事前検証(reports/22〜26)を踏まえた設計:

- **ゲームデータは公式アップデータ ver1.00d 相当を使う**。ver1.00a はリプレイ再生中に
  内部fpsが数百〜数千に暴走する既知の不具合があり(reports/22)、ver1.00dで事実上
  解消した(成功率20%→100%、reports/23)。タイトル資産アーカイブには `games/th08` と
  してver1.00d相当のデータを配置すること(「タイトル資産のS3アップロード手順」参照)。
- **fps暴走の残存ケース検知**: `mods/common/fps_monitor.cpp` がGetDeviceStateフックの
  呼び出し頻度(実効fps相当)を5秒毎にログ出力し、`recording_common.scan_fps_runaway()`
  が閾値(300Hz)超過が2回連続したら異常とみなす(単発のノイズを誤検知しないため、
  reports/23)。閾値は元々100Hzだったが、会話イベント中はレンダリングfpsが60のままでも
  GetDeviceStateのポーリング頻度だけ一時的に約3倍(実測179.9Hz)に上がる仕様があり、
  これを誤って異常判定していたことが本番ジョブの調査で判明したため、本物のfps暴走
  (実測下限479Hz、reports/22)との中間である300Hzに引き上げた。
- **処理落ちの早期検知**: 通常の2秒間隔ポーリングでは見逃す処理落ち(reports/12・13由来、
  th08で高頻度に再発、reports/22)を、0.15秒間隔の短時間サンプリング
  (`recording_common.probe_stutter()`)で検知する。処理落ちは実測で録画開始25秒以内に
  発生していたため、判定は録画開始5分以内に限定する(それ以降はリプレイの正常終了
  (結果画面の静止)と区別がつかないため)。
- **映像/音声を別プロセスで録画**: 単一ffmpegでx11grab(映像)とpulse(音声)を同時に
  取り込むと、内部のA/V同期がth08の描画タイミングを律速し、AWS環境で重複フレーム率が
  85%超まで悪化することが判明した(reports/26)。両タイトルとも既定で映像・音声を別
  プロセスで録画し、停止後に `ffmpeg -c copy -shortest` で結合する(th07はこの問題の
  影響を受けないが、安全側に倒して両タイトル共通の実装にした)。
- **リプレイの正規スロット名**: `th7_ud0000.rpy` と同じ命名則(`th{N}_ud####.rpy`)を
  踏襲し、th08では `th8_ud0000.rpy` を使う。touhou-recorderの検証レポート(22〜26)
  では未検証だった(PoC側は常にゲームデータに元から存在するファイルを使っていたため)
  が、Issue #13対応時に実ゲームデータ(ver1.00d)で実機検証済み(候補スロット名で
  配置したリプレイが実際に選択・再生されることをスクリーンショットで確認した)。
- **自動リトライ**: 既定3回(`recording_common.MAX_ATTEMPTS_DEFAULT`)。th08固有の
  不安定性はver1.00d更新+音声分離修正でおおむね解消された前提のため、旧検証時に
  th08向けに推奨されていた8〜15回のような大きな値は採用せず、th07を含む両タイトル
  共通の既定値としている。

## th06対応の技術的背景

touhou-recorderでの事前検証(reports/30〜32)を踏まえた設計:

- **wined3dの白画面ハング回避にVsyncPatchが必須**: th06はWine/最新Windows環境で
  頻発する既知の互換性バグ(D3D8のvsync検出関連)により、そのままでは画面が白一色の
  まま固まる(reports/30)。ファン製パッチ「VsyncPatch」(`vpatch_th06.dll`)をMOD本体
  (`th06_hook.dll`)より前に同一プロセスへ注入することで解消する。このため
  `mods/common/injector.cpp` は複数DLLを指定順に注入してからメインスレッドを再開する
  方式に拡張されている(`injector.exe <target.exe> <hook1.dll> [hook2.dll ...]`、th07/th08
  はDLL1個のみの従来通りの呼び出しのままで後方互換)。`GameConfig.extra_dlls`に
  `("vpatch_th06.dll",)`を指定すると、`recording_common.build_injector_cmd()`がhook_dll
  より前にこれを注入するコマンドを組み立てる。`vpatch_th06.dll`自体はタイトル資産
  アーカイブの`games/th06`に同梱しておけば、`prepare_instance()`のrsyncで自動的に
  instance_dirへコピーされる(個別コピー不要)。
- **タイトル画面の構造がth07/th08と異なる**: th06はタイトル画面が最初からアトラクト
  モードのデモプレイ("DEMO PLAY")を表示しており、メニュー自体がまだ出ていない。
  `mods/th06_replay_autoplay/dllmain.cpp`はDown連打の前にメニュー表示のためのEnter
  押下を1回余分に行う(reports/31)。
- **fps暴走の兆候は見られなかった**が、`mods/th06_replay_autoplay/`は
  `fps_monitor.cpp`を組み込んでいないため`scan_fps_runaway()`は実質的に発火しない
  (th07と同様)。処理落ちの早期検知・自動リトライ・音声/映像の別プロセス録画は
  th07/th08と共通の実装をそのまま使う。
- **実行ファイル名は元の`東方紅魔郷.exe`のまま使う(th07/th08のような`th{N}.exe`への
  リネームはしない)**: 当初th07/th08の慣習に合わせて`th06.exe`へリネームしていたが、
  2026-07-23のsattori側での実機検証で、VsyncPatchが対象プロセスの実行ファイル名を
  検証しているらしいことが判明した。`th06.exe`へリネームすると`WaitForStableWindow`
  が`stable`に到達せずCPU使用率100%で張り付く白画面ハングが再発し、`東方紅魔郷.exe`
  のままなら約3.5秒で正常に安定する。このため`GameConfig`に`game_exe`/
  `process_name`の明示オーバーライドを追加した(`recording_common.py`。未指定時は
  従来通り`f"{game_id}.exe"`を自動導出、th07/th08は無指定のまま)。Linuxの
  `/proc/PID/comm`は15バイトで切り詰められ、UTF-8で18バイトの`東方紅魔郷.exe`は
  末尾の`.exe`が欠落した`東方紅魔郷`(15バイトちょうど)になるため、`pgrep -x`/
  `pkill -x`用に`process_name="東方紅魔郷"`を別途指定する(touhou-recorder
  reports/31)。
- **リプレイの正規スロット名(`th6_ud0000.rpy`)は2026-07-23にローカル実機
  スモークテストで検証済み**: th07/th08の命名則(`th{N}_ud####.rpy`)を踏襲したもの。
  touhou-recorderの検証(reports/30〜32)は既存の numbered replay ファイル名
  (`th6_02.rpy`等)でのみ行われていたが、sattori側で任意ファイル名のリプレイを
  `th6_ud0000.rpy`として配置し`record_th06.py`をそのまま実行したところ、MODが
  「1件目のリプレイ」として正しく選択・再生し、60fps安定・重複フレームなしで
  ゲームプレイ画面(スコア進行・日本語表示すべて正常)を確認できた。

## th11対応の技術的背景(reports/35〜39)

touhou-recorderでの事前検証(reports/35〜39)を踏まえた設計:

- **レンダリングはth08と同じ経路**: th11.exeのインポートテーブルはth08と同じ
  `d3d9.dll`/`DINPUT8.dll`系統で、Xvfb上でも追加調査なしに正常動作する。th08用に
  導入済みのMS Gothic配置・レジストリ登録もそのまま有効に働く(reports/35)。
- **メニュー自動操作にはGetKeyboardStateフックが必要**: TH10以降のエンジンは
  DirectInput `GetDeviceState`を実際の入力ポーリングに使わない(`CreateDevice`は
  呼ばれるがGetDeviceStateは一切呼ばれず、FpsMonitorが常に0Hzを示す)。実際の
  入力ポーリングはWin32 `GetKeyboardState()`経由のため、`mods/common/dinput_hook.h/.cpp`
  に`InstallKeyboardStateHook`/`PressVKey`を追加し、`mods/th11_replay_autoplay/dllmain.cpp`
  がこちらを使う(GetDeviceStateフックと同じ`g_hookCallCount`を共有するため、
  `WaitForHookActive`は変更なしでどちらの経路でも動作する)。
- **リプレイ一覧の「ユーザーリプレイ」タブ**: th11のリプレイ一覧画面は「組み込み
  リプレイ(No.01〜24、ファイル名の数字で表示スロットが決まる)」と、右キーで切り替わる
  別タブの「ユーザーリプレイ(ud0000〜)」に分かれている。実際のプレイヤー録画リプレイは
  後者に属するため、MODのキーシーケンスはDown×2→Enter(Replay確定)→Right(ユーザー
  リプレイタブへ切替)→Enter(1件目選択)→Enter(再生確定)とし、投入リプレイは
  `th11_ud0000.rpy`という固定名で配置する(`GameConfig.canonical_slot`)。
- **タイトルロゴアニメーション待機は6000ms必要**: th08の1500msでは不足し、メニューが
  まだ操作可能になっていないタイミングで入力が送られて意図しないメニュー項目
  (Practice Start等)に迷い込む誤動作が発生した。
- **終了検知はテンプレート照合を使わず、画面静止検知のみで運用する**: th11の終了画面は
  th06/07/08のような内容非依存の専用リプレイ選択画面ではなく、「直前のゲームプレイ
  画面がそのまま静止し、半透明のPause Menuがオーバーレイ表示される」という構造で、
  静止直前の背景(スペルカード名・弾幕パターン等)はリプレイ内容によって異なる。
  テンプレート照合の前提(上部帯がリプレイ内容非依存)が崩れるため、th11は
  `end_template_path`を意図的に用意しない(ワーカーイメージに`assets/replay_end_templates/
  th11.png`を含めない)ことで、`load_end_template()`が自動的にNoneを返し、画面静止のみ
  判定にフォールバックする(reports/36)。
- **Pause Menu画面の選択カーソル明滅を静止判定から除外する**: 画面静止検知のみに
  依存する副作用として、Pause Menu画面で現在選択中のメニュー項目の文字が明滅し続け、
  画面全体のMADが閾値をわずかに超え続けて自然終了を検知できない事例が実機で発生した
  (`th11_ud16gm.rpy`、40分のハードタイムアウトに到達、reports/37)。この明滅は640x480
  原座標で`(70,288)-(188,318)`の矩形に収まることが判明したため、
  `GameConfig.still_detect_exclude_rect`にこの矩形を指定し、
  `recording_common.build_still_mask()`/`mad_masked()`でMAD計算から除外する
  (reports/38)。
- **クロップ座標の確定手順(全ゲーム共通)**: x11grabのクロップ座標は、
  「ウィンドウが見つかった瞬間の`xwininfo`の値」ではなく、以下の順序で確定する
  (`recording_common.attempt_recording()`)。
  1. `find_window()`でウィンドウの存在だけを確認する(この時点の座標は使わない)
  2. MOD側の`WaitForStableWindow: stable`ログを待つ
  3. `wait_for_stable_geometry()`で、0.3秒間隔の2回連続で同じ座標が返るまで待って確定する
  4. 確定座標がXVFB_SCREEN(800x600)からはみ出す場合のみ`xdotool windowmove`で
     左上(0,0)へ移動し、同じ安定判定を通してから再確認する(最大20回)

  1と2〜3を分ける必要があるのは、**ゲームが起動中に自分でウィンドウを再配置する**ため。
  th11はopenboxの初期配置`client=(159,119)`(=800x600に収まるようクランプされた位置)で
  viewableになった直後に、自身で`client=(185,211)`(=画面右下にはみ出す位置)へ移動する。
  実測でこの2状態の間隔はわずか40msで、負荷の高いEC2上ではこの隙間で`find_window()`が
  成立してしまう(ローカル再現試験でCPUに負荷をかけると8試行中7回発生)。
  移動中に取得した座標は移動前・移動後のどちらとも異なる破れた値になることがあり、
  th11の本番/ローカル実測では`(133,119)(142,137)(159,119)(163,127)(168,136)(172,197)`
  `(174,149)(197,196)(200,202)`と毎回異なる値が観測された(安定後の真の座標は常に
  `(185,211)`)。th08は起動から約2.5秒後にウィンドウ自体を破棄・再生成する
  (座標は同じ`(3,29)`)。
  また`WaitForStableWindow`(`mods/common/window_wait.cpp`)はHWNDの同一性しか見ておらず
  位置・サイズの安定は保証しないため、3の座標側の安定判定と併用する必要がある。

  4の`windowmove`はXVFB_SCREENの範囲外にウィンドウが置かれるとx11grabが起動に失敗する
  ため必要(th11実機検証で発覚、reports/35)。装飾のあるウィンドウでは移動後の実座標
  (クライアント領域)を再取得しないとタイトルバー分ずれて録画され(reports/37)、
  `windowmove`の反映も非同期なので、ここでも同じ安定判定を通す。
  「既に範囲内なら`windowmove`を呼ばない」という条件は、2026-07-28にsattori側で
  th06/07/08向けゲームデータを新しいものへ差し替えた際の実機再検証で追加したもの。
  当初はこの対策を全ゲーム共通で無条件に適用しており「th06/07/08では実害がなかった」
  としていたが(reports/37)、この再検証でth07・th08について実害
  (タイトルバーがゲーム画面上端に重なり下端が録画されない)が偶発的に再現したためである。
  ただしこの条件だけでは不十分だった: th11のジョブ
  `a5c36a30-548a-421d-abc7-b4a7fdffc914`(2026-08-01)で、上記のクランプされた一時座標
  `(159,119)`を掴んだ結果「画面内に収まっている」と誤判定して`windowmove`をスキップし、
  実ウィンドウ`(185,211)`に対して`(159,119)`を録画してタイトルバーが写り込み右下
  26x92pxが欠ける不具合が発生した。上記1〜4の手順はこの調査を受けて整理したもの。
  修正後、CPU負荷をかけたローカル実機試験でth11 8/8・th06 4/4・th07 4/4・th08 4/4が
  正しい座標に確定することを確認済み。
- **MS明朝(`msmincho.ttc`)の配置・レジストリ登録が必要**: NPC会話シーン等で
  「ＭＳ 明朝」というフォント名が要求されるが、実体・レジストリが無いとWineの代替
  フォント解決チェーンを経由して別の書体(ゴシック体寄り・半角括弧)にフォールバック
  する。`setup_wineprefix.sh`の第3引数でmsmincho.ttcを渡すと配置・レジストリ登録
  される(reports/38、後述の「WINEPREFIXの作成・フォント修正」参照)。
- **文字輪郭のジャギーは既知の制約として残る(対応なし)**: 修正後もWindows実機と
  比べて文字の輪郭が粗い(グレースケール階調の遷移幅が狭い)現象が残る。原因は
  WineのFreeTypeベースAA(`GGO_GRAY4_BITMAP`、4bit=17階調)自体が実機Windowsの描画
  結果と比べてアルゴリズムレベルで異なることによるもので、gaspテーブル・lfQuality
  書き換え・MacType(旧gdi++)等の対策はいずれも画素値レベルで効果がないことを
  確認済み(reports/39)。費用対効果の観点からこのリポジトリでは対応を見送る。
- **fps暴走の検知・処理落ちの早期検知・自動リトライ・音声/映像の別プロセス録画**は
  th06/07/08と共通の実装(`recording_common.py`)をそのまま使う。th11のMODも
  `fps_monitor.cpp`を組み込んでおり、実機検証では56.6〜60.2Hzで安定していた
  (fps暴走の兆候なし、reports/35)。

## th20対応の技術的背景(reports/44〜48、Issue #87)

th20(東方錦上京)は TH125 以降のエンジンで、これまでの4タイトルと構造が大きく違う。
既存タイトルの慣習をそのまま流用すると必ず外すので、以下は個別に押さえること。

- **cfg とリプレイは `%APPDATA%/ShanghaiAlice/th20/` から読まれる**。ゲーム本体
  ディレクトリに置いても読まれない(reports/44)。cfg が無いと「解像度を選択して
  ください」の初回起動ダイアログ(246x234 の小さなウィンドウ)が出て、
  `WaitForStableWindow` が通らず録画に失敗する。`GameConfig.uses_appdata_profile`
  を立てると `prepare_instance()` が配置する。
  - **配置先は実行中の UNIX ユーザーから解決する**(`recording_common.resolve_appdata_dir()`)。
    Wine はプロファイルを `drive_c/users/<UNIXユーザー名>` へマッピングし、無ければ
    起動時に作る。資産アーカイブに入っている `users/hakatashi/...`(アーカイブを
    作った開発機のユーザー名)を決め打ちにすると、root で動く本番コンテナは空の
    `users/root/` を参照して cfg を見失う。touhou-recorder ではコンテナの実行ユーザー
    自体を改名して回避した(reports/46)が、こちらは**ユーザー名に依存しない**方を
    採っている——イメージの実行ユーザーと資産を作った開発機のユーザー名を一致させ
    続ける、という運用上の約束を増やしたくないため。
- **Xvfb の画面サイズは `1400x1100x24` が必要**。th14 以降は内部描画解像度が 960p 相当に
  上がっており、th20 は 1280x960 ウィンドウで起動する。全タイトル共通の 800x600 では
  x11grab が起動に失敗する(reports/44)。`GameConfig.xvfb_screen` でタイトルごとに
  指定する。
- **メニュー自動操作は Down×3→Enter→Right→Enter→Enter**(th11 の Down×2 と異なる)。
  タイトルロゴアニメーションの待機は **10000ms** 必要で、th11 の 6000ms では
  メニュー項目が操作可能になる前に入力が空振りする(reports/44)。
- **終了検知は画面静止のみ**(th11 と同じくテンプレート照合に不向き)。ただし th20 は
  リプレイ終了後も**2箇所**で背景アニメーションが継続するため、両方を静止判定の
  MAD 計算から除外しないと自然終了を検知できない(reports/45)。このため
  `GameConfig.still_detect_exclude_rect` は矩形の**リスト**も受け付ける
  (th11 の単一矩形指定はそのまま動く)。
- **`Present` フックによるフレームレート制御が必須**。AWS 実機(Intel Xeon/Nitro 仮想化)
  では th20 のフレームペーシング計算が崩れ、ゲーム内 fps が常時 75fps 前後まで上振れして
  **リプレイが早回しで録画される**(reports/46)。th20 はレンダリング fps とゲームロジック
  更新が直結しているため、fps の上振れがそのままゲーム進行の早回しになる。
  `mods/common/fps_limiter_hook.*` が `QueryPerformanceCounter` 基準で 60Hz へ
  スロットルして是正する。**ローカル(Ryzen 7 5700X)では元々再現しない**ので、
  ローカル録画が正常でも AWS 側で必ず fps カウンターを目視確認すること。
- **`mods/common/dinput_hook.cpp` の二重フック対策**: th20 はメニュー用とゲームプレイ用で
  `DirectInput8Create` を2回呼ぶ。2つ目のインスタンスも同じ静的 vtable を共有するため、
  無条件に `PatchVTable` すると `g_origCreateDevice` に自分自身が保存され、次の
  `CreateDevice` で無限再帰(スタックオーバーフロー)になる(reports/44)。
  vtable[9] 側にあった同じチェックを vtable[3] にも入れてある。
  **この修正は共通コードなので、th06/07/08/11 の `*_hook.dll` を次に触る際は
  本修正込みで再ビルドすること**(これらは `DirectInput8Create` を1回しか呼ばないため
  現状は無害だが、ビルド済み DLL と最新ソースが乖離している状態ではある)。
- **デシンク(リプレイずれ)が起きやすい**。リプレイファイル・ゲーム本体側の現象で
  録画側では検知も対処もできない。reports/45 では、撃破できなくなったスペルカードを
  時間切れまで再生し続けて尺が 40 分近くまで伸びた実例が出ている。**想定尺を大幅に
  超えてタイムアウトへ近づいた場合は、まずデシンクを疑うこと**。ユーザーには
  ページAで事前に注意書きを出している(`apps/web`、Issue #87)。

## 低速録画(Issue #68)

th20 は Xvfb + wined3d + llvmpipe のソフトウェアレンダリングに対して描画負荷が重く、
ボム・スペルカード等の高負荷区間で**ゲームエンジン自体が処理落ちする**
(ローカル実機で最低 19.8fps、`c7i.2xlarge` で最低 9.1fps、reports/45・46)。録画側の
コマ落ちではなくゲーム進行そのものが遅くなるため、等倍録画のままでは品質を担保できない。

対策として、**ゲームを 1/2 倍速で走らせて録画し、後処理で等倍へ戻す**。th20 は
レンダリング fps とゲームロジック更新が直結しているので、`Present` を 30Hz へ絞ると
ゲーム進行ごとスローモーション化し、実時間あたりの CPU 負荷が下がって処理落ちが解消する
(reports/47 で最低 19.8fps → 安定 30.0fps を実証)。

### 有効化とワーカー側の分岐が無いこと

起動側が渡す環境変数 **`FPS_LIMIT_TARGET_HZ` の有無だけ**で決まる。未設定なら全タイトル
従来どおり等倍で動く。**ワーカーは自分が EC2 にいるのか自宅にいるのかを知らない**
——低速録画は EC2 では割に合わない(録画時間＝Spot 料金が倍になる)ため自宅ワーカー限定だが、
その判断は起動側(`apps/api/src/workerEnv.ts`)が環境変数を付けるかどうかで表現する。

### 3つのフックが同じ比率で動く

| フック | 役割 |
| --- | --- |
| `fps_limiter_hook` | `IDirect3DDevice9::Present` を目標fpsへスロットル(＝ゲーム進行のスローダウン) |
| `dsound_hook` | セカンダリバッファの再生周波数を同じ比率へ下げる。BGM/SE は DirectSound の独立したストリーミングで Present のスロットルに連動しないため、これが無いと映像と音声がズレ続ける(reports/47) |
| `fps_display_hook` | 画面に焼き付く fps カウンターの表示だけ等倍相当へ補正。無いと等倍へ戻した動画に「30.0fps」と表示され続ける(reports/48) |

MOD 内のメニュー操作待機(`dllmain.cpp` の `ScaledSleep`)も同じ比率で伸びる。

### 監視側の時間も同じ比率で伸ばすこと

**MOD 内部の待機だけでなく、それを監視する `recording_common.py` 側のタイムアウト・
猶予も同じ比率で伸ばさないと低速録画は成立しない**。reports/47 では、スケール未適用の
`POST_START_GRACE_SEC`(15秒)のままステージ開始の導入演出中に処理落ち検知が走り、
3回とも誤ってリトライされる事象が実際に起きた。`slow_motion_scale()` の係数を掛けて
いるのは以下:

- MOD の `sequence complete` ログを待つタイムアウト
- `POST_START_GRACE_SEC`(リプレイ再生開始後の猶予)
- `STUTTER_PROBE_INTERVAL_SEC` / `_PERIOD_SEC` / `_ACTIVE_UNTIL_SEC`(処理落ち早期検知)
- `TIMEOUT_SEC`(録画のハードタイムアウト。60分 → 120分)

`TIMEOUT_SEC` が倍になることに合わせて、Step Functions の `taskTimeout` と自宅デーモンの
`HOME_WORKER_DRAIN_TIMEOUT_SEC` も 150 分に揃えてある(`infra/lib/sattori-stack.ts`・
`home-worker/README.md`)。

### 等倍への変換は録画直後に済ませる

`attempt_recording()` は mux の直後に `descale.py` を呼び、**その試行の出力ファイルを
等倍相当に置き換える**。以降の工程(重複フレーム率チェック・S3 へのチェックポイント・
720p 変換・配信)は等倍の動画だけを見ればよく、パイプラインの他の場所に低速録画の分岐が
一切要らない。

この順序は重複フレーム率チェックにとっても正しい。録画自体は等倍と同じ
`-framerate 60` で撮っているので 30Hz 素材は各フレームが2枚ずつ並ぶが、変換で PTS を
1/2 に圧縮してから `-r 60` に落とすと**重複がちょうど間引かれる**。結果、
「目標 fps を維持できていれば重複ほぼ 0%、本当に処理落ちしていれば重複として残る」という
等倍録画と同じ意味の数字になり、閾値(`MAX_DUPLICATE_RATE_DEFAULT`)をそのまま使える。

### 進捗はコンテンツ秒数で報告する

`save_progress_snapshot()` へ渡す進捗は実時間ではなく**コンテンツ秒数**(完成品の動画で
何秒ぶん進んだか)。分母の `EXPECTED_DURATION_SECONDS` がリプレイの再生時間である以上、
伸びた実時間をそのまま入れると進捗率が半分に見えてしまう。実時間が倍かかること自体は、
フロントエンドがジョブの `slowMotion` を見て残り時間の見積もりへ織り込む
(`apps/web/src/hooks/jobProgressBudget.ts`)。

### ローカルでの実行

```bash
FPS_LIMIT_TARGET_HZ=30 python3 record_th20.py \
  --replay-path games/th20/replay/th20_01.rpy --output /tmp/th20/out.mp4
```

## リプレイ終了検知の方式(reports/33・34)

`recording_common.attempt_recording()`は「リプレイが終了したか」を、画面静止だけでは
なく**リプレイ選択画面テンプレートとの一致**で判定する。

- 当初の方式(画面静止のMAD判定のみ)には構造的な弱点があった。実際にリプレイが
  終了して自動的に戻る「リプレイ選択画面」と、ステージクリア後に一時的に表示される
  「Stage Clear」等のリザルト画面は、どちらも入力なしで画面がぴったり静止する
  (MAD≈0.0)という点で区別がつかない。th06の実リプレイ(`th6_ud1vfq.rpy`)でステージ4
  クリア後のリザルト画面がSTILL_CONSECUTIVE_REQUIRED(16秒)を超えて静止し続け、
  リプレイ本編の途中で誤って「終了」と判定される事象が実際に発生した
  (touhou-recorder reports/33)。この誤検知はth06に限らずth07/th08にも起こりうる。
- 対策として、`assets/replay_end_templates/{game_id}.png`(ゲームごとのリプレイ選択画面の
  参照画像)を用意し、画面が静止しているかに関わらず**毎回**そのテンプレートと照合する
  方式に変更した(`recording_common.load_end_template()`/`END_TEMPLATE_*`定数)。
  比較対象は160x120にダウンサンプルした座標系の上部の帯(`END_TEMPLATE_ROWS=40`、
  タイトル文言+列見出し行)のみで、リプレイ内容(一覧の中身・プレイヤー名/日付)には
  依存しない(reports/34でクロスリプレイ実証済み)。MADが閾値
  (`END_TEMPLATE_MAD_THRESHOLD=15.0`)未満の状態が`END_TEMPLATE_CONSECUTIVE_REQUIRED`
  (=2、4秒)回連続したら終了と確定する。動画圧縮ノイズ等による単発の偶然一致を弾く
  ための連続回数要求であり、画面静止を待たない分、静止のみ判定(最短16秒+α)より
  大幅に高速化されている(reports/34、th06実リプレイで画面切替から2.3秒で確定)。
- テンプレート画像が未整備・未検出の場合は警告ログを出しつつ、従来の画面静止のみ判定
  (`STILL_MAD_THRESHOLD`/`STILL_CONSECUTIVE_REQUIRED`)にフォールバックする。新規タイトル
  追加時にテンプレートが未整備でも動作は壊れない。**th11はこのフォールバックを意図的に
  常用する**(終了画面がリプレイ内容依存でテンプレート照合に不向きなため、上記
  「th11対応の技術的背景」参照)。
- テンプレート画像はゲーム本体ではなく録画パイプライン自体の参照素材のため、タイトル
  資産S3アーカイブではなくワーカーイメージに焼き込む(「リポジトリに含まれない資産」
  節参照)。

## 並列録画時の音声分離(Issue #48、reports/41)

映像はXvfbのディスプレイ番号(`GameConfig.display`、タイトルごとに`:96`〜`:99`)で
分離されているが、音声は以前はすべてのジョブがPulseAudioのデフォルトsink
(`module-always-sink`が自動生成する`auto_null`)を暗黙に共有しており、同一ホストで
複数ジョブを並列録画すると**全ジョブの音声が混ざって記録される**問題があった。
EC2 Fleet(1インスタンス=1ジョブ)では顕在化しないが、自宅サーバーを追加ワーカーとして
併用する構想(Issue #49)の前提としてこれを解消した。

- **原因はPulseAudio・Wineいずれの構造的制約でもない**。WINEPREFIXのレジストリにある
  `winepulse.drv`の`devices`設定は「PulseAudioバックエンドを使う」という指定でしか
  なく、接続先sinkを固定しない。実際の出力先はPulseAudioクライアントライブラリの
  規則(`PULSE_SINK`環境変数、無指定ならデフォルトsink)に従うだけである。
- **対策**: ジョブごとに専用のnull-sinkを作り、ゲーム(Wine)側は`PULSE_SINK`で出力先を
  そのsinkに固定し(`GameConfig.build_env()`)、録音側ffmpegはそのsinkのmonitor
  (`GameConfig.pulse_source` = `<sink名>.monitor`)を入力にする。Wine側・MOD側の
  変更は不要。
- **sinkのライフサイクル**は`recording_common.record_with_retry()`が
  `pulse.job_sink()`で管理する。録画開始時に作成し、成功・失敗を問わず戻る際に
  unloadする。全試行(自動リトライ)で1つのsinkを共有する。
- sink名は`pulse.sink_name_for_job()`でjobIdから採番する
  (`sattori_job_<英数字・アンダースコアに正規化したjobId>`)。jobIdの生成規則に
  依存しないよう、PulseAudioのsink名として安全な文字種へ必ず正規化する。
  `entrypoint.py`が`--pulse-sink`で録画スクリプトへ渡す。ローカル単体実行時
  (`--pulse-sink`未指定)はプロセスIDから採番する。
- 作成前に**同名のsinkが残っていれば必ずunloadする**(`pulse.remove_sink()`)。
  ワーカーがSIGKILL等で強制終了するとunloadが走らず孤児sinkが残り、同名sinkが既に
  存在する状態で作成すると新しいsinkが`<名前>.2`へリネームされて、`<名前>.monitor`が
  前回の孤児sinkを指してしまうため。掃除の対象を同名sinkに限定しているのは、
  `sattori_job_*`を一括削除すると並列実行中の他ジョブの音声を巻き込んで壊すため。
- **`auto_null`には依存しない**。`module-always-sink`は「他にsinkが1つも無い場合にのみ
  `auto_null`を維持する」仕様のため、専用sinkを作った時点で`auto_null`は消えるが、
  専用sinkしか使わない以上これは無害である(以前`entrypoint.py`にあった「sinkを追加
  すると`auto_null`が消えて録画が失敗する」という注意書きはこの設計変更で解消した)。
- **EC2 Fleet(1インスタンス=1ジョブ)でも同じコードパスを通す**。1ジョブしかない環境で
  専用sinkを使うこと自体に副作用はなく(既存の`-copyts`+実測`-itsoffset`によるA/V同期
  補正にも影響しないことをreports/41で確認済み)、環境分岐を作らない方がテスト・保守が
  容易なため。
- 実機検証(2026-08-08、このリポジトリのローカル環境): th07とth08を専用sink付きで
  同時録画し、`pactl list sink-inputs`で各ゲームが自分のsinkにのみ接続していることを
  確認した上で、th08プロセスをSIGSTOPで停止する対照実験を行った。停止中のth08側sinkの
  monitorは`mean_volume: -91.0 dB`(実質無音)まで落ちる一方、動作を続けているth07側は
  `-8.1 dB`のままで、混成が起きていないことを確認した(reports/41 Task 3と同じ手順)。
  単一ジョブ(th06、`th6_03.rpy`)の通し録画(379秒)も併せて実施し、リグレッションが
  ないことを確認した(重複フレーム率0.3%、音声トラックあり(mean -10.3 dB)、
  終了検知・sinkの破棄とも正常)。このときのA/V同期の実測ズレは-0.045秒で、
  `auto_null`共有時にローカルで観測されていた0.6〜1.4秒より小さい
  (専用sinkではゲームの音声ストリームが既に流れている状態で録音ffmpegを開始する
  ためと考えられる、reports/41 §4)。いずれにせよ実測ベースの`-itsoffset`補正が
  値によらず吸収するため、この差自体は問題にならない。

## テスト(`tests/`)

Wine/Xvfb/実ゲームに依存する録画本体(`recording_common.attempt_recording()`)以外の、
純粋なロジック部分(MAD計算・ffmpegコマンド組み立て・fps暴走/重複フレーム率の判定・
720pアップスケールの解像度/進捗計算・DynamoDB更新式の組み立て・Spot中断/リバランス
判定・進捗レポートの重複排除等)を pytest でユニットテストする。boto3 呼び出しは
`unittest.mock` でモックし、実際の AWS リソースには接続しない(moto 等の
追加依存は導入していない)。

```bash
pip install -r requirements-dev.txt
pytest
```

GitHub Actions の `Test` ワークフロー(`.github/workflows/test.yml`)の
`worker-test` ジョブで push・PR 毎に自動実行される。

## リポジトリに含まれない資産(ビルド前に配置が必要)

以下はゲーム本体(著作権物)・ビルド成果物・素材であり `.gitignore` 済み。

`worker/assets/watermark/watermark-60fps.webm`(ウォーターマーク素材、VP9アルファ)と
`worker/assets/replay_end_templates/{th06,th07,th08}.png`(リプレイ終了検知用の
リプレイ選択画面テンプレート、touhou-recorder reports/33・34参照)は、いずれもタイトル
固有アセットではなく録画パイプライン自体が使う共通素材として `docker build` の前に
`worker/` 配下へ配置し、イメージに含める(ゲーム本体ではないため、後述のタイトル資産
S3アーカイブには含めずイメージへ焼き込む)。

一方、ゲーム本体(`worker/games/{title}/`)・WINEPREFIX(`worker/prefixes/{title}-*/`)・
MODビルド成果物(`worker/mods/**/build/*`)は **イメージには含めない**。ECRストレージ
コストがタイトル数に比例して増大する問題(Issue #22)への対応として、これらは
タイトルごとに1本のアーカイブへまとめてS3へアップロードし、ワーカーが `GAME`
環境変数に応じて起動時にダウンロード・展開する(`title_assets.py`)。手順は次節
「タイトル資産のS3アップロード手順」を参照。

## WINEPREFIXの作成・フォント修正(`setup_wineprefix.sh`)

`worker/prefixes/{title}-wined3d-gl/`(WINEPREFIX)自体は`.gitignore`済みのビルド
成果物だが、その生成手順(`wineboot`初期化・MS Gothicフォントの配置・レジストリ
登録)は`worker/setup_wineprefix.sh`としてコード化してある。th07・th08の
`th{N}.exe`はGDIのフォント名指定にShift_JISで`ＭＳ ゴシック`をハードコードして
おり、これに対応するフォントファイル・レジストリがWINEPREFIXに無いと、
タイトル画面やスペルカード名等の動的描画テキストが文字化けする
(touhou-recorder reports/13, reports/29)。th07には元から適用されていたが
th08には未適用だったため、本番で文字化けが発生していた(2026-07-23に修正・
再アップロード済み)。

```bash
cd worker
# 新規WINEPREFIXを作る場合(wineboot初期化から)
./setup_wineprefix.sh prefixes/th08-wined3d-gl /path/to/msgothic.ttc
# 既存WINEPREFIXにフォント修正のみ適用する場合(ディレクトリが存在すればwineboot初期化はスキップされる)
./setup_wineprefix.sh prefixes/th08-wined3d-gl /path/to/msgothic.ttc
```

th11は上記に加えてMS明朝(`msmincho.ttc`)の配置・レジストリ登録も必要
(NPC会話シーン等でのフォント誤り対策、touhou-recorder reports/38、上記「th11対応の
技術的背景」参照)。第3引数にmsmincho.ttcのパスを渡すと追加で登録される:

```bash
cd worker
./setup_wineprefix.sh prefixes/th11-wined3d-gl /path/to/msgothic.ttc /path/to/msmincho.ttc
```

`msgothic.ttc`(実際のMS Gothic/MS PGothic/MS UI Gothicを含むTrueTypeコレクション)・
`msmincho.ttc`(実際のMS Mincho/MS PMinchoを含むTrueTypeコレクション)はいずれも
Windowsのライセンスフォントであり、著作権上リポジトリにもS3にも単体では置いて
いない。Windows実機等から別途用意すること。

日本語ロケール(`LANG=ja_JP.UTF-8`/`LC_ALL=ja_JP.UTF-8`)はWINEPREFIX作成時ではなく
`recording_common.py`が起動時に毎回設定するため、このスクリプトでは扱わない
(reports/13で「WINEPREFIXが英語ロケールで初期化されているとANSI文字列の変換が
壊れる」問題が見つかったが、対策はプレフィックス再作成ではなく実行時の環境変数で
足りると判明した)。

このスクリプトが対応するのはtouhou-recorderのレポートで実際に文書化・検証された
範囲(プレフィックス初期化+フォント修正)のみ。それ以外にWINEPREFIXへ手作業で
加えた変更があった場合、このスクリプトでは再現されない可能性がある。

WINEPREFIXを新規作成・更新した後は、次節の手順でタイトル資産アーカイブに含めて
S3へアップロードすること。

## タイトル資産のS3アップロード手順(Issue #22)

新タイトル追加時(#13)や既存タイトルのゲーム本体・MOD更新時は、以下の3点を
1本の tar.gz にまとめて `s3://${TITLE_ASSETS_BUCKET}/titles/{title}/assets.tar.gz`
へアップロードする(`TITLE_ASSETS_BUCKET` は `cdk deploy` 後の `TitleAssetsBucketName`
出力を参照)。アーカイブ内のパスは `worker/` 配下への展開先と一致させること
(`title_assets.py` が `/app`(`REPO`)直下へ相対パスのまま展開するため):

```
games/{title}/                                  # ゲーム本体一式(.cfg はウィンドウモード必須)
prefixes/{title}-wined3d-gl/                    # 日本語ロケール初期化済み WINEPREFIX
mods/common/build/injector.exe                  # DLL インジェクタ(共通。下記手順でビルド)
mods/{title}_replay_autoplay/build/{title}_hook.dll  # 自動再生 MOD(タイトル毎。下記手順でビルド)
```

例(th07。ビルドマシンが `worker/` チェックアウトで各資産を配置済みの前提):

```bash
cd worker
tar -czf /tmp/th07-assets.tar.gz \
  games/th07 \
  prefixes/th07-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th07_replay_autoplay/build/th07_hook.dll
aws s3 cp /tmp/th07-assets.tar.gz "s3://${TITLE_ASSETS_BUCKET}/titles/th07/assets.tar.gz"
```

th08の場合、`games/th08` には**公式アップデータ ver1.00d 相当のゲームデータ**を
配置すること(ver1.00a はfps暴走の既知不具合があり非推奨、reports/23):

```bash
cd worker
tar -czf /tmp/th08-assets.tar.gz \
  games/th08 \
  prefixes/th08-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th08_replay_autoplay/build/th08_hook.dll
aws s3 cp /tmp/th08-assets.tar.gz "s3://${TITLE_ASSETS_BUCKET}/titles/th08/assets.tar.gz"
```

th06の場合、`games/th06/`配下ではゲーム本体の実行ファイルを**元の`東方紅魔郷.exe`の
まま配置する(th07/th08と異なりリネームしないこと)**。VsyncPatch(`vpatch_th06.dll`)が
対象プロセスの実行ファイル名を検証しているらしく、`th06.exe`へリネームすると
`WaitForStableWindow`が`stable`に到達せずCPU使用率100%で張り付く白画面ハングが
再発することを実機検証で確認した(2026-07-23、元のファイル名のままなら約3.5秒で
正常に安定)。`record_th06.py`は`GameConfig`に`game_exe="東方紅魔郷.exe"`を明示
指定している(未指定時のth07/th08は従来通り`f"{game_id}.exe"`を自動導出)。また、
wined3dの白画面ハング回避に必須の`vpatch_th06.dll`・`vpatch.ini`(VsyncPatch本体、
`mods/th06_replay_autoplay/`配下ではなく`games/th06/`直下に同梱する。
`recording_common.prepare_instance()`のrsyncで自動コピーされるため個別の
`mods/{title}_replay_autoplay/build/`配置は不要):

```bash
cd worker
tar -czf /tmp/th06-assets.tar.gz \
  games/th06 \
  prefixes/th06-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th06_replay_autoplay/build/th06_hook.dll
aws s3 cp /tmp/th06-assets.tar.gz "s3://${TITLE_ASSETS_BUCKET}/titles/th06/assets.tar.gz"
```

th11の場合、WINEPREFIXはMS明朝も登録済みのものを使うこと(上記「WINEPREFIXの作成・
フォント修正」参照)。ゲーム本体・MODファイル名はth07/th08と同じ命名則
(`th11.exe`・`th11_hook.dll`)で、`GameConfig.game_exe`/`process_name`の
オーバーライドは不要:

```bash
cd worker
tar -czf /tmp/th11-assets.tar.gz \
  games/th11 \
  prefixes/th11-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th11_replay_autoplay/build/th11_hook.dll
aws s3 cp /tmp/th11-assets.tar.gz "s3://${TITLE_ASSETS_BUCKET}/titles/th11/assets.tar.gz"
```

th20の場合、`games/th20/` には**cfg(`th20.cfg`、ウィンドウモードのもの)を必ず同梱する**
(`prepare_instance()` が `%APPDATA%` へコピーする元になる。無いと初回起動時の解像度選択
ダイアログで止まる、reports/44)。WINEPREFIX はth11と同じくMS明朝も登録済みのものを使う:

```bash
cd worker
tar -czf /tmp/th20-assets.tar.gz \
  games/th20 \
  prefixes/th20-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th20_replay_autoplay/build/th20_hook.dll
aws s3 cp /tmp/th20-assets.tar.gz "s3://${TITLE_ASSETS_BUCKET}/titles/th20/assets.tar.gz"
```

> アーカイブ内の `prefixes/th20-wined3d-gl/drive_c/users/<name>/` は、アーカイブを作った
> 開発機のユーザー名のままでよい。ワーカーは実行中のUNIXユーザーから `%APPDATA%` を
> 解決する(`recording_common.resolve_appdata_dir()`)ので、コンテナの実行ユーザーと
> 一致させる必要はない。

`title_assets.py` はインスタンス起動時に `worker/games/{title}/` が既に存在するかを
確認し、無ければこのアーカイブをダウンロード・展開する(存在すればスキップ、
Spot中断リトライ時の同一インスタンス再利用等を想定)。展開先はワーカーイメージ内の
`/app` 直下で、`record_{game}.py` が既定で参照するパス(`/app/games/{game}`、
`/app/prefixes/{game}-wined3d-gl` 等)と一致する。

## MOD (DLL インジェクタ / 自動再生フック) のビルド

`mods/` はソースのみ管理しており、`injector.exe` / `th06_hook.dll` / `th07_hook.dll` /
`th08_hook.dll` / `th11_hook.dll` 自体は `.gitignore` 済みのビルド成果物。
**Windows + Visual Studio (C++ x86/x64 tools)** が必要(ゲームが 32bit ネイティブ
Win32 バイナリのため MSVC の x86 ツールチェーンでビルドする)。x86 Native Tools
Command Prompt for VS、または通常のコマンドプロンプトから:

```bat
worker\mods\common\build_injector.bat
worker\mods\th06_replay_autoplay\build.bat
worker\mods\th07_replay_autoplay\build.bat
worker\mods\th08_replay_autoplay\build.bat
worker\mods\th11_replay_autoplay\build.bat
worker\mods\th20_replay_autoplay\build.bat
```

- `build_injector.bat` は `setup_vcvars.bat`(vswhere.exe で VS を検出し
  `vcvars32.bat` を呼ぶ)経由で環境を整えてから `cl.exe` で
  `worker/mods/common/build/injector.exe` を生成する(タイトル非依存の共通バイナリ。
  複数DLLの順次注入に対応、th06のVsyncPatch+MOD本体の共存に使う)。
- `th06_replay_autoplay/build.bat` / `th07_replay_autoplay/build.bat` は `dllmain.cpp` と
  `common/` の `dinput_hook.cpp` / `window_wait.cpp` / `logging.cpp` を静的にまとめて
  それぞれ `worker/mods/th06_replay_autoplay/build/th06_hook.dll` /
  `worker/mods/th07_replay_autoplay/build/th07_hook.dll` を生成する。
- `th20_replay_autoplay/build.bat` は上記に加えて `fps_limiter_hook.cpp` /
  `dsound_hook.cpp` / `fps_display_hook.cpp` を含める(それぞれ Present のフレームレート
  制御・低速録画時の音声スケール・fps表示補正。上記「th20対応の技術的背景」「低速録画」
  参照)。mingw-w64 でクロスビルドする場合、th20だけは `-static` も必須
  (付けないと wine 実行時に `libgcc_s_dw2-1.dll` / `libstdc++-6.dll` が見つからず
  DLL 注入が失敗する、reports/44):
  ```bash
  cd worker/mods/th20_replay_autoplay
  i686-w64-mingw32-g++ -shared -O2 -o build/th20_hook.dll \
    dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
    ../common/logging.cpp ../common/fps_monitor.cpp ../common/fps_limiter_hook.cpp \
    ../common/dsound_hook.cpp ../common/fps_display_hook.cpp \
    -luser32 -static-libgcc -static-libstdc++ -static
  ```
- `th08_replay_autoplay/build.bat` / `th11_replay_autoplay/build.bat` も同様に
  `fps_monitor.cpp`(fps暴走検知用、reports/22)を加えてそれぞれ
  `worker/mods/th08_replay_autoplay/build/th08_hook.dll` /
  `worker/mods/th11_replay_autoplay/build/th11_hook.dll` を生成する
  (th11は`InstallKeyboardStateHook`を使うが、リンクするソースファイル自体はth08と
  同じ構成)。
- MSVCが使えない検証環境では `mingw-w64`(`i686-w64-mingw32-g++`)でも同一ソースを
  クロスビルドできる(実機注入テストでMSVCビルドと同一挙動を確認済み、reports/25)。
  正式なビルド手順は引き続きMSVC想定(`build.bat`)で、mingw-w64は調査目的のセルフ
  ビルド用途の位置づけ:
  ```bash
  i686-w64-mingw32-g++ -shared -O2 -o build/th08_hook.dll \
    dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
    ../common/logging.cpp ../common/fps_monitor.cpp \
    -luser32 -static-libgcc -static-libstdc++
  ```
- ビルドしたら各DLLはゲーム本体・WINEPREFIXと合わせてタイトル資産のtar.gzへまとめ、
  S3へアップロードする(`docker build` には含めない。前節「タイトル資産のS3
  アップロード手順」参照)。

## 実行時の環境変数

`apps/api` の `ec2.buildUserData` が UserData 経由でコンテナに渡す:

| 変数 | 説明 |
| --- | --- |
| `JOB_ID` | ジョブ ID(DynamoDB キー・出力キーに使用) |
| `GAME` | タイトル(`th06` / `th07` / `th08` / `th11` / `th20`。`entrypoint.py` がこの値に応じて
  `record_th06.py` 〜 `record_th20.py` を呼び分ける) |
| `REPLAY_BUCKET` / `REPLAY_KEY` | アップロード済みリプレイの S3 位置 |
| `OUTPUT_BUCKET` | 録画動画の出力先バケット(CloudFront オリジン) |
| `TITLE_ASSETS_BUCKET` | タイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)のバケット
  (Issue #22。`title_assets.py` が `GAME` に応じてダウンロード・展開する) |
| `JOBS_TABLE` | ジョブ状態の DynamoDB テーブル名 |
| `WATERMARK` | `1` でウォーターマーク合成、`0` で無効 |
| `TASK_TOKEN` | Step Functions の `waitForTaskToken` トークン(省略時は通知をスキップ、ローカル検証用) |
| `EXPECTED_DURATION_SECONDS` | リプレイの推定再生時間(進捗率算出の参考値、省略可) |
| `FPS_LIMIT_TARGET_HZ` | 低速録画(Issue #68)の目標fps。**省略時は等倍**(既定60)。
  自宅ワーカーへのオファー時のみ `30` が渡る(EC2 起動時は付かない)。上記「低速録画」参照 |

## 出力ファイル

録画完了後、`upscale.py` で720p(アスペクト比維持、th06・th07なら960x720)へ変換した版を
別ファイルとして追加生成し、元動画と合わせて2本を `OUTPUT_BUCKET` へアップロードする
(同時録画中のアップスケールは4vCPU構成で重複フレーム率を悪化させるため採用しない、
reports/21)。th06・th07(640x480)のような低解像度録画はそのままだと YouTube 側で60fpsと
認識されないため、ページBの主要ダウンロードボタンは既定で720p版を案内する。

| S3キー | 内容 |
| --- | --- |
| `videos/{jobId}.mp4` | 録画そのままの解像度(DynamoDB `outputPath`)。録画完了直後、
  変換前にチェックポイントとしてアップロードされる(Issue #11) |
| `videos/{jobId}_720p.mp4` | 720pアップスケール版(DynamoDB `outputPath720p`) |
| `progress/{jobId}/{unixMillis}.jpg` | 録画中の進捗スクリーンショット(DynamoDB
  `previewImagePath`)。スナップショット毎にユニークなキーを使う(CloudFrontの
  長期キャッシュで古い画像が返り続けるのを避けるため) |
| `worker-logs/{jobId}/ffmpeg-upscale.log` | 720p変換のffmpeg生ログ(下記「720p変換の
  ffmpegログ」参照)。診断用データのため`OutputBucket`内で3日の短いライフサイクル
  ルールが別途設定されており、DynamoDBにも保存しない(jobIdから決定的に導出可能、
  `apps/api/src/downloads.ts`の`buildFfmpegUpscaleLogKey`) |

動画のアップロード時には**そのバイト数も DynamoDB へ記録する**
(`outputBytes`/`outputBytes720p`、`entrypoint.py`の`upload_video()`が
`os.path.getsize()`の値を返し`status.py`の`update_status()`が書き込む。Issue #60)。
管理画面のコスト推定でS3保管料とCloudFront配信量の入力になる。動画サイズは本サービスの
コスト構造で最大のレバレッジ(`docs/aws-region-cost-analysis.md` §6)なので、平均値で
丸めずジョブ単位の実測を残す。生動画のサイズは`done`遷移時にも併せて書く
(チェックポイントから再開したジョブは`record()`を通らないため)。

### 720p変換のffmpegログ(Issue #58フォローアップ)

`upscale.py`は720p変換中、ffmpegの`-progress`生出力(`frame=`/`fps=`/`bitrate=`等、
`out_time_ms`以外の全キー)を1行ずつ受け取る。当初はこれをそのままCloudWatch Logsへ
流していたが、1ジョブで数千行に達し管理画面のログビューア(Issue #58)で他のログを
埋もれさせる実害が判明した。録画本体のffmpeg(`recording_common.py`の映像/音声プロセス、
下記「映像/音声を別プロセスで録画」)は元々ファイル出力＋失敗時のみ末尾をCloudWatchに
残す方式だったため、`upscale_to_720p()`もこれに合わせ、`ffmpeg_log_path`引数で渡された
ローカルファイルへ書き出す方式に変更した。変換の成否にかかわらず(`entrypoint.py`が
`finally`で)そのファイルをS3(`worker-logs/{jobId}/ffmpeg-upscale.log`)へアップロード
する。CloudWatchには変換失敗時のみ末尾2000バイトを残す(録画側と同じ方針)。

## Spot中断時のリトライと再開(Issue #11)

`entrypoint.py` は起動直後にDynamoDBのジョブレコードを確認し、`outputPath`
(上記の生動画チェックポイント)が既に設定済みなら「変換から再開」する(S3から
生動画をダウンロードし、録画をスキップして720p変換から実行する)。Step Functions
がSpot中断/タイムアウトを検知して新しいワーカーインスタンスでリトライした場合、
このチェックポイントにより録画をやり直さずに済む(録画フェーズ自体の途中再開は
非対応で、中断時はそのフェーズを最初からやり直す)。

`interruption_watcher.py` がIMDS経由でSpot中断通知/リバランス推奨(いずれも2分前
通知)を監視し、検知次第 taskToken 経由で Step Functions に早期失敗通知する
(60分のタスクタイムアウトを待たずに新インスタンスでのリトライを開始させるため)。

## 緊急停止されたジョブへの書き込み拒否(`status.py`)

`update_status()` は `attribute_not_exists(stopRequestedAt)` を条件にしかジョブ
レコードを更新しない(条件が崩れたらログだけ残して何もしない。停止済みジョブへの
書き込み拒否は想定内の正常系なので例外にしない)。

管理画面からの緊急停止(Issue #59)は EC2 なら `TerminateInstances` でワーカーを
即座に黙らせられるが、自宅ワーカー(Issue #49)のコンテナは常駐デーモンが claim の
取り消しに気づくまで走り続ける。その間に完走すると `done` と `doneAt` が書かれ、
DynamoDB Streams 経由で**停止したはずのジョブの完了メールがユーザーへ飛ぶ**。
`stopRequestedAt` は停止要求がワーカーの生存期間より長生きするための拒否票で、
ワーカー側は「自分が自宅かEC2か」を知る必要がなく、どちらも同じ票を尊重するだけ
でよい(録画パイプラインに実行環境の分岐を持ち込まない方針のまま扱える)。

## ローカルでの録画単体テスト(ネットワーク不要)

ゲーム資産を配置済みであれば、S3/DynamoDB を介さず録画本体だけを試せる:

```bash
python3 record_th07.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
python3 record_th08.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
python3 record_th11.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
```

音声の録音先となるPulseAudio sink(上記「並列録画時の音声分離」)は`--pulse-sink`未指定
ならプロセスIDから採番されるため、複数タイトルを同時に走らせても音声は混ざらない
(ディスプレイ番号もタイトルごとに異なるため映像も干渉しない)。特定の名前を使いたい
場合のみ`--pulse-sink sattori_job_xxx`を明示する。

```bash
# 2並列で音声が分離されていることを確かめる例
python3 record_th07.py --replay-path /path/to/th7.rpy --output /tmp/th07/out.mp4 &
python3 record_th08.py --replay-path /path/to/th8.rpy --output /tmp/th08/out.mp4 &
pactl list sink-inputs | grep -E "Sink:|application.name"  # 各ゲームが別sinkに繋がる
```

720pアップスケール変換だけを試す場合(ffmpeg/ffprobeがあれば動作する):

```bash
python3 -c "from upscale import upscale_to_720p; upscale_to_720p('/tmp/out.mp4', '/tmp/out_720p.mp4')"
```

## ビルド

```bash
docker build -t sattori-worker:latest worker/
```

## ECRへのpush

本番のECRリポジトリ名は`sattori-worker`（`infra/lib/sattori-stack.ts`が作成、
本体スタックと同じくeu-south-2）。`docker build`とは別に、タグ付け・ログイン・
pushが必要:

```bash
docker build -t <account>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest worker/
aws ecr get-login-password --region eu-south-2 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.eu-south-2.amazonaws.com
docker push <account>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest
```

`worker/assets/`（ウォーターマーク・終了検知テンプレート）は`.gitignore`対象のため、
クリーンなチェックアウトからは`docker build`前にビルドコンテキストへ配置しておく
こと（上記「リポジトリに含まれない資産」参照）。

## 制約と今後

- 対応タイトルは th06・th07・th08・th11・th20。他タイトルはリプレイパーサー側は
  多タイトル対応済みだが、録画対応(MOD移植)は未着手(AGENTS.md参照)。
- **th20はデシンクが起きやすい**。録画側では検知も対処もできない(リプレイファイル・
  ゲーム本体側の現象)ため、ページAでユーザーへ事前に注意書きを出すことで対応している
  (Issue #87)。想定尺を大幅に超えてタイムアウトへ近づいたジョブは、まずこれを疑うこと。
- **th20の720p版はダウンスケールになる**。th20の録画は1280x960で、`upscale.py`は
  アスペクト比を保って高さ720pxへ合わせるため960x720へ**縮小**される。ページBの主要
  ダウンロードボタンが既定で案内するのは720p版なので、th20では既定の導線が低い解像度を
  指すことになる。720p版が存在する理由は「低解像度録画がYouTubeで60fpsと認識されない」
  ことへの対策(reports/21)であり、元から720p以上あるth20には当てはまらない。
  ダウンロード導線の見直しは別途対応する(Issue #99)。
- **`mods/common/dinput_hook.cpp`のth20対応修正(vtable[3]の二重フック防止、reports/44)は
  th06/07/08/11のビルド済みDLLに反映されていない**。これらは`DirectInput8Create`を
  1回しか呼ばないため現状は無害だが、ソースとビルド済み成果物が乖離している。
  次にこれらのMODを触る際は本修正込みで再ビルドし、タイトル資産を再アップロードすること。
- th11の文字輪郭のジャギー(Windows実機よりWineのFreeTypeベースAAが粗い)は
  原因調査済み・対策なしの既知の制約として残る(touhou-recorder reports/39)。
- th11は画面静止検知のみで終了判定するため、Pause Menu明滅カーソル以外の要因による
  誤検知(長時間静止するステージ間演出等)のリスクを本質的には排除できていない
  (th06(reports/33)と同様の注意が必要)。
- リプレイ内容の解析・デシンク検知は未実装。デシンク(記録時と再生時でプレイヤー操作と
  ゲーム進行がズレ、想定外の被弾で残機が0になり強制終了する現象)が起きると、
  録画が`estimatedDurationSeconds`よりはるかに早くリプレイ選択画面に戻って終了する
  (本番ジョブ`64367b3c-64f5-47c4-be9d-e0c4aa8a35d8`の調査で確認。同一リプレイ・
  同一バイナリのWindows実機、および記録元と推測されるver1.00aのゲームデータでも
  同じ箇所で再現しており、Wine環境やver1.00d固有の不具合ではなくリプレイファイル
  自体に起因する)。この症状は「早期に終了検知/異常検知が誤発火した」ように見えて
  紛らわしいため、録画失敗・早期終了の調査では、fps暴走やリプレイ選択画面テンプレートの
  誤マッチ等の検知ロジック側を疑う前に、まず実際に録画された映像を目視して
  デシンクによる強制終了(不自然な被弾・ゲームオーバー、その直後のリプレイ選択画面への
  遷移)が起きていないか確認すること。デシンクは検知ロジックの閾値調整やリトライでは
  解決しない(同一リプレイなら何度録画しても同じ箇所で再現する)ため、現時点で対処法はない。
