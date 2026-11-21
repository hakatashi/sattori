# フェーズ80: th06ncのDXVK経路検証(フェンス固着は回避できず)とAWS GPUインスタンス調査

## 背景

フェーズ79で、th06nc(東方紅魔郷: New Classic)をホストGPU(Radeon VII / amdgpu)で
録画すると**1回の実行ごとにGPUが固着し、次の起動ができなくなる**ことが判明した
(`amdgpu_vm_fini` でのdma_fence待ちにより `do_exit` が完了せず、`th06nc.exe` が
reapできないゾンビ `Zl` として残る)。フェーズ79 §8.2 で次の検証として挙げた
**DXVK(D3D11→Vulkan)経路で回避できるか**を本フェーズで検証した。

## 1. 検証手順

再起動直後のクリーンな状態(D状態タスク9個・ゾンビ無し)から実施した。
DXVK 2.7 の x64 DLL はフェーズ79で `prefixes/th06nc-wined3d-gl` に導入済み
(wineビルトインは `drive_c/windows/system32/_wine_builtin_backup/` に退避済み)。

```bash
# GPU描画面(headless weston + rootful Xwayland)
scripts/78_start_gpu_display.sh --display :88 --screen 2200x1400
# => :88 準備完了: OpenGL renderer string: AMD Radeon Graphics (radeonsi, vega20, ACO, ...)

# DXVK経路で録画(WINEDLLOVERRIDES を付けないと wine は builtin=wined3d を使う)
WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=n" \
  python3 scripts/25_record_replay_e2e_multigame.py --game th06nc --replay th6_07.rpy \
      --output runs/th06nc_verification/dxvk1/th6_07.mp4 --max-attempts 1
```

DXVKが実際に使われていることは、実行中のプロセスのマップで確認した(wined3dなら
`libGL`/`radeonsi` 系がロードされ、`libvulkan_radeon.so` は出てこない)。

```bash
$ pid=$(pgrep -f th06nc.exe | head -1)
$ grep -iE "d3d11|dxgi|vulkan" /proc/$pid/maps | awk '{print $6}' | sort -u
.../prefixes/th06nc-wined3d-gl/drive_c/windows/system32/d3d11.dll   # <- native(DXVK)
.../prefixes/th06nc-wined3d-gl/drive_c/windows/system32/dxgi.dll    # <- native(DXVK)
/usr/lib/x86_64-linux-gnu/libvulkan_radeon.so                       # <- RADV
/usr/lib/x86_64-linux-gnu/libvulkan.so.1.3.275
```

## 2. 結果: DXVKでもGPU固着は回避できない

| 時点 | D状態タスク数 | `th06nc.exe` |
|---|---|---|
| 実行前(再起動直後) | 9 | 無し |
| GPU描画面の起動後 | 9 | 無し |
| **DXVK録画1回目の後** | **27** | **`Zl` ゾンビが1個残存** |

ゾンビのカーネルスタックはwined3d時(フェーズ79 §2)と**完全に同一**だった。

```bash
$ sudo cat /proc/13967/task/14051/stack
[<0>] dma_fence_default_wait+0x1e1/0x220
[<0>] dma_fence_wait_timeout+0x116/0x140
[<0>] amdgpu_vm_fini+0xf1/0x610 [amdgpu]
[<0>] amdgpu_driver_postclose_kms+0x1b7/0x2f0 [amdgpu]
```

`dmesg` にも同じ経路の hung task と、それに続く `amdgpu_tlb_fence_work` の
ブロックが記録されている。

```
[Sep 12 10:52:55] [drm:amddrm_sched_entity_push_job [amd_sched]] *ERROR* Trying to push to a killed entity
[Sep 12 10:54:21] INFO: task kworker/9:0:73 blocked for more than 245 seconds.
[Sep 12 10:54:21] Workqueue: events amdgpu_tlb_fence_work [amdgpu]
```

**結論: フェンス固着は wined3d/OpenGL 固有ではなく、D3D11→Vulkan(DXVK/RADV)でも
同じように発生する。** 描画APIの違いではなく、プロセス終了時のGPU VM破棄
(`amdgpu_driver_postclose_kms` → `amdgpu_vm_fini`)が完了しないフェンスを待つ、という
amdgpu側の問題である可能性が高い。`glxgears` では発生しないことから、th06ncの
GPU使用パターン(大量のバッファ確保・コンテキスト生成)が引き金になっていると見られる。

## 3. 副産物: 描画品質はDXVKの方が良い

GPUが健全な1回目の録画そのものは正常に完走した(`th6_07.rpy`、Easy・21秒)。

| 経路 | ゲームプレイ区間の重複フレーム率 | MOD計測のポーリング |
|---|---|---|
| wined3d(フェーズ79) | 1.5% | — |
| **DXVK(本フェーズ)** | **0.0%** | 57.6 Hz |

```bash
$ bash scripts/measure_duplicate_frame_rate.sh runs/th06nc_verification/dxvk1/th6_07.mp4 12 17
video=... start=12s duration=17s total_frames=1019 unique_frames=1019 duplicate_rate=0.0%
```

A/V同期の実測差分は -0.014秒、`stutter probe` も `dup_fraction=0.00` で、フェーズ79 §4 で
入れた `stutter_probe_exclude_rect` によるマスクが正しく効いていることも確認できた。

### 3.1 【注意】短尺スモークテストでは`scripts/25`の最終重複フレーム率チェックが誤判定する

本録画は最終的に以下で失敗扱いになったが、これは**計測区間の取り方による見かけ上の問題**で
あり、実際の描画品質とは無関係である。

```
[10:52:58] 録画開始15秒以降の重複フレーム率: 36.7%
[10:52:58] WARNING: 重複フレーム率(36.7%)が閾値(30.0%)を超えました。...破棄してリトライします
```

`scripts/25` の最終チェックは「録画開始15秒以降**〜ファイル末尾まで**」を測る。本件は
リプレイ本編21秒に対し、終了検知(画面静止 8回/16秒)+ 余裕で**26秒もの静止画面**が
末尾に付いており、計測区間の大半が静止画面だった。フル尺録画(30分前後)では末尾16秒の
比率は0.9%程度なので実害はない。**短尺リプレイでのスモークテストでは、この最終チェックの
数値ではなく `measure_duplicate_frame_rate.sh` でプレイ区間を明示指定した値を見ること。**

## 4. 方針決定: th06ncの録画はAWSのGPUスポットインスタンスで行う

ユーザー判断により、以下の方針が決定した(2026-09-12)。

* **本問題はこの環境のGPU(Radeon VII)が特殊であることに起因する可能性が高く、
  本番サービスでこのGPUを使うのはリスクが高い**
* **sattori本番でもth06ncを録画する際は必ずAWSのGPUインスタンスを使う**
* **以降のth06nc検証(フル尺録画・録画品質・音ズレ・理論尺比較など)はすべて
  AWSのGPU搭載スポットインスタンス上で行う**

ローカルのamdgpu回避策(カーネルパラメータ・カーネル/Mesa更新)の調査は、
ユーザーのML系ワークロード(ComfyUI・WebUI Forge)と共有しているGPUを
1試行ごとに壊す必要があり割に合わないため、**追求しない**。

## 5. eu-south-2で利用可能なGPUインスタンスの調査

```bash
aws ec2 describe-instance-type-offerings --region eu-south-2 \
    --location-type availability-zone \
    --filters "Name=instance-type,Values=g6f.*,g6.*,g5.*,g6e.*,gr6.*,g4dn.*" \
    --query "InstanceTypeOfferings[].[InstanceType,Location]" --output text | sort
```

**【注意】`--filters` の `Values` はワイルドカード `*` を使うが `.` は literal なので、
`g6.*` は `g6f.*` にマッチしない。** 最初の調査で g6f を見落としかけた。

| ファミリ | GPU | 提供AZ | 備考 |
|---|---|---|---|
| **g6f** | NVIDIA L4 の 1/8〜1/2 スライス | a/b/c | large/xlarge/2xlarge/4xlarge |
| g6 | NVIDIA L4(フル) | a/b/c | |
| g5 | NVIDIA A10G | a/b/c | |
| g6e | NVIDIA L40S | **b/c のみ** | 高価(LLM向け) |
| gr6 / gr6f | L4 + 大容量メモリ | a/b/c | |
| g5g | NVIDIA T4G | **a のみ** | **Graviton(ARM)のため使用不可** |
| g4dn | T4 | **提供なし** | us-east-1等にはあるがeu-south-2には無い |

### 5.1 スポット価格(2026-09-12時点、過去7日の実測レンジ)

`aws ec2 describe-spot-price-history --region eu-south-2 --instance-types <type>
--product-descriptions "Linux/UNIX" --start-time <7日前>` の結果をAZごとに集計したもの。

| インスタンス | vCPU | RAM | GPUメモリ | スポット(AZ a / b の安い方) | オンデマンド |
|---|---|---|---|---|---|
| g6f.large | 2 | 8 GiB | 2.8 GiB (L4 1/8) | **$0.023/h** | $0.227/h |
| **g6f.xlarge** | 4 | 16 GiB | 2.8 GiB (L4 1/8) | **$0.062/h** | $0.267/h |
| g6f.2xlarge | 8 | 32 GiB | 5.7 GiB (L4 1/4) | **$0.055/h** | $0.534/h |
| g6f.4xlarge | 16 | 64 GiB | 11.4 GiB (L4 1/2) | $0.110/h | — |
| g6.xlarge | 4 | 16 GiB | 22.4 GiB (L4フル) | $0.170/h | $0.848/h |
| g6.2xlarge | 8 | 32 GiB | 22.4 GiB | $0.184/h | $1.030/h |
| g5.xlarge | 4 | 16 GiB | 22.4 GiB (A10G) | $0.156/h | $1.060/h |

**AZごとの価格差が極端なので注意すること。**

* **g6f は eu-south-2c を避ける**: large/xlargeが $0.22〜0.27(a/bの4〜10倍)、
  4xlargeに至っては $1.05。a/b は安定して安い
* **g5.2xlarge は逆に a/b が $1.25 と異常に高く、c だけ $0.25**。g5系は容量逼迫と見られる
* Spot Fleet の `AllocationStrategy: lowestPrice` なら自動回避されるが、
  AZ固定で単発検証する場合は **a または b** を明示すること

### 5.2 必要スペックの見積もり

**第一候補: g6f.xlarge(4 vCPU / RAM 16 GiB / L4 1/8スライス)、AZ は a または b。**

* **GPU側**: th06ncは1280x720の2D弾幕描画であり、L4の1/8スライス(2.8 GiB)でも
  720pのスワップチェーン+テクスチャには十分。ローカルのRadeon VII(13.8 TFLOPS)で
  重複フレーム率0.0%だったのは明らかにオーバースペック
* **CPU側**: 既存8タイトルが4〜8 vCPUを要したのは **llvmpipeのソフトウェア描画が
  CPUを食い潰していたため**で、GPU描画ではその分が丸ごと不要になる。残るのは
  wine + ゲームロジック + x264(veryfast, 720p60)+ AAC で2〜3コア相当
* **`.large`(2 vCPU)は当面避ける**(AGENTS.mdの既存ルール)。ただし $0.023/h と
  xlargeの1/3以下なので、xlargeで余裕が確認できたら試す価値はある

**1録画あたりのコスト試算**: フル尺30〜40分+準備で約1時間として
**g6f.xlarge で約 $0.06/本**。既存タイトルで使っている c7i.2xlarge($0.092〜0.094/h)
よりも安い。

### 5.3 事前に検証が必要なリスク

1. **g6f は分割GPU(vGPU)**であり、標準のNVIDIAデータセンタードライバで
   OpenGL/Vulkan が使えるかの確認が必要。ダメならAWS提供のGRIDドライバに切り替える
2. **ヘッドレス描画面の構成**: ローカルと同じ headless weston(GLレンダラ)+
   rootful Xwayland が NVIDIA/GBM 経路で動くか。動かない場合は
   NVIDIA + Xorg(ダミー画面)という定番構成に切り替える
3. **wined3d と DXVK のどちらを本番採用するか**。ローカル実測ではDXVKが優位
   (0.0% vs 1.5%)だったので、NVIDIA上でも両方試して決める

## 6. 成果物

| パス | 内容 |
|---|---|
| `runs/th06nc_verification/dxvk1/th6_07.mp4` | DXVK経路の録画(プレイ区間の重複フレーム率0.0%) |

## 7. 次にやること

* eu-south-2(AZ a または b)に **g6f.xlarge** のスポットインスタンスを立て、
  NVIDIAドライバ+ヘッドレス描画面+wine環境を構築する
* th06nc単体の軽量Dockerイメージ(`cloud/docker/aws/Dockerfile.th06nc`)を作る
  (全タイトル入りの `Dockerfile.multigame` は7GB超で pull が遅い、フェーズ46)
* フル尺録画(通常ステージ・Extra)、録画品質・音ズレ・理論尺比較
* wined3d / DXVK の比較と本番採用の決定
