# worker — Sattori 録画ワーカー

東方紅魔郷(th06)・東方妖々夢(th07)・東方永夜抄(th08)・東方地霊殿(th11)のリプレイを
Wine + Xvfb + ffmpeg でヘッドレス録画し、S3 へアップロードする Python ワーカー。AWS EC2
Spot インスタンス上で Docker コンテナとして実行される。技術的背景は `touhou-recorder` の
PoC レポート(th07: `reports/11`, `reports/13`, `reports/14`, `reports/16`, `reports/17`,
`reports/21`。th08: `reports/22`〜`reports/26`、Issue #13。th06: `reports/30`〜`reports/32`。
th11: `reports/35`〜`reports/39`)を参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `entrypoint.py` | ジョブ全体の制御。DynamoDBのチェックポイント確認 → (再開でなければ)S3 DL →
  録画 → 生動画をS3へチェックポイントUP → 720p変換 → S3 UP → DynamoDB/taskToken 通知。
  GAME環境変数に応じて `record_th06.py` / `record_th07.py` / `record_th08.py` /
  `record_th11.py` を呼び分ける |
| `recording_common.py` | th06・th07・th08・th11共通の録画パイプライン本体(Issue #13でth08
  対応時に共通化)。Xvfb起動・ウィンドウ検出(画面外へのはみ出しを補正する
  `windowmove`再試行ループを含む。既に画面内に収まっているウィンドウは`windowmove`
  自体を呼ばない、後述「ウィンドウ位置の強制移動と再試行ループ」参照)・録画・終了検知
  (リプレイ選択画面テンプレートとの照合。テンプレート未整備のゲームは画面静止のMAD判定に
  フォールバック、reports/33・34。静止判定は`GameConfig.still_detect_exclude_rect`で
  指定した矩形をMAD計算から除外できる、th11のPause Menu明滅カーソル対策、reports/37・38)・
  fps暴走/処理落ちの早期検知・自動リトライ(既定3回)・映像/音声を別プロセスで録画し
  後でmuxする処理(reports/26)・フックDLLより前に追加DLLを注入する処理
  (`GameConfig.extra_dlls`、th06のVsyncPatch用)を担う。進捗スクリーンショット/状態も
  書き出す |
| `record_th06.py` / `record_th07.py` / `record_th08.py` / `record_th11.py` | タイトル
  固有のパス設定(`GameConfig`)を組み立てて `recording_common.record_with_retry()` を
  呼ぶだけの薄いラッパー |
| `upscale.py` | 録画動画をアスペクト比を保って720pへアップスケールする後処理(reports/21)。
  進捗コールバック対応 |
| `status.py` | DynamoDB へのジョブ状態・進捗反映、チェックポイント確認用のジョブ取得 |
| `interruption_watcher.py` | Spot中断通知/リバランス推奨をIMDS経由で監視するバックグラウンドスレッド |
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
  が閾値(100Hz)超過が2回連続したら異常とみなす(単発のノイズを誤検知しないため、
  reports/23)。
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
- **ウィンドウ位置の強制移動と再試行ループ(全ゲーム共通)**: openboxの初期配置に
  よってはウィンドウがXVFB_SCREEN(800x600)の範囲外にはみ出す位置に置かれることが
  ある(th11実機検証で発覚、reports/35)。ウィンドウが既にXVFB_SCREENの範囲内に収まって
  いる場合は`windowmove`自体を呼ばない。範囲外の場合のみ`xdotool windowmove`で
  左上(0,0)へ強制移動するが、装飾のあるウィンドウでは移動後の実座標(クライアント
  領域)を再取得しないとタイトルバー分ずれて録画される(reports/37)。さらに
  `windowmove`の反映は非同期なため、座標がXVFB_SCREENの範囲内に収まるまで最大20回
  (0.1秒間隔)再試行する。
  この「既に範囲内なら`windowmove`を呼ばない」という条件は、2026-07-28にsattori側で
  th06/07/08向けゲームデータを新しいものへ差し替えた際の実機再検証で追加したもの。
  当初はこの対策を全ゲーム共通で無条件に適用しており「th06/07/08では実害がなかった」
  としていたが(reports/37)、この再検証でth07・th08について実害
  (タイトルバーがゲーム画面上端に重なり下端が録画されない)が偶発的に再現した。原因は
  openboxが装飾込みのウィンドウ枠を画面内に収めようとする再配置と`windowmove`直後の
  座標再取得が競合するレース条件で、画面内に収まる座標を検出した瞬間がまだ装飾抜きの
  一時的な値(見かけ上(0,0))であることがあり、それを「安定した」座標として確定して
  しまうと装飾が録画範囲に戻ってきてしまう。既に範囲内に収まっているウィンドウは
  移動自体が不要なため、その場合は`windowmove`を呼ばないことでこの競合を回避した
  (th06/07/08は通常この経路)。実際に移動が必要な場合(th11等)は競合を避けられないため、
  移動後の座標を0.3秒後に再取得し一致することを確認してから確定するようにした
  (`worker/recording_common.py`)。
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
```

- `build_injector.bat` は `setup_vcvars.bat`(vswhere.exe で VS を検出し
  `vcvars32.bat` を呼ぶ)経由で環境を整えてから `cl.exe` で
  `worker/mods/common/build/injector.exe` を生成する(タイトル非依存の共通バイナリ。
  複数DLLの順次注入に対応、th06のVsyncPatch+MOD本体の共存に使う)。
- `th06_replay_autoplay/build.bat` / `th07_replay_autoplay/build.bat` は `dllmain.cpp` と
  `common/` の `dinput_hook.cpp` / `window_wait.cpp` / `logging.cpp` を静的にまとめて
  それぞれ `worker/mods/th06_replay_autoplay/build/th06_hook.dll` /
  `worker/mods/th07_replay_autoplay/build/th07_hook.dll` を生成する。
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
| `GAME` | タイトル(`th06` / `th07` / `th08` / `th11`。`entrypoint.py` がこの値に応じて
  `record_th06.py` / `record_th07.py` / `record_th08.py` / `record_th11.py` を呼び分ける) |
| `REPLAY_BUCKET` / `REPLAY_KEY` | アップロード済みリプレイの S3 位置 |
| `OUTPUT_BUCKET` | 録画動画の出力先バケット(CloudFront オリジン) |
| `TITLE_ASSETS_BUCKET` | タイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)のバケット
  (Issue #22。`title_assets.py` が `GAME` に応じてダウンロード・展開する) |
| `JOBS_TABLE` | ジョブ状態の DynamoDB テーブル名 |
| `WATERMARK` | `1` でウォーターマーク合成、`0` で無効 |
| `TASK_TOKEN` | Step Functions の `waitForTaskToken` トークン(省略時は通知をスキップ、ローカル検証用) |
| `EXPECTED_DURATION_SECONDS` | リプレイの推定再生時間(進捗率算出の参考値、省略可) |

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

## ローカルでの録画単体テスト(ネットワーク不要)

ゲーム資産を配置済みであれば、S3/DynamoDB を介さず録画本体だけを試せる:

```bash
python3 record_th07.py --replay-path /path/to/any.rpy --output /tmp/out.mp4 \
  --watermark assets/watermark/watermark-60fps.webm
python3 record_th08.py --replay-path /path/to/any.rpy --output /tmp/out.mp4 \
  --watermark assets/watermark/watermark-60fps.webm
python3 record_th11.py --replay-path /path/to/any.rpy --output /tmp/out.mp4 \
  --watermark assets/watermark/watermark-60fps.webm
```

720pアップスケール変換だけを試す場合(ffmpeg/ffprobeがあれば動作する):

```bash
python3 -c "from upscale import upscale_to_720p; upscale_to_720p('/tmp/out.mp4', '/tmp/out_720p.mp4')"
```

## ビルド

```bash
docker build -t sattori-worker:latest worker/
```

## 制約と今後

- 対応タイトルは th06・th07・th08・th11。他タイトルはリプレイパーサー側は
  多タイトル対応済みだが、録画対応(MOD移植)は未着手(AGENTS.md参照)。
- th11の文字輪郭のジャギー(Windows実機よりWineのFreeTypeベースAAが粗い)は
  原因調査済み・対策なしの既知の制約として残る(touhou-recorder reports/39)。
- th11は画面静止検知のみで終了判定するため、Pause Menu明滅カーソル以外の要因による
  誤検知(長時間静止するステージ間演出等)のリスクを本質的には排除できていない
  (th06(reports/33)と同様の注意が必要)。
- リプレイ内容の解析・デシンク検知は未実装。
