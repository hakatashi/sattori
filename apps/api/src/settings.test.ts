import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { DEFAULT_MONTHLY_COST_LIMIT_USD } from "@sattori/shared";
import { getSettings, updateSettings } from "./settings.js";

describe("settings", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddbMock.reset();
  });

  describe("getSettings", () => {
    it("itemが存在しなければ既定値(受付中・既定の月間上限額)を返す", async () => {
      ddbMock.on(GetCommand).resolves({});
      const settings = await getSettings("settings-table");
      expect(settings).toEqual({
        acceptingNewJobs: true,
        monthlyCostLimitUsd: DEFAULT_MONTHLY_COST_LIMIT_USD,
      });
    });

    it("itemが存在すればその値を返す", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { settingKey: "global", acceptingNewJobs: false, monthlyCostLimitUsd: 30 },
      });
      const settings = await getSettings("settings-table");
      expect(settings).toEqual({ acceptingNewJobs: false, monthlyCostLimitUsd: 30 });
    });
  });

  describe("updateSettings", () => {
    it("指定したフィールドだけを更新し、他は現在値(または既定値)を保つ", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { settingKey: "global", acceptingNewJobs: true, monthlyCostLimitUsd: 50 },
      });
      ddbMock.on(PutCommand).resolves({});

      const updated = await updateSettings("settings-table", { acceptingNewJobs: false });
      expect(updated).toEqual({ acceptingNewJobs: false, monthlyCostLimitUsd: 50 });

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]?.args[0].input.Item).toEqual({
        settingKey: "global",
        acceptingNewJobs: false,
        monthlyCostLimitUsd: 50,
      });
    });

    it("itemが存在しない状態からの更新は既定値をベースにマージする", async () => {
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const updated = await updateSettings("settings-table", { monthlyCostLimitUsd: 80 });
      expect(updated).toEqual({ acceptingNewJobs: true, monthlyCostLimitUsd: 80 });
    });
  });
});
