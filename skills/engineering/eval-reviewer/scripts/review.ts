#!/usr/bin/env node
/**
 * eval-reviewer entry point.
 *
 * Its only job is making sure the skill's dependencies exist before the
 * orchestrator's imports need them — that is what makes "clone the skill and
 * run it" true, with no setup step to forget. Everything else is in
 * orchestrator.ts.
 *
 *   bun scripts/review.ts --diff main
 *   node scripts/review.ts --diff main     (node 22.18+, native type stripping)
 *   npx tsx scripts/review.ts --diff main
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

if (!existsSync(join(skillRoot, "node_modules", "@ai-hero", "sandcastle"))) {
  const [command, args] = onPath("bun")
    ? (["bun", ["install"]] as const)
    : (["npm", ["install", "--omit=dev", "--no-fund", "--no-audit"]] as const);

  console.log(`  installing eval-reviewer's dependencies with ${command}…`);
  const result = spawnSync(command, [...args], {
    cwd: skillRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.error(
      `eval-reviewer: ${command} install failed in ${skillRoot}.\n` +
        `  Run it there by hand, then try again.`
    );
    process.exit(1);
  }
}

await import("./orchestrator.ts");
