# AWS GPU環境構築・録画運用手順

th06ncやth15など、GPUアクセラレーションを必要とするタイトルのAWS環境構築手順および運用上の注意点をまとめます。

## 推奨インスタンス

- **ファミリー**: `g6f.xlarge` (4 vCPU / 16 GiB / NVIDIA L4の1/8スライス) または `g6f.2xlarge` (8 vCPU)
  - `describe-instance-type-offerings` のフィルタでは `Values=g6f.*` を明示指定（`g6.*` だとマッチしません）。
  - eu-south-2 では AZ a または b を選択（AZ cは価格が高いため避ける）。

- **`g6f.xlarge`の倍速は不可(reports/94)**: 2xlargeとの差はCPUだけでなく、GPUも1/8スライスと半分になる。th06ncで720p 3倍速・1080p 2倍速とも実効17.6〜31.4fps。実用は720p等倍のみ(1080p等倍は52fps)。パイプラインの重複率では検知されない。
- **フォールバック**: `g6.2xlarge`(L4フル、8 vCPU / 32 GiB、Pass-Through)は本番AMI(GRIDドライバ)がそのまま動く。品質は`g6f.2xlarge`と同等で単価が高いので、フォールバック専用(reports/92)。在庫は変動し、同日に`InsufficientInstanceCapacity`も出る。

## GPUインスタンス環境構築手順

1. **ベースAMIの起動**:
   - `Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)` を使用。
   - ルートボリュームは100GB以上を割り当てる。
2. **標準ドライバの削除**:
   - 付属ドライバではvGPUが動作しないため削除します：
     ```bash
     sudo apt-get remove --allow-change-held-packages -y nvidia-* libnvidia-*
     sudo dkms remove -m nvidia -v <VERSION> --all
     ```
3. **AWS配布GRIDドライバの導入**:
   - S3配布のドライバアーカイブを取得して導入：
     ```bash
     aws s3 cp --no-sign-request s3://ec2-linux-nvidia-drivers/latest/NVIDIA-Linux-x86_64-<VERSION>-grid-aws.run .
     sudo sh ./NVIDIA-Linux-x86_64-*-grid-aws.run --silent --dkms --compat32-libdir=/usr/lib/i386-linux-gnu
     ```
   - **既知の癖**: `--compat32-libdir=/usr/lib/i386-linux-gnu` 指定時に `/usr/usr/lib/i386-linux-gnu/` へ誤配置される現象があるため、以下で修正：
     ```bash
     sudo cp -a /usr/usr/lib/i386-linux-gnu/* /usr/lib/i386-linux-gnu/ && sudo ldconfig
     ```
   - **ドライババージョンの互換性**: リージョンや物理ホストにより最新ドライバが動作しない場合があります（`dmesg` に `Guest driver is incompatible with host driver` が出る等）。その場合は `s3://ec2-linux-nvidia-drivers/grid-19.x/` などの前バージョンを試します。
4. **Xorg + NVIDIA 画面の構築**:
   - `scripts/78_start_gpu_display.sh --backend xorg` を実行。
   - vGPU環境では `Option "UseDisplayDevice" "none"` は使用不可。`AllowEmptyInitialConfiguration` を有効化します。
   - `nvidia-xconfig --query-gpu-info` が失敗する場合は、`nvidia-smi --query-gpu=pci.bus_id` から10進数BusID（`PCI:X:Y:Z`）を算出するフォールバックがスクリプト内に組み込まれています。
   - **CRTCモード指定**: Xorg+NVIDIA環境ではCRTCモードが既定で1024x768になるため、`--crtc-mode 1280x960` や `--crtc-mode 1920x1080` を明示指定します。
5. **ホストへ直接導入する場合の追加パッケージ**(reports/87):
   - `--no-install-recommends` でwineを入れると32bitの `libGL.so.1`(libglvnd i386)が入らず、th15が「Direct3D オブジェクトは何故か作成出来なかった」ダイアログで停止する。`libgl1:i386 libglx0:i386 libglvnd0:i386 libegl1:i386` を明示導入する。
   - CRTCモード設定には `xrandr`(`x11-xserver-utils`)が必須(無いと警告のみでスキップされ1024x768のまま録画される)。
   - WINEPREFIXのユーザー名(`hakatashi`)に合わせたユーザーで実行し、SSH切断で `/run/user/<uid>` が消えないよう `sudo loginctl enable-linger <user>` を設定する。
6. **PulseAudioの起動**:
   - SSHセッション切断で死なないよう、必ずセッションから切り離して起動：
     ```bash
     setsid nohup pulseaudio --exit-idle-time=-1 >/dev/null 2>&1 &
     ```

## 運用上の重要注意点

### G系クォータの共有と本番影響防止
- **eu-south-2のG系（g6f等）インスタンスクォータは本番ジョブと共有される限られた資源**です（クォータ8 vCPU）。
- 検証用にG系インスタンスを起動する際は、本番環境のGPUワークロードを阻害しないよう長時間の占有を避け、検証完了後は即座にterminateしてください。
- 必要に応じて、別枠のクォータを持つ `us-west-2` などへの切り替えを検討します。

### GPU描画面でのウィンドウ再配置対策
Xorg+NVIDIA環境では、`xdotool windowmove 0 0` 実行後にopenboxの初期配置座標へ戻ってしまう現象が確認されています。録画パイプライン（`recorder/window.py` の `recheck_origin_before_recording()`）では、`gpu_display` 指定タイトルにおいて録画開始直前に原点座標の再確認・再移動を行う防御処理が実装されています。

### 1枚のvGPUで複数のGPU描画面(Xorg)を同時に立てない(reports/89)
タイトルごとに表示番号が違うため、続けて別タイトルを録画すると2つ目のXorgが立つ。**VTを最後に取ったXorgしか描画が進まず、先に起動していた画面のゲームはFpsMonitor 0Hzで固まる**。`scripts/89_run_speedup_batch.sh`のように、録画ごとに既存のGPU描画面を`scripts/78_start_gpu_display.sh --display :NN --stop`で止めてから始める。

### 既存タイトルをGPU描画面で録画する(`--gpu-display`)
`scripts/25`の`--gpu-display`で`GameConfig.gpu_display=False`のタイトルもGPU描画面で録画できる。この場合`poll_side_stream`は自動で有効になる(無いと終了検知ポーリングで周期2秒強のカクつきが出る)。

### ゲームがウィンドウ位置を戻すタイトル(th08)は`--capture-window-id`
th08はGPU描画面で、録画開始後にゲーム自身がウィンドウをクライアント(3,29)へ設定し直し、以後の映像がずれて終了検知できなくなる。`--capture-window-id`でx11grabをウィンドウID基準で取り込むこと。openboxで装飾を消す・(0,0)固定にする設定は、Wineがクライアント領域をX窓の内側へずらすため逆効果だった。

### NvFBC(GPUキャプチャ、実験、reports/94)
`g6f`のvGPUでNvFBC→CUDA→NVENC(`scripts/94_nvfbc/nvfbc_rec.c`)が動く。Xorg・ffmpegのCPU負荷は下がるが、`g6f.xlarge`ではGPU側の上限が変わらず品質は目標に届かない。約10分ごとに`NVFBC_ERR_MUST_RECREATE`が出るので、セッションの作り直しが必須。本番には組み込んでいない。

## 参照レポート

- `reports/78_phase78_th06nc_environment_and_gpu_rendering.md`
- `reports/80_phase80_th06nc_dxvk_and_aws_gpu_survey.md`
- `reports/81_phase81_th06nc_aws_gpu_bringup.md`
- `reports/82_phase82_th15_environment_and_mod_bringup.md`
- `reports/84_phase84_gpu_nvenc_encoding_offload_verification.md`(動画エンコードのNVENCオフロード検証)
- `reports/87_phase87_th15_speedup_multiplier_comparison.md`(us-west-2 g6f.2xlargeへのホスト直接導入手順・th15倍速録画の倍率別比較)
- `reports/89_phase89_speedup_all_titles_gpu.md`(`scripts/89_setup_gpu_instance.sh`による構築、全タイトルの倍速録画)
- `reports/92_phase92_th06nc_g6_full_l4_verification.md`(`g6.2xlarge`の検証、本番イメージでの録画手順)
- `reports/94_phase94_g6f_xlarge_and_nvfbc_capture.md`(`g6f.xlarge`の倍速の検証、NvFBCによるGPUキャプチャ)
- `reports/95_phase95_g6f_2xlarge_ondemand_short_check.md`(`g6f.2xlarge`オンデマンドの短い実測)
