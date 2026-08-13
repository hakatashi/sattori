import { useEffect, useRef, useState } from "react";
import { recordingWallClockScale } from "@sattori/shared";
import type { GetJobResponse, JobStatus } from "@sattori/shared";
import { MIN_CONVERTING_RATE } from "./jobProgressBudget.ts";

/**
 * 録画フェーズはリプレイを再生しながら録画するため、進捗(コンテンツ秒数)の進む速度は
 * 実時間1秒あたり1秒で確定している。ただし低速録画(Issue #68)ではゲームが半分の速度で
 * 走るため、実時間1秒あたりコンテンツ0.5秒しか進まない(`recordingRate()`)。
 * 変換フェーズはサーバースペックに応じて4〜6倍速程度で進む想定だが、個々のジョブでどの速度に
 * なるかは事前に分からないため、実測データが集まるまでの初期値として保守的な下限寄りの値を使う。
 */
function recordingRate(slowMotion: boolean): number {
  return 1 / recordingWallClockScale(slowMotion);
}
const DEFAULT_CONVERTING_RATE = 4;
const MAX_CONVERTING_RATE = 8;

/**
 * 変換フェーズの速度推定に使う最小経過秒数。ごく短い間隔の2点間で速度を計算すると、
 * ポーリングの取得タイミングのわずかなブレが速度の誤差として増幅されてしまうため、
 * ある程度時間が経ってから速度を確定させる。
 */
const MIN_RATE_SAMPLE_SECONDS = 2;

const TICK_INTERVAL_MS = 250;

/**
 * ワーカーが進捗をDynamoDBへ書き込む間隔(実時間秒)。録画フェーズは
 * `worker/progress_reporter.py` の `POLL_INTERVAL_SEC`、変換フェーズは
 * `worker/convert.py` の `PROGRESS_REPORT_INTERVAL_SEC` で、どちらも10秒
 * (DynamoDBへの書き込み頻度を抑えるための間引き)。
 *
 * つまりポーリングで得られる進捗は**最大でこの秒数ぶん古い**。表示をサーバー値の
 * 手前に置く「バッファ」の幅として、また遅れを取り戻す速度の基準としてこの値を使う
 * (下記 `useEstimatedProgress` の説明を参照)。ブラウザ側のポーリング間隔
 * (`useJobPolling.ts` の3秒)がさらに加わるため、実際の遅れはこれより最大3秒大きい。
 */
const WORKER_PROGRESS_INTERVAL_SECONDS = 10;

interface PhaseStartSample {
  jobId: string;
  status: JobStatus;
  startProgress: number;
  startAt: number;
}

/** 表示中の進捗値。同一フェーズ内では単調非減少であることを保証する。 */
interface DisplaySample {
  jobId: string;
  status: JobStatus;
  /** 直近に表示した進捗(コンテンツ秒数)。 */
  value: number;
  /** `value` を最後に進めた時刻(ms)。次のティックとの差分が進める量になる。 */
  atMs: number;
}

/**
 * ポーリング間隔（3秒）でしか届かないサーバーの進捗を、実時間経過をもとに補間して
 * 滑らかに見せる。表示は次の2つを常に満たす（Issue #108）。
 *
 * 1. **同一フェーズ内で決して巻き戻らない**（時間表示が戻るのは混乱のもとになるため）。
 * 2. **直近にポーリングで得たサーバー値を追い越さない**（実際より先の時間を表示しない）。
 *
 * この2つを両立させるため、サーバー値から**外挿する**（＝先読みして追い越し、次の
 * ポーリングで巻き戻る）のではなく、サーバー値を上限とした**内挿**にしてある。
 * 具体的には、フェーズに入った時点で表示値をサーバー値より
 * `WORKER_PROGRESS_INTERVAL_SECONDS` ぶん手前に置き（サーバー値はその間隔ぶん
 * 古くなり得るので、この時点で既に「実際より遅れている」値になる）、そこから
 * フェーズの速度で進める。次のサーバー値が届く頃にちょうど現在の上限へ到達する
 * ペースになるので、表示は止まらず、かつ上限にぶつかって追い越すこともない。
 *
 * 遅れが `WORKER_PROGRESS_INTERVAL_SECONDS` 以上に開いた場合（タブが裏に回って
 * ティックが間引かれた、変換速度の推定が実際より遅かった等）は、その差を同じ秒数で
 * 埋め切る速度まで一時的に上げて追いつく。上限はあくまでサーバー値なので、
 * 追いついた先で追い越すことはない。
 *
 * サーバー値が表示値より小さくなった場合（フェーズを跨いだ進捗の持ち越し等）は
 * 表示を据え置く。巻き戻さないことを優先する。フェーズが変われば別のカウンタなので
 * 表示は新しいフェーズの値で開始する（これは巻き戻りではなく、UI上も別の行に出る）。
 *
 * 変換フェーズは同じジョブでもサーバースペックによって速度が変わるため、固定倍率ではなく、
 * そのジョブの変換フェーズ開始時点から直近のポーリング結果までの実測進捗（サーバー時刻ベース）
 * から平均速度を逆算し、以降の補間に使う。十分な実測データが無い間は保守的な既定値で補間する。
 */
export function useEstimatedProgress(job: GetJobResponse | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  const phaseStartRef = useRef<PhaseStartSample | null>(null);
  const convertingRateRef = useRef(DEFAULT_CONVERTING_RATE);
  const displayRef = useRef<DisplaySample | null>(null);

  useEffect(() => {
    if (!job || job.progress === null) {
      return;
    }

    const start = phaseStartRef.current;
    const updatedAtMs = Date.parse(job.updatedAt);

    if (!start || start.jobId !== job.jobId || start.status !== job.status) {
      phaseStartRef.current = {
        jobId: job.jobId,
        status: job.status,
        startProgress: job.progress,
        startAt: updatedAtMs,
      };
      if (job.status === "converting") {
        convertingRateRef.current = DEFAULT_CONVERTING_RATE;
      }
      return;
    }

    if (job.status === "converting") {
      const elapsedSeconds = (updatedAtMs - start.startAt) / 1000;
      if (elapsedSeconds >= MIN_RATE_SAMPLE_SECONDS && job.progress > start.startProgress) {
        const observedRate = (job.progress - start.startProgress) / elapsedSeconds;
        convertingRateRef.current = Math.min(
          MAX_CONVERTING_RATE,
          Math.max(MIN_CONVERTING_RATE, observedRate),
        );
      }
    }
  }, [job?.jobId, job?.status, job?.progress, job?.updatedAt]);

  const rate = job
    ? job.status === "recording"
      ? recordingRate(job.slowMotion)
      : job.status === "converting"
        ? convertingRateRef.current
        : undefined
    : undefined;
  const active = job !== null && job.progress !== null && rate !== undefined;

  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, job?.updatedAt]);

  // 進捗が意味を持つのは録画・変換フェーズだけ。それ以外の status で残っている
  // progress は前のフェーズ・前の試行の置き土産なので、値があっても表示しない
  // （例: リトライ後の `launching` で前回の録画進捗が「8:20 経過」と出て、録画が
  // 始まった途端に 0:00 へ戻る、という巻き戻りを防ぐ。Issue #108）。
  if (!job || job.progress === null || rate === undefined) {
    return null;
  }

  // 表示の上限。サーバー値がリプレイの長さを超えて報告された場合(録画が想定より
  // 伸びた等)でも、目盛りの外へはみ出した時間は表示しない。
  const cap = job.replayInfo?.estimatedDurationSeconds ?? null;
  const target = cap === null ? job.progress : Math.min(job.progress, cap);

  // 表示値の累積はレンダー中にrefで進める。返り値そのものがこの累積結果であり、
  // effectで更新すると1ティックぶん遅れるため。`now`(ティックのたびに更新される
  // state)からの差分で進める作りなので、同じ`now`で再レンダーされても値は変わらず、
  // StrictModeの二重レンダーでも二重に進むことはない。
  const previous = displayRef.current;
  if (!previous || previous.jobId !== job.jobId || previous.status !== job.status) {
    const value = Math.max(0, target - WORKER_PROGRESS_INTERVAL_SECONDS * rate);
    displayRef.current = { jobId: job.jobId, status: job.status, value, atMs: now };
    return value;
  }

  const elapsedSeconds = Math.max(0, (now - previous.atMs) / 1000);
  const speed = Math.max(
    rate,
    (target - previous.value) / WORKER_PROGRESS_INTERVAL_SECONDS,
  );
  const value = Math.max(
    previous.value,
    Math.min(target, previous.value + elapsedSeconds * speed),
  );
  displayRef.current = { jobId: previous.jobId, status: previous.status, value, atMs: now };
  return value;
}
