import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { UploadForm } from "./UploadForm.tsx";
import * as client from "../api/client.ts";

vi.mock("../api/client.ts", () => ({
  SattoriApiError: class extends Error {},
  createUpload: vi.fn(),
  uploadReplay: vi.fn(),
  createJob: vi.fn(),
}));

const mocked = vi.mocked(client);

function selectFile(name: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["dummy"], name, { type: "application/octet-stream" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return file;
}

describe("UploadForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ファイル未選択では録画開始ボタンが無効", () => {
    render(<UploadForm onJobStarted={vi.fn()} />);
    const button = screen.getByRole("button", { name: "録画を開始する" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it(".rpy 以外を選ぶとエラー表示", () => {
    render(<UploadForm onJobStarted={vi.fn()} />);
    selectFile("bad.txt");
    expect(screen.getByText("リプレイファイル（.rpy）を選択してください")).toBeTruthy();
  });

  it("アップロード→ジョブ起動が順に呼ばれ onJobStarted が発火する", async () => {
    mocked.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mocked.uploadReplay.mockResolvedValue(undefined);
    mocked.createJob.mockResolvedValue({ jobId: "job-42", status: "launching" });
    const onJobStarted = vi.fn();

    render(<UploadForm onJobStarted={onJobStarted} />);
    selectFile("th7_07.rpy");
    screen.getByRole("button", { name: "録画を開始する" }).click();

    await waitFor(() => expect(onJobStarted).toHaveBeenCalledWith("job-42"));
    expect(mocked.createUpload).toHaveBeenCalledWith({ filename: "th7_07.rpy", size: 5 });
    expect(mocked.uploadReplay).toHaveBeenCalledWith("https://s3/put", expect.any(File));
    expect(mocked.createJob).toHaveBeenCalledWith("replays/x.rpy", { watermark: true });
  });
});
