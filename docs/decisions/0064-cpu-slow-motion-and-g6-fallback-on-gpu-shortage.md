# 0064. GPUを確保できないth15・th20はCPU低速録画へ、th06ncはg6.2xlargeへ逃がす

- **状態**: 有効
- **決定日**: 2026-11-05
- **対象**: packages/shared / apps/api / worker / apps/web
- **関連**: Issue #316、#315、#317、#322、#179、[`0010`](0010-slow-motion-no-worker-side-branching.md)・
  [`0047`](0047-no-gpu-titles-for-home-worker.md)・[`0050`](0050-th15-gpu-instance-despite-not-strictly-required.md)・
  [`0058`](0058-speedup-recording-on-gpu-instances.md)・[`0060`](0060-speedup-fallback-to-native-speed.md)・
  [`0063`](0063-spot-capacity-shortage-is-permanent-within-a-job.md)、touhou-recorder reports/91・92・93

`g6f.2xlarge`の段を使い切ったら、th15・th20は`options.recordingSpeed`を低速（1/2、th15 Extraは1/3）へ
書き換えて`c7i.4xlarge`で録り、th06ncは3段目の`g6.2xlarge`（eu-south-2）で録る。起動はすべてSpot。
0058の「低速録画の廃止」、0050の「th15をGPU系に固定」を置き換える。**低速録画はユーザーが選ぶものでは
なく、自宅ワーカーへもオファーしない。**

## 背景

`g6f.2xlarge`のSpot枯渇が続き、GPU必須タイトルの成功が 10/05 週の 14/30 から 11/02 週の 0/6 まで
落ちた（Issue #316）。全リージョンの`g6f`が尽きると、これらのタイトルは0063により直ちに失敗する。

## 決定

- **試行順**: `gpu:<eu-south-2>`→`gpu:<eu-north-1>`→（th06ncのみ）`gpu-full:<eu-south-2>`
  （`apps/api/src/ec2.ts`の`launchTiersFor()`）。
- **落とす速度**（`packages/shared/src/gpuRecording.ts`の`fallbackRecordingSpeedFor()`）: th15・th20は
  等倍でも倍速でも低速へ。th15は`replayInfo.difficulty === "Extra"`なら1/3、それ以外は1/2。
  他の倍速録画は従来どおり等倍へ。th06ncは null（落とす先が無い）。読めない`replayInfo`は1/2。
- **既存の仕組みに乗せる**: 0060の`options.recordingSpeed`の書き換えをそのまま使う
  （`jobs.ts`の`fallBackRecordingSpeed()`）。契機も同じで、全段の枯渇（`Launch`）、待ち行列30分
  （`AcquireGpuSlot`）、クォータ超過などの3回目（`HandleFailure`）。低速のジョブは
  `requiresGpuRecording()`が false になり、`AcquireGpuSlot`・リース・GPUイメージを通らない。
- **表現**: `RECORDING_SPEEDS`（1〜4）はユーザーが選べる値のまま、`SLOW_MOTION_RECORDING_SPEEDS`を
  足す。`POST /magic-links`は低速を等倍へ落とす（`normalizeRequestedRecordingSpeed()`）。
- **ワーカーに分岐を作らない（0010）**: 低速は`FPS_LIMIT_TARGET_HZ`（30・20）だけで表す。th15の
  `gpu_display`は固定をやめ、`GPU_WORKER`から決める。
- **重複フレーム率**: 低速録画の生データには固定の閾値90%を使う（`recording/timing.py`の
  `SLOW_MOTION_MAX_DUPLICATE_RATE`）。低速の処理落ちはこの指標で判定しない。
- **タイムアウト**: 監視の時間定数はこれまでどおり`time_scale`倍。ただし録画タイムアウトは実時間120分で
  頭打ち（`MAX_WALL_CLOCK_TIMEOUT_SEC`）。`taskTimeout`（150分）は変えない。
- **検証用の管理設定**: `skipFractionalGpuTiers`。`g6f`の段を飛ばし、各段を本番で試せるようにする。
- **旧レコードの`options.slowMotion`は読まない**。今のコードは読んでおらず、そのまま等倍扱いにする。
  旧低速の再開に必要な倍率はチェックポイントのS3メタデータにあり、影響しない。

## 根拠

- **`c7i.4xlarge` 1タイプだけ**: この構成で検証したのはこれだけ（reports/91。配信版の落ちは0.5〜0.8%）。
  `.2xlarge`はth20とth15 Extraで品質が足りない。ユーザーが視聴し、GPUより品質は落ちるが許容と判断した。
- **CPU等倍へは落とさない**: `c7i.4xlarge`でも落ち3.4〜6.8%（reports/91 §3）。
- **1/3倍速**: th15 Extraは1/2倍速で最低19.8Hzまで落ち、BGMが映像より先行する。1/3倍速で目標割れが
  6.0%から1.5%へ減る（reports/91）。
- **閾値90%**: 正常な録画の実測は30Hzで58%、20Hzで80.3〜80.4%で、従来の換算（76.67%）では破棄された
  （reports/91 §4）。**止まった録画をすべて弾けるわけではない**。背景が動くPracticeのステージ選択画面で止まった
  20Hzの録画は本番で67.4%だった（`docs/reports/2026-11-05-cpu-slow-motion-production-e2e.md`）。リプレイが
  始まらなかった録画の検知は別の課題（`docs/known-limitations.md` §1）。
- **th15のタイトル待ちを10秒に戻す**: 5秒では`c7i.4xlarge`の20Hzでメニューを取りこぼした（2本中2本）。10秒では
  通過した。reports/91・93の20Hzも10秒のMODで、th20も同じ値。**なぜ取りこぼすのかは説明できていない**
  （待つゲーム内フレーム数は速度によらず同じで、同じ5秒でもローカルの20Hzと`c7i.4xlarge`の30Hzは通った）。
- **`g6.2xlarge`**: AMI変更なしで録画でき、品質は`g6f`と同等。単価が3.5〜7倍なので最後の段にする。
  eu-north-1は在庫が無かった（reports/92）。
- **実時間120分の頭打ち**: 1/2倍速なら従来どおりコンテンツ60分で打ち切る計算で、変換とアップロードを
  足しても150分に収まる。1/3倍速のみ、コンテンツ40分で打ち切りになる。th15 Extraの尺は十数分で届かない。
- **実機確認**: ワーカーでの動作は [`reports/2026-11-05-cpu-slow-motion-worker-local.md`](../reports/2026-11-05-cpu-slow-motion-worker-local.md)。
  AWS実機のE2Eは未実施（`docs/known-limitations.md` §1）。

## 採らなかった選択肢

- **低速録画を自宅ワーカーへオファーする。** th20低速2並列のハング（#179）が未解決で、構成が無くなって
  閉じただけ。同時実行を1に制限する実装を足しても、自宅機でのCPU低速は未検証で、`c7i.4xlarge`の
  結果を流用する根拠が無い。無料になる利点はあるが、月約30件・約$1.5の節約に対して割に合わない。
- **別の属性（`options.slowMotion`）で表す。** GPU要否と環境変数が2つの属性に依存し、0060の書き換えに
  乗らなくなる。
- **2/3倍速（40Hz）。** 60fpsキャプチャのままでは落ち16%超。120fpsキャプチャはth20の1本だけの結果で
  実装も要る（reports/91 §5）。
- **`g6.2xlarge`の段でth06ncの速度を変える（720p 3倍速・1080p 2倍速）。** ユーザーが採用した値だが、#322の
  修正が前提で、段ごとの速度は#317の範囲。本Issueではジョブの速度をそのまま使う。
- **`taskTimeout`を伸ばす。** ジョブごとに変えられず、固まったワーカーの検知はハートビートが担うので、
  伸ばす理由は1/3倍速の長尺だけ。該当するリプレイが想定できない。
- **`pulse`の起動確認を足す（reports/91 §8）。** `create_null_sink()`が接続できなければ例外で試行を失敗させる。
  報告の事例はsystemdのソケットとの二重起動で、コンテナの構成では起きない。

## 影響範囲

- **MOD**: `worker/mods/th15_replay_autoplay`（fps表示の補正とタイトル待ち）・`common/fps_display_hook`を変えたので、デプロイ時にth15の
  タイトル資産を再アップロードする（`build-mods`・`upload-title-assets` skill）。古いDLLでも録画はでき、
  配信版のfps表示が低いままになるだけ。
- **CPUイメージ**: `worker/Dockerfile`に`record_th15.py`を足した。`worker/`のイメージをpushしてからデプロイすること。
- **`gpu-full`の段の候補を変える、段を足す**: `GPU_INSTANCE_TYPE_VCPUS`と`cost.ts`の帯も見直す。
- `fallbackRecordingSpeedFor()`の速度・対象を変えるときは実機検証を先に行う（AGENTS.md §3）。
- #317で速度の自動選択を入れるときは、`requestedRecordingSpeed`と案内文の扱いを合わせて見直す。
