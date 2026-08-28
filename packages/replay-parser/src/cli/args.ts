export interface CliOptions {
  files: string[];
  json: boolean;
  splits: boolean;
  help: boolean;
  version: boolean;
}

export type CliArgsResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string };

/**
 * Parses command-line arguments for touhou-replay-parser CLI without external dependencies.
 */
export function parseCliArgs(args: readonly string[]): CliArgsResult {
  const options: CliOptions = {
    files: [],
    json: false,
    splits: false,
    help: false,
    version: false,
  };

  let endOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (endOfOptions) {
      options.files.push(arg);
      continue;
    }

    if (arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (arg === "-") {
      // Single hyphen is treated as stdin file path
      options.files.push(arg);
      continue;
    }

    if (arg.startsWith("--")) {
      switch (arg) {
        case "--json":
          options.json = true;
          break;
        case "--splits":
          options.splits = true;
          break;
        case "--help":
          options.help = true;
          break;
        case "--version":
          options.version = true;
          break;
        default:
          return { ok: false, error: `unknown option: ${arg}` };
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const flags = arg.slice(1);
      for (const flag of flags) {
        switch (flag) {
          case "j":
            options.json = true;
            break;
          case "s":
            options.splits = true;
            break;
          case "h":
            options.help = true;
            break;
          case "v":
            options.version = true;
            break;
          default:
            return { ok: false, error: `unknown option: -${flag} (in ${arg})` };
        }
      }
      continue;
    }

    options.files.push(arg);
  }

  return { ok: true, options };
}
