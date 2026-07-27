---
name: setup-eval-reviewer
description: Use when adding eval-reviewer's multi-persona code review to a repo that doesn't have it yet, or when checking whether an existing setup is intact. Installs the dependency, symlinks the orchestrator into .sandcastle/, builds the sandbox image, and optionally writes a GitHub Actions workflow. Use when the user says "setup eval-reviewer", "add eval-reviewer to this project", "/setup-eval-reviewer", or when an eval-reviewer run fails because the repo was never wired up.
license: MIT
---

# Setup Eval Reviewer

Wires [`eval-reviewer`](../eval-reviewer/SKILL.md) into the current repo. One command does the work; your job is to run it in the right repo and to relay what it says is still missing.

## The one rule

`scripts/setup.mjs` is the only thing that writes files. Reproducing its steps by hand — creating the symlink yourself, hand-writing the workflow — produces a setup that the next `setup.mjs` run does not recognize.

## Steps

### 1 — Find the installed skill

```bash
ls -d {.,"$HOME"}/{.claude,.agents,.codex,.cursor,.config/agents}/skills/eval-reviewer 2>/dev/null | head -1
```

If that finds nothing, eval-reviewer isn't installed. Install it, then continue:

```bash
npx skills@latest add alysonvilela/skills --skill eval-reviewer
```

**Done when:** you have a path, and `<path>/scripts/setup.mjs` exists.

### 2 — Ask what the repo needs

Two choices change what gets written, and guessing wrong on either is worse than one question:

- **Which agent reviews.** Default is whichever of claude-code, pi, codex, cursor, opencode, copilot already has a credential exported. Pass `--agent NAME` to pick another — the sandbox image is built around one agent's CLI, so this decides what gets built.
- **Whether CI runs it too.** `--workflow` writes `.github/workflows/eval-review.yml`. Skip it for a local-only setup.

Skip the question when the user already said which they want.

### 3 — Run it

```bash
node <path>/scripts/setup.mjs [--agent NAME] [--workflow]
```

Run it from inside the target repo, or pass `--repo PATH`. It installs the one dependency, creates `.sandcastle/`, symlinks `.sandcastle/eval-reviewer.ts` at the orchestrator, writes `.sandcastle/.env.example`, and builds the sandbox image — a couple of minutes the first time, cached forever after. Every step is idempotent.

Useful when the defaults don't fit: `--no-build` (skip the image), `--sandbox podman`, `--force` (replace an existing symlink or workflow), `--no-install`.

**Done when:** the process exited 0.

### 4 — Relay what's left

Setup ends with a `First:` block when something outside its reach is missing. Pass it on rather than summarizing it away:

- **A credential.** Either exported in the shell or written into `.sandcastle/.env` (gitignored; `.env.example` names the variable). Without it the first review fails at preflight, before any sandbox starts.
- **A repository secret**, when `--workflow` ran. The workflow's `env:` block names the variable; it has to exist under that name in Settings → Secrets and variables → Actions.
- **The image**, if the build was skipped or the container runtime was absent.

**Done when:** the user knows which of these are on them.

### 5 — Prove it

```bash
node .sandcastle/eval-reviewer.ts --diff main --personas skeptic
```

One persona against the current branch is the cheapest end-to-end check: it exercises the credential, the sandbox, the worktree, and the report writer. A `PASS` or `CONTESTED` verdict means the setup works. An `INCOMPLETE` carries the reason on the persona's entry in `.eval-reviewer/verdict.json`.

**Done when:** a report exists at `.eval-reviewer/report.md`.

## What lands in the repo

```
.sandcastle/
├── eval-reviewer.ts   -> symlink to the skill's orchestrator
├── .env.example       # names the credential this agent needs
└── .gitignore         # .env, logs/, worktrees/, patches/
.github/workflows/
└── eval-review.yml    # only with --workflow
```

The symlink is relative when the skill lives inside the repo, which makes it survive a commit and resolve on a CI runner. Otherwise it's absolute — good locally, dangling anywhere else, which is why the generated workflow installs the skill on the runner instead of trusting the link.

Nothing is added to the repo's own `.gitignore`, and no dependency is added to its `package.json`: the orchestrator's single dependency lives in the skill directory, installed once per machine and shared by every repo you wire up.
