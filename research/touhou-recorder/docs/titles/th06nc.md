# 東方紅魔郷: New Classic (th06nc)

## 基本情報

- 画面解像度: 1280x720 (1080p対応可)
- 描画API: Direct3D11 (DXVK経由でVulkan描画)
- 推奨クラウドアスペクト: **GPUインスタンス必須** (`g6f.2xlarge`。`g6f.xlarge`は720p等倍のみ、reports/94)

## 固有仕様・運用ルール

- **CPU描画(reports/96)**: llvmpipeで9fpsだった主因はBC7テクスチャのサンプリング。`D3D11_DECODE_BC7=1`を付けるとMOD(`mods/common/d3d11_bc7_hook.cpp`)がロード時にRGBA8へ展開し、Xvfb+wined3d(`WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b"`、プレフィックスのDXVKを使わない)で8スレッド60fpsになる。等倍の実効fpsは8スレッド56.3、16スレッド57.6、1/2倍速(8スレッド)は58.45。本番は未採用。
- **CPU描画のクラウド実測(reports/97)**: `c7i.2xlarge`の720p 1/2倍速はLunaticでGPU等倍と同等(落ち1.3%、尺1時間約$0.09)だが、Extraのパチュリー戦の高密度弾幕で描画が実時間約15Hzへ落ちる(Extra全体で落ち7.6%)。`c7i.4xlarge`の720p 1/2倍速はExtra 0.7%(約$0.17)、1080p 1/2倍速は1.4〜2.5%(約$0.18)。等倍(`c7i.4xlarge`、7%)と`c7i.xlarge`(10〜11%)は不可。**FpsMonitor(`GetDeviceState`の回数)は描画落ちを示さない**ので、品質は配信版のユニークフレームで判定する。
- **DXVKはXvfbで落ちる**: XvfbのRandRのリフレッシュレートが0HzのためDXVKの`dxgi.dll`がゼロ除算する。DXVKをCPU描画で使うならXorg dummy(`scripts/96_cpu_render/xorg-dummy.conf`)。
- **ローカル実行の禁止**: ローカルマシンのGPU（Radeon VII / amdgpu）ではプロセス終了時のGPU VM破棄でdma_fence待ちハングが発生し、復旧に再起動が必要となるため、検証・録画はAWSのGPUスポットインスタンス上で行います。
- **推奨インスタンス・AZ**: eu-south-2では `g6f.2xlarge`（8 vCPU / 32 GiB / NVIDIA L4の1/4スライス、AZ aまたはb）を使います（AZ cはスポット価格が高いため避ける）。`g6f.xlarge`（L4の1/8）は720p等倍のみ実用です（reports/94）。
- **後mux補正の必須性**: 4 vCPUでは映像・音声ffmpegの起動レイテンシ差が大きいため、`-copyts` + `-itsoffset` による後mux補正（`recorder/ffmpeg.py` の既定動作）を必ず有効にします。
- **DXVK経路の利用**: `WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=n"` を指定し、DXVK（D3D11→Vulkan）経路で録画します。
- **理論尺比較**: Extraステージは理論尺が−5.40%と大きくマイナスに出るため、理論尺比較は超過方向の検出にのみ使用します。
- **1080p録画**: 1080p録画時は `g6f.2xlarge`（8 vCPU）が必須です（`TH06NC_ENV_FILE=games/th06nc/th06.env.1080p`）。Xorg経路では `--crtc-mode 1920x1080` の指定が必要です。また解像度変更に伴い矩形判定もスケールされます。
- **終了検知ポーリング（poll_side_stream）**: 通常のffmpeg個別プロセス起動型ポーリングは録画用x11grabと干渉して周期的なフレーム落ちを引き起こすため、`recorder/games.py` の th06nc に `poll_side_stream=True` を指定してサブストリームから取得します。
- **ウィンドウ再配置対策**: GPU描画面（Xorg+nvidia）では録画開始直前に原点座標の再確認・再移動処理が行われます。

## g6f.2xlarge(L4の1/4、reports/95)

- Extraの実測で、1080p 2倍速は59.20fps(落ち1.3%)、720p 3倍速は50.71fps(落ち15.5%)。**720p 3倍速は`g6.2xlarge`(59.49fps)と同等ではない。** Lunaticは未測定。

## g6f.xlarge(L4の1/8、reports/94)

- **倍速は不可。** Lunatic全6面の実効fpsは720p 3倍速が19.78(NvFBCで24.65)、1080p 2倍速が17.56(同31.38)。720p 2倍速もExtraで35.8〜39.9。ゲーム単体でも720p 3倍速は167〜177Hzで目標未満。
- 等倍は720pが59.36fpsで実用水準、1080pが52.44fps。
- オンデマンドの費用比較はreports/95を参照。

## g6.2xlarge(L4フル、フォールバック先、reports/92)

- 本番AMI・本番イメージのままAMI変更なしで動く(Pass-Through、`Licensed`)。品質・実時間は`g6f.2xlarge`と同等。
- 録画+変換の実時間は尺に対し、720p: 等倍×1.06〜1.09、2倍速×0.59〜0.61、3倍速×0.42〜0.44、1080p: 等倍×1.14〜1.17、2倍速×0.67〜0.69(通常ステージ)。起動からコンテナ開始まで127〜140秒。
- **現行の配信版変換では倍速のユニークフレームが約45/秒に落ちる**(`docs/known-limitations.md`)。
- **`g6.2xlarge`で採用する録画速度(2026-11-05、ユーザーの視聴で決定): 720pは3倍速、1080pは2倍速。** 上記の変換の修正(sattori-dev#322)が前提。`g6f.2xlarge`は追加検証せず、以前検証した設定のまま使う。
- 配信版の末尾には終了検知待ちのリプレイ一覧が最大約18秒残る。短いリプレイの品質評価では末尾を除く。

## 参照レポート

- `reports/78_phase78_th06nc_gpu_recording_poc.md`
- `reports/79_phase79_th06nc_host_gpu_hang_investigation.md`
- `reports/80_phase80_th06nc_aws_gpu_exploration.md`
- `reports/81_phase81_th06nc_aws_gpu_bringup.md`
- `reports/92_phase92_th06nc_g6_full_l4_verification.md`
- `reports/96_phase96_th06nc_cpu_rendering_bc7.md`(CPU描画、BC7展開)
- `reports/97_phase97_th06nc_cpu_spot_verification.md`(CPU描画のc7iスポット実測)
- 共通GPU手順: [docs/gpu-recording.md](docs/gpu-recording.md)
