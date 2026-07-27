#!/usr/bin/env node
/**
 * setup — wires eval-reviewer into a repo.
 *
 * Plain ESM with no dependencies on purpose: this is the script that installs
 * the dependencies, so it has to run before any of them exist, under whatever
 * runtime the machine happens to have.
 *
 * What it does, all of it idempotent:
 *   1. installs the skill's single dependency, once per machine
 *   2. creates <repo>/.sandcastle/ and its .gitignore
 *   3. symlinks <repo>/.sandcastle/eval-reviewer.ts at the orchestrator
 *   4. writes .sandcastle/.env.example naming the credential the agent needs
 *   5. builds the sandbox image if the container runtime is there and it isn't
 *
 * Usage: setup.mjs [options]
 *   --repo PATH     repo to wire up (default: git root of cwd)
 *   --agent NAME    claude-code | pi | codex | cursor | opencode | copilot
 *   --sandbox NAME  docker | podman | none   (default: docker)
 *   --workflow      also write .github/workflows/eval-review.yml
 *   --no-build      skip the sandbox image build
 *   --no-install    skip the dependency install
 *   --force         overwrite an existing symlink target or workflow file
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = {
  "claude-code": {
    npmPackage: "@anthropic-ai/claude-code",
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
    alsoAccepts: ["ANTHROPIC_API_KEY"],
    hint: "run `claude setup-token` on this machine to mint one",
  },
  pi: {
    npmPackage: "@mariozechner/pi-coding-agent",
    credential: "ANTHROPIC_API_KEY",
    alsoAccepts: ["OPENAI_API_KEY"],
    hint: "an Anthropic API key",
  },
  codex: {
    npmPackage: "@openai/codex",
    credential: "OPENAI_KEY",
    alsoAccepts: ["OPENAI_API_KEY"],
    hint: "an OpenAI API key",
  },
  cursor: {
    npmPackage: "cursor-agent",
    credential: "CURSOR_API_KEY",
    alsoAccepts: [],
    hint: "a Cursor API key",
  },
  opencode: {
    npmPackage: "opencode-ai",
    credential: "OPENCODE_API_KEY",
    alsoAccepts: [],
    hint: "an OpenCode API key",
  },
  copilot: {
    npmPackage: "@github/copilot",
    credential: "GITHUB_TOKEN",
    alsoAccepts: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN"],
    hint: 'a token with the "Copilot Requests" permission',
  },
};

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message, ...detail) {
  console.error(`setup: ${message}`);
  for (const line of detail) {
    if (line) console.error(`  ${line}`);
  }
  process.exit(1);
}

function onPath(binary) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [binary], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const USAGE = `setup — wire eval-reviewer into a repo

Usage: setup.mjs [options]
  --repo PATH     repo to wire up (default: git root of cwd)
  --agent NAME    ${Object.keys(AGENTS).join(" | ")}
                  (default: the one whose credential is already exported)
  --sandbox NAME  docker | podman | none   (default: docker)
  --workflow      also write .github/workflows/eval-review.yml
  --no-build      skip the sandbox image build
  --no-install    skip the dependency install
  --force         replace an existing symlink or workflow file
  --help

Everything it does is idempotent — re-run it to check a setup.`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith("--")) fail(`unexpected argument "${arg}".`);
    const separator = arg.indexOf("=");
    if (separator !== -1) {
      flags[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key = arg.slice(2);
    // --no-build / --no-install turn the matching step off.
    if (key.startsWith("no-")) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

/** Pick the agent whose credential is already exported, else claude-code. */
function detectAgent() {
  for (const [name, spec] of Object.entries(AGENTS)) {
    const keys = [spec.credential, ...spec.alsoAccepts];
    if (keys.some((key) => process.env[key])) return name;
  }
  return "claude-code";
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function resolveRepo(explicit) {
  if (explicit && explicit !== true) {
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
      "not inside a git repository.",
      "Each persona reviews in a git worktree, so eval-reviewer needs one.",
      "Run this from the repo you want to review, or pass --repo PATH."
    );
  }
}

function installDependencies() {
  if (existsSync(join(skillRoot, "node_modules", "@ai-hero", "sandcastle"))) {
    console.log("  · dependencies already installed");
    return;
  }

  const [command, args] = onPath("bun")
    ? ["bun", ["install"]]
    : ["npm", ["install", "--omit=dev", "--no-fund", "--no-audit"]];

  console.log(`  · installing the skill's dependency with ${command}`);
  const result = spawnSync(command, args, {
    cwd: skillRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed in ${skillRoot}.`,
      "Install it by hand, then re-run setup."
    );
  }
}

/** Merge our ignores into .sandcastle/.gitignore without dropping what's there. */
function writeSandcastleGitignore(sandcastleDir) {
  const path = join(sandcastleDir, ".gitignore");
  const required = [".env", "logs/", "worktrees/", "patches/"];
  const existing = existsSync(path)
    ? readFileSync(path, "utf-8").split("\n")
    : [];
  const missing = required.filter((line) => !existing.includes(line));

  if (missing.length === 0) return;

  const kept = (existing.length > 0 ? existing : ["# Sandcastle run artifacts"])
    .join("\n")
    .replace(/\n+$/, "");
  writeFileSync(path, `${kept}\n${missing.join("\n")}\n`);
}

/**
 * Symlink rather than copy, so every repo on the machine runs the same
 * orchestrator and an updated skill needs no re-setup.
 *
 * Relative when the skill lives inside the repo — that link survives a commit
 * and resolves on a CI runner. Absolute otherwise, which is a local-only link;
 * the generated workflow installs the skill itself rather than trusting it.
 */
function linkOrchestrator(repo, sandcastleDir, force) {
  const link = join(sandcastleDir, "eval-reviewer.ts");
  const orchestrator = join(skillRoot, "scripts", "orchestrator.ts");
  const inRepo = !relative(repo, skillRoot).startsWith("..");
  const target = inRepo
    ? relative(sandcastleDir, orchestrator)
    : orchestrator;

  let existing;
  try {
    existing = lstatSync(link);
  } catch {
    existing = undefined;
  }

  if (existing) {
    if (!existing.isSymbolicLink() && !force) {
      fail(
        `${link} exists and is not a symlink.`,
        "Move it aside, or re-run with --force to replace it."
      );
    }
    if (existing.isSymbolicLink() && readlinkSync(link) === target) {
      console.log(`  · symlink already points at the orchestrator`);
      return { link, inRepo };
    }
    rmSync(link);
  }

  symlinkSync(target, link);
  console.log(`  · linked .sandcastle/eval-reviewer.ts -> ${target}`);
  return { link, inRepo };
}

function writeEnvExample(sandcastleDir, agentName) {
  const spec = AGENTS[agentName];
  const path = join(sandcastleDir, ".env.example");
  const accepted = [spec.credential, ...spec.alsoAccepts].join(" or ");

  writeFileSync(
    path,
    [
      `# Credential for ${agentName} — ${spec.hint}.`,
      `# eval-reviewer reads it from your shell environment first, then from`,
      `# .sandcastle/.env (this file's untracked sibling). Accepted: ${accepted}.`,
      `${spec.credential}=`,
      "",
    ].join("\n")
  );
}

function imageExists(runtime, image) {
  if (!onPath(runtime)) return false;
  try {
    execFileSync(runtime, ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function buildImage(runtime, image, agentName) {
  if (!onPath(runtime)) {
    console.log(
      `  · ${runtime} is not on PATH — skipping the image build (install it, or review with --sandbox none)`
    );
    return false;
  }

  if (imageExists(runtime, image)) {
    console.log(`  · sandbox image ${image} already built`);
    return true;
  }

  console.log(`  · building ${image} (one time, a couple of minutes)`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;

  const result = spawnSync(
    runtime,
    [
      "build",
      "-t",
      image,
      "--build-arg",
      `AGENT_NPM_PACKAGE=${AGENTS[agentName].npmPackage}`,
      "--build-arg",
      `AGENT_UID=${uid}`,
      "--build-arg",
      `AGENT_GID=${gid}`,
      join(skillRoot, "docker"),
    ],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    console.log(
      `  · image build failed — reviews will need --sandbox none until it succeeds`
    );
    return false;
  }

  return true;
}

function writeWorkflow(repo, agentName, force) {
  const template = join(skillRoot, "workflows", "eval-review.yml");
  if (!existsSync(template)) fail(`workflow template not found: ${template}`);

  const destination = join(repo, ".github", "workflows", "eval-review.yml");
  if (existsSync(destination) && !force) {
    console.log(
      `  · ${relative(repo, destination)} already exists — left alone (--force to replace)`
    );
    return destination;
  }

  const spec = AGENTS[agentName];
  const contents = readFileSync(template, "utf-8")
    .replaceAll("{{AGENT}}", agentName)
    .replaceAll("{{AGENT_NPM_PACKAGE}}", spec.npmPackage)
    .replaceAll("{{CREDENTIAL}}", spec.credential);

  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  console.log(`  · wrote ${relative(repo, destination)}`);
  return destination;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const flags = parseArgs(process.argv.slice(2));

const agentName = flags.agent === undefined ? detectAgent() : String(flags.agent);
if (!AGENTS[agentName]) {
  fail(
    `unknown agent "${agentName}".`,
    `Available: ${Object.keys(AGENTS).join(", ")}.`
  );
}

const sandboxName = flags.sandbox === undefined ? "docker" : String(flags.sandbox);
if (!["docker", "podman", "none"].includes(sandboxName)) {
  fail(`--sandbox must be docker, podman, or none — got "${sandboxName}".`);
}

const repo = resolveRepo(flags.repo);
const sandcastleDir = join(repo, ".sandcastle");
const image = `sandcastle:eval-reviewer-${agentName}`;

console.log(`\n  eval-reviewer setup`);
console.log(`  Skill: ${skillRoot}`);
console.log(`  Repo:  ${repo}`);
console.log(`  Agent: ${agentName}\n`);

if (flags.install !== false) installDependencies();

mkdirSync(sandcastleDir, { recursive: true });
writeSandcastleGitignore(sandcastleDir);
const { inRepo } = linkOrchestrator(repo, sandcastleDir, flags.force === true);
writeEnvExample(sandcastleDir, agentName);

const imageReady =
  sandboxName === "none"
    ? false
    : flags.build === false
      ? imageExists(sandboxName, image)
      : buildImage(sandboxName, image, agentName);

if (flags.workflow) writeWorkflow(repo, agentName, flags.force === true);

// ─── What is left for the human ──────────────────────────────────────────────

const spec = AGENTS[agentName];
const envFile = join(sandcastleDir, ".env");
const envFileContents = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";
const credentialSet = [spec.credential, ...spec.alsoAccepts].some(
  (key) =>
    process.env[key] ||
    new RegExp(`^${key}=.+$`, "m").test(envFileContents)
);
const runner = onPath("bun") ? "bun" : "node";
const next = [];

if (!credentialSet) {
  next.push(
    `export ${spec.credential}=... — ${spec.hint}`,
    `  (or copy .sandcastle/.env.example to .sandcastle/.env and fill it in)`
  );
}

if (sandboxName !== "none" && !imageReady) {
  next.push(
    `build the sandbox image: node ${join(skillRoot, "scripts", "setup.mjs")} --build --agent ${agentName}`
  );
}

if (!inRepo) {
  next.push(
    `the symlink is absolute (the skill lives outside this repo), so it works here but not on a CI runner`,
    `  — the generated workflow installs the skill itself, so CI is unaffected`
  );
}

console.log(`\n  Review with:`);
console.log(`    ${runner} .sandcastle/eval-reviewer.ts --diff main`);
console.log(`    ${runner} .sandcastle/eval-reviewer.ts path/to/diff.md`);

if (next.length > 0) {
  console.log(`\n  First:`);
  for (const line of next) console.log(`    ${line}`);
}

if (!flags.workflow) {
  console.log(
    `\n  For CI: re-run with --workflow to write .github/workflows/eval-review.yml`
  );
}

console.log("");
