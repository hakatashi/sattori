import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../../dist/cli/index.js");
const fixturePath = resolve(__dirname, "../../test-fixtures/th07/th7_07.rpy");
const fixture2Path = resolve(__dirname, "../../test-fixtures/th07/th7_08.rpy");

describe("cli E2E", () => {
  it("prints help with --help", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: touhou-replay-parser");
    expect(stdout).toContain("threp");
  });

  it("prints version with -v", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "-v"]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("parses single replay file into summary text", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, fixturePath]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Game:        東方妖々夢 ～ Perfect Cherry Blossom. (th07)");
    expect(stdout).toContain("Player:      koyi");
    expect(stdout).toContain("Character:   魔符 / Marisa A (MarisaA)");
    expect(stdout).toContain("Difficulty:  Extra");
    expect(stdout).toContain("Score:       303,766,040");
    expect(stdout).not.toContain("Splits:");
  });

  it("parses single replay file with --splits", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "-s", fixturePath]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Splits:");
    expect(stdout).toContain("Stage");
    expect(stdout).toContain("30,376,604");
  });

  it("parses single replay file into pretty JSON", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "-j", fixturePath]);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.file).toBe(fixturePath);
    expect(parsed.game).toBe("th07");
    expect(parsed.characterNameJa).toBe("魔符");
    expect(stdout).toContain("\n  \"");
  });

  it("parses multiple replay files into NDJSON by default", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      "-j",
      fixturePath,
      fixture2Path,
    ]);
    expect(stderr).toBe("");
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(2);

    const record1 = JSON.parse(lines[0]!);
    expect(record1.file).toBe(fixturePath);
    expect(record1.difficulty).toBe("Extra");

    const record2 = JSON.parse(lines[1]!);
    expect(record2.file).toBe(fixture2Path);
    expect(record2.difficulty).toBe("Phantasm");
  });

  it("returns exit code 2 on missing file", async () => {
    try {
      await execFileAsync(process.execPath, [cliPath, "non_existent_file.rpy"]);
      expect.fail("should have failed");
    } catch (err: unknown) {
      const error = err as { code: number; stderr: string };
      expect(error.code).toBe(2);
      expect(error.stderr).toContain("ENOENT");
    }
  });

  it("reads from stdin when passed '-'", async () => {
    const child = execFile(process.execPath, [cliPath, "-j", "-"]);
    let stdoutData = "";
    let stderrData = "";

    child.stdout?.on("data", (chunk) => {
      stdoutData += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderrData += chunk;
    });

    const fs = await import("node:fs/promises");
    const buffer = await fs.readFile(fixturePath);
    child.stdin?.write(buffer);
    child.stdin?.end();

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    expect(exitCode).toBe(0);
    expect(stderrData).toBe("");
    const parsed = JSON.parse(stdoutData);
    expect(parsed.file).toBe("-");
    expect(parsed.game).toBe("th07");
  });
});
