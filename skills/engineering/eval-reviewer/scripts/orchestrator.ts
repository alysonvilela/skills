/**
 * eval-reviewer — every persona reviews the same target independently, then a
 * deterministic merge compiles one report.
 *
 * Everything tunable lives in eval-reviewer.config.ts, and every persona is the
 * prompt file references/<name>.md. This file owns the run: load the config,
 * resolve the target, drive Sandcastle, merge the findings. The merge is plain
 * code on purpose — same findings in, same verdict out.
 *
 * Two ways to run a persona, chosen by `execution.mode`:
 *   local  — the agent CLI on this machine, inheriting this shell. Whatever
 *            authenticates your harness authenticates the review.
 *   docker — one container per persona, carrying only what `docker.mounts`
 *            and `docker.forwardEnv` hand it.
 *
 * Reached through scripts/review.ts, which installs the dependencies first.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { z } from "zod";

const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ─── Agents ──────────────────────────────────────────────────────────────────
// Three CLIs, because those are the three harnesses people already have open.
// Adding a fourth is one entry here — Sandcastle also ships cursor, opencode,
// and copilot providers.

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface AgentSpec {
  /** Binary the agent runs as — checked on PATH in local mode. */
  readonly cli: string;
  /** What to `npm i -g` when that binary is missing. */
  readonly npmPackage: string;
  readonly build: (
    model: string,
    thinking: Thinking,
    env: Record<string, string>
  ) => sandcastle.AgentProvider;
}

const AGENTS = {
  pi: {
    cli: "pi",
    npmPackage: "@earendil-works/pi-coding-agent",
    build: (model, thinking, env) =>
      sandcastle.pi(model, { env, ...(thinking === "off" ? {} : { thinking }) }),
  },
  "claude-code": {
    cli: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    build: (model, thinking, env) =>
      sandcastle.claudeCode(model, {
        env,
        ...(thinking === "off" || thinking === "minimal"
          ? {}
          : { effort: thinking }),
        // Outside a container Sandcastle withholds --dangerously-skip-permissions,
        // which leaves a -p run unable to read or grep — a review that can see
        // nothing. The prompts are reviewer-only, so the bypass is asked for
        // explicitly rather than left to a permission prompt nobody can answer.
        permissionMode: "bypassPermissions",
      }),
  },
  codex: {
    cli: "codex",
    npmPackage: "@openai/codex",
    build: (model, thinking, env) =>
      sandcastle.codex(model, {
        env,
        ...(thinking === "off" || thinking === "minimal"
          ? {}
          : { effort: thinking }),
      }),
  },
} as const satisfies Record<string, AgentSpec>;

type AgentName = keyof typeof AGENTS;

// ─── Config ──────────────────────────────────────────────────────────────────

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const VERDICTS = ["pass", "contest", "reject"] as const;

type Severity = (typeof SEVERITIES)[number];
type PersonaVerdict = (typeof VERDICTS)[number];

const ConfigSchema = z.object({
  agent: z
    .object({
      provider: z.enum(["pi", "claude-code", "codex"]).default("pi"),
      model: z.string().min(1).default("claude-sonnet-4-6"),
      thinking: z.enum(THINKING).default("medium"),
    })
    .prefault({}),
  execution: z
    .object({
      mode: z.enum(["local", "docker"]).default("local"),
      concurrency: z.number().int().positive().default(6),
      idleTimeoutSeconds: z.number().int().positive().default(300),
      retries: z.number().int().nonnegative().default(2),
    })
    .prefault({}),
  docker: z
    .object({
      image: z.string().min(1).default("sandcastle:eval-reviewer"),
      mounts: z
        .array(
          z.object({
            hostPath: z.string().min(1),
            sandboxPath: z.string().min(1),
            readonly: z.boolean().default(true),
          })
        )
        .default([]),
      forwardEnv: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  review: z
    .object({
      personas: z
        .array(
          z.object({
            name: z.string().min(1),
            critical: z.boolean().default(false),
          })
        )
        .min(1)
        .prefault([
          { name: "skeptic", critical: true },
          { name: "architect", critical: true },
          { name: "security", critical: true },
          { name: "minimalist", critical: false },
          { name: "performance", critical: false },
          { name: "test-coverage", critical: false },
        ]),
      failOn: z.enum([...SEVERITIES, "never"]).default("high"),
      outDir: z.string().min(1).default(".eval-reviewer"),
    })
    .prefault({}),
});

type Config = z.infer<typeof ConfigSchema>;
type Persona = Config["review"]["personas"][number];

// ─── Review payload ──────────────────────────────────────────────────────────

const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().min(1),
  // Agents quote numbers and emit null about as often as they omit the key.
  line: z.coerce.number().int().positive().nullish(),
  message: z.string().min(1),
  suggestion: z.string().min(1),
});

const ReviewSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  verdict: z.enum(VERDICTS),
});

type Finding = z.infer<typeof FindingSchema>;

// ─── Constants ───────────────────────────────────────────────────────────────

const OUTPUT_TAG = "review";
const SEVERITY_SCORE: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
/** Past this, models start truncating the target — say so rather than pretend. */
const TARGET_WARN_BYTES = 400_000;

const USAGE = `eval-reviewer — every persona reviews the same target independently

Usage:
  review.ts                      review the work in progress — uncommitted
                                 changes, else this branch against its base
  review.ts --diff <base-ref>    review \`git diff <base-ref>...HEAD\`
  review.ts <file-or-text>       review a diff file, a code file, or literal text

Options:
  --config PATH    config file (default: <repo>/eval-reviewer.config.ts, else the skill's)
  --mode NAME      local | docker — overrides the config for this run
  --personas a,b   subset of the personas the config lists
  --fail-on LEVEL  ${[...SEVERITIES, "never"].join(" | ")}
  --repo PATH      repo to review in (default: git root of the working directory)
  --help

Everything else lives in the config file. Exit codes:
  0 clean · 1 findings at/above fail-on · 2 critical findings · 3 incomplete run`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fail(message: string, ...detail: string[]): never {
  console.error(`eval-reviewer: ${message}`);
  for (const line of detail) {
    if (line) console.error(`  ${line}`);
  }
  process.exit(1);
}

/**
 * Where PATH says the binary is, or undefined. The full path is printed in the
 * header on purpose: more than one version of an agent CLI can be installed
 * (a global npm one and a bun one), PATH order decides which runs, and the
 * loser is often an old build that fails silently.
 */
function whichBinary(binary: string): string | undefined {
  try {
    return execFileSync(
      process.platform === "win32" ? "where" : "which",
      [binary],
      { encoding: "utf-8" }
    )
      .split("\n")[0]
      ?.trim();
  } catch {
    return undefined;
  }
}

function expandTilde(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

interface Flags {
  config?: string;
  mode?: string;
  personas?: string;
  "fail-on"?: string;
  repo?: string;
  diff?: string;
  _: string[];
}

function parseFlags(argv: string[]): Flags {
  const named: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
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
      named[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      fail(`--${key} needs a value.`, "Run --help for the full list.");
    }
    named[key] = next;
    i++;
  }

  return { ...named, _: positional };
}

function resolveRepo(explicit: string | undefined): string {
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(join(abs, ".git"))) {
      fail(`--repo ${explicit} is not a git repository (no .git).`);
    }
    return abs;
  }
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return fail(
      "not inside a git repository — Sandcastle anchors a run to one.",
      "Run from the repo you're reviewing, or pass --repo PATH."
    );
  }
}

/** The repo's config wins over the skill's default; neither has to exist. */
async function loadConfig(
  explicit: string | undefined,
  repoRoot: string
): Promise<{ config: Config; configPath: string }> {
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        join(repoRoot, "eval-reviewer.config.ts"),
        join(SKILL_ROOT, "eval-reviewer.config.ts"),
      ];

  const configPath = candidates.find((candidate) => existsSync(candidate));
  if (!configPath) fail(`config not found: ${candidates.join(", ")}`);

  const module = (await import(pathToFileURL(configPath).href)) as {
    default?: unknown;
  };
  const parsed = ConfigSchema.safeParse(module.default ?? {});
  if (!parsed.success) {
    fail(
      `${configPath} is not a valid config.`,
      ...parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      )
    );
  }

  return { config: parsed.data, configPath };
}

/** A file path, literal text, or a diff computed here. Never a URL — nothing is fetched. */
function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/**
 * No target given, so answer the question instead of asking it: review the work
 * in progress. Uncommitted changes first — that is what "review this" means
 * mid-task — then the branch against the base it forked from.
 */
function defaultTarget(repoRoot: string): { target: string; label: string } {
  const working = git(repoRoot, ["diff", "HEAD"]);
  if (working.trim() !== "") {
    return { target: working, label: "git diff HEAD (uncommitted work)" };
  }

  const remoteHead = git(repoRoot, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]).trim();
  const candidates = [remoteHead, "origin/main", "origin/master", "main", "master"];

  for (const base of candidates) {
    if (base === "") continue;
    if (git(repoRoot, ["rev-parse", "--verify", "--quiet", base]).trim() === "")
      continue;
    const branch = git(repoRoot, ["diff", `${base}...HEAD`]);
    if (branch.trim() !== "") {
      return { target: branch, label: `git diff ${base}...HEAD` };
    }
  }

  return fail(
    "nothing to review: no uncommitted changes, and this branch does not differ from its base.",
    "Pass a base ref with --diff <ref>, or a file path.",
    USAGE
  );
}

function resolveTarget(
  flags: Flags,
  repoRoot: string
): { target: string; label: string } {
  if (flags.diff) {
    const label = `git diff ${flags.diff}...HEAD`;
    let target: string;
    try {
      target = execFileSync("git", ["diff", `${flags.diff}...HEAD`], {
        cwd: repoRoot,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      return fail(
        `${label} failed in ${repoRoot}.`,
        error instanceof Error ? error.message : String(error),
        "In CI, fetch the base ref first — actions/checkout with fetch-depth: 0."
      );
    }
    if (target.trim() === "") fail(`${label} is empty — nothing to review.`);
    return { target, label };
  }

  if (flags._.length === 0) return defaultTarget(repoRoot);

  const path = resolve(flags._[0]!);
  return existsSync(path)
    ? { target: readFileSync(path, "utf-8"), label: flags._[0]! }
    : { target: flags._.join(" "), label: "inline text" };
}

// ─── Preflight ───────────────────────────────────────────────────────────────
// Everything knowably broken, checked before the first agent starts. A problem
// found here costs a second; found later it costs six agent runs.

interface Runtime {
  agentName: AgentName;
  /** Explicitly forwarded into the sandbox. Empty in local mode — it inherits. */
  agentEnv: Record<string, string>;
  sandbox: () => sandcastle.SandboxProvider;
  /** What the header prints as the source of the agent's credentials. */
  /** Resolved path of the agent CLI in local mode; undefined in docker mode. */
  cliPath?: string;
  authNote: string;
}

function preflight(config: Config, mode: "local" | "docker"): Runtime {
  const agentName = config.agent.provider;
  const agent: AgentSpec = AGENTS[agentName];

  // A persona is its prompt file. Both checks below fail here rather than
  // halfway through an agent run that could not have produced a review.
  for (const persona of config.review.personas) {
    const path = personaPrompt(persona.name);
    if (!existsSync(path)) {
      fail(
        `no prompt for persona "${persona.name}".`,
        `Expected ${path} — every name in review.personas needs one.`
      );
    }
    const text = readFileSync(path, "utf-8");
    if (!text.includes("{{TARGET}}")) {
      fail(
        `${path} has no {{TARGET}} placeholder.`,
        "That is where the reviewed code is substituted in; without it the persona reviews nothing."
      );
    }
    if (!text.includes(`<${OUTPUT_TAG}>`)) {
      fail(
        `${path} never mentions <${OUTPUT_TAG}>.`,
        "Sandcastle requires the prompt to contain the opening tag it extracts."
      );
    }
  }

  if (mode === "local") {
    // No credential check, on purpose. A locally installed CLI carries its own
    // auth — an OAuth token on disk, a provider registry, an exported key — and
    // demanding one specific variable is what blocked runs that would have
    // worked. If the CLI is there, authenticating is the harness's job.
    const cliPath = whichBinary(agent.cli);
    if (!cliPath) {
      fail(
        `local mode runs "${agent.cli}" on this machine, but it is not on PATH.`,
        `Install it with: npm i -g ${agent.npmPackage}`,
        `Or set execution.mode to "docker" in the config.`
      );
    }
    return {
      agentName,
      agentEnv: {},
      sandbox: () => noSandbox(),
      cliPath,
      authNote: `${cliPath} (inherits this shell)`,
    };
  }

  if (!whichBinary("docker")) {
    fail(
      "docker mode needs docker on PATH.",
      'Install it, or set execution.mode to "local" in the config.'
    );
  }

  // A container gets none of the host's auth. What reaches it is exactly these
  // two lists, so anything missing is worth saying out loud now — before the
  // image build, which is the slow part.
  const agentEnv: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of config.docker.forwardEnv) {
    const value = process.env[key];
    if (value) agentEnv[key] = value;
    else missing.push(key);
  }

  const mounts = config.docker.mounts
    .map((mount) => ({ ...mount, hostPath: expandTilde(mount.hostPath) }))
    .filter((mount) => {
      if (existsSync(mount.hostPath)) return true;
      console.warn(
        `eval-reviewer: skipping mount ${mount.hostPath} — no such path on this host.`
      );
      return false;
    });

  if (Object.keys(agentEnv).length === 0 && mounts.length === 0) {
    fail(
      "docker mode would start a container with no way to authenticate.",
      "Set docker.forwardEnv to the variables your provider needs, or",
      "docker.mounts to the config directory it reads (~/.pi/agent for pi)."
    );
  }
  if (missing.length > 0) {
    console.warn(
      `eval-reviewer: docker.forwardEnv names ${missing.join(", ")} — unset in this shell, not forwarded.`
    );
  }

  ensureImage(config, agentName);

  return {
    agentName,
    agentEnv,
    sandbox: () => docker({ imageName: config.docker.image, mounts }),
    authNote: `container: ${
      [...Object.keys(agentEnv), ...mounts.map((mount) => mount.hostPath)].join(
        ", "
      ) || "nothing forwarded"
    }`,
  };
}

/** Build the sandbox image on first use, so there is no setup step to forget. */
function ensureImage(config: Config, agentName: AgentName): void {
  try {
    execFileSync("docker", ["image", "inspect", config.docker.image], {
      stdio: "ignore",
    });
    return;
  } catch {
    // Not built yet — fall through and build it.
  }

  console.log(
    `  building ${config.docker.image} (one time, a couple of minutes)…`
  );
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;

  const result = spawnSync(
    "docker",
    [
      "build",
      "-t",
      config.docker.image,
      "--build-arg",
      `AGENT_NPM_PACKAGE=${AGENTS[agentName].npmPackage}`,
      "--build-arg",
      `AGENT_UID=${uid}`,
      "--build-arg",
      `AGENT_GID=${gid}`,
      join(SKILL_ROOT, "docker"),
    ],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    fail(
      `could not build ${config.docker.image}.`,
      'Set execution.mode to "local" to review without a container.'
    );
  }
}

// ─── Review execution ────────────────────────────────────────────────────────

/** A persona's prompt file. Absolute, because Sandcastle resolves promptFile
 *  against process.cwd() rather than the `cwd` option. */
function personaPrompt(persona: string): string {
  return join(SKILL_ROOT, "references", `${persona}.md`);
}

/**
 * The agent's own explanation of why it said nothing, dug out of one raw stdout
 * line.
 *
 * An agent CLI that cannot reach its provider does not crash: it reports the
 * failure inside its event stream and exits 0. Sandcastle's parser has no
 * reason to surface that — it is looking for assistant text — so without this
 * the run fails with "tag not found" and the real message ("OAuth refresh
 * failed", "model not found", "rate limited") never leaves the stream.
 */
function agentErrorIn(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  if (!trimmed.startsWith("{")) {
    return /^(error|fatal)\b/i.test(trimmed) ? trimmed : undefined;
  }

  let found: string | undefined;
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (found) return;
      if (
        typeof value === "string" &&
        value !== "" &&
        /^(errorMessage|error|error_message)$/.test(key)
      ) {
        found = value;
        return;
      }
      walk(value);
    }
  };

  try {
    walk(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
  return found;
}

interface AgentResult {
  persona: string;
  status: "done" | "failed";
  findings: Finding[];
  verdict: PersonaVerdict;
  /** Why this persona failed — in the report, so a silent gap is impossible. */
  error?: string;
}

interface RunContext {
  config: Config;
  runtime: Runtime;
  target: string;
  repoRoot: string;
  outDir: string;
}

async function reviewWith(
  persona: Persona,
  context: RunContext
): Promise<AgentResult> {
  const { config, runtime, target, repoRoot, outDir } = context;
  const logPath = join(outDir, persona.name, "agent.log");
  mkdirSync(dirname(logPath), { recursive: true });
  let spoke = false;
  let agentError: string | undefined;

  try {
    const result = await sandcastle.run({
      agent: AGENTS[runtime.agentName].build(
        config.agent.model,
        config.agent.thinking,
        runtime.agentEnv
      ),
      sandbox: runtime.sandbox(),
      cwd: repoRoot,
      name: persona.name,
      // The persona file is the prompt — no wrapper, no preamble. Sandcastle
      // substitutes {{TARGET}} on the host and treats an argument's contents as
      // inert text, so a diff carrying !`cmd` or {{KEY}} is never expanded.
      promptFile: personaPrompt(persona.name),
      promptArgs: { TARGET: target },
      // Structured output requires a single iteration.
      maxIterations: 1,
      // No branchStrategy: a review reads, it never commits. The default for
      // bind-mount and no-sandbox providers is `head`, which skips the worktree,
      // the branch, and the merge — six worktrees of a large repo was most of
      // the wall time, spent isolating writes that never happen.
      idleTimeoutSeconds: config.execution.idleTimeoutSeconds,
      logging: {
        type: "file",
        path: logPath,
        // Did the agent produce any text or tool call? A run that fails having
        // produced none is a broken CLI or a model that returned nothing — not
        // a model that ignored the output format — and reporting the second
        // when it was the first sends everyone hunting through prompts for a
        // bug that was on PATH. "raw" is excluded on purpose: session and
        // lifecycle lines arrive even when the model never answers.
        onAgentStreamEvent: (event) => {
          if (event.type === "text" || event.type === "toolCall") spoke = true;
          else if (event.type === "raw" && !agentError)
            agentError = agentErrorIn(event.line);
        },
      },
      output: sandcastle.Output.object({
        tag: OUTPUT_TAG,
        schema: ReviewSchema,
        maxRetries: config.execution.retries,
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
    const message = spoke
      ? error instanceof Error
        ? error.message
        : String(error)
      : agentError
        ? `the agent produced no text at all. It reported: ${agentError}`
        : `the agent produced no text at all — the review never happened, so the ` +
          `missing <${OUTPUT_TAG}> tag is a symptom, not the cause. Either ` +
          `${runtime.cliPath ?? runtime.agentName} is not the CLI you think it is ` +
          `(a second, older copy earlier on PATH exits 0 having printed nothing), ` +
          `or "${config.agent.model}" returned an empty answer. ` +
          `Full transcript: ${logPath}`;
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

/** Run personas in batches, so N agents are alive at once rather than all of them. */
async function runReviews(
  personas: Persona[],
  context: RunContext
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  const { concurrency } = context.config.execution;

  for (let i = 0; i < personas.length; i += concurrency) {
    const batch = personas.slice(i, i + concurrency);
    console.log(`\n  Reviewing: ${batch.map((p) => p.name).join(", ")}`);
    results.push(
      ...(await Promise.all(
        batch.map((persona) => reviewWith(persona, context))
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
  mode: string;
  timestamp: string;
}

function buildVerdict(
  results: AgentResult[],
  findings: Finding[],
  personas: Persona[],
  meta: { target: string; agent: string; model: string; mode: string }
): Verdict {
  const breakdown: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) breakdown[finding.severity]++;

  const criticalPersonas = new Set(
    personas.filter((persona) => persona.critical).map((persona) => persona.name)
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
    ...meta,
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
    `**Reviewed by**: ${verdict.agent} (${verdict.model}), ${verdict.mode} mode  `
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
    const entry = verdict.agents[result.persona]!;
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

const flags = parseFlags(process.argv.slice(2));
const repoRoot = resolveRepo(flags.repo);
const { config, configPath } = await loadConfig(flags.config, repoRoot);

// A CI runner is already a disposable VM: a container inside it buys nothing
// and costs an image build every run. Its secrets are in the environment,
// which is exactly what local mode inherits.
const mode = flags.mode ?? (process.env.CI ? "local" : config.execution.mode);
if (mode !== "local" && mode !== "docker") {
  fail(`--mode must be local or docker, got "${mode}".`);
}

const failOn = (flags["fail-on"] ?? config.review.failOn) as Severity | "never";
if (failOn !== "never" && !SEVERITIES.includes(failOn)) {
  fail(
    `--fail-on must be one of ${SEVERITIES.join(", ")}, never — got "${failOn}".`
  );
}

const personas = (() => {
  if (!flags.personas) return config.review.personas;
  const names = flags.personas
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter(
    (name) => !config.review.personas.some((persona) => persona.name === name)
  );
  if (unknown.length > 0) {
    fail(
      `unknown persona(s): ${unknown.join(", ")}.`,
      `The config lists: ${config.review.personas.map((p) => p.name).join(", ")}.`
    );
  }
  return config.review.personas.filter((persona) =>
    names.includes(persona.name)
  );
})();

const { target, label } = resolveTarget(flags, repoRoot);
const targetBytes = Buffer.byteLength(target);
if (targetBytes > TARGET_WARN_BYTES) {
  console.warn(
    `eval-reviewer: target is ${Math.round(targetBytes / 1024)}KB — large enough ` +
      `that models may truncate it. Consider reviewing fewer files at once.`
  );
}

const runtime = preflight(config, mode);

const outDir = isAbsolute(config.review.outDir)
  ? config.review.outDir
  : join(repoRoot, config.review.outDir);
mkdirSync(outDir, { recursive: true });
// Self-ignoring output directory — nothing to add to the repo's .gitignore.
writeFileSync(join(outDir, ".gitignore"), "*\n");

console.log(`\n  eval-reviewer`);
console.log(`  Target:   ${label}`);
console.log(`  Agent:    ${runtime.agentName} (${config.agent.model})`);
console.log(`  Mode:     ${mode}`);
console.log(`  Auth:     ${runtime.authNote}`);
console.log(`  Personas: ${personas.map((persona) => persona.name).join(", ")}`);
console.log(`  Config:   ${configPath}`);
console.log(`  Report:   ${outDir}`);

const results = await runReviews(personas, {
  config,
  runtime,
  target,
  repoRoot,
  outDir,
});
const findings = mergeFindings(results);
const verdict = buildVerdict(results, findings, personas, {
  target: label,
  agent: runtime.agentName,
  model: config.agent.model,
  mode,
});
const report = renderReport(results, findings, verdict);

writeFileSync(join(outDir, "report.md"), report);
writeFileSync(
  join(outDir, "verdict.json"),
  `${JSON.stringify(verdict, null, 2)}\n`
);

// In GitHub Actions the report belongs on the run page, not only in an artifact.
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  } catch (error) {
    console.warn(
      `eval-reviewer: could not write the job summary: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

console.log(`\n  Report:  ${join(outDir, "report.md")}`);
console.log(`  Verdict: ${join(outDir, "verdict.json")}`);
console.log(`\n  ═══════ VERDICT: ${verdict.overall} ═══════\n`);

// An incomplete run is always a failure — it is not a clean result, it is an
// unknown one. Otherwise the gate is whatever fail-on asked for.
if (verdict.overall === "INCOMPLETE") process.exit(3);
if (failOn === "never") process.exit(0);

const threshold = SEVERITY_SCORE[failOn];
const worst = findings.reduce(
  (max, finding) => Math.max(max, SEVERITY_SCORE[finding.severity]),
  0
);
process.exit(worst < threshold ? 0 : worst === SEVERITY_SCORE.critical ? 2 : 1);
