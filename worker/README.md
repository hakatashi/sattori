# worker — Sattori 録画ワーカー

東方リプレイを Wine + Xvfb + ffmpeg でヘッドレス録画し、S3 へアップロードする Python
ワーカー。AWS EC2 Spot インスタンス、または自宅サーバー(`home-worker/`)上で Docker
コンテナとして実行される。**ここには「今どうなっているか」だけを書く** ——
タイトル別の背景は [`docs/titles/`](docs/titles/README.md)、横断的な設計判断の根拠は
[`docs/decisions/`](../docs/decisions/README.md) にある(§1)。

## 目次

- [1. 対応タイトル](#1-対応タイトル)
- [2. 構成](#2-構成)
- [3. 実行時の環境変数](#3-実行時の環境変数)
- [4. 出力ファイル](#4-出力ファイル)
- [5. 低速録画(Issue #68)](#5-低速録画issue-68)
- [6. Spot中断時のリトライと再開(Issue #11)](#6-spot中断時のリトライと再開issue-11)
- [7. ジョブレコードへの書き込み規約](#7-ジョブレコードへの書き込み規約)
- [8. リポジトリに含まれない資産とタイトル資産アーカイブ(Issue #22)](#8-リポジトリに含まれない資産とタイトル資産アーカイブissue-22)
- [9. MOD・WINEPREFIX](#9-modwineprefix)
- [10. テスト(`tests/`)](#10-テストtests)
- [11. ローカルでの実行(ネットワーク不要)](#11-ローカルでの実行ネットワーク不要)
- [12. ビルドとECRへのpush](#12-ビルドとecrへのpush)
- [13. 既知の制約](#13-既知の制約)

## 1. 対応タイトル

| タイトル | 録画スクリプト | 技術的背景 | 終了検知 | 解像度 |
| --- | --- | --- | --- | --- |
| th06 東方紅魔郷 | `record_th06.py` | [docs/titles/th06.md](docs/titles/th06.md) | テンプレート照合 | 640x480 |
| th07 東方妖々夢 | `record_th07.py` | [docs/titles/th07.md](docs/titles/th07.md) | テンプレート照合 | 640x480 |
| th08 東方永夜抄 | `record_th08.py` | [docs/titles/th08.md](docs/titles/th08.md) | テンプレート照合 | 640x480 |
| th10 東方風神録 | `record_th10.py` | [docs/titles/th10.md](docs/titles/th10.md) | テンプレート照合(絞り込み領域) | 640x480 |
| th11 東方地霊殿 | `record_th11.py` | [docs/titles/th11.md](docs/titles/th11.md) | 画面静止のみ | 640x480 |
| th20 東方錦上京 | `record_th20.py` | [docs/titles/th20.md](docs/titles/th20.md) | 画面静止のみ | 1280x960 |

**そのタイトルのゲームデータ・MOD・`GameConfig` を触る前に、必ず該当する背景ファイルを開くこと**
(他タイトルの慣習をそのまま流用すると外す箇所がタイトルごとにある)。新しいタイトルを足す手順は
[`docs/titles/README.md`](docs/titles/README.md)。

## 2. 構成

| ファイル | 役割 |
| --- | --- |
| `entrypoint.py` | ジョブ全体の制御。チェックポイント確認 → (再開でなければ)S3 DL → 録画 →
  生動画をS3へチェックポイントUP → 配信用変換 → S3 UP → DynamoDB/taskToken 通知。`GAME`
  環境変数で `record_thNN.py` を呼び分ける |
| `recording_common.py` | 全タイトル共通の録画パイプライン本体(Issue #13でth08対応時に共通化)。
  Xvfb起動・クロップ座標の確定([`0012`](../docs/decisions/0012-crop-geometry-after-window-stabilizes.md))・録画・
  終了検知([`0011`](../docs/decisions/0011-replay-end-template-matching.md))・fps暴走検知・
  自動リトライ(既定3回)・映像/音声を別プロセスで録画し後でmuxする処理(reports/26)・
  フックDLLより前の追加DLL注入(`GameConfig.extra_dlls`)・音声のジョブ専用sinkへの分離
  ([`0013`](../docs/decisions/0013-per-job-pulseaudio-sink.md))を担う。処理落ちの早期検知
  (stutter probe)は真陽性の実績が無く正常なリプレイも誤検知しうることが判明したため
  削除済み([`0038`](../docs/decisions/0038-remove-stutter-early-detection.md)) |
| `pulse.py` | ジョブ専用のPulseAudio null-sinkの作成・破棄(Issue #48) |
| `record_thNN.py` | タイトル固有のパス設定(`GameConfig`)を組み立てて `record_with_retry()` を呼ぶだけの薄いラッパー |
| `convert.py` | 録画結果を「ユーザーへ配信する1本」へ変換する後処理。**録画後の再エンコード
  はどのタイトル・どの録画速度でもこの1パスだけ**で、等倍への戻し(§5)・解像度合わせ(720pに
  満たない録画だけ引き上げる、reports/21)・ウォーターマーク合成を1つのfilter_complexに
  まとめてある |
| `status.py` | DynamoDB へのジョブ状態・進捗反映、チェックポイント確認用のジョブ取得(§7) |
| `interruption_watcher.py` / `progress_reporter.py` | バックグラウンドスレッド。Spot中断通知
  /リバランス推奨のIMDS経由の監視(§6)／進捗スクリーンショットのS3アップロード |
| `task_heartbeat.py` | Step Functionsへ60秒ごとに`SendTaskHeartbeat`を送るバックグラウンド
  スレッド(Issue #49)。15分途絶えるとタスクが失敗し`HandleFailure`が後始末に入る。主目的は
  自宅ワーカーの停電・回線断の検知だが、EC2でもハング時の失敗検知が90分→15分に縮まる |
| `title_assets.py` | `GAME`環境変数に応じたタイトル固有アセットをS3からダウンロード・展開する(§8) |
| `Dockerfile` | 実行イメージ定義 |
| `mods/common/` | DLL インジェクタ(`injector.exe`。複数DLLの順次注入に対応)・共通フック処理・
  fps計測スレッド(`fps_monitor.*`、fps暴走検知用、reports/22)のソース(C++) |
| `mods/thNN_replay_autoplay/` | タイトルごとの自動再生フック DLL(`thNN_hook.dll`)のソース(C++)。
  組み込むフックの違いは各タイトルの背景ファイル(§1)を参照 |
| `mods/common/fps_limiter_hook.*` | `IDirect3DDevice9::Present`のvtableフックによるフレーム
  レート制限(reports/46)。目標fpsは`FPS_LIMIT_TARGET_HZ`(既定60)。低速録画(§5)の実装基盤 |
| `mods/common/dsound_hook.*` / `fps_display_hook.*` | 低速録画時に音声を同じ比率へスローダウン
  させる(`SetFrequency`フック、reports/47)／画面に焼き付くfpsカウンター表示だけを等倍相当へ
  補正する(reports/48) |
| `mods/common/score_monitor.*` | ゲーム内スコア・ステージ番号・残機・グレイズの定期サンプリング
  (reports/50、Issue #103)。`recording_common.check_replay_desync()`が録画成功直後にMODログの
  スコア推移と`replayInfo.score`を突き合わせてリプレイずれ(デシンク)の疑いを判定する
  (`JobRecord.desyncDetected`、自動リトライはしない)。RVAはタイトル毎に`dllmain.cpp`で指定
  (baseRva+baseIsPointer+フィールドオフセット/幅の汎用設計)。対応6タイトル全てで実機動作確認済み
  ([`docs/reports/2026-08-25-th07-score-monitor-fix.md`](../docs/reports/2026-08-25-th07-score-monitor-fix.md)、
  `docs/known-limitations.md`参照。th07だけはSattoriが配布するth07.exeが当初の検証環境と
  バイナリが異なりゲームデータのバージョン差でRVAの再特定を要した。th10はtouhou-recorder
  reports/57で別途確認) |
| `mods/common/score_probe_hook.*` / `stage_probe_hook.*` | RVA特定用の診断専用コード(本番ビルドには
  含めない)。score_monitorのRVAが通用しないタイトル・ゲームバージョンが出た場合の再調査に使う |

`mods/` 配下はソースとビルドスクリプトのみ管理する(元は `touhou-recorder` の PoC 由来。ビルドは §9)。

## 3. 実行時の環境変数

`apps/api` の `ec2.buildUserData` が UserData 経由でコンテナに渡す:

| 変数 | 説明 |
| --- | --- |
| `JOB_ID` | ジョブ ID(DynamoDB キー・出力キーに使用) |
| `GAME` | タイトル(`th06` / `th07` / `th08` / `th11` / `th20`) |
| `REPLAY_BUCKET` / `REPLAY_KEY` | アップロード済みリプレイの S3 位置 |
| `OUTPUT_BUCKET` | 録画動画の出力先バケット(CloudFront オリジン) |
| `TITLE_ASSETS_BUCKET` | タイトル固有アセットのバケット(§8) |
| `JOBS_TABLE` | ジョブ状態の DynamoDB テーブル名 |
| `WATERMARK` | `1` でウォーターマーク合成、`0` で無効 |
| `TASK_TOKEN` | Step Functions の `waitForTaskToken` トークン(省略時は通知をスキップ、ローカル検証用) |
| `EXPECTED_DURATION_SECONDS` | リプレイの推定再生時間(進捗率算出の参考値、省略可) |
| `EXPECTED_SCORE` | リプレイファイルの記録スコア(画面表示値)。リプレイずれの事後検証(Issue #103、
  §2の`score_monitor`)に使う。`replayInfo.score`が取得できていなければ省略される |
| `FPS_LIMIT_TARGET_HZ` | 低速録画(§5)の目標fps。**省略時は等倍**(既定60)。自宅ワーカーへのオファー時のみ `30` が渡る |
| `THPRAC_ATTACH_TIMEOUT_SEC` / `_CONFIRM_SEC` / `_ATTEMPTS` | th20 の thprac アタッチの予算([`titles/th20.md`](docs/titles/th20.md)) |
| `TH10_BUGFIX_MARISA_B` | `1` で th10 の VsyncPatch(`vpatch.ini`の`BugFixTh10Power3`)を有効にして録画する
  (魔理沙Bの「バグマリ」修正、Issue #75)。**リプレイ記録時と同じ設定で録画しないとリプレイずれが
  起きる**([`titles/th10.md`](docs/titles/th10.md))ため、`RecordingOptions.th10BugfixMarisaB`
  (既定false)をそのまま転記する。省略時・`0`ならパッチ無効(バグマリの挙動をそのまま再現)で
  録画する |

## 4. 出力ファイル

録画完了後に `convert.py` で配信用の1本へ変換する(同時録画中の変換は4vCPU構成で重複フレーム率
を悪化させるため採用しない、reports/21)。**アップロードするファイルが1本か2本かは録画の内容で
決まる**(`convert.needs_separate_raw_output()`):

| 録画 | 配信版 | 生データ(元解像度版) | 理由 |
| --- | --- | --- | --- |
| th06/07/08/10/11(640x480・等倍) | 960x720へ拡大 | **そのまま2本目として配信** | 生データが無加工で通用するので、再エンコードは配信版の1回だけで済む |
| th20(1280x960・等倍) | 1280x960のまま | 出さない | 2本目はウォーターマークの有無しか違わず、S3保管料とCloudFront転送量が倍になるだけ |
| th20(低速録画) | 1280x960のまま | 出さない | 生データが半分の速度でそのまま配信できない。別途出すには等倍化の再エンコードがもう1回要る |

640x480 の録画はそのままだと YouTube 側で60fpsと認識されないため拡大する(reports/21)。
**逆に、元から720p以上ある録画を高さ720pxへ「合わせる」ことはしない**(th20を960x720へ縮小
すると、主要ダウンロード導線がユーザーを低い解像度へ誘導することになるため)。

| S3キー | 内容 |
| --- | --- |
| `videos/{jobId}.mp4` | 録画そのままの解像度(DynamoDB `outputPath`)。録画完了直後、変換前に
  チェックポイントとしてアップロードされる(§6) |
| `videos/{jobId}_720p.mp4` | 配信版(DynamoDB `outputPath720p`)。**出力が1本のジョブでは
  このキーが `outputPath` に入り、`outputPath720p` は null になる**(生データのチェックポイント
  は `done` 確定後に削除)。`_720p` は歴史的な接尾辞で、実際の解像度は録画によって変わる |
| `progress/{jobId}/{unixMillis}.jpg` | 録画中の進捗スクリーンショット(DynamoDB
  `previewImagePath`)。スナップショット毎にユニークなキーを使う(CloudFrontの長期キャッシュ
  で古い画像が返り続けるのを避けるため) |
| `worker-logs/{jobId}/ffmpeg-upscale.log` | 配信用変換のffmpeg生ログ(キー名は互換のため
  `upscale`のまま)。`convert.py` が `-progress` の生出力をローカルファイルへ書き、
  `entrypoint.py` が `finally` でS3へ上げる。CloudWatchには変換失敗時のみ末尾2000バイトを
  残す(数千行を流すと管理画面のログビューアで他のログが埋もれるため。Issue #58)。
  `OutputBucket`内で3日のライフサイクルルールがあり、DynamoDBには保存しない
  (jobIdから決定的に導出可能、`apps/api/src/downloads.ts`の`buildFfmpegUpscaleLogKey`) |

動画のアップロード時には**そのバイト数も DynamoDB へ記録する**
(`outputBytes`/`outputBytes720p`、Issue #60)。管理画面のコスト推定の入力で、動画サイズは
本サービスのコスト構造で最大のレバレッジ(`docs/research/aws-region-cost-analysis.md` §6)
なので平均値で丸めずジョブ単位の実測を残す(生動画のサイズはチェックポイントから再開した
ジョブが`record()`を通らないため`done`遷移時にも併せて書く)。

## 5. 低速録画(Issue #68)

ゲームを 1/2 倍速で走らせて録画し、後処理で等倍へ戻す。**対応タイトルは th20 のみ・
自宅ワーカー限定**で、有効・無効は起動側が渡す `FPS_LIMIT_TARGET_HZ` の有無だけで決まる
(未設定なら全タイトル従来どおり等倍)。ワーカー自身は自分が EC2 にいるのか自宅にいるのかを
知らない。

> **ここにワーカー側の分岐を足さないこと**
> ([`decisions/0010`](../docs/decisions/0010-slow-motion-no-worker-side-branching.md))。
> また**倍率はフック・監視のタイムアウト・変換・品質チェックの閾値・進捗のすべてへ一貫して
> 掛かっており**、1つでも据え置くと誤リトライ・誤終了検知・音ズレが起きる
> ([`decisions/0014`](../docs/decisions/0014-slow-motion-scaling-across-pipeline.md))。
> 実機検証は [`reports/2026-08-11-th20-slow-motion-local.md`](../docs/reports/2026-08-11-th20-slow-motion-local.md)。

```bash
FPS_LIMIT_TARGET_HZ=30 python3 record_th20.py \
  --replay-path games/th20/replay/th20_01.rpy --output /tmp/th20/out.mp4
```

## 6. Spot中断時のリトライと再開(Issue #11)

`entrypoint.py` は起動直後に**S3の生動画チェックポイント(`videos/{jobId}.mp4`)の実体を
確認**し、在れば「変換から再開」する。Step Functions がSpot中断/タイムアウトを検知して
新しいワーカーインスタンスでリトライした場合、これにより録画をやり直さずに済む(録画
フェーズ自体の途中再開は非対応で、中断時はそのフェーズを最初からやり直す)。起動時点で
ジョブが既に`done`なら何もせず成功として通知する。録画時の実時間スケールは生データの
S3オブジェクトメタデータ(`sattori-time-scale`)として運ぶ。また `interruption_watcher.py`
がIMDS経由でSpot中断通知/リバランス推奨(いずれも2分前通知)を監視し、検知次第 taskToken
経由で早期失敗通知する(60分のタスクタイムアウトを待たずにリトライを開始させるため)。

> **再開の判定材料を変える前に
> [`decisions/0015`](../docs/decisions/0015-resume-from-raw-video-checkpoint.md) を読むこと。**
> ジョブレコードの `outputPath` で判定する・再開側で `FPS_LIMIT_TARGET_HZ` を読み直す、は
> いずれも実害のある間違いで、前者は `done` だったジョブを `failed` へ書き換え、後者は
> 半分の速度の動画をそのまま等倍として配信する。

## 7. ジョブレコードへの書き込み規約

`status.py` の `update_status()` には、どのフェーズから呼ばれても効く規約が2つある。

- **緊急停止されたジョブへは書き込まない**。更新は
  `attribute_not_exists(stopRequestedAt)` を条件にしか行わない(条件が崩れたらログだけ
  残して何もしない。停止済みジョブへの書き込み拒否は想定内の正常系なので例外にしない)。
  自宅ワーカーのコンテナは常駐デーモンが claim の取り消しに気づくまで走り続けるため、
  この拒否票が無いと**停止したはずのジョブの完了メールがユーザーへ飛ぶ**
  (Issue #59。`docs/known-limitations.md` §4・`home-worker/README.md` §3)。ワーカー側は「自分が
  自宅かEC2か」を知る必要がなく、どちらも同じ票を尊重するだけでよい。
- **フェーズを開始する書き込みでは同じ更新で進捗を0へ戻す**(`reset_progress=True`、
  Issue #108)。`progress` は「**現在のフェーズ内**で処理が完了した時間(秒)」であって
  フェーズを跨いで意味を持たない。分けて書くと、その隙間だけ「変換中なのに録画フェーズ
  末尾の進捗」というレコードがユーザーに見える。ジョブページの経過時間表示は**巻き戻らない
  こと**を保証する作りになっている(`apps/web/src/hooks/useEstimatedProgress.ts`)ため、
  この一瞬の値を掴むと以降の進捗が表示に反映されない。

## 8. リポジトリに含まれない資産とタイトル資産アーカイブ(Issue #22)

ゲーム本体(著作権物)・ビルド成果物・素材はいずれも `.gitignore` 済みで、置き場所が2つある。

- **イメージに焼き込むもの**(`docker build` の前に `worker/` 配下へ配置する): ウォーター
  マーク素材 `assets/watermark/watermark-60fps.webm`(VP9アルファ)と、リプレイ終了検知用の
  テンプレート `assets/replay_end_templates/{th06,th07,th08,th10}.png`
  ([`decisions/0011`](../docs/decisions/0011-replay-end-template-matching.md))。いずれも
  タイトル固有アセットではなく録画パイプライン自体が使う共通素材のため。
- **イメージには含めず、タイトル資産アーカイブとしてS3へ置くもの**: ゲーム本体
  (`games/{title}/`)・WINEPREFIX(`prefixes/{title}-*/`)・MODビルド成果物
  (`mods/**/build/*`)。ECRストレージコストがタイトル数に比例して増大するのを避けるため。

> **アーカイブを作って流すコマンド(タイトルごとの同梱物・`tar`の注意点込み)は
> `upload-title-assets` skill にある。** 以下は構成とワーカー側の展開の仕組みだけ。

新タイトル追加時やゲーム本体・MOD更新時は、以下を1本の tar.gz にまとめて
`s3://${TITLE_ASSETS_BUCKET}/titles/{title}/assets.tar.gz` へアップロードする
(`TITLE_ASSETS_BUCKET` は `cdk deploy` 後の `TitleAssetsBucketName` 出力)。アーカイブ内のパスは
`worker/` 配下への展開先と一致させること(`title_assets.py` が `/app` 直下へ相対パスのまま展開):

```
games/{title}/                                  # ゲーム本体一式(.cfg はウィンドウモード必須)
prefixes/{title}-wined3d-gl/                    # 日本語ロケール初期化済み WINEPREFIX
mods/common/build/injector.exe                  # DLL インジェクタ(共通)
mods/{title}_replay_autoplay/build/{title}_hook.dll  # 自動再生 MOD(タイトル毎)
```

タイトルごとの同梱物の違い(th06 の実行ファイル名・th08 のゲームデータのバージョン・
th20 の cfg と thprac など)は §1 の各背景ファイルに理由込みで書いてある。

`title_assets.py` はインスタンス起動時に `worker/games/{title}/` が既に存在するかを確認し、
無ければこのアーカイブをダウンロード・展開する(存在すればスキップ。Spot中断リトライ時の
同一インスタンス再利用等を想定)。展開先は `/app` 直下で、`record_{game}.py` が既定で参照
するパス(`/app/games/{game}`、`/app/prefixes/{game}-wined3d-gl` 等)と一致する。

## 9. MOD・WINEPREFIX

いずれもビルド成果物で、リポジトリにはソース・生成スクリプトだけがある。**手順は Skill に
一本化してある**(重複した手順書を作らないこと): `injector.exe` / `thNN_hook.dll` のビルドは
`build-mods` skill、WINEPREFIX の作成・フォント修正(`setup_wineprefix.sh`)と資産アーカイブの
作成は `upload-title-assets` skill。

MOD が何をしているか(各フックの役割)は §2 の `mods/` の行と §1 の各背景ファイルを参照。
**フォントの実体(`msgothic.ttc`・`msmincho.ttc`)は Windows のライセンスフォントであり、
リポジトリにも S3 にも置いていない**ので別途用意すること。配置・レジストリ登録が要る理由は
[`titles/th07.md`](docs/titles/th07.md)(MS ゴシック)・[`titles/th11.md`](docs/titles/th11.md)(MS 明朝)。

## 10. テスト(`tests/`)

Wine/Xvfb/実ゲームに依存する録画本体(`recording_common.attempt_recording()`)以外の、
純粋なロジック部分(MAD計算・ffmpegコマンド組み立て・fps暴走/重複フレーム率の判定・
配信用変換の解像度/フィルタ組み立て/進捗計算・DynamoDB更新式の組み立て・Spot中断/リバランス
判定・進捗レポートの重複排除等)を pytest でユニットテストする。boto3 呼び出しは
`unittest.mock` でモックし、実際の AWS リソースには接続しない(moto 等の追加依存は導入して
いない)。GitHub Actions の `Test`(`.github/workflows/test.yml`)の `worker-test` ジョブで
push・PR 毎に自動実行される。

```bash
pip install -r requirements-dev.txt && pytest
```

## 11. ローカルでの実行(ネットワーク不要)

ゲーム資産を配置済みなら S3/DynamoDB 無しで録画本体だけを試せる(低速録画の例は §5)。配信用
変換だけなら ffmpeg/ffprobe があれば動く。

```bash
python3 record_th07.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
# 配信用変換のみ(等倍。低速録画の素材は time_scale=2.0 を渡すと等倍へ戻る)
python3 -c "from convert import convert_for_delivery; convert_for_delivery('/tmp/out.mp4', '/tmp/out_delivery.mp4')"
```

音声の録音先となるPulseAudio sinkは`--pulse-sink`未指定ならプロセスIDから採番されるため、複数
タイトルを同時に走らせても音声は混ざらない(ディスプレイ番号もタイトルごとに異なるため映像も
干渉しない)。分離できているかは `pactl list sink-inputs` で各ゲームの接続先を見る
([`reports/2026-08-08-parallel-audio-isolation.md`](../docs/reports/2026-08-08-parallel-audio-isolation.md))。

**手動検証時はOSレベルの強制終了ラッパーを併用すること。** 既知の未修正バグ(th20の低速録画
2並列がハングするIssue #179、その他未知のタイトル固有バグ)により、ゲームプロセスがGPU待ち等の
D state(カーネルレベルで割り込み不可能)に陥り録画処理自体が完全にハングする可能性がある。
`kill_wine_and_wait()`はこのケースをタイムアウト検知しWINEPREFIX配下の残存プロセスをSIGKILLする
フォールバックを持つが(Issue #186)、内部のリトライ/クリーンアップが機能しない未知の経路まで
保証するものではない。本番のDocker経路はジョブ完了後にコンテナごと破棄されるため実害が無いが、
本節のようにホスト上で直接実行する場合はプロセスが確実に終了するよう外側から保険を掛ける:

```bash
timeout --kill-after=30s 600s python3 record_th20.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
```

放置されたWineプロセス(`winedevice.exe`等)がsystem D-Busのシグナル購読を持ったまま残り続けると
D-Busのメッセージキューが枯渇し、ホストのsystemdごとハングする事故が実際に起きている
([`docs/reports/2026-08-27-wine-cleanup-hang-incident.md`](../docs/reports/2026-08-27-wine-cleanup-hang-incident.md))。

## 12. ビルドとECRへのpush

本番のECRリポジトリ名は`sattori-worker`(`infra/lib/sattori-stack.ts`が作成、本体スタックと
同じくeu-south-2)。デプロイ手順全体は `deploy-sattori` skill(**push と deploy の順序を
守ること**)。

```bash
docker build -t <account>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest worker/
aws ecr get-login-password --region eu-south-2 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.eu-south-2.amazonaws.com
docker push <account>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest
```

`worker/assets/`は`.gitignore`対象なので、`docker build`前にビルドコンテキストへ配置すること(§8)。

## 13. 既知の制約

一覧と詳細は [`docs/known-limitations.md`](../docs/known-limitations.md)。録画パイプラインに
関わるものは次の4点。

- **デシンク(リプレイずれ)を録画時に予防する手段は無い**。th20 は thprac の導入で大半が
  解消したが([`titles/th20.md`](docs/titles/th20.md))、他タイトルには対処法がない。録画後の
  スコア突き合わせによる事後検知(`JobRecord.desyncDetected`、Issue #103、§2の
  `score_monitor`)は対応6タイトル全てで実装済みだが、自動リトライはしない(警告表示のみ)。
  想定尺より大幅に早く終了した/タイムアウトへ近づいたジョブでは、検知ロジック側を疑う前に
  **まず録画された映像を目視して**不自然な被弾・ゲームオーバーが無いか確認すること(閾値調整や
  リトライでは解決しない —— 同一リプレイなら毎回同じ箇所で再現する)。
- **タイムアウト打ち切り(検知方式がリプレイ終了検知ではなく録画時間の上限)は検知・
  警告のみで、自動リトライはしない**(Issue #161)。`JobRecord.timedOut`に記録して
  デシンクと同じ警告表示に乗せ、ワーカーのログにも`WARNING:`を残す。2026-08-24に
  自宅ワーカーで観測したfps低下(録画全体が遅く進み上限まで回してもリプレイ終端に
  届かない)はサーマルスロットリング(Issue #162)が原因と判明しクーラー換装で解消済み
  (PR #180)だが、冷却以外の要因で同様の遅延が再発する可能性は排除できないため、
  検知・警告の仕組み自体は残してある。
- **重複フレーム率の自動チェックは録画開始15〜45秒の30秒スポットしか見ていない**
  (Issue #93)。全編の代表値ではない。
- **対応タイトルは §1 の6本のみ**(リプレイパーサー側は多タイトル対応済みで、残作業は録画
  対応 —— MOD 移植・実機検証。Issue #13 配下)。
- **th10のVsyncPatch「バグマリ」修正(`BugFixTh10Power3`)は記録時の設定を録画前に自動判別
  できない**。ページAの`th10BugfixMarisaB`オプション(既定false)で利用者の自己申告に頼っており、
  誤った申告のリプレイはリプレイずれ(デシンク)を起こす([`titles/th10.md`](docs/titles/th10.md)、
  reports/58)。
