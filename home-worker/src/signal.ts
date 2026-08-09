/**
 * 一度だけ立てられるフラグと、それによって中断できる待機。
 * Python版が `threading.Event` に頼っていた「待っている最中に外から起こされる」
 * 挙動を、スレッドを使わない Node で表現するための最小限の道具。
 *
 * 用途は2つ:
 *
 * - デーモンの停止シグナル（SIGTERM を受けたらポーリング間隔の途中でも即座に
 *   ループを抜ける）。
 * - ジョブの完了シグナル（claim監視ループが最大30秒の待機の途中でも、コンテナが
 *   終わったらすぐ止まれるようにする。放置するとプロセス終了が最大30秒遅れる）。
 */
export class Signal {
  #signalled = false;
  #wakers = new Set<() => void>();

  get isSet(): boolean {
    return this.#signalled;
  }

  /** フラグを立て、待機中のすべての `wait()` を即座に解決する。 */
  set(): void {
    if (this.#signalled) {
      return;
    }
    this.#signalled = true;
    for (const wake of [...this.#wakers]) {
      wake();
    }
    this.#wakers.clear();
  }

  /** 指定ミリ秒待つ。待機中に `set()` されたらその時点で戻る。 */
  async wait(ms: number): Promise<void> {
    if (this.#signalled) {
      return;
    }
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#wakers.delete(wake);
        resolve();
      };
      // タイマーは意図的に `unref()` しない。ポーリングの待機はデーモンが生きて
      // いることそのものであり、unrefするとイベントループが空とみなされて
      // 常駐プロセスが1周目で終了してしまう。`set()` 側で `clearTimeout` するので、
      // 停止要求に対する反応が遅れることもない。
      const timer = setTimeout(wake, ms);
      this.#wakers.add(wake);
    });
  }
}

/** 単純なスリープ（中断の必要がない箇所用）。 */
export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
