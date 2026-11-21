# フェーズ94: th06ncの倍速録画を`g6f.xlarge`で再現できるかの検証と、NvFBCによるGPUキャプチャ

日付: 2026-11-06(検証は 07:56〜12:47 UTC)

## 結論

1. **`g6f.xlarge`では目標(720p 3倍速・1080p 2倍速)を再現できない。** Lunatic全6面の配信版(`-r 60`変換)の実効fpsは、目標の約58〜59に対し17.6〜31.4。720p 2倍速もExtraで35.8〜39.9で実用水準に届かない。
2. **律速はCPUではなくvGPUの1/8スライスと考えられる(直接の測定はできていない)。** CPU使用率は倍速の全条件で30〜45%。「ゲームのfps + キャプチャのfps」が方式によらず720pで約206〜221、1080pで約167〜173に収まる。`nvidia-smi`の使用率はvGPUでは0%のままで使えない。`g6f.2xlarge`はL4の1/4で、同時比較はしていない。
3. **NvFBC→CUDA→NVENCはvGPU上で動く。** 映像がシステムメモリを通らず、Xorg・ffmpegのCPU負荷は下がる。ただしGPU側の上限は同じなので、キャプチャが増えるとゲームのfpsが下がり、品質は目標に届かない(§4)。
4. **`g6f.xlarge`で実用水準なのは720p等倍のみ**(59.36fps、落ち1.1%、実時間×1.25)。1080p等倍は52.44fps(落ち12.6%)。
5. **オンデマンドでも`g6f.2xlarge`の倍速の方が`g6f.xlarge`の等倍より安い見込み**(§6。**reports/95で修正**: `g6f.2xlarge`の720p 3倍速は50.71fpsで同等品質ではなく、費用も過小だった)。**今回の検証からは`g6f.xlarge`への切り替えを勧めない。**

**重複率では検知できない。** 配信版が17.56fpsの条件でも、パイプラインの重複率は0.2%で試行1回目成功になる。配信版が最大1.44倍に伸びて再生が遅くなる問題もある(§2)。

## ユーザーの視聴結果と判断(2026-11-06)

ユーザーが動画を視聴し、計測どおり倍速はどの録画も実用品質に達しておらず、本番投入は難しいと判断した。1.5倍速は、過去の検証でデグレードが見られたことと費用対効果の薄さから検証を見送る。

## 1. 環境と手順

| 項目 | 値 |
|---|---|
| インスタンス | `g6f.xlarge` オンデマンド、eu-south-2b、`<INSTANCE_ID>`。1台のみ。$0.26719/時。L4-3Q(3072MiB)、VGPU、`Licensed`、AMD EPYC 7R13、4vCPU(2コア2スレッド) |
| 起動の試行(07:56 UTC) | Spot 2a・2b・2c と オンデマンド2a は`InsufficientInstanceCapacity`、**オンデマンド2bで成功** |
| AMI・イメージ | `<AMI_ID>`、`sattori-worker-gpu:latest`(`sha256:5481a697…`)。ルート80GiB |
| リプレイ | `th6_20`(Lunatic全6面、1586秒、score 142962440)、`th6_33`(Extra、334秒、score 52476730) |
| 配信版の変換 | 倍速は`fps`フィルタを除いた`-r 60`(sattori-dev#322の修正相当、reports/92)。等倍は本番のまま |
| 録画 | `scripts/94_run_worker_batch.sh`。`variant`で`/app/recording/ffmpeg.py`を差し替える |

```bash
scripts/94_launch_g6f.sh auto 300 80 <出力先>
# インスタンス上(<label> <replay> <倍率> <解像度> <score> <尺秒> <variant>)
BATCH=x bash ~/verify/94_run_worker_batch.sh base_extra_720p_3x th6_33.rpy 3 720p 52476730 334 base
# 集計(ローカル)
python3 scripts/94_summarize.py <logs> base_extra_720p_3x:334 ...
```

`nvfbc_rec`のビルド(ホスト、Ubuntu 24.04):

```bash
sudo apt-get install -y libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libffmpeg-nvenc-dev
curl -o NvFBC.h https://git.dec05eba.com/gpu-screen-recorder/plain/external/NvFBC.h  # リポジトリには入れていない
gcc -O2 -o nvfbc_rec nvfbc_rec.c -lavformat -lavcodec -lavutil -lswscale -ldl -lpthread
```

variantの`ffmpeg.py`は、イメージの`/app/recording/ffmpeg.py`の末尾へ`scripts/94_nvfbc/ffmpeg_variant_append.py`を連結したもの。`build_video_ffmpeg_cmd`が`nvfbc_rec`を返す。パイプラインの他の部分は変えていない。

## 2. 結果(Lunatic全6面)

全条件で記録スコア一致、同期残差1ms未満。

| 条件 | 試行 | 重複率 | FpsMonitor 中央/下位5%/最低(Hz) | CPU% | 配信版の実効fps(落ち) | 録画 | 変換 | 計(尺比) |
|---|---|---|---|---|---|---|---|---|
| x11grab 720p 等倍 | 1 | 0.0% | 61.6/60.1/59.9 | 32 | **59.36 (1.1%)** | 1590s | 386s | 1976s (×1.25) |
| x11grab 720p 3倍速 | 1 | 3.6% | 153.7/142.5/107.1 | 34 | 19.78 (67.0%) | 681s | 477s | 1159s (×0.73) |
| NvFBC 720p 3倍速 | 1 | 2.4% | 131.1/122.9/80.9 | 34 | 24.65 (58.9%) | 792s | 557s | 1349s (×0.85) |
| x11grab 1080p 等倍 | 1 | 10.0% | 62.3/60.3/59.7 | 53 | 52.44 (12.6%) | 1598s | 387s | 1985s (×1.25) |
| x11grab 1080p 2倍速 | 1 | 0.2% | 125.0/122.1/102.1 | 42 | 17.56 (70.7%) | 853s | 389s | 1242s (×0.78) |
| NvFBC 1080p 2倍速 | 1 | 2.7% | 110.6/104.7/69.3 | 42 | 31.38 (47.7%) | 973s | 444s | 1417s (×0.89) |

比較: reports/92の`g6.2xlarge`は720p 3倍速が58.64fps(×0.42)、1080p 2倍速が59.57fps(×0.67)。`ffmpeg_video.log`の取り込みは180fps・120fps。

変換は`g6.2xlarge`の約2〜5倍かかる(720p 102秒→477秒、1080p 213秒→389秒)。原因がCPUかGPUかは切り分けていない。

### 配信版が長くなる(ゲームが目標fpsを割ると再生が遅くなる)

**実効fpsに加えて、再生速度も遅くなっていた。** 等倍へ戻す倍率は固定なので、ゲームが目標より遅いと配信版がその分だけ長くなる。結論の表を出した時点では見落としていた。比率はFpsMonitorの比とほぼ一致する。

| 条件 | 配信版の尺 | `g6.2xlarge`の尺に対する再生速度 | FpsMonitor中央値の比(対`g6.2xlarge`) |
|---|---|---|---|
| x11grab 720p 3倍速 | 1917s | 0.81倍 | 153.7/186.8=0.82 |
| NvFBC 720p 3倍速 | 2236s | 0.70倍 | 131.1/186.8=0.70 |
| x11grab 1080p 2倍速 | 1557s | 0.99倍 | 125.0/124.4=1.00 |
| NvFBC 1080p 2倍速 | 1773s | 0.87倍 | 110.6/124.4=0.89 |
| 比較: `g6.2xlarge` 720p 3倍速 / 1080p 2倍速 | 1557s / 1547s | - | - |

音声は実時間で録って同じ倍率で戻すので、全体の尺は映像と揃うが、BGMはゲームの遅れと無関係に進むため、BGMとゲーム画面の対応はずれていくと考えられる(未測定)。**スコア一致・重複率・同期残差のどれでも検知されない。** 配信版の尺とリプレイの理論尺の比較なら検知できる。

## 3. 律速の切り分け(Extra)

キャプチャを8fpsまで落としたゲーム単体(variant `nocap`、90秒以上のプレイ区間):

| 条件 | 目標 | ゲーム単体 | x11grab時 | NvFBC時 |
|---|---|---|---|---|
| 720p 3倍速 | 180Hz | 167〜177Hz | 155Hz | 131Hz |
| 720p 2倍速 | 120Hz | 未測定 | 127Hz | 123Hz |
| 1080p 2倍速 | 120Hz | 122〜126Hz | 125Hz | 110Hz |

ゲームとキャプチャのfpsの合計(キャプチャfpsは録画中のログの概数):

| 条件 | x11grab(ゲーム+取り込み) | NvFBC(ゲーム+取り込み) | 必要な合計 |
|---|---|---|---|
| 720p 3倍速 | 155+66=221 | 131+85=216 | 360 |
| 720p 2倍速 | 127+79=206 | 123+85=208 | 240 |
| 1080p 2倍速 | 125+42=167 | 110+63=173 | 240 |

配信版の実効fps(Extra):

| 条件 | x11grab | NvFBC(NV12) | NvFBC(BGRA) | NvFBC(BGRA、タイマー1ms) |
|---|---|---|---|---|
| 720p 3倍速 | 20.22 | 26.71 | 27.14 | 23.94 |
| 720p 2倍速 | 35.77 | 39.93 | - | - |
| 1080p 2倍速 | 20.46 | 26.06 | - | - |

解釈(仮説): CPUが余っているのに合計が頭打ちなので、vGPUの時間割当に応じてGPUへの投入回数の上限があり、ゲームの描画とキャプチャが同じ枠を奪い合っている。x11grab時のXorg(1スレッドで約90%)は、CPU処理ではなくGPU待ちのスピンの可能性がある(未確認)。

**未確認**: `g6f.2xlarge`の同時比較、同じ物理GPUの他テナントの影響、vGPUのスケジューラの設定。

## 4. NvFBC

ドライバ同梱の`libnvidia-fbc.so.1`がそのまま動く。`bIsCapturePossible=1`、コンテナ内も`NVIDIA_DRIVER_CAPABILITIES=all`で可。特別なライセンス手続きは不要だった。

ゲーム無しのベンチ(`scripts/94_nvfbc/bench_in_container.sh`、720p、glxgearsを動かした状態):

| 方式 | 取り込み/秒 | 主なCPU |
|---|---|---|
| x11grab(エンコードなし) | 162 | Xorg 99% |
| x11grab + NVENC(bgr0のまま) | 99 | Xorg 99% |
| x11grab + NVENC(`-pix_fmt yuv420p`、本番) | 83 | Xorg 93%、ffmpeg 44% |
| NvFBC→システムメモリ(push) | 116 | nvfbc 200% |
| NvFBC→CUDA(push) | 164 | Xorg 27% |

`scripts/94_nvfbc/nvfbc_rec.c`(本番の録画ffmpegの置き換え)の要点:

- **経路**: NvFBC ToCUDA(NV12、BT.709)→ `cuMemcpy2D`でhwframeへ(GPU上のコピー)→ `h264_nvenc`(p4、vbr、cq 23、5M/6M、本番と同じ)→ libavformatでmp4。音声は従来どおりpulse+ffmpeg
- **start_time**: ptsをepochマイクロ秒にし、`-copyts`相当の絶対時刻をmp4に残す。同期マーカーの補正がそのまま動き、残差は+0.1〜+0.9ms
- **サイドストリーム**: 終了検知用に8fpsでシステムメモリへ下ろしてJPEG化(別スレッド)。ここだけCPUを使う
- **可変フレームレート**: 新フレームのみエンコードする。`-r 60`の変換で等倍へ戻せる

ハマった点:

- **Bフレームを切る必要がある**(`max_b_frames=0`)。可変フレームレートのptsではNVENCのdtsが`pts < dts`になりmuxが失敗する
- **SIGINT後に`exit`が戻らない**ことがある。ドライバの後始末と思われるため、mp4の完結後に`_exit(0)`する(パイプラインは20秒で`TimeoutExpired`にしてリトライしていた)
- **約10分で`NVFBC_ERR_MUST_RECREATE`(16)が出る。** 720pでframe=49459・49928、1080pでframe=38527と、フレーム数ではなく時間に揃う。セッションだけ作り直せば録画は続く(`recreated=1`)。原因は未特定。セッションの作り直しの前後の映像は確認していない
- **`nvfbc_rec`が落ちると、パイプラインは待ち続ける。** サイドストリームのmtimeが更新されず`poll`がスキップされ続ける。本番へ入れるならプロセスの死活確認が必要
- 色: 録画は`bt709`タグ付き(本番は未指定のBT.601)。1枚の目視では色ずれなし。本番との厳密な色の比較はしていない

**本番への組み込みはしていない。** 効果が目標に届かないため。

## 5. その他の発見

- **`unattended-upgrades`**: `apt-daily-upgrade`がインスタンス起動から約22分(08:19 UTC)に走り、`unattended-upgrades`がdpkgのロックを持っていた。スモークの後なので結果への影響はないが、本番AMIで録画中に走ると4vCPUでは影響しうる(未評価)。以降の検証では止めた
- **メニューの取りこぼし**: `nvfbc_extra_1080p_2x`の試行1で画面静止検知(45秒、重複率51.6%)、試行2で成功。reports/92 §8と同種の可能性あり(発生率は未調査)

## 6. 費用

オンデマンド単価: `g6f.xlarge` $0.26719/時、`g6f.2xlarge` $0.53438/時。尺1時間あたり(起動時間・EBS・転送を除く):

| 構成 | 実時間の尺比 | 費用 | 配信版の実効fps |
|---|---|---|---|
| `g6f.2xlarge` 720p 3倍速 ※ | ×0.42 | **$0.22** | 58.64 |
| `g6f.2xlarge` 720p 2倍速 ※ | ×0.59 | $0.32 | 59.22 |
| `g6f.xlarge` 720p 等倍 | ×1.25 | $0.33 | 59.36 |
| `g6f.2xlarge` 1080p 2倍速 ※ | ×0.67 | $0.36 | 59.57 |
| `g6f.xlarge` 1080p 等倍 | ×1.25 | $0.33 | **52.44** |

※ 尺比・fpsはreports/92の`g6.2xlarge`の実測。`g6f.2xlarge`での3倍速と1080p 2倍速は未検証(同じ8vCPUだがGPUは1/4)。

Spot単価(検証開始時、2a/2b/2c): `g6f.xlarge` 0.0645/0.1115/0.2554、`g6f.2xlarge` 0.0534/0.0998/0.5266。

**検証全体の費用**: インスタンス約5.0時間で約$1.33、転送は配信版約10.6GB+ログで約$1(すべて概算)。

## 7. 残された手段(未検証)

- **ゲームプロセス内のキャプチャ**: Vulkanレイヤーで描画と同じ投入の中で画面をコピーし、NVENCへ渡す。改善の見込みは下記のとおり机上の推定で、コピーの実コストは未測定。DXVKを使うth06nc専用(th15等のwined3dは別の仕組みが要る)
  - 720p 3倍速: **改善しても目標に届かない。** ゲーム単体(FpsMonitor中央値171Hz、`g6.2xlarge`は186.8Hz)で再生速度が約0.92倍になる
  - 720p 2倍速: 最も見込みがある(120Hzはゲーム単体の範囲内)
  - 1080p 2倍速: 可能性はあるが余裕の見積もりが不確か(ゲーム単体で目標に到達、上限は未測定)
  - 投入回数だけで上限が決まるという§3の仮説は単純すぎる可能性がある。合計が解像度で下がる(720p約210、1080p約170)ので、処理時間も効いている
  - 費用の削減は小さい: 1080p 2倍速が全部成立しても、reports/92の見込み(月55件、平均尺985秒)で月約$2.3
- **1.5倍速**: 検証を見送る(ユーザーの判断)
- **NvFBCの1080p等倍**: x11grabの52.44fpsを改善できる可能性がある(2倍速時のNvFBCの取り込みが約63fps)。未測定

## 8. 成果物

`/mnt/cache3/sattori-th06nc-verify/phase94_g6f_xlarge/`(10GB。生映像はインスタンスと共に削除)。

**視聴の優先順:**

1. `delivery/base_lunatic_720p_3x_delivery.mp4`: 本番方式のまま`g6f.xlarge`で720p 3倍速(19.78fps)
2. `delivery/nvfbc_lunatic_720p_3x_delivery.mp4`: NvFBCの720p 3倍速(24.65fps)
3. `delivery/base_lunatic_1080p_2x_delivery.mp4`: 本番方式の1080p 2倍速(17.56fps)
4. `delivery/nvfbc_lunatic_1080p_2x_delivery.mp4`: NvFBCの1080p 2倍速(31.38fps)
5. `delivery/base_lunatic_720p_1x_delivery.mp4`: 720p等倍(59.36fps、唯一の実用水準)
6. `delivery/base_lunatic_1080p_1x_delivery.mp4`: 1080p等倍(52.44fps)

`logs/<label>/`: 全条件のログ、pidstat、cpu・gpu、scripts/81の結果。`logs/failed_nvfbc_lunatic_720p_3x/`: セッション喪失で止まった試行。

インスタンスの終了(`terminated`)、未アタッチのEBSが無いことを確認し、一時キーペア`touhou-recorder-g6f-key`を削除した。残存リソースの増加は無い。

## 変更ファイル

- 新規: `scripts/94_launch_g6f.sh`、`scripts/94_run_worker_batch.sh`、`scripts/94_worker_run.py`、`scripts/94_summarize.py`、`scripts/94_nvfbc/`
- 変更: `AGENTS.md`、`docs/gpu-recording.md`、`docs/titles/th06nc.md`、`docs/known-limitations.md`、`reports/README.md`
