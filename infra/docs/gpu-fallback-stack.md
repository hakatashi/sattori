# `SattoriStack` と `SattoriGpuFallbackStack` の受け渡し

本体スタックと GPU フォールバック先スタック（eu-north-1）の間で、CloudFormation の参照を
張らずに固定名で受け渡しているリソースの一覧と、デプロイ順序の制約。どちらかのスタックで
固定名のリソースを変えるときに読むこと。[`infra/README.md`](../README.md) 冒頭から分けた。

**`SattoriStack`と`SattoriGpuFallbackStack`の間にはCloudFormationの参照を張っていない**。
本体はフォールバック先のLaunch Template・サブネットを、フォールバック先は本体の
インスタンスプロファイルを必要とし、参照を張ると循環するため。代わりに固定名
（`lib/gpu-fallback.ts`）で受け渡す:

| 固定名 | 作るスタック | 使う側 |
| --- | --- | --- |
| Launch Template `sattori-gpu-worker` | フォールバック | Launch Lambda（`GPU_FALLBACK_LAUNCH_TEMPLATE_NAME`） |
| サブネットのタグ `sattori:gpuWorkerSubnet` | フォールバック | Launch Lambda（`DescribeSubnets`で実行時に引く） |
| インスタンスプロファイル `sattori-gpu-worker-remote` | 本体（既存の`WorkerRole`に追加） | フォールバックのLaunch Template |
| ECRリポジトリ `sattori-worker-gpu` | 両方（本体が原本、フォールバックが受け皿） | 本体のレジストリ複製設定・UserData |
| S3バケット `sattori-output-<account>-eu-north-1` | フォールバック | 本体のMediaCdn（`/eu-north-1/*`のオリジン）・`WorkerRole`・Lambda（`GPU_FALLBACK_OUTPUT_BUCKET`） |
| S3バケット `sattori-title-assets-<account>-eu-north-1` | フォールバック | 本体のTitleAssetsBucketのレプリケーション先・`WorkerRole`・Lambda（`GPU_FALLBACK_TITLE_ASSETS_BUCKET`） |

**フォールバックを本体より先にデプロイすること**（`bin/sattori.ts`で`addDependency`済み）。
本体のECRレジストリ複製設定が先に有効になると、次のpushでECRが受け皿のリポジトリを
ライフサイクル無しで自動作成し、フォールバックスタックのリポジトリ作成と衝突する。
Launch Templateは作成時にインスタンスプロファイルの存在を検証しないため、
フォールバックが先でも作成は通る。S3レプリケーションの宛先・MediaCdnのオリジン（OAC許可は
フォールバック側のバケットポリシー）も、フォールバック側のバケットが先に在る前提。
