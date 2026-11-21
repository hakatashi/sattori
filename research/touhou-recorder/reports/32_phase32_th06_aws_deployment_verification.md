# フェーズ32: th06(紅魔郷)のAWSデプロイ実機検証

日付: 2026-07-23

## 目的

フェーズ30・31でローカル環境(Xvfb)でのth06 E2E録画(重複フレーム率0.1%)を実証した。本フェーズでは、th08で行った一連のAWS検証(`reports/24〜29`)と同様の方法論で、th06をAWS EC2上のDockerコンテナで実際に録画し、クラウド環境固有の問題(重複フレーム率悪化・文字化け・音ズレ等)が無いかを確認した。

## 事前準備

### 1. WINEPREFIXへのMSゴシックフォント適用(フェーズ13・29と同じ対応)

`prefixes/th06-wined3d-gl`には、th07/th08で既に適用済みのMS Gothicフォント配置・レジストリ登録(フェーズ13・29参照)が未実施だった。Dockerイメージにはprefixの実体がそのまま焼き込まれるため、検証前に同じ対応を行った:

1. `games/assets/msgothic.ttc`を`prefixes/th06-wined3d-gl/drive_c/windows/Fonts/msgothic.ttc`に配置
2. `wine reg add`で`HKLM\...\Fonts`に`"MS Gothic/MS PGothic/MS UI Gothic (TrueType)"="msgothic.ttc"`、`HKLM\...\FontSubstitutes`に`"ＭＳ ゴシック"→"MS Gothic"`・`"ＭＳ Ｐゴシック"→"MS PGothic"`を登録(`LANG=ja_JP.UTF-8`指定で正しくUTF-8のキー名として登録されることを確認)

### 2. `cloud/docker/aws/Dockerfile.multigame`へのth06追加

既存のth07/th08両対応イメージに、`games/th06/`・`prefixes/th06-wined3d-gl/`・`mods/th06_replay_autoplay/build/th06_hook.dll`のCOPYを追加した。`mods/common/build/injector.exe`はフェーズ31で複数DLL注入に対応済みのビルドをそのまま使う。`entrypoint_multigame.py`は`GAME`環境変数を`scripts/25`にそのまま渡す設計のため、コード変更は不要だった。

## 発見: Dockerコンテナ特有の2つの新規問題

ローカルでのDocker動作確認(`docker run`)で、th07/th08では顕在化していなかった(または場当たり的に回避されていた)問題を2つ発見し、Dockerfile自体に恒久対応を組み込んだ。

### 問題1: PulseAudioはroot(uid 0)での起動を拒否する

コンテナはデフォルトでrootユーザーとして動作するが、`pulseaudio -D ...`は`This program is not intended to be run as root (unless --system is specified)`で即座に失敗する。`reports/26`に「uid 1000固定で条件を比較した」という記載があり、過去の検証でもこの問題を認識し都度`docker run --user`等で回避していたと見られるが、Dockerfile自体には反映されていなかった。

### 問題2: wineserverはWINEPREFIXの所有者と実行uidの不一致を拒否する

`docker run --user 1000:1000`で問題1を回避すると、今度は`wineserver: /app/prefixes/th06-wined3d-gl is not owned by you`で失敗する。`COPY`はビルド時rootの所有になるため、単に実行時uidを変えるだけでは不十分だった。

### 対応

`Dockerfile.multigame`の最後に以下を追加し、**イメージのデフォルト実行ユーザーを固定**した(`docker run`側で`--user`指定が不要になる):

```dockerfile
# ubuntu:24.04には既定でuid 1000の"ubuntu"ユーザーが存在するためそれを流用する。
RUN chown -R ubuntu:ubuntu /app
USER ubuntu
```

(`useradd -u 1000`で新規ユーザーを作ろうとしたところ`ubuntu:24.04`ベースイメージに既にuid 1000の`ubuntu`ユーザーが存在し衝突したため、既存ユーザーを流用する方式にした。)

この修正はth07・th08にも同様に影響する内容だが、今回はth06検証の一環として発見・修正したものであり、th07/th08側の本番運用(既存のECRイメージ)への影響有無は別途確認が必要(後述の今後の課題)。

## ローカルDocker検証結果

修正後のイメージで`th6_02.rpy`(Normalステージ)を録画し、自然終了(画面静止検知)まで実行した。

| 項目 | 結果 |
|---|---|
| 総録画時間 | 1504.3秒(約25分) |
| 検知方式 | 画面静止検知(正常) |
| 重複フレーム率(15秒以降) | **0.1%** |
| 文字化け | タイトル画面・リプレイ選択画面(「灑洒なるリプレイを見よう!」等)・ゲーム内ロゴいずれも正しく表示、文字化けなし |

ローカルホスト直接実行(フェーズ30・31)と同水準の結果であり、Dockerイメージ化による劣化は見られなかった。

## AWS実機検証結果

### 環境構築

フェーズ27の方法論を踏襲し、`aws ec2 run-instances`(Spot、`c7i.xlarge`、us-east-1)で直接構築した。前回検証時にユーザー確認の上で全リソースを削除済みだったため、キーペア・セキュリティグループ・IAMロール/インスタンスプロファイル・ECRリポジトリを`touhou-recorder-verify-*`の命名で作り直した。AMIはUbuntu 24.04(フェーズ27で判明したAmazon Linux 2023のルートボリューム2GB問題を避けるため。念のためルートEBSは40GiBに拡張)。今回は本番運用のS3アップロード検証は目的外のため、IAMロールにはECR読み取り権限のみ付与し、S3バケットは作成しなかった(`entrypoint.py`のS3アップロードは失敗するが、録画自体・動画ファイルの生成には影響しない)。

### クイック検証(`--record-seconds 90`)

| 項目 | 結果 |
|---|---|
| インスタンス | `c7i.xlarge`(Spot、us-east-1d) |
| 総録画 | 98.2秒 |
| 重複フレーム率(15〜93秒) | **0.1%** |
| A/V同期補正 | 24ms(自動補正、フェーズ28の仕組みが正常に機能) |

### フル尺録画(`th6_03.rpy`、Extraステージ、自然終了検知)

| 項目 | 結果 |
|---|---|
| 総録画時間 | 395.4秒(約6.6分) |
| 検知方式 | 画面静止検知(正常) |
| 重複フレーム率(15秒以降) | **0.1%** |
| 映像 | 640x480, 60fps。Extraボス(パチュリー)のスペルカード「火水木金土符『賢者の石』」の高密度弾幕でも安定 |

`reports/assets/th06_aws_c7i_xlarge_frame.png`に該当フレームを配置。`runs/th06_aws_c7i_xlarge_full/video.mp4`にフル尺動画を配置(gitignore対象)。

## 考察: th08の初回AWS検証(フェーズ24)との対比

th08はAWS初回検証(フェーズ24)で重複フレーム率90%超という致命的な結果になり、フェーズ25〜29で真因(音声同時取り込みによるA/V同期の律速、音ズレ、フォント欠落)を1つずつ特定・修正する必要があった。一方**th06は今回のAWS初回検証で重複フレーム率0.1%という良好な結果を最初から得られた**。これは、th06検証の開始時点で`scripts/25`が既にth08で得られた教訓(映像・音声別プロセス録画、A/V同期補正、MSゴシックフォント適用)を標準装備していたため、th08が経験したのと同じ問題を未然に回避できたためと考えられる。

## クリーンアップ

検証終了後、本フェーズで作成した全AWSリソースを削除済み。

- EC2インスタンス(`c7i.xlarge`、Spot): `terminate-instances`で終了・`terminated`状態を確認済み
- キーペア(`touhou-recorder-verify-key`)・セキュリティグループ(`touhou-recorder-verify-sg`)・IAMロール/インスタンスプロファイル(`touhou-recorder-verify-role`/`-profile`)・ECRリポジトリ(`touhou-recorder-multigame`): いずれも削除済み、削除後に存在しないことを確認済み
- ローカルDockerイメージ(`touhou-recorder-multigame:th06-local`および同ECRタグ): 削除済み
- 概算コスト: `c7i.xlarge`Spot(約$0.07/時間)を約1.5時間使用、$0.15未満

## 今後の課題

- 本フェーズで発見した「PulseAudioのroot起動拒否」「wineserverのWINEPREFIX所有者不一致拒否」への対応(`chown`+`USER ubuntu`)は、th07/th08の本番ECRイメージにはまだ反映されていない可能性がある(本番がどのユーザーで実行されているか未確認)。次回th07/th08の本番デプロイに触れる際は、現在のECRイメージが同じuid/権限問題を抱えていないか確認すること
- S3アップロード・CloudFront配信を含めた本番相当のフルパイプライン(entrypoint.pyの正常完走)はテストしていない(今回は録画品質の検証が主目的のため意図的に省略)。本番投入時にはS3バケット権限を含めた確認が必要
- 複数リプレイ・複数回試行での成功率測定は未実施(th06は今回の2回の試行(クイック・フル尺)いずれも一発で成功しており、th08で見られたfps暴走・処理落ちの兆候は無いが、統計的な確認はできていない)
