# フェーズ19: ウォーターマーク合成のAWS(c7i.xlarge)レンダリング品質検証

日付: 2026-07-16

## 目的

フェーズ18で実装したウォーターマーク合成(`overlay`フィルタ、`libvpx-vp9`デコーダによるアルファ合成、右下1.5倍サイズ表示)を`scripts/11_record_th07_replay_e2e.py`本体に組み込み、フェーズ17で最良の結果だったAWS EC2 Spot `c7i.xlarge`上で実際にth07リプレイ全編を録画し、フィルタ追加によるCPU負荷増分が重複フレーム率(処理落ちの指標)に悪影響を与えないか検証する。

## 結論(要約)

- **ウォーターマーク合成を追加しても、重複フレーム率はフェーズ17の`c7i.xlarge`ベースラインと実質的に同一だった(全編4.7%、両者とも一致)**。録画時間(851.1秒 vs 850.6秒)・出力ファイルサイズ(646MB vs 648MB)もほぼ同一で、`overlay`+`libvpx-vp9`デコーダの追加によるCPU負荷はレンダリング品質に有意な影響を与えないことを実機で確認した
- タイトル画面・ゲームプレイ中双方で目視確認したところ、ウォーターマークは冒頭6秒間だけ右下に自然に合成され、それ以降は元映像のみに戻ることを確認(フェーズ18のローカル検証と同じ挙動)。スコア・HUD・弾幕・日本語フォントの描画品質にも異常は見られなかった
- 音声(mean_volume -9.3dB)もフェーズ17実測値と一致し、無音化や音量劣化は発生していない

## 検証環境・手順

### コード変更

- `scripts/11_record_th07_replay_e2e.py`: `--watermark`(未指定なら合成なし、後方互換)・`--watermark-width`(デフォルト285px=フェーズ18の1.5倍サイズ)引数を追加。ffmpegコマンドの構築部分にフェーズ18で検証した`libvpx-vp9`デコーダ指定+`overlay`+`eof_action=pass`のfilter_complexを追加
- `assets/watermark/watermark-60fps.webm`: ウォーターマーク素材をリポジトリ内に配置(Dockerビルドコンテキストに含めるため)
- `cloud/docker/aws/Dockerfile`: 上記素材を`/app/assets/watermark/`にCOPYする行を追加
- `cloud/docker/aws/entrypoint.py`: 環境変数`WATERMARK_PATH`・`WATERMARK_WIDTH`(共に空/未設定ならウォーターマークなし)を`scripts/11...`の引数に橋渡しするよう変更
- `cloud/terraform/aws/main.tf`: `watermark_path`・`watermark_width`変数を追加し、EC2 user-dataのdocker run環境変数に配線(ただし本フェーズの実行はフェーズ16・17の教訓に従いAWS CLIから直接`run-instances`した)

ローカル(Xvfb + th07実機)で、`kill -9`ではなく短時間の起動確認によりffmpegコマンド生成(`yuva420p`として正しくアルファ認識されること)を事前確認してからAWSでの本番検証に進んだ。

### AWSインフラの状態(検証開始前)

フェーズ16・17のレポートに「検証終了後、全リソース削除済み」と明記されていた通り、本フェーズ開始時点でtouhou-recorder関連のAWSリソース(S3・CloudFront・IAM・セキュリティグループ・ECR)は実際にすべて存在しない状態だった(`terraform.tfstate`はdata sourceのみでリソース0件、実機確認でも該当リソースなし)。ユーザーの「引き続き検証作業を行う可能性があるためEC2インスタンス以外は残す」という方針に基づき、本フェーズで以下を新規構築した。

- `terraform apply`(`-target`で`aws_instance`を除く10リソースを指定): S3出力バケット・パブリックアクセスブロック・7日ライフサイクル・CloudFront(OAC経由)・S3バケットポリシー・IAMロール/ロールポリシー/インスタンスプロファイル・セキュリティグループ
- `aws ecr create-repository`: ECRリポジトリ`touhou-recorder`
- EC2インスタンス自体は`aws_instance`リソースを使わず、`aws ec2 run-instances`をAWS CLIから直接実行(フェーズ16で判明した「Spotインスタンス作成時にterraform-provider-awsがハングすることがある」問題を踏まえた既存の運用方針を踏襲)

### レンダリング実行

- インスタンス: EC2 Spot `c7i.xlarge`、AZ: `us-east-1a`(`<INSTANCE_ID>`)
- コンテナ: ECRの`touhou-recorder:latest`(ウォーターマーク素材・機能を組み込んでビルドし直したイメージ)
- 環境変数: `REPLAY_FILE=th7_07.rpy`, `WATERMARK_PATH=/app/assets/watermark/watermark-60fps.webm`, `WATERMARK_WIDTH=285`
- インスタンス起動(14:08:18 UTC)からS3への結果アップロード完了(14:23:52 UTC)まで約15分。うちffmpeg録画時間は851.1秒(≒14分11秒)

## 動作検証結果

| 項目 | 今回(ウォーターマーク合成あり) | フェーズ17 `c7i.xlarge`ベースライン(合成なし) |
|---|---|---|
| 録画時間 | 851.1秒 | 850.6秒 |
| 出力ファイルサイズ | 646,340,174 bytes(約646MB) | 648MB |
| 重複フレーム率(全編0-840s) | **4.7%**(50398フレーム中48009ユニーク) | **4.7%**(50399フレーム中48026ユニーク) |
| 映像 | 640x480, 60fps, h264 | 同左 |
| 音声 | AAC 48kHz, mean_volume -9.3dB, max_volume 0.0dB | mean_volume -9.3dB(フェーズ17全体ベースライン値) |
| 終了検知方式 | 画面静止検知(MAD閾値ベース、正常動作) | 同左 |

目視確認(タイトル画面3秒目・ゲームプレイ中400秒目)でも、ウォーターマークの合成(冒頭のみ・フェードアウト後は元映像)・スコア/HUD/弾幕/日本語フォントの描画品質ともに異常なし。

## クリーンアップ状況

- EC2インスタンス(`<INSTANCE_ID>`)は録画完了後、コンテナ内`entrypoint.py`完走後の`shutdown -h now`により**自己終了済み**(`terminated`、`StateReason: Client.InstanceInitiatedShutdown`を確認)。追加の削除操作は行っていない
- **ユーザー指示により、S3バケット・CloudFrontディストリビューション・IAMロール/インスタンスプロファイル・セキュリティグループ・ECRリポジトリは削除せず残置**している(引き続きAWSでの検証作業を行う可能性があるため)。次回検証時は本フェーズで構築したインフラをそのまま再利用できる

## 未検証・今後の課題

- 本検証は`c7i.xlarge`1台のみ。他インスタンスタイプ(`c6i.xlarge`, `z1d.xlarge`, `c6i.2xlarge`)でのウォーターマーク合成影響は未検証(フェーズ17の傾向から見て、`c7i.xlarge`同様の相対的な影響の小ささが期待されるが未確認)
- ウォーターマークのフェード演出(冒頭6秒)以外の表示パターン(常時表示、複数箇所表示等)は本検証の対象外
- 現在AWS上に残置しているリソースは検証用の一時的なものであり、恒久運用する場合はセキュリティグループのingressルール見直し・IAMポリシーの最小権限化等を別途検討する必要がある

## 作成した成果物

- `runs/aws_ec2_c7i_xlarge_watermark/video.mp4`, `record_stdout.log`: 今回のAWS実機録画結果
- `scripts/11_record_th07_replay_e2e.py`: `--watermark`/`--watermark-width`オプション追加(本番パイプライン)
- `assets/watermark/watermark-60fps.webm`: ウォーターマーク素材(リポジトリ内に配置)
- `cloud/docker/aws/Dockerfile`, `cloud/docker/aws/entrypoint.py`, `cloud/terraform/aws/main.tf`: ウォーターマーク合成をAWSパイプラインに配線
