# 0070. th13は自宅ワーカー→`c7i.4xlarge`の等倍→`.2xlarge`帯の1/2倍速で録り、GPUの段を持たない

- **状態**: 有効
- **決定日**: 2026-11-12
- **対象**: packages/shared / worker
- **関連**: Issue #79、touhou-recorder reports/100、[`0042`](0042-2xlarge-instance-type-group-precedent.md)・
  [`0066`](0066-recording-fallback-plan-as-config.md)、
  [`docs/reports/2026-11-12-th13-recording-verification.md`](../reports/2026-11-12-th13-recording-verification.md)

th13（東方神霊廟）の録画の段は「自宅ワーカー（等倍）→`c7i.4xlarge`（等倍）→`c7i`/`c7a`/`m7i`の`.2xlarge`
（1/2倍速）」の3段にする（`packages/shared/src/recordingPlan.ts`）。**`c7i.4xlarge`の等倍は数値上は品質基準を
満たしていないが、視聴して許容範囲と判断して採用した**。GPUの段は検証できていないので置かない。

## 背景

touhou-recorder reports/100でth13（ver1.00c・非Steam版）をCPU描画（Xvfb+wined3d+llvmpipe）で検証した結果:

| 環境 | Extraの落ち | 通常の落ち |
|---|---|---|
| 自宅ワーカー機（ローカル）等倍 | 0.6% | 0.7% |
| `c7i.2xlarge` 等倍 | 6.3% | 3.0% |
| `c7i.4xlarge` 等倍 | 4.3% | 未実施 |
| `c7i.2xlarge` 1/2倍速 | 落ちなし | 落ちなし |

reports/100の推奨は「`c7i.2xlarge`+1/2倍速」だった。等倍の`c7i.4xlarge`はExtraが基準外（落ち4.3%）。
GPUインスタンスは枯渇していて倍速を検証できていない。

## 決定

- 段は`th13: [home x1, cpu:eu-south-2 x1 c7i.4xlarge, cpu-slow:eu-south-2 x0.5 c7i/c7a/m7i.2xlarge]`。
  CPUの段を2つ持つ最初のタイトルなので、2つ目の段の`id`を`cpu-slow:<region>`にした
  （`cpuStep()`の`idPrefix`。段の`id`はタイトルの中で一意でなければならない、0066）。
- 等倍の`c7i.4xlarge`は**ユーザーが録画を視聴して品質を許容範囲と判断した**ので採用する。
  1/2倍速より録画時間が半分で済み、録り上がりが速い。
- 1/2倍速の段は`c7i.2xlarge`で検証済み。`c7a.2xlarge`・`m7i.2xlarge`は0042のグループとして足した
  （0042が求める理論尺の比較は、reports/100の`c7i.2xlarge`の録画のMODログから行った。
  `docs/reports/2026-11-12-th13-recording-verification.md` §3）。
- **GPUの段は置かない**。`g6f.2xlarge`の在庫が無く倍速を一度も検証できていない。検証できたら段の
  配列の先頭に`gpuSteps()`を足すだけでよい（0066）。
- ワーカーは低速録画でPresentの上限に加えてQPC偽装でも減速する（`record_th13.py`の
  `slow_motion_speed_hack=True`）。reports/100の1/2倍速はこの構成で検証したもので、画面右下のfps表示も
  「60.0fps」のまま正しく出る。

## 根拠

- 自宅ワーカー機の等倍はreports/100とsattoriのコードでの再検証の両方で合格
  （`docs/reports/2026-11-12-th13-recording-verification.md`）。
- `c7i.4xlarge`の等倍はExtraで落ち4.3%、理論尺比+1.8%（reports/100のMODログから算出）。数値基準では
  不合格だが、視聴での判断を優先した。
- `c7i.2xlarge`の1/2倍速は落ちなし・スコア一致・理論尺比+0.2%（Extra）。

## 採らなかった選択肢

- **reports/100の推奨どおり`.2xlarge`の1/2倍速だけ（等倍のEC2の段を持たない）**: 品質は最も良いが、
  録画時間が倍になる。`c7i.4xlarge`の等倍が視聴に耐えると判断したため、先に置いた。
- **`.2xlarge`帯の等倍**: Extraの落ち6.3%で、`.4xlarge`より明確に悪い。
- **GPUの2倍速を先頭に置く**: 未検証。AGENTS.md §3（インスタンスタイプ・録画パイプラインの変更は必ず
  実機検証を経る）。
- **`.4xlarge`帯を`c7a`/`m7i`へ広げる**: 0042のグループ化は`.2xlarge`帯に限る。

## 影響範囲

- `packages/shared/src/recordingPlan.ts`（`TH13_NATIVE_INSTANCE_TYPES`・`TH13_SLOW_MOTION_INSTANCE_TYPES`・
  `RECORDING_PLANS.th13`）と同テスト。
- 自宅ワーカーは段に`home`があるので、既定でth13を引き受ける（`HOME_WORKER_GAME_IDS`）。
- `worker/record_th13.py`（`slow_motion_speed_hack`）、`worker/docs/titles/th13.md`。
