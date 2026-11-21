# フェーズ42: AWSリージョン移行(us-east-1→eu-south-2)の録画品質検証

日付: 2026-07-31

## 目的

コスト等の事情から、AWSインフラをus-east-1からeu-south-2(ミラノ)へ全面移行する案が検討されている。同じ録画環境(`cloud/docker/aws/Dockerfile.multigame` + `scripts/25_record_replay_e2e_multigame.py`)のまま、th06/07/08/11それぞれフル尺(約30分)をeu-south-2で録画し、重複フレーム率がus-east-1実績から悪化しないかを検証した。

## 事前確認

- eu-south-2は本アカウントで既にopt-in済み(`ec2 describe-regions`で`opted-in`確認済み)
- インスタンスタイプ提供状況: `c7i.xlarge`・`c7i.2xlarge`は3AZ(eu-south-2a/b/c)すべてで提供あり。`c6i`系はeu-south-2に存在せず(`c5`・`c7i`のみ)。us-east-1同様`c7i`系列を採用
- Spot価格(実測): `c7i.xlarge` $0.046〜0.048/時間、`c7i.2xlarge` $0.092〜0.094/時間。us-east-1実績(reports/40: 各$0.07〜0.08、$0.15〜0.19)よりむしろ安い
- IAMロール/インスタンスプロファイル(`touhou-recorder-verify-role`/`-profile`)はグローバルリソースのため、フェーズ40で作成済みのものをそのまま流用。ECRリポジトリ・セキュリティグループ・キーペアはリージョンスコープのためeu-south-2に新規作成

## 発見1: `Dockerfile.multigame`が`assets/replay_end_templates/`を含んでいなかった(既存バグ、今回修正)

th06のフル尺録画(`th6_ud1vfq.rpy`)を初回実行したところ、想定34.4分に対し約20.5分(1226.8秒)で録画が終了した。ログを確認すると`WARNING: /app/assets/replay_end_templates/th06.png が見つからないため、画面静止のみでリプレイ終了を判定します`と出ており、フェーズ33で導入したはずのテンプレート画像照合が効いていなかった。

`cloud/docker/aws/Dockerfile.multigame`を確認したところ、`COPY assets/watermark/watermark-60fps.webm ...`はあるが`assets/replay_end_templates/`をコピーする行が存在しなかった(このDockerfileが作られたフェーズ25の時点から一貫して未実装で、フェーズ33でテンプレート機構が追加された際も追随されていなかった)。`th6_ud1vfq.rpy`はフェーズ33で「ステージ4クリア画面での画面静止誤検知」が実際に報告された既知の問題リプレイであり、まさにその誤検知が再現していた。

`th07`・`th08`の初回録画(同じ旧イメージ)は結果的に誤検知を起こさなかった(該当リプレイの内容がたまたま長時間の中間結果画面を含まなかったため)が、これは偶然であり、リージョンの問題ではなくDockerイメージの既存バグである。

**対応**: `Dockerfile.multigame`に`COPY assets/replay_end_templates/ /app/assets/replay_end_templates/`を追加し、イメージを再ビルド・再push(タグ`eu-south-2-test2`)。修正後、th06を同一リプレイで再録画したところ`template_MAD`によるテンプレート照合が機能し、想定通り2054.7秒(34.2分)で正常終了、重複フレーム率0.1%を確認した。

**今後の課題**: この修正はeu-south-2検証用に作成したイメージにのみ適用済みで、us-east-1側の本番/検証ECRイメージには未反映。本番でこのバグの影響を受けている可能性がある(要確認・要追随)。

## 発見2: `th7_ud1mdq.rpy`(ユーザー記録形式のth07リプレイ)がメニュー自動操作と噛み合わない

th07の当初の録画対象として選定した`th7_ud1mdq.rpy`(Lunatic, 33.0分)は、3回試行すべてリプレイ選択一覧画面で停止し(dup_fraction=1.00、約26秒で早期打ち切り)、`ERROR: 3回試行しても正常な録画が得られませんでした`となった。フレーム抽出で目視したところ、メニュー自動操作のキー入力シーケンスは完了しているにもかかわらず画面はリプレイ選択画面のままだった。

過去の検証実績がある命名系統の非「ud」プレフィックスファイル(`th7_07/08/09.rpy`)に類似した`th7_09.rpy`(Hard, 36.3分)に差し替えたところ、同一インスタンス・同一イメージで問題なく完走した(2102.0秒、重複フレーム率0.2%)。

このリプレイは今回のパイプラインで過去に一度も検証されたことがなく(reports内に言及なし)、リージョン固有の問題ではなく当該リプレイファイル自体(またはth07 MODの当該ファイルへの非対応)に起因すると考えられる。th11で確認された「組み込みリプレイタブ/ユーザーリプレイタブ」の区別(フェーズ35)と同様の問題がth07にも存在する可能性があるが、本フェーズのスコープ外として深掘りはしていない。

## 検証結果: 重複フレーム率比較(us-east-1 既存ベースライン vs eu-south-2)

| タイトル | インスタンスタイプ(Spot) | 使用リプレイ | 想定尺 | 実測総録画時間 | 重複フレーム率(全体、パイプライン内蔵計測) | 5区間サンプル平均 | us-east-1 既存ベースライン |
|---|---|---|---|---|---|---|---|
| th06 | `c7i.xlarge` | `th6_ud1vfq.rpy`(Lunatic) | 34.4分 | 2054.7秒(34.2分) | **0.1%** | 2.6% | 0.1%(フェーズ32) |
| th07 | `c7i.xlarge` | `th7_09.rpy`(Hard) | 36.3分 | 2102.0秒(35.0分) | **0.2%** | 1.4% | 0.8〜4.7%(フェーズ17・25) |
| th08(ver1.00d) | `c7i.xlarge` | `th8_06.rpy`(Normal) | 32.8分実績 | 1971.8秒(32.9分) | **0.2%** | 2.1% | 1.0〜8.1%(フェーズ23) |
| th11 | `c7i.2xlarge` | `th11_06.rpy`(Lunatic全ステージ) | 27.5分実績 | 1652.0秒(27.5分) | **4.5%** | 0.4% | 2.9〜6.3%(フェーズ37・40) |

th06/07/08は既存の4vCPU基準(フェーズ27)、th11はフェーズ40で確定した8vCPU/16GiB以上の基準(`.2xlarge`帯)に従ってインスタンスタイプを選定した。

「重複フレーム率(全体)」はパイプライン内蔵の録画開始15秒以降・動画全長に対するmpdecimate計測値(entrypointログの`録画開始15秒以降の重複フレーム率`)。「5区間サンプル平均」は`scripts/measure_duplicate_frame_rate.sh`で各動画を15%/20%/40%/60%/80%地点(各60秒)で独立に再計測した平均値で、AGENTS.mdの「単一60秒サンプルはブレが大きい」という既知の注意点通り、全体値と数%のブレがあるが、いずれも同じ低い水準に収まっている。

**結論: eu-south-2でも、th06/07/08/11のいずれも重複フレーム率はus-east-1の既存ベースラインと同等かそれ以上に良好で、悪化は確認されなかった。** リプレイ尺(総録画時間)も想定通りで、処理落ちによるゲーム内速度低下(フェーズ40で確認されたth11 4vCPU不足時の症状)も見られなかった。

## 目視確認

各動画から1フレームずつ抽出し確認(`runs/eu_south_2_verify/measurements/*.png`)。4タイトルとも、クロップ位置・日本語フォント(スペルカード名、タイトルロゴ含む)・HUD表示に異常なし。th06は59.99fps、th11は60.1fpsといずれも内部fps表示も安定していた。

## 作業内容

1. `touhou-recorder-multigame`イメージを現在のHEAD(フェーズ38/39のth11修正込み)でローカル再ビルド(既存ローカルイメージはフェーズ38/39以前のもので古かったため)
2. eu-south-2に検証用リソースを新規作成: ECRリポジトリ`touhou-recorder-multigame`、セキュリティグループ`touhou-recorder-verify-sg`(SSH全開放)、キーペア`touhou-recorder-verify-key`。IAMロール/プロファイルはグローバルなのでフェーズ40の`touhou-recorder-verify-role`/`-profile`を流用
3. `aws ec2 run-instances`でSpotインスタンスを4台起動(th06/07/08: `c7i.xlarge`、th11: `c7i.2xlarge`、Ubuntu 24.04 AMI、ルートEBS 40GiB)。当初のuser-dataで`apt-get install -y docker.io awscli`が複合失敗する不具合(Ubuntu 24.04には`awscli`パッケージが存在しない)を発見し、`docker.io`と`awscli`(公式zipインストーラ経由)のインストールを分離して修正、再起動
4. 各インスタンスへSSH接続し、`docker run`でscripts/25経由の録画を実行(S3出力先は既存のus-east-1バケット`touhou-recorder-output-<AWS_ACCOUNT_ID>`を流用、動画取得は`scp`でローカル`runs/eu_south_2_verify/`へ)
5. 発見1・2の対応後、th06とth07を再実行
6. 検証完了後、4台のEC2インスタンスはすべて`terminate-instances`済み(`terminated`状態を確認済み)

## 成果物

- `runs/eu_south_2_verify/{th06,th07,th08,th11}/video.mp4` + `record_stdout.log`(gitignore対象、目視確認用にローカル保存)
- `runs/eu_south_2_verify/measurements/`: 20区間の重複フレーム率計測結果(`results.txt`)、4タイトルの目視確認用フレーム(`*_frame.png`)
- 修正済み`cloud/docker/aws/Dockerfile.multigame`(`assets/replay_end_templates/`のCOPY追加)

## 概算コスト

Spotインスタンス4台(th06はリトライ含め約80分、th07はリトライ含め約80分、th08約80分、th11約80分)の合計で1ドル未満(`c7i.xlarge`×3・`c7i.2xlarge`×1、いずれも1.5時間未満)。ECRイメージのeu-south-2への転送・S3クロスリージョンアップロード・scp転送(us-east-1向けegress)を含めても数ドル程度と軽微。

## 今後の課題

- **本フェーズで発見した`Dockerfile.multigame`の`replay_end_templates`欠落バグは、us-east-1側の既存ECR本番/検証イメージにも存在する可能性が高く未確認**。次にus-east-1側のイメージに触れる際は再ビルド・再pushを検討すること
- `th7_ud1mdq.rpy`がth07 MODの自動操作と噛み合わない原因は未調査のまま(リージョン移行検証のスコープ外と判断し保留)。同様の「ud」プレフィックス系th07リプレイを本番で使う予定がある場合は要事前検証
- eu-south-2の検証用リソース(ECRリポジトリ`touhou-recorder-multigame`、セキュリティグループ`touhou-recorder-verify-sg`、キーペア`touhou-recorder-verify-key`)は本レポート作成時点で未削除。ユーザーの指示を待って削除するか、本番移行の判断が出るまで保持するかを決定する
