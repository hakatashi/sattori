# フェーズ100: th13(東方神霊廟 ver1.00c・非Steam版)の導入とクラウド検証

日付: 2026-11-11

## 0. 結論

- th13(ver1.00c、CDリッピング+公式アップデート済み、`games/th13`)をパイプラインへ追加し、ローカル・AWSでフル尺録画(通常=Hard全クリア、Extra=クリア)を行った。**スコアは全録画でリプレイ記録値と一致**(内部値×10、デシンクなし)。
- **等倍はAWSの`c7i.4xlarge`(16 vCPU)でもExtraが基準外**(落ち4.3%)。**1/2倍速なら`c7i.2xlarge`(8 vCPU)で通常・Extraとも合格**(AGENTS.mdの基準①②④)。推奨は`c7i.2xlarge`+1/2倍速。
- VsyncPatchは使っていない(ローカル・AWSとも60Hzで安定)。視聴確認は未実施(判定は数値のみ。ユーザーが後で視聴する、動画は`/mnt/cache3/sattori-th13-verify/`)。

## 1. 準備

作業前に`sattori-home-worker`が停止(inactive・disabled)で、録画ジョブ・wineが無いことを確認した(作業後も停止のまま)。

- 旧`prefixes/th13-wined3d-gl`(Steam版用)は`prefixes/th13_steam-wined3d-gl-old`へ退避。新規prefix:
  `Xvfb :199 & DISPLAY=:199 bash ../sattori/worker/setup_wineprefix.sh $PWD/prefixes/th13-wined3d-gl games/assets/msgothic.ttc games/assets/msmincho.ttc`(**絶対パス必須**、Xvfbが要る)
- MOD: `mods/th13_replay_autoplay/dllmain.cpp`(th12のMODを基に、DirectInput・Down×3・待機10秒)。ビルド `mods/common/build_mingw.sh th13`
- `recorder/games.py`に`GameConfig(game_id="th13")`: `display=":86"`(:91は使用済み)、`replay_dest_filename="th13_ud0000.rpy"`、`appdata_dir=prefixes/th13-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th13`、`cfg_filename="th13.cfg"`、`still_detect_exclude_rect=(48,220,207,432)`
- スコア監視RVA(thprac_th13.cpp、`ScoreMonitorConfig`): base=0xbe7c0(score)、stage=+0x5c(0x4be81c)、lives=+0x34(0x4be7f4)、graze=+0x10(0x4be7d0)
- th13.exeのインポート: DINPUT8/DSOUND/d3d9。MODログで`GetDeviceState`が60Hzで呼ばれ、PressKeyでメニュー操作が通ることを確認(60秒試験録画 重複0.6%)

リプレイ(`../sattori/packages/replay-parser/dist/cli/index.js games/th13/replay/*.rpy -j`で確認): 通常=`th13_02.rpy`(Reimu Hard 全クリア、score 257269690、103713f=1728.6秒)、Extra=`th13_06.rpy`(Reimu Extra クリア、117168790、45906f=765.1秒)。

## 2. 録画コマンド

```bash
# ローカル(出力は/mnt/cache3)
python3 scripts/25_record_replay_e2e_multigame.py --game th13 --replay th13_02.rpy --output /mnt/cache3/sattori-th13-verify/full_th13_02.mp4 --max-attempts 1
# AWS(c7i、Ubuntu 24.04、<AMI_ID>、eu-south-2、Spot)。構築はscripts/91_setup_cpu_instance.sh
bash scripts/100_run_th13_cloud_batch.sh x1_extra th13_06.rpy x1_normal th13_02.rpy
FPS_LIMIT_TARGET_HZ=30 SPEED_HACK_MULTIPLIER=0.5 bash scripts/100_run_th13_cloud_batch.sh half_extra th13_06.rpy half_normal th13_02.rpy
# 判定(プレイ区間、60秒以降)
python3 scripts/81_analyze_stutter_periodicity.py <動画> --start 60 --duration <秒>
```

転送: `rsync -aR recorder scripts assets games/th13 prefixes/th13-wined3d-gl mods/common/build mods/th13_replay_autoplay/build hakatashi@<ip>:~/touhou-recorder/`。

## 3. 結果

落ちは`scripts/81`(プレイ区間)。1/2倍速の生動画は30Hzのゲームを60fpsで録るため重複が約50%出るのが正常で、**ユニークフレーム/秒が30に近いか**で判定した(配信版への変換は未実施)。

| 環境 | リプレイ | 落ち / ユニークfps | FpsMonitor下位 | 同期残差 | スコア | 判定 |
|---|---|---|---|---|---|---|
| ローカル 等倍 | 通常 | 0.7%(59.56) | – | – | 一致※ | 合格 |
| ローカル 等倍 | Extra | 0.6%(59.59) | – | – | 一致 | 合格 |
| c7i.xlarge 等倍 | Extra | 12.4%(52.5) | 43.0 | – | 一致 | 不合格 |
| c7i.xlarge 等倍 | 通常 | 8.5%(54.9) | – | – | 一致 | 不合格 |
| c7i.2xlarge 等倍 | Extra | 6.3%(56.1) | 52.3 | – | 一致 | 不合格 |
| c7i.2xlarge 等倍 | 通常 | 3.0%(58.2) | – | – | 一致 | 不合格 |
| c7i.4xlarge 等倍 | Extra | 4.3%(57.4) | 54.9 | – | 一致 | 不合格 |
| c7i.4xlarge 1/2倍速 | Extra | 落ちなし(30.11/s) | 29.8 | -0.3ms | 一致 | 合格 |
| c7i.2xlarge 1/2倍速 | Extra | 落ちなし(30.11/s) | 29.6 | -0.1ms | 一致 | 合格 |
| c7i.2xlarge 1/2倍速 | 通常 | 落ちなし(30.07/s) | 29.8 | -0.8ms | 一致 | 合格 |

- 全録画が試行1回目で完走。終了検知は画面静止検知のみで正常(ローカル通常は総録画1760秒)。
- ※通常ステージのスコアは、最初の録画でMODログが上書きされたため再録画(`rerun_th13_02`)の最終値 25726969(×10=257269690)で確認した。
- 1/2倍速の基準②は 30×0.97=29.1Hz。理論尺比③・視聴確認は未実施。
- 費用: Spot単価は$0.05(2xlarge)〜$0.11(4xlarge)/h程度(eu-south-2)。許可上限$0.2/h以下。1/2倍速は録画実時間が約2倍(通常58分、Extra 14分→28分前後)。

## 4. 注意・未了

- **`c7i.xlarge`のSpotが1回中断**(`Server.SpotInstanceTermination`)され成果物を失った。以後は録画1本ごとに回収する運用にした。2aは`c7i.xlarge`の在庫不足(InsufficientInstanceCapacity)もあった。
- 新規インスタンス直後はsshdが遅く、setupが空振りしうる(`ssh ubuntu@ip true`が通るまで待つ)。SSHは時々数分タイムアウトするが復帰する。
- 画面上fps表示の低速補正は未対応(§docs/titles/th13.md)。配信版変換・理論尺比・BGM同期の視聴確認、等倍`c7i.4xlarge`の通常ステージ、GPU描画は未検証。
- 後始末: インスタンスは計4台起動した(`c7i.xlarge`×2、うち1台はSpot中断、`c7i.2xlarge`×1、`c7i.4xlarge`×1)。全て終了済み、一時キーペア`touhou-recorder-p100-key`は削除済み。残存リソース増加なし(`docs/aws-resources.md`変更なし)。
