#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Auto-install deps on first run
if (!existsSync(join(ROOT, "node_modules", "@ai-hero", "sandcastle"))) {
  const onPath = (b: string) => { try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch { return false; } };
  const [cmd, args] = onPath("bun") ? ["bun", ["install"]] : ["npm", ["install", "--omit=dev", "--no-fund", "--no-audit"]];
  const r = spawnSync(cmd, [...args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("dep install failed"); process.exit(1); }
}

// ─── Agent providers ─────────────────────

const AGENTS: Record<string, (model: string, opts: Record<string, unknown>) => sandcastle.AgentProvider> = {
  pi: (m, o) => sandcastle.pi(m, o),
  "claude-code": (m, o) => sandcastle.claudeCode(m, { ...o, permissionMode: "bypassPermissions" }),
  codex: (m, o) => sandcastle.codex(m, o),
};

// ─── Config (reads JSON) ─────────────────

interface Mount { hostPath: string; sandboxPath: string; readonly: boolean }
interface Config { provider: string; model: string; thinking: string; mode: string; concurrency: number; idleTimeoutSeconds: number; retries: number; failOn: string; outDir: string; personas: { name: string; critical: boolean }[]; docker: { image: string; mounts: Mount[]; forwardEnv: string[] } }

function loadConfig(explicit?: string, repoRoot?: string): Config {
  const c = JSON.parse(readFileSync(
    [explicit, join(repoRoot ?? "", "eval-reviewer.config.json"), join(ROOT, "eval-reviewer.config.json")]
      .find(f => f && existsSync(resolve(f))) ?? fail("config not found"), "utf-8"));
  return {
    provider: c.provider ?? "pi", model: c.model ?? "lm-studio/gemma-4-e2b-it", thinking: c.thinking ?? "medium",
    mode: c.mode ?? "local", concurrency: c.concurrency ?? 6, idleTimeoutSeconds: c.idleTimeoutSeconds ?? 300, retries: c.retries ?? 2,
    failOn: c.failOn ?? "high", outDir: c.outDir ?? ".eval-reviewer",
    personas: c.personas ?? [
      { name: "skeptic", critical: true }, { name: "architect", critical: true }, { name: "security", critical: true },
      { name: "minimalist", critical: false }, { name: "performance", critical: false }, { name: "test-coverage", critical: false },
    ],
    docker: {
      image: c.docker?.image ?? "sandcastle:eval-reviewer",
      mounts: c.docker?.mounts ?? [],
      forwardEnv: c.docker?.forwardEnv ?? [],
    },
  };
}

// ─── CLI ─────────────────────────────────

const USAGE = `eval-reviewer — multi-persona code review

Usage: review.ts [options] [target]
  --config PATH    config file
  --pr NUMBER      post findings to PR
  --diff REF       git diff REF...HEAD
  --personas a,b   subset
  --repo PATH      repo root
  --mode local|docker
  --help`;

function parseFlags(a: string[]) {
  const f: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const arg = a[i]!;
    if (arg === "--help") { console.log(USAGE); process.exit(0); }
    if (!arg.startsWith("--")) { f._ = arg; continue; }
    const k = arg.slice(2), n = a[i + 1];
    if (n && !n.startsWith("--")) { f[k] = n; i++; }
  }
  return f;
}

function fail(m: string): never { console.error(m); process.exit(1); }

// ─── Git ─────────────────────────────────

function git(a: string[], cwd?: string) {
  try { return execFileSync("git", a, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch { return ""; }
}

function resolveRoot(flags: Record<string, string>) {
  if (flags.repo) { const r = resolve(flags.repo); if (existsSync(join(r, ".git"))) return r; }
  return git(["rev-parse", "--show-toplevel"]) || fail("not in a git repo");
}

function resolveTarget(flags: Record<string, string>, root: string) {
  if (flags.diff) { const t = git(["diff", `${flags.diff}...HEAD`], root); if (t) return { target: t, label: `diff ${flags.diff}...HEAD` }; fail("empty diff"); }
  const w = git(["diff", "HEAD"], root); if (w) return { target: w, label: "working tree" };
  const b = git(["diff", "main...HEAD"], root) || git(["diff", "master...HEAD"], root); if (b) return { target: b, label: "branch diff" };
  if (flags._) { const p = resolve(flags._); if (existsSync(p)) return { target: readFileSync(p, "utf-8"), label: flags._! }; return { target: flags._, label: "inline text" }; }
  fail("nothing to review");
}

// ─── Diff parser (for PR anchor validation) ──

function parseDiffLines(d: string) {
  const files = new Map<string, Set<number>>(); let cur: Set<number> | undefined, nl = 0;
  for (const line of d.split("\n")) {
    const pm = /^\+\+\+ b\/(.+)/.exec(line); if (pm) { cur = files.get(pm[1]!) ?? new Set(); files.set(pm[1]!, cur); continue; }
    const hm = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line); if (hm) { nl = Number(hm[1]); continue; }
    if (!cur) continue;
    if (line.startsWith("+")) cur.add(nl++); else if (line.startsWith(" ")) cur.add(nl++);
  }
  return files;
}

// ─── Sandcastle output schema ────────────

const FindingSchema = z.object({ severity: z.enum(["critical", "high", "medium", "low"]), file: z.string().min(1), line: z.coerce.number().int().positive().nullish(), message: z.string().min(1), suggestion: z.string().min(1) });
const ReviewSchema = z.object({ findings: z.array(FindingSchema).default([]), verdict: z.enum(["pass", "contest", "reject"]) });
type Finding = z.infer<typeof FindingSchema>;

// ─── Sandbox ──────────────────────────────

function expandTilde(p: string) { return p.startsWith("~") ? join(homedir(), p.slice(1)) : p; }

function sandbox(mode: string, cfg: Config) {
  if (mode === "local") return noSandbox();
  if (mode !== "docker") fail(`mode must be local or docker, got ${mode}`);
  if (!existsSync("/usr/bin/docker") && !existsSync("/usr/local/bin/docker")) fail("docker not found on PATH");
  // Build image on first use
  try { execFileSync("docker", ["image", "inspect", cfg.docker.image], { stdio: "ignore" }); }
  catch {
    console.log(`  building ${cfg.docker.image}…`);
    const r = spawnSync("docker", ["build", "-t", cfg.docker.image, join(ROOT, "docker")], { stdio: "inherit" });
    if (r.status !== 0) fail("docker build failed");
  }
  const mounts = cfg.docker.mounts
    .map(m => ({ ...m, hostPath: expandTilde(m.hostPath) }))
    .filter(m => { if (existsSync(m.hostPath)) return true; console.warn(`  skipping mount ${m.hostPath} — not found`); return false; });
  const agentEnv: Record<string, string> = {};
  for (const key of cfg.docker.forwardEnv) { const v = process.env[key]; if (v) agentEnv[key] = v; }
  return docker({ imageName: cfg.docker.image, mounts, env: agentEnv });
}

// ─── Persona execution ───────────────────

interface PersonaResult { persona: string; status: "done" | "failed"; findings: Finding[]; verdict: string; error?: string }

async function runPersona(name: string, target: string, cfg: Config, root: string, sb: ReturnType<typeof sandbox>): Promise<PersonaResult> {
  const pp = join(ROOT, "references", `${name}.md`);
  if (!existsSync(pp)) return { persona: name, status: "failed", findings: [], verdict: "contest", error: `missing ${name}.md` };
  const agent = AGENTS[cfg.provider];
  if (!agent) return { persona: name, status: "failed", findings: [], verdict: "contest", error: `unknown provider: ${cfg.provider}` };
  try {
    const r = await sandcastle.run({
      agent: agent(cfg.model, { thinking: cfg.thinking === "off" ? undefined : cfg.thinking }),
      sandbox: sb, cwd: root, name, promptFile: pp, promptArgs: { TARGET: target },
      maxIterations: 1, idleTimeoutSeconds: cfg.idleTimeoutSeconds,
      output: sandcastle.Output.object({ tag: "review", schema: ReviewSchema, maxRetries: cfg.retries }),
    });
    return { persona: name, status: "done", findings: r.output.findings, verdict: r.output.verdict };
  } catch (e) { return { persona: name, status: "failed", findings: [], verdict: "contest", error: String(e) }; }
}

// ─── Merge ───────────────────────────────

function mergeFindings(results: PersonaResult[]) {
  const seen = new Set<string>(), all: Finding[] = [];
  const score: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  for (const r of results) for (const f of r.findings) {
    const k = `${f.file}\x00${f.line ?? ""}\x00${f.message}`;
    if (!seen.has(k)) { seen.add(k); all.push(f); }
  }
  return all.sort((a, b) => (score[b.severity] ?? 0) - (score[a.severity] ?? 0) || a.file.localeCompare(b.file));
}

// ─── Verdict & Report ────────────────────

function buildVerdict(results: PersonaResult[], findings: Finding[], personas: { name: string; critical: boolean }[], meta: { target: string; model: string; mode: string }) {
  const breakdown = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) breakdown[f.severity]++;
  const criticalSet = new Set(personas.filter(p => p.critical).map(p => p.name));
  const crFail = results.some(r => criticalSet.has(r.persona) && r.status !== "done");
  const anyFail = results.some(r => r.status !== "done");
  const overall = crFail ? "INCOMPLETE" : breakdown.critical > 0 ? "REJECT" : breakdown.high > 0 ? "CONTESTED" : anyFail ? "INCOMPLETE" : "PASS";
  return { overall, breakdown, findings, ...meta, timestamp: new Date().toISOString(), agents: Object.fromEntries(results.map(r => [r.persona, { status: r.status, critical: criticalSet.has(r.persona), findings: r.findings.length, verdict: r.verdict, ...(r.error ? { error: r.error } : {}) }])) };
}

function renderReport(results: PersonaResult[], findings: Finding[], v: ReturnType<typeof buildVerdict>): string {
  const out: string[] = [`# Code Review Report\n`, `**Target**: \`${v.target}\`  `, `**Verdict**: **${v.overall}**\n`, `## Summary\n`, `| Severity | Count |`, `|----------|-------|`];
  for (const s of ["critical", "high", "medium", "low"] as const) out.push(`| ${s} | ${v.breakdown[s]} |`);
  out.push(`| **Total** | **${findings.length}** |\n`, `## Personas\n`, `| Persona | Critical | Status | Findings |`, `|---------|----------|--------|----------|`);
  for (const r of results) out.push(`| ${r.persona} | ${v.agents[r.persona]?.critical ? "★" : ""} | ${r.status} | ${r.findings.length} |`);
  const failed = results.filter(r => r.status !== "done");
  if (failed.length) { out.push(`\n## Failed\n`); for (const r of failed) out.push(`- **${r.persona}**: ${r.error ?? "unknown"}`); }
  if (!findings.length) return out.join("\n") + `\nNo findings.\n`;
  out.push(`\n## Findings\n`);
  for (const f of findings) { const loc = f.line ? `${f.file}:${f.line}` : f.file; out.push(`### [${f.severity.toUpperCase()}] ${f.message}`, `- **File**: \`${loc}\``, `- **Suggestion**: ${f.suggestion}\n`); }
  return out.join("\n");
}

// ─── PR posting (was pr-comment.ts) ──────

function postToPr(findings: Finding[], diff: string, pr: string, v: ReturnType<typeof buildVerdict>) {
  const dl = parseDiffLines(diff), anchored: { path: string; line: number; body: string }[] = [], unanchored: Finding[] = [];
  for (const f of findings) {
    const lines = dl.get(f.file);
    if (f.line == null || !lines?.has(f.line)) { unanchored.push(f); continue; }
    anchored.push({ path: f.file, line: f.line, body: `**${f.severity.toUpperCase()}** — ${f.message}\n\n${f.suggestion}` });
  }
  const body: string[] = [`## eval-reviewer: ${v.overall}`, `${findings.length} findings — ${v.breakdown.critical} critical, ${v.breakdown.high} high, ${v.breakdown.medium} medium, ${v.breakdown.low} low.`];
  const failed = Object.entries(v.agents).filter(([, a]) => a.status !== "done");
  if (failed.length) { body.push("", "### Missing personas"); for (const [n, a] of failed) body.push(`- **${n}**: ${a.error ?? a.status}`); }
  if (unanchored.length) { body.push("", "### Not anchored"); for (const f of unanchored) body.push(`- **${f.severity.toUpperCase()}** \`${f.file}:${f.line ?? "?"}\` — ${f.message}`); }
  const sha = execFileSync("gh", ["pr", "view", pr, "--json", "headRefOid", "--jq", ".headRefOid"], { encoding: "utf-8" }).trim();
  execFileSync("gh", ["api", `repos/{owner}/{repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"], { input: JSON.stringify({ event: "COMMENT", commit_id: sha, body: body.join("\n"), comments: anchored.map(c => ({ ...c, side: "RIGHT" })) }), encoding: "utf-8" });
  console.error(`Posted to PR ${pr}`);
}

// ─── Main ────────────────────────────────

const flags = parseFlags(process.argv.slice(2));
const root = resolveRoot(flags);
const config = loadConfig(flags.config, root);
const mode = flags.mode ?? (process.env.CI ? "local" : config.mode);
const { target, label } = resolveTarget(flags, root);

const personas = flags.personas ? config.personas.filter(p => flags.personas!.split(",").map(s => s.trim()).includes(p.name)) : config.personas;
const sb = sandbox(mode, config);

const results: PersonaResult[] = [];
for (let i = 0; i < personas.length; i += config.concurrency) {
  results.push(...await Promise.all(personas.slice(i, i + config.concurrency).map(p => runPersona(p.name, target, config, root, sb))));
}

const findings = mergeFindings(results);
const verdict = buildVerdict(results, findings, personas, { target: label, model: config.model, mode });
const report = renderReport(results, findings, verdict);

const outDir = isAbsolute(config.outDir) ? config.outDir : join(root, config.outDir);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, ".gitignore"), "*\n");
writeFileSync(join(outDir, "report.md"), report);
writeFileSync(join(outDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);

if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, report);
if (flags.pr) postToPr(findings, target, flags.pr, verdict);

console.log(`\n  VERDICT: ${verdict.overall}\n`);
if (verdict.overall === "INCOMPLETE") process.exit(3);
if (config.failOn === "never") process.exit(0);
const score: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const worst = findings.reduce((m, f) => Math.max(m, score[f.severity] ?? 0), 0);
process.exit(worst < (score[config.failOn] ?? 0) ? 0 : worst >= 4 ? 2 : 1);
