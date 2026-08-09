/** CloudWatch Logsへのログ転送のテスト。 */
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CloudWatchLogShipper, MAX_BATCH_SIZE } from "./logShipper.js";

const logsMock = mockClient(CloudWatchLogsClient);

beforeEach(() => {
  logsMock.reset();
  logsMock.on(CreateLogStreamCommand).resolves({});
  logsMock.on(PutLogEventsCommand).resolves({});
});

const makeShipper = (): CloudWatchLogShipper =>
  new CloudWatchLogShipper(
    new CloudWatchLogsClient({ region: "eu-south-2" }),
    "/sattori/worker",
    "job-1",
    { log: () => undefined, now: () => 0 },
  );

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

    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(1);
    expect(logsMock.commandCalls(PutLogEventsCommand)[0]?.args[0].input.logEvents).toHaveLength(
      MAX_BATCH_SIZE,
    );
  });

  it("転送に失敗したら以降は諦めて録画を止めない", async () => {
    logsMock.on(PutLogEventsCommand).rejects(new Error("throttled"));
    const shipper = makeShipper();

    shipper.append("行1");
    await shipper.flush();
    shipper.append("行2");
    await shipper.flush();

    // 1回失敗した時点で無効化され、以降はAPIを叩かない。
    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(1);
  });

  it("バッファが空ならAPIを叩かない", async () => {
    const shipper = makeShipper();

    await shipper.flush();

    expect(logsMock.commandCalls(PutLogEventsCommand)).toHaveLength(0);
  });
});
