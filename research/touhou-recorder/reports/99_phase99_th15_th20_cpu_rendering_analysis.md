# フェーズ99: th15・th20のCPU描画(wined3d+llvmpipe)の律速調査

日付: 2026-11-10。**クラウドリソースは使っていない。** 検証はローカル(Ryzen 7 5700X、8コア16スレッド、Wine 9.0、Mesa 25.2.8)。GPUには触れていない。

## 結論

1. **th15・th20には、th06ncのBC7のような「特定の遅い処理」は無かった。** 描画の中身を記録するD3D9フックを作って調べたところ、1フレームの描画コールは60〜360と少なく、テクスチャもA8R8G8B8・A4R4G4B4だけ。律速はllvmpipeのラスタライズ(アルファブレンド・フィルタ付きのスプライト、加算エフェクト、全画面の合成を合わせて1フレームに画面2.4〜6.8枚分の塗りつぶし)そのもので、**処理能力は使えるCPUにほぼ比例する**(th15 Extra: 4コア8スレッド61Hz → 8コア83Hz → 8コア16スレッド約100Hz)。ゲーム本体やwined3dの単一スレッドは律速ではなかった(th20の本体はth15の約3倍重いが、落ち込み時も22〜50%)。
2. **試した削減策はどれも効かなかった**(平均の誤差は±3〜6Hz):

   | 試したこと | th15 Extra 平均Hz(ベース98.5/100.5) |
   |---|---|
   | A4R4G4B4テクスチャをA8R8G8B8へ格上げ | 94.2 |
   | 意味のない深度テスト(ALWAYS・書き込みなし)を切る | 91.6 / 97.2 |
   | 色を変えない全画面描画を省く | 画面が崩れた(アルファのマスクを書く描画だった) |
   | レンダーテクスチャの等倍コピーをStretchRectへ置き換え | 99.4 |
   | DXVK(d3d9)+lavapipe | 84.9(遅くなる) |

3. **効くのは内部解像度だけ。** cfgの1バイトで描画を960x720にすると、**4コア8スレッド(`c7i.2xlarge`相当)の処理能力が、1280x960の8コア16スレッド(`c7i.4xlarge`相当)とほぼ同じ**になった(th15 Extra 平均88.8Hz・下位5% 50.1、th20 Lunatic 89.1・55.4)。現行の`c7i.4xlarge` 1/2倍速を`c7i.2xlarge` 1/2倍速へ下げられる見込みで、**Spot単価はほぼ半分**($0.0769→$0.0383/時、reports/96)。ただし画質は下がる(§7の比較画像)。採用は視聴判断と、`c7i`での実測を条件とする。
4. 調査の道具として、D3D9の描画記録フック(`D3D9_PROBE=1`)、スレッド別CPUの記録、倍速で上限を外すベンチマーク(`scripts/99_bench.sh`)を整えた。D3D9タイトル全般に使える。

## 背景

reports/96でth06ncのCPU描画が遅い原因(BC7テクスチャ)を描画の中身から特定し、9fps→60fpsにした。GPUが使えないときに録画が高くつく残りのタイトルはth15・th20(どちらもD3D9、現行は`c7i.4xlarge`の1/2倍速、reports/91)。同じ手順で律速を探した。

## 1. 道具

D3D9はwined3d(OpenGL)経路でVulkanを通らないため、reports/96のVulkanレイヤーは使えない。perfは`perf_event_paranoid=4`で一般ユーザーから使えない。代わりに次を用意した。

| 道具 | 内容 |
|---|---|
| `scripts/99_thread_sampler.py` | ゲームプロセスのスレッド別CPU使用率(/procのutime+stimeの差分、2秒間隔)と、システム全体の使用率(`__system__`行)。`llvmpipe-N`・`wined3d_cs`・ゲーム本体を区別できる。集計は`scripts/99_summarize_threads.py` |
| `mods/common/d3d9_probe_hook.{h,cpp}` | `D3D9_PROBE=1`で有効になるIDirect3DDevice9のvtableフック。300フレームごとに1フレームあたりの描画コール数・頂点数・クリア・描画先切替を、`D3D9_PROBE_DUMP_EVERY`フレームごとに1フレーム分の全描画を状態(描画先・テクスチャ形式とサイズ・ブレンド(分離アルファ含む)・アルファテスト・深度(有効/書き込み/比較)・カラー書き込み・シェーダー・FVF・フィルタ)ごとにまとめ、`D3DQUERYTYPE_OCCLUSION`で描画ごとの通過サンプル数(≒塗りつぶしたピクセル数)を記録する。`InstallFpsLimiterHook()`のCreateDeviceからコールバックで受け取る(`g_d3d9DeviceCreatedCallback`。登録しないタイトルのビルド・動作は変わらない)。§4〜6の実験用スイッチ(`D3D9_PROMOTE_A4R4G4B4`、`D3D9_ZTRIM`、`D3D9_SKIP_NOOP`、`D3D9_COPY_TO_BLIT`)も同じファイルにある |
| `GALLIUM_HUD` のダンプ | `GALLIUM_HUD="fps,ps-invocations,samples-passed,ia-vertices,clipper-primitives-generated" GALLIUM_HUD_VISIBLE=false GALLIUM_HUD_DUMP_DIR=<dir>`で、llvmpipeのパイプライン統計をファイルへ出せる(画面には描かない)。llvmpipeは`draw-calls`を持たない |
| `scripts/99_bench.sh` | 処理能力のベンチマーク。倍速フック(`SPEED_HACK_MULTIPLIER=4`、`FPS_LIMIT_TARGET_HZ=240`、`BENCH_MULT`で変更)で上限を外し、描画が許す限り速くリプレイを回す。FpsMonitorのHzがそのまま「1秒に描けるフレーム数」になり、重い場面にも早く着く(th15 Extra 764秒を約8分、th20 Lunatic 1690秒を約18分)。キャプチャは30fps(`CAPTURE_FRAME_RATE_HZ=30`)、stutter probeは止める(`STUTTER_PROBE_ACTIVE_UNTIL_SEC=0`、本フェーズで`recorder/stutter.py`へ追加)、MODのメニュー待ちは`MOD_MENU_TIME_SCALE`(既定1=実時間、本フェーズでth15・th20のMODへ追加)。集計は`scripts/99_bench_summary.py <log> [区間] [最大フレーム数]`(平均・下位5%・最低Hz、ゲーム内1分ごとの平均) |
| `scripts/99_cfg_window_probe.sh` | cfgの1バイトを書き換えてMODなしで起動し、ウィンドウサイズを読む |
| `scripts/99_quality_compare.sh` | 同じリプレイを1280x960と960x720で等倍録画し、配信版と同じく1440x1080へlanczosで拡大して並べた画像を作る |

MODの再ビルド: `bash mods/th15_replay_autoplay/build_mingw.sh`、`bash mods/th20_replay_autoplay/build_mingw.sh`(th20用は本フェーズで追加。`build.bat`は`speed_hack_hook.cpp`が漏れていて古い)。

ベンチの平均Hzはリプレイ全体(メニュー含む)を処理した平均。th15は同条件2回で98.5/100.5Hz、th20は94.3/88.7Hzだったので、差が±3〜6Hz以内なら誤差とみる。下位5%・最低は5秒窓の値でぶれが大きい。

## 2. th15 Extra(`th15_08.rpy`)等倍の録画中のスレッド別CPU

```bash
python3 scripts/99_thread_sampler.py th15.exe <出力>/threads.tsv 2 &
python3 scripts/25_record_replay_e2e_multigame.py --game th15 --cpu-display --replay th15_08.rpy \
  --max-attempts 1 --max-duplicate-rate 95 --output /mnt/cache3/sattori-th15-verify/phase99/base/extra_1x_16t.mp4
```

FpsMonitorは序盤60Hz、590〜610秒で40Hz、750秒で24.6Hzまで落ちた(reports/91と同じ傾向)。

| 区間 | FpsMonitor | llvmpipe 16本の合計 | llvmpipe 1本の最大 | wined3d_cs | th15.exe |
|---|---|---|---|---|---|
| メニュー(40〜50秒) | 60Hz | 約480% | 38% | 10% | 8% |
| 最も重い区間(745〜762秒) | 24.6Hz | 550〜800% | 56% | 8〜16% | 6〜15% |

fpsが半分以下に落ちても、ゲーム本体・wined3dのコマンドスレッド(llvmpipeの頂点処理・ビニングもここで走る)は飽和していない。ラスタライズのスレッドも半分程度に見えるが、§4のとおりSMTの兄弟スレッドと、同じコアを使うキャプチャ(ffmpeg・Xvfb)を数えると、全体としては計算量律速だった。システム全体の使用率は1600%中1100〜1250%で、残りはPresent時の待ち等と見られる。

## 3. 描画の中身

### 3.1 th15 Extra序盤(`D3D9_PROBE=1`、`th15_09.rpy`の等倍90秒)

- 1フレームあたり描画コール約100〜120(`DrawPrimitive` 約50、`DrawPrimitiveUP` 約55〜67、頂点2,800〜4,800)。シェーダーは使わず固定機能。**描画コールも頂点も少ない。**
- 描画先の切替が1フレームに5回、クリアが7回。描画先は1280x960のレンダーテクスチャ2枚とバックバッファ。
- 通過サンプル数は1フレーム5.6M(1280x960の4.56枚分)、`ps-invocations`は約8.3M。
- テクスチャは全てミップマップなし(lv=1)のMANAGED。形式はA8R8G8B8とA4R4G4B4が半々(他にA8 4x4、R5G6B5が1枚)。生成は`D3DXCreateTexture`/`D3DXCreateTextureFromFileInMemoryEx`、書き込みは`D3DXLoadSurfaceFrom*`(th15・th20とも`d3dx9_43.dll`をインポート)。**BC7のような「明らかに遅い形式」は無い。**

### 3.2 th15 Extra全編の重い場面(`D3D9_PROBE=1 D3D9_PROBE_DUMP_EVERY=3000 scripts/99_bench.sh th15 probe_dump th15_08.rpy`)

遅いフレームは通過サンプル数(塗りつぶし量)が多い。描画コール(62〜200)・頂点(2,500〜13,500)とHzの関係は弱い。

| フレーム | Hz | 描画コール | 通過サンプル(画面何枚分) |
|---|---|---|---|
| 21000 | 95.7 | 62 | 2.74 |
| 6000 | 101.3 | 137 | 4.45 |
| 27000 | 62.5 | 200 | 5.47 |
| 30000 | 50.9 | 112 | 6.40 |
| 36000 | 53.9 | 193 | 6.77 |

最も遅いフレーム36000の内訳(上位):

| 描画 | 通過サンプル |
|---|---|
| 128x128テクスチャの加算(SRCALPHA,ONE)、96ポリゴン(大きなエフェクト) | 2.31M |
| 1280x960レンダーテクスチャの全画面コピー(ONE,ZERO、点サンプリング)×5 | 1.88M |
| 1024x1024テクスチャ、色はZERO,ONE(変えない)・**分離アルファでアルファだけ書く**全画面描画 | 1.23M |
| A4R4G4B4 512x512、ブレンドDESTALPHA,INVDESTALPHA(上のアルファを使う全画面描画) | 1.23M |
| その他 | 1.67M |

ほぼ全ての描画がZENABLE=1だが比較ALWAYS・書き込みなし(深度テストが何もしない)。比較LESSEQUALは一部(背景の3D)だけ。

### 3.3 th20 Lunatic全6面(`D3D9_PROBE=1 D3D9_PROBE_DUMP_EVERY=6000 scripts/99_bench.sh th20 base_16t_probe th20_ud1qn7.rpy`)

- 描画の構成はth15と同じエンジン(1フレームに描画先切替5回・クリア7回)。描画コール84〜357、**テクスチャは全てA8R8G8B8(392枚)、深度テストは無効**。
- 通過サンプルは画面2.4〜4.0枚分。最大の項目は1280x960レンダーテクスチャの全画面コピー(4回で1.84M、全体の約45%)。
- スレッド別(リプレイ全体の平均): llvmpipe合計764%(1本最大58%)、**th20.exe本体40%(th15は13%)**、wined3d_cs 25%、システム全体1114%。落ち込み(26〜50Hz)の区間でも本体スレッドは22〜50%(1回だけ96%)で、**律速はllvmpipe(描画)。** ただし本体はth15の約3倍重く、1スレッド性能の低い`c7i`では等倍時に効いてくる可能性がある(sattoriの`recordingSpeed.ts`の見立て)。1/2倍速では問題にならない。

## 4. CPU量と処理能力(th15 Extra `th15_08.rpy`)

```bash
scripts/99_bench.sh th15 <ラベル> th15_08.rpy [cpuset]
```

| 条件 | 平均Hz | 下位5% | 最低 | 実時間 |
|---|---|---|---|---|
| 16スレッド(`base_16t`) | 98.5 | 41.9 | 31.8 | 491s |
| 16スレッド 再実行(`base2_16t`) | 100.5 | 48.1 | 26.0 | 491s |
| 物理8コア・SMTなし(`phys8`、cpuset 0-7) | 83.0 | 39.6 | 23.6 | 591s |
| 4コア8スレッド(`c4t8`、cpuset 0-3,8-11、`c7i.2xlarge`相当) | 61.2 | 28.6 | 18.4 | 791s |

**処理能力は使えるCPUにほぼ比例する**(SMTも約2割効く)。

`LP_PERF=no_tex`等(llvmpipeの機能を切る診断フラグ)は、Mesa 25.2.8の配布ビルドでは効かなかった(no_texでも画面にテクスチャが出て96.0Hz)。no_depth・no_blendは中止した。

## 5. 削減策の実験(いずれも`mods/common/d3d9_probe_hook.cpp`、th15 Extra 16スレッド)

| 条件 | 平均Hz | 下位5% | 最低 | 結果 |
|---|---|---|---|---|
| `D3D9_PROMOTE_A4R4G4B4=1`(`promote_16t`) | 94.2 | 48.8 | 20.4 | 66枚格上げ。**効果なし** |
| `D3D9_ZTRIM=1`(`ztrim`、`skip_ztrim`) | 91.6 / 97.2 | 53.3 / 47.4 | 30.0 / 22.6 | **効果なし** |
| `D3D9_SKIP_NOOP=1`(当初版、`skipnoop`) | - | - | - | **画面が崩れた** |
| `D3D9_COPY_TO_BLIT=1`(`blit`) | 99.4 | 49.1 | 29.8 | 109,839回置き換え。**効果なし** |
| DXVK 2.7(d3d9)+lavapipe(`dxvk`) | 84.9 | 37.1 | 27.8 | **遅くなる** |

- **A4R4G4B4の格上げ**: `D3DXCreateTexture`・`D3DXCreateTextureFromFileInMemoryEx`のIATを包み、形式引数A4R4G4B4をA8R8G8B8へ差し替える。書き込みは`D3DXLoadSurfaceFrom*`が転送先の形式へ変換するので中身は正しく入る。
- **深度テストの間引き**: ZENABLE/ZWRITEENABLE/ZFUNC/STENCILENABLEの設定を横取りし、比較ALWAYS・書き込みなし・ステンシルなしのときはZENABLE=FALSEをデバイスへ渡す。効かないので、wined3dかllvmpipeが既に省いていると見られる。
- **空描画の省略**: 当初「ブレンドZERO,ONE・深度書き込みなし」を空とみなして省いたところ、画面が崩れて残像が積もり、リプレイ終了後も画面が静止しなくなった(1200秒で手動終了)。この描画は**分離アルファブレンド(SEPARATEALPHABLENDENABLE)でアルファだけを書くマスク**で、直後のDESTALPHA,INVDESTALPHAの全画面描画が使う。判定を「アルファも書かない場合だけ空」に直すと該当は0件(`skipped_noop=0`)。
- **等倍コピーのStretchRect化**(`TryCopyAsBlit()`): th06ncのBC7と同じく「一番大きい塗りつぶしを安い処理へ」という発想。`DrawPrimitiveUP`が次を全て満たすときだけ、描画の代わりに`StretchRect(テクスチャの面, 元矩形, 現在の描画先, 先矩形, POINT)`を呼ぶ。
  - FVF `XYZRHW|DIFFUSE|TEX1`(stride 28)、2三角形で軸に平行な長方形、頂点色が全て0xFFFFFFFF
  - 段0のテクスチャがレンダーテクスチャ(D3DPOOL_DEFAULT、usage RENDERTARGET)で描画先と同じ形式、点サンプリング
  - `u*幅 - x`と`v*高さ - y`が全頂点で一定(等倍)、元・先の矩形がテクスチャ・描画先・ビューポートの内側
  - 段0の色・アルファがテクスチャそのもの(SELECTARG1(TEXTURE)、またはMODULATE(TEXTURE, DIFFUSE/CURRENT))、段1はDISABLE
  - ブレンドなし相当(無効、またはONE,ZEROかつ分離アルファもONE,ZERO)、アルファテスト・フォグ・シザー・ステンシル・シェーダーなし、カラー書き込み全チャンネル、深度は無効かALWAYS・書き込みなし

  th15の短尺で1フレーム約3回置き換わり(拒否0)、画面は正常だった(例: `src=(436,244)-(844,716) dst=(436,244)-(844,716)`、`src=(256,32)-(1024,928) dst=(64,32)-(832,928)`)。それでも速くならないので、**点サンプリング・ブレンドなしの単純なコピーはllvmpipeが元々安く処理している**と見られる。th20では条件に合う描画が0件で、置き換えは起きなかった(実質ベースの再計測)。
- **DXVK**: DXVK 2.7の32bit `d3d9.dll`をゲームディレクトリへ置き(`BENCH_DXVK=<dxvk>/x32`、`WINEDLLOVERRIDES=d3d9=n,b`)、Xvfbのまま動いた(d3d9はreports/96のdxgiのゼロ除算に当たらない)。

**重いのはフィルタ付き・アルファブレンドの通常のスプライトと加算エフェクトで、ゲームの描画そのもの。** 描画を変えずに削れる部分は見つからなかった。

## 6. 内部解像度(960x720)

画面サイズのバイト(MODなしで起動して`xwininfo`で確認、`scripts/99_cfg_window_probe.sh <game> <offset> <value>`):

| タイトル | オフセット | 値 |
|---|---|---|
| th15.cfg | 0x1F(31) | 3=640x480、4=960x720、**5=1280x960(現行)**。1・6はD3Dの初期化エラーやウィンドウが出ない |
| th20.cfg | 0x78(120) | 4=960x720、5=1280x960(現行。0x77は無関係) |

描画先のレンダーテクスチャも960x720になる(`CreateTexture 960x720 usage=0x1`)。検証用に`recorder/instance.py`へ`GAME_CFG_OVERRIDE`(別のcfgを使う)を追加した。

```bash
cp games/th15/th15.cfg <cfg>; printf '\x04' | dd of=<cfg> bs=1 seek=31 conv=notrunc
MOD_MENU_TIME_SCALE=0.25 GAME_CFG_OVERRIDE=<cfg> scripts/99_bench.sh th15 res720 th15_08.rpy
MOD_MENU_TIME_SCALE=0.25 GAME_CFG_OVERRIDE=<cfg> scripts/99_bench.sh th15 res720_c4t8 th15_08.rpy 0-3,8-11
# th20(4倍速ではメニュー操作が空振りしたため2倍速上限)
BENCH_MULT=2 MOD_MENU_TIME_SCALE=0.5 GAME_CFG_OVERRIDE=<th20 cfg> scripts/99_bench.sh th20 res720_c4t8_x2 th20_ud1qn7.rpy 0-3,8-11
```

| タイトル・条件 | 平均Hz | 下位5% | 最低 | 実時間 |
|---|---|---|---|---|
| th15 1280x960 8コア16スレッド(2回) | 98.5 / 100.5 | 41.9 / 48.1 | 31.8 / 26.0 | 491s |
| th15 960x720 8コア16スレッド | 129.8 | 59.9 | 39.4 | 375s |
| th15 1280x960 4コア8スレッド | 61.2 | 28.6 | 18.4 | 791s |
| **th15 960x720 4コア8スレッド** | **88.8** | **50.1** | **24.0** | 541s |
| th20 1280x960 8コア16スレッド(2回) | 94.3 / 88.7 | 59.3 / 45.6 | 26.4 / 26.2 | 1106s / 1176s |
| th20 1280x960 4コア8スレッド | 64.9 | 35.6 | 14.4 | 1597s |
| **th20 960x720 4コア8スレッド**(上限120Hz) | **89.1** | **55.4** | **29.5** | 1171s |

- **960x720の4コア8スレッドは、両タイトルとも1280x960の8コア16スレッドとほぼ同じ。** 4コア8スレッドでの伸びは平均1.37〜1.45倍、下位5%は1.56〜1.75倍。
- 16スレッドでは1.3倍にとどまる。llvmpipeの1Hzあたりの使用率は9.1%→6.4%(0.70倍)で、解像度に比例しない部分(シーンごとの処理、クリア、Present時の待ち)が約3分の1ある。
- 960x720ではメニューが速く回るため、ベンチの4倍速ではキーが連打扱いになりメニュー操作が空振りした(th15はGame Start、th20はPlayer Selectへ入った)。本番の1/2倍速には関係しない。
- **960x720ではリプレイ終了後の画面静止を検知できなかった**(th20)。`still_detect_exclude_rect`等が1280x960の座標のままのため。本番へ入れるならth06ncの`_scale_rect()`と同様に座標を縮める必要がある(th20は手でゲームを止め、`scripts/99_bench_summary.py <log> 3600 104300`でリプレイ分に揃えた)。

## 7. 960x720の画質

配信版は、1280x960の録画を1440x1080へ引き上げている(sattori `worker/convert.py`の`delivery_resolution()`、Issue #284)。960x720の録画は高さがちょうど720なので**そのまま720pで配信される**。1080pの段を保つには、960x720を1440x1080へ拡大する処理を足す必要がある。

`scripts/99_quality_compare.sh`で、同じリプレイを等倍で両方の解像度で録り、どちらも1440x1080へlanczosで拡大してプレイフィールドの720x720を並べた(左=1280x960由来、右=960x720由来)。

```bash
scripts/99_quality_compare.sh th15 th15_09.rpy <th15 960x720 cfg> 60 30 45 55
scripts/99_quality_compare.sh th20 th20_ud1qn7.rpy <th20 960x720 cfg> 90 60 75 85
```

- 録画の開始位置がわずかに違うため、同じフレームではない(th20の75秒はほぼ同じ場面)。
- 960x720由来は、弾の縁・アイテムの文字・細い線がやや柔らかい。弾幕の判別に困るほどではない。**採用は開発者の視聴で判断してほしい**(`/mnt/cache3/sattori-th1{5,20}-verify/phase99/quality/compare_*.png`)。

## 8. 本番へ入れる場合(未実施)

1. 視聴で960x720の画質を許容できるか判断する。
2. `c7i.2xlarge`の1/2倍速・960x720で、th15 Extra(`th15_08.rpy`)・th20 Lunatic(`th20_ud1qn7.rpy`)をフル尺で実測し、AGENTS.mdの品質基準(落ち≤1.5%等)を確認する。ローカルの5700X(Zen 3)と`c7i`(Sapphire Rapids)の差は未評価。reports/91の`c7i.4xlarge` 1/2倍速(落ち0.5〜0.8%)と同等なら、費用はほぼ半分になる。
3. sattoriの実装: cfgの差し替え(th15は0x1F=4、th20は0x78=4)、ウィンドウサイズ・`xvfb_screen`・`still_detect_exclude_rect`・`crtc_mode`等の座標の縮小、配信版の1440x1080への拡大(`delivery_resolution()`の例外)。
4. 余地として、AVX-512を持つ`c7i`でllvmpipeが512bitベクトルを使っているか(DXVKのログではローカルは`256 bits`)は未確認。

## 成果物

`/mnt/cache3/sattori-th15-verify/phase99/`

- `base/`: 等倍Extra全編の録画(16スレッド)、スレッド記録、MODログ
- `probe_smoke/`: 描画記録フックとHUDダンプの動作確認(Extra短尺)
- `blit_smoke/`: StretchRect置き換えの動作確認(Extra短尺の録画)
- `bench/<条件>/`: ベンチマークのログ・スレッド記録・集計(4倍速の動画は品質評価に使わないため削除)
- `quality/`: 画質比較の録画(`r960.mp4`、`r720.mp4`)と比較画像
- `th15_960x720.cfg`、`dl/dxvk-2.7/`(DXVK 2.7、比較用)

`/mnt/cache3/sattori-th20-verify/phase99/`: `bench/`、`quality/`、`th20_960x720.cfg`、`cfgprobe/`(スクリーンショット)

## 変更ファイル

- 新規: `mods/common/d3d9_probe_hook.{h,cpp}`、`mods/th20_replay_autoplay/build_mingw.sh`、`scripts/99_thread_sampler.py`、`scripts/99_summarize_threads.py`、`scripts/99_bench.sh`、`scripts/99_bench_summary.py`、`scripts/99_cfg_window_probe.sh`、`scripts/99_quality_compare.sh`
- 変更: `mods/common/fps_limiter_hook.cpp`(CreateDevice時のコールバック)、`mods/th15_replay_autoplay/{dllmain.cpp,build_mingw.sh}`、`mods/th20_replay_autoplay/dllmain.cpp`(`InstallD3D9ProbeHook()`、`MOD_MENU_TIME_SCALE`)、`recorder/stutter.py`(`STUTTER_PROBE_ACTIVE_UNTIL_SEC`)、`recorder/instance.py`(`GAME_CFG_OVERRIDE`)、`docs/titles/th15.md`、`docs/titles/th20.md`、`docs/known-limitations.md`、`AGENTS.md`、`reports/README.md`
