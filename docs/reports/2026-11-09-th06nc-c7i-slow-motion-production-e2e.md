# th06ncのCPU描画1/2倍速を、本番の`c7i.2xlarge`で録画する（本番E2E）

- **検証日**: 2026-11-09
- **対象**: th06ncの3段目（`c7i.2xlarge`・CPU描画のBC7展開・1/2倍速、`RECORDING_PLANS.th06nc`）。
  Lunatic（`th6_06.rpy`）とExtra（`th6_33.rpy`）の各1本。PR #333
- **環境**: 本番AWS（eu-south-2）。#330〜#332 のワーカーイメージ・タイトル資産・Lambdaに、#333 のLambdaだけを
  先出ししてデプロイ。公開フロントエンドは`main`ビルドのまま。管理設定`skipGpuSteps`を一時的に有効にして
  GPUの段を飛ばした（検証後に戻した）
- **結論**: 2本とも完走し、記録スコアと一致（`desyncDetected=false`・`timedOut=false`）。配信版の重複フレーム率は
  Lunatic 3.5%・Extra 2.41%。品質は問題ないと判断してマージした

[ローカル検証](2026-11-08-th06nc-cpu-bc7-local-verification.md)で未確認だった`c7i`での品質を、
`verify-recording-in-production` skillの手順で確かめた。

## 方法

1. `main`の`apps/web/dist`をPRの作業ツリーへ差し込み、`pnpm --filter @sattori/shared build`のあと`pnpm run deploy`。
   **`shared`のビルドを忘れると、Lambdaが古い`dist`のまま「no changes」になる**（初回はこれで変更が入らなかった）。
2. `/uploads`→S3 PUT→`/magic-links`でpendingのジョブを作り、`skipGpuSteps=true`にしてから`/jobs/{id}/start`。
   管理設定の更新は`POST /admin/settings`（PUTは404）。
3. 両ジョブが`c7i.2xlarge`で起動したのを確認してから`skipGpuSteps`を戻した。
4. 配信版（720p）をダウンロードし、ffprobeで尺、`ffmpeg -vf mpdecimate`で重複フレーム率を測った。

## 結果

| | Lunatic (`th6_06`) | Extra (`th6_33`) |
| --- | --- | --- |
| 起動した段 | `c7i.2xlarge`（eu-south-2） | 同左 |
| `desyncDetected` / `timedOut` | false / false | false / false |
| 動画の尺（理論尺） | 619.5秒（617.0秒、+0.4%） | 337.4秒（333.7秒、+1.1%） |
| 重複フレーム率（動画全体） | 3.5%（35869 / 37169枚がユニーク） | 2.41%（19754 / 20242枚） |
| ローカル検証（Ryzen）の落ちフレーム | 2.2% | 0.2% |
| touhou-recorder reports/97（`c7i`） | 1.3% | 7.6% |

- 録画の所要時間は、Extraが約13分、Lunaticが約40分（Spot中断の再試行を含む）。
- LunaticはSpot中断（`SpotInterrupted`）で1回再試行した。再試行先も`c7i.2xlarge`で、GPUの段は
  `capacityExhaustedTargets`に記録されたまま飛ばされた。

## 考察・既知の限界

- 重複フレーム率は**動画全体**を`mpdecimate`で数えた値で、ローカル検証と同じ方法だが、reports/97のExtra・Lunatic
  の数字（窓の取り方が異なる）とは直接比較できない。
- Extraはローカル（0.2%）より悪く、reports/97（7.6%）より良い。サンプルは各1本で、`c7i`の個体差・時間帯の
  影響は見ていない。理論尺との差は+1.1%以内で、処理落ちによる大きな尺の伸びはない。
- 動画の映像・音声を目視・試聴では確認していない（ffprobeでは映像・音声の両ストリームがある）。
- Spot中断からの再試行は1回だけ観測した。
