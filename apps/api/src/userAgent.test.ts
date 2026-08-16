import { describe, expect, it } from "vitest";
import { classifyUserAgent } from "./userAgent.js";

describe("classifyUserAgent", () => {
  it("nullなら両方nullを返す", () => {
    expect(classifyUserAgent(null)).toEqual({ browserFamily: null, osFamily: null });
  });

  it("Windows上のChromeを判定する", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    expect(classifyUserAgent(ua)).toEqual({ browserFamily: "chrome", osFamily: "windows" });
  });

  it("ChromeのUAに含まれるSafariトークンに惑わされずEdgeと判定する", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";
    expect(classifyUserAgent(ua)).toEqual({ browserFamily: "edge", osFamily: "windows" });
  });

  it("macOS上のSafariを判定する", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    expect(classifyUserAgent(ua)).toEqual({ browserFamily: "safari", osFamily: "macos" });
  });

  it("iOS版ChromeをChrome/iOSと判定する", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1";
    expect(classifyUserAgent(ua)).toEqual({ browserFamily: "chrome", osFamily: "ios" });
  });

  it("AndroidのFirefoxを判定する", () => {
    const ua = "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0";
    expect(classifyUserAgent(ua)).toEqual({ browserFamily: "firefox", osFamily: "android" });
  });

  it("Linux上のブラウザを判定する", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    expect(classifyUserAgent(ua)).toEqual({ browserFamily: "chrome", osFamily: "linux" });
  });

  it("未知のUAはotherへ縮退する", () => {
    expect(classifyUserAgent("some-bot/1.0")).toEqual({ browserFamily: "other", osFamily: "other" });
  });
});
