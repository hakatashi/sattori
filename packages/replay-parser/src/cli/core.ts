import { parseCliArgs } from "./args.js";
import { formatReplayJson, formatReplayText } from "./format.js";
import { parseReplay } from "../index.js";

export interface CliIO {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  readStdin: () => Promise<Uint8Array>;
  readFile: (path: string) => Promise<Uint8Array>;
  isStdinTTY: () => boolean;
  version: string;
}

export function buildHelpText(): string {
  return [
    "Usage: touhou-replay-parser [options] <file...>",
    "       threp [options] <file...>",
    "       cat replay.rpy | threp [options]",
    "",
    "Decoder for Touhou Project replay files (.rpy), covering th06 through th20.",
    "",
    "Arguments:",
    "  <file...>            One or more .rpy files to parse. Use '-' for stdin.",
    "                       If no files are specified and stdin is piped, reads from stdin.",
    "",
    "Options:",
    "  -j, --json           Output result as JSON. Defaults to NDJSON (one line per record)",
    "                       when multiple files are parsed.",
    "  -s, --splits         Show per-stage split records (text mode only).",
    "  -h, --help           Display this help message.",
    "  -v, --version        Display version number.",
  ].join("\n");
}

/**
 * Runs the CLI with given arguments and IO interfaces.
 * Returns the exit code:
 *   0: success
 *   1: replay parse error
 *   2: argument error or file reading I/O error
 */
export async function runCli(args: readonly string[], io: CliIO): Promise<number> {
  const parsedArgs = parseCliArgs(args);
  if (!parsedArgs.ok) {
    io.stderr(`Error: ${parsedArgs.error}\n\n${buildHelpText()}`);
    return 2;
  }

  const { options } = parsedArgs;

  if (options.help) {
    io.stdout(buildHelpText());
    return 0;
  }

  if (options.version) {
    io.stdout(io.version);
    return 0;
  }

  let targetFiles = options.files;
  if (targetFiles.length === 0) {
    if (io.isStdinTTY()) {
      io.stderr(`Error: No input files specified.\n\n${buildHelpText()}`);
      return 2;
    }
    targetFiles = ["-"];
  }

  const isMultiple = targetFiles.length > 1;
  let hasParseError = false;
  let hasIoError = false;
  let printedOutputCount = 0;

  for (const file of targetFiles) {
    let data: Uint8Array;
    try {
      if (file === "-") {
        data = await io.readStdin();
      } else {
        data = await io.readFile(file);
      }
    } catch (error) {
      hasIoError = true;
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`Error: ${file}: ${message}`);
      continue;
    }

    const result = parseReplay(data);
    if (!result.ok) {
      hasParseError = true;
      io.stderr(`Error: ${file}: [${result.error.code}] ${result.error.message}`);
      continue;
    }

    if (options.json) {
      // Multiple files default to NDJSON (compact, one per line).
      // Single file outputs formatted (pretty) JSON.
      const pretty = !isMultiple;
      io.stdout(formatReplayJson(file, result.replay, pretty));
    } else {
      if (printedOutputCount > 0) {
        io.stdout("");
      }
      io.stdout(formatReplayText(file, result.replay, { splits: options.splits }));
    }
    printedOutputCount++;
  }

  if (hasIoError) return 2;
  if (hasParseError) return 1;
  return 0;
}
