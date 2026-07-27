#!/usr/bin/env bun
/**
 * Orchestrator — runs each persona as an independent sandboxed agent, then
 * merges their findings into one report.
 *
 * Sandcastle owns process lifecycle, isolation, timeouts, and structured
 * output. This file owns configuration, prompt assembly, and the merge —
 * the merge is deliberately plain code so the same findings always produce
 * the same verdict.
 *
 * Usage:
 *   bun orchestrator.ts <path-to-diff-or-code> [options]
 *
 * Options:
 *   --personas skeptic,architect,security  Subset of the configured personas
 *   --config path/to/config.yaml           Override the config file
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// ─── Config ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
  agent: z.object({
    provider: z.string(),
    model: z.string(),
    thinking: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    // Names only — values are read from the host environment at run time, so
    // no credential is ever written into this file.
    forwardEnv: z.array(z.string()).default([]),
  }),
  sandbox: z.object({
    provider: z.string(),
    imageName: z.string().optional(),
    mounts: z
      .array(
        z.object({
          hostPath: z.string(),
          sandboxPath: z.string(),
          readonly: z.boolean().default(false),
        })
      )
      .default([]),
  }),
  review: z
    .object({
      maxConcurrent: z.number().int().positive().default(3),
      idleTimeoutSeconds: z.number().int().positive().default(600),
      completionTimeoutSeconds: z.number().int().positive().default(60),
      maxRetries: z.number().int().min(0).default(2),
      branchPrefix: z.string().default("eval-review/"),
    })
    // prefault, not default: fills in an empty object *before* parsing, so the
    // per-field defaults above apply when the whole block is omitted.
    .prefault({}),
  personas: z
    .array(z.object({ name: z.string(), critical: z.boolean().default(false) }))
    .min(1),
});

type Config = z.infer<typeof configSchema>;

/**
 * Agent providers. Sandcastle exports claudeCode, codex, cursor, opencode and
 * copilot alongside pi — add one here to make it selectable from config.yaml.
 *
 * Structured-output retries need a provider that can resume a session, which
 * pi, claudeCode and codex support and the others do not.
 */
const AGENTS: Record<
  string,
  (c: Config["agent"], env: Record<string, string>) => sandcastle.AgentProvider
> = {
  pi: (c, env) =>
    sandcastle.pi(c.model, {
      ...(c.thinking ? { thinking: c.thinking } : {}),
      env,
    }),
};

/**
 * Sandbox providers. Sandcastle also ships podman, vercel and no-sandbox.
 */
const SANDBOXES: Record<
  string,
  (c: Config["sandbox"]) => sandcastle.SandboxProvider
> = {
  docker: (c) =>
    docker({
      ...(c.imageName ? { imageName: c.imageName } : {}),
      ...(c.mounts.length > 0 ? { mounts: c.mounts } : {}),
    }),
};

/**
 * Read the named variables out of the host environment.
 *
 * Failing here is much cheaper than failing inside six containers: a missing
 * API key otherwise surfaces as every persona erroring at once, several
 * minutes and one image pull later.
 */
function resolveForwardedEnv(names: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of names) {
    const value = process.env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      continue;
    }
    env[name] = value;
  }

  if (missing.length > 0) {
    console.error(
      `Missing environment variable(s) named in agent.forwardEnv: ${missing.join(", ")}.`
    );
    console.error(`Export them in your shell, or drop them from the config.`);
    process.exit(1);
  }

  return env;
}

function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    console.error(`Config not found: ${path}`);
    process.exit(1);
  }

  const parsed = configSchema.safeParse(parseYaml(readFileSync(path, "utf-8")));

  if (!parsed.success) {
    console.error(`Invalid config at ${path}:`);
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }

  const config = parsed.data;

  if (!AGENTS[config.agent.provider]) {
    console.error(
      `Unknown agent provider "${config.agent.provider}". Wired up: ${Object.keys(AGENTS).join(", ")}.`
    );
    process.exit(1);
  }

  if (!SANDBOXES[config.sandbox.provider]) {
    console.error(
      `Unknown sandbox provider "${config.sandbox.provider}". Wired up: ${Object.keys(SANDBOXES).join(", ")}.`
    );
    process.exit(1);
  }

  return config;
}

// ─── Types ───────────────────────────────────────────────────────────────────

const reviewSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low"]),
      file: z.string(),
      // Agents emit null about as often as they omit the key.
      line: z.number().nullish(),
      message: z.string(),
      suggestion: z.string(),
    })
  ),
  verdict: z.enum(["pass", "contest", "reject"]),
});

interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

interface AgentResult {
  persona: string;
  status: "done" | "failed";
  findings: Finding[];
  verdict: "pass" | "contest" | "reject";
  /** Why this persona failed — surfaced in the report so a silent gap is impossible. */
  error?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
const SEVERITY_SCORE: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const OUTPUT_TAG = "review";

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  target: string;
  personas?: string[];
  configPath: string;
  repo?: string;
}

function parseArgs(skillRoot: string): CliArgs {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: bun orchestrator.ts <path-to-diff-or-code> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --personas a,b,c   Subset of the configured personas");
    console.error("  --config PATH      Override the config file");
    console.error("  --repo PATH        Repo to review in (default: git root of cwd)");
    process.exit(1);
  }

  const parsed: CliArgs = {
    target: args[0],
    configPath: join(skillRoot, "references", "config.yaml"),
  };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--personas" && args[i + 1]) {
      parsed.personas = args[i + 1].split(",").map((p) => p.trim().toLowerCase());
      i++;
    } else if (args[i] === "--config" && args[i + 1]) {
      parsed.configPath = resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--repo" && args[i + 1]) {
      parsed.repo = resolve(args[i + 1]);
      i++;
    }
  }

  return parsed;
}

/**
 * Sandcastle anchors its worktrees and git operations on a repo root, so the
 * review needs one even though the findings come from the prompt. Defaults to
 * the git root above the working directory — not the skill directory, which
 * is only a subdirectory when this skill is installed inside another repo.
 */
function resolveRepoRoot(explicit: string | undefined): string {
  if (explicit) {
    if (!existsSync(join(explicit, ".git"))) {
      console.error(`--repo ${explicit} is not a git repository (no .git).`);
      process.exit(1);
    }
    return explicit;
  }

  const found = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
  });

  if (found.exitCode !== 0) {
    console.error(
      `Not inside a git repository — each persona reviews in a worktree, so one is required.`
    );
    console.error(`Run from the repo you're reviewing, or pass --repo PATH.`);
    process.exit(1);
  }

  return found.stdout.toString().trim();
}

// ─── Prompt Assembly ─────────────────────────────────────────────────────────

/**
 * The target is embedded literally rather than passed through Sandcastle's
 * `promptArgs`/`promptFile` pipeline, so nothing inside the reviewed diff is
 * ever treated as a placeholder or a shell expression.
 */
function assemblePrompt(
  persona: string,
  referencesDir: string,
  targetContent: string
): string {
  const personaPromptPath = join(referencesDir, `${persona}.md`);

  if (!existsSync(personaPromptPath)) {
    throw new Error(`Persona prompt not found: ${personaPromptPath}`);
  }

  return `# Code Review Task — ${persona} Persona

${readFileSync(personaPromptPath, "utf-8")}

---

## Code to Review

\`\`\`
${targetContent}
\`\`\`

## Instructions

Review the code above through your ${persona} lens, then emit your findings as
JSON inside <${OUTPUT_TAG}> tags, in the exact shape given in your Output Format
section. Finding nothing is a valid result — emit \`"findings": []\` with
\`"verdict": "pass"\`.

This is a review. Report what you find; leave the code as you found it.
`;
}

// ─── Review Execution ────────────────────────────────────────────────────────

async function reviewWith(
  persona: { name: string; critical: boolean },
  config: Config,
  agentEnv: Record<string, string>,
  repoRoot: string,
  workDir: string,
  referencesDir: string,
  targetContent: string
): Promise<AgentResult> {
  const logPath = join(workDir, persona.name, "agent.log");
  mkdirSync(dirname(logPath), { recursive: true });

  try {
    const result = await sandcastle.run({
      agent: AGENTS[config.agent.provider](config.agent, agentEnv),
      sandbox: SANDBOXES[config.sandbox.provider](config.sandbox),
      cwd: repoRoot,
      name: persona.name,
      prompt: assemblePrompt(persona.name, referencesDir, targetContent),
      // Structured output requires a single iteration.
      maxIterations: 1,
      // Its own branch, so concurrent personas never share a working directory.
      branchStrategy: {
        type: "branch",
        branch: `${config.review.branchPrefix}${persona.name}`,
      },
      idleTimeoutSeconds: config.review.idleTimeoutSeconds,
      completionTimeoutSeconds: config.review.completionTimeoutSeconds,
      logging: { type: "file", path: logPath },
      output: sandcastle.Output.object({
        tag: OUTPUT_TAG,
        schema: reviewSchema,
        maxRetries: config.review.maxRetries,
      }),
    });

    const findings: Finding[] = result.output.findings.map((f) => ({
      severity: f.severity,
      file: f.file,
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      message: f.message,
      suggestion: f.suggestion,
    }));

    console.log(
      `  ✓ ${persona.name} — ${findings.length} findings, verdict: ${result.output.verdict}`
    );

    return {
      persona: persona.name,
      status: "done",
      findings,
      verdict: result.output.verdict,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ ${persona.name} — failed: ${message}`);

    return {
      persona: persona.name,
      status: "failed",
      findings: [],
      verdict: "contest",
      error: message,
    };
  }
}

/** Run personas in batches so N containers are alive at once, not all of them. */
async function runReviews(
  personas: Array<{ name: string; critical: boolean }>,
  config: Config,
  agentEnv: Record<string, string>,
  repoRoot: string,
  workDir: string,
  referencesDir: string,
  targetContent: string
): Promise<Map<string, AgentResult>> {
  const results = new Map<string, AgentResult>();
  const { maxConcurrent } = config.review;

  for (let i = 0; i < personas.length; i += maxConcurrent) {
    const batch = personas.slice(i, i + maxConcurrent);
    console.log(`\n  Reviewing: ${batch.map((p) => p.name).join(", ")}`);

    const batchResults = await Promise.all(
      batch.map((persona) =>
        reviewWith(
          persona,
          config,
          agentEnv,
          repoRoot,
          workDir,
          referencesDir,
          targetContent
        )
      )
    );

    for (const result of batchResults) {
      results.set(result.persona, result);
    }
  }

  return results;
}

// ─── Report Generation ───────────────────────────────────────────────────────

function deduplicateFindings(allFindings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return allFindings.filter((f) => {
    // Delimiter unlikely to appear in file paths or messages.
    const key = [f.file, String(f.line ?? ""), f.message].join("\x00");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => {
    const scoreA = SEVERITY_SCORE[a.severity] ?? 0;
    const scoreB = SEVERITY_SCORE[b.severity] ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.file.localeCompare(b.file);
  });
}

function computeVerdict(
  results: Map<string, AgentResult>,
  criticalPersonas: Set<string>
): {
  overall: "PASS" | "CONTESTED" | "REJECT" | "INCOMPLETE";
  breakdown: Record<string, number>;
} {
  const breakdown: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const [, result] of results) {
    for (const f of result.findings) {
      breakdown[f.severity] = (breakdown[f.severity] || 0) + 1;
    }
  }

  // A review missing one of its load-bearing angles cannot be reported as clean.
  const criticalFailed = [...results.entries()].some(
    ([persona, r]) => criticalPersonas.has(persona) && r.status !== "done"
  );

  if (criticalFailed) return { overall: "INCOMPLETE", breakdown };
  if (breakdown.critical > 0) return { overall: "REJECT", breakdown };
  if (breakdown.high > 0) return { overall: "CONTESTED", breakdown };
  return { overall: "PASS", breakdown };
}

function generateReport(
  results: Map<string, AgentResult>,
  criticalPersonas: Set<string>,
  target: string
): { markdown: string; verdict: any } {
  const allFindings: Finding[] = [];
  for (const [, result] of results) {
    allFindings.push(...result.findings);
  }

  const sortedFindings = sortFindings(deduplicateFindings(allFindings));
  const { overall, breakdown } = computeVerdict(results, criticalPersonas);

  const parts: string[] = [];
  parts.push(`# Code Review Report\n\n`);
  parts.push(`**Target**: \`${target}\`\n`);
  parts.push(`**Date**: ${new Date().toISOString().split("T")[0]}\n`);
  parts.push(`**Verdict**: **${overall}**\n\n`);

  parts.push(`## Summary\n\n`);
  parts.push(`| Severity | Count |\n`);
  parts.push(`|----------|-------|\n`);
  for (const sev of SEVERITY_ORDER) {
    parts.push(`| ${sev} | ${breakdown[sev]} |\n`);
  }
  parts.push(`| **Total** | **${sortedFindings.length}** |\n\n`);

  parts.push(`## Agent Status\n\n`);
  parts.push(`| Persona | Critical | Status | Findings | Verdict |\n`);
  parts.push(`|---------|----------|--------|----------|---------|\n`);
  for (const [persona, result] of results) {
    const critical = criticalPersonas.has(persona) ? "yes" : "no";
    parts.push(
      `| ${persona} | ${critical} | ${result.status} | ${result.findings.length} | ${result.verdict} |\n`
    );
  }
  parts.push(`\n`);

  const failed = [...results.values()].filter((r) => r.status !== "done");
  if (failed.length > 0) {
    parts.push(`## Personas That Did Not Report\n\n`);
    for (const r of failed) {
      parts.push(`- **${r.persona}**: ${r.error ?? "unknown error"}\n`);
    }
    parts.push(
      `\nTheir angles are absent from the findings below — this report is a partial view.\n\n`
    );
  }

  if (sortedFindings.length > 0) {
    parts.push(`## Findings\n\n`);
    for (const f of sortedFindings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      parts.push(`### [${f.severity.toUpperCase()}] ${f.message}\n\n`);
      parts.push(`- **File**: \`${loc}\`\n`);
      parts.push(`- **Suggestion**: ${f.suggestion}\n\n`);
    }
  } else {
    parts.push(`## Findings\n\nNo findings to report.\n\n`);
  }

  const verdict = {
    overall,
    breakdown,
    agents: Object.fromEntries(
      [...results].map(([p, r]) => [
        p,
        {
          status: r.status,
          critical: criticalPersonas.has(p),
          findings: r.findings.length,
          verdict: r.verdict,
          ...(r.error ? { error: r.error } : {}),
        },
      ])
    ),
    target,
    timestamp: new Date().toISOString(),
  };

  return { markdown: parts.join(""), verdict };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const skillRoot = dirname(import.meta.dir);
  const args = parseArgs(skillRoot);
  const config = loadConfig(args.configPath);

  let personas = config.personas;
  if (args.personas) {
    const requested = new Set(args.personas);
    const known = new Set(config.personas.map((p) => p.name));

    const unknown = [...requested].filter((p) => !known.has(p));
    if (unknown.length > 0) {
      console.error(
        `Unknown persona(s): ${unknown.join(", ")}. Configured: ${[...known].join(", ")}.`
      );
      process.exit(1);
    }

    personas = config.personas.filter((p) => requested.has(p.name));
  }

  const criticalPersonas = new Set(
    personas.filter((p) => p.critical).map((p) => p.name)
  );

  const agentEnv = resolveForwardedEnv(config.agent.forwardEnv);
  const repoRoot = resolveRepoRoot(args.repo);

  const targetPath = resolve(args.target);
  const targetContent = existsSync(targetPath)
    ? readFileSync(targetPath, "utf-8")
    : args.target;

  const workDir = join(skillRoot, ".eval-reviewer");
  const referencesDir = join(skillRoot, "references");
  mkdirSync(workDir, { recursive: true });

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║       Eval Reviewer — Orchestrator       ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log(`  Target:   ${args.target}`);
  console.log(`  Agent:    ${config.agent.provider} (${config.agent.model})`);
  console.log(`  Sandbox:  ${config.sandbox.provider}`);
  console.log(`  Personas: ${personas.map((p) => p.name).join(", ")}`);
  console.log(`  Repo:     ${repoRoot}`);
  console.log(`  Workspace: ${workDir}`);
  if (config.agent.forwardEnv.length > 0) {
    console.log(`  Env:      ${config.agent.forwardEnv.join(", ")}`);
  }

  const results = await runReviews(
    personas,
    config,
    agentEnv,
    repoRoot,
    workDir,
    referencesDir,
    targetContent
  );

  const { markdown, verdict } = generateReport(
    results,
    criticalPersonas,
    args.target
  );

  const reportPath = join(workDir, "report.md");
  const verdictPath = join(workDir, "verdict.json");

  writeFileSync(reportPath, markdown);
  writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));

  console.log(`\n  Report:  ${reportPath}`);
  console.log(`  Verdict: ${verdictPath}`);
  console.log(`\n  ═══════ VERDICT: ${verdict.overall} ═══════\n`);

  const exitCodes: Record<string, number> = {
    PASS: 0,
    CONTESTED: 1,
    REJECT: 2,
    INCOMPLETE: 3,
  };
  process.exit(exitCodes[verdict.overall] ?? 0);
}

main().catch((err) => {
  console.error("Orchestrator failed:", err);
  process.exit(1);
});
