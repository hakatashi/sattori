import { describe, expect, it } from "vitest";
import { runCli, type CliIO } from "./core.js";

function createMockIO(overrides?: Partial<CliIO>) {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const io: CliIO = {
    stdout: (msg) => stdoutLines.push(msg),
    stderr: (msg) => stderrLines.push(msg),
    readStdin: async () => new Uint8Array(),
    readFile: async (_path) => new Uint8Array(),
    isStdinTTY: () => true,
    version: "1.2.3",
    ...overrides,
  };

  return { io, stdoutLines, stderrLines };
}

describe("runCli", () => {
  it("shows help on --help", async () => {
    const { io, stdoutLines, stderrLines } = createMockIO();
    const code = await runCli(["--help"], io);

    expect(code).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines[0]).toContain("Usage: touhou-replay-parser");
    expect(stdoutLines[0]).toContain("threp");
  });

  it("shows version on -v", async () => {
    const { io, stdoutLines, stderrLines } = createMockIO();
    const code = await runCli(["-v"], io);

    expect(code).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toEqual(["1.2.3"]);
  });

  it("fails on unknown option", async () => {
    const { io, stdoutLines, stderrLines } = createMockIO();
    const code = await runCli(["--unknown-opt"], io);

    expect(code).toBe(2);
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines[0]).toContain("unknown option: --unknown-opt");
  });

  it("fails when no files specified on TTY stdin", async () => {
    const { io, stderrLines } = createMockIO({ isStdinTTY: () => true });
    const code = await runCli([], io);

    expect(code).toBe(2);
    expect(stderrLines[0]).toContain("No input files specified");
  });

  it("reads stdin when piped without file arguments", async () => {
    // Magic for th06 is T6RP, but shorter than full header will return too_short or corrupt.
    // Provide a minimal invalid buffer to test flow
    const dummyBuffer = new Uint8Array([0x54, 0x36, 0x52, 0x50]); // "T6RP"
    const { io, stderrLines } = createMockIO({
      isStdinTTY: () => false,
      readStdin: async () => dummyBuffer,
    });

    const code = await runCli([], io);
    // Parse error (too short for full header) -> code 1
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("Error: -: [corrupt]");
  });

  it("handles file reading I/O error", async () => {
    const { io, stderrLines } = createMockIO({
      readFile: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });

    const code = await runCli(["non_existent.rpy"], io);
    expect(code).toBe(2);
    expect(stderrLines[0]).toContain("Error: non_existent.rpy: ENOENT");
  });
});
