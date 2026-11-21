# フェーズ17: AWS EC2インスタンスタイプ比較・複数AZ Spot Fleet検証

日付: 2026-07-16

## 目的

フェーズ16でAWS EC2 Spot `c6i.xlarge`(4vCPU)でのth07リプレイ録画を実証し、重複フレーム率(処理落ちの指標)は60秒サンプルで約8.0%だった。本フェーズでは、この品質をさらに改善できないか、(1) 同価格帯の別インスタンスタイプ・4vCPUより多いインスタンスタイプで実機比較し、(2) 単一AZでのSpotキャパシティ不足・価格高騰リスクに備え、複数サブネット(AZ)にまたがるSpot Fleetで最安価格の自動選択と録画完走を検証する。

## 結論(要約)

- **`c7i.xlarge`(Sapphire Rapids世代、4vCPU)は`c6i.xlarge`より重複フレーム率が低く(全編5.9%→4.7%)、かつSpot価格も安い(実測$0.0779/時間→$0.0696/時間)**。コスト・品質の両面で`c6i.xlarge`を上回るため、デフォルト構成として`c7i.xlarge`への切り替えを推奨する
- **`c6i.2xlarge`(同世代・8vCPU)は最も重複フレーム率が低い(全編3.3%)が、Spot価格は約2倍($0.162/時間)**。品質を最優先する場合の選択肢になる
- **`z1d.xlarge`(高クロック特化・4vCPU)は期待に反して全編の重複フレーム率が最も悪化した(10.8%、ベースラインより悪い)**。60秒程度の短時間サンプルでは良好に見えることがあり(2.3%)、単発サンプルだけでは判断を誤る典型例だった
- **単一の60秒サンプルによる重複フレーム率計測は非常にノイズが大きく、同一動画・同一パイプラインでもサンプル区間によって1.3%〜17.4%までばらつくことを実測で確認した**。フェーズ15・16で使っていた「60秒サンプル」方式は代表性に乏しく、今後は録画全編(または複数区間の平均)で評価すべきという教訓を得た
- **複数サブネット(AZ)にまたがるSpot Fleet(`request-spot-fleet`、`AllocationStrategy: lowestPrice`)は、実際にその時点で最安価格だったAZ(`us-east-1f`、$0.0621/時間)を正しく自動選択してインスタンスを起動することを確認した**。録画完走の確認はユーザー指示により省略し、起動成功(ステータスチェックOK)の時点で検証を終了・リソースを解放した

## 検証手法

### 重複フレーム率の測定方法(標準化)

フェーズ15・16で行っていたアドホックな`mpdecimate`ベースの計測手順を`scripts/measure_duplicate_frame_rate.sh <video> [start_sec] [duration_sec]`として再利用可能な形にした。指定区間の総フレーム数(`ffprobe`)とmpdecimateフィルタ通過後のユニークフレーム数(`ffmpeg -vf mpdecimate -f null -`)を比較する。

検証の過程で、フェーズ16の「重複フレーム率(60秒サンプル)は約8.0%」という数値が**動画の先頭0〜60秒区間**を指していたことを、同じベースライン動画に対して`start=0`で再計算し完全一致(3599フレーム中3311ユニーク)することで確認した。一方、同じ動画の他の60秒区間(60-120s, 200-260s, 400-460s, 600-660s, 700-760s)を計測すると1.3%〜17.4%まで大きくばらついた。このため、**本フェーズのインスタンスタイプ比較では、録画全体(0〜840秒、リプレイ本編とほぼ全域をカバー)を通した重複フレーム率を主指標とした**。

### インスタンス選定の考え方

- `c7i.xlarge`: `c6i.xlarge`(Ice Lake世代)の後継世代(Sapphire Rapids)。同じ4vCPU・同価格帯だが、新しいCPUマイクロアーキテクチャがWineのソフトウェアレンダリング(llvmpipe)やffmpegのエンコードにどう効くかを検証する狙い
- `z1d.xlarge`: AWSで唯一「全コア持続4.0GHz」を謳う高クロック特化インスタンス。th07自体は単一プロセスのゲームであり、シングルスレッド性能(クロック速度)がボトルネックである可能性を検証する狙い(価格は$0.13台とやや高め)
- `c6i.2xlarge`: `c6i.xlarge`と同世代のまま vCPU を8に倍増。ffmpegのエンコードやOS全体のスケジューリング余裕がボトルネック解消に効くかを検証する狙い(価格は約2倍)

### インフラ構成

フェーズ16と同一のTerraform構成(`cloud/terraform/aws/main.tf`、S3出力バケット・CloudFront・IAMロール・セキュリティグループ)を`terraform apply`(EC2インスタンス以外を対象、フェーズ16の教訓により`-target`で限定)で再構築した。ECRリポジトリ・録画ワーカーのDockerイメージ(`cloud/docker/aws/Dockerfile`)もフェーズ16と同一内容で作り直した(前回検証後に全て削除済みだったため)。

EC2インスタンス自体は、フェーズ16で判明した「Spotキャパシティ不足時にterraform-provider-awsがハングする」問題を踏まえ、`aws ec2 run-instances`(通常のインスタンスタイプ比較)・`aws ec2 request-spot-fleet`(Spot Fleet検証)をAWS CLIから直接実行する形にした。3つのインスタンスタイプ比較は、クラウド上の完全に独立したVMであるため(`AGENTS.md`に記載のローカルWine並列実行の制約とは無関係)、**3台を同時並列に起動**して検証時間を短縮した。

## 動作検証結果:インスタンスタイプ比較

| インスタンスタイプ | vCPU | 実測Spot価格(us-east-1a) | 重複フレーム率(全編0-840s) | 重複フレーム率(60秒サンプル、参考) | 録画時間 | 出力サイズ |
|---|---|---|---|---|---|---|
| `c6i.xlarge`(ベースライン、フェーズ16録画を再利用) | 4 | $0.0779/時間 | **5.9%**(50400中47406ユニーク) | 1.3%〜17.4%(区間依存、大幅変動) | 850.5秒 | 644MB |
| `c7i.xlarge`(新世代・同価格帯) | 4 | $0.0696/時間 | **4.7%**(50399中48026ユニーク) | 1.1%〜1.6% | 850.6秒 | 648MB |
| `z1d.xlarge`(高クロック特化) | 4 | $0.1331/時間 | **10.8%**(50400中44946ユニーク) | 2.3%〜6.4% | 851.3秒 | 629MB |
| `c6i.2xlarge`(同世代・8vCPU) | 8 | $0.1620/時間 | **3.3%**(50399中48742ユニーク) | 2.4%〜3.9% | 852.0秒 | 656MB |

全インスタンスで映像(640x480, 60fps, h264)・音声(AAC 48kHz、mean_volume -9.3dB、無音でないことを確認)は正常。フレーム抽出による目視確認(`reports/assets/th07_aws_c7i_xlarge_frame_60s.png`, `th07_aws_z1d_xlarge_frame_400s.png`, `th07_aws_c6i_2xlarge_frame_400s.png`)でも、スコア・HUD・キャラクター・弾幕・日本語フォントが正しく描画されていることを確認した。全ランでMODログの`WaitForStableWindow: stable`を確認しており、録画開始タイミングの問題も無かった。

### 考察

- **`c7i.xlarge`は価格・品質ともに`c6i.xlarge`を上回る「フリーランチ」だった**。新CPU世代がWineのソフトウェアレンダリング・ffmpegエンコードの両方に効いている可能性が高いが、正確な要因分解(CPU世代 vs 単なるその時点でのスポット需給)までは踏み込んでいない
- **`z1d.xlarge`が全編ベースより悪化したのは意外な結果**。クロック速度がボトルネックという仮説は今回のデータでは支持されなかった。z1dはメモリ帯域や世代がc6iと同等(いずれもIce Lake系)で、コア数もvCPU4のまま変わらないため、単純な「高クロック」だけでは処理落ちの根本原因(おそらくffmpegのx11grab+エンコードとWineのレンダリングスレッド間のコンテンション)を解消できなかったと考えられる。60秒サンプルだけで判断していれば「z1dは改善した」と誤った結論を出しかねなかった点は重要な教訓
- **`c6i.2xlarge`(vCPU倍増)は確実に効果があった**。ffmpegエンコードとWine/Xvfbレンダリングを別コアで実行できる余裕が増えたことが要因と推測されるが、コストは約2倍
- 総合すると、**コストを増やさずに品質を改善したいなら`c7i.xlarge`への切り替え、品質を最優先するなら`c6i.2xlarge`**が推奨構成となる

## 動作検証結果:複数AZ Spot Fleet

### 構成

`aws ec2 request-spot-fleet`(クラシックSpot Fleet API)で、`c6i.xlarge`を対象に以下の設定でリクエストした。

- `AllocationStrategy: lowestPrice`(複数のLaunchSpecificationsの中から最安値のものを選択)
- `TargetCapacity: 1`, `Type: request`(目標数量を満たしたら追加のリランチはしない、フリート自体は録画完了後に手動キャンセル)
- `IamFleetRole`: アカウントに既存だったサービスロール`aws-ec2-spot-fleet-tagging-role`をそのまま利用(新規作成不要だった)
- `LaunchSpecifications`: `us-east-1a`(<SUBNET_ID>)・`us-east-1c`(<SUBNET_ID>)・`us-east-1d`(<SUBNET_ID>)・`us-east-1f`(<SUBNET_ID>)の4サブネット分を用意(`us-east-1b`はフェーズ16でSpotキャパシティ不足が判明済みのため除外、`main.tf`の既存フィルタと同じ方針)

リクエスト時点の各AZのSpot価格(実測): `us-east-1a`=$0.0779, `us-east-1c`=$0.0687, `us-east-1d`=$0.0709, `us-east-1f`=$0.0621(最安)。

### 結果

Spot Fleetは**実際に最安値だった`us-east-1f`を正しく自動選択し**、インスタンス(`<INSTANCE_ID>`)を起動した。起動後、`SystemStatus`・`InstanceStatus`とも`ok`となり、正常に起動していることを確認した。**録画完走までの確認はユーザー指示により省略**した(`c6i.xlarge`自体の録画パイプラインはフェーズ16および本フェーズの他インスタンスタイプ比較で既に実証済みのため、Spot Fleet機構自体の検証としては起動成功の確認で十分と判断)。確認後、`cancel-spot-fleet-requests --terminate-instances`でリクエストとインスタンスを終了し、コストを最小化した。

### 実装上の注意点

- クラシックSpot Fleet APIの`LaunchSpecifications`には`InstanceInterruptionBehavior`フィールドは存在しない(EC2Fleet/RunInstancesの`instance_market_options.spot_options`とはスキーマが異なる)。誤って指定すると`Parameter validation failed`になる。中断時の扱いは`SpotFleetRequestConfig`側の`Type`(`request`/`maintain`)で制御する
- `IamFleetRole`用のサービスロール`aws-ec2-spot-fleet-tagging-role`はこのAWSアカウントに2017年から既に存在していた(おそらくコンソール経由でSpot Fleetを使った際に自動作成されたもの)。新規にSpot Fleetを使うアカウントでは、このロールを事前に作成する必要がある(`iam:CreateRole`権限が必要)

### 結論

複数AZにまたがるSpot Fleetは、単一AZ固定運用の弱点(特定AZでのキャパシティ不足・価格高騰)を機械的に回避しつつ、その時点で最安のAZを自動選択できることを実機で確認した。フェーズ16で示唆した「本番運用ではSpot Fleet/EC2 Fleetの活用が望ましい」という方針は、実装・動作の両面で裏付けられた。恒久的な自動化パイプラインでは、`request-spot-fleet`(または新しい`create-fleet`のEC2 Fleet API)をAWS CLI/SDKから直接呼び出す形を推奨する(`aws_instance`と同様、terraformの`aws_spot_fleet_request`リソースがフェーズ16と同種のハング問題を起こす可能性は未検証)。

## クリーンアップ

検証終了後、本フェーズで作成した全AWSリソースを削除済み。

- EC2インスタンス4台(`c7i.xlarge`, `z1d.xlarge`, `c6i.2xlarge`, Spot Fleet経由の`c6i.xlarge`)は全て自己終了(`shutdown -h now`)、または`cancel-spot-fleet-requests --terminate-instances`で終了済み(`terminated`確認済み)
- S3バケット(`touhou-recorder-output-<AWS_ACCOUNT_ID>`)・CloudFrontディストリビューション・Origin Access Control・IAMロール/インスタンスプロファイル/インラインポリシー・セキュリティグループは`terraform destroy`で削除済み(オブジェクトが残っているとバケット削除が失敗するため、事前に`aws s3 rm --recursive`で空にした)
- ECRリポジトリ・イメージは`aws ecr delete-repository --force`で削除済み
- ローカルのDockerイメージも削除済み

## 作成した成果物

- `scripts/measure_duplicate_frame_rate.sh`: 重複フレーム率計測の再利用可能スクリプト(今後のフェーズでも同一手法を使い回すため)
- `runs/aws_ec2_c7i_xlarge/`, `runs/aws_ec2_z1d_xlarge/`, `runs/aws_ec2_c6i_2xlarge/`: 各インスタンスタイプでの録画動画・ログ・目視確認用フレーム画像(60秒目・400秒目)
- `reports/assets/th07_aws_c7i_xlarge_frame_60s.png`, `th07_aws_z1d_xlarge_frame_400s.png`, `th07_aws_c6i_2xlarge_frame_400s.png`: 目視確認用フレーム

## 未検証・今後の課題

- 重複フレーム率の変動要因(なぜz1dが悪化しc7iが改善したか)の根本原因分析は未実施。`perf`等でのプロファイリングがあればより確実な結論が得られる
- Spot Fleetでの録画完走・S3アップロードまでの確認は本フェーズでは省略した。恒久運用に組み込む前には、少なくとも1回はSpot Fleet経由での録画完走を確認することが望ましい
- `c7i`世代のオンデマンド価格・他リージョンでの価格差は未調査。本フェーズはSpot実勢価格の一時点の比較に留まる
- ARM系(Graviton, `c7g`等)は、Wine on ARMのアーキテクチャ的な複雑さ(box64/FEX-Emu等が必要)を理由に本フェーズの対象外とした
