#!/usr/bin/env node
// ドキュメントのサイズ上限を機械的に強制する（Issue #118）。
// 上限値の出典は docs/documentation-guidelines.md §6.1 なので、変更するときは両方を直すこと。
//
//   pnpm check:docs           # 超過があれば終了コード1
//   pnpm check:docs --list    # 全ファイルの計測値を行数順に出す

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const KIB = 1024;
// 上限の何割を超えたら警告を出すか（ガイドライン §6.1）。上限に達してから慌てて分割するより、
// 余裕のあるうちに気づける方が望ましいため、失敗させずに警告だけ出す段階を設けてある。
const WARN_RATIO = 0.8;

const GUIDELINES = "docs/documentation-guidelines.md";

const HINT_SPLIT = [
  `→ ${GUIDELINES} の §3「追記先の判断フロー」を参照し、`,
  "  ② 決定と根拠は docs/decisions/ へ、③ 手順は docs/runbooks/ か Skill へ、",
  "  ④ 検証記録は docs/reports/ へ移してください（分割の軸は同 §6.3）。",
].join("\n");

const HINT_ALWAYS_LOADED = [
  `→ ${GUIDELINES} の §7「常時ロードされるファイルの特別扱い」を参照し、`,
  "  個別の事実は各パッケージの README や docs/decisions/ へ移してリンクだけ残してください",
  "  （毎セッション無条件にコンテキストへ載るファイルです）。",
].join("\n");

// 上から順に評価し、最初に一致した規則を適用する。README の規則を docs/ の規則より後に
// 置いているのは、docs/decisions/README.md のような索引を「パッケージのREADME」として
// 扱わないため。
const rules = [
  {
    label: "常時ロードされるファイル",
    match: (file) => file === "AGENTS.md",
    maxLines: 150,
    maxBytes: 12 * KIB,
    hint: HINT_ALWAYS_LOADED,
  },
  {
    // 1件が長いこと自体は問題ない（不変で、必要な人が1件だけ開く）ため上限を設けない。
    label: "検証記録・調査レポート",
    match: (file) => file.startsWith("docs/reports/") || file.startsWith("docs/research/"),
    maxLines: null,
  },
  {
    label: "docs/ 配下",
    match: (file) => file.startsWith("docs/") || file.includes("/docs/"),
    maxLines: 500,
    hint: HINT_SPLIT,
  },
  {
    // npm 公開パッケージで、利用者向けAPIリファレンスを兼ねるため別枠（外部リンクで分割できない）。
    label: "npm公開パッケージのREADME",
    match: (file) => file === "packages/replay-parser/README.md",
    maxLines: 500,
    hint: HINT_SPLIT,
  },
  {
    label: "パッケージのREADME",
    match: (file) => file === "README.md" || file.endsWith("/README.md"),
    maxLines: 300,
    hint: HINT_SPLIT,
  },
  {
    label: "その他のMarkdown",
    match: () => true,
    maxLines: 500,
    hint: HINT_SPLIT,
  },
];

// 検査対象は git が知っている Markdown だけにする。node_modules / dist / cdk.out /
// .pytest_cache などの生成物は .gitignore 済みなので、これだけで除外できる。
// 未追跡ファイル（`--others`）も含めるのは、新設したドキュメントが `git add` するまで
// 検査されない状態を避けるため。CI では追跡済みしか無いので結果は変わらない。
function listMarkdownFiles() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * KIB * KIB,
  });
  return stdout.split("\0").filter((file) => file !== "");
}

function measure(file) {
  const buffer = readFileSync(path.join(repoRoot, file));
  const text = buffer.toString("utf8");
  // 末尾の改行は1行と数えない（`wc -l` と一致させる）。
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  return { lines, bytes: buffer.byteLength };
}

function formatLines(value) {
  return `${value} 行`;
}

function formatBytes(value) {
  return `${value} バイト`;
}

// ファイル1件を、上限を持つ軸（行数・バイト数）ごとに判定する。
function evaluate(file) {
  const rule = rules.find((candidate) => candidate.match(file));
  const { lines, bytes } = measure(file);

  const axes = [];
  if (rule.maxLines != null) {
    axes.push({ value: lines, limit: rule.maxLines, format: formatLines });
  }
  if (rule.maxBytes != null) {
    axes.push({ value: bytes, limit: rule.maxBytes, format: formatBytes });
  }

  const findings = axes.map((axis) => ({
    ...axis,
    ratio: axis.value / axis.limit,
    level: axis.value > axis.limit ? "error" : axis.value >= axis.limit * WARN_RATIO ? "warn" : "ok",
  }));

  return { file, rule, lines, bytes, findings };
}

function describe(finding) {
  // 超過分は「99%」「100%」と丸めると差が消えてしまうので、超過量そのものを出す。
  const excess =
    finding.level === "error"
      ? `${finding.format(finding.value - finding.limit)}超過`
      : `${Math.round(finding.ratio * 100)}%`;
  return `${finding.format(finding.value)} (上限 ${finding.format(finding.limit)}、${excess})`;
}

// GitHub Actions のアノテーション。PR の Files changed 上に直接出るので、
// ログを開かなくても「どのファイルがどれだけ超えたか」が分かる。
function annotate(level, result, finding) {
  if (!process.env.GITHUB_ACTIONS) {
    return;
  }
  const headline = `${result.rule.label}の上限を${level === "error" ? "超過" : "まもなく超過"}: ${describe(finding)}`;
  const body = level === "error" && result.rule.hint ? `${headline}\n${result.rule.hint}` : headline;
  console.log(`::${level} file=${result.file},line=1::${body.replaceAll("\n", "%0A")}`);
}

function main() {
  const files = listMarkdownFiles();
  const results = files.map(evaluate);

  if (process.argv.includes("--list")) {
    for (const result of [...results].sort((a, b) => b.lines - a.lines)) {
      const limit = result.rule.maxLines == null ? "上限なし" : `上限 ${result.rule.maxLines} 行`;
      console.log(`${String(result.lines).padStart(5)} 行  ${result.file}  [${result.rule.label}: ${limit}]`);
    }
    console.log("");
  }

  const errors = [];
  const warnings = [];
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.level === "error") {
        errors.push({ result, finding });
      } else if (finding.level === "warn") {
        warnings.push({ result, finding });
      }
    }
  }

  if (warnings.length > 0) {
    console.log(`⚠ 上限の${Math.round(WARN_RATIO * 100)}%を超えています（分割の準備を始めてください。まだCIは落ちません）:`);
    for (const { result, finding } of warnings) {
      console.log(`  ${result.file}: ${describe(finding)}`);
      annotate("warning", result, finding);
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.log("✖ ドキュメントのサイズ上限を超えています:");
    console.log("");
    for (const { result, finding } of errors) {
      console.log(`  ${result.file}: ${describe(finding)}`);
      console.log(result.rule.hint.replace(/^/gm, "  "));
      console.log("");
      annotate("error", result, finding);
    }
    console.log(`${errors.length} 件が上限を超えています（上限の一覧は ${GUIDELINES} §6.1）。`);
    process.exitCode = 1;
    return;
  }

  console.log(`✔ ${files.length} 件のMarkdownはすべてサイズ上限内です。`);
}

main();
