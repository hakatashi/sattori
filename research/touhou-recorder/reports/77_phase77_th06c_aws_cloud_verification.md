# フェーズ77: th06cのAWSクラウド実機検証

日付: 2026-09-10

## 位置づけ

AGENTS.mdの新規タイトル対応チェックリスト最終項目「クラウド実機検証」をth06cで実施した。
ユーザー指示により、低速録画・残りのRVA特定(ステージ番号・残機・グレイズ)は今回のスコープ外とし、
クラウド実機検証の完了をもってth06cの録画対応を完了とする。

## 準備

### 軽量Dockerイメージの作成

`cloud/docker/aws/Dockerfile.th128`(フェーズ73)を土台に`cloud/docker/aws/Dockerfile.th06c`を
新規作成した。th06c固有の対応点:

- `mods/common/build/injector.exe`ではなく`injector64.exe`をコピー(th06c.exeがPE32+/x86-64のため)
- `mods/th06c_steam_stub/build/steam_api64.dll`を追加でコピー(`scripts/25`の`extra_files`機構が
  rsync後にこのスタブへ上書きコピーする、reports/74参照)
- `THPRAC`環境変数は設定しない(`GAME_CONFIGS["th06c"]`に`thprac_exe`の指定が無く不要)

ビルドしたイメージは2.36GB(th128の2.4GBと同程度)。ECRリポジトリ`touhou-recorder-th06c`を
eu-south-2に新規作成し、タグ`test`でpush済み。

### AWSリソースの新規作成(eu-south-2)

既存のCLAUDE.local.md記載リソース(IAMロール/インスタンスプロファイル・セキュリティグループ
`<SECURITY_GROUP_ID>`・サブネット`<SUBNET_ID>`・S3バケット
`touhou-recorder-output-<AWS_ACCOUNT_ID>`)を再利用しつつ、以下を新規作成した:

- ECRリポジトリ `touhou-recorder-th06c`
  (`<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th06c`、タグ`test`)
- EC2キーペア `touhou-recorder-th06c-key`(秘密鍵は`/tmp`配下のためセッション終了で失われる想定)

AMIはth10/th12と同様、通常のAmazon Linux 2023(`al2023-ami-2023.12.20260909.0-kernel-6.12-x86_64`)
を使用(ECS最適化AMIは不使用)。ルートボリュームは40GiB gp3。

## 実機検証結果

インスタンス: `<INSTANCE_ID>`(c7i.xlarge、4vCPU、eu-south-2b、スポット)。
th09/th10/th12がxlarge帯(4vCPU)で良好だったことを踏まえ、まずc7i.xlargeから検証した。

### 短時間検証(動作確認)

```bash
docker run --rm -e GAME=th06c -e REPLAY_FILE=th6_01.rpy -e RECORD_SECONDS=40 \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th06c_cloud_test1 \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th06c:test
```

exit_code=0、S3アップロード成功。実ゲームプレイ区間(15〜43秒)の重複フレーム率**0.1%**。

### フル尺録画

```bash
# Hard(通常ステージ)
docker run --rm -e GAME=th06c -e REPLAY_FILE=th6_01.rpy \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th06c_cloud_hard_full \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th06c:test

# Extra
docker run --rm -e GAME=th06c -e REPLAY_FILE=th6_04.rpy \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th06c_cloud_extra_full \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th06c:test
```

| リプレイ | 総録画時間 | 重複フレーム率(開始15秒以降) | 実測プレイ時間 | 理論尺 | 理論尺比 |
|---|---|---|---|---|---|
| `th6_01.rpy`(Hard、93,403フレーム) | 1552.5秒 | **7.2%** | 1540.0秒 | 1556.72秒 | **−1.07%** |
| `th6_04.rpy`(Extra、36,849フレーム) | 626.5秒 | **0.0%** | 614.0秒 | 614.15秒 | **−0.02%** |

実測プレイ時間は「総録画時間 − 録画開始からsequence completeまでの経過秒(両方とも8.0秒) −
テンプレート照合の検知猶予(約4.5秒、reports/76参照)」で算出した。

いずれもexit_code=0で正常終了、S3アップロードも成功した。

### 理論尺比較による処理落ち判定

th06cは**理論尺比較を「超過方向」の検出にのみ使うべき**という制約がある(reports/75参照。
リプレイの`frameCount`合計が実再生時間よりステージ数に比例して系統的に大きい)。
今回もローカル検証(reports/75: Hard −1.16%、Extra −0.19%)とほぼ同水準のマイナス側の差に
収まっており、**理論尺超過は検出されなかった**(=処理落ちの兆候なし)。

Hardの重複フレーム率7.2%はローカル検証(2.7%)より高めで、Extraの重複フレーム率0.0%は逆に
ローカル検証(6.2%)より大幅に改善している。値のブレ自体はth06cの「背景・弾幕が変化し続ける中で
同一内容フレームが連続キャプチャされる」現象の区間依存によるものと考えられる
(reports/67・reports/75で確立した「重複フレーム率と理論尺比較の併用」の原則どおり、
理論尺超過が無いことを優先して判断した)。

念のためHard録画をダウンロードし、t=100/400/700/1000/1300/1500秒の6点をフレーム抽出して
目視確認した。全点で画面右下のfps表示が**60.00fps**、弾幕・スコア表示にも破綻は見られなかった
(`runs/th06c_verification/cloud/frames/`)。

### 結論

**th06cはth09/th10/th12と同じグループ(`.xlarge`帯、4vCPU、`c7i.xlarge`推奨)で十分**と判断した。
th11・th20・th128のような`.2xlarge`帯への引き上げは不要。

## 後片付け(c7i.xlarge検証分)

検証完了後、EC2インスタンス`<INSTANCE_ID>`を`terminate-instances`し、
`describe-instances`で稼働中インスタンスが無いことを確認した。ECRリポジトリ・キーペアは
CLAUDE.local.mdの運用ルールに従い残置(ユーザーからクリーンアップ指示があるまで保持)。

## c7i.2xlargeとの比較検証(ユーザー依頼、視聴比較用)

c7i.xlargeの結果は理論尺比較上「処理落ちなし」と判定できたが、重複フレーム率(特にHardの
7.2%)がローカル検証より高めだったため、ユーザーの依頼により**実際に視聴して比較する目的**で
c7i.2xlargeでもHard/Extra両方のフル尺録画を追加実施した。

インスタンス: `<INSTANCE_ID>`(c7i.2xlarge、8vCPU、eu-south-2b、スポット)。
同一のECRイメージ(`touhou-recorder-th06c:test`)・同一リプレイ(`th6_01.rpy`/`th6_04.rpy`)を使用。

| リプレイ | インスタンスタイプ | 総録画時間 | 重複フレーム率(開始15秒以降) |
|---|---|---|---|
| Hard(`th6_01.rpy`) | c7i.xlarge | 1552.5秒 | 7.2% |
| Hard(`th6_01.rpy`) | **c7i.2xlarge** | 1553.1秒 | **6.5%** |
| Extra(`th6_04.rpy`) | c7i.xlarge | 626.5秒 | 0.0% |
| Extra(`th6_04.rpy`) | **c7i.2xlarge** | 625.0秒 | **0.0%** |

**2xlargeでも重複フレーム率はxlargeとほぼ同水準**(Hard: 7.2%→6.5%、Extra: 0.0%→0.0%)であり、
インスタンスタイプによる明確な改善は見られなかった。これは「Hardの重複フレーム率が
ローカル検証より高めなのはCPU不足による処理落ちではなく、th06c固有の描画パターン(区間依存で
ブレる)によるもの」というxlarge検証時の判断を裏付ける結果であり、**c7i.xlargeで十分という
結論を維持する**。

## 後片付け(c7i.2xlarge比較検証分)

検証完了後、EC2インスタンス`<INSTANCE_ID>`を`terminate-instances`し、
`describe-instances`で稼働中インスタンスが無いことを確認した。

クラウドで録画した動画5本(短時間検証6.5MB・Hardフル尺xlarge 603MB・Extraフル尺xlarge 249MB・
Hardフル尺2xlarge 606MB・Extraフル尺2xlarge 248MB、計約1.7GB)、録画ログ、目視確認用フレーム画像は
すべて`runs/th06c_verification/cloud/`に保存した(`runs/`はgitignore対象)。

## AGENTS.md新規タイトル対応チェックリスト完了

フェーズ74〜77で以下の全項目を完了した(低速録画・ステージ番号等の未特定RVAはユーザー指示により
スコープ外として持ち越し):

1. 設定確認 ✅(フェーズ74)
2. 起動確認 ✅(フェーズ74)
3. MOD開発・動作確認 ✅(フェーズ74、GetProcAddressフック方式)
4. リプレイ録画確認(通常・Extra両方のフル尺) ✅(フェーズ75)
5. 録画品質確認 ✅(フェーズ75・77、クラウドでの理論尺比較含む)
6. 音ズレ確認 ✅(フェーズ75)
7. 低速録画機能 — **未実施(ユーザー指示によりスコープ外)**
8. 内部データ取得機能(score_monitor、スコアのみ) ✅(フェーズ75、記録スコア完全一致)
9. クラウド実機検証 ✅(本フェーズ、推奨インスタンスタイプ`c7i.xlarge`)

## 残課題(変更なし)

* 低速録画(1/2倍速)が未実装。D3D11経路のため`fps_limiter_hook.h`(D3D9専用)・
  `fps_limiter_hook_d3d8.h`のいずれも使えず新規実装が必要
* ステージ番号・残機・グレイズのRVAが未特定(スコアのみ実装済み)。
  ステージ番号が無いため`.chapters.txt`の出力にも未対応

## 変更ファイル

- 新規: `cloud/docker/aws/Dockerfile.th06c`
- 新規: `reports/77_phase77_th06c_aws_cloud_verification.md`(本レポート)
- 変更: `AGENTS.md`(th06cの推奨インスタンスタイプを追記)
- 変更: `CLAUDE.local.md`(eu-south-2の新規AWSリソース記録)
