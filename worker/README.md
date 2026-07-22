# worker — Sattori 録画ワーカー

東方妖々夢(th07)・東方永夜抄(th08)のリプレイを Wine + Xvfb + ffmpeg でヘッドレス
録画し、S3 へアップロードする Python ワーカー。AWS EC2 Spot インスタンス上で Docker
コンテナとして実行される。技術的背景は `touhou-recorder` の PoC レポート
(th07: `reports/11`, `reports/13`, `reports/14`, `reports/16`, `reports/17`, `reports/21`。
th08: `reports/22`〜`reports/26`、Issue #13)を参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `entrypoint.py` | ジョブ全体の制御。DynamoDBのチェックポイント確認 → (再開でなければ)S3 DL →
  録画 → 生動画をS3へチェックポイントUP → 720p変換 → S3 UP → DynamoDB/taskToken 通知。
  GAME環境変数に応じて `record_th07.py` / `record_th08.py` を呼び分ける |
| `recording_common.py` | th07・th08共通の録画パイプライン本体(Issue #13でth08対応時に
  共通化)。Xvfb起動・ウィンドウ検出・録画・終了検知(画面静止のMAD判定)・fps暴走/
  処理落ちの早期検知・自動リトライ(既定3回)・映像/音声を別プロセスで録画し後でmuxする
  処理(reports/26)を担う。進捗スクリーンショット/状態も書き出す |
| `record_th07.py` / `record_th08.py` | タイトル固有のパス設定(`GameConfig`)を組み立てて
  `recording_common.record_with_retry()` を呼ぶだけの薄いラッパー |
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
| `mods/common/` | DLL インジェクタ(`injector.exe`)・共通フック処理・fps計測スレッド
  (`fps_monitor.*`、th08のfps暴走検知用、reports/22)のソース(C++, MSVC) |
| `mods/th07_replay_autoplay/` | th07 自動再生フック DLL(`th07_hook.dll`)のソース(C++, MSVC) |
| `mods/th08_replay_autoplay/` | th08 自動再生フック DLL(`th08_hook.dll`)のソース(C++, MSVC) |

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

`worker/assets/watermark/watermark-60fps.webm`(ウォーターマーク素材、VP9アルファ)
のみ、タイトル非依存の共通素材として `docker build` の前に `worker/` 配下へ配置し、
イメージに含める。

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

`msgothic.ttc`(実際のMS Gothic/MS PGothic/MS UI Gothicを含むTrueTypeコレクション)
はWindowsのライセンスフォントであり、著作権上リポジトリにもS3にも単体では置いて
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

`title_assets.py` はインスタンス起動時に `worker/games/{title}/` が既に存在するかを
確認し、無ければこのアーカイブをダウンロード・展開する(存在すればスキップ、
Spot中断リトライ時の同一インスタンス再利用等を想定)。展開先はワーカーイメージ内の
`/app` 直下で、`record_{game}.py` が既定で参照するパス(`/app/games/{game}`、
`/app/prefixes/{game}-wined3d-gl` 等)と一致する。

## MOD (DLL インジェクタ / 自動再生フック) のビルド

`mods/` はソースのみ管理しており、`injector.exe` / `th07_hook.dll` / `th08_hook.dll`
自体は `.gitignore` 済みのビルド成果物。**Windows + Visual Studio (C++ x86/x64 tools)**
が必要(ゲームが 32bit ネイティブ Win32 バイナリのため MSVC の x86 ツールチェーンで
ビルドする)。x86 Native Tools Command Prompt for VS、または通常のコマンドプロンプトから:

```bat
worker\mods\common\build_injector.bat
worker\mods\th07_replay_autoplay\build.bat
worker\mods\th08_replay_autoplay\build.bat
```

- `build_injector.bat` は `setup_vcvars.bat`(vswhere.exe で VS を検出し
  `vcvars32.bat` を呼ぶ)経由で環境を整えてから `cl.exe` で
  `worker/mods/common/build/injector.exe` を生成する(タイトル非依存の共通バイナリ)。
- `th07_replay_autoplay/build.bat` は `dllmain.cpp` と `common/` の
  `dinput_hook.cpp` / `window_wait.cpp` / `logging.cpp` を静的にまとめて
  `worker/mods/th07_replay_autoplay/build/th07_hook.dll` を生成する。
- `th08_replay_autoplay/build.bat` も同様に `fps_monitor.cpp`(th08のfps暴走検知用、
  reports/22)を加えて `worker/mods/th08_replay_autoplay/build/th08_hook.dll` を生成する。
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
| `GAME` | タイトル(`th07` / `th08`。`entrypoint.py` がこの値に応じて
  `record_th07.py` / `record_th08.py` を呼び分ける) |
| `REPLAY_BUCKET` / `REPLAY_KEY` | アップロード済みリプレイの S3 位置 |
| `OUTPUT_BUCKET` | 録画動画の出力先バケット(CloudFront オリジン) |
| `TITLE_ASSETS_BUCKET` | タイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)のバケット
  (Issue #22。`title_assets.py` が `GAME` に応じてダウンロード・展開する) |
| `JOBS_TABLE` | ジョブ状態の DynamoDB テーブル名 |
| `WATERMARK` | `1` でウォーターマーク合成、`0` で無効 |
| `TASK_TOKEN` | Step Functions の `waitForTaskToken` トークン(省略時は通知をスキップ、ローカル検証用) |
| `EXPECTED_DURATION_SECONDS` | リプレイの推定再生時間(進捗率算出の参考値、省略可) |

## 出力ファイル

録画完了後、`upscale.py` で720p(アスペクト比維持、th07なら960x720)へ変換した版を
別ファイルとして追加生成し、元動画と合わせて2本を `OUTPUT_BUCKET` へアップロードする
(同時録画中のアップスケールは4vCPU構成で重複フレーム率を悪化させるため採用しない、
reports/21)。th07(640x480)のような低解像度録画はそのままだと YouTube 側で60fpsと
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

- 対応タイトルは th07・th08(Issue #13)。他タイトルはリプレイパーサー側は
  多タイトル対応済みだが、録画対応(MOD移植)は未着手(AGENTS.md参照)。
- リプレイ内容の解析・デシンク検知は未実装。
