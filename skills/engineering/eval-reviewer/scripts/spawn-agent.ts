#!/usr/bin/env bun
/**
 * Spawn Agent — Launches a single reviewer agent in isolation.
 *
 * This script is the "strategy adapter." The default implementation uses
 * `qwen` CLI in headless mode, but the design allows plugging in other
 * strategies (claude, generic, etc.) by modifying the executeStrategy function.
 *
 * Each agent receives:
 *   - Its persona prompt (references/{persona}.md)
 *   - The target code/diff to review
 *   - An output directory to write done.json
 *
 * Usage:
 *   bun spawn-agent.ts \
 *     --persona skeptic \
 *     --target /path/to/diff.md \
 *     --output-dir .eval-reviewer/skeptic \
 *     --references-dir ./references \
 *     --strategy qwen
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpawnConfig {
  persona: string;
  target: string;
  outputDir: string;
  referencesDir: string;
  strategy: string;
}

interface DoneJson {
  persona: string;
  status: "done" | "failed" | "error";
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file: string;
    line?: number;
    message: string;
    suggestion: string;
  }>;
  verdict: "pass" | "contest" | "reject";
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): SpawnConfig {
  const args = process.argv.slice(2);

  const config: Partial<SpawnConfig> = {};

  for (let i = 0; i < args.length; i += 2) {
    const rawKey = args[i];
    const key = rawKey?.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[i + 1];
    if (key && value) {
      config[key as keyof SpawnConfig] = value;
    }
  }

  if (!config.persona || !config.target || !config.outputDir || !config.referencesDir) {
    console.error("Usage: bun spawn-agent.ts --persona X --target Y --output-dir Z --references-dir R [--strategy qwen]");
    process.exit(1);
  }

  return {
    persona: config.persona!,
    target: config.target!,
    outputDir: config.outputDir!,
    referencesDir: config.referencesDir!,
    strategy: config.strategy || "qwen",
  };
}

// ─── Prompt Assembly ─────────────────────────────────────────────────────────

function assemblePrompt(persona: string, referencesDir: string, targetContent: string): string {
  const personaPromptPath = join(referencesDir, `${persona}.md`);

  if (!existsSync(personaPromptPath)) {
    throw new Error(`Persona prompt not found: ${personaPromptPath}`);
  }

  const personaPrompt = readFileSync(personaPromptPath, "utf-8");

  return `# Code Review Task — ${persona} Persona

${personaPrompt}

---

## Code to Review

Below is the complete diff/code you must analyze. Apply your persona's lens and write your findings to done.json in the current working directory.

\`\`\`
${targetContent}
\`\`\`

## Instructions

1. Read and analyze the code above through your ${persona} lens.
2. Identify findings with severity levels (critical, high, medium, low).
3. Write your results to \`done.json\` in this exact format:

\`\`\`json
{
  "persona": "${persona}",
  "status": "done",
  "findings": [
    {
      "severity": "high",
      "file": "relative/path/from/diff",
      "line": 42,
      "message": "Clear description of the issue",
      "suggestion": "Specific fix suggestion"
    }
  ],
  "verdict": "pass|contest|reject"
}
\`\`\`

4. If you find nothing, write:

\`\`\`json
{
  "persona": "${persona}",
  "status": "done",
  "findings": [],
  "verdict": "pass"
}
\`\`\`

5. ONLY write the JSON to done.json. Do not write anything else.
`;
}

// ─── Strategy: Qwen CLI Headless ─────────────────────────────────────────────

async function executeWithQwen(prompt: string, outputDir: string): Promise<void> {
  // qwen -o json emits a JSON array: [system, assistant, assistant, result]
  // The final element's .result field has the full text output.
  // --yes auto-approves tool calls so the agent can write done.json directly.
  try {
    const result = await Bun.$`qwen --yolo -p ${prompt} -o json`;
    const stdout = result.stdout?.toString() || "";

    // Check if the agent successfully wrote done.json via write_file tool
    const donePath = join(outputDir, "done.json");
    if (existsSync(donePath)) {
      console.log(`[${basename(outputDir)}] done.json written by qwen write_file tool`);
      return;
    }

    // Fallback: parse qwen's text output for done.json
    const extracted = parseQwenJsonOutput(stdout);

    if (!extracted) {
      await generateFallbackFromOutput(outputDir, prompt, "(no output from qwen)");
      return;
    }

    const doneJson = extractDoneJson(extracted);

    if (doneJson) {
      writeFileSync(donePath, JSON.stringify(doneJson, null, 2));
      console.log(`[${basename(outputDir)}] Parsed done.json from qwen text output`);
    } else {
      await generateFallbackFromOutput(outputDir, prompt, extracted);
    }
  } catch (error) {
    console.error(`qwen process error for ${outputDir}:`, error);
    await generateFallbackFromOutput(outputDir, prompt, String(error));
  }
}

/**
 * Parse qwen -o json output (JSON array) and extract the result text.
 */
function parseQwenJsonOutput(raw: string): string | null {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;

    // Look for the result element
    for (const item of arr) {
      if (item.type === "result" && item.result) {
        return String(item.result);
      }
    }

    // Fallback: concatenate all assistant text
    let text = "";
    for (const item of arr) {
      if (item.type === "assistant" && item.message?.content) {
        for (const c of item.message.content) {
          if (c.type === "text") text += c.text;
        }
      }
    }
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Extract a done.json object from raw LLM text output.
 * Looks for ```json ... ``` blocks or raw JSON objects.
 */
function extractDoneJson(text: string): DoneJson | null {
  // Try fenced code block first
  const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    try {
      const json = JSON.parse(fencedMatch[1]);
      if (json.persona && json.status && json.findings !== undefined) {
        return json as DoneJson;
      }
    } catch {
      // Not valid JSON
    }
  }

  // Try raw JSON object
  try {
    const json = JSON.parse(text);
    if (json.persona && json.status && json.findings !== undefined) {
      return json as DoneJson;
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

// ─── Strategy: Generic (in-process LLM call placeholder) ────────────────────

async function executeWithGeneric(prompt: string, outputDir: string): Promise<void> {
  // Placeholder for a generic LLM API call strategy.
  // To implement: call your LLM provider directly, parse JSON response,
  // and write done.json.
  console.warn("Generic strategy not yet implemented — writing placeholder");
  writeFileSync(
    join(outputDir, "done.json"),
    JSON.stringify({
      persona: "generic",
      status: "error",
      findings: [],
      verdict: "contest",
      error: "Generic strategy not implemented",
    } as DoneJson)
  );
}

// ─── Strategy: Claude Code CLI ───────────────────────────────────────────────

async function executeWithClaude(prompt: string, outputDir: string): Promise<void> {
  try {
    // Pass prompt via stdin to avoid unnecessary disk I/O
    const result = await Bun.$`
      claude \
        --print \
        --dangerously-skip-permissions \
        --output ${outputDir} \
        --prompt "Read the prompt from stdin and follow the instructions."
    `.stdin(prompt).quiet();

    const donePath = join(outputDir, "done.json");
    if (!existsSync(donePath)) {
      await generateFallbackFromOutput(outputDir, prompt, result.stdout?.toString() || "");
    }
  } catch (error) {
    console.error(`claude process error for ${outputDir}:`, error);
    await generateFallbackFromOutput(outputDir, prompt, String(error));
  }
}

// ─── Fallback: Parse LLM output and generate done.json ───────────────────────

async function generateFallbackFromOutput(
  outputDir: string,
  prompt: string,
  rawOutput: string
): Promise<void> {
  // If the CLI didn't write done.json directly, try to extract from raw output
  const donePath = join(outputDir, "done.json");

  // If we already have done.json, skip
  if (existsSync(donePath)) return;

  // Try to extract from raw output
  const extracted = extractDoneJson(rawOutput);
  if (extracted) {
    writeFileSync(donePath, JSON.stringify(extracted, null, 2));
    return;
  }

  // Write a minimal placeholder so the orchestrator doesn't hang forever
  const persona = prompt.match(/Code Review Task — (\S+) Persona/)?.[1] ?? "unknown";
  writeFileSync(
    donePath,
    JSON.stringify({
      persona,
      status: "failed",
      findings: [],
      verdict: "contest",
      error: "Agent output could not be parsed — check logs",
      raw_output_snippet: rawOutput?.slice(0, 500),
    } as DoneJson & { raw_output_snippet?: string })
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  // Ensure output directory exists
  mkdirSync(config.outputDir, { recursive: true });

  // Read target content
  let targetContent: string;
  const targetPath = resolve(config.target);

  if (existsSync(targetPath)) {
    targetContent = readFileSync(targetPath, "utf-8");
  } else {
    // Target might be inline content (not a file path)
    targetContent = config.target;
  }

  // Assemble the full prompt
  const prompt = assemblePrompt(config.persona, config.referencesDir, targetContent);

  console.log(`[${config.persona}] Starting review...`);

  // Execute based on strategy
  switch (config.strategy) {
    case "qwen":
      await executeWithQwen(prompt, config.outputDir);
      break;
    case "claude":
      await executeWithClaude(prompt, config.outputDir);
      break;
    case "generic":
      await executeWithGeneric(prompt, config.outputDir);
      break;
    default:
      console.error(`Unknown strategy: ${config.strategy}`);
      writeFileSync(
        join(config.outputDir, "done.json"),
        JSON.stringify({
          persona: config.persona,
          status: "error",
          findings: [],
          verdict: "contest",
        } as DoneJson)
      );
  }

  console.log(`[${config.persona}] Done.`);
}

main().catch((err) => {
  console.error(`Spawn agent failed:`, err);
  // Even on crash, write a done.json so the orchestrator doesn't hang
  const args = parseArgsSafe();
  if (args.outputDir) {
    try {
      writeFileSync(
        join(args.outputDir, "done.json"),
        JSON.stringify({
          persona: args.persona ?? "unknown",
          status: "error",
          findings: [],
          verdict: "contest",
          error: String(err),
        })
      );
    } catch {
      // Best-effort — if we can't even write this, the orchestrator will timeout
    }
  }
  process.exit(1);
});

// Safe arg parsing for error handler (won't throw)
function parseArgsSafe(): Partial<SpawnConfig> {
  const args = process.argv.slice(2);
  const config: Partial<SpawnConfig> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (key && value) {
      config[key as keyof SpawnConfig] = value;
    }
  }
  return config;
}
