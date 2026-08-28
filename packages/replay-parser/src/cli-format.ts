import type { ParsedReplay, ReplayResourceCount, ReplayStageSplit } from "./types.js";

/**
 * Formats a frame count into a human-readable duration string.
 * Main-series games run at 60 fps.
 * Example: 51120 -> "14m 12s (51,120 frames)"
 */
export function formatDuration(frames: number | null): string {
  if (frames == null) {
    return "-";
  }

  const totalSeconds = Math.floor(frames / 60);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const formattedFrames = frames.toLocaleString("en-US");
  let timeStr = "";

  if (hours > 0) {
    timeStr = `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  } else if (minutes > 0) {
    timeStr = `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  } else {
    timeStr = `${seconds}s`;
  }

  return `${timeStr} (${formattedFrames} frames)`;
}

/**
 * Formats a stage split frame count into a compact duration string.
 * Example: 7500 -> "2m 05s"
 */
export function formatSplitDuration(frames: number | null): string {
  if (frames == null) {
    return "-";
  }

  const totalSeconds = Math.floor(frames / 60);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/**
 * Formats score with comma separators.
 */
export function formatScore(score: number | null): string {
  return score != null ? score.toLocaleString("en-US") : "-";
}

/**
 * Formats cleared status.
 */
export function formatCleared(cleared: boolean | null): string {
  if (cleared === true) return "Yes";
  if (cleared === false) return "No";
  return "-";
}

/**
 * Formats character display name with localized Japanese and English names.
 */
export function formatCharacter(replay: ParsedReplay): string {
  const { character, characterNameJa, characterNameEn } = replay;

  const localizedParts: string[] = [];
  if (characterNameJa) localizedParts.push(characterNameJa);
  if (characterNameEn) localizedParts.push(characterNameEn);

  if (localizedParts.length > 0) {
    const localizedStr = localizedParts.join(" / ");
    if (character && character !== characterNameJa && character !== characterNameEn) {
      return `${localizedStr} (${character})`;
    }
    return localizedStr;
  }

  return character ?? "-";
}

function formatResource(res: ReplayResourceCount | null): string {
  if (res == null) return "-";
  if (res.pieces != null) {
    return `${res.count} (${res.pieces})`;
  }
  return String(res.count);
}

/**
 * Formats a splits table.
 */
export function formatSplitsTable(splits: readonly ReplayStageSplit[]): string {
  if (splits.length === 0) {
    return "Splits: (none)";
  }

  const headers = ["Stage", "Score", "Power", "Lives", "Bombs", "Graze", "Duration"];

  const rows = splits.map((split) => [
    split.stage != null ? String(split.stage) : "-",
    formatScore(split.score),
    split.power ?? "-",
    formatResource(split.lives),
    formatResource(split.bombs),
    split.graze != null ? split.graze.toLocaleString("en-US") : "-",
    formatSplitDuration(split.frameCount),
  ]);

  const colWidths = headers.map((header, colIdx) => {
    let max = header.length;
    for (const row of rows) {
      const cell = row[colIdx]!;
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const formatRow = (cells: string[]) =>
    "  " +
    cells
      .map((cell, idx) => {
        const width = colWidths[idx]!;
        // Left-align Stage, Lives, Bombs. Right-align others.
        if (idx === 0 || idx === 3 || idx === 4) {
          return cell.padEnd(width);
        }
        return cell.padStart(width);
      })
      .join("  ");

  const headerLine = formatRow(headers);
  const totalLength = headerLine.length;
  const separator = "  " + "-".repeat(totalLength - 2);

  const lines = ["Splits:", headerLine, separator];
  for (const row of rows) {
    lines.push(formatRow(row));
  }

  return lines.join("\n");
}

/**
 * Formats replay parse results into human-readable summary text.
 */
export function formatReplayText(
  filename: string,
  replay: ParsedReplay,
  options?: { splits?: boolean },
): string {
  const fields: [string, string][] = [
    ["File", filename],
    ["Game", `${replay.gameTitle} (${replay.game})`],
    ["Player", replay.player ?? "-"],
    ["Date", replay.date ?? "-"],
    ["Character", formatCharacter(replay)],
    ["Difficulty", replay.difficulty ?? "-"],
    ["Stage", replay.stage ?? "-"],
    ["Score", formatScore(replay.score)],
    ["Cleared", formatCleared(replay.cleared)],
    ["Duration", formatDuration(replay.frameCount)],
  ];

  const lines = fields.map(([key, val]) => `${(key + ":").padEnd(13)}${val}`);

  if (options?.splits && replay.splits.length > 0) {
    lines.push("", formatSplitsTable(replay.splits));
  }

  return lines.join("\n");
}

/**
 * Formats replay parse result into JSON string.
 */
export function formatReplayJson(filename: string, replay: ParsedReplay, pretty: boolean): string {
  const obj = {
    file: filename,
    ...replay,
  };
  return pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
}
