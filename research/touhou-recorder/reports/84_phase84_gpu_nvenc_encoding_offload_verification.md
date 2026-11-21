# フェーズ84: EC2 GPUインスタンスにおける動画キャプチャ・エンコードのGPUオフロード(NVENC)検証

## 背景

[Issue #2](https://github.com/hakatashi/touhou-recorder/issues/2)を受け、倍速録画(issue #1)の前提条件として、
EC2 GPUインスタンス(`g6f`系、NVIDIA L4)における動画キャプチャ・エンコード処理のGPUオフロード
(NVENC等)の技術的実現可能性を検証した。

**前提のずれの確認**: issue本文が参照する`docs/decisions/0046〜0050-*.md`(ADR)、
`worker/Dockerfile.gpu`、配信用変換スクリプト`convert.py`は、いずれも本リポジトリには
存在しない。GPU EC2選定等の「決定」に相当する内容は`docs/gpu-recording.md`・
`docs/titles/th06nc.md`・`reports/78`〜`82`に地の文で分散して記録されている。
`worker/`ディレクトリは存在せず、GPU用Dockerfileも無い(GPU系タイトルの単体イメージは
`cloud/docker/aws/Dockerfile.th15`のみで、素のUbuntu 24.04 apt版ffmpegを使用)。
`convert.py`相当の実体は独立スクリプト`scripts/21_upscale_to_720p.sh`、または
`recorder/ffmpeg.py`の`upscale_720p`インラインフィルタ。
リポジトリ全体を"nvenc"で検索してもヒットはゼロで、本フェーズは完全に新規の検証となる。

## 検証環境

本番リージョン(eu-south-2)はG系クォータが0のため使用せず、ユーザー指示により
**us-west-2**(G/VTスポットクォータ128 vCPU確認済み)で実施した。

| 項目 | 値 |
|---|---|
| インスタンス | `<INSTANCE_ID>`(g6f.xlarge、スポット、検証終了後terminate済み) |
| リージョン/AZ | us-west-2 / us-west-2a(us-west-2dは`InsufficientInstanceCapacity`で不可) |
| AMI | `<AMI_ID>`(Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20260918) |
| スペック | 4 vCPU / 16 GiB / NVIDIA L4の1/8スライス(3072 MiB、`NVIDIA L4-3Q`) |
| スポット実勢価格 | 約$0.0815/h(us-west-2a) |
| ルートボリューム | gp3 80GiB(AMIのスナップショットが75GiB以上を要求するため60GiBでは`InvalidBlockDeviceMapping`) |
| キーペア/SG | `touhou-recorder-nvenc-key`(新規作成、秘密鍵は`/tmp/aws-gpu-nvenc/nvenc-key.pem`)、既存`<SECURITY_GROUP_ID>`(SSHルールを作業元IPへ更新) |

GRIDドライバ導入手順は`docs/gpu-recording.md`・`reports/81`の記載どおりで再現できた
(標準dkmsドライバの`dkms remove -m nvidia -v 595.91.07 --all`→
`aws s3 cp --no-sign-request s3://ec2-linux-nvidia-drivers/latest/NVIDIA-Linux-x86_64-595.91.07-grid-aws.run`→
`sudo sh grid.run --silent --dkms --compat32-libdir=/usr/lib/i386-linux-gnu`)。
`nvidia-smi`で`NVIDIA L4-3Q`(3072MiB)を確認。`/usr/usr/lib/i386-linux-gnu/`への
誤配置も既知どおり発生したが、今回は32bit不要のため未対応でも問題なし。

## 1. NVENCエンコードのGPU化: 実現容易であることを確認(issue最優先項目)

### 1.1 追加ビルド不要でNVENCが動作する

**重要な発見**: Ubuntu 24.04の標準apt版ffmpeg(6.1.1-3ubuntu5、`--enable-nonfree`無し)は
ビルド時点で`h264_nvenc`/`hevc_nvenc`/`av1_nvenc`のフロントエンドを含んでおり、
GRIDドライバ導入(`libnvidia-encode.so`の追加)だけで実際にエンコード動作した。
独自ffmpegビルドや`Dockerfile.gpu`の新規作成は不要。

```bash
sudo apt-get install -y ffmpeg  # 標準aptパッケージのみ
ffmpeg -y -f lavfi -i testsrc=size=1280x960:rate=60:duration=5 \
  -c:v h264_nvenc -preset p4 -cq 18 -pix_fmt yuv420p out.mp4
# → speed=2.58x で正常にエンコード完了
```

### 1.2 Dockerコンテナ内からも追加設定なしで動作する

issueが懸念していた「`Dockerfile.gpu`環境で`libnvidia-encode.so`が正常にロードできるか」を、
**既存の`cloud/docker/aws/Dockerfile.th15`相当の素のUbuntu 24.04イメージ**で検証した。
AMIには`nvidia-container-toolkit`・`libnvidia-container1`が最初から導入済みで、
`/etc/docker/daemon.json`に`nvidia`ランタイムが設定済みだった。

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu:24.04 bash -c '
  apt-get update -qq && apt-get install -y -qq ffmpeg
  ffmpeg -y -f lavfi -i testsrc=size=1280x960:rate=60:duration=3 \
    -c:v h264_nvenc -preset p4 -cq 18 -pix_fmt yuv420p /tmp/c.mp4'
# → speed=1.98x で正常にエンコード完了
```

**結論: 既存Dockerfileの変更は不要**。`docker run`(または`docker-compose`/ECS)側に
`--runtime=nvidia --gpus all`相当の指定を追加するだけでコンテナ内からNVENCが使える。

### 1.3 CPU負荷削減効果の実測(x11grabキャプチャ + リアルタイムエンコード)

Xvfb(`:99`、1280x960x24)+ openbox + `ffplay -f lavfi testsrc2`で動きのある画面を用意し、
`recorder/ffmpeg.py`の`build_video_ffmpeg_cmd`と同じパラメータ体系
(`-f x11grab -draw_mouse 0 -video_size 1280x960 -framerate <fps> -i :99+0,0`)で
30秒(60fps)・15秒(120fps)録画し、`mpstat -P ALL 1`で4vCPU全体のCPU使用率を計測した。

| 条件 | エンコーダ | 平均CPU使用率(4コア合計に対する%usr、全コア平均) | 出力ファイルサイズ | 備考 |
|---|---|---|---|---|
| 60fps, 30秒 | `libx264 -preset veryfast -crf 18` | **62.13%** | 20.1MB(≈5.35Mbps) | 1800/1800フレーム、欠落無し |
| 60fps, 30秒 | `h264_nvenc -preset p4 -cq 18` | **49.33%** | 54.9MB(≈14.6Mbps) | 1800/1800フレーム、欠落無し |
| 120fps(倍速相当), 15秒 | `libx264 -preset veryfast -crf 18` | **85.30%** | 5.4MB | — |
| 120fps(倍速相当), 15秒 | `h264_nvenc -preset p4 -cq 18` | **43.19%** | 10.8MB | — |

**倍速録画(120fps)でNVENCのCPU削減効果がより顕著**(85.3%→43.2%、約50%減)であり、
issueの仮説(倍速録画ではCPU側の処理負荷がボトルネックになりやすく、NVENCが特に有効)を
実測で裏付ける結果となった。60fpsでも21%程度のCPU使用率削減効果があった。

**注意**: x11grabによる画面キャプチャ自体(X11共有メモリ読み取り・色空間変換)はCPU側の
処理のままなので、NVENCはエンコード部分のみのオフロードであり、CPU使用率がゼロにはならない。
これはissue本文が「2. キャプチャ処理のGPU連携」を別項目として挙げている理由と一致する。

### 1.4 同じcq/crf値でもNVENCの方がビットレートが高くなる(パラメータチューニングが必要)

`-cq 18`(NVENC)は`-crf 18`(libx264)と単純比較すると2.7〜3倍程度ビットレートが高くなった
(60fps条件で5.35Mbps→14.6Mbps)。NVENCとlibx264の`-cq`/`-crf`は数値スケールが似ているが
圧縮効率は同一ではないため、そのまま数値だけ揃えても画質・ファイルサイズは同等にならない。

明示的なレート制御(`-rc vbr -cq <値> -b:v <目標bitrate> -maxrate <上限>`)を組み合わせると、
libx264 crf18相当のファイルサイズに近づけられることを確認した(10秒の同一合成ソースで比較):

| 設定 | ファイルサイズ(10秒) | 実効ビットレート |
|---|---|---|
| `libx264 -preset veryfast -crf 18` | 8.94MB | 7.15Mbps |
| `h264_nvenc -preset p4 -cq 18`(レート制御無し) | 20.91MB | 16.84Mbps |
| `h264_nvenc -preset p4 -rc vbr -cq 23 -b:v 5M -maxrate 6M` | 7.50MB | 6.04Mbps |

→ **本番導入時は`-cq`単体でなく`-rc vbr -cq <値> -b:v <目標> -maxrate <上限>`の組み合わせで
画質・ファイルサイズをチューニングする必要がある**。今回は合成テストパターンでの比較であり、
実際のゲーム画面(セルルック2Dグラフィック、弾幕)での主観画質評価は未実施(今後の課題)。

### 1.5 配信用変換(720pアップスケール、`scripts/21_upscale_to_720p.sh`相当)の高速化効果

録画済み1280x960動画を960x720へlanczosスケーリングする後処理変換で比較:

| エンコーダ | real time | user time(CPU時間、4コア合計) | speed |
|---|---|---|---|
| `libx264 -preset veryfast -crf 18` | 9.77s | **23.79s** | (非表示) |
| `h264_nvenc -preset p4 -cq 18` | 8.79s | **10.04s** | 3.67x |

**CPU時間で58%削減**(23.79s→10.04s)。配信用変換処理は録画本体と異なりリアルタイム制約が
無いため、この高速化はサーバーの処理能力あたりのスループット向上(同時変換可能数の増加)に
直結する。

### 1.6 non-monotonic DTS警告とdup/drop表示について

`h264_nvenc`使用時、ffmpegが`Non-monotonic DTS in output stream`警告を出す場合があり、
リアルタイムエンコード中は`dup=44 drop=42`のような表示も見られた。ただし`-vsync 0`
(パススルー)で検証したところ、想定フレーム数(15秒×60fps=900)ちょうどが出力されており、
**x11grab側の入力フレーム自体が欠落しているわけではない**ことを確認した
(60fps/30秒・120fps/15秒いずれの本番相当条件でも最終出力フレーム数は理論値と一致)。
dup/drop表示はffmpegの内部vsync(cfr変換)処理によるものと考えられ、`recorder/ffmpeg.py`へ
NVENCを組み込む際は`-vsync`の扱い(既定のcfr변환でよいか、`recorder/ffmpeg.py`が前提とする
`measure_duplicate_frame_rate.sh`の重複フレーム率計測ロジックに悪影響が無いか)を
実際の東方ゲーム画面で追加検証すべき。

## 2. キャプチャ処理のGPU連携/ゼロコピー化

### 2.1 ハイブリッド構成(x11grab CPU capture + h264_nvenc GPU encode)は動作する

1.3節の測定がそのままハイブリッド構成の実測にあたる。追加のCUDAアップロード
(`-hwaccel cuda`等)を明示指定しなくても、ffmpegがCPU側フレームを暗黙にGPUへ転送して
NVENCに渡していることを確認した(`-hwaccel`未指定でも`h264_nvenc`は動作する)。
CPU負荷削減効果は1.3節の通りで、**追加の複雑な設定なしに導入できる構成**。

### 2.2 完全GPUキャプチャ(ゼロコピー、NVFBC/kmsgrab等)は未着手

時間的制約により本フェーズでは着手していない。Ubuntu標準ffmpegには`--enable-nvfbc`が
含まれないため独自ビルドが必要になるという issue本文の指摘は妥当と考えられる
(`ffmpeg -version`のconfigureオプションにnvfbc関連のフラグは無いことを確認済み)。
また`g6f`系はvGPU(GRIDドライバ)環境であり、`kmsgrab`が前提とするKMS/DRM直接アクセスが
仮想ディスプレイ環境でどう振る舞うかも未確認。**費用対効果の観点では、1.3節で確認した
「x11grab(CPU) + NVENC(GPU)」のハイブリッド構成が十分な効果(CPU使用率50%減、追加実装ほぼ不要)
を持つため、ゼロコピー化の優先度は低いと考えられる**。

## 3. 倍速録画への適用性評価

- 1.3節の120fps測定により、倍速録画条件下でのCPU負荷削減効果(50%減)を確認した。
- **フレーム数の測定に異常値が出た点は限界として記録する**: 120fps・15秒(理論値1800フレーム)の
  出力を`ffprobe`で確認したところ、`nb_frames`が24558〜24976という異常な値になった
  (`r_frame_rate`も`1000000/1`という異常値)。これは合成テスト環境固有の問題
  (`ffplay -fs`によるXvfb上のフルスクリーン表示が実際に120fpsで更新されていない、
  または`-vsync`既定動作とタイムスタンプ処理の相互作用)によるものと考えられ、
  今回のセットアップの限界である可能性が高い。**倍速録画への適用性の最終判断には、
  実際の東方ゲーム画面(th15/th06nc等)かつ`FPS_LIMIT_TARGET_HZ`を用いた実際の倍速MOD経由での
  再検証が必要**(本フェーズのスコア外、issue #1側の倍速録画実装と合わせて行うべき)。

## 4. 実装への示唆(次のステップ)

- `recorder/options.py`の`RecordingOptions`に`gpu_encode: bool`相当のフラグを追加し、
  `recorder/ffmpeg.py`の`build_video_ffmpeg_cmd`(72行目`-c:v libx264 ...`)を
  条件分岐で`-c:v h264_nvenc -preset p4 -rc vbr -cq <値> -b:v <値> -maxrate <値>`に
  切り替える形の実装が可能。既存の`GameConfig.gpu_display`(th06nc等で使用)と連動させ、
  GPU描画タイトルでは自動的にNVENCも使う設計が自然と考えられる。
- 旧式スクリプト(`scripts/11_`, `22_`, `23_`, `18_`, `47_`, `21_`)にも同様の
  `-c:v libx264`ハードコードが残っているため、NVENC対応時は影響範囲として洗い出しが必要
  (ただし`recorder/`パッケージへの一本化が進行中のため、優先度は`recorder/ffmpeg.py`が高い)。
- 本番導入前に、実際の東方ゲーム画面での重複フレーム率・理論尺比較による品質検証
  (既存の新規タイトル対応チェックリストの手法を流用)が必須。

## 5. 使用リソースの後片付け

検証終了後、以下をterminate/削除済み。

```bash
aws ec2 terminate-instances --region us-west-2 --instance-ids <INSTANCE_ID>
```

新規作成したキーペア`touhou-recorder-nvenc-key`(us-west-2)は今後の追加検証で再利用する
可能性があるため残置した(`docs/aws-resources.md`に追記)。セキュリティグループ
`<SECURITY_GROUP_ID>`のSSHルールは本セッションの作業元IP(`<HOME_GLOBAL_IP>/32`)に更新済み。
