# フェーズ79: th06ncのGPU描画経路で発覚したamdgpuフェンス固着と、その切り分け

## 背景

フェーズ78でth06nc(東方紅魔郷: New Classic)を`scripts/25_record_replay_e2e_multigame.py`に
統合し、headless weston + rootful Xwayland によるGPU描画面(`scripts/78_start_gpu_display.sh`)
の上で録画できるところまで来ていた。本フェーズはその続きで、フル尺録画・録画品質確認・
スコアRVA特定を進めるのが目的だったが、**ホストGPU(Radeon VII / amdgpu)がth06ncを
動かすたびに固着していく**問題に阻まれた。

作業開始前に `systemctl status sattori-home-worker` で本マシンのワーカーが停止中
(2026-09-12 05:10:36 にSIGTERMで停止)であることを確認済み。

## 1. 症状: th06ncを1回動かすとGPUが壊れ、2回目は起動すらしない

再起動直後(健全な状態)から順に観測した数値。「D状態タスク数」は
`ps -eo stat | awk '$1 ~ /^D/' | wc -l` で数えたもの。

| 時点 | D状態タスク数 | load average | 状態 |
|---|---|---|---|
| 再起動直後(05:12) | 9 | 1.4 | ComfyUI/webui-forge起動による既存分 |
| `glxgears` 5秒実行後 | 9 | — | **増えない**(105 fps で正常描画) |
| th06nc 1回目の録画後(05:13) | — | — | 録画自体は成功(重複フレーム率1.5%) |
| th06nc 2回目の起動時(05:15) | 37 | 32.2 | **ゲームが初期化で停止**(FpsMonitor 0.0 Hz) |
| th06nc 3回目の起動時(05:16) | 38 | — | 同上。ウィンドウすら作られない |

再起動前(前セッションからの継続分)は最終的に **67タスクがD状態・load average 70** まで
悪化し、`DISPLAY=:88` の `xdpyinfo` がタイムアウトする(Xwayland・westonとも
`futex_wait_queue` でデッドロック)状態になっていた。

## 2. 原因: ゲームプロセス終了時のDRM fdクローズがdma_fence待ちで永久ブロックする

決定的な証拠は、殺したはずの `th06nc.exe` が **reapできないゾンビ(`Zl`)として残り続ける**
ことだった。ゾンビのスレッドのカーネルスタックを見ると:

```bash
$ ps -eo pid,stat,comm | grep th06nc
  12781 Zl   th06nc.exe
  16416 Zl   th06nc.exe

$ sudo cat /proc/12781/task/12870/stack
[<0>] dma_fence_default_wait+0x1e1/0x220
[<0>] dma_fence_wait_timeout+0x116/0x140
[<0>] amdgpu_vm_fini+0xf1/0x610 [amdgpu]
[<0>] amdgpu_driver_postclose_kms+0x1b7/0x2f0 [amdgpu]
[<0>] drm_file_free+0x1e9/0x260
[<0>] drm_release+0xb7/0x130
[<0>] __fput+0xa3/0x2e0
[<0>] ____fput+0xe/0x20
[<0>] task_work_run+0x61/0xa0
[<0>] do_exit+0x2be/0x530
```

つまり **プロセス終了処理(`do_exit` → fd クローズ)の中で、amdgpuが
「まだ完了していないフェンス」を待ち続けて戻ってこない**。`do_exit` の途中で
止まるのでプロセスはゾンビのままreapされず、GPU VM・フェンスの資源も解放されない。

同じフェンス待ちは `amdgpu_tlb_fence_work` のワーカーにも波及する:

```
Sep 12 04:40:54 kernel: INFO: task kworker/5:0:49 blocked for more than 122 seconds.
Sep 12 04:40:54 kernel: Workqueue: events amdgpu_tlb_fence_work [amdgpu]
Sep 12 04:40:54 kernel:  dma_fence_default_wait+0x1e1/0x220
Sep 12 04:40:54 kernel:  dma_fence_wait_timeout+0x116/0x140
Sep 12 04:40:54 kernel:  amdgpu_tlb_fence_work+0x29/0x140 [amdgpu]
```

D状態タスクが積み上がると、新しくGPUコンテキストを作ろうとするクライアント
(= 次のth06nc起動)が最初の描画で止まり、ゲームが初期化を完了できなくなる。
MODログが必ず `GetProcAddress: XInputSetState` の直後で途切れるのはこのためで、
**MOD側の不具合ではない**(当初はDllMainのローダーロック反転を疑ったが無関係だった)。

### 2.1 原因はth06nc(wined3d経由のD3D11描画)であり、weston/Xwayland自体ではない

* `glxgears` を同じ `DISPLAY=:88` で5秒動かしてもD状態タスクは9のまま増えない
* ComfyUI・webui-forge(ROCm/PyTorch)は起動時に9タスク分の`tlb_fence_work`待ちを
  作るが、それ以上は増えない
* th06ncを1回動かすと一気に+28タスク

th06ncは **D3D11タイトルであり、wine上では wined3d による D3D11→OpenGL 変換**で
描画されている(フェーズ78 §1)。Vulkan(DXVK)経路は未検証。

### 2.2 再起動でしか復旧しない

`/sys/kernel/debug/dri/1/amdgpu_gpu_recover` によるGPUリセットは、固着した
カーネルスレッドが残っている状態では効果が期待できない。実際に本セッションでは
ユーザー判断でマシンを再起動して復旧した(再起動後はD状態9・load 1.4に戻った)。

**なお、このGPUはユーザーのML系ワークロード(ComfyUI・Stable Diffusion WebUI Forge、
`/dev/dri/renderD128` を開いているpython 18プロセス)と共有されている。**
th06ncの検証でGPUを壊すとそれらも巻き添えになる。

## 3. 副産物: 録画自体は正常だった(GPUが健全な1回目)

GPUが健全な状態での1回目の録画(`th6_07.rpy`、Easy・21秒)は問題なく成功した。

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th06nc --replay th6_07.rpy \
    --output runs/th06nc_verification/smoke/th6_07.mp4 --max-attempts 1
```

* MODのキーシーケンス(Enter → Down×3 → Enter×3)が完走し `sequence complete`
* 録画は 1280x720 / 60fps、画面右下のゲーム内fps表示は **60.00fps**、《REPLAY》表示あり
* **重複フレーム率 1.5%**(`scripts/measure_duplicate_frame_rate.sh`、12秒目から17秒間)
* A/V同期の実測差分は -0.003秒

つまり **GPUさえ健全なら録画品質は問題ない**。

## 4. `scripts/25` の処理落ち早期検知がth06ncで誤検知する問題を修正

上記の録画は `stutter probe: elapsed=19.5s dup_fraction=0.89` で早期終了扱いになっていた
(閾値0.7)。実際には60fpsで正常に再生されており、**誤検知**である。

原因は `probe_stutter()` が**全画面のMAD**で「静止しているか」を判定していること。
th06ncは1280x720の16:9画面で、左のアートワーク・右のサイドバー・外周の装飾枠が
静止しており、実際に動くプレイフィールドは中央の `x=352..934` だけである。
全画面MADではプレイフィールドの動きが薄まり、0.15秒間隔のMADが
`STILL_MAD_THRESHOLD`(2.0)を下回ってしまう。

録画済み動画から0.15秒間隔のフレームを取り出して実測した結果:

| MAD計算範囲 | 平均 | 最小 | 閾値2.0未満の割合 |
|---|---|---|---|
| 全画面 | 2.35 | 0.93 | **0.62** |
| プレイフィールドのみ(左右除外) | 4.47 | 2.02 | **0.00** |

対策として、`scripts/25` に以下を追加した(**既存タイトルは設定を持たないので挙動不変**)。

* `probe_stutter()` に `mask` 引数を追加(`mad_masked` を使う)
* `GAME_CONFIGS` の新キー `stutter_probe_exclude_rect`(未設定なら従来どおり全画面)
* `GAME_CONFIGS` の新キー `stutter_dup_fraction_threshold`(未設定ならグローバル値)
* th06ncには `stutter_probe_exclude_rect = [(0,0,352,720), (934,0,1280,720)]` と
  `stutter_dup_fraction_threshold = 0.9` を設定

## 5. MODに待ち時間スケール `TH06NC_TIME_SCALE` を追加

スコアRVAの特定には60fpsは不要なので、GPUを一切使わない Xvfb + llvmpipe
(`LIBGL_ALWAYS_SOFTWARE=1`)で動かしたい。しかしllvmpipeでは1280x720で9fps程度しか
出ないため(フェーズ78 §5)、MODの固定待ち(`Sleep(2000)` 等)では画面遷移
アニメーションの完了前に次のキーを送ってしまう。

`mods/th06nc_replay_autoplay/dllmain.cpp` に `GetTimeScale()` / `SleepScaled()` を追加し、
メニュー操作シーケンスの待ちを環境変数 `TH06NC_TIME_SCALE`(既定1.0)で伸ばせるように
した。`PressVKey()` はポーリング回数(=描画フレーム)基準なので、もともとfps非依存で
変更不要である。llvmpipe上では `TH06NC_TIME_SCALE=7`(60/9 ≒ 6.7)を使う。

## 6. スコア変数のRVAをGPU無しで特定した

`scripts/79_th06nc_find_score_rva.sh` で、記録スコアの異なる2本のリプレイについて
メモリ探索を行った。**「再生中」と「再生終了後」の両方で探索する**のが要点で、
再生中から記録スコアを保持しているアドレスは「リプレイファイルから読んだ記録スコア」
なので除外できる。

```bash
# 1本目: th6_07(Easy・21秒・記録スコア 514,850)。再生終了後だけを6回スキャン
scripts/79_th06nc_find_score_rva.sh --replay th6_07.rpy --score 514850 \
    --delay-ms 150000 --repeat 6 --interval-ms 20000

# 2本目: th6_03(Spell Practice No.108・17秒・記録スコア 5,710,640)。
#        再生中(30秒後)から8回スキャンして、再生中に既に一致するアドレスを炙り出す
scripts/79_th06nc_find_score_rva.sh --replay th6_03.rpy --score 5710640 \
    --delay-ms 30000 --repeat 8 --interval-ms 20000
```

2本目の結果(モジュール内ヒットのみ抜粋):

| アドレス | 再生中(30/50/70秒) | 終了後(90〜170秒) | th6_07でも出たか | 判定 |
|---|---|---|---|---|
| `module+0x00C0EC80` | **ヒット** | ヒット | はい | リプレイファイルの記録スコア(検証に使えない) |
| `module+0x004F2790` | なし | ヒット | はい | **生スコア** |
| `module+0x004F2798` | なし | ヒット | はい | 生スコア(0x4F2790の8バイト隣、表示追いかけ値と推測) |
| `module+0x004F27A8` | なし | ヒット | **いいえ** | th6_03でのみ出現。ハイスコア更新欄と推測 |

th06c(フェーズ74)と全く同じ構造で、`kScoreRva` / `kScoreDisplayRva` の2つ組に
リプレイファイル由来の記録スコアが1つ付く形だった。

### 6.1 【重要】th06cとは内部値・表示値の前後関係が逆

2つのアドレスのどちらが「即時に加算される内部スコア」かを、MODの
`ScoreMonitor`(`kScoreRva` と `kScoreDisplayRva` の両方を1秒ごとにログする)で実測した。
**th06cとは逆で、`0x004F2798` が内部スコア、`0x004F2790` がそれを追いかける表示値**だった。

```
[10:16:05] ScoreMonitor: score=513570 ... displayed=514550   <- displayed が先行
[10:16:06] ScoreMonitor: score=513970 ... displayed=514550
[10:16:07] ScoreMonitor: score=514370 ... displayed=514550
[10:16:08] ScoreMonitor: score=514550 ... displayed=514550   <- score が追いついた
[10:16:12] ScoreMonitor: score=514640 ... displayed=514850   <- displayed が最終値に到達
[10:16:14] ScoreMonitor: score=514850 ... displayed=514850   <- score が2秒遅れで到達
```

(このログは `kScoreRva=0x004F2790` / `kScoreDisplayRva=0x004F2798` で採取したもの。
`score` として出ている方が追いかけ値である。)

最終的にMODには以下を設定した。追いかけ値をデシンク判定に使うと、最終加算が大きい
リプレイで「追いつく前に画面が遷移して値が消える」リスクがあるため、内部値側を使う。

```cpp
constexpr uint32_t kScoreRva = 0x004F2798;        // 内部スコア(即時)
constexpr uint32_t kScoreDisplayRva = 0x004F2790; // 画面表示用の追いかけ値
```

`scripts/53_verify_replay_score.py` の `GAME_MULTIPLIERS` には
`"th06nc": 1`(内部値=表示値、等倍)を追加した。

### 6.2 デシンク判定の実機検証

```bash
$ python3 scripts/53_verify_replay_score.py --game th06nc \
      games/th06nc/replay/th6_07.rpy <autoplay.log>
タイトル      : th06nc
リプレイ      : th6_07.rpy (Easy / None / koyi)
記録時スコア  : 514,850
再生時スコア  : 514,850 (内部値514,850×1, 最大514,850)
到達ステージ  : -1  残機: -1  グレイズ: -1
スコア動作時間: 113.2s  サンプル数: 68
判定          : 一致(デシンクなし)
```

ステージ番号・残機・グレイズのRVAは未特定(th06cと同じく `-1` を出力する)。

**この特定作業はすべて Xvfb + llvmpipe(`LIBGL_ALWAYS_SOFTWARE=1`)で行っており、
GPUには一切触れていない。** 実測fpsは約10fpsだったが、`TH06NC_TIME_SCALE=7` で
メニュー操作の待ちを伸ばすことで問題なくリプレイ再生まで到達できた。

## 7. 成果物

| パス | 内容 |
|---|---|
| `scripts/79_th06nc_find_score_rva.sh` | GPUを使わない(Xvfb+llvmpipe)スコアRVA探索ランナー |
| `runs/th06nc_verification/smoke/th6_07.mp4` | GPU健全時の録画(重複フレーム率1.5%) |

## 8. 【検証済み・仮説は棄却】ROCmワークロードは原因ではなかった

再起動直後のD状態タスク(`amdgpu_tlb_fence_work` 待ち)9個が、経過秒から逆算すると
**ブートの8秒後、ComfyUI/webui-forge の `ActiveEnterTimestamp` と同一時刻**に発生して
いたため、「th06ncを動かす前からROCmワークロードがGPUを半壊させているのでは」という
仮説を立て、ユーザーの許可を得て両サービスを停止・自動起動無効化した上で再起動して
検証した。

```bash
sudo systemctl stop comfyui webui-forge
sudo systemctl disable comfyui webui-forge
# (再起動)
```

**結果: 仮説は棄却された。** ROCmサービスが一切起動していない状態でも、
ブート直後のD状態タスクは**同じく9個**発生し、スタックも同一だった。
先の時刻一致は「どちらもブート数秒後に起きる」ことによる偶然だった。

| 条件 | ブート直後のD状態タスク | GPUを開いているプロセス |
|---|---|---|
| ROCm有効(前回) | 9 | unity-greeter, Xorg, **ComfyUI/forge系 python 19個** |
| **ROCm無効(今回)** | **9** | unity-greeter, Xorg のみ |

検証後、両サービスは `systemctl enable` で元に戻した(次回ブートから起動する)。

### 8.1 ROCm無しでもth06ncは同じようにGPUを壊す

同じクリーンな状態で `scripts/25` による録画を2回連続実行した。

| 手順 | D状態タスク数 | 結果 |
|---|---|---|
| ブート直後 | 9 | — |
| GPU描画面(weston+Xwayland)起動後 | **9**(増えない) | — |
| **th06nc 録画1回目** | **27** | 録画成功。リプレイ終了も画面静止検知で正常に検知 |
| **th06nc 録画2回目** | **29** | **起動失敗**(FpsMonitor 0.0 Hz、ウィンドウ安定せず) |

1回目の後には `th06nc.exe` のゾンビ(`Zl`)が1個残り、§2のスタックと同じく
`amdgpu_vm_fini` のフェンス待ちで `do_exit` が完了できていない。

**結論: GPU固着の原因はth06nc自身のGPUコンテキスト破棄であり、ROCmワークロードは
無関係である。** また、ブート直後に必ず出る9個のD状態タスクは、`glxgears` も
th06ncの録画1回目も正常に動いたことから、**それ自体は実害のない残留**と見てよい。

### 8.2 次の検証: DXVK(D3D11→Vulkan)

th06ncはD3D11タイトルで、現在は wined3d による D3D11→OpenGL 変換で描画している。
`glxgears`(素のOpenGL)では固着しないことから、wined3dの重いGL使用パターン固有の
可能性がある。DXVK 2.7 の x64 DLLを WINEPREFIX に導入済み(wineビルトインは
`system32/_wine_builtin_backup/` に退避済み)。

```bash
# DXVK(D3D11 -> Vulkan)で実行
WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=n" \
  python3 scripts/25_record_replay_e2e_multigame.py --game th06nc --replay th6_07.rpy \
      --output runs/th06nc_verification/dxvk1/th6_07.mp4 --max-attempts 1

# wined3d(従来)で実行 = 環境変数を付けない(wineは既定でbuiltinを優先するため)
```

DLLを system32 に置いただけでは wine は既定で builtin(wined3d)を使うので、
**`WINEDLLOVERRIDES` を付けない限り従来動作のまま**である。

### 8.3 【注意】1回の録画ごとに再起動が必要な状態

現時点では、th06ncの録画はホストGPUを1回で壊すため、**録画1本ごとにマシン再起動が
必要**である。フル尺録画(通常ステージ+Extra)の検証を進めるには、DXVKで回避できるか、
あるいはAWSのGPUインスタンス(NVIDIAスタック)に寄せるかの判断が要る。

## 9. 次にやること

* **DXVK(D3D11→Vulkan)経路の検証**。th06ncはD3D11タイトルであり、現在は
  wined3dによるD3D11→OpenGL変換で動いている。XwaylandはDRI3を持つのでVulkanが
  使える見込みで、フェンス固着がwined3d/GL固有なら回避できる可能性がある
* フル尺録画(通常ステージ・Extra)、録画品質・音ズレ・理論尺比較
* AWSクラウド実機検証(GPUインスタンス g4dn/g5/g6 前提)
