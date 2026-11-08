# th06ncのCPU描画（BC7展開）1/2倍速を、本番のCPUワーカーイメージでローカル録画する

- **検証日**: 2026-11-08
- **対象**: th06nc（720p）を、CPU用ワーカーイメージ（`worker/Dockerfile`）・BC7展開を移植したMOD・1/2倍速
  （`FPS_LIMIT_TARGET_HZ=30`）で録画する。Extra（`th6_33.rpy`）とLunatic（`th6_06.rpy`）の各1本
- **環境**: 自宅ワーカー機（HakataMatrix、Ryzen 7 5700X）のDocker。`--cpuset-cpus 0-3,8-11`
  （物理4コア+SMTの8スレッド。本番候補の`c7i.2xlarge`の8 vCPUに合わせた）。`sattori-home-worker`は停止中
- **結論**: 2本とも試行1回目で完走し、記録スコアと一致した。配信版の落ちフレームはExtra 0.2%、Lunatic 2.2%。
  `c7i`での品質は未確認なので、本番の段に入れる前に本番E2Eで確かめること

touhou-recorder reports/96・97のBC7展開フック（`mods/common/d3d11_bc7_hook.cpp`）をsattoriのMODへ移植した。
本番のCPUワーカーイメージと録画パイプライン（`record_th06nc.py`→`recording/`）で、th06ncのCPU描画が
動くかを確かめた。reports/97はPoCの`recorder/`経由で、本番のパイプラインは通していない。

## 目的

- 移植したMODで、`D3D11_DECODE_BC7=1`のときだけBC7展開が働くことを確かめる。
- 1/2倍速の減速が、QPC偽装（`SPEED_HACK_MULTIPLIER=0.5`）とメニュー待ち（`TH06NC_TIME_SCALE=2`）を通して
  効くことを確かめる。th06ncはfps_limiterを持たない。
- CPU用イメージに`record_th06nc.py`が入っていること（Dockerfileの COPY 漏れの再発防止）。

## 方法

1. MODを`make -C worker/mods th06nc`でビルドし、S3の`titles/th06nc/assets.tar.gz`（2026-10-03版）を
   `/mnt/cache3/sattori-th06nc-verify/cpu-pr1/assets`へ展開して`th06nc_hook.dll`だけを差し替えた。コンテナは
   rootで動くので、展開したコピーは`sudo chown -R root:root`した（`hakatashi`所有のままだと`wineserver: ... is
   not owned by you`で起動しない。1回目はこれで失敗した）。
2. `docker build -t sattori-worker:verify-th06nc-cpu -f worker/Dockerfile worker`
3. `verify-recording-locally` skill §5の手順で`record_th06nc.py`を直接呼んだ（`GPU_WORKER`なし、
   `FPS_LIMIT_TARGET_HZ=30`、`--cpuset-cpus 0-3,8-11`）。
4. 配信版は本番の`convert.build_convert_cmd()`（ウォーターマークなし、録画ログのカット範囲）で作った。
   落ちフレームはtouhou-recorderの`scripts/81_analyze_stutter_periodicity.py`で、配信版の15秒以降を測った。

## 結果

| リプレイ | 試行 | 最終スコア（MODログ） | 判定重複率（15〜45秒） | 配信版の尺 | 録画の実時間 | 同期マーカー残差 |
| --- | --- | --- | --- | --- | --- | --- |
| `th6_33`（Extra、記録52476730、frameCount 20020=333.7秒） | 1/2 | 52476730（一致） | 60.0% | 337.8秒（+1.2%） | 729.5秒（×2.16） | +0.4ms |
| `th6_06`（Lunatic、記録44139720、frameCount 37022=617.0秒） | 1/2 | 44139720（一致） | 59.4% | 622.4秒（+0.9%） | 1299.1秒（×2.09） | +0.9ms |

- MODログに`InstallSpeedHackHook: ... (multiplier=0.50)`と`D3D11BC7: デバイスをフックしました`が出た。
  `GetDeviceState`の回数（FpsMonitor、5秒窓）の中央値は両方とも30.0Hz（1/2倍速の目安どおり。最低値の3.8〜5.0Hzは
  ロード中）。ただしFpsMonitorは描画落ちを示さない（reports/97 §3）ので、品質は下の配信版で見た。
- 判定重複率の閾値は低速録画の90%（`SLOW_MOTION_MAX_DUPLICATE_RATE`）。1/2倍速の構造的な重複（約50%）を含む。

配信版の落ちフレーム（15秒以降、`scripts/81`の既定のしきい値）:

| リプレイ | 区間 | 落ち | 実効fps |
| --- | --- | --- | --- |
| Extra | 15〜335秒 | 32枚（0.2%） | 59.90 |
| Lunatic | 15〜615秒 | 782枚（2.2%） | 58.70 |

30秒窓（Extra）: 0.0 / 0.5 / 0.5 / 0.1 / 0.0 / 0.0 / 0.3 / 0.1 / 0.1 / 0.2%（15秒から30秒ごと）。
reports/97で`c7i.2xlarge`の描画落ち（25〜36%）が出たパチュリー戦（配信版75〜165秒）でも0.0〜0.5%だった。

60秒窓（Lunatic）: 0.3 / 0.1 / 0.8 / 2.9 / 3.4 / 1.3 / 1.8 / 5.1 / 4.3 / 1.7%（15秒から60秒ごと）。

## 考察・既知の限界

- **CPUはRyzen 7 5700X（Zen 3）で、`c7i`（Sapphire Rapids）ではない**。reports/97の`c7i.2xlarge`では、Extraの
  パチュリー戦で描画が実時間約15Hzへ間引かれた。今回の値から`c7i.2xlarge`の品質は言えない。
- Lunaticの2.2%には、ステージ間の暗転などの演出上の静止が含まれる（GPU等倍の配信版でも1.1〜1.7%は出る、
  reports/96・97）。窓ごとの落ちを目視で切り分けてはいない。
- 各リプレイ1本ずつ。
- GPU描画の経路（`GPU_WORKER=1`）は、このマシンにNVIDIAのGPUが無いので試していない。変更点は`gpu_display`を
  `gpu_worker()`から決めるようにしたことと、`extra_env`・`slow_motion_speed_hack`を足したことだけ。GPUでは
  `extra_env`は空で、低速録画も来ない。本番のGPUジョブで退行が無いことを確かめること。
- 等倍のCPU描画は試していない（reports/97で不採用）。
