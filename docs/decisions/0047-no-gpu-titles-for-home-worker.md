# 0047. GPU描画必須タイトルは自宅ワーカーへ常にオファーしない

- **状態**: 有効
- **決定日**: 2026-09-12
- **対象**: apps/api / home-worker
- **関連**: Issue #241、`docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`、
  touhou-recorder reports/78

GPU描画必須タイトル（th06nc等、`GPU_RECORDING_GAME_IDS`）は、自宅ワーカー
（GPU非搭載が前提の常駐マシン）へは構造的にオファーしない。`apps/api/src/
workerRouting.ts`の`GAME_ROUTING_POLICIES`で`offerToHomeWorker: false`に固定し、
`home-worker`側の既定`supportedGames`からも除外する多層防御を行う。

## 背景

自宅ワーカー（Issue #49）は既存9タイトルの共通ワーカーイメージをそのまま実行できる
前提で設計されており、GPU非搭載の常駐マシンで動いている。th06ncはGPU（Xorg+NVIDIA
GRIDドライバ）+DXVKによる描画が必須で、GPU無しのXvfb+wined3d+llvmpipeでは720pで
9.1fpsしか出ない（touhou-recorder reports/78 §5）。自宅ワーカーがth06ncのジョブを
claimしてしまうと、録画自体が成立しない。

`apps/api/src/workerRouting.ts`の`GameRoutingPolicy.offerToHomeWorker`は、既に
「自宅マシンでは録画できないタイトルが出てきた場合の逃げ道」として設計時から
用意されていたフィールドであり、th06ncがその最初の実例になる。

## 決定

- `GAME_ROUTING_POLICIES`にth06ncの行を追加し、`offerToHomeWorker: false`を設定
  する。`tryOfferToHomeWorker()`（`apps/api/src/handlers/sfn/launch.ts`）は
  この時点で`selectHomeWorker()`が常に`null`を返すため、オファー自体が構造的に
  発生しない。
- 多層防御として、`home-worker/src/config.ts`の既定`supportedGames`
  （`SUPPORTED_GAME_IDS`全部）から`GPU_RECORDING_GAME_IDS`を除外する。
- `HOME_WORKER_SUPPORTED_GAMES`環境変数でGPU描画必須タイトルを明示的に指定した
  場合は`ConfigError`を投げて起動を拒否する（GPU無し自宅マシンへの誤設定事故を
  防ぐため）。
- `infra/lib/sattori-stack.ts`の`homeWorkerRole`には`workerGpuRepo`のpull権限を
  意図的に付与しない（pull権限すら渡さないことも多層防御の1つ）。

## 根拠

- GPU無し環境での実測fps（720pで9.1fps、60fpsに遠く届かない）: touhou-recorder
  reports/78 §5。
- `offerToHomeWorker`フィールド自体が既存設計で「タイトルごとの自宅ワーカー
  除外」を想定していたこと: `apps/api/src/workerRouting.ts`の
  `GameRoutingPolicy`のコメント。

## 採らなかった選択肢

- **`WORKER_CAPABILITIES`にGPU能力を新設し、`requiredCapabilities`で表現する**:
  低速録画（`slow-motion-recording`）と同じパターンだが、低速録画は「対応
  タイトルかつ能力を宣言したワーカーなら実行可能」という前提がある一方、
  th06ncは「自宅ワーカーでは原理的に実行不可能」なので、能力宣言の仕組みより
  シンプルな`offerToHomeWorker: false`で十分と判断した。将来GPU搭載の自宅
  マシンを追加する構想が具体化した場合は、この判断を見直す必要がある。

## 影響範囲

- `apps/api/src/workerRouting.ts`（`GAME_ROUTING_POLICIES`）。
- `home-worker/src/config.ts`（`supportedGames`の既定値・`parseGames()`の拒否
  ロジック）。
- `infra/lib/sattori-stack.ts`（`homeWorkerRole`のIAM権限）。
- 将来GPU搭載の自宅マシンを追加する場合は、この決定と`GPU_RECORDING_GAME_IDS`の
  扱いを見直すこと。
