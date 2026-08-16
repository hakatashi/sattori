import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { JobRecord } from "@sattori/shared";
import { USD_TO_JPY_RATE } from "@sattori/shared";
import { JobCostPanel } from "./JobCostPanel.tsx";
import { CostCurrencyContext } from "./adminCurrency.ts";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "job-1",
    game: "th07",
    replayKey: "replays/abc.rpy",
    status: "done",
    options: { watermark: true, slowMotion: false },
    outputPath: "videos/job-1.mp4",
    outputPath720p: "videos/job-1-720p.mp4",
    outputBytes: 700 * 1024 * 1024,
    outputBytes720p: 1024 * 1024 * 1024,
    error: null,
    errorCode: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:36:00.000Z",
    launchedAt: "2026-08-01T00:00:00.000Z",
    doneAt: "2026-08-01T00:36:00.000Z",
    email: "user@example.com",
    workerKind: "ec2",
    instanceId: "i-1234",
    instanceType: "c7i.xlarge",
    availabilityZone: "us-east-1a",
    spotPricePerHour: 0.06,
    estimatedDurationSeconds: 900,
    progress: null,
    previewImagePath: null,
    replayInfo: null,
    pendingExpiresAt: null,
    retriedToJobId: null,
    retriedFromJobId: null,
    language: "ja",
    ...overrides,
  };
}

describe("JobCostPanel", () => {
  it("内訳と課金対象時間・単価の根拠を表示する", () => {
    render(<JobCostPanel job={makeJob()} />);

    expect(screen.getByText("EC2 Spot")).toBeTruthy();
    // 0.06 USD/h × 0.6h = 0.036
    expect(screen.getByText("$0.0360")).toBeTruthy();
    expect(screen.getByText("36分0秒")).toBeTruthy();
    expect(screen.getByText("（実測（起動〜終了））")).toBeTruthy();
    expect(screen.getByText("（起動時に記録した実測値）")).toBeTruthy();
  });

  it("実行中のジョブは増加中である旨を注記する", () => {
    render(<JobCostPanel job={makeJob({ status: "recording", doneAt: null })} />);

    expect(screen.getByText("（実行中のため現在時刻まで（増加中））")).toBeTruthy();
  });

  it("コスト算出用フィールドを持たない旧ジョブでは代用した旨を注記する", () => {
    render(
      <JobCostPanel
        job={makeJob({
          launchedAt: null,
          spotPricePerHour: null,
          outputBytes: null,
          outputBytes720p: null,
        })}
      />,
    );

    expect(screen.getByText("（起動時刻未記録のため実績平均で代用）")).toBeTruthy();
    expect(screen.getByText("（未記録のためインスタンスタイプ帯の平均値）")).toBeTruthy();
    expect(screen.getByText("未記録（このフィールド追加より前のジョブ）")).toBeTruthy();
  });

  it("EC2が一度も起動していないジョブはEC2系のコストを0にする", () => {
    render(
      <JobCostPanel
        job={makeJob({
          status: "pending",
          launchedAt: null,
          doneAt: null,
          instanceId: null,
          instanceType: null,
          spotPricePerHour: null,
          outputPath: null,
          outputPath720p: null,
          outputBytes: null,
          outputBytes720p: null,
        })}
      />,
    );

    expect(screen.getByText("（EC2未起動）")).toBeTruthy();
    // その他(Lambda/SES等)の定数ぶんだけが残る。
    expect(screen.getAllByText("$0.0020").length).toBeGreaterThan(0);
  });

  it("表示通貨に円を選ぶと円換算して表示する", () => {
    render(
      <CostCurrencyContext.Provider value={{ currency: "jpy", setCurrency: () => {} }}>
        <JobCostPanel job={makeJob()} />
      </CostCurrencyContext.Provider>,
    );

    // EC2 Spot = 0.06 USD/h × 0.6h = 0.036 USD（円は小数2桁まで）。
    const ec2Jpy = (0.036 * USD_TO_JPY_RATE).toFixed(2);
    expect(screen.getByText(`¥${ec2Jpy}`)).toBeTruthy();
    expect(screen.queryByText("$0.0360")).toBeNull();
    expect(screen.getByText(/固定レートで換算した概算/)).toBeTruthy();
  });
});
