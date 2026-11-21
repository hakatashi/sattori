# フェーズ81: th06ncのAWS GPUインスタンス環境構築(g6f.xlarge / NVIDIA L4分割)

## 背景

フェーズ80で、th06ncの検証・本番録画をAWSのGPUスポットインスタンス上で行う方針が
決まった。本フェーズはその環境構築と、ローカル(Radeon VII)と同等の録画品質が
得られるかの確認を行う。

## 1. 【重要】G系インスタンスのクォータが0だった

eu-south-2(本番リージョン)でg6f.xlargeを起動しようとすると、まず
`InsufficientInstanceCapacity`(AZ在庫不足)が出て、AZを変えると
`MaxSpotInstanceCountExceeded` になった。調べると**このアカウントはG系の
クォータが0 vCPU**だった。

```bash
aws service-quotas get-service-quota --region <region> --service-code ec2 \
    --quota-code L-3819A6DF   # All G and VT Spot Instance Requests
aws service-quotas get-service-quota --region <region> --service-code ec2 \
    --quota-code L-DB2E81BA   # Running On-Demand G and VT instances
```

| リージョン | G/VT スポット | G/VT オンデマンド |
|---|---|---|
| **eu-south-2**(本番) | **0 vCPU** | **0 vCPU** |
| us-west-2 | **128 vCPU** | 0 |
| us-east-1 | 5 vCPU | 752 |
| ap-northeast-1 | 0 | 768 |
| eu-central-1 / eu-north-1 / eu-west-2 | 0 | 0 |

CLIユーザー(`awscli@HakataMatrix`)は`servicequotas:ListRequestedServiceQuotaChangeHistory`
すら拒否されるため、**引き上げ申請はユーザーがコンソールから行う必要がある**
(Service Quotas → Amazon EC2 → eu-south-2 → "All G and VT Spot Instance Requests")。

ユーザー判断により、**本フェーズの検証はクォータが既にある us-west-2 で実施**し、
eu-south-2のクォータ承認後に本番リージョンで最終確認する方針とした。

## 2. 起動したインスタンス

| 項目 | 値 |
|---|---|
| インスタンス | `<INSTANCE_ID>`(g6f.xlarge、スポット) |
| リージョン/AZ | us-west-2 / us-west-2d |
| AMI | `<AMI_ID>`(Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20260828) |
| スペック | 4 vCPU / 16 GiB / NVIDIA L4の1/8スライス(3 GiB) |
| スポット実勢価格 | 約 $0.075/h |
| キーペア | `touhou-recorder-th06nc-key`(us-west-2) |
| セキュリティグループ | `<SECURITY_GROUP_ID>`(SSH 22番を作業マシンのIPのみに限定) |

us-west-2でも `g6f.xlarge` は **us-west-2d が最安**($0.075/h)、次いで a/c が
$0.08〜0.09/h、b は $0.12〜0.16/h と高い。

## 3. 【重要】DLAMI付属のNVIDIAドライバではg6fは動かない

`nvidia-smi` が以下で失敗する。

```
NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.
```

`dmesg` を見ると、g6fが**vGPUデバイス**であるためデータセンタードライバのprobeが
拒否されていた。

```
NVRM: The NVIDIA vGPU 0000:31:00.0 (PCI ID: 10de:27b8)
nvidia 0000:31:00.0: probe with driver nvidia failed with error -1
NVRM: None of the NVIDIA devices were initialized.
```

**対策: AWSが配布するGRID(vGPU)ドライバに入れ替える。**

```bash
# 既存のデータセンタードライバを削除(holdされているので --allow-change-held-packages が要る)
sudo apt-get -y --allow-change-held-packages remove --purge \
    'nvidia-driver-*' 'nvidia-dkms-*' 'libnvidia-nscq' 'nvidia-fabricmanager'

# AWS配布のGRIDドライバ(インスタンスのIAMロールでS3から取得できる)
aws s3 cp s3://ec2-linux-nvidia-drivers/latest/NVIDIA-Linux-x86_64-595.91.07-grid-aws.run /tmp/grid.run
sudo sh /tmp/grid.run --silent --dkms
```

導入後、vGPUプロファイル **`NVIDIA L4-3Q`(3072 MiB)** として認識される。

```
| GPU  Name          Persistence-M | Bus-Id        Disp.A | Volatile Uncorr. ECC |
|   0  NVIDIA L4-3Q             On  | 00000000:31:00.0 Off |                    0 |
|                                   |      17MiB /   3072MiB |                    |
```

インストーラが出す以下の警告は、th06nc(64bit)の用途では無害である。

* `Unable to find a suitable destination to install 32-bit compatibility libraries`
  → th06ncはPE32+(x86-64)なので32bitのGLは不要。**ただし他タイトル(th06〜th20は
  すべて32bit)を同じイメージに載せる場合は `--compat32-libdir` の指定が必要になる**
* `no Vulkan ICD loader was detected` → `libvulkan1` を後から入れれば解決する

## 4. 【重要】NVIDIAではweston+Xwayland構成が使えない(llvmpipeに落ちる)

ローカル(amdgpu)で使っている headless weston + rootful Xwayland 構成
(`scripts/78_start_gpu_display.sh`)をそのまま持ち込むと、**weston自体はNVIDIAの
GLレンダラで動くのに、その上のXwaylandに接続したクライアントのOpenGLが
llvmpipe(ソフトウェア描画)になる**。

```
[weston] GL renderer: NVIDIA L4-3Q/PCI/SSE2      <- westonはGPUを使えている
$ DISPLAY=:88 glxinfo | grep "OpenGL renderer"
OpenGL renderer string: llvmpipe (LLVM 20.1.2, 256 bits)   <- クライアントはCPU描画
```

**対策: Xorg + nvidia ドライバでヘッドレスX画面を直接立てる。**
`scripts/78_start_gpu_display.sh` に `--backend auto|xorg|weston` を追加し、
`nvidia-smi` が使える環境では自動的にXorg経路を選ぶようにした(既定は `auto`、
amdgpu環境は従来どおり weston+Xwayland)。

要点は3つ。

1. **BusIDは決め打ちしない**。`nvidia-xconfig --query-gpu-info` から取得する
   (今回の実機では `PCI:49:0:0`)
2. **`Option "AllowEmptyInitialConfiguration" "true"` が必須**。無いと
   `(EE) no screens found` で落ちる
3. **`Option "UseDisplayDevice" "none"` を付けてはいけない**。vGPUは仮想ディスプレイを
   持つため、付けると以下で落ちる。ヘッドレス用の定番設定として紹介されることが
   多いオプションなので注意
   ```
   (EE) NVIDIA(GPU-0): UseDisplayDevice "None" is not supported with virtual display
   (EE) NVIDIA(GPU-0): Failed to select a display subsystem.
   ```

結果、`DISPLAY=:88` で **`OpenGL renderer string: NVIDIA L4-3Q/PCI/SSE2`**、
`direct rendering: Yes`、`dimensions: 2200x1400` の画面が得られた。

## 5. 環境構築のその他の手順

```bash
# 描画・録画まわり
sudo apt-get install -y libvulkan1 vulkan-tools mesa-utils weston xwayland openbox \
    xdotool x11-utils x11-xserver-utils xserver-xorg-core xserver-xorg-video-dummy ffmpeg
# wine(ローカルと同じ wine-9.0 (Ubuntu 9.0~repack-4build3))
sudo apt-get install -y wine wine64 rsync procps language-pack-ja \
    python3-numpy python3-pil pulseaudio pulseaudio-utils
sudo locale-gen ja_JP.UTF-8
```

ゲーム一式(約2.2GB)はDockerイメージではなく **rsyncで直接持ち込んだ**
(`scripts/`、`assets/`、`games/th06nc/`、`prefixes/th06nc-wined3d-gl/`、
`mods/common/build/injector64.exe`、`mods/th06nc_replay_autoplay/build/th06nc_hook.dll`、
`mods/th06c_steam_stub/build/steam_api64.dll`)。
`scripts/25`はスクリプト位置から`REPO`を決めるので配置場所は任意でよい。
**`instances/` ディレクトリは事前に作っておくこと**(rsyncが親ディレクトリを
作れず `error in file IO (code 11)` で落ちる)。

### 5.1 PulseAudioはセッションから切り離して常駐させること

`pulseaudio --start` をSSHセッション内で実行すると、**SSHが切れると一緒に死ぬ**。
録画スクリプトの音声ffmpegが `Error opening input: No such process` で失敗し、
mux前に音声ファイルが存在しない状態になる。

```bash
sudo loginctl enable-linger ubuntu
setsid nohup pulseaudio --exit-idle-time=-1 --disallow-exit > /tmp/pulse.log 2>&1 < /dev/null &
```

## 6. スモークテスト: wined3d vs DXVK

短尺リプレイ(`th6_07.rpy`、Easy・21秒)で両経路を比較した。

| 経路 | プレイ区間(12秒から17秒)の重複フレーム率 | 音声 | A/V同期差分 |
|---|---|---|---|
| wined3d(OpenGL) | 2.6% | — | — |
| **DXVK(Vulkan)** | **1.7%** | 取得OK | -0.032秒 |

ローカル(Radeon VII)でもDXVKが優位(0.0% vs 1.5%、フェーズ80)だったのと同じ傾向で、
**th06ncはDXVK経路を採用する**。

```bash
WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=n" \
  python3 scripts/25_record_replay_e2e_multigame.py --game th06nc --replay <rpy> --output <mp4>
```

## 7. `scripts/25` の最終重複フレーム率チェックを修正

フェーズ80 §3.1 で見つけた「短尺リプレイでは終了検知の静止画面が計測区間の大半を
占めて誤判定する」問題を、計測区間から尾部を除外することで修正した。

* `attempt_recording()` の戻り値に `end_detect_tail_sec` を追加
  (画面静止検知なら `STILL_CONSECUTIVE_REQUIRED * POLL_INTERVAL_SEC` = 16秒、
  テンプレート照合なら `POLL_INTERVAL_SEC * 2` = 4秒)
* 最終チェックの計測区間を「録画開始15秒 〜 (総録画時間 − 尾部)」に変更。
  尾部を除くと5秒未満しか残らない場合のみ従来どおり尾部込みで測る

## 8. フル尺録画(Normal / Lunatic)

DXVK経路でフル尺録画を行い、スコア一致・理論尺・A/V同期を確認した。

| 項目 | Normal(`th6_02.rpy`) | Lunatic(`th6_22.rpy`) |
|---|---|---|
| 総録画時間 | 1487.4秒 | 1551.8秒 |
| 記録スコア vs 再生スコア | **90,668,470 = 90,668,470(一致)** | (同様に取得) |
| 実プレイ時間 / 理論尺 | 1460.5s / 1454.8s = **+0.39%** | 1525.0s / 1523.6s = **+0.09%** |
| A/V同期差分 | -0.040秒 | -0.030秒 |
| 重複フレーム率(区間別) | 2.1〜3.9% | 2.2% |

**理論尺が健全なのが重要な手がかりだった。** ゲーム自体は60fpsで正常に進行しており、
問題は「キャプチャ側がフレームを取りこぼしている」ことを意味する。

## 9. 【重要】「数秒ごとに数フレーム飛ぶ」カクつきの原因は scripts/25 自身だった

ユーザーが `full_normal/th6_02.mp4` を視聴して「おおむね滑らかだが、数秒ごとに
不自然なカクつき(数フレームほど飛んだように見える)がある。本番投入の品質には
達していない」と指摘したことから調査した。

### 9.1 周期性の解析で原因を特定した

`scripts/81_analyze_stutter_periodicity.py`(本フェーズで新規作成)で、mpdecimateが
残したフレームのタイムスタンプ列から「コマ落ちの発生時刻」を求め、その位相集中度 R を
周期ごとに計算した。

| 検定した周期 | 位相集中度 R |
|---|---|
| 2.00秒 | 0.019(無相関) |
| **2.32秒** | **0.654(強い周期性)** |

2.32秒 = `POLL_INTERVAL_SEC`(2.0秒)+ `grab_frame()` の所要時間(0.32秒)。

`grab_frame()` は**呼ぶたびに別プロセスのffmpegを起動してウィンドウ全体(1280x720)を
x11grabし、PNGにエンコードしてPILで読み込む**。これを2秒ごとに実行すると、同じXサーバーから
60fpsでキャプチャしている本録画を毎回約0.32秒妨害する。

既存8タイトルで顕在化しなかったのは、640x480(th06ncの1/3のピクセル数)かつ
CPU専用インスタンス(8 vCPU)で吸収できていたためと考えられる。なお
`--record-seconds` モードのコメントには「画面静止検知・stutter probe・grab_frame は
連続録画の重複フレーム率計測を攪乱しうるので、このモードでは一切行わない」と
**過去フェーズの時点で既に書かれていた**が、本番録画の品質そのものへの影響とは
結び付けられていなかった。

### 9.2 対策: X11キャプチャを1本に統一する

録画用ffmpegの `filter_complex` に `split` を入れ、**8fps・160x120・grayのサブ出力**を
生やした。画面静止検知も `probe_stutter` もこのファイルの末尾を読むだけにして、
X11キャプチャを1本に統一した(`GAME_CONFIGS["th06nc"]["poll_side_stream"] = True`。
既存タイトルは設定を持たないので挙動不変。`POLL_SIDE_STREAM=0` で従来動作に戻せる)。

```
ffmpeg -y -copyts -f x11grab ... -i :88+0,8 \
  -filter_complex "[0:v]split=2[vmain][vpollsrc];[vpollsrc]fps=8,scale=160:120,format=gray[vpollout]" \
  -map [vmain] -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p out.video.mp4 \
  -map [vpollout] -f rawvideo -pix_fmt gray -flush_packets 1 out.pollraw
```

実装上の落とし穴が2つあった。

1. **ffmpegの出力バッファリング**。`-flush_packets 1` を付けないと書き込みが遅れ、
   読み側が同じフレームを2回掴む。するとMADが0になり「画面が静止している」と
   誤判定して、**開始47秒でリプレイ終了とみなして録画を打ち切ってしまう**。
   `-flush_packets 1` に加えて、読み側でも**フレーム番号(ファイルサイズ÷19200)が
   進んだことを必ず確認する**こと
2. **`probe_stutter` も `grab_frame` を使っている**。こちらは10回連続キャプチャ
   (約3.2秒)を最初の300秒間だけ60秒おきに行う。サブ出力を8fps(0.125秒間隔)に
   することで、`probe_stutter` も同じファイルから読めるようにした

### 9.3 実測比較(同一リプレイ `th6_05.rpy`、60秒地点から120秒間)

| 条件 | 実効fps | 落ちフレーム | バースト数 | 1バーストの大きさ |
|---|---|---|---|---|
| A: g6f.xlarge(4 vCPU)・修正前 | 57.47 | 304 | 70回 | 3〜8フレーム(R=0.629) |
| C: g6f.2xlarge(8 vCPU)・修正前 | 59.42 | 71 | 26回 | 約2フレーム(R=0.606) |
| **B: g6f.xlarge(4 vCPU)・修正後** | **59.74** | **32** | 10回 | 7回は1フレームのみ |
| **E: g6f.2xlarge(8 vCPU)・修正後** | **59.82** | **23** | **4回** | — |

所見は2つある。

1. **インスタンスを増強しても周期性は消えない**(Cで依然 R=0.606)。原因がCPU不足では
   なく「2本目のX11キャプチャによる干渉」であることの裏付けになった
2. **修正後は4 vCPUでも8 vCPUとほぼ同等**(32 vs 23フレーム)。eu-south-2のG系スポット
   クォータが8 vCPUであることを踏まえると、**g6f.xlarge 2台で並列2録画**という構成が
   取れる(g6f.2xlargeだと1台しか立てられない)

### 9.4 【計測手法の教訓】mpdecimateは「演出上の静止画面」と「取りこぼし」を区別できない

修正後に残った単発の大きなバースト(27〜100フレーム)について、ユーザーが実際に
目視確認した結果、**いずれもボス前の会話シーン(BGMロードのため実機でも一瞬静止する)と
ステージ終了後のリザルト画面**で、カクつきではなかった。

```
01:36.3 -> 1面ボス前会話   02:40.1 -> 1面リザルト画面
04:19.7 -> 2面ボス前会話   05:52.1 -> 2面リザルト画面
```

当初これらを `probe_stutter` 由来と推定したが誤りで、時刻の一致は偶然だった。

**重複フレーム(mpdecimate)は「絵が同一のフレーム」しか見ないため、ゲームが本当に
静止している場面と、キャプチャが取りこぼした場面を原理的に区別できない。**
両者を切り分ける指標は**周期性**である。

* 内容由来の静止(会話・リザルト・エンディング)= 散発的、Rは低い、1回あたりが大きい
* キャプチャの取りこぼし = 等間隔、Rが高い、1回あたりは数フレーム

`scripts/81_analyze_stutter_periodicity.py --list-bursts` で発生時刻を出せるので、
**大きな単発バーストは必ず動画を目視して演出かどうか確かめること。**

また、リプレイ終了後の静止画面(終了検知の尾部)も当然「重複」として数えられるので、
解析区間から外すこと(`scripts/25` の最終チェックは §7 で対応済み)。

### 9.5 修正後のフル尺録画(視聴確認用)

修正版で `th6_02.rpy`(Normal)をフル尺録画し直した(g6f.2xlarge)。

| 項目 | 修正前 | **修正後** |
|---|---|---|
| 重複フレーム率(scripts/25の最終チェック) | 2.5% | **0.1%** |
| A/V同期差分 | -0.040秒 | **-0.009秒** |
| 実プレイ/理論尺 | +0.39% | **+0.33%** |
| 記録スコアとの一致 | 一致 | **一致(90,668,470)** |

カクつき解析(120秒窓)の結果は以下のとおりで、**プレイ中の区間は完全に60fps**である。

| 区間 | 実効fps | 落ちフレーム |
|---|---|---|
| 200秒〜 | **60.01** | **0** |
| 600秒〜 | **60.01** | **0** |
| 1000秒〜 | 59.63 | 46(16:59.2に44フレーム、18:06.1に2フレームの2回のみ) |

1000秒台に残る44フレームの塊は §9.4 の通り演出上の静止画面と見られる。

なお `scripts/81_analyze_stutter_periodicity.py` は、当初バーストが2〜3回しかなくても
「強い周期性あり」と断定してしまっていた(少数の点はどんな周期にも当てはまる)。
8回未満のときは「判定不能」と表示し、目視確認を促すよう修正した。

### 9.6 副産物: 無言ハングのガードを追加

x11grabがウィンドウ画面外(`-i :88+-131,8`)で起動に失敗した際、録画用ffmpegが即死した
にもかかわらず、ポーリングループが `TIMEOUT_SEC`(既定40分)まで無言で回り続ける事象が
発生した。ループ先頭で `record_proc.poll()` を見て、死んでいたらffmpegログの末尾を
出力して試行を打ち切るようにした。

### 9.6.1 修正版でのExtraステージ録画

`th6_10.rpy`(Extra、理論尺12.6分)をg6f.2xlargeで録画した。

| 項目 | 結果 |
|---|---|
| 総録画時間 | 741.6秒 |
| 重複フレーム率(scripts/25) | **0.1%** |
| A/V同期差分 | **-0.010秒** |
| 記録スコア | **68,468,720 = 68,468,720(一致)** |

カクつき解析(120秒窓)も良好で、**プレイ中はほぼ完全に60fps**である。

| 区間 | 実効fps | 落ちフレーム |
|---|---|---|
| 100秒〜 | 59.90 | 13(02:07.8に1、03:36.9に12) |
| 350秒〜 | **60.01** | **0** |
| 550秒〜 | 59.99 | 2 |

## 9.7 Extraステージの理論尺は系統的にマイナスに出る

修正版で `th6_10.rpy`(Extra)をフル尺録画した結果、理論尺比較が **-5.40%**(実プレイ
715.6秒に対し理論尺756.5秒)になった。ただし **記録スコア 68,468,720 と完全一致**しており
再生は完走している(`scripts/53_verify_replay_score.py` で確認)ので、録画不良ではない。

| リプレイ | 難易度 | 実プレイ/理論尺 |
|---|---|---|
| `th6_02.rpy` | Normal | **+0.33%** |
| `th6_22.rpy` | Lunatic | **+0.09%** |
| `th6_10.rpy` | **Extra** | **-5.40%** |

通常ステージ・Lunaticは理論尺とよく一致するのに、Extraだけ大きくマイナスに出る。
th06c(`reports/74`〜`77`)と同じ性質なので、**th06ncのExtraでも理論尺比較は
「超過方向」の検出にのみ使うこと。**

## 9.8 修正版でのフル尺録画まとめとインスタンス選定

修正版で通常ステージ(Normal)・Lunatic・Extraをフル尺録画し、4 vCPU と 8 vCPU を比較した。

| リプレイ | インスタンス | 重複フレーム率 | A/V同期差分 | 理論尺 | 記録スコア |
|---|---|---|---|---|---|
| `th6_02` Normal | g6f.2xlarge(8 vCPU) | 0.1% | -0.009秒 | +0.33% | **一致** |
| `th6_02` Normal | g6f.xlarge(4 vCPU) | 0.4% | -0.683秒 | +0.73% | **一致** |
| `th6_22` Lunatic | g6f.2xlarge(8 vCPU) | **0.0%** | -0.009秒 | -0.23% | **一致** |
| `th6_10` Extra | g6f.2xlarge(8 vCPU) | 0.1% | -0.010秒 | -5.40%(§9.7) | **一致** |

区間別の実効fps(120秒窓):

| 録画 | 区間1 | 区間2 | 区間3 | 区間4 |
|---|---|---|---|---|
| Normal 8 vCPU | **60.01**(0) | **60.01**(0) | 59.63(46) | — |
| Normal 4 vCPU | 59.67(40) | 59.93(9) | 59.61(48) | — |
| Lunatic 8 vCPU | 59.90(13) | **60.01**(0) | 58.45(187) | **60.01**(0) |
| Extra 8 vCPU | 59.90(13) | **60.01**(0) | 59.99(2) | — |

括弧内は落ちフレーム数。Lunaticの1100秒台にある187フレームは
**19:55.5〜19:58.6の3秒間に7回連続**しており、キャプチャ起因の周期的な脱落ではなく
「3秒ほど画面がほぼ静止する演出」の形をしている(§9.4 の判別基準どおり)。

### 選定: g6f.xlarge(4 vCPU)で十分

* 4 vCPUの残存脱落は1〜4フレームの散発的なものと、演出由来の大きな単発のみで、
  **周期性は無い**(§9.4 の基準で defect ではない)
* 8 vCPUの方がわずかに綺麗(0フレームの区間が出る)だが、体感差が出るレベルではない
* **eu-south-2のG系スポットクォータは8 vCPU**なので、
  **g6f.xlargeなら2台(並列2録画)、g6f.2xlargeなら1台**しか立てられない。
  並列運用の余地を残す意味でも g6f.xlarge が有利

ただし4 vCPUでは以下の点に注意すること。

* 映像・音声ffmpegの**起動レイテンシ差が -0.683秒**と大きく出た(8 vCPUでは-0.009秒)。
  `-copyts` + `-itsoffset` で補正されるので出力の同期は取れているが、
  この補正機構が無いと致命的にずれる
* 理論尺が +0.73%(8 vCPUは+0.33%)とやや大きい

## 9.9 1080p録画の実現性(ユーザー依頼による追加検証)

th06ncはウィンドウ解像度を 1280x720 / 1920x1080 から選べる。1080pでの録画が
現実的かを検証した。

### 9.9.1 【重要】Xorg経路では`th06.env.1080p`がそのままでは効かない

`TH06NC_ENV_FILE=games/th06nc/th06.env.1080p` を指定しても、**ウィンドウは
1024x768 で作られた**。byte[5] を 0〜18 で総当たりしても、**4(=1280x720)以外は
すべて 1024x768 に落ちる**。

| byte[5] | Xvfb上(フェーズ78) | **Xorg+nvidia上(本フェーズ)** |
|---|---|---|
| 0 | 1920x1080 | 1024x768 |
| 3 | 1920x1080 | 1024x768 |
| 4 | 1280x720 | 1280x720 |
| 5 | 画面いっぱい | 1024x768 |

**原因は「プライマリ出力の現在のCRTCモード」だった。**

```bash
$ DISPLAY=:88 xrandr | head -3
Screen 0: minimum 8 x 8, current 2200 x 1400, maximum 30720 x 17280
DVI-D-0 connected primary 1024x768+588+316 ...   # <- 仮想画面2200x1400なのにモードは1024x768
```

Xorg + nvidia で `Virtual 2200 1400` の画面を作ると、**仮想画面は2200x1400になるが
CRTCの実モードは1024x768のまま**になる。th06ncはモニタの現在のモードを見て
ウィンドウ解像度の選択肢を決めるため、1080pを選べなくなっていた。Xvfbでは
「画面サイズ=モード」なので、この問題はフェーズ78では顕在化しなかった。

`xrandr --output DVI-D-0 --mode 1920x1080` を打つと、フェーズ78のXvfb実測と
完全に一致する結果になる(0/3/5 → 1920x1080、4 → 1280x720)。

対策として `scripts/78_start_gpu_display.sh` に **`--crtc-mode`**(環境変数
`GPU_CRTC_MODE`)を追加し、Xorg起動後に `xrandr --output <出力> --mode` を打つように
した。`scripts/25` は `GAME_CONFIGS` の `crtc_mode` をそのまま渡す。

```bash
scripts/78_start_gpu_display.sh --display :88 --screen 2200x1400 --crtc-mode 1920x1080
```

**仮想画面(`--screen`)はウィンドウ+装飾が収まる大きさ(2200x1400)のまま、
CRTCモードだけを1920x1080にするのが要点**。CRTCは仮想画面へのビューポートに過ぎず、
x11grabはルートウィンドウから取るので、ウィンドウがビューポート外にあっても録画できる。

### 9.9.2 解像度依存の除外矩形をスケールする

`stutter_probe_exclude_rect` 等は1280x720で目視して決めた座標なので、1080pでは
位置がずれる。`scale_exclude_rects()` を追加し、`GAME_CONFIGS` に
`exclude_rect_base: (1280, 720)` がある場合は実ウィンドウサイズへ比例拡大するようにした。

### 9.9.3 実測結果: 1080pは8 vCPUなら実用、4 vCPUでは破綻する

同一リプレイ(`th6_05.rpy`)で比較した(60秒地点から120秒間)。

| | 720p / 8 vCPU | **1080p / 8 vCPU** | **1080p / 4 vCPU** |
|---|---|---|---|
| 実効fps | 59.82 | **58.94** | **54.87** |
| 落ちフレーム | 23 | 128 | **616** |
| カクつきバースト | 4回 | **2回** | **128回**(平均0.94秒間隔) |
| 周期性 | 判定不能 | 判定不能 | R=0.074(周期性なし) |
| 重複フレーム率(scripts/25) | 0.1% | **0.2%** | **7.9%** |
| A/V同期差分 | -0.009秒 | -0.007秒 | -0.043秒 |
| load average | — | 2.4 / 8コア | **4.5 / 4コア(飽和)** |
| ファイルサイズ(6.7分) | 217MB(4.3 Mbps) | 356MB(7.1 Mbps) | 340MB |

**8 vCPU(g6f.2xlarge)での1080pは実用品質。** 落ちフレーム128は2回の塊
(01:35.8に21、02:39.5に107)に集中しており、**同じ時刻に720p版でも塊が出ている**
(02:39.1に19フレーム)。ユーザーの目視確認により、これらは1面ボス前会話と
1面リザルト画面=演出上の静止画面であることが確定している(§9.4)。
つまりキャプチャ起因のカクつきは無い。

**4 vCPU(g6f.xlarge)では明確に破綻する。** 128回のバーストが平均0.94秒間隔で
散発し、実効fpsが54.87まで落ちる。周期性が無い(R=0.074)ので、ポーリング干渉
(§9.1)ではなく**純粋なCPU不足**である。load averageも4コアに対し4.5と飽和していた。

### 9.9.4 運用上のトレードオフ

* **eu-south-2のG系スポットクォータは8 vCPU**なので、1080pを選ぶと
  **g6f.2xlarge 1台=並列録画不可**になる。720pなら g6f.xlarge 2台で並列2録画ができる
* ビットレートが1.65倍(25分の録画で約2.0GB対1.2GB)になり、
  CloudFrontの無料枠1TB/月の消費も比例して増える

### 9.9.5 副産物: 空の録画が「正常」と判定される不具合を発見・修正

1080pの初回実行で、openboxがウィンドウを **x=-3, y=-16**(画面左上の外側)に置き、
x11grabが1フレームも取れずに空の動画ができた。にもかかわらず
**「試行1で正常な録画を確認しました」と成功扱いになった**。原因は2つで、両方修正した。

1. `skip_origin_move_if_fits` の判定が `x + w <= screen_w` だけで、**負の座標を
   考慮していなかった**(-3 + 1920 = 1917 <= 2200 なので「収まっている」と誤判定)。
   `x >= 0 and y >= 0` を条件に追加した
2. 最終チェックが `if dup_rate is not None and dup_rate > 閾値` という条件で、
   **計測不能(None)のときに異常なしと扱っていた**。`None` は失敗として扱うようにした

## 9.10 th06ncの録画検証はここで完了とする(ユーザー判断、2026-09-12)

以下はユーザー判断により**今回のスコープ外**とし、th06ncの録画検証は完了とする。

| 項目 | 扱い |
|---|---|
| **本番リージョン(eu-south-2)での実機検証** | スコープ外。検証はus-west-2で実施済み。eu-south-2はG系スポットクォータが8 vCPUに緩和されたが、32 vCPUへの再申請を行う |
| **低速録画機能** | スコープ外(th06cと同じ扱い)。th06ncはD3D11経路のため`fps_limiter_hook.h`(D3D9専用)・`fps_limiter_hook_d3d8.h`のいずれも使えず新規実装が必要 |
| **さらなる1080p検証**(フル尺・Extra・Lunatic等) | スコープ外。§9.9の短尺比較で「8 vCPUなら実用、4 vCPUでは破綻」まで確認済み |

### 新規タイトル対応チェックリストの達成状況

| # | 項目 | 状態 |
|---|---|---|
| 1 | 設定確認(ウィンドウモード) | 完了(`th06.env`、720p/1080p) |
| 2 | 起動確認 | 完了 |
| 3 | MOD開発・動作確認 | 完了 |
| 4 | フル尺録画(通常+Extra) | **完了**(Normal・Lunatic・Extraの3本、いずれも記録スコア完全一致) |
| 5 | 録画品質確認 | **完了**(重複フレーム率0.0〜0.4%、実効fps 60.01の区間あり) |
| 6 | 音ズレ確認 | **完了**(A/V同期差分 -0.007〜-0.043秒) |
| 7 | 低速録画機能 | **スコープ外**(ユーザー判断) |
| 8 | 内部データ取得(スコアRVA) | 完了(フェーズ79。ステージ番号・残機・グレイズは未特定) |
| 9 | クラウド実機検証 | **完了**(us-west-2 / g6f.xlarge・g6f.2xlarge。本番リージョンでの再確認はスコープ外) |

### 推奨構成(まとめ)

* **インスタンス: `g6f.xlarge`(4 vCPU / NVIDIA L4の1/8スライス)、720p録画**
* **描画: Xorg + nvidia(GRIDドライバ)、DXVK(D3D11→Vulkan)経路**
* 1080pが必要な場合のみ `g6f.2xlarge`(8 vCPU)+ `--crtc-mode 1920x1080`
* **th06ncはCPUのみのインスタンスでは録画できない**(llvmpipeでは720pで約9fps)ため、
  他8タイトルとは別系統のインスタンスタイプを使う必要がある

## 10. 運用上の注意(実際に踏んだもの)

### 10.1 新規インスタンスでは最初のwine起動がタイムアウトする

AMIから立てた直後の1本目の録画は、ほぼ必ず以下のどちらかで失敗する。

```
ERROR: th06nc.exe プロセスが検出できませんでした     (検出待ち20秒)
ERROR: ゲームウィンドウが検出できませんでした         (検出待ち20秒)
```

wineserverのコールドスタート(prefixの初回チェック)に時間がかかるためで、環境自体は
正常である。**録画前に1度ゲームを起動して捨てるウォームアップを行うこと。**

```bash
cd ~/touhou-recorder/instances/th06nc-multigame-recording-test
WINEPREFIX=~/touhou-recorder/prefixes/th06nc-wined3d-gl DISPLAY=:88 LANG=ja_JP.UTF-8 \
  WINEDLLOVERRIDES='d3d11,dxgi,d3d10core=n' \
  setsid nohup wine injector64.exe th06nc.exe th06nc_hook.dll > /tmp/warmup.log 2>&1 &
sleep 45
# 後片付け(自分自身のシェルをkillしないよう $$ を除外すること)
for p in $(ps -eo pid,args | grep -E 'th06nc\.exe|wineserver|winedevice|injector64' \
           | grep -v grep | awk -v me=$$ '$1!=me {print $1}'); do kill -9 $p; done
```

### 10.2 AMIからクローンしたインスタンスではPulseAudioのソケットが衝突する

`E: [pulseaudio] socket-server.c: bind(): Address already in use` で起動に失敗し、
音声ffmpegが `Error opening input: No such process` で落ちる(映像だけ録れて
muxで失敗する)。起動前に消すこと。

```bash
rm -rf /run/user/1000/pulse ~/.config/pulse
setsid nohup pulseaudio --exit-idle-time=-1 --disallow-exit > /tmp/pulse.log 2>&1 < /dev/null &
```

### 10.3 スポット中断は普通に起きる

本フェーズでも g6f.xlarge(`<INSTANCE_ID>`)がフル尺録画の最中に
`StateTransitionReason: Service initiated` で終了した。**長尺の録画結果は
こまめに手元へ回収すること**(25分の録画を1本失った)。

### 10.4 プロセスをkillするパターンに自分自身を含めない

`ps -eo pid,args | grep -E 'th06nc|wineserver|...'` はSSHで送り込んだシェル自身の
コマンドラインにも一致するため、そのままkillすると**自分が死んで以降の処理が
実行されない**(rm・mkdir・録画開始が全て無言でスキップされる)。
`awk -v me=$$ '$1!=me'` で除外すること。AGENTS.mdの`pkill -f`の注意と同根。

### 10.5 `scripts/78 --stop` が落とすべきプロセス名

Xorgの実体は `/usr/lib/xorg/Xorg` なので `X :88` では一致しない。また
root権限で起動しているのでユーザー権限のkillでは落ちない。両方対応済み。

## 11. 成果物

| パス | 内容 |
|---|---|
| `scripts/78_start_gpu_display.sh` | `--backend auto/xorg/weston` 対応(NVIDIAはXorg経路) |
| `runs/th06nc_aws/smoke_wined3d/` | wined3d経路のスモークテスト録画 |
| `runs/th06nc_aws/smoke_dxvk/` | DXVK経路のスモークテスト録画 |


## 12. 次にやること(th06ncのスコープ外項目)

* eu-south-2のG系スポットクォータを32 vCPUへ再申請し、本番リージョンでの実機検証を行う
* 低速録画機能(D3D11経路での新規実装が必要)
* 1080pのフル尺検証(必要になったら)
* ステージ番号・残機・グレイズのRVA特定(`.chapters.txt`出力の対応)
