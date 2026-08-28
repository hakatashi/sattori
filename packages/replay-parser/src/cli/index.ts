#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { runCli, type CliIO } from "./core.js";

function getVersion(): string {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const content = readFileSync(pkgUrl, "utf-8");
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const defaultIO: CliIO = {
  stdout: (message) => {
    process.stdout.write(message + "\n");
  },
  stderr: (message) => {
    process.stderr.write(message + "\n");
  },
  readStdin,
  readFile: async (filePath) => {
    const buf = await readFile(filePath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
  isStdinTTY: () => Boolean(process.stdin.isTTY),
  version: getVersion(),
};

runCli(process.argv.slice(2), defaultIO).then(
  (exitCode) => {
    process.exit(exitCode);
  },
  (err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  },
);
