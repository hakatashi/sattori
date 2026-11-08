# Lambda の環境変数（`config.ts`）

API の Lambda 群がどの環境変数をどこから受け取るか、`commonEnv` を使わず個別に受け取る
Lambda がどれでなぜか、の参照仕様。CDK 側で環境変数を足す・Lambda を足すときに読むこと。
[`apps/api/README.md`](../README.md) §12 から分けた。

すべて `infra/lib/sattori-stack.ts` の `commonEnv`（+ `startJob.ts`/
`admin/getExecution.ts`/`admin/stopJob.ts`/`admin/retryJob.ts`/
`sweepOrphanInstances.ts`/`sweepStalledJobs.ts`専用の`STATE_MACHINE_ARN`、
`admin/authorizer.ts`専用の`ADMIN_TOKEN_PARAMETER_NAME`、
`admin/getLogs.ts`専用の`WORKER_LOG_GROUP`単独指定、
`sweepOrphanInstances.ts`/`sweepStalledJobs.ts`専用の`JOBS_TABLE`単独指定
（前者は`GPU_SLOTS_TABLE`も、Issue #270）、
`admin/getCosts.ts`専用のCloudFront実配信量取得用`CLOUDFRONT_DISTRIBUTION_ID`、
Issue #163、`admin/getLogs.ts`・`sweepOrphanInstances.ts`専用の`GPU_FALLBACK_REGION`
単独指定、Issue #296）から注入される。`loadConfig()`が必須環境変数の存在を検証する（`admin/authorizer.ts`・
`admin/getLogs.ts`・`RecordAnalyticsEventFn`以外の管理API用Lambdaは`commonEnv`を使う）。

`GPU_FALLBACK_REGION`・`GPU_FALLBACK_LAUNCH_TEMPLATE_NAME`・`GPU_FALLBACK_SUBNET_TAG_KEY`・
`GPU_FALLBACK_WORKER_GPU_IMAGE`・`GPU_FALLBACK_OUTPUT_BUCKET`・`GPU_FALLBACK_TITLE_ASSETS_BUCKET`は
GPUの容量不足時フォールバック先（Issue #296・#313）。
`SattoriGpuFallbackStack`とはCloudFormation参照を張らず固定名で受け取る（`infra/README.md`）。
`GPU_FALLBACK_REGION`が無ければフォールバックしない（`config.ec2.gpuFallback`が`null`）。
設定するなら残り5つも必須。

`SES_CONFIGURATION_SET`は`SattoriEdgeStack`が作った`ses.ConfigurationSet`名
（`crossRegionReferences`経由）。`ses.ts`が`SendEmailCommand`へ指定し、
バウンス・苦情・拒否イベントを運用アラート用SNSへ流す（Issue #133 OPS-1、
[`docs/decisions/0025`](../../../docs/decisions/0025-ops-alerts-per-region-sns-topics.md)）。

`STATE_MACHINE_ARN`が`commonEnv`に含まれない理由: ステートマシンが`launchFn`/
`handleFailureFn`を呼び出すため、これらのLambdaの環境変数がステートマシンARNを
参照すると循環依存になる。`StartExecution`/`DescribeExecution`系を呼ぶ`startJob.ts`・
`admin/getExecution.ts`・`admin/stopJob.ts`・`admin/retryJob.ts`・
`sweepOrphanInstances.ts`・`sweepStalledJobs.ts`だけが個別に受け取る。
