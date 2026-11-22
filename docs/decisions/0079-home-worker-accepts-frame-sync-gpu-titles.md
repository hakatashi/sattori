# 0079. GPUの段を持つタイトルでも、フレーム同期の段なら自宅ワーカーへオファーする（0047を置き換える）

- **状態**: 有効
- **決定日**: 2026-11-22
- **対象**: packages/shared / home-worker / docs
- **関連**: Issue #390、Epic #399、[`0047`](0047-no-gpu-titles-for-home-worker.md)（置き換え）・
  [`0078`](0078-frame-sync-plan-and-instance-type-verification-policy.md)・[`0077`](0077-worker-frame-sync-recording-path.md)・
  [`0066`](0066-recording-fallback-plan-as-config.md)

自宅ワーカーへオファーするかは**録画の段（`kind: "home"`の段を持つか）だけが決める**。「GPU描画が必要なタイトルは
自宅へ出さない」という規則は廃止する。th15（かつては低速録画でも自宅へ出さなかった）に、フレーム同期の自宅の段を置いた。

## 背景

`0047`は、th06ncがGPU描画必須で、GPU非搭載の自宅マシンでは録画が成立しない（720pで9.1fps）ことから、GPU描画が要る
タイトルを自宅へ出さないと決めた。その後、フレーム同期（`0077`）は実時間に縛られず、負荷が高くても速度が落ちるだけで
品質は変わらない。th15は自宅マシンのCPU描画（Xvfb+wined3d+llvmpipe）でも、フレーム同期なら0.59倍速で
フル尺を完走し、三者照合・スコア・視聴を満たした（`docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md`）。
「GPUが要るから自宅で録れない」は実時間方式の制約で、フレーム同期には当てはまらない。

## 決定

- `packages/shared/src/recordingPlan.ts`の段に自宅の段（`kind: "home"`）を置いたタイトルだけが、自宅へオファーされる
  （`HOME_WORKER_GAME_IDS`は段から導く）。**「GPU必須だから」という個別の禁止は持たない**。
  th06nc・th20は、まだ自宅の段が無いのでオファーされない（それぞれの計画の切り替え時に判断する）。
- `home-worker/src/config.ts`の多層防御は、「`HOME_WORKER_SUPPORTED_GAMES`で、段に自宅が無いタイトルを明示指定したら
  起動時に落とす」ままにする（理由の記述だけ、GPU必須から「段に無い」へ直した）。
- 自宅ワーカーの並列度は2のまま（Epic #399の判断）。

## 採らなかった選択肢

- **GPU必須タイトルの除外を残し、th15は自宅へ出さない**: 自宅の遊休CPUで録れ、EC2のコストが減るのに使えなくなる。
  フレーム同期なら品質が落ちないことは実測した。
- **タイトルごとに自宅の許可リストを`home-worker`へ持たせる**: 段の配列が唯一の出典という方針（`0066`）に反する。

## 影響範囲

- `home-worker/src/config.ts`の`parseGames()`、`home-worker/README.md`、`docs/known-limitations.md`§4。
- 自宅マシンの速度は`estimatedRealtimeFactor`（home段）に反映してある。2並列・自宅マシンの冷却状態で変わる。
