# フェーズ96: th06ncのGPU非依存録画(BC7展開でCPU描画が9fps→60fps)と、GPU以外を含む低コスト手段の調査

日付: 2026-11-07。**クラウドリソースは使っていない**(読み取り専用の価格・Spot Placement Score・クォータの照会のみ)。検証はローカル(Ryzen 7 5700X、8コア16スレッド)。GPUには触れていない。

## 結論

1. **th06ncのCPU描画が約9fpsだった主因は、BC7圧縮テクスチャのサンプリング。** 1フレームの描画は10〜400コールと少ないのに、llvmpipe/lavapipeはBC7をテクセルごとにソフトウェアでデコードするため極端に遅い。D3D11フックでBC7をロード時にRGBA8へ展開すると、同じ8スレッドで**5.4Hz→60.1Hz**になった。
2. **既存のCPU録画と同じ構成(Xvfb+wined3d+llvmpipe)のまま、GPU無しで品質検査を通る録画が初めてできた。** Lunatic全6面(1586秒)を等倍で完走し、記録スコア142962440と一致、同期残差+0.5ms、パイプラインの重複率0.4〜2.0%。DXVKも専用のXサーバーも要らない。
3. **品質(配信版相当の実効fps、同じ370秒区間)**: GPU(`g6f.xlarge`、reports/94)59.00、**CPU 8スレッドの1/2倍速 58.45**、CPU 16スレッドの等倍 57.29、CPU 8スレッドの等倍 55.95。等倍はゲームが60Hzを保ってもキャプチャ側で落ちる。**本番候補は既存の低速録画(`FPS_LIMIT_TARGET_HZ=30`)の流用。**
4. **費用見込み(尺1時間あたり、eu-south-2のSpot 7日中央値、起動・転送・変換を除く)**: 720pの1/2倍速を`c7i.2xlarge`で約**$0.08**、等倍を`c7i.4xlarge`で約$0.085。目標$0.20を大きく下回り、GPUの在庫に依存しない。1080pは`c7i.4xlarge`の1/2倍速で約$0.16(キャプチャ込みは未測定)。
5. **GPUのまま続ける場合も手がある。** g6fのSpot Placement Score(1〜10)は eu-south-2・eu-north-1 が **1**、us-east-1・us-west-2・eu-west-2・eu-central-1・sa-east-1・ap-northeast-1 が **9**。枯渇は今のリージョン固有。

## 1. 原因の特定

### 1.1 DXVK+lavapipeでも9fps(描画APIの問題ではない)

`--cpu-display`はXvfbを使うが、XvfbのRandRのリフレッシュレートが0Hzのため、DXVK(v2.7)の`dxgi.dll`がRVA `0xED5A`の`idiv`でゼロ除算して落ちる(`Found monitors not associated with any adapter`の直後)。Xorgのdummyドライバ(`scripts/96_cpu_render/xorg-dummy.conf`、60Hzのモードライン、root不要)で回避した。

DXVK+lavapipe(Mesa 25.2.8、LLVM 20)でも8.4〜9.6Hz、llvmpipeのスレッド14本がほぼ100%で、reports/78(wined3d+llvmpipe)と同じだった。

### 1.2 描画コールは少ない

`DXVK_HUD`(リプレイ情報画面): 描画10コール、レンダーパス2、CS load 98%、GPU 99%。自前のVulkanレイヤー(`scripts/96_cpu_render/vk_probe_layer.c`)で記録すると、1フレームは1280x720のパスに10〜20回の小さな描画と、スワップチェーンへのブリット1回だけ。MSAAなし。**生成されたテクスチャの多くが`VK_FORMAT_BC7_UNORM_BLOCK`(145)**: 4096x4096×2、2048x2048×6、1920x1080、1920x808、1024x1024×3、512x512×4。ゲームプレイ中は約400コール。

```bash
gcc -O1 -shared -fPIC -I<libvulkan-devのinclude> -o /tmp/p96/layer/libvkprobe.so scripts/96_cpu_render/vk_probe_layer.c -lpthread
VK_LAYER_PATH=/tmp/p96/layer VK_INSTANCE_LAYERS=VK_LAYER_TOUHOU_probe VKPROBE_LOG=<出力> VKPROBE_START=250 VKPROBE_FRAMES=3 \
  DXVK_CONFIG="dxvk.enableGraphicsPipelineLibrary=False" scripts/96_cpu_render_probe.sh layer 50
```

(`libvulkan-dev`は`apt-get download`で展開したヘッダだけを使い、システムには導入していない。)

### 1.3 BC7をロード時に展開する

`mods/common/d3d11_bc7_hook.cpp`(`D3D11_DECODE_BC7=1`のときだけ有効):

- DXライブラリは`D3D11CreateDevice`を`GetProcAddress`で取るので、MODの`MyGetProcAddress`で包む(`mods/th06nc_replay_autoplay/dllmain.cpp`)
- `ID3D11Device`のvtable 5(`CreateTexture2D`)・7(`CreateShaderResourceView`)、`ID3D11DeviceContext`の14/15(`Map`/`Unmap`)・48(`UpdateSubresource`)を差し替え、BC7(`DXGI_FORMAT_BC7_*`)をR8G8B8A8へ置き換える。th06ncの経路は全て「初期データなしで生成→`UpdateSubresource`」だった(ログ上30枚)
- デコーダは自前(`mods/common/bc7_decode.h`)。Pillowの`bcn`デコーダとランダムな256,000ブロック(全8モード)で照合し、**不一致0**

| 条件(リプレイ情報画面または実プレイ、720p) | FpsMonitor | th06nc.exeのCPU |
|---|---|---|
| 16スレッド、DXVK+lavapipe、展開なし | 8.4〜9.6Hz | 約1300% |
| 16スレッド、DXVK+lavapipe、展開あり | 57.7〜78.3Hz | 約510% |
| 8スレッド、DXVK、展開なし(実プレイ) | 中央値5.4 | 783% |
| 8スレッド、DXVK、展開あり(実プレイ) | 中央値60.1(最低57.1) | 431% |
| **8スレッド、wined3d(Xvfb)、展開あり(実プレイ)** | **中央値60.1(最低58.2)** | **377%** |
| 4スレッド、DXVK、展開あり | 中央値50.6 | 346% |
| 4スレッド、wined3d、展開あり | 中央値57.2 | 319% |
| 1080p 16スレッド、wined3d、展開あり | 中央値60.1 | 797% |
| 1080p 8スレッド、wined3d、展開あり | 中央値46.8 | 610% |

キャプチャなしの`scripts/96_cpu_render/matrix.sh`(実プレイ開始後の約55秒)。スレッドは`taskset`で物理コアとそのSMTの対(8スレッド=`0-3,8-11`)に固定し、`LP_NUM_THREADS`も合わせた。

## 2. 録画パイプラインでの実測(Lunatic全6面`th6_20`、720p、wined3d)

```bash
taskset -c 0-3,8-11 env D3D11_DECODE_BC7=1 WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b" GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1 \
  python3 scripts/25_record_replay_e2e_multigame.py --game th06nc --cpu-display --replay th6_20.rpy --max-attempts 1 --output <出力>
# 1/2倍速は FPS_LIMIT_TARGET_HZ=30 SPEED_HACK_MULTIPLIER=0.5 TH06NC_TIME_SCALE=2 を足し、--record-seconds 800
# 復元: ffmpeg -i <録画> -vf "setpts=0.5*PTS" -r 60 -af "asetrate=88200,aresample=44100" <復元>
python3 scripts/81_analyze_stutter_periodicity.py <動画> --start 20 --duration 370
```

| 条件 | 結果 | FpsMonitor 中央/下位5%/最低(Hz) | 全区間の実効fps(落ち) | 同じ370秒区間の実効fps(落ち) |
|---|---|---|---|---|
| 8スレッド 等倍 | 試行1成功、スコア一致、残差+0.5ms、総録画1609秒 | 60.2/57.2/37.1 | 56.32 (6.1%) | 55.95 (6.7%) |
| 16スレッド 等倍 | 試行1成功、スコア一致、総録画1584秒 | 60.1/59.7/45.3 | 57.59 (4.0%) | 57.29 (4.5%) |
| **8スレッド 1/2倍速** | 800秒で打ち切り(Stage 1〜2)、30.0Hz安定、残差+1.0ms | 30.0前後 | - | **58.45 (2.6%)** |
| 比較: GPU `g6f.xlarge` 等倍(reports/94の配信版) | - | - | 59.36 (1.1%) | 59.00 (1.7%) |

- GPUの配信版でも同じ区間で1.7%落ちる(演出上の静止を含む)ので、差を見ること。
- 描画の一致: GPU録画と頭出しを合わせた同じ場面のPSNRは、序盤で全体32〜37dB(左の静止パネル35〜39dB)。圧縮・透かしの差の範囲で、目視でも差は無い。後半はずれが大きく同じ場面を取れず、比較できていない。
- 1/2倍速の生データの重複率は51.1%で、本番の低速録画の閾値90%(sattori `SLOW_MOTION_MAX_DUPLICATE_RATE`)の内側。
- CPU温度(Tctl)は最大63℃。

## 3. 費用の見込み(尺1時間あたり)

eu-south-2のSpot単価(`describe-spot-price-history`、直近7日の中央値): `c7i.xlarge` $0.0437、`c7i.2xlarge` $0.0383、`c7i.4xlarge` $0.0769、`c7i-flex.2xlarge` $0.0372。実時間の比は、等倍が×1.06〜1.09(reports/92)、1/2倍速が×2.03〜2.08(sattori `recordingSpeed.ts`の`c7i.4xlarge`実測)。起動・変換・EBS・転送は含めない。

| 構成 | 費用 | 品質 | 状態 |
|---|---|---|---|
| **720p 1/2倍速 `c7i.2xlarge`** | **約$0.08** | 58.45fps(GPUの59.00に近い) | Stage 1〜2のみ実測 |
| 720p 等倍 `c7i.4xlarge` | 約$0.085 | 57.29〜57.59fps(落ち4%) | 全6面実測(16スレッドで代用) |
| 720p 1/2倍速 `c7i.xlarge` | 約$0.09 | 未測定(ゲーム単体は等倍で57.2Hz) | 未測定 |
| 1080p 1/2倍速 `c7i.4xlarge` | 約$0.16 | 未測定(ゲーム単体は等倍で60.1Hz) | 未測定 |
| 参考: 現行`g6.2xlarge` 720p 3倍速(reports/92) | 約$0.23 | 58.64fps | 在庫は変動 |

ローカルの5700X(Zen 3)と`c7i`(Sapphire Rapids)の差は未評価。**クラウドでの実測が次の確認事項。**

## 4. GPUを使う場合の調査結果

### 4.1 AWSの別リージョン(読み取り専用APIで2026-11-07 07:15 UTC前後に取得)

`aws ec2 get-spot-placement-scores --region us-east-1 --instance-types <type> --target-capacity 1 --region-names ...`(1〜10、高いほど取れやすい):

| タイプ | 9 | 低い |
|---|---|---|
| g6f.xlarge | sa-east-1, us-east-1, us-west-2, ap-northeast-1, eu-central-1, us-east-2, ap-southeast-2 | eu-west-2 8, ap-south-1 2, ca-central-1 2 |
| g6f.2xlarge | sa-east-1, us-east-1, eu-west-2, us-west-2, ap-northeast-1, eu-central-1 | **eu-south-2 1, eu-north-1 1**, ca-central-1 1, ap-south-1 2 |
| g6.2xlarge | eu-south-2, sa-east-1, us-east-1, eu-central-1 | ap-northeast-1 8, us-west-2 3 |
| g4dn.xlarge(T4) | 調べた10リージョンすべて | - |

`g6f.2xlarge`のSpot単価(14日中央値): eu-west-2 $0.187、us-west-2 $0.192、sa-east-1 $0.138、us-east-1 $0.231、eu-central-1 $0.236(eu-south-2 $0.130)。reports/95の尺比×0.66(720p 3倍速)なら eu-west-2で約$0.12、sa-east-1で約$0.09。ただしreports/95のとおり`g6f.2xlarge`の3倍速は50.71fps。**G系Spotのクォータ(vCPU)は us-west-2 128、eu-north-1 32、eu-south-2 32、us-east-1 5、sa-east-1・eu-central-1 0**で、追加のリージョンにはクォータ申請・AMIコピー・出力バケット(#313と同じ構成)が要る。Placement Scoreは時点の値で、確保を保証しない。

### 4.2 AWS以外

| 手段 | 価格の目安 | 評価 |
|---|---|---|
| Azure `NV6ads_A10_v5`(A10の1/6、6vCPU)Spot | 最安$0.084/時(westus3、Retail Prices API) | GRIDドライバ・1/6スライス。`g6f.xlarge`同様にスライスが律速の恐れ。新規クラウドの構築が必要 |
| Azure `NV4ads_V710_v5`(AMD V710の1/6)Spot | $0.074/時 | AMD+RADVはローカルでamdgpuのフェンス固着(reports/79・80)と同系統の懸念 |
| GCP `g2-standard-4`(L4フル)Spot | $0.29〜0.47/時(gcloud-compute.com、2026-11-01) | 目標超過 |
| Vast.ai | RTX 2070〜4060級で$0.056〜0.08/時(公開API、2026-11-07) | コンテナのみ、ホストは個人。**ゲーム本体(著作権物)を第三者の機器へ置く**。Vulkan/Xorgの可否はホスト次第で未確認 |
| SaladCloud | $0.02〜0.07/時(第三者の集計) | 同上、さらに中断が多い |

**CPU描画で目標を満たせるため、AWS以外の新規導入は勧めない。**

## 5. 本番へ入れる場合の作業(未実施)

- sattoriのCPUワーカー(`worker/Dockerfile`、Xvfb+wined3d)でth06ncを録る。必要なのは、MODの再ビルド(本フェーズの`th06nc_hook.dll`)、環境変数`D3D11_DECODE_BC7=1`と`WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b"`(GPU用プレフィックスはDXVKをsystem32へ置いているため、ビルトインを明示する)、`gpu_display=False`。
- 速度は1/2倍速(`FPS_LIMIT_TARGET_HZ=30`、`SPEED_HACK_MULTIPLIER=0.5`、MODの待ちは`TH06NC_TIME_SCALE=2`)。0064の低速録画の仕組み(`fallbackRecordingSpeedFor()`)にth06ncを足すのが最小。th06ncのMODは`fps_limiter_hook`ではなくQPCの偽装で減速する。
- クラウドでの確認: `c7i.2xlarge`の720p 1/2倍速と`c7i.4xlarge`の1080p 1/2倍速のフル尺(Lunatic・Extra)、`c7i.xlarge`の可否。
- 自宅ワーカー: 0047はGPU必須を理由にth06ncを除外しているが、CPU描画なら対象になりうる(未検討)。

## 6. 補足

- `apitrace`(配布バイナリ)での調査は権限で拒否されたため使っていない。代わりに自前のVulkanレイヤーとDXVKのHUDを使った。
- 検証中は`/dev/dri`・`/dev/kfd`をゲームが開いていないこと、Tctl 88℃未満を5秒ごとに監視した(`/tmp/p96/guard.sh`、違反は0回)。
- 自前のXorg dummyはamdgpuの初期化を試みて権限エラーで失敗する(`amdgpu_query_info(ACCEL_WORKING) failed (-13)`)。GPUの使用には至らないが、本番では不要(wined3dはXvfbで動く)。

## 成果物

`/mnt/cache3/sattori-th06nc-verify/phase96/`

- `full/lunatic_wined3d_8t.mp4`・`lunatic_wined3d_16t.mp4`: CPU等倍のLunatic全6面
- `full/lunatic_wined3d_8t_half_restored.mp4`: 1/2倍速を等倍へ戻したもの(Stage 1〜2)
- `probe/`: 各計測のMODログ・スクリーンショット・DXVKログ、`vkprobe.log`

## 変更ファイル

- 新規: `mods/common/bc7_decode.h`、`mods/common/d3d11_bc7_hook.{h,cpp}`、`scripts/96_cpu_render_probe.sh`、`scripts/96_cpu_render/`(Xorg dummy設定、Vulkanレイヤー、`matrix.sh`、`compare_gpu.py`)
- 変更: `mods/th06nc_replay_autoplay/dllmain.cpp`、`mods/th06nc_replay_autoplay/build_mingw.sh`、`docs/titles/th06nc.md`、`docs/known-limitations.md`、`AGENTS.md`、`reports/README.md`
