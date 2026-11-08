# 0067. th06ncの最終段をg6.2xlargeからCPU描画（BC7展開）の1/2倍速に替え、1080pを廃止する

- **状態**: 有効
- **決定日**: 2026-11-09
- **対象**: packages/shared / worker / apps/web
- **関連**: Issue #317、#316、[`0064`](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)・
  [`0066`](0066-recording-fallback-plan-as-config.md)・[`0047`](0047-no-gpu-titles-for-home-worker.md)、
  touhou-recorder reports/92・96・97、
  [`2026-11-08-th06nc-cpu-bc7-local-verification.md`](../reports/2026-11-08-th06nc-cpu-bc7-local-verification.md)

th06ncの段を`g6f.2xlarge`（eu-south-2→eu-north-1、2倍速）→**`c7i.2xlarge`（eu-south-2、CPU描画の1/2倍速）**にする。
0064の最終段`g6.2xlarge`（`gpu-full:eu-south-2`）は外した。CPU描画はMODがBC7テクスチャをロード時に展開して成り立つ。
**th06ncの1080p録画は当面廃止する**（UI・APIから消す。ワーカーの1080pのコードは残す）。Extraも同じ段で録り、高密度弾幕の
描画落ちは既知の制約として受け入れる（ユーザー判断）。

## 背景

th06ncはGPU以外の段を持たず、`g6f`が尽きると単価が3.5〜7倍の`g6.2xlarge`（約$0.28〜0.56/尺1時間）に頼っていた。その
`g6.2xlarge`も本番のLambdaからは一度も起動できていない（`2026-11-05-cpu-slow-motion-production-e2e.md`）。th06ncは
GPU必須タイトルで最も件数が多い（月54〜55件、Issue #316）。

## 決定

- **段**: `RECORDING_PLANS.th06nc`（`packages/shared/src/recordingPlan.ts`）の3段目を
  `cpu:eu-south-2`・`TH06NC_CPU_INSTANCE_TYPES`（`c7i.2xlarge`のみ）・速度1/2にした。配列の変更だけで、起動側の
  コードは変えていない（0066）。
- **自宅ワーカーへはオファーしない**（0047のまま）。CPU描画を自宅の環境で本番相当に検証していないため。
- **ワーカー**: `record_th06nc.py`は`GPU_WORKER`が無ければXvfb+wined3d+llvmpipeで描画し、`D3D11_DECODE_BC7=1`・
  `WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b"`・`LP_NUM_THREADS`を渡す。低速録画もQPC偽装で減速する
  （`GameConfig.slow_motion_speed_hack`）。詳細は`worker/docs/titles/th06nc.md`。
- **1080p**: UIのチェックボックスを消し、`POST /magic-links`は`th06ncHighResolution`を常に false にする。
  `TH06NC_RESOLUTION`も渡さない。

## 根拠

touhou-recorder reports/97（eu-south-2の`c7i`スポット、本番の変換）:

| 構成 | Lunatic全6面 | Extra | 尺1時間の費用 |
| --- | --- | --- | --- |
| 720p 1/2倍速 `c7i.2xlarge` | 落ち1.3%（同区間59.01fps、GPU等倍59.00fps） | 7.6%（パチュリー戦で描画が約15Hzへ間引かれる） | 約$0.09 |
| 720p 1/2倍速 `c7i.4xlarge` | 4.1% | 0.7% | 約$0.17 |
| 720p 等倍 `c7i.4xlarge` | 7.0% | 6.8% | 約$0.10 |
| 720p 1/2倍速 `c7i.xlarge` | 11.2%（ゲーム進行も遅れる） | 10.0% | 約$0.12 |
| 1080p 1/2倍速 `c7i.4xlarge` | 2.5% | 1.4% | 約$0.19 |

- `c7i.2xlarge`の1/2倍速は通常ステージでGPU等倍と区別できず、`g6.2xlarge`（約$0.28〜0.56）より安い。
- 本番の録画パイプライン（CPUワーカーイメージ）でもExtra・Lunaticが完走し、スコアが一致した（上記ローカル検証。
  CPUはRyzen 7 5700Xで、`c7i`ではない）。

## 採らなかった選択肢

- **Extraだけ`c7i.4xlarge`**（`speedByDifficulty`の要領で段の中身を差し替える）: Extraの落ちは0.7%になるが、ユーザー
  判断で全難易度`c7i.2xlarge`にした。描画落ちが問題になれば、段の配列の変更だけで足せる。
- **`g6.2xlarge`の段をCPUの段の前に残す**: 単価が高く、本番では起動できた実績も無い。
- **1080pをCPUの段で録る**（`c7i.4xlarge`の1/2倍速、約$0.19）: 段がタイトルだけでなく解像度でも分かれ、段の配列が
  単純でなくなる。利用は少なく、当面は廃止とした。

## 影響範囲

- `packages/shared/src/recordingPlan.ts`（段・候補）、`cost.ts`（`gpuFull`帯は旧レコードの推定にだけ使う）
- `worker/record_th06nc.py`・`worker/recording/config.py`・`worker/mods/`（BC7展開）
- `docs/known-limitations.md`（Extraの描画落ち、FpsMonitorが描画落ちを示さないこと）
- 段を変えたら本番E2Eで確かめること（AGENTS.md §3）。
