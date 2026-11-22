# 決定記録（軽量 ADR）

「なぜこうなっているか」「これをやると壊れる」を1決定1ファイルで残す場所
（`docs/documentation-guidelines.md` の分類 ②）。**まずこのページの一覧だけを読み、
関係する1件だけを開くこと。**

各パッケージの `README.md` は「今どうなっているか」（① 参照仕様）しか書かない。
仕様だけを読んで推測で変更すると、過去に踏んだ地雷を踏み直すので、README 側からここへの
リンクがあれば必ず辿ること。

## 一覧

| # | 決定日 | 対象 | 内容 | 状態 |
| --- | --- | --- | --- | --- |
| [0001](0001-region-eu-south-2-ses-us-east-1.md) | 2026-08-03 | infra / apps/api | リージョンを `eu-south-2` にし、SES と CloudFront 用 ACM だけ `us-east-1` に残す | 有効 |
| [0002](0002-ec2-launch-at-runtime-not-iac.md) | 2026-06 | infra / apps/api | EC2 の起動だけは IaC ではなく実行時に AWS SDK で行う | 有効 |
| [0003](0003-worker-python-home-worker-typescript.md) | 2026-07 | worker / home-worker | 録画ワーカーだけ Python にし、自宅ワーカーの常駐デーモンは TypeScript にする | 有効 |
| [0004](0004-job-id-as-authorization-secret.md) | 2026-06 | apps/api / apps/web | jobId 自体を認可の秘密値として使う | 有効 |
| [0005](0005-admin-auth-ssm-shared-token.md) | 2026-07 | apps/api / infra | 管理画面の認証は Cognito ではなく SSM の共有トークンにする | 有効 |
| [0006](0006-progress-polling-not-websocket.md) | 2026-06 | apps/web / apps/api | 進捗表示は単純なポーリングにし、WebSocket / SSE を使わない | 有効 |
| [0007](0007-no-ip-rate-limit-no-recaptcha.md) | 2026-07 | apps/api | IP 単位のレート制限・reCAPTCHA を見送る | 有効 |
| [0008](0008-th20-appdata-resolved-from-unix-user.md) | 2026-08 | worker | th20 の `%APPDATA%` 配置先を実行中の UNIX ユーザーから解決する | 有効 |
| [0009](0009-thprac-post-attach.md) | 2026-08 | worker / apps/web | th20 のデシンク対策に thprac を「後付けアタッチ」で適用する | 有効 |
| [0010](0010-slow-motion-no-worker-side-branching.md) | 2026-08 | worker / apps/api | 低速録画をワーカー側の分岐にせず、起動側が渡す環境変数だけで表す | 有効（低速録画は[0058](0058-speedup-recording-on-gpu-instances.md)で廃止し、[0064](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)で復活） |
| [0011](0011-replay-end-template-matching.md) | 2026-07 | worker | リプレイの終了検知を画面静止ではなくリプレイ選択画面テンプレートとの照合で行う | 有効 |
| [0012](0012-crop-geometry-after-window-stabilizes.md) | 2026-08 | worker | x11grab のクロップ座標はウィンドウ発見時ではなく座標が安定してから確定する | 有効 |
| [0013](0013-per-job-pulseaudio-sink.md) | 2026-08 | worker | 並列録画の音声混成をジョブ専用の PulseAudio sink で防ぐ | 有効 |
| [0014](0014-slow-motion-scaling-across-pipeline.md) | 2026-08 | worker / apps/web | 低速録画の倍率をフック・監視・変換・品質チェックのすべてへ一貫して適用する | 有効 |
| [0015](0015-resume-from-raw-video-checkpoint.md) | 2026-08 | worker / apps/api | リトライ時の再開可否は S3 の生動画の実体で判定し、録画時の倍率はそのオブジェクトに添えて運ぶ | 有効 |
| [0016](0016-ec2-fleet-instance-type-diversification.md) | 2026-08 | apps/api | EC2 Fleet の候補インスタンスタイプはタイトルごとに実機検証で決める | 有効 |
| [0017](0017-orphan-sweep-from-aws-instances.md) | 2026-08 | apps/api | 孤児インスタンスの掃除はジョブレコードではなく AWS 上の実インスタンスを起点に走査する | 有効 |
| [0018](0018-home-worker-pull-assignment.md) | 2026-08 | apps/api / home-worker | 自宅ワーカーへの割り当ては Pull 型にし、競合はすべて条件付き更新で決着させる | 有効 |
| [0019](0019-userdata-ecs-agent-off-and-bootstrap-failure-notification.md) | 2026-07 | apps/api | UserData で ECS エージェントを止め、コンテナ起動前の失敗は UserData 自身が通知する | 有効 |
| [0020](0020-worker-env-redaction-enforced-by-type.md) | 2026-08 | apps/api / packages/shared | taskToken の秘匿は散文の約束ではなく型で強制する | 有効 |
| [0021](0021-cost-estimation-side-data-never-fails-the-job.md) | 2026-08 | apps/api | コスト推定用の付随データは、取得に失敗してもジョブを落とさず、後から上書きしない | 有効 |
| [0022](0022-cost-guard-by-estimated-amount-not-job-count.md) | 2026-07 | apps/api | 新規受付の自動停止は録画回数ではなく推定コスト額で判定する | 有効 |
| [0023](0023-elapsed-time-interpolation-never-rewinds.md) | 2026-08 | apps/web / worker | 経過時間表示はサーバー値を上限とする内挿にし、決して巻き戻さない | 有効 |
| [0024](0024-cookieless-analytics-beacon.md) | 2026-08-16 | apps/web / apps/api / packages/shared / infra | アナリティクスはCookie無しの自前ビーコンで実装し、国はCloudFront経由で取る | 有効 |
| [0025](0025-ops-alerts-per-region-sns-topics.md) | 2026-08-16 | infra / apps/api | 運用アラート通知は1本の宛先に統一しつつ、SNSトピック自体はリージョンごとに分ける | 有効 |
| [0026](0026-hashed-visitor-id-daily-salt.md) | 2026-08-16 | apps/api / infra | ユニーク訪問者数はIPを日次saltでハッシュ化した仮の訪問者IDで数える | 有効 |
| [0027](0027-lambda-alarms-account-wide-not-per-function.md) | 2026-08-19 | infra | Lambdaのエラー・スロットルアラームは関数ごとではなくアカウント全体集計に1本ずつ張る | 有効 |
| [0028](0028-home-worker-container-network-check.md) | 2026-08-24 | home-worker / apps/api | 自宅ワーカーは新規claim前に「コンテナのネットワーク名前空間」からAWSへの疎通を確認する | 有効 |
| [0029](0029-analytics-aggregation-daily-only-uniques.md) | 2026-08-25 | apps/api / packages/shared / apps/web / infra | 訪問者アナリティクスの集計はパーティション単位のQueryで行い、ユニーク訪問者数は日次のみ意味を持たせる | 有効 |
| [0030](0030-cloudfront-measured-usage-best-effort.md) | 2026-08-25 | apps/api / packages/shared / infra | CloudFrontの実配信量はCloudWatchから取得する付随データとし、失敗しても集計APIを壊さない | 有効 |
| [0031](0031-stalled-job-sweep-by-status.md) | 2026-08-26 | apps/api / packages/shared / infra | 非終端のまま固まったジョブは、ジョブレコードのstatusを起点に既存の孤児EC2掃除Ruleへ相乗りして定期掃除する | 有効 |
| [0032](0032-replay-info-server-side-reparse-only.md) | 2026-08-26 | apps/api | replayInfo/game/estimatedDurationSecondsはクライアント申告値を使わずサーバー側で再パースする | 有効 |
| [0033](0033-admission-control-split-magic-link-vs-start-job.md) | 2026-08-26 | apps/api | 受付制御（キルスイッチ・月間コストガード）はrequestMagicLinkとstartJobで非対称にチェックする | 有効 |
| [0034](0034-launch-handlefailure-timing.md) | 2026-08-26 | apps/api | Launch/HandleFailureの判定タイミングは早期失敗通知の遅延と書き込み競合を考慮して決める | 有効 |
| [0035](0035-outer-timeout-wrapper-for-bare-metal-runs.md) | 2026-08-27 | worker | 録画処理のハング対策はコード側の後片付け頑健化とベアメタル実行時の外側timeoutラッパーの二段構えにする | 有効 |
| [0036](0036-th10-bugfix-marisab-self-report.md) | 2026-08-29 | worker / packages/shared / apps/api / apps/web | th10「バグマリ」修正の要否はリプレイに記録されないため自動判別せず、利用者の自己申告オプションに委ねる | 有効 |
| [0037](0037-end-template-restricted-region-for-th10.md) | 2026-08-29 | worker | 終了検知テンプレート照合に絞り込み領域・専用閾値を持たせ、背景が常時アニメーションするth10に対応する | 有効 |
| [0038](0038-remove-stutter-early-detection.md) | 2026-08-29 | worker | 処理落ち早期検知(stutter probe)は真陽性の実績が無く正常なリプレイも誤検知しうるため削除する | 有効 |
| [0039](0039-end-template-freeze-timeout.md) | 2026-08-30 | worker | end_template方式のタイトルにも画面が5分静止したら強制打ち切りする早期検知を追加する | 有効 |
| [0040](0040-home-worker-title-assets-cache.md) | 2026-08-30 | worker / home-worker | 自宅ワーカーのタイトル資産はETagキー付き世代ディレクトリでキャッシュする | 有効 |
| [0041](0041-worker-recording-package-split.md) | 2026-08-31 | worker | 録画パイプラインを`recording/`パッケージへ分割し、`record_thNN.py`はタイトル固有値だけのシムにする | 有効 |
| [0042](0042-2xlarge-instance-type-group-precedent.md) | 2026-09-01 | apps/api | `c7i`/`c7a`/`m7i`の`.2xlarge`帯を実機検証済みグループとして扱い、新規タイトルは1タイプの検証で残り2タイプも候補に加えてよい | 実時間方式の段に限り有効（フレーム同期の段は[0078](0078-frame-sync-plan-and-instance-type-verification-policy.md)） |
| [0043](0043-remove-fps-runaway-detection.md) | 2026-09-08 | worker | fps暴走検知(`scan_fps_runaway()`)を削除する。真陽性の実績が無く、th08の会話イベント・th09のステージ間演出で誤検知した実績のみだったため | 有効 |
| [0044](0044-th06c-steam-drm-stub-and-64bit-title.md) | 2026-09-10 | worker | th06cのSteamworks API初期化要求は最小限のスタブDLLで回避し、64bit専用の録画経路(`GameConfig.for_game()`のoverridesでinjectorを差し替え)を別途用意する | 有効 |
| [0045](0045-ec2-slow-motion-for-th20.md) | 2026-09-11 | packages/shared / apps/api / apps/web / docs | EC2環境でのth20低速録画を有効化し、対応タイトルをコード内定数で管理する | [0058](0058-speedup-recording-on-gpu-instances.md) によって置き換え済み |
| [0046](0046-gpu-ec2-instance-and-fixed-ami.md) | 2026-09-12 | infra / apps/api / worker | GPU描画必須タイトル向けにg6f.xlargeを新規導入し、AMIは事前構築したカスタムAMIを固定参照する | 起動候補(g6f.xlarge)は[0058](0058-speedup-recording-on-gpu-instances.md)によって一部置き換え済み |
| [0047](0047-no-gpu-titles-for-home-worker.md) | 2026-09-12 | apps/api / home-worker | GPU描画必須タイトルは自宅ワーカーへ常にオファーしない | [0079](0079-home-worker-accepts-frame-sync-gpu-titles.md)によって置き換え済み |
| [0048](0048-separate-ecr-repo-for-gpu-workers.md) | 2026-09-12 | infra / worker / apps/api | GPU描画必須タイトル専用の別ECRリポジトリ（worker-gpu）を新設する | 有効 |
| [0049](0049-mod-integration-test-local-only.md) | 2026-09-14 | worker | MODの実機注入統合テストを追加するが、ゲーム資産のライセンス・実行コストのためCIには組み込まず`worker/games/`がある環境限定のローカル実行に限定する | 有効 |
| [0050](0050-th15-gpu-instance-despite-not-strictly-required.md) | 2026-09-17 | worker / apps/api / packages/shared | th15はGPU描画が原理的に必須ではないが、Extraステージの処理落ち対策としてth06ncと同じGPU系インスタンス(g6f系)に固定する | 「固定」は[0064](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)によって置き換え済み(GPUを優先し、確保できなければCPU低速へ) |
| [0051](0051-launch-template-source-version-latest-not-default.md) | 2026-09-17 | apps/api | EC2 Launch Templateのバージョン継承元を`$Default`ではなく`$Latest`にする(CDKデプロイの変更が反映されないバグの修正) | 有効 |
| [0052](0052-gpu-xorg-driver-file-level-mount-not-directory.md) | 2026-09-18 | apps/api | GPU用コンテナへのXorg NVIDIAドライバ受け渡しはディレクトリ丸ごとではなくファイル単位でマウントする(`Need libwfb`起動不能バグの修正) | 有効 |
| [0053](0053-mount-32bit-nvidia-client-libraries-for-wine.md) | 2026-09-18 | apps/api | GPU用コンテナへ32bit版NVIDIAクライアントライブラリを個別マウントする(32bitタイトルがGPUを使えずllvmpipeへ静かにフォールバックするバグの修正) | 有効 |
| [0054](0054-detect-wine-crash-via-wine-log-not-duration-ratio.md) | 2026-09-19 | worker | Wineクラッシュの検知は理論尺比ではなく`wine.log`の未処理例外(`Unhandled`)で行い、検知したら破棄・リトライする(理論尺比はデシンクと縮退するため使わない) | 有効 |
| [0055](0055-exclude-eu-south-2a-from-gpu-fleet.md) | 2026-09-19 | apps/api / infra | GPUジョブのEC2 Fleet候補から`eu-south-2a`を暫定除外する(クラッシュ率が有意に高い、p=0.0021。CPU系は対象外) | [0057](0057-revert-eu-south-2a-gpu-exclusion.md)によって撤回済み |
| [0056](0056-gpu-vcpu-lease-and-queue.md) | 2026-09-19 | apps/api / infra | GPU録画ジョブのvCPU容量をDynamoDBでリースし、`Launch`の手前で待たせる(eu-south-2のG系スポットクオータ8vCPU下でのキューイング、Issue #270) | 有効（リースを取る判定は[0073](0073-gpu-lease-for-next-ec2-step-and-capture-mode.md)で「次のEC2の段がGPUか」へ改訂） |
| [0057](0057-revert-eu-south-2a-gpu-exclusion.md) | 2026-09-22 | apps/api / infra | [0055](0055-exclude-eu-south-2a-from-gpu-fleet.md)の`eu-south-2a`除外を撤回する(起動失敗の増加が実害化し、除外後もクラッシュが根絶されていないため) | 有効 |
| [0058](0058-speedup-recording-on-gpu-instances.md) | 2026-09-30 | packages/shared / apps/api / infra / worker | 倍速録画(2〜4倍速)を導入し、2倍速以上はGPUインスタンス(g6f.2xlargeのみ)で録画する。GPU要否はタイトルではなくジョブ(タイトル+録画速度)で決まる(Issue #288) | 「低速録画の廃止」は[0064](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)、「ユーザーが速度を選ぶ」「GPU要否はジョブで決まる」は[0066](0066-recording-fallback-plan-as-config.md)によって置き換え済み |
| [0059](0059-cut-range-decided-by-recorder.md) | 2026-10-04 | worker | 配信版のカット範囲は録画スクリプトがMODログと終了検知の時刻から決め、元の解像度版も同じ変換で作り直す。同期マーカーは音声の録音をゲーム起動直後に始めてカット区間へ追い出す(Issue #266) | 有効 |
| [0060](0060-speedup-fallback-to-native-speed.md) | 2026-10-09 | packages/shared / apps/api / apps/web | GPUを確保できない倍速録画ジョブ(GPU必須タイトルを除く)は、待ち行列30分超か3回目以降の容量不足で`options.recordingSpeed`を1へ書き換えて等倍(CPU)へ落とす(Issue #289) | [0066](0066-recording-fallback-plan-as-config.md) によって置き換え済み（契機の30分・3回目は段を飛ばす契機として残る） |
| [0061](0061-gpu-capacity-fallback-to-eu-north-1.md) | 2026-10-11 | apps/api / infra / packages/shared / worker / apps/web | GPUジョブはeu-south-2のSpot在庫枯渇時だけeu-north-1で起動する。データ面は移さず、価格では振り分けない。0001の単一リージョン原則の例外(Issue #296) | 「データ面は移さない」は[0062](0062-gpu-fallback-region-local-output-and-title-assets.md)によって一部置き換え済み。「リトライで毎回eu-south-2から試す」は[0063](0063-spot-capacity-shortage-is-permanent-within-a-job.md)によって置き換え済み |
| [0062](0062-gpu-fallback-region-local-output-and-title-assets.md) | 2026-10-11 | apps/api / infra / packages/shared / worker | GPUフォールバック先(eu-north-1)に出力バケットとタイトル資産のレプリカを置き、リージョン間転送料を消す。出力のリージョンは`JobRecord.outputRegion`、配信は MediaCdn の`/eu-north-1/*`(Issue #313) | 有効 |
| [0063](0063-spot-capacity-shortage-is-permanent-within-a-job.md) | 2026-11-04 | apps/api / packages/shared / infra / apps/web | Spot在庫の枯渇はジョブの中で永続エラーとして扱い、待たずに次の段へ進む。全段が尽きたら等倍へ落とすか直ちに失敗させる。ステートマシンは変えない(Issue #315) | 有効 |
| [0064](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md) | 2026-11-05 | packages/shared / apps/api / worker / apps/web | GPUを確保できないth15・th20はCPU低速録画(`c7i.4xlarge`、1/2倍速・th15 Extraは1/3倍速)へ、th06ncは`g6.2xlarge`へ逃がす。低速録画はユーザーが選べず自宅ワーカーへも出さない(Issue #316) | [0081](0081-frame-sync-plan-for-th20-and-th06nc.md)によって置き換え済み（th15は[0078](0078-frame-sync-plan-and-instance-type-verification-policy.md)でフレーム同期へ置き換え済み）。「`options.recordingSpeed`の書き換えで落とす」実装は[0066](0066-recording-fallback-plan-as-config.md)、th06ncの`g6.2xlarge`の段は[0067](0067-th06nc-cpu-slow-motion-and-drop-1080p.md)によって置き換え済み |
| [0082](0082-framesync-duration-mismatch-is-warning-not-failure.md) | 2026-11-23 | worker / docs | フレーム同期の理論尺ずれは、再生区間が3秒未満のときだけ破棄し、それ以外は(短い側なら`desyncDetected`を立てて)警告配信にする。デシンクで早期終了したth10ジョブが失敗した退行の修正 | 有効 |
| [0065](0065-speedup-delivery-frame-rate-by-output-option.md) | 2026-11-07 | worker | 倍速録画の配信版は`fps`フィルタではなく`-r 60 -fps_mode cfr`で60fpsへ揃える。生映像のptsが信用できないため(Issue #322) | 有効 |
| [0066](0066-recording-fallback-plan-as-config.md) | 2026-11-08 | packages/shared / apps/api / home-worker / apps/web / infra | 録画速度・インスタンス・リージョンはタイトルごとの段の配列(`recordingPlan.ts`)を先頭から試して決め、ユーザーに速度を選ばせない。フォールバックの変更は配列だけで行う(Issue #317) | 有効 |
| [0067](0067-th06nc-cpu-slow-motion-and-drop-1080p.md) | 2026-11-09 | packages/shared / worker / apps/web | th06ncの最終段を`g6.2xlarge`からCPU描画(BC7展開)の`c7i.2xlarge`・1/2倍速に替え、1080p録画を廃止する。Extraも同じ段で録り、高密度弾幕の描画落ちは受け入れる(Issue #317) | [0081](0081-frame-sync-plan-for-th20-and-th06nc.md)によって置き換え済み(CPU1/2倍速の段はフレーム同期へ。1080p廃止は有効) |
| [0068](0068-supply-chain-cooldown-and-dependabot.md) | 2026-11-11 | 全パッケージ | 依存パッケージ更新はDependabotとリリース後クールダウン(5〜7日)・完全ピン留め(`requirements-docker.txt`・Actions SHA固定)でサプライチェーン汚染を防ぐ(Issue #338) | 有効 |
| [0069](0069-automated-dependabot-merge-deploy-with-gvisor-sandbox.md) | 2026-11-11 | 全パッケージ | Dependabot PRのAI自動処理はgVisor隔離検査(Phase A)とホスト本番デプロイ・E2E検証(Phase B)の二段階に分離する(Issue #341) | 有効 |
| [0070](0070-th13-native-on-4xlarge-and-half-speed-on-2xlarge.md) | 2026-11-12 | packages/shared / worker | th13は自宅ワーカー→`c7i.4xlarge`の等倍(数値上は基準外だが視聴で許容)→`.2xlarge`帯の1/2倍速で録り、未検証のGPUの段は持たない(Issue #79) | [0080](0080-frame-sync-plan-for-640x480-titles.md)によって置き換え済み |
| [0071](0071-d3dx-text-downscale-filter-in-mod.md) | 2026-11-12 | worker | th10〜th13の文字のジャギーは、MODでD3DXLoadSurfaceFromMemoryの縮小フィルタ(テント)を補って直す。既定で有効、診断機能は取り込まない | 有効 |
| [0072](0072-web-cdn-edge-cache-ignores-origin-no-cache.md) | 2026-11-12 | infra | `WebCdn`はminTTL 1日の専用CachePolicyでHTMLをエッジにキャッシュし、オリジンの`no-cache`による毎回のS3再検証(TTFB約1秒)を避ける。鮮度はデプロイ時の無効化で保つ(Issue #376) | 有効 |
| [0073](0073-gpu-lease-for-next-ec2-step-and-capture-mode.md) | 2026-11-21 | packages/shared / apps/api | 録画の段に`captureMode`（realtime / frameSync）と`maxEstimatedDurationSeconds`を足し、GPUのvCPUリースは「次のEC2の段」で判定してGPUの段が配列の最後にあっても動くようにする（Issue #387、Epic #399） | 有効（[0056](0056-gpu-vcpu-lease-and-queue.md)の「次の段がGPUのとき」の判定を改訂） |
| [0074](0074-import-touhou-recorder-snapshot.md) | 2026-11-21 | research / docs | 旧 PoC リポジトリ touhou-recorder を、伏せ字化した履歴なしスナップショットとして `research/touhou-recorder/` へ取り込み、「touhou-recorder reports/NN」を同ディレクトリの `reports/NN_*.md` と定義する（Issue #396、Epic #399） | 有効 |
| [0075](0075-experiment-jobs-and-experimental-ecr.md) | 2026-11-21 | packages/shared / apps/api / infra / docs | クラウドでの技術検証は、段を明示した「実験ジョブ」（管理API）と検証用ECRリポジトリ（CDK管理）で本番パイプラインに乗せ、手作業のEC2・terraformでの検証はやめる（Issue #397、Epic #399） | 有効 |
| [0076](0076-mod-core-and-present-bus.md) | 2026-11-21 | worker / docs | MODを共通基盤(`core/`)と機能別のディレクトリへ再編し、Presentをイベントバスにする。メニュー待ちは`60/FPS_LIMIT_TARGET_HZ`の1系統、起動待ちは低速録画でだけ伸ばし、`TH06NC_TIME_SCALE`は廃止(Issue #393、Epic #399) | 有効 |
| [0077](0077-worker-frame-sync-recording-path.md) | 2026-11-22 | worker | ワーカーにフレーム同期キャプチャの録画経路(`CAPTURE_MODE=frame_sync`、`recording/framesync.py`)を足す。経路の分岐は`CAPTURE_MODE`だけで、ワーカーの中ではリトライせず、重複フレーム率の代わりに三者照合と理論尺(短い側-30%・長い側+10%)で判定する(Issue #389、Epic #399) | 有効(尺ずれの扱いは[0082](0082-framesync-duration-mismatch-is-warning-not-failure.md)が優先) |
| [0078](0078-frame-sync-plan-and-instance-type-verification-policy.md) | 2026-11-22 | packages/shared / apps/api / apps/web / docs | th12・th15の録画の段をフレーム同期（自宅→2xlarge/4xlarge帯→GPU）中心にする。フレーム同期のインスタンスタイプは品質に影響しないので綿密な実機検証をせず（速度のみ）、新しい作品タイトルの追加と実時間の段のタイプは従来どおり実機検証する(Issue #390、Epic #399) | 有効 |
| [0079](0079-home-worker-accepts-frame-sync-gpu-titles.md) | 2026-11-22 | packages/shared / home-worker / docs | GPUの段を持つタイトルでも、フレーム同期の段なら自宅ワーカーへオファーする。自宅へ出すかは録画の段だけが決める（0047を置き換え。Issue #390） | 有効 |
| [0080](0080-frame-sync-plan-for-640x480-titles.md) | 2026-11-22 | packages/shared / apps/web / docs | 640x480の残り9タイトル(th06・th06c・th07・th08・th09・th10・th11・th128・th13)も、th12と同じフレーム同期中心の計画(自宅→2xlarge帯→4xlarge帯→GPU。th13はGPUなし)へ切り替える。実時間専用のCPU候補定数は削除 | 有効 |
| [0081](0081-frame-sync-plan-for-th20-and-th06nc.md) | 2026-11-23 | packages/shared / home-worker / apps/web / docs | th20・th06ncも自宅→EC2フレーム同期→GPU(最後)の計画にする。実時間のCPU低速段(0064・0067)を削除し、全13タイトルがフレーム同期中心になる(Issue #390の完了) | 有効 |

## 書き方

- ファイル名は `NNNN-kebab-case-title.md`（4桁の連番）。**番号は既存の最大値+1**を採る。
  日付順ではなく作成順なので、番号が飛んでいても詰めない。
- [`TEMPLATE.md`](TEMPLATE.md) をコピーして書き始める。書式の詳細は
  [`../documentation-guidelines.md`](../documentation-guidelines.md) §5.2。
- **新規追加したら上の一覧にも必ず1行足すこと**。一覧に載っていない決定記録は、
  エージェントからは存在しないのと同じである。
- **README（① 参照仕様）側からもリンクを張る**（同ガイドライン §5.5）。
  リンクを張らずに情報をここへ移すのは、削除と大差ない。

## 決定が覆されたとき

**元のファイルを削除・書き換えしない**。`状態` を「`NNNN` によって置き換え済み」に変え、
新しい番号で新規ファイルを作り、この一覧の `状態` 欄も更新する。

覆された決定とその理由が残っていること自体が、同じ検討を繰り返さないための情報である
（「昔なぜそうしなかったか」は再検討時に最も価値が高い）。
