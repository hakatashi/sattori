# 録画速度（倍速録画 Issue #288・低速録画 Issue #316）

倍速・低速録画でパイプラインの各段（MOD・キャプチャ・監視・変換）が何を変えるかと、
速度に関わらず効く同期マーカーによるA/V同期補正の参照仕様。録画速度・A/V同期・
`recording/timing.py` を触る前に読むこと。[`worker/README.md`](../README.md) §5 から分けた。

ゲームを2〜4倍速で走らせて録画し、後処理(`convert.py`)で等倍へ戻す。GPUを確保できないth15・th20は
`c7i.4xlarge`のCPU描画で1/2倍速(th15 Extraは1/3倍速)で録り、同じ変換で等倍へ戻す
([`decisions/0064`](../../docs/decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md))。有効・無効は起動側が渡す `FPS_LIMIT_TARGET_HZ` の有無だけで
決まる(未設定なら全タイトル従来どおり等倍)。ワーカー自身は自分が EC2 にいるのか自宅に
いるのかを知らない。

> **ここにワーカー側の分岐を足さないこと**
> ([`decisions/0010`](../../docs/decisions/0010-slow-motion-no-worker-side-branching.md))。
> また**倍率はフック・監視のタイムアウト・変換・品質チェックの閾値・進捗のすべてへ一貫して
> 掛かっており**、1つでも据え置くと誤リトライ・誤終了検知・音ズレが起きる
> ([`decisions/0014`](../../docs/decisions/0014-slow-motion-scaling-across-pipeline.md))。

倍速録画(touhou-recorder reports/84〜90で技術検証)は**GPUワーカー(`GPU_WORKER=1`、
g6f.2xlarge)専用**。CPU描画(llvmpipe)では2倍速を維持できない。倍速時にパイプラインが
変えることは次のとおり(実装は `recording/timing.py` に集約):

- **ゲーム側(MOD)**: `speed_hack_hook`がQueryPerformanceCounterの経過時間を倍率ぶん伸ばし、
  `dsound_hook`/`wasapi_hook`が再生周波数を倍率ぶん上げる(テープの早回し)。VsyncPatchを
  注入するタイトル(th06/th07/th10/th12)は`vpatch.ini`の`GameFPS`を`60×倍率`、`CalcFPS`を0に
  書き換える(`recording.config.with_runtime_overrides()`)。
- **キャプチャ**: x11grabを`60×倍率`fps・`-vsync 0`で撮る。音声はジョブ専用sinkを
  `44100×倍率`Hzで作ってPCMのまま録り、mux時に2倍速はAAC(`-cutoff`付き)、3倍速以上は
  ALACへ変換する(AACのサンプルレート上限96kHzのため)。
- **監視**: 終了検知の連続回数・猶予・全体のタイムアウトはゲーム内時間で一定になるよう縮めるが、
  終了テンプレートの連続一致回数と、起動・メニュー操作を待つタイムアウトは縮めない
  (`scaled_confirmation_count()`)。
- **変換**: 映像のPTSを倍率ぶん引き伸ばして60fpsへ揃え、音声は`asetrate`で読み替えて
  44100Hzへ戻す。60fpsへ揃えるのは`fps`フィルタではなく`-r 60 -fps_mode cfr`で行う。生映像のptsが
  等間隔とは限らず、`fps`フィルタでは約45fpsへ落ちるため([`decisions/0065`](../../docs/decisions/0065-speedup-delivery-frame-rate-by-output-option.md))。

倍速かどうかにかかわらず、**A/V同期は同期マーカーで補正する**(`recording/sync_marker.py`、
reports/88)。MODが録音開始2秒後にゲーム自身の音声デバイスから約3秒・-42dBFSの疑似乱数
ノイズを鳴らし、音声からその位置を相互相関で探す。見つからなければ従来の`-copyts`の
start_time差で補正する。**音声の録音は映像より先、ゲームの起動直後に始め**、マーカーはMODが
ウィンドウの安定を報告しゲームの音声が流れ始めてから鳴らす。マーカーはメニュー操作より前に
鳴り終わり、配信版ではカットされる(重なる場合はカット開始を遅らせる。[`output-files.md`](output-files.md)、Issue #266)。

```bash
# 2倍速(GPU搭載マシンでのみ意味がある)
FPS_LIMIT_TARGET_HZ=120 GPU_WORKER=1 python3 record_th10.py \
  --replay-path games/th10/replay/th10_01.rpy --output /tmp/th10/out.mp4
```
