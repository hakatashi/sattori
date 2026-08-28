import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("parses empty args", () => {
    const res = parseCliArgs([]);
    expect(res).toEqual({
      ok: true,
      options: {
        files: [],
        json: false,
        splits: false,
        help: false,
        version: false,
      },
    });
  });

  it("parses files and flags", () => {
    const res = parseCliArgs(["--json", "-s", "replay1.rpy", "replay2.rpy"]);
    expect(res).toEqual({
      ok: true,
      options: {
        files: ["replay1.rpy", "replay2.rpy"],
        json: true,
        splits: true,
        help: false,
        version: false,
      },
    });
  });

  it("handles combined short flags", () => {
    const res = parseCliArgs(["-js", "replay.rpy"]);
    expect(res).toEqual({
      ok: true,
      options: {
        files: ["replay.rpy"],
        json: true,
        splits: true,
        help: false,
        version: false,
      },
    });
  });

  it("handles single hyphen as stdin file", () => {
    const res = parseCliArgs(["-j", "-"]);
    expect(res).toEqual({
      ok: true,
      options: {
        files: ["-"],
        json: true,
        splits: false,
        help: false,
        version: false,
      },
    });
  });

  it("handles -- delimiter", () => {
    const res = parseCliArgs(["-j", "--", "--not-an-option.rpy", "-s"]);
    expect(res).toEqual({
      ok: true,
      options: {
        files: ["--not-an-option.rpy", "-s"],
        json: true,
        splits: false,
        help: false,
        version: false,
      },
    });
  });

  it("returns error for unknown options", () => {
    const resLong = parseCliArgs(["--unknown"]);
    expect(resLong).toEqual({
      ok: false,
      error: "unknown option: --unknown",
    });

    const resShort = parseCliArgs(["-x"]);
    expect(resShort).toEqual({
      ok: false,
      error: "unknown option: -x (in -x)",
    });
  });
});
