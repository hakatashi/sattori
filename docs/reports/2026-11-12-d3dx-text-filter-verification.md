# 文字の縮小フィルタ補完(d3dx_filter_hook)をsattoriのMODに取り込み、5タイトルをローカル録画で確かめる

- **検証日**: 2026-11-12
- **対象**: th10・th11・th12・th128・th13のMOD(`thNN_hook.dll`)に`d3dx_filter_hook`(既定で有効)を
  組み込んだもの([`decisions/0071`](../decisions/0071-d3dx-text-downscale-filter-in-mod.md))
- **環境**: HakataMatrix(Ryzen 7 5700X)。本番のCPUワーカーイメージ(`sattori-worker:latest`、ECR)を
  Dockerで実行し、S3の現行タイトル資産のhook DLLだけを差し替えた(`verify-recording-locally` skill)。
  `--cpuset-cpus 0-3,8-11`(8スレッド)、等倍、`--max-attempts 1`、1本ずつ直列。`sattori-home-worker`は停止中
- **結論**: 5本とも試行1回で完走し、最終スコアはリプレイの記録値(touhou-recorder reports/102の録画)と一致。
  文字はtouhou-recorderの`D3DX_AREA_FILTER=1`と同じ描画になり、フィルタなし(現行の本番)よりなめらかになった。
  タイトル資産を差し替えた本番でもth13・th11の2本がdone・スコア一致で、配信版の文字も同じだった(§3)

品質(落ち率・理論尺)の評価はtouhou-recorder reports/101・102(AWS `c7i.2xlarge`でフィルタの有無を各2回比較し、
差が無かった)で済んでいるので、ここではsattoriのビルド・ワーカーイメージで同じ効果が出ることだけを確かめた。

## 1. 方法

- MODは`make -C worker/mods th10 th11 th12 th13 th128`でビルドした(警告なし)。
- リプレイはreports/102と同じもの: th10_03(Extra、813.8秒)、th11_04(Extra、1018.8秒)、th12_01(Extra、690.9秒)、
  th128_extra01(Extra、1321.8秒)、th13_06(Extra、765.1秒)。
- フックの動作はMODログ(`D3DXFilterHook: area-filtered ...`)で確かめた。MODログはコンテナ内の
  `/app/instances/<game>-recording/`にあるので、録画中に`docker cp`で取り出した(th10は取り出す前に終わったため無し)。
- 文字の比較: reports/102のフィルタあり(A)・フィルタなし(B)の録画と、今回の録画(S)から同じゲームフレームを探した
  (画面全体の平均絶対差が最小のフレーム)。AとBで輝度差が24を超える画素をマスクにし、マスク内で
  SとA・Bとの平均絶対差を比べた。th13のBはreports/101の`baseline.mp4`。

## 2. 結果

| タイトル | 終了検知 | 総録画 | 重複フレーム率(15〜45秒) | 最終スコア | 縮小転送(MODログ) | マスク内平均差 S-A / S-B |
| --- | --- | --- | --- | --- | --- | --- |
| th10 | テンプレート照合 | 830.4秒 | 0.0% | 155,470,620(805秒地点の画面でAと一致) | (ログなし) | 11.5 / 41.4、13.0 / 49.1 |
| th11 | 画面静止 | 1050.6秒 | 0.9% | 47,848,439(一致) | 730x36→354x17 | 17.1 / 44.3、18.4 / 49.6 |
| th12 | 画面静止 | 720.8秒 | 0.6% | 19,569,963(一致) | 730x36→354x17 | 10.8 / 65.5、13.9 / 51.0 |
| th128 | 画面静止 | 1371.2秒 | 3.8% | 10,084,516(一致) | 1024x44→512x20 | 7.2 / 92.8 |
| th13 | 画面静止 | 821.3秒 | 5.4% | 11,716,879×10(一致) | 1024x44→512x20 | 9.4 / 67.9、21.0 / 52.1 |

- 縮小転送の形はreports/102 §1の表と同じで、`InstallD3DXFilterHook: hooked d3dx9_NN.dll!D3DXLoadSurfaceFromMemory`
  (th10は`d3dx9_31`)が全タイトルで出た。
- マスク内平均差は、背景が乱数で動く場面(th11の雪、th13の花びら)を除いた、文字が出ている場面の値。どの場面もSは
  フィルタあり(A)に近い。文字の範囲を切り出して並べた画像でも、Bに比べてSの文字の縁に中間階調が付いていた
  (`/mnt/cache3/sattori-<title>-verify/d3dx-filter-sattori/compare/`)。
- th128・th13の重複フレーム率が高めなのは、8スレッドに絞ったことによる(th13の等倍の本番は`c7i.4xlarge`、
  [`decisions/0070`](../decisions/0070-th13-native-on-4xlarge-and-half-speed-on-2xlarge.md))。フィルタの負荷は
  reports/101 §10で現行と同等と確認済み。

録画・ログは`/mnt/cache3/sattori-<title>-verify/d3dx-filter-sattori/`にある。

## 3. 本番E2E(簡易)

5タイトルのタイトル資産(S3の現行アーカイブのhook DLLだけを差し替えたもの。ファイル一覧は元と同一)を
アップロードし、eu-north-1のレプリカへの複製(ETag一致)を確かめてから、API経由で2本流した
(`verify-recording-in-production` skill。Lambda・ワーカーイメージ・フロントエンドは変更なし)。

| タイトル | 録画した段 | 結果 | 配信版の尺(理論尺比) | 文字(マスク内平均差 S-A / S-B) |
| --- | --- | --- | --- | --- |
| th13(th13_06) | `c7i.4xlarge` 等倍 | done、`desyncDetected=false`、`timedOut=false` | 775.0秒(+1.3%) | 12.1 / 72.3 |
| th11(th11_04) | `c7i.2xlarge` 等倍 | done、`desyncDetected=false`、`timedOut=false` | 1023.1秒(+0.4%) | 17.0 / 42.3 |

- th11はGPU 2倍速の段から始まるが、eu-south-2・eu-north-1ともGPUのSpot在庫が無く(`capacityExhaustedTargets`)、
  CPU等倍の段で録った。**GPUワーカー(倍速)でのフィルタの動作は本番では確かめていない**。d3dx9の縮小はGPUの有無に
  かかわらずWine内のCPU処理なので、効き方は変わらないはず。
- 配信版はウォーターマーク付き。比較画像は`/mnt/cache3/sattori-<title>-verify/d3dx-filter-sattori/e2e/`。
- 品質の数値評価(落ち率等)は、ユーザーの判断によりtouhou-recorder reports/102 §3のAWS比較で代える。
- 元のアーカイブは`/mnt/cache3/sattori-d3dx-assets/<title>/orig.tar.gz`に退避した(差し戻し用)。
