# フェーズ95: `g6f.2xlarge`オンデマンドでth06ncの720p 3倍速・1080p 2倍速を短く実測

日付: 2026-11-06(13:34〜13:52 UTC)

## 結論

- **1080p 2倍速は`g6f.2xlarge`で実用水準に見える**(Extraのプレイ中 59.20fps、落ち1.3%)。`g6.2xlarge`の59.99fpsよりわずかに悪い。
- **720p 3倍速は`g6.2xlarge`と同等ではない。** プレイ中 50.71fps、落ち15.5%(`g6.2xlarge`は59.49fps、0.9%)。ゲーム自体は目標fpsを維持し、再生速度の低下は無い。落ちるのはキャプチャ側。
- **reports/94 §6の「`g6f.2xlarge`の720p 3倍速が最安」は`g6.2xlarge`の品質を前提にしており、そのままでは成り立たない。** 視聴で判断が必要。
- 測定はExtra各1回のみ(334秒)。Lunaticでは未測定。

## 環境と手順

reports/94と同じ(`sattori-worker-gpu`イメージ`sha256:5481a697…`、倍速は`-r 60`変換、variant `base`、リプレイ`th6_33`)。

| 項目 | 値 |
|---|---|
| インスタンス | `g6f.2xlarge` オンデマンド、eu-south-2b、`<INSTANCE_ID>`、NVIDIA L4-6Q(6144MiB)、VGPU、`Licensed`、8vCPU |
| 起動 | オンデマンド2aは`InsufficientInstanceCapacity`、2bで成功 |

```bash
INSTANCE_TYPE=g6f.2xlarge scripts/94_launch_g6f.sh ondemand 90 80 <出力先>
bash ~/verify/94_run_worker_batch.sh f2x_extra_720p_3x th6_33.rpy 3 720p 52476730 334 base \
  f2x_extra_1080p_2x th6_33.rpy 2 1080p 52476730 334 base
python3 scripts/81_analyze_stutter_periodicity.py video_delivery.mp4 --start 15 --duration 300  # プレイ中のみ
```

## 結果

全条件で試行1回目成功、スコア一致、同期残差1ms未満。

| 条件 | 構成 | FpsMonitor 中央/下位5%/最低(Hz) | 重複率 | プレイ中の実効fps(落ち) | 配信版の尺 | 録画 | 変換 | 計(尺比) |
|---|---|---|---|---|---|---|---|---|
| 720p 3倍速 | **`g6f.2xlarge`** | 186.9/184.4/184.4 | 14.2% | **50.71 (15.5%)** | 341.5s | 177s | 44s | 221s (×0.66) |
| 720p 3倍速 | `g6.2xlarge`(reports/92) | 187.7/182.4/182.4 | 0.0% | 59.49 (0.9%) | 340.6s | 156s | 23s | ×0.54 |
| 1080p 2倍速 | **`g6f.2xlarge`** | 124.9/120.9/120.5 | 0.2% | **59.20 (1.3%)** | 339.3s | 226s | 65s | 292s (×0.87) |
| 1080p 2倍速 | `g6.2xlarge`(reports/92) | 124.3/120.7/120.5 | 0.1% | 59.99 (0.0%) | 358.6s | 232s | 50s | ×0.85 |

- 720p 3倍速のプレイ中の落ちは散発的で、平均0.64秒ごとに平均5.9フレーム、最大18フレーム。
- `ffmpeg_video.log`の取り込みは180fps・120fpsだが、中身に同じ絵が混ざる(重複率14.2%)。**ffmpegのfps表示だけでは判定できない。**
- 720p 3倍速ではこの条件に限り重複率で異常が見える。reports/94の`g6f.xlarge`(3.6%)では見えなかったので、指標として信頼はできない。
- 主なCPU(1コア=100%): ffmpeg 85〜128%、Xorg 60〜63%。全体のCPU使用率は29〜35%(8vCPU基準)。

ゲームが目標fpsを保ちつつ取り込みだけ落ちるので、`g6f.xlarge`と同じGPU側の制約の可能性がある。ただしCPU・GPUのどちらが原因かは切り分けていない。

## 費用の修正(オンデマンド、尺1時間あたり、推定)

Lunaticの実測が無いので、`g6.2xlarge`のLunaticの録画時間に、Extraで見えた`g6f.2xlarge`の変換時間の比(720p 約1.9倍、1080p 約1.3倍)を掛けた推定。起動時間・EBS・転送は除く。

| 構成 | 尺比(推定) | 費用 | 品質 |
|---|---|---|---|
| `g6f.2xlarge` 720p 3倍速 | ×0.48 | $0.26 | Extraで50.71fps(視聴で判断) |
| `g6f.xlarge` 720p 等倍 | ×1.25(実測) | $0.33 | 59.36fps |
| `g6f.2xlarge` 720p 2倍速 | ×0.65 | $0.35 | reports/89で落ち0.6%(Easy) |
| `g6f.2xlarge` 1080p 2倍速 | ×0.72 | $0.38 | Extraで59.20fps |
| `g6f.xlarge` 1080p 等倍 | ×1.25(実測) | $0.33 | 52.44fps |

reports/94 §6の$0.22・$0.36は`g6.2xlarge`の尺比を流用したもので、変換が遅い分だけ過小だった。

**検証の費用**: インスタンス約0.3時間で約$0.16、転送約0.9GBで約$0.08(概算)。

## 成果物

`/mnt/cache3/sattori-th06nc-verify/phase95_g6f_2xlarge/`

1. `delivery/f2x_extra_720p_3x_delivery.mp4`: 3倍速を採用できるかの視聴判断用
2. `delivery/f2x_extra_1080p_2x_delivery.mp4`

`logs/<label>/`: ログ一式。インスタンスの終了(`terminated`)、未アタッチのEBSが無いことを確認し、一時キーペアを削除した。残存リソースの増加は無い。

## 未実施・残課題

- Lunaticでの測定(特に1080p 2倍速、高負荷区間の落ち)
- 720p 3倍速の落ちの原因の切り分け(`g6.2xlarge`との差がGPUスライスかどうか)
- 720p 2倍速の`g6f.2xlarge`での再測定(reports/89はEasy、変換は当時のもの)

## 変更ファイル

- 新規: `reports/95_phase95_g6f_2xlarge_ondemand_short_check.md`
- 変更: `scripts/94_launch_g6f.sh`(`INSTANCE_TYPE`)、`AGENTS.md`、`docs/titles/th06nc.md`、`docs/gpu-recording.md`、`reports/README.md`、`reports/94_phase94_g6f_xlarge_and_nvfbc_capture.md`
