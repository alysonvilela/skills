#!/usr/bin/env bun
/**
 * Orchestrator — Spawns parallel reviewer agents, polls for completion hooks,
 * merges findings into a unified report.
 *
 * Usage:
 *   bun orchestrator.ts <path-to-diff-or-code> [options]
 *
 * Options:
 *   --personas skeptic,architect,security  Select specific personas (default: all 6)
 *   --timeout 600                          Max seconds per agent (default: 300)
 *   --strategy qwen                        Spawn strategy: qwen (default), claude, generic
 */

import { writeFileSync, existsSync, mkdirSync, rmSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

interface DoneJson {
  persona: string;
  status: "done" | "timed_out" | "failed" | "error";
  findings: Finding[];
  verdict: "pass" | "contest" | "reject";
}

interface AgentResult {
  persona: string;
  status: DoneJson["status"];
  findings: Finding[];
  verdict: DoneJson["verdict"];
  durationMs: number;
}

interface OrchestratorConfig {
  target: string;
  personas: string[];
  timeoutSeconds: number;
  strategy: string;
  pollIntervalMs: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALL_PERSONAS = [
  "skeptic",
  "architect",
  "minimalist",
  "security",
  "performance",
  "test-coverage",
];

const CRITICAL_PERSONAS = ["skeptic", "architect", "security"];

// Max concurrent agents — prevents resource exhaustion when each agent runs a
// heavy LLM CLI process. Tuned for typical dev machines (8+ cores).
const MAX_CONCURRENT_AGENTS = 4;

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const SEVERITY_SCORE: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): OrchestratorConfig {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: bun orchestrator.ts <path-to-diff-or-code> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --personas a,b,c   Select personas (default: all 6)");
    console.error("  --timeout N        Max seconds per agent (default: 300)");
    console.error("  --strategy NAME    Spawn strategy: qwen (default), claude, generic");
    process.exit(1);
  }

  const target = args[0];
  let personas = ALL_PERSONAS;
  let timeoutSeconds = 300;
  let strategy = "qwen";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--personas" && args[i + 1]) {
      personas = args[i + 1]
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter((p) => ALL_PERSONAS.includes(p));
      i++;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeoutSeconds = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--strategy" && args[i + 1]) {
      strategy = args[i + 1];
      i++;
    }
  }

  if (personas.length === 0) {
    console.error("Error: No valid personas specified.");
    process.exit(1);
  }

  return { target, personas, timeoutSeconds, strategy, pollIntervalMs: 1000 };
}

// ─── Workspace Setup ─────────────────────────────────────────────────────────

function setupWorkspace(personas: string[]): string {
  const projectRoot = dirname(import.meta.dir);
  const workDir = join(projectRoot, ".eval-reviewer");

  mkdirSync(workDir, { recursive: true });

  for (const persona of personas) {
    const personaDir = join(workDir, persona);
    mkdirSync(personaDir, { recursive: true });

    // Clean any previous done.json
    const donePath = join(personaDir, "done.json");
    if (existsSync(donePath)) {
      rmSync(donePath, { force: true });
    }

    // Copy target diff/code into each persona's workspace
    // The spawn-agent script handles copying the actual content
  }

  return workDir;
}

// ─── Agent Spawning ──────────────────────────────────────────────────────────

/**
 * Spawn agents with bounded concurrency to prevent resource exhaustion.
 * Launches at most MAX_CONCURRENT_AGENTS simultaneously.
 */
async function spawnAgents(
  personas: string[],
  workDir: string,
  target: string,
  strategy: string
): Promise<Map<string, Bun.Subprocess>> {
  const processes = new Map<string, Bun.Subprocess>();
  const spawnScript = join(dirname(import.meta.dir), "scripts", "spawn-agent.ts");
  const referencesDir = join(dirname(import.meta.dir), "references");

  // Launch agents in batches of MAX_CONCURRENT_AGENTS
  for (let i = 0; i < personas.length; i += MAX_CONCURRENT_AGENTS) {
    const batch = personas.slice(i, i + MAX_CONCURRENT_AGENTS);

    if (i > 0) {
      console.log(`  Waiting for batch of ${batch.length} agents...`);
    }

    const batchEntries: Array<{ persona: string; proc: Bun.Subprocess; logFd: number }> = [];

    for (const persona of batch) {
      const personaDir = join(workDir, persona);

      console.log(`  Spawning ${persona}...`);

      // Stream output to per-agent log files to prevent pipe backpressure
      const logPath = join(personaDir, "agent.log");
      const logFd = openSync(logPath, "w");

      const proc = Bun.spawn(
        [
          "bun",
          spawnScript,
          "--persona",
          persona,
          "--target",
          target,
          "--output-dir",
          personaDir,
          "--references-dir",
          referencesDir,
          "--strategy",
          strategy,
        ],
        {
          stdout: logFd,
          stderr: logFd,
        }
      );

      batchEntries.push({ persona, proc, logFd });
    }

    // Wait for all processes in this batch to exit before launching the next batch
    await Promise.all(
      batchEntries.map(async ({ proc, logFd }) => {
        try {
          await proc.exited;
        } finally {
          try { closeSync(logFd); } catch { /* best-effort */ }
        }
      })
    );

    for (const entry of batchEntries) {
      processes.set(entry.persona, entry.proc);
    }
  }

  return processes;
}

// ─── Hook Polling ────────────────────────────────────────────────────────────

async function waitForCompletion(
  personas: string[],
  workDir: string,
  timeoutSeconds: number,
  pollIntervalMs: number
): Promise<Map<string, AgentResult>> {
  const results = new Map<string, AgentResult>();
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  const completed = new Set<string>();

  console.log(`\n  Waiting for ${personas.length} agents (timeout: ${timeoutSeconds}s)...`);

  while (completed.size < personas.length) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      console.log("  ⏱  Timeout reached — collecting partial results");
      break;
    }

    for (const persona of personas) {
      if (completed.has(persona)) continue;

      const donePath = join(workDir, persona, "done.json");
      if (existsSync(donePath)) {
        try {
          const raw = Bun.file(donePath);
          const json: DoneJson = await raw.json();
          results.set(persona, {
            persona: json.persona,
            status: json.status,
            findings: json.findings || [],
            verdict: json.verdict,
            durationMs: Date.now() - startTime,
          });
          completed.add(persona);

          const statusIcon = json.status === "done" ? "✓" : "✗";
          const count = json.findings?.length ?? 0;
          console.log(`  ${statusIcon} ${persona} completed — ${count} findings, verdict: ${json.verdict}`);
        } catch {
          // File might be mid-write, retry next poll
        }
      }
    }

    if (completed.size < personas.length) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  // Mark incomplete agents
  for (const persona of personas) {
    if (!completed.has(persona)) {
      results.set(persona, {
        persona,
        status: "timed_out",
        findings: [],
        verdict: "contest",
        durationMs: Date.now() - startTime,
      });
      console.log(`  ✗ ${persona} — timed out or failed`);
    }
  }

  return results;
}

// ─── Report Generation ───────────────────────────────────────────────────────

function deduplicateFindings(allFindings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return allFindings.filter((f) => {
    // Use a delimiter unlikely to appear in file paths or messages
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

function computeVerdict(results: Map<string, AgentResult>): {
  overall: "PASS" | "CONTESTED" | "REJECT" | "INCOMPLETE";
  breakdown: Record<string, number>;
} {
  const breakdown: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let anyIncomplete = false;

  for (const [, result] of results) {
    if (result.status !== "done") {
      anyIncomplete = true;
      continue;
    }
    for (const f of result.findings) {
      breakdown[f.severity] = (breakdown[f.severity] || 0) + 1;
    }
  }

  // Check if critical agents timed out
  const criticalTimedOut = [...results.entries()].some(
    ([persona, r]) => CRITICAL_PERSONAS.includes(persona) && r.status !== "done"
  );

  if (anyIncomplete || criticalTimedOut) {
    return { overall: "INCOMPLETE", breakdown };
  }

  if (breakdown.critical > 0) return { overall: "REJECT", breakdown };
  if (breakdown.high > 0) return { overall: "CONTESTED", breakdown };
  return { overall: "PASS", breakdown };
}

function generateReport(
  results: Map<string, AgentResult>,
  target: string
): { markdown: string; verdict: any } {
  const allFindings: Finding[] = [];
  for (const [, result] of results) {
    allFindings.push(...result.findings);
  }

  const uniqueFindings = deduplicateFindings(allFindings);
  const sortedFindings = sortFindings(uniqueFindings);
  const { overall, breakdown } = computeVerdict(results);

  // ── Markdown Report — use array join for O(n) performance ──
  const parts: string[] = [];
  parts.push(`# Code Review Report\n\n`);
  parts.push(`**Target**: \`${target}\`\n`);
  parts.push(`**Date**: ${new Date().toISOString().split("T")[0]}\n`);
  parts.push(`**Verdict**: **${overall}**\n\n`);

  parts.push(`## Summary\n\n`);
  parts.push(`| Severity | Count |\n`);
  parts.push(`|----------|-------|\n`);
  for (const sev of SEVERITY_ORDER) {
    if (breakdown[sev] !== undefined) {
      parts.push(`| ${sev} | ${breakdown[sev]} |\n`);
    }
  }
  parts.push(`| **Total** | **${sortedFindings.length}** |\n\n`);

  parts.push(`## Agent Status\n\n`);
  parts.push(`| Persona | Status | Findings | Verdict |\n`);
  parts.push(`|---------|--------|----------|---------|\n`);
  for (const [persona, result] of results) {
    parts.push(`| ${persona} | ${result.status} | ${result.findings.length} | ${result.verdict} |\n`);
  }
  parts.push(`\n`);

  if (sortedFindings.length > 0) {
    parts.push(`## Findings\n\n`);
    for (const f of sortedFindings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      parts.push(`### [${f.severity.toUpperCase()}] ${f.message}\n\n`);
      parts.push(`- **File**: \`${loc}\`\n`);
      parts.push(`- **Suggestion**: ${f.suggestion}\n\n`);
    }
  } else {
    parts.push(`## Findings\n\nNo findings to report. Great job!\n\n`);
  }

  const md = parts.join("");

  // ── Verdict JSON ──
  const verdict = {
    overall,
    breakdown,
    agents: Object.fromEntries(
      [...results].map(([p, r]) => [p, { status: r.status, findings: r.findings.length, verdict: r.verdict }])
    ),
    target,
    timestamp: new Date().toISOString(),
  };

  return { markdown: md, verdict };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║       Eval Reviewer — Orchestrator       ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║ Target:   ${config.target.padEnd(30)}║`);
  console.log(`║ Personas: ${config.personas.length} of ${ALL_PERSONAS.length}`.padEnd(44) + `║`);
  console.log(`║ Strategy: ${config.strategy.padEnd(30)}║`);
  console.log(`║ Timeout:  ${config.timeoutSeconds}s`.padEnd(44) + `║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // 1. Setup workspace
  const workDir = setupWorkspace(config.personas);
  console.log(`  Workspace: ${workDir}\n`);

  // 2. Spawn agents
  console.log(`  Spawning ${config.personas.length} agents...`);
  const processes = await spawnAgents(config.personas, workDir, config.target, config.strategy);

  // 3. Wait for completion via hooks
  const results = await waitForCompletion(
    config.personas,
    workDir,
    config.timeoutSeconds,
    config.pollIntervalMs
  );

  // 4. Generate report
  const { markdown: reportMd, verdict } = generateReport(results, config.target);

  // 5. Write outputs
  const reportPath = join(workDir, "report.md");
  const verdictPath = join(workDir, "verdict.json");

  writeFileSync(reportPath, reportMd);
  writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));

  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Verdict: ${verdictPath}`);
  console.log(`\n  ═══════ VERDICT: ${verdict.overall} ═══════\n`);

  // Exit code based on verdict
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
