# フェーズ15: GCPクラウド環境での録画動作検証・コスト試算(AWS比較込み)

日付: 2026-07-15

## 目的

これまでのフェーズでローカルマシン(Wine + Xvfb + ffmpeg、CPUソフトウェアレンダリング)による th07 リプレイの安定録画を実証してきた。本フェーズでは、この録画パイプラインを実際にGCPプロジェクト「<GCP_PROJECT_ID>」上にデプロイし、クラウド環境(CPUのみ、GPUなし)でも同様に動作することを検証した。当初計画のとおり **Cloud Run Job を第一候補**とし、動作確認できたため Compute Engine 側の検証はコスト比較目的の追加検証として実施した。あわせて、4 vCPU固定でメモリを削減したより安価な構成の可否、およびAWSを利用した場合の同条件でのコスト試算も行った。

## 結論(要約)

- **Cloud Run Job・Compute Engine(Spot VM)のいずれでも、CPUのみでth07リプレイの実写と同等の録画が正常に完走することを実証した**(実際に東方妖々夢のゲームプレイ映像・音声を含むmp4をダウンロードし、目視・ffprobe・音量解析・重複フレーム率で検証済み)
- 必要なCPU割当は **4 vCPU が事実上の下限**。2 vCPUでは処理落ち(重複フレーム率28〜59%)が発生し実用に耐えない
- **4 vCPU固定でメモリだけを4GB→2GBに削減(`e2-custom-4-2048`)しても動作はするが、重複フレーム率が4%→17%に悪化し、コスト削減効果はごくわずか(コンピュートコストの約6%)しかない**。メモリ削減は推奨しない
- **保存期間7日・ダウンロードが無料枠を超過する前提でも、コスト最安の構成はGCE Spot VMが依然として有利**。ただし想定利用量(月1回程度のダウンロード)では無料枠内に収まる可能性が高く、egressコストは実際にはかからない見込み
- **AWSでも同条件で同程度のアーキテクチャ(Fargate / EC2 Spot)が組める。GCPとAWSそれぞれの最安構成(GCE Spot e2-highcpu-4 と EC2 Spot c6i.xlarge)はコストがほぼ同水準($0.196〜0.198、egress込み)**で、クラウド事業者の選択よりも「egressが発生するかどうか」の方がコストへの影響が大きい
- 運用の単純さでは Cloud Run Job / AWS Fargate(サーバーレス、VMライフサイクル管理が不要)が優位。コスト最優先なら Compute Engine Spot VM / EC2 Spot を推奨

## 検証環境

- GCPプロジェクト: `<GCP_PROJECT_ID>`(既存、課金有効)。**2026-10-14にプロジェクトごと削除済み**(末尾「現在GCP・AWS上に残っているリソース」参照)
- リージョン: `asia-northeast1`(東京)
- コンテナイメージ: `asia-northeast1-docker.pkg.dev/<GCP_PROJECT_ID>/touhou-recorder/th07-recorder:latest`(Artifact Registry)
- 出力先: `gs://touhou-recorder-output`(Cloud Storage)
- IaC: Terraform (`cloud/terraform/cloudrun/`, `cloud/terraform/gce/`)、Docker (`cloud/docker/`)

## アーキテクチャ

### コンテナイメージ (`cloud/docker/Dockerfile`)

Ubuntu 24.04ベースに、ローカル検証環境と同一の構成(wine 9.0, Xvfb, openbox, ffmpeg, pulseaudio, MS Gothicフォント, python3+numpy+PIL)を導入し、`games/th07`(ゲーム本体)・`prefixes/th07-wined3d-gl`(WINEPREFIX)・`mods/`のビルド済みMODを焼き込んだ。イメージサイズは約4.76GB。

エントリポイント (`cloud/docker/entrypoint.py`) は PulseAudio起動 → `scripts/11_record_th07_replay_e2e.py` 実行 → 結果(動画・ログ)をCloud Storageへアップロード、という流れを行う。

### Cloud Run Job (`cloud/terraform/cloudrun/main.tf`)

`google_cloud_run_v2_job` で定義。ジョブ実行中は常時CPUが割り当てられる(サービスと異なりリクエスト駆動ではない)ため、エンコード処理主体の本ワークロードに適している。

### Compute Engine (`cloud/terraform/gce/main.tf`)

Packerでの専用VMイメージビルドは行わず、**Container-Optimized OS (COS) 上で既存のDockerイメージをそのまま起動する**方式を採用した(Cloud Run用に構築したイメージをそのまま再利用でき、ビルドパイプラインを二重化せずに済むため)。`startup-script`で`docker run`を実行し、完了後に自身をpoweroffしてVM courant時間を最小化する設計。SpotVM(旧プリエンプティブル)を使用。

## 発生した問題と対処

デプロイ過程で複数の環境差異に起因する問題が発生し、すべて解消した。

1. **DockerビルドがDNS解決失敗で進まない**: ホストマシンのhide.me VPN(`hide.me@tw.service`)がDockerブリッジネットワークの外部疎通を妨げていた。VPNサービスを一時停止して解消(ユーザー確認済み)
2. **containerdサービスが2週間前から停止していた**: `docker build`が`containerd.sock`への接続でタイムアウト。`sudo systemctl start containerd`で復旧(既存の稼働中コンテナには影響なし)
3. **ゲームウィンドウの代わりに小さな"log"ウィンドウしか現れない**: 最小構成のUbuntuイメージにMesaのOpenGL関連パッケージ(`libgl1`, `libgl1-mesa-dri`, `libglx-mesa0`, `libegl-mesa0`。amd64・i386両方)が不足しており、`wined3d`の`libGL.so.1`ロードに失敗、結果的にDirect3Dデバイス初期化がすべて失敗してゲームがエラーダイアログのみ表示していた。該当パッケージ追加で解消
4. **録画用ffmpegが起動直後に無言でクラッシュ**: PulseAudioはハードウェア非搭載環境で起動時に自動的に`auto_null`という名前のnull sinkを作成する(ホスト環境と同じ挙動)。entrypoint側で同名のsinkを重ねて手動作成していたため`auto_null.2`にリネームされ、スクリプトが期待する`auto_null.monitor`が存在せず、`-f pulse -i auto_null.monitor`を含む録画用ffmpegコマンドが`Input/output error`で即終了していた。**この不具合はrecord_stdout.logだけを見ると「録画が正常に完走したように見える」ため発覚が遅れた**(静止画面検知ロジックが別プロセスの単発スクリーンショットに依存しており、本体のffmpeg生死と無関係に動作し続けるため)。手動でのnull sink作成を削除して解消。あわせて`scripts/11_record_th07_replay_e2e.py`のffmpeg標準エラーを`DEVNULL`から実ログファイルへの出力に変更し、今後同種の問題を早期検知できるようにした
5. **COSのstartup-scriptで`docker-credential-gcr`が`/root/.docker`に書き込めない**: Container-Optimized OSはルートファイルシステムが読み取り専用。`HOME`を`/tmp/home`等の書き込み可能なパスに変更して解消
6. **GCEのサービスアカウントにArtifact Registry読み取り権限がなかった**: `roles/storage.objectAdmin`のみ付与しており、`roles/artifactregistry.reader`が欠けていたためイメージpullが権限エラーで失敗。IAMバインディングを追加して解消

いずれも一過性の環境差異(コンテナの最小構成・COSの制約・PulseAudioの自動命名)に起因するものであり、th07自体やレンダリングパイプラインの問題ではない。

## 動作検証結果

| 環境 | 構成 | 実行結果 | 重複フレーム率(60秒サンプル) | 実録画時間 |
|---|---|---|---|---|
| Cloud Run Job | 4 vCPU / 4Gi | ✅成功 | 約7%(良好) | 852.7秒(th7_07.rpy) |
| Cloud Run Job | 2 vCPU / 2Gi | ⚠️完走するが品質不可 | **約59%**(重度の処理落ち) | 852.7秒(実時間1250秒に伸長) |
| GCE Spot | e2-highcpu-4 (4vCPU/4GB) | ✅成功 | 約4%(良好、Cloud Runより僅かに良い) | 849.8秒 |
| GCE Spot | e2-highcpu-2 (2vCPU/2GB) | ⚠️動作するが品質にやや難 | 約28%(軽度〜中程度の処理落ち) | 実時間1093秒に伸長 |
| GCE Spot | **e2-custom-4-2048 (4vCPU/2GB)** | ⚠️動作するがやや難 | **約17%**(4GB版より悪化) | 851.6秒(実時間はほぼ変わらず) |

**4 vCPU固定でのメモリ削減(`e2-custom-4-2048`、4vCPUでE2カスタムマシンタイプが許容する最小メモリ)について**: 実録画時間はe2-highcpu-4とほぼ同じ(851.6秒 対 849.8秒)だが、重複フレーム率は4%→17%へ悪化した。コンテナのメモリ使用量自体は録画中で481.8MiB/1.93GiB(約24%)と余裕があったため致命的なOOMではないが、ページキャッシュ等の余裕が減ったことでI/Oまわりに軽微な影響が出たと推測される。**コスト削減効果はコンピュートコストの約6%(RAM単価がCPU単価よりずっと安いため)に留まり、品質低下に見合わない**ため、メモリ削減は推奨しない。

すべての成功ケースで、ダウンロードしたmp4を`ffprobe`(解像度640x480・60fps・h264/aac)、`volumedetect`(mean_volume -9.3dB、無音でないことを確認)、フレーム抽出による目視確認(スコア・HUD・キャラクター等が正しく描画されている)で内容の正しさを検証済み。

**重複フレーム率が高い(=処理落ちしている)場合、リプレイの実時間が本来より伸びる**(2vCPU構成でおよそ1.29〜1.47倍)。これは録画時間课金コストに直結するため、CPU割当を絞りすぎることはコスト的にも逆効果になりうる。

## コスト試算(2026-07-15時点の実勢価格、GCP Cloud Billing Catalog・AWS Pricing API実測)

### 単価一覧

| 項目 | GCP (asia-northeast1) | AWS (ap-northeast-1) |
|---|---|---|
| サーバーレス実行 CPU | Cloud Run Jobs: $0.000018 / vCPU秒 | Fargate: $0.05056 / vCPU時間 |
| サーバーレス実行 メモリ | Cloud Run Jobs: $0.000002 / GiB秒 | Fargate: $0.00553 / GB時間 |
| VM CPU(Spot) | E2: $0.01619 / vCPU時間 | c6i.xlarge実勢Spot: $0.0824/時間(4vCPU/8GB) |
| VM CPU(On-Demand) | E2: $0.02802642 / vCPU時間 | c6a.xlarge: $0.1926/時間(4vCPU/8GB) |
| VM RAM(Spot) | E2: $0.00216 / GB時間 | (インスタンスサイズに内包) |
| オブジェクトストレージ標準保存 | GCS: $0.023 / GiB・月 | S3: $0.025 / GB・月 |
| ネットワーク下り(無料枠超過後) | $0.12 / GiB(APAC向け) | $0.114 / GB(東京→インターネット) |

AWS側はFargate/EC2いずれも**実際にはデプロイ・録画テストを行っておらず**、GCP側で実測したオーバーヘッド(起動・pull・アップロード等、合計約20秒[サーバーレス]・約105秒[VM])が同程度かかると仮定した試算値である。EC2 Spot価格は変動制のため、取得時点(2026-07-15)の直近スポット価格を採用した。また、AWSはFargate・EC2いずれも「4 vCPU」に対応する最小メモリが**8GB**(GCPのCloud Run Jobsは4Gi、E2カスタムマシンタイプは2GBまで下げられる)で、GCPよりメモリの下限が高い点もアーキテクチャ上の違いとして影響する。

### 録画1回(30分と仮定、保存期間7日間、ダウンロードは無料枠を超過した前提)のコスト試算

前提: リプレイ再生時間30分(1800秒)+実測オーバーヘッド。動画ファイルサイズは実測(14.2分で約600MB)から比例配分で約1.27GB/GiBと推定。保存期間7日間(1ヶ月ではなく7日分で按分)。**ダウンロード(egress)は無料枠を使い切っている前提で有料単価をそのまま適用**(GCPは月100GiB、AWSも同水準の無料枠があるが、ここでは意図的に超過ケースを試算する)。

| アーキテクチャ・構成 | 実行時間(概算) | コンピュート | 保存(7日) | ダウンロード | **合計** |
|---|---|---|---|---|---|
| **GCE Spot e2-highcpu-4**(GCP推奨) | 約31.8分 | $0.0388 | $0.0068 | $0.1524 | **$0.1981** |
| **AWS EC2 Spot c6i.xlarge**(AWS推奨) | 約31.8分(仮定) | $0.0436 | $0.0074 | $0.1448 | **$0.1958** |
| GCE Spot e2-custom-4-2048(4vCPU/2GB、非推奨) | 約31.8分 | $0.0366 | $0.0068 | $0.1524 | $0.1958(品質低下あり) |
| AWS EC2 On-Demand c6a.xlarge | 約31.8分(仮定) | $0.1019 | $0.0074 | $0.1448 | $0.2541 |
| GCE On-Demand e2-highcpu-4 | 約31.8分 | $0.0672 | $0.0068 | $0.1524 | $0.2265 |
| AWS Fargate 4vCPU/8GB | 約30.3分(仮定) | $0.1246 | $0.0074 | $0.1448 | $0.2768 |
| Cloud Run Job 4vCPU/4Gi | 約30.3分 | $0.1456 | $0.0068 | $0.1524 | $0.3048 |

**注目すべき点**: egressが無料枠を超過するケースでは、**動画1本分のダウンロード費用($0.14〜0.15)がコンピュートコスト($0.04〜0.05)を大きく上回り、総コストの支配項になる**。この結果、GCP側の最安構成(GCE Spot e2-highcpu-4)とAWS側の最安構成(EC2 Spot c6i.xlarge)は**ほぼ同額($0.1981 対 $0.1958)**に収束し、クラウド事業者の選択そのものよりも「egressが発生するかどうか(=無料枠内に収まる運用ができるか)」の方がコストへの影響が大きい。

**実際の運用では、月あたりのダウンロード量が無料枠(GCP: 100GiB、AWS: 概ね同水準)に収まっていればegressコストは発生しない**。1本あたり約1.27GBなので、月70〜80本程度まではダウンロード無料枠内に収まる計算になる。当初レポート(無料枠内を前提とした試算)ではGCE Spotの合計コストは$0.04程度だったが、無料枠を使い切った状態が常態化する運用(高頻度録画・多数ユーザーへの配信等)ではegressコストが支配的になる点に注意が必要。

### 結論・推奨構成

- **コスト最優先なら Compute Engine Spot VM (e2-highcpu-4) または AWS EC2 Spot (c6i.xlarge)。両者はほぼ同コスト**なので、既存の運用基盤(GCP/AWSどちらを主に使っているか)で選んで差し支えない
- **運用のシンプルさを取るなら Cloud Run Job または AWS Fargate**(サーバーレスでVMライフサイクル管理・イメージ認証周りのトラブルシュートが不要)。ただしAWS Fargateは4vCPU時の最小メモリが8GBとGCPのCloud Run Jobs(4Gi)より高く、コンピュートコストもやや高い
- **4 vCPU固定でのメモリ削減(GCEのE2カスタムマシンタイプで2GBまで可能)は、コスト削減効果が小さく(約6%)品質が悪化するため推奨しない**
- CPU割当は**4 vCPU未満に抑えるとコストと品質の両方が悪化する**(処理落ちで実時間が伸びるため、単価が安くても総コストは必ずしも下がらない)ため推奨しない
- **高頻度に録画・配信する運用を想定するなら、egressコストの最小化(CDN併用、無料枠内に収まる配信量の維持等)がコンピュート構成の選択より優先度が高い**
- 追記(egress対策の一案): **Amazon CloudFrontは1TB/月・1,000万リクエスト/月が12ヶ月限定ではなく永年無料(Always Free)**で、超過分も$0.085/GBとS3直接ダウンロード($0.114/GB)より安い。動画1本約1.27GBなら月700本超まで配信コスト$0で済む計算になり、egressが支配項化する高頻度運用では有力な選択肢。ただしS3の手前にCloudFrontを置く構成となるため、この恩恵を活かすには保存・配信をAWS側に寄せる必要がある(GCPで録画しS3にアップロードする構成だとGCP→AWS間のegressで単に課金ポイントが移るだけになりうる)。GCPのCloud CDNには同等の永年無料枠は無く従量課金のみ。本レポートでは試算・実装とも未着手

## 未検証・今後の課題

- T2D(AMD)・N2・C2等、E2以外のマシンファミリでの追加比較(時間の制約で未実施。E2はバースト可能な汎用インスタンスであり、より安価な代替がある可能性は残る)
- Packerによる専用VMイメージ(ゲーム本体・WINEPREFIXを含む)構築は行わなかった。COS+コンテナ方式で十分動作したため優先度を下げたが、VM起動のたびに4.76GBのイメージpullが発生する点は、頻繁に実行する運用ではPacker製ゴールデンイメージの方が起動時間・pull帯域コストの両面で有利になる可能性がある
- Cloud Tasks/Pub/Subによるジョブキューイングの実装自体は未着手(手動での`gcloud run jobs execute` / VM起動で動作確認したのみ)
- 本検証はth07・`th7_07.rpy`(約14分の通常ステージリプレイ)のみで実施。より長時間のリプレイ(`th7_09.rpy`、約30分)や他タイトルでの動作確認は未実施
- GCE側は現在SpotVMの`instance_termination_action=DELETE`を設定しているが、これはGCP側からのプリエンプション時のみ有効で、`poweroff`によるゲスト主導のシャットダウンでは単に`TERMINATED`状態になりディスク課金(pd-balanced 30GB、月あたり数百円程度)が残る。恒久運用する場合はVM自身による自己削除(`gcloud compute instances delete`をサービスアカウント権限で実行)を組み込むことを推奨
- **AWS側は実際のデプロイ・録画テストを行っておらず、公開料金データ(AWS Pricing API・EC2 Spot Price History)に基づく試算のみ**。GCPと全く同じオーバーヘッド(起動時間・イメージpull速度等)になるとは限らないため、正式採用する場合はGCPと同様に実機検証を推奨する
- EC2 Spotは価格が需給で変動する(GCPのSpotは固定の割引率)ため、本レポートの数値は2026-07-15時点のスナップショットである点に注意

## 作成した成果物

- `cloud/docker/Dockerfile`, `cloud/docker/entrypoint.py`: 録画ワーカーのコンテナイメージ
- `cloud/terraform/cloudrun/main.tf`: Cloud Run Job定義
- `cloud/terraform/gce/main.tf`: Compute Engine(COS+コンテナ、Spot VM)定義。`machine_type`変数で任意のマシンタイプ(E2カスタム含む)を指定可能
- `scripts/11_record_th07_replay_e2e.py`: ffmpeg標準エラーの可視化・exit code記録を追加(診断性向上)

## 現在GCP・AWS上に残っているリソース

検証終了後、本フェーズで作成したGCPリソース(Cloud Run Job・Compute Engineインスタンス・Artifact Registryリポジトリ・Cloud Storage上の検証動画・関連サービスアカウント/IAMバインディング)は**すべて削除済み**。AWS側はPricing API・Spot Price History参照のみでリソース作成は行っていない(IAMインラインポリシーで`pricing:GetProducts`等の読み取り権限を追加していただいた点のみ、ユーザー側の環境変更として残る)。

追記(2026-10-14): フェーズ16以降はAWSに一本化しておりGCPは使用していなかったため、GCPプロジェクト`<GCP_PROJECT_ID>`(プロジェクト番号`<GCP_PROJECT_NUMBER>`)を**プロジェクトごと削除した**(`gcloud projects delete <GCP_PROJECT_ID>`、削除直前の残存物は空のGCSバケット`gs://touhou-recorder-output`とデフォルトのCompute Engineサービスアカウントのみ)。これに伴い、`cloud/terraform/cloudrun/`・`cloud/terraform/gce/`のTerraform定義および`cloud/docker/Dockerfile`・`cloud/docker/entrypoint.py`(GCP版)は過去の検証記録としてのみ残っており、そのままでは適用・実行できない。
