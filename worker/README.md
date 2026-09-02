# worker — Sattori 録画ワーカー

東方リプレイを Wine + Xvfb + ffmpeg でヘッドレス録画し、S3 へアップロードする Python
ワーカー。AWS EC2 Spot インスタンス、または自宅サーバー(`home-worker/`)上で Docker
コンテナとして実行される。**ここには「今どうなっているか」だけを書く** ——
タイトル別の背景は [`docs/titles/`](docs/titles/README.md)、録画パイプライン・MOD・タイトル資産の
詳細は [`docs/recording-package.md`](docs/recording-package.md)・[`docs/mods.md`](docs/mods.md)・
[`docs/title-assets.md`](docs/title-assets.md)、横断的な設計判断の根拠は
[`docs/decisions/`](../docs/decisions/README.md) にある。

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
| th09 東方花映塚 | `record_th09.py` | [docs/titles/th09.md](docs/titles/th09.md) | テンプレート照合(絞り込み領域) | 640x480 |
| th10 東方風神録 | `record_th10.py` | [docs/titles/th10.md](docs/titles/th10.md) | テンプレート照合(絞り込み領域) | 640x480 |
| th11 東方地霊殿 | `record_th11.py` | [docs/titles/th11.md](docs/titles/th11.md) | 画面静止のみ | 640x480 |
| th12 東方星蓮船 | `record_th12.py` | [docs/titles/th12.md](docs/titles/th12.md) | 画面静止のみ | 640x480 |
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
| `recording/` | 全タイトル共通の録画パイプライン本体。責務ごとに11モジュールへ分割してあり、
  Xvfb起動・クロップ座標の確定・録画・終了検知・fps暴走検知・自動リトライ・映像と音声の
  別プロセス録画・音声のジョブ専用sinkへの分離を担う。**モジュール一覧と、どの挙動がどの決定
  記録に基づくかは [`docs/recording-package.md`](docs/recording-package.md)**(分割の経緯は
  [`0041`](../docs/decisions/0041-worker-recording-package-split.md)) |
| `pulse.py` | ジョブ専用のPulseAudio null-sinkの作成・破棄(Issue #48) |
| `record_thNN.py` | **そのタイトルでしか成り立たない `GameConfig` の値だけ**を持つシム(25〜36行)。CLI と録画の呼び出しは `recording/cli.py` に集約してある。タイトル固有の背景は [`docs/titles/thNN.md`](docs/titles/README.md) |
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
| `mods/` | ゲームプロセスへ注入するフック DLL(`thNN_hook.dll`)とインジェクタ(`injector.exe`)の
  ソース(C++)。共通フック・タイトル別フック・低速録画(§5)のPresentフック・スコア監視(デシンクの
  事後検知)の内訳は **[`docs/mods.md`](docs/mods.md)**。ビルドは §9 |

## 3. 実行時の環境変数

`apps/api` の `ec2.buildUserData` が UserData 経由でコンテナに渡す:

| 変数 | 説明 |
| --- | --- |
| `JOB_ID` | ジョブ ID(DynamoDB キー・出力キーに使用) |
| `GAME` | タイトル(`th06` / `th07` / `th08` / `th09` / `th10` / `th11` / `th12` / `th20`) |
| `REPLAY_BUCKET` / `REPLAY_KEY` | アップロード済みリプレイの S3 位置 |
| `OUTPUT_BUCKET` | 録画動画の出力先バケット(CloudFront オリジン) |
| `TITLE_ASSETS_BUCKET` | タイトル固有アセットのバケット(§8) |
| `JOBS_TABLE` | ジョブ状態の DynamoDB テーブル名 |
| `WATERMARK` | `1` でウォーターマーク合成、`0` で無効 |
| `TASK_TOKEN` | Step Functions の `waitForTaskToken` トークン(省略時は通知をスキップ、ローカル検証用) |
| `EXPECTED_DURATION_SECONDS` | リプレイの推定再生時間(進捗率算出の参考値、省略可) |
| `EXPECTED_SCORE` | リプレイファイルの記録スコア(画面表示値)。リプレイずれの事後検証(Issue #103、
  [`docs/mods.md`](docs/mods.md)の`score_monitor`)に使う。`replayInfo.score`が取得できていなければ省略される |
| `FPS_LIMIT_TARGET_HZ` | 低速録画(§5)の目標fps。**省略時は等倍**(既定60)。自宅ワーカーへのオファー時のみ `30` が渡る |
| `THPRAC_ATTACH_TIMEOUT_SEC` / `_CONFIRM_SEC` / `_ATTEMPTS` | th20 の thprac アタッチの予算([`titles/th20.md`](docs/titles/th20.md)) |
| `TH10_BUGFIX_MARISA_B` | `1` で th10 の VsyncPatch(`vpatch.ini`の`BugFixTh10Power3`)を有効にして録画する
  (魔理沙Bの「バグマリ」修正、Issue #75)。**リプレイ記録時と同じ設定で録画しないとリプレイずれが
  起きる**([`titles/th10.md`](docs/titles/th10.md))ため、`RecordingOptions.th10BugfixMarisaB`
  (既定false)をそのまま転記する。省略時・`0`ならパッチ無効(バグマリの挙動をそのまま再現)で
  録画する |
| `TITLE_ASSETS_CACHE_DIR` | 自宅ワーカーのみが渡す(§8、Issue #104)。設定時はタイトル資産を
  直接ダウンロードせず、このディレクトリ配下のキャッシュを使う。EC2は渡さないため常に
  直接ダウンロードする |

## 4. 出力ファイル

録画完了後に `convert.py` で配信用の1本へ変換する(同時録画中の変換は4vCPU構成で重複フレーム率
を悪化させるため採用しない、reports/21)。**アップロードするファイルが1本か2本かは録画の内容で
決まる**(`convert.needs_separate_raw_output()`):

| 録画 | 配信版 | 生データ(元解像度版) | 理由 |
| --- | --- | --- | --- |
| th06/07/08/09/10/11/12(640x480・等倍) | 960x720へ拡大 | **そのまま2本目として配信** | 生データが無加工で通用するので、再エンコードは配信版の1回だけで済む |
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
  テンプレート `assets/replay_end_templates/{th06,th07,th08,th09,th10}.png`
  ([`decisions/0011`](../docs/decisions/0011-replay-end-template-matching.md))。いずれも
  タイトル固有アセットではなく録画パイプライン自体が使う共通素材のため。
- **イメージには含めず、タイトル資産アーカイブとしてS3へ置くもの**: ゲーム本体
  (`games/{title}/`)・WINEPREFIX(`prefixes/{title}-*/`)・MODビルド成果物
  (`mods/**/build/*`)。ECRストレージコストがタイトル数に比例して増大するのを避けるため。

**後者のアーカイブの構成(何をどのパスで固めるか)・ワーカー側の展開・自宅ワーカーの
`TITLE_ASSETS_CACHE_DIR` キャッシュは [`docs/title-assets.md`](docs/title-assets.md)**、
アーカイブを作って流すコマンドは `upload-title-assets` skill。

## 9. MOD・WINEPREFIX

いずれもビルド成果物で、リポジトリにはソース・生成スクリプトだけがある。**手順は Skill に
一本化してある**(重複した手順書を作らないこと): `injector.exe` / `thNN_hook.dll` のビルドは
`build-mods` skill、WINEPREFIX の作成・フォント修正(`setup_wineprefix.sh`)と資産アーカイブの
作成は `upload-title-assets` skill。

MOD が何をしているか(各フックの役割)は [`docs/mods.md`](docs/mods.md) と §1 の各背景ファイルを
参照。**フォントの実体(`msgothic.ttc`・`msmincho.ttc`)は Windows のライセンスフォントであり、
リポジトリにも S3 にも置いていない**ので別途用意すること。配置・レジストリ登録が要る理由は
[`titles/th07.md`](docs/titles/th07.md)(MS ゴシック)・[`titles/th11.md`](docs/titles/th11.md)(MS 明朝)。

## 10. テスト(`tests/`)

Wine/Xvfb/実ゲームに依存する録画本体(`recording.pipeline.attempt_recording()`)以外の、純粋な
ロジック部分を pytest でユニットテストする(boto3 呼び出しは `unittest.mock` でモックし、実際の
AWS リソースには接続しない)。GitHub Actions の `Test`(`.github/workflows/test.yml`)の
`worker-test` ジョブで push・PR 毎に自動実行される。**走らせ方と、`recording/` のテストに効く
規約(monkeypatch は定義側ではなく「使う側」のモジュールに当てる)は
[`docs/runbooks/worker-local-recording.md`](../docs/runbooks/worker-local-recording.md) §1。**

## 11. ローカルでの実行(ネットワーク不要)

ゲーム資産を配置済みなら S3/DynamoDB 無しで録画本体だけを試せる(低速録画の例は §5)。配信用
変換だけなら ffmpeg/ffprobe があれば動く。**コマンドと並列実行時の音声分離の確認方法は
[`docs/runbooks/worker-local-recording.md`](../docs/runbooks/worker-local-recording.md) §2。**

> **そこに書いたOSレベルの強制終了ラッパー(`timeout`)を必ず併用すること。** 未修正のハング
> バグ(Issue #179 ほか)でゲームプロセスが D state に陥ると録画処理ごとハングし、放置された
> Wine プロセスがホストの systemd まで巻き込む事故が実際に起きている
> ([`decisions/0035`](../docs/decisions/0035-outer-timeout-wrapper-for-bare-metal-runs.md)、
> [`reports/2026-08-27-wine-cleanup-hang-incident.md`](../docs/reports/2026-08-27-wine-cleanup-hang-incident.md))。

## 12. ビルドとECRへのpush

本番のECRリポジトリ名は`sattori-worker`(`infra/lib/sattori-stack.ts`が作成、本体スタックと
同じくeu-south-2)。`worker/assets/`は`.gitignore`対象なので、`docker build`前にビルド
コンテキストへ配置すること(§8)。コマンドは
[`docs/runbooks/worker-local-recording.md`](../docs/runbooks/worker-local-recording.md) §3、
デプロイ手順全体は `deploy-sattori` skill(**push と deploy の順序を守ること**)。

## 13. 既知の制約

一覧と詳細は [`docs/known-limitations.md`](../docs/known-limitations.md)。録画パイプラインに
関わるのは次の5点で、**なぜその割り切りなのか・何が未解決かはリンク先にある**。

- **デシンク(リプレイずれ)を録画時に予防する手段は無い**。th20 は thprac の導入で大半が
  解消したが([`titles/th20.md`](docs/titles/th20.md))、他タイトルには対処法がない。録画後の
  スコア突き合わせによる事後検知(`JobRecord.desyncDetected`、Issue #103、[`docs/mods.md`](docs/mods.md)
  の`score_monitor`)はth09を除く7タイトルで実装済みだが、自動リトライはしない(警告表示のみ)。
  th09はスコアのRVAが未特定でこの検知自体が機能しない
  ([known-limitations §3](../docs/known-limitations.md#3-録画品質の検証にまつわる制約)、
  [`titles/th09.md`](docs/titles/th09.md))。
- **タイムアウト打ち切り(検知方式がリプレイ終了検知ではなく録画時間の上限)も検知・警告のみで、
  自動リトライはしない**(Issue #161。`JobRecord.timedOut`に記録して同じ警告表示に乗せる。同 §3)。
- **重複フレーム率の自動チェックは録画開始15〜45秒の30秒スポットしか見ていない**(Issue #93)。
  全編の代表値ではなく、背景が常時アニメーションするタイトルでは処理落ちを過小評価しうるため、
  リプレイのframeCount(60fps基準の理論尺)との比較も必ず併用すること(同 §3)。
- **th10のVsyncPatch「バグマリ」修正(`BugFixTh10Power3`)は記録時の設定を録画前に自動判別
  できない**。利用者の自己申告(`th10BugfixMarisaB`、既定false)に頼っており、誤った申告の
  リプレイはデシンクする([known-limitations §1](../docs/known-limitations.md#1-対応タイトルの拡大)、
  [`titles/th10.md`](docs/titles/th10.md))。
- **対応タイトルは §1 の8本のみ**(リプレイパーサー側は多タイトル対応済みで、残作業は録画
  対応 —— MOD 移植・実機検証。Issue #13 配下。同 §1)。

**想定尺より大幅に早く終了した/タイムアウトへ近づいたジョブでは、検知ロジック側を疑う前に
まず録画された映像を目視して**不自然な被弾・ゲームオーバーが無いか確認すること(閾値調整や
リトライでは解決しない —— 同一リプレイなら毎回同じ箇所で再現する。`apps/api` の
`retryPolicy.ts`・`handleFailure.ts` はこの性質を前提にリトライ回数を決めている)。
