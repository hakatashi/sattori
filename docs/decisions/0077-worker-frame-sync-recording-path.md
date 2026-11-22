# 0077. ワーカーにフレーム同期キャプチャの録画経路を足す(実時間の経路と`CAPTURE_MODE`だけで分け、リトライしない)

- **状態**: 有効
- **決定日**: 2026-11-22
- **対象**: worker
- **関連**: Issue #389、Epic #399、[`0073`](0073-gpu-lease-for-next-ec2-step-and-capture-mode.md)・
  [`0010`](0010-slow-motion-no-worker-side-branching.md)・[`0011`](0011-replay-end-template-matching.md)・
  [`0015`](0015-resume-from-raw-video-checkpoint.md)・[`0039`](0039-end-template-freeze-timeout.md)・[`0059`](0059-cut-range-decided-by-recorder.md)、
  touhou-recorder reports/104〜112、
  [`docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md`](../reports/2026-11-22-worker-frame-sync-full-length-verification.md)

ワーカーは`CAPTURE_MODE=frame_sync`のとき、実時間の録画(x11grab・PulseAudio・同期マーカー)とは別の経路
(`worker/recording/framesync.py`)で録る。**分岐の基準は`CAPTURE_MODE`だけで、タイトルや自宅/EC2では分けない。**
この経路は**ワーカーの中でリトライせず**、重複フレーム率の判定を使わない。これを知らずに実時間の経路の仕組み
(重複フレーム率・`time_scale`・同期マーカー・実時間の`content_end_epoch`)を持ち込むと、合否の判定・カット位置・進捗が壊れる。

## 背景

MODがゲームのPresentごとにバックバッファをFIFOへ書き、ゲームの時計と音声も仮想化する方式(Issue #388)は、
取り込みでフレームが落ちず、負荷が高くても映像と音声が決定的に一致する(touhou-recorder reports/109)。
ワーカー側は、この方式の入力(FIFO・仮想音声のPCM)から動画を作り、合否を判定する経路が要る。

## 決定

- **経路の分岐は`pipeline.record_with_retry()`の冒頭の`frame_sync_mode()`(`CAPTURE_MODE`)だけ**。
  `recording_time_scale()`はこのとき常に1.0を返すので、生動画のチェックポイントのメタデータ
  `sattori-time-scale`は1.0のまま(0015との互換)で、`FPS_LIMIT_TARGET_HZ`が渡っても使わない。
- **時間の基準は動画のフレーム番号**。終了検知は、ffmpegの出力を3つに分けた**サブ出力**(160x120 gray・
  動画の1秒につき8枚)を動画の2秒おきに調べる。猶予の15秒・連続一致の回数・画面固着の5分は動画の秒で数える。
  実時間で数えるのは**上限(固定120分)とハング検知(サブ出力が実時間120秒増えない)だけ**。
  上限が`min(60分×time_scale, 120分)`のままだとtime_scale=1で60分になり、2xlarge帯のth20の長いリプレイ
  (約52〜63分)がこれに当たる。
- **合否は次で判定し、重複フレーム率は使わない**(フレーム同期では取りこぼしが起きず、mpdecimateが拾うのは
  ゲームが同じ絵を2回Presentした会話・暗転・静止演出だけで、誤判定になる)。
  1. **三者照合**: MODが書いたフレーム数 == 動画のフレーム数 == 音声のフレーム数(PCMがちょうど「フレーム数×2940B」)。
     合わなければ`classification: "setup_error"`で失敗にする。
  2. **理論尺との比較**: 終了を検知できた録画だけ。`EXPECTED_DURATION_SECONDS`と、再生区間
     (終了検知の位置 − リプレイの再生を確定したフレーム)のずれが、**短い側-30%・長い側+10%(どちらも3秒を下限)**を
     超えたら失敗にする。短い側を広く取るのは、リプレイパーサーのframeCountが理論尺を長く見積もることがあるため。
     実測(再生区間/理論尺)は、th12・th15・th13・th20・th09・th10・th11・th128・th06c・th06ncが-0.5〜+0.6%、
     th07が-3.9%、th08が-4.95%、th06が-2.1〜-5.65%。**th06の1本(Extra、理論862秒)は-14.2%**だったが、
     同じリプレイを実時間の経路で録ると総録画時間が753.8秒でスコアも最終まで一致し、録画は正しく
     パーサーの値が長すぎた。取りこぼしのない録画を捨ててジョブを別の段へ回すほうが損なので、
     リプレイが再生されなかった・途中で止まった録画(-100%〜大幅な短縮)を弾く値にする。
  Wineのクラッシュ検知(`wine.log`の`Unhandled`、Issue #267)・スコア0の検知・デシンクの事後検証(スコア照合)は
  実時間の経路と同じものを使う。
- **ワーカーの中ではリトライしない**。決定的なので、同じ条件でやり直しても結果は変わらない。失敗は終了コード1と
  `diagnostics/attempt1-<分類>.jpg`(`frame_mismatch`・`duration_mismatch`・`score_zero`・`crashed`等)で残し、
  Step Functionsのリトライ・フォールバックに任せる。Wineのクラッシュは非決定的だが、同じ理由で
  ワーカーの中のリトライはせず、Step Functionsの1試行にする。
- **進捗は動画のフレーム数が基準**: サブ出力の枚数から「リプレイ再生開始からの録画済みの尺」を求めて報告する
  (実時間の経路の`elapsed/time_scale`に当たる)。メニュー区間(動画の先頭の10〜15秒)は含めない。
- **配信版のカットはフレーム番号で決める**(`cut.compute_frame_sync_cut_range()`)。
  - 開始: MODログの`FrameSync: unthrottled=1 at frame=N`のフレームから、`sequence complete`より前の
    最後のStep行までの**実時間の差を60Hzのフレーム数へ換算して遡った**位置の1秒前。メニュー区間は
    実時間60Hzで進むので、誤差は数フレームで、1秒の余裕に収まる。同期マーカーは鳴らさない(仮想音声は
    映像と決定論的に一致するので不要)。
  - 終了: 終了検知の連続一致が始まったサブ出力の位置(動画の秒)。
  動画の先頭10〜15秒は等速のメニュー区間で、その長さは録画ごとに揺れる(ログの位置を基準にする理由)。
- **FIFOのバッファは1MiBへ広げるが、広げられなくても録画は続ける**(`framesync._grow_pipe_buffer()`)。コンテナは
  `CAP_SYS_RESOURCE`を持たないので、ホストの同じユーザー(root)のパイプのバッファの総量が
  `/proc/sys/fs/pipe-user-pages-soft`(既定16384ページ)を超えているとEPERMになる。実際に自宅ワーカー機で、
  並列に走らせた2本目以降が1MiBを得られず、既定の64KiB未満(8KiB)になった。512KiB→256KiB→128KiBと小さくして
  試し、全部だめなら既定のまま、警告をログに残す。速度への影響は1280x960のタイトル(CPU描画が律速)では見えなかった。
  自宅ワーカーで640x480のタイトルが遅いと感じたら、`docker run`の追加引数(`home-worker`の設定)へ
  `--cap-add=SYS_RESOURCE`を足すと上限を受けずに済む。
- **`CalcFPS=0`**: vpatchを注入するタイトル(th06・th07・th10・th12)は、フレーム同期のときも`vpatch.ini`の
  `CalcFPS`を0にする(`with_runtime_overrides()`)。GameFPSは60のまま。
- **Xvfbは引き続き使う**(`LIBGL_ALWAYS_SOFTWARE=1`、ゲームの起動に要る)。ウィンドウ座標・クロップは使わない。
  th20のthpracはウィンドウの出現を待ってからアタッチする。
- **`FRAME_SYNC_SKIP_PRESENT=1`は既定では使わない**(数%〜1割速くなるが、フル尺では未検証)。
- **ジョブ専用のPulseAudio sinkは作る**(音声はPulseAudioから録らないが、Wineの出力先が無いと初期化で警告・遅延が
  出るので、実時間の経路と同じ`pulse.job_sink()`を通す)。

## 根拠

全13タイトルを各1本、**本番のジョブ(S3のリプレイ)のフル尺で**、本番のワーカーイメージ(`worker/Dockerfile`のビルド)を
使って自宅ワーカー機で録画し、三者照合・理論尺・スコア・視聴で確認した
([`docs/reports/2026-11-22-worker-frame-sync-full-length-verification.md`](../reports/2026-11-22-worker-frame-sync-full-length-verification.md))。
ユニットテストは`worker/tests/test_recording_framesync.py`(ffmpegとMODはモック)。

## 採らなかった選択肢

- **ワーカーの中でリトライする**: フレーム同期は決定的で、同じ条件の再実行は同じ結果になる。実時間の経路の
  リトライは「処理落ちという確率的な事象」のためのもので、ここには当てはまらない。1試行の失敗に
  フル尺の録画時間(数十分)を3回重ねるだけになる。
- **重複フレーム率の閾値を調整して残す**: 会話・暗転・静止演出(重複が構造的に多い場面)があるタイトルで、
  取りこぼしのない録画を誤って破棄する。実時間の経路が見ていた「取りこぼし」は原理的に起きない。
- **録画の上限を`TIMEOUT_SEC×time_scale`のまま使う**: 上記のとおり60分になり、長いリプレイを打ち切る。
- **進捗を「書き出したフレーム数/60」のまま報告する**: メニュー区間(動画の先頭の10〜15秒)が含まれ、
  分母のリプレイの長さ(`EXPECTED_DURATION_SECONDS`)に対して進捗が先走る。
- **カット位置のためにMODのStep行へフレーム番号を足す**: 契約(`core/log_contract.h`)と全タイトルのMODの変更に
  なる。ログの時刻と上限解除のフレーム番号で十分な精度が出るので見送った。

## 影響範囲

- `worker/recording/framesync.py`(新規)・`pipeline.py`(分岐と`build_end_detection()`)・`timing.py`・`config.py`・
  `cut.py`・`modlog.py`
- `worker/README.md` §3(`CAPTURE_MODE`)・`worker/docs/recording-package.md`
- `docs/known-limitations.md` §3(#93、重複フレーム率のチェックはフレーム同期の段では使わない)
- 起動側が`CAPTURE_MODE`を渡す仕組みは0073(`apps/api/src/workerEnv.ts`)。**段を切り替える(#390)まで本番には流れない**。
- MODのログの書式(`FrameSync: capture start / unthrottled / capture stopped`)を変えるときは、
  `mods/core/log_contract.h`と`recording/modlog.py`の両方を直す。
