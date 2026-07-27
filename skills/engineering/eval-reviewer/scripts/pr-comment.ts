/**
 * Turn .eval-reviewer/verdict.json into a GitHub pull request review.
 *
 * This is deliberately a separate script, not a step inside the orchestrator.
 * The review writes two files and an exit code; everything downstream — a
 * webhook, a Slack message, a gate — is a shell line over verdict.json. This
 * one is in the repo only because posting inline comments has a failure mode
 * that costs the whole review:
 *
 *   GitHub rejects the entire review with 422 if any single comment anchors to
 *   a line that is not in the diff.
 *
 * So one hallucinated line number loses every finding. Anchors are checked
 * against the diff's own hunks here, and anything that does not anchor is
 * moved into the review body rather than dropped.
 *
 *   node scripts/pr-comment.ts --diff /tmp/target.diff            # print payload
 *   node scripts/pr-comment.ts --diff /tmp/target.diff --pr 42    # post it
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = `eval-reviewer pr-comment — post the findings as a PR review

Usage:
  pr-comment.ts --diff <path> [--pr <number>]

Options:
  --diff PATH      the diff the review ran against — anchors are validated
                   against its hunks (required)
  --verdict PATH   default: .eval-reviewer/verdict.json
  --pr NUMBER      post to this pull request; without it the payload is
                   printed and nothing is sent
  --out PATH       also write the payload here
  --repo OWNER/REPO  default: whatever gh resolves in the working directory
  --help

Findings with no line, or a line the diff does not contain, are listed in the
review body instead of being dropped.`;

interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number | null;
  message: string;
  suggestion: string;
}

interface Verdict {
  overall: string;
  breakdown: Record<string, number>;
  findings?: Finding[];
  agents: Record<string, { status: string; error?: string }>;
}

function fail(message: string, ...detail: string[]): never {
  console.error(`pr-comment: ${message}`);
  for (const line of detail) if (line) console.error(`  ${line}`);
  process.exit(1);
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "help") {
      console.log(USAGE);
      process.exit(0);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      fail(`--${key} needs a value.`);
    }
    flags[key] = next;
    i++;
  }
  return flags;
}

/**
 * Line numbers that exist on the right-hand side of a unified diff, per file.
 *
 * Both added and context lines count: GitHub accepts a comment on any line
 * inside a hunk. Removed lines do not — they have no line number in the new
 * file to anchor to.
 */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim().replace(/^b\//, "");
      if (path === "/dev/null") {
        current = undefined;
        continue;
      }
      current = files.get(path) ?? new Set<number>();
      files.set(path, current);
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (!current) continue;
    if (line.startsWith("+")) current.add(newLine++);
    else if (line.startsWith("-")) continue;
    else if (line.startsWith(" ")) current.add(newLine++);
    // Everything else (\ No newline, diff --git, index, ---) moves nothing.
  }

  return files;
}

const LABEL: Record<Finding["severity"], string> = {
  critical: "**CRITICAL**",
  high: "**HIGH**",
  medium: "**MEDIUM**",
  low: "**LOW**",
};

function commentBody(finding: Finding): string {
  return `${LABEL[finding.severity]} — ${finding.message}\n\n${finding.suggestion}`;
}

const flags = parseFlags(process.argv.slice(2));

const verdictPath = resolve(flags.verdict ?? ".eval-reviewer/verdict.json");
if (!existsSync(verdictPath)) {
  fail(
    `no verdict at ${verdictPath}.`,
    "Run scripts/review.ts first, or pass --verdict PATH."
  );
}

if (!flags.diff) fail("--diff is required.", USAGE);
const diffPath = resolve(flags.diff);
if (!existsSync(diffPath)) fail(`no diff at ${diffPath}.`);

const verdict = JSON.parse(readFileSync(verdictPath, "utf-8")) as Verdict;
const findings = verdict.findings ?? [];
if (!Array.isArray(verdict.findings)) {
  fail(
    `${verdictPath} has no "findings" array.`,
    "It was written by an older eval-reviewer — re-run the review."
  );
}

const diffLines = parseDiffLines(readFileSync(diffPath, "utf-8"));

const anchored: { path: string; line: number; body: string }[] = [];
const unanchored: Finding[] = [];

for (const finding of findings) {
  const lines = diffLines.get(finding.file);
  if (finding.line == null || !lines?.has(finding.line)) {
    unanchored.push(finding);
    continue;
  }
  anchored.push({
    path: finding.file,
    line: finding.line,
    body: commentBody(finding),
  });
}

const counts = verdict.breakdown;
const body: string[] = [
  `## eval-reviewer: ${verdict.overall}`,
  "",
  `${findings.length} finding${findings.length === 1 ? "" : "s"} — ` +
    `${counts.critical} critical, ${counts.high} high, ` +
    `${counts.medium} medium, ${counts.low} low.`,
];

const failed = Object.entries(verdict.agents).filter(
  ([, agent]) => agent.status !== "done"
);
if (failed.length > 0) {
  body.push(
    "",
    "### Personas that did not report",
    "",
    "Their angles are missing from this review.",
    ""
  );
  for (const [name, agent] of failed) {
    body.push(`- **${name}**: ${agent.error ?? agent.status}`);
  }
}

if (unanchored.length > 0) {
  body.push(
    "",
    "### Not anchored to a line",
    "",
    "These name a file the diff does not touch at that line, so they are here",
    "rather than inline.",
    ""
  );
  for (const finding of unanchored) {
    const where = finding.line == null ? finding.file : `${finding.file}:${finding.line}`;
    body.push(
      `- ${LABEL[finding.severity]} \`${where}\` — ${finding.message}`
    );
  }
}

const payload = {
  event: "COMMENT" as const,
  body: body.join("\n"),
  comments: anchored.map((comment) => ({ ...comment, side: "RIGHT" as const })),
};

if (flags.out) {
  writeFileSync(resolve(flags.out), `${JSON.stringify(payload, null, 2)}\n`);
}

console.error(
  `${anchored.length} inline, ${unanchored.length} in the body, ` +
    `${findings.length} total.`
);

if (!flags.pr) {
  console.log(JSON.stringify(payload, null, 2));
  console.error("No --pr given, so nothing was posted.");
  process.exit(0);
}

const repoFlag = flags.repo ? ["--repo", flags.repo] : [];
let commitId: string;
try {
  commitId = execFileSync(
    "gh",
    ["pr", "view", flags.pr, ...repoFlag, "--json", "headRefOid", "--jq", ".headRefOid"],
    { encoding: "utf-8" }
  ).trim();
} catch (error) {
  fail(
    `could not read PR ${flags.pr} with gh.`,
    error instanceof Error ? error.message : String(error)
  );
}

const repoPath = flags.repo ?? "{owner}/{repo}";
try {
  execFileSync(
    "gh",
    ["api", `repos/${repoPath}/pulls/${flags.pr}/reviews`, "--method", "POST", "--input", "-"],
    {
      encoding: "utf-8",
      input: JSON.stringify({ ...payload, commit_id: commitId }),
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
} catch (error) {
  fail(
    `gh rejected the review for PR ${flags.pr}.`,
    error instanceof Error ? error.message : String(error),
    "A 422 here means an anchor slipped through — re-run with the same --diff",
    "the review used, not a regenerated one."
  );
}

console.error(`Posted to PR ${flags.pr} at ${commitId.slice(0, 7)}.`);
