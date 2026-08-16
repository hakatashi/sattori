import { beforeEach, describe, expect, it, vi } from "vitest";
import { trackParseError, trackPageview } from "./analytics.ts";

/** jsdomのBlobは`.text()`を実装していないため、FileReaderで内容を読む。 */
function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function lastBeaconPayload(sendBeacon: ReturnType<typeof vi.fn>): Promise<unknown> {
  const call = sendBeacon.mock.calls.at(-1) as [string, Blob] | undefined;
  expect(call).toBeTruthy();
  const [path, blob] = call!;
  expect(path).toBe("/beacon");
  return JSON.parse(await readBlobAsText(blob));
}

describe("analytics beacon", () => {
  const sendBeacon = vi.fn().mockReturnValue(true);

  beforeEach(() => {
    sendBeacon.mockClear();
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    window.history.pushState({}, "", "/");
  });

  it("trackPageviewはUUIDセグメントを:idに正規化してから送る(jobIdのような秘密値を含めないため)", async () => {
    trackPageview("/jobs/1b7e4c3e-2f9a-4b1a-9c3e-8f2a5d6e7b10");

    const payload = (await lastBeaconPayload(sendBeacon)) as { path: string };
    expect(payload.path).toBe("/jobs/:id");
  });

  it("trackPageviewはutmパラメータとreferrerを送る", async () => {
    window.history.pushState({}, "", "/?utm_source=twitter&utm_medium=social&utm_campaign=launch");

    trackPageview("/");

    const payload = (await lastBeaconPayload(sendBeacon)) as {
      type: string;
      utmSource: string | null;
      utmMedium: string | null;
      utmCampaign: string | null;
    };
    expect(payload).toMatchObject({
      type: "pageview",
      utmSource: "twitter",
      utmMedium: "social",
      utmCampaign: "launch",
    });
  });

  it("trackParseErrorはerrorCodeとgameを送る", async () => {
    trackParseError("unsupported_game", "th09");

    const payload = await lastBeaconPayload(sendBeacon);
    expect(payload).toEqual({ type: "parse_error", errorCode: "unsupported_game", game: "th09" });
  });
});
