import type { GameId } from "./games.js";
import type { WorkerCapability, WorkerKind } from "./worker.js";

/**
 * 低速録画（Issue #68）——ユーザー向けの呼称は「低速録画」、実装上は
 * 「ゲームを 1/2 倍速で動かして録画し、後処理で等倍へ戻す」方式——に関する
 * 定数と判定。フロントエンド・API・ワーカーの3者が同じ値を参照する。
 *
 * ## なぜ低速で録画するのか
 *
 * th20（東方錦上京）は Xvfb + wined3d + llvmpipe のソフトウェアレンダリングに対して
 * 描画負荷が重く、ボム・スペルカード等の高負荷区間でゲームエンジン自体が処理落ちする
 * （touhou-recorder reports/45 でローカル実機の最低19.8fps、reports/46 で
 * `c7i.2xlarge` の最低9.1fpsを実測）。**録画側のコマ落ちではなくゲームの進行そのものが
 * 遅くなる**ため、インスタンスを上げる以外に等倍録画で品質を担保する手立てがない。
 *
 * th20 は「レンダリングfps＝ゲームロジック更新頻度」が直結した実装なので、MOD
 * （`worker/mods/common/fps_limiter_hook.*`）で `IDirect3DDevice9::Present` を
 * 30Hzへ絞ると**ゲーム進行ごとスローモーション化**でき、実時間あたりのCPU負荷が
 * 下がって処理落ちが解消する（reports/47 で最低19.8fps→安定30.0fpsを実証）。
 * 録画後に映像のPTS圧縮＋音声のリサンプルで等倍へ戻す（`worker/descale.py`）。
 *
 * ## なぜ th20 限定なのか
 *
 * 速度を落とす仕組みがタイトルのMOD側にあるため、フックを組み込んで実機検証を済ませた
 * タイトルでしか使えない（`SLOW_MOTION_SUPPORTED_GAME_IDS`）。他タイトルへの展開は
 * Issue #101。
 *
 * ## なぜ自宅ワーカー限定なのか
 *
 * 録画に**実時間で倍かかる**ため、EC2 Spot では単純にコストが倍になる。電気代しか
 * かからない自宅ワーカー（Issue #49）でのみ行う。この制約は「ワーカー側が自分の
 * 実行環境で分岐する」のではなく、**起動側が `FPS_LIMIT_TARGET_HZ` を渡すかどうか**
 * で表現する（`apps/api/src/workerEnv.ts`）。
 */

/** ゲーム本来のフレームレート（Hz）。低速録画の基準になる。 */
export const NATIVE_FRAME_RATE_HZ = 60;

/**
 * 低速録画時にゲームを走らせる目標フレームレート（Hz）。ワーカーコンテナへは
 * `FPS_LIMIT_TARGET_HZ` として渡り、MOD の Present フック・DirectSound の
 * SetFrequency フック・fps表示補正フックがこの値でスケールする。
 * touhou-recorder reports/47・48 で実証済みの値。
 */
export const SLOW_MOTION_TARGET_HZ = 30;

/**
 * 低速録画の実時間倍率（= 60 / 30 = 2）。「リプレイの再生時間（コンテンツ秒数）」に
 * 対して録画フェーズが実時間で何倍かかるかを表す。進捗バー・残り時間推定
 * （`apps/web/src/hooks/jobProgressBudget.ts`）と、録画のハードタイムアウト
 * （`worker/recording_common.py`）が同じ係数を使う。
 */
export const SLOW_MOTION_TIME_SCALE = NATIVE_FRAME_RATE_HZ / SLOW_MOTION_TARGET_HZ;

/**
 * 低速録画を行うために自宅ワーカーへ要求する能力。`WorkerCapability` の値そのものだが、
 * ルーティング（`apps/api/src/workerRouting.ts`）と可用性API・フロントエンドが
 * 同じ文字列を書き写さないよう定数にしてある。
 */
export const SLOW_MOTION_CAPABILITY: WorkerCapability = "slow-motion-recording";

/**
 * 低速録画に**対応している**タイトル（Issue #101）。
 *
 * 速度を落とす仕組みはタイトルのMOD側にある——`IDirect3DDevice9::Present` を絞る
 * `fps_limiter_hook`・音程を保つ `dsound_hook`・fps表示を補正する `fps_display_hook`
 * ——ので、これらを組み込んで実機検証まで済んだタイトルだけが対象になる。現状
 * `th20_hook.dll` のみ。
 *
 * **非対応タイトルで低速録画を要求してはならない**。ゲームは等倍で動くのに後処理だけが
 * 等倍化（PTS圧縮＋音声リサンプル）を行うため、2倍速・高ピッチの動画が出来上がり、
 * しかも元の生動画は削除される（`worker/convert.py` の `needs_separate_raw_output()`）。
 * ワーカーはこの食い違いを検知できないので、UI（グレーアウト）と API（受付時の
 * 握り潰し）の両方で入口を塞ぐ。
 */
export const SLOW_MOTION_SUPPORTED_GAME_IDS: readonly GameId[] = ["th20"];

/** そのタイトルが低速録画に対応しているか。タイトル未確定（解析前）なら false。 */
export function supportsSlowMotion(game: GameId | null): game is GameId {
  return game !== null && SLOW_MOTION_SUPPORTED_GAME_IDS.includes(game);
}

/**
 * 低速録画を既定でオンにするタイトル。等倍録画では品質が担保できないことが実機検証で
 * 判明しているタイトルだけを挙げる（現状 th20 のみ）。他タイトルは等倍で十分な品質が
 * 出ているため、倍の時間をかける既定にはしない（ユーザーが明示的に選ぶことは可能）。
 * 当然ながら `SLOW_MOTION_SUPPORTED_GAME_IDS` の部分集合でなければならない。
 */
export const SLOW_MOTION_DEFAULT_GAME_IDS: readonly GameId[] = ["th20"];

/**
 * そのタイトルで低速録画を既定オンにするか。**自宅ワーカーが使えない場合は常に false**
 * （低速録画自体が選べないため）。
 */
export function defaultSlowMotionFor(game: GameId | null, available: boolean): boolean {
  if (!available || !supportsSlowMotion(game)) {
    return false;
  }
  return SLOW_MOTION_DEFAULT_GAME_IDS.includes(game);
}

/**
 * 録画フェーズが実時間で「コンテンツ秒数の何倍」かかるか。等倍録画なら1、
 * 低速録画なら `SLOW_MOTION_TIME_SCALE`。
 */
export function recordingWallClockScale(slowMotion: boolean): number {
  return slowMotion ? SLOW_MOTION_TIME_SCALE : 1;
}

/**
 * このジョブが**実際に**低速録画で走る（走った）か。
 *
 * `options.slowMotion` はあくまでユーザーの希望であり、オファーが時間内にclaimされず
 * EC2 Fleet へフォールバックした場合は等倍録画になる（EC2で倍の時間をかけない、
 * Issue #68 の前提）。割り当てが確定していない間（`workerKind === null`）は、
 * 自宅ワーカーが空いていたからこそチェックできた option を尊重して低速録画とみなす
 * ——ジョブページの残り時間推定が、割り当て確定の瞬間に大きく飛ぶのを避けるため。
 * EC2 に確定した時点で false に落ちる。
 */
export function isSlowMotionRecording(
  options: { slowMotion: boolean },
  workerKind: WorkerKind | null,
): boolean {
  return options.slowMotion && workerKind !== "ec2";
}
