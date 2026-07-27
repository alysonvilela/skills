#!/usr/bin/env node
/**
 * Eval Reviewer — runs each persona as an independent sandboxed agent, then
 * merges their findings into one report.
 *
 * Sandcastle owns process lifecycle, isolation, timeouts, and structured
 * output. This file owns configuration, prompt assembly, and the merge — the
 * merge is deliberately plain code so the same findings always produce the
 * same verdict.
 *
 * Single file on purpose: it gets symlinked into a target repo as
 * `.sandcastle/eval-reviewer.ts`, and a symlink with no sibling imports runs
 * under bun, node (>=22.18, native type stripping), and `npx tsx` alike.
 *
 * Configuration is environment variables and flags — there is no config file.
 * Run with --help for the full list.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Type-only, so it is erased at runtime and never needed at install time.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// ─── Personas ────────────────────────────────────────────────────────────────
// `name` must match a prompt file: <skill>/references/<name>.md.
//
// `critical: true` means the review is not trustworthy without this persona —
// if one of them fails, the verdict is INCOMPLETE no matter what the others
// found. A clean PASS that silently skipped the security review is a lie.

const PERSONAS = [
  { name: "skeptic", critical: true },
  { name: "architect", critical: true },
  { name: "security", critical: true },
  { name: "minimalist", critical: false },
  { name: "performance", critical: false },
  { name: "test-coverage", critical: false },
] as const;

// ─── Agents ──────────────────────────────────────────────────────────────────
// Every agent Sandcastle ships is wired up. `credentials` is ordered by
// preference and is what the run is checked against before any container
// starts; the ones that are set get forwarded into the sandbox explicitly,
// because Sandcastle's own resolver only forwards names that already appear in
// `.sandcastle/.env` — a file that does not exist in CI.

type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface AgentSpec {
  /** Binary the agent runs as — checked on PATH when --sandbox none. */
  readonly cli: string;
  /** What to `npm i -g` when that binary is missing. */
  readonly npmPackage: string;
  readonly defaultModel: string;
  /** Env var names holding this agent's credential, best first. */
  readonly credentials: readonly string[];
  /** Can this provider resume a session? Structured-output retries need it. */
  readonly canResume: boolean;
  readonly build: (opts: {
    model: string;
    effort: Effort | undefined;
    env: Record<string, string>;
    bypassPermissions: boolean;
  }) => sandcastle.AgentProvider;
}

const AGENTS: Record<string, AgentSpec> = {
  "claude-code": {
    cli: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    defaultModel: "claude-sonnet-4-6",
    credentials: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    canResume: true,
    build: ({ model, effort, env, bypassPermissions }) =>
      sandcastle.claudeCode(model, {
        env,
        ...(effort && effort !== "off" && effort !== "minimal"
          ? { effort: effort as "low" | "medium" | "high" | "xhigh" }
          : {}),
        // Sandcastle passes --dangerously-skip-permissions only inside a
        // container. Without one the flag is withheld, which leaves a -p run
        // silently unable to grep or read — so it has to be asked for.
        ...(bypassPermissions
          ? { permissionMode: "bypassPermissions" as const }
          : {}),
      }),
  },
  pi: {
    cli: "pi",
    npmPackage: "@mariozechner/pi-coding-agent",
    defaultModel: "claude-sonnet-4-6",
    credentials: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    canResume: true,
    build: ({ model, effort, env }) =>
      sandcastle.pi(model, { env, ...(effort ? { thinking: effort } : {}) }),
  },
  codex: {
    cli: "codex",
    npmPackage: "@openai/codex",
    defaultModel: "gpt-5.4",
    credentials: ["OPENAI_KEY", "OPENAI_API_KEY"],
    canResume: true,
    build: ({ model, effort, env }) =>
      sandcastle.codex(model, {
        env,
        ...(effort && effort !== "off" && effort !== "minimal"
          ? { effort: effort as "low" | "medium" | "high" | "xhigh" }
          : {}),
      }),
  },
  cursor: {
    cli: "cursor-agent",
    npmPackage: "cursor-agent",
    defaultModel: "composer-2",
    credentials: ["CURSOR_API_KEY"],
    canResume: false,
    build: ({ model, env }) => sandcastle.cursor(model, { env }),
  },
  opencode: {
    cli: "opencode",
    npmPackage: "opencode-ai",
    defaultModel: "opencode/big-pickle",
    credentials: ["OPENCODE_API_KEY"],
    canResume: false,
    build: ({ model, env }) => sandcastle.opencode(model, { env }),
  },
  copilot: {
    cli: "copilot",
    npmPackage: "@github/copilot",
    defaultModel: "claude-sonnet-4.5",
    credentials: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    canResume: false,
    build: ({ model, env }) => sandcastle.copilot(model, { env }),
  },
};

interface Mount {
  hostPath: string;
  sandboxPath: string;
  readonly: boolean;
}

const SANDBOXES: Record<
  string,
  (image: string, mounts: Mount[]) => sandcastle.SandboxProvider
> = {
  docker: (image, mounts) => docker({ imageName: image, mounts }),
  podman: (image, mounts) => podman({ imageName: image, mounts }),
  none: () => noSandbox(),
};

// ─── Review payload ──────────────────────────────────────────────────────────
// A hand-rolled Standard Schema validator. Sandcastle only needs the
// `~standard.validate` contract, and this keeps the dependency list at exactly
// one package — the whole skill installs in a couple of seconds.

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const VERDICTS = ["pass", "contest", "reject"] as const;

type Severity = (typeof SEVERITIES)[number];
type PersonaVerdict = (typeof VERDICTS)[number];

interface Finding {
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

interface ReviewPayload {
  findings: Finding[];
  verdict: PersonaVerdict;
}

interface SchemaIssue {
  message: string;
  path: (string | number)[];
}

/** Validate one finding, collecting every problem so one retry can fix them all. */
function validateFinding(
  raw: unknown,
  index: number,
  issues: SchemaIssue[]
): Finding | undefined {
  if (typeof raw !== "object" || raw === null) {
    issues.push({ message: "must be an object", path: ["findings", index] });
    return undefined;
  }

  const finding = raw as Record<string, unknown>;
  const before = issues.length;

  if (!SEVERITIES.includes(finding.severity as Severity)) {
    issues.push({
      message: `must be one of ${SEVERITIES.join(", ")}`,
      path: ["findings", index, "severity"],
    });
  }

  for (const key of ["file", "message", "suggestion"]) {
    if (typeof finding[key] !== "string" || finding[key] === "") {
      issues.push({
        message: "must be a non-empty string",
        path: ["findings", index, key],
      });
    }
  }

  // Agents emit null about as often as they omit the key.
  const hasLine = finding.line !== undefined && finding.line !== null;
  if (
    hasLine &&
    (typeof finding.line !== "number" || !Number.isFinite(finding.line))
  ) {
    issues.push({
      message: "must be a number, null, or omitted",
      path: ["findings", index, "line"],
    });
  }

  if (issues.length > before) return undefined;

  return {
    severity: finding.severity as Severity,
    file: finding.file as string,
    ...(hasLine ? { line: finding.line as number } : {}),
    message: finding.message as string,
    suggestion: finding.suggestion as string,
  };
}

const reviewSchema: StandardSchemaV1<unknown, ReviewPayload> = {
  "~standard": {
    version: 1,
    vendor: "eval-reviewer",
    validate: (
      value: unknown
    ): { value: ReviewPayload } | { issues: SchemaIssue[] } => {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "must be an object", path: [] }] };
      }

      const root = value as Record<string, unknown>;
      const issues: SchemaIssue[] = [];

      if (!VERDICTS.includes(root.verdict as PersonaVerdict)) {
        issues.push({
          message: `must be one of ${VERDICTS.join(", ")}`,
          path: ["verdict"],
        });
      }

      if (!Array.isArray(root.findings)) {
        issues.push({ message: "must be an array", path: ["findings"] });
        return { issues };
      }

      const findings: Finding[] = [];
      root.findings.forEach((raw, index) => {
        const finding = validateFinding(raw, index, issues);
        if (finding) findings.push(finding);
      });

      if (issues.length > 0) return { issues };

      return { value: { findings, verdict: root.verdict as PersonaVerdict } };
    },
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

const OUTPUT_TAG = "review";
const SEVERITY_SCORE: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Past this, models start truncating the target — say so rather than pretend. */
const TARGET_WARN_BYTES = 400_000;

const USAGE = `eval-reviewer — six personas review the same target independently

Usage:
  eval-reviewer.ts <file-or-text>        review a diff file, a code file, or literal text
  eval-reviewer.ts --diff <base-ref>     review \`git diff <base-ref>...HEAD\` (EVAL_DIFF)

Options (each has an env var; the flag wins):
  --personas a,b,c   EVAL_PERSONAS     subset of ${PERSONAS.map((p) => p.name).join(", ")}
  --agent NAME       EVAL_AGENT        ${Object.keys(AGENTS).join(", ")} (default: first with a credential set)
  --model NAME       EVAL_MODEL        default: the agent's own default
  --effort LEVEL     EVAL_EFFORT       off|minimal|low|medium|high|xhigh (default: medium)
  --sandbox NAME     EVAL_SANDBOX      docker|podman|none (default: docker, none under CI)
  --image NAME       EVAL_IMAGE        default: sandcastle:eval-reviewer-<agent>
  --concurrency N    EVAL_CONCURRENCY  personas alive at once (default: 3)
  --timeout N        EVAL_IDLE_TIMEOUT seconds without agent output before stuck (default: 600)
  --retries N        EVAL_RETRIES      re-asks when output fails validation (default: 2)
  --mounts LIST      EVAL_MOUNTS       host:sandbox[:ro] pairs, comma-separated
  --repo PATH        EVAL_REPO         repo to review in (default: git root of cwd)
  --out PATH         EVAL_OUT          report directory (default: <repo>/.eval-reviewer)
  --fail-on LEVEL    EVAL_FAIL_ON      critical|high|medium|low|never (default: high)
  --help

Credentials come from your shell, then from <repo>/.sandcastle/.env. Nothing is written.
Exit codes: 0 clean · 1 findings at/above --fail-on · 2 critical findings · 3 incomplete run`;

interface Config {
  target: string;
  targetLabel: string;
  personas: Array<{ name: string; critical: boolean }>;
  agentName: string;
  agent: AgentSpec;
  model: string;
  effort: Effort | undefined;
  sandboxName: string;
  image: string;
  mounts: Mount[];
  concurrency: number;
  idleTimeout: number;
  retries: number;
  repoRoot: string;
  outDir: string;
  failOn: Severity | "never";
  skillRoot: string;
}

function fail(message: string, ...detail: string[]): never {
  console.error(`eval-reviewer: ${message}`);
  for (const line of detail) {
    if (line) console.error(`  ${line}`);
  }
  process.exit(1);
}

function onPath(binary: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [binary], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function imageExists(runtime: string, image: string): boolean {
  try {
    execFileSync(runtime, ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Credentials the repo keeps in `.sandcastle/.env` — the file Sandcastle's own
 * docs tell you to put them in. Populated once the repo root is known.
 */
let dotEnv: Record<string, string> = {};

/** Minimal KEY=VALUE reader. Missing file, blank lines, and comments are fine. */
function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0];
    vars[key] = quoted ? value.slice(1, -1) : value;
  }
  return vars;
}

/** The shell wins over the file, so a one-off export overrides the checked-in default. */
function credential(key: string): string | undefined {
  return process.env[key] || dotEnv[key] || undefined;
}

/**
 * `host:sandbox` or `host:sandbox:ro`, comma-separated. What this is for: an
 * agent that reaches a custom OpenAI-compatible endpoint reads its provider
 * definition from a file on the host (pi's `~/.pi/agent/models.json`), and the
 * sandboxed copy has to see the same file.
 */
function parseMounts(raw: string | undefined): Mount[] {
  if (!raw) return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":").map((part) => part.trim());
      if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === "")) {
        fail(
          `bad mount "${entry}".`,
          "Expected host:sandbox or host:sandbox:ro, comma-separated."
        );
      }
      const [hostPath, sandboxPath, mode] = parts;
      if (mode !== undefined && mode !== "ro" && mode !== "rw") {
        fail(`bad mount mode "${mode}" in "${entry}" — use ro or rw.`);
      }
      return { hostPath, sandboxPath, readonly: mode === "ro" };
    });
}

/** Pick the first agent whose credential is already available. */
function detectAgent(): string | undefined {
  for (const [name, spec] of Object.entries(AGENTS)) {
    if (spec.credentials.some((key) => credential(key))) return name;
  }
  return undefined;
}

function parseConfig(argv: string[], skillRoot: string): Config {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    if (separator !== -1) {
      flags[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      fail(`--${key} needs a value.`, "Run --help for the full list.");
    }
    flags[key] = next;
    i++;
  }

  const pick = (flag: string, envVar: string, fallback?: string) =>
    flags[flag] ?? process.env[envVar] ?? fallback;

  const repoRoot = (() => {
    const explicit = pick("repo", "EVAL_REPO");
    if (explicit) {
      const abs = resolve(explicit);
      if (!existsSync(join(abs, ".git"))) {
        fail(`--repo ${explicit} is not a git repository (no .git).`);
      }
      return abs;
    }
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        encoding: "utf-8",
      }).trim();
    } catch {
      return fail(
        "not inside a git repository — each persona reviews in a worktree, so one is required.",
        "Run from the repo you're reviewing, or pass --repo PATH."
      );
    }
  })();

  dotEnv = parseDotEnv(join(repoRoot, ".sandcastle", ".env"));

  // The target is a file, literal text, or a diff this script computes itself.
  const diffBase = pick("diff", "EVAL_DIFF");
  let target: string;
  let targetLabel: string;

  if (diffBase) {
    targetLabel = `git diff ${diffBase}...HEAD`;
    try {
      target = execFileSync("git", ["diff", `${diffBase}...HEAD`], {
        cwd: repoRoot,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      return fail(
        `${targetLabel} failed in ${repoRoot}.`,
        error instanceof Error ? error.message : String(error),
        "In CI, fetch the base ref first — actions/checkout with fetch-depth: 0."
      );
    }
    if (target.trim() === "") fail(`${targetLabel} is empty — nothing to review.`);
  } else if (positional.length > 0) {
    const path = resolve(positional[0]);
    const isFile = existsSync(path);
    target = isFile ? readFileSync(path, "utf-8") : positional.join(" ");
    targetLabel = isFile ? positional[0] : "inline text";
  } else {
    console.error(USAGE);
    return process.exit(1);
  }

  const targetBytes = Buffer.byteLength(target);
  if (targetBytes > TARGET_WARN_BYTES) {
    console.warn(
      `eval-reviewer: target is ${Math.round(targetBytes / 1024)}KB — large enough ` +
        `that agents may truncate it. Consider reviewing fewer files at once.`
    );
  }

  const agentName =
    pick("agent", "EVAL_AGENT") ??
    detectAgent() ??
    fail(
      "no agent credential found in the environment.",
      ...Object.entries(AGENTS).map(
        ([name, spec]) => `${name}: ${spec.credentials.join(" or ")}`
      ),
      "Export one, or pick an agent explicitly with --agent."
    );

  const agent = AGENTS[agentName];
  if (!agent) {
    fail(
      `unknown agent "${agentName}".`,
      `Available: ${Object.keys(AGENTS).join(", ")}.`
    );
  }

  const sandboxName = pick(
    "sandbox",
    "EVAL_SANDBOX",
    // A CI runner is already a disposable VM; a container inside it buys
    // nothing and costs an image build on every run.
    process.env.CI ? "none" : "docker"
  ) as string;
  if (!SANDBOXES[sandboxName]) {
    fail(
      `unknown sandbox "${sandboxName}".`,
      `Available: ${Object.keys(SANDBOXES).join(", ")}.`
    );
  }

  const requestedPersonas = pick("personas", "EVAL_PERSONAS");
  const personas = (() => {
    const all = PERSONAS.map((p) => ({ name: p.name, critical: p.critical }));
    if (!requestedPersonas) return all;
    const names = requestedPersonas
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const unknown = names.filter((name) => !all.some((p) => p.name === name));
    if (unknown.length > 0) {
      fail(
        `unknown persona(s): ${unknown.join(", ")}.`,
        `Available: ${all.map((p) => p.name).join(", ")}.`
      );
    }
    return all.filter((p) => names.includes(p.name));
  })();

  const number = (flag: string, envVar: string, fallback: number): number => {
    const raw = pick(flag, envVar);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      fail(`--${flag} must be a non-negative integer, got "${raw}".`);
    }
    return parsed;
  };

  const efforts: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const effort = pick("effort", "EVAL_EFFORT", "medium") as Effort;
  if (!efforts.includes(effort)) {
    fail(`--effort must be one of ${efforts.join(", ")}, got "${effort}".`);
  }

  const failOn = pick("fail-on", "EVAL_FAIL_ON", "high") as Severity | "never";
  if (failOn !== "never" && !SEVERITIES.includes(failOn as Severity)) {
    fail(
      `--fail-on must be one of ${SEVERITIES.join(", ")}, never — got "${failOn}".`
    );
  }

  const retries = number("retries", "EVAL_RETRIES", 2);
  if (retries > 0 && !agent.canResume) {
    console.warn(
      `eval-reviewer: ${agentName} cannot resume a session, so validation retries are off.`
    );
  }

  return {
    target,
    targetLabel,
    personas,
    agentName,
    agent,
    model: pick("model", "EVAL_MODEL", agent.defaultModel) as string,
    effort: effort === "off" ? undefined : effort,
    sandboxName,
    image: pick(
      "image",
      "EVAL_IMAGE",
      `sandcastle:eval-reviewer-${agentName}`
    ) as string,
    mounts: parseMounts(pick("mounts", "EVAL_MOUNTS")),
    concurrency: Math.max(1, number("concurrency", "EVAL_CONCURRENCY", 3)),
    idleTimeout: Math.max(1, number("timeout", "EVAL_IDLE_TIMEOUT", 600)),
    retries: agent.canResume ? retries : 0,
    repoRoot,
    outDir: resolve(
      pick("out", "EVAL_OUT", join(repoRoot, ".eval-reviewer")) as string
    ),
    failOn,
    skillRoot,
  };
}

/**
 * Everything knowably broken before a container starts, checked before one
 * does. A missing key otherwise surfaces as six agents erroring at once,
 * several minutes and one image pull later.
 */
function preflight(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of config.agent.credentials) {
    const value = credential(key);
    if (value) env[key] = value;
  }

  if (Object.keys(env).length === 0) {
    fail(
      `no credential for ${config.agentName}.`,
      `Export one of: ${config.agent.credentials.join(", ")}`,
      `— or put it in ${join(config.repoRoot, ".sandcastle", ".env")}.`,
      config.agentName === "claude-code"
        ? "Run `claude setup-token` for a CLAUDE_CODE_OAUTH_TOKEN."
        : ""
    );
  }

  if (config.sandboxName === "none") {
    if (config.mounts.length > 0) {
      console.warn(
        `eval-reviewer: --mounts has no meaning with --sandbox none (the agent already sees this filesystem).`
      );
    }
    if (!onPath(config.agent.cli)) {
      fail(
        `--sandbox none runs the agent on this host, but "${config.agent.cli}" is not on PATH.`,
        `Install it with: npm i -g ${config.agent.npmPackage}`
      );
    }
  } else {
    if (!onPath(config.sandboxName)) {
      fail(`${config.sandboxName} is not on PATH.`);
    }
    if (!imageExists(config.sandboxName, config.image)) {
      fail(
        `sandbox image "${config.image}" does not exist.`,
        `Build it once with: node ${join(config.skillRoot, "scripts", "setup.mjs")} --build`,
        `Or skip the container and run on this host with: --sandbox none`
      );
    }
  }

  for (const persona of config.personas) {
    const prompt = join(config.skillRoot, "references", `${persona.name}.md`);
    if (!existsSync(prompt)) fail(`persona prompt not found: ${prompt}`);
  }

  return env;
}

// ─── Prompt assembly ─────────────────────────────────────────────────────────

/**
 * The target is embedded literally rather than passed through Sandcastle's
 * `promptArgs`/`promptFile` pipeline, so nothing inside the reviewed diff is
 * ever treated as a placeholder or a shell expression.
 */
function assemblePrompt(persona: string, config: Config): string {
  const personaPrompt = readFileSync(
    join(config.skillRoot, "references", `${persona}.md`),
    "utf-8"
  );

  return `# Code Review Task — ${persona} Persona

${personaPrompt}

---

## Code to Review

\`\`\`
${config.target}
\`\`\`

## Instructions

Review the code above through your ${persona} lens, then emit your findings as
JSON inside <${OUTPUT_TAG}> tags, in the exact shape given in your Output Format
section. Finding nothing is a valid result — emit \`"findings": []\` with
\`"verdict": "pass"\`.

This is a review. Report what you find; leave the code as you found it.
`;
}

// ─── Review execution ────────────────────────────────────────────────────────

interface AgentResult {
  persona: string;
  status: "done" | "failed";
  findings: Finding[];
  verdict: PersonaVerdict;
  /** Why this persona failed — surfaced in the report so a silent gap is impossible. */
  error?: string;
}

async function reviewWith(
  persona: { name: string; critical: boolean },
  config: Config,
  agentEnv: Record<string, string>
): Promise<AgentResult> {
  const logPath = join(config.outDir, persona.name, "agent.log");
  mkdirSync(dirname(logPath), { recursive: true });

  try {
    const result = await sandcastle.run({
      agent: config.agent.build({
        model: config.model,
        effort: config.effort,
        env: agentEnv,
        // Outside a container Sandcastle withholds the bypass flag. On an
        // ephemeral CI runner that only costs the review its tools; on a
        // developer's own machine the permission gate is worth keeping.
        bypassPermissions:
          config.sandboxName === "none" && Boolean(process.env.CI),
      }),
      sandbox: SANDBOXES[config.sandboxName](config.image, config.mounts),
      cwd: config.repoRoot,
      name: persona.name,
      prompt: assemblePrompt(persona.name, config),
      // Structured output requires a single iteration.
      maxIterations: 1,
      // Its own branch, so concurrent personas never share a working directory.
      branchStrategy: { type: "branch", branch: `eval-review/${persona.name}` },
      idleTimeoutSeconds: config.idleTimeout,
      logging: { type: "file", path: logPath },
      output: sandcastle.Output.object({
        tag: OUTPUT_TAG,
        schema: reviewSchema,
        maxRetries: config.retries,
      }),
    });

    console.log(
      `  ✓ ${persona.name} — ${result.output.findings.length} findings, verdict: ${result.output.verdict}`
    );

    return {
      persona: persona.name,
      status: "done",
      findings: result.output.findings,
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

/** Run personas in batches so N agents are alive at once, not all of them. */
async function runReviews(
  config: Config,
  agentEnv: Record<string, string>
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];

  for (let i = 0; i < config.personas.length; i += config.concurrency) {
    const batch = config.personas.slice(i, i + config.concurrency);
    console.log(`\n  Reviewing: ${batch.map((p) => p.name).join(", ")}`);
    results.push(
      ...(await Promise.all(
        batch.map((persona) => reviewWith(persona, config, agentEnv))
      ))
    );
  }

  return results;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

function mergeFindings(results: AgentResult[]): Finding[] {
  const seen = new Set<string>();
  const merged: Finding[] = [];

  for (const result of results) {
    for (const finding of result.findings) {
      // Delimiter unlikely to appear in file paths or messages.
      const key = [finding.file, finding.line ?? "", finding.message].join(
        "\x00"
      );
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(finding);
    }
  }

  return merged.sort((a, b) => {
    const bySeverity = SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity];
    return bySeverity !== 0 ? bySeverity : a.file.localeCompare(b.file);
  });
}

type Overall = "PASS" | "CONTESTED" | "REJECT" | "INCOMPLETE";

interface Verdict {
  overall: Overall;
  breakdown: Record<Severity, number>;
  agents: Record<
    string,
    {
      status: string;
      critical: boolean;
      findings: number;
      verdict: PersonaVerdict;
      error?: string;
    }
  >;
  target: string;
  agent: string;
  model: string;
  sandbox: string;
  timestamp: string;
}

function buildVerdict(
  results: AgentResult[],
  findings: Finding[],
  config: Config
): Verdict {
  const breakdown: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) breakdown[finding.severity]++;

  const criticalPersonas = new Set(
    config.personas.filter((p) => p.critical).map((p) => p.name)
  );

  // A review missing one of its load-bearing angles cannot be reported at all.
  const criticalFailed = results.some(
    (result) => criticalPersonas.has(result.persona) && result.status !== "done"
  );
  // And "nothing found" from a run where a persona crashed is not a clean
  // result, it is an unknown one — findings still stand on their own, but the
  // absence of findings does not.
  const anyFailed = results.some((result) => result.status !== "done");

  const overall: Overall = criticalFailed
    ? "INCOMPLETE"
    : breakdown.critical > 0
      ? "REJECT"
      : breakdown.high > 0
        ? "CONTESTED"
        : anyFailed
          ? "INCOMPLETE"
          : "PASS";

  return {
    overall,
    breakdown,
    agents: Object.fromEntries(
      results.map((result) => [
        result.persona,
        {
          status: result.status,
          critical: criticalPersonas.has(result.persona),
          findings: result.findings.length,
          verdict: result.verdict,
          ...(result.error ? { error: result.error } : {}),
        },
      ])
    ),
    target: config.targetLabel,
    agent: config.agentName,
    model: config.model,
    sandbox: config.sandboxName,
    timestamp: new Date().toISOString(),
  };
}

function renderReport(
  results: AgentResult[],
  findings: Finding[],
  verdict: Verdict
): string {
  const out: string[] = [];

  out.push(`# Code Review Report\n`);
  out.push(`**Target**: \`${verdict.target}\`  `);
  out.push(
    `**Reviewed by**: ${verdict.agent} (${verdict.model}) in sandbox \`${verdict.sandbox}\`  `
  );
  out.push(`**Date**: ${verdict.timestamp.split("T")[0]}  `);
  out.push(`**Verdict**: **${verdict.overall}**\n`);

  out.push(`## Summary\n`);
  out.push(`| Severity | Count |`);
  out.push(`|----------|-------|`);
  for (const severity of SEVERITIES) {
    out.push(`| ${severity} | ${verdict.breakdown[severity]} |`);
  }
  out.push(`| **Total** | **${findings.length}** |\n`);

  out.push(`## Agent Status\n`);
  out.push(`| Persona | Critical | Status | Findings | Verdict |`);
  out.push(`|---------|----------|--------|----------|---------|`);
  for (const result of results) {
    const entry = verdict.agents[result.persona];
    out.push(
      `| ${result.persona} | ${entry.critical ? "yes" : "no"} | ${result.status} | ${result.findings.length} | ${result.verdict} |`
    );
  }
  out.push("");

  const failed = results.filter((result) => result.status !== "done");
  if (failed.length > 0) {
    out.push(`## Personas That Did Not Report\n`);
    for (const result of failed) {
      out.push(`- **${result.persona}**: ${result.error ?? "unknown error"}`);
    }
    out.push(
      `\nTheir angles are absent from the findings below — this report is a partial view.\n`
    );
  }

  out.push(`## Findings\n`);
  if (findings.length === 0) {
    out.push(`No findings to report.\n`);
  } else {
    for (const finding of findings) {
      const location = finding.line
        ? `${finding.file}:${finding.line}`
        : finding.file;
      out.push(`### [${finding.severity.toUpperCase()}] ${finding.message}\n`);
      out.push(`- **File**: \`${location}\``);
      out.push(`- **Suggestion**: ${finding.suggestion}\n`);
    }
  }

  return out.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // realpath: this file is normally reached through a symlink in the target
  // repo's .sandcastle/, and references/ lives next to the real file.
  const skillRoot = dirname(
    dirname(realpathSync(fileURLToPath(import.meta.url)))
  );

  const config = parseConfig(process.argv.slice(2), skillRoot);
  const agentEnv = preflight(config);

  mkdirSync(config.outDir, { recursive: true });
  // Self-ignoring output directory — nothing to add to the repo's .gitignore.
  writeFileSync(join(config.outDir, ".gitignore"), "*\n");

  console.log(`\n  eval-reviewer`);
  console.log(`  Target:      ${config.targetLabel}`);
  console.log(`  Agent:       ${config.agentName} (${config.model})`);
  console.log(
    `  Sandbox:     ${config.sandboxName}${config.sandboxName === "none" ? " (this host)" : ` (${config.image})`}`
  );
  console.log(`  Personas:    ${config.personas.map((p) => p.name).join(", ")}`);
  console.log(`  Repo:        ${config.repoRoot}`);
  console.log(`  Report:      ${config.outDir}`);
  console.log(`  Credentials: ${Object.keys(agentEnv).join(", ")}`);

  const results = await runReviews(config, agentEnv);
  const findings = mergeFindings(results);
  const verdict = buildVerdict(results, findings, config);
  const report = renderReport(results, findings, verdict);

  writeFileSync(join(config.outDir, "report.md"), report);
  writeFileSync(
    join(config.outDir, "verdict.json"),
    `${JSON.stringify(verdict, null, 2)}\n`
  );

  // In GitHub Actions the report belongs on the run page, not only in an artifact.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    } catch (error) {
      console.warn(
        `eval-reviewer: could not write the job summary: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log(`\n  Report:  ${join(config.outDir, "report.md")}`);
  console.log(`  Verdict: ${join(config.outDir, "verdict.json")}`);
  console.log(`\n  ═══════ VERDICT: ${verdict.overall} ═══════\n`);

  // An incomplete run is always a failure — it is not a clean result, it is an
  // unknown one. Otherwise the gate is whatever --fail-on asked for.
  if (verdict.overall === "INCOMPLETE") process.exit(3);
  if (config.failOn === "never") process.exit(0);

  const threshold = SEVERITY_SCORE[config.failOn];
  const worst = findings.reduce(
    (max, finding) => Math.max(max, SEVERITY_SCORE[finding.severity]),
    0
  );
  if (worst < threshold) process.exit(0);
  process.exit(worst === SEVERITY_SCORE.critical ? 2 : 1);
}

main().catch((error) => {
  console.error("eval-reviewer: orchestrator failed:", error);
  process.exit(1);
});
