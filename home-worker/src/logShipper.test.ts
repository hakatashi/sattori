/** CloudWatch Logsへのログ転送のテスト。 */
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloudWatchLogShipper,
  MAX_BATCH_BYTES,
  MAX_BATCH_SIZE,
  MAX_EVENT_BYTES,
} from "./logShipper.js";

const logsMock = mockClient(CloudWatchLogsClient);

beforeEach(() => {
  logsMock.reset();
  logsMock.on(CreateLogStreamCommand).resolves({});
  logsMock.on(PutLogEventsCommand).resolves({});
});

const makeShipper = (options: { log?: (message: string) => void } = {}): CloudWatchLogShipper =>
  new CloudWatchLogShipper(
    new CloudWatchLogsClient({ region: "eu-south-2" }),
    "/sattori/worker",
    "job-1",
    // 実タイマーを持ち込まない（定期flushの検証は時計の差し替えで行う）。
    { log: options.log ?? ((): undefined => undefined), now: () => 0, autoFlush: false },
  );

/** 各PutLogEventsに載ったイベント件数。 */
function batchSizes(): number[] {
  return logsMock
    .commandCalls(PutLogEventsCommand)
    .map((call) => call.args[0].input.logEvents?.length ?? 0);
}

describe("CloudWatchLogShipper", () => {
  it("EC2ワーカーと同じストリーム名へ書く", async () => {
    const shipper = makeShipper();

    shipper.append("録画開始");
    await shipper.flush();

    expect(logsMock.commandCalls(CreateLogStreamCommand)[0]?.args[0].input).toMatchObject({
      logGroupName: "/sattori/worker",
      logStreamName: "job-1",
    });
    expect(logsMock.commandCalls(PutLogEventsCommand)[0]?.args[0].input.logEvents?.[0]).toMatchObject(
      { message: "録画開始" },
    );
  });

  it("既存ストリームでも失敗しない", async () => {
    logsMock
      .on(CreateLogStreamCommand)
      .rejects(new ResourceAlreadyExistsException({ message: "exists", $metadata: {} }));
    const shipper = makeShipper();

    shipper.append("行");
    await shipper.flush();

    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(1);
  });

  it("バッチ上限に達したら自動でflushする", async () => {
    const shipper = makeShipper();

    for (let index = 0; index < MAX_BATCH_SIZE; index += 1) {
      shipper.append(`line-${index}`);
    }
    await shipper.flush();

    expect(batchSizes()).toEqual([MAX_BATCH_SIZE]);
  });

  it("バイト数の上限でもバッチを切る(1MiB超のリクエストは再試行しても通らない)", async () => {
    // 件数だけで切っていると、長い行が続いた回に上限超過の400で丸ごと捨てられる。
    const shipper = makeShipper();
    const line = "x".repeat(100_000);

    for (let index = 0; index < 12; index += 1) {
      shipper.append(line);
    }
    await shipper.flush();

    expect(batchSizes().length).toBeGreaterThan(1);
    for (const call of logsMock.commandCalls(PutLogEventsCommand)) {
      const bytes = (call.args[0].input.logEvents ?? []).reduce(
        (total, event) => total + Buffer.byteLength(event.message ?? "", "utf8") + 26,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  it("1行が長すぎる場合は切り詰めて送る", async () => {
    const shipper = makeShipper();

    shipper.append("y".repeat(MAX_EVENT_BYTES + 5000));
    await shipper.flush();

    const message = logsMock.commandCalls(PutLogEventsCommand)[0]?.args[0].input.logEvents?.[0]
      ?.message;
    expect(Buffer.byteLength(message ?? "", "utf8")).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(message).toContain("切り詰め");
  });

  it("転送に失敗しても録画を止めず、以降の転送も諦めない", async () => {
    // 1回の失敗で転送を打ち切ると、出力が多い（＝何かが起きている）回に限って
    // 管理画面のログが尻切れになる。自宅ワーカーのジョブは instanceId が無く
    // GetConsoleOutput へのフォールバックも効かないため、控えのコピーが無い。
    logsMock.on(PutLogEventsCommand).rejects(new Error("throttled"));
    const shipper = makeShipper();

    shipper.append("行1");
    await shipper.flush();
    shipper.append("行2");
    await shipper.flush();

    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(2);
  });

  it("失敗ログは間引き、復旧したら1行だけ報告する", async () => {
    const messages: string[] = [];
    logsMock.on(PutLogEventsCommand).rejects(new Error("throttled"));
    const shipper = makeShipper({ log: (message) => messages.push(message) });

    for (let index = 0; index < 5; index += 1) {
      shipper.append(`行${index}`);
      await shipper.flush();
    }
    // 5回失敗しても、うるさくならないよう出すのは最初の1回だけ。
    expect(messages).toHaveLength(1);

    logsMock.on(PutLogEventsCommand).resolves({});
    shipper.append("復旧後");
    await shipper.flush();

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("復旧");
  });

  it("closeで残りを送り、破棄した行数を報告する", async () => {
    const messages: string[] = [];
    logsMock.on(PutLogEventsCommand).rejects(new Error("throttled"));
    const shipper = makeShipper({ log: (message) => messages.push(message) });

    shipper.append("行1");
    shipper.append("行2");
    await shipper.close();

    expect(messages.at(-1)).toContain("転送できなかった行が2行");
  });

  it("バッファが空ならAPIを叩かない", async () => {
    const shipper = makeShipper();

    await shipper.flush();

    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(0);
  });

  it("一定時間が経てば件数が少なくてもflushする", async () => {
    let now = 0;
    const shipper = new CloudWatchLogShipper(
      new CloudWatchLogsClient({ region: "eu-south-2" }),
      "/sattori/worker",
      "job-1",
      { log: () => undefined, now: () => now, autoFlush: false },
    );

    shipper.append("行1");
    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(0);

    now = 10_000;
    shipper.append("行2");
    await shipper.flush();

    // 1回目のflushで2行、その後は空。
    expect(batchSizes()).toEqual([2]);
  });
});
