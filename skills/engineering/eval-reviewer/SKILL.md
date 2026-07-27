---
name: eval-reviewer
description: Use when you want an adversarial code review from multiple independent angles at once. Six personas (skeptic, architect, minimalist, security, performance, test-coverage) each review the same target with no visibility into each other's findings, then a deterministic merge dedupes and ranks them into one report with a PASS/CONTESTED/REJECT/INCOMPLETE verdict. Runs with {{agent}} in {{mode}} mode on your machine or in CI. Use when the user says "review this", "evaluate this code", asks for a second opinion on a diff or PR, or runs the CLI directly.
license: MIT
---

# Eval Reviewer

Six personas review the same target independently and simultaneously — no persona sees another's findings before writing its own, so nothing anchors on anything else. The merge step that follows is plain code, not an LLM: same findings in, same verdict out, every time.

## The one rule

Run it and present what it produces — the personas do the reviewing, you don't.

## Steps

### 1 — Run it

```bash
bun <skill>/scripts/review.ts
```

**Do not ask the user what to review.** With no arguments it reviews the work in progress — uncommitted changes, or, if the tree is clean, this branch against its base. That is what "review this" means mid-task, and the runner picks it without you.

Pass a target only when the user named one:

| They said | You run |
|---|---|
| "review against main" | `--diff main` |
| a GitHub PR | `gh pr diff <url> > /tmp/target.diff` then pass that path |
| a specific file | pass the path |

Never a URL — the runner fetches nothing itself.

`node` (22.18+) and `npx tsx` work in place of `bun`. There is no setup step: the first run auto-installs `@ai-hero/sandcastle`.

All six personas run at once by default (`concurrency`), so the wait is the slowest persona rather than the sum.

**Done when:** the process has exited. Its exit code is the gate: `0`=clean, `1`=findings at or above `failOn`, `2`=critical findings, `3`=incomplete run.

### 2 — Read the output

Written into the reviewed repo: `.eval-reviewer/report.md` and `.eval-reviewer/verdict.json`, with per-persona transcripts at `.eval-reviewer/<persona>/agent.log`. The directory ignores itself, so it never shows up in `git status`.

If a persona failed, both files say so by name and carry the error — `report.md` gets a "Personas That Did Not Report" section, and `verdict.json` puts the message on that persona's entry.

**Done when:** you've read both — the markdown is for the user, the JSON has the structured breakdown you need to reason about the verdict.

### 3 — Present

Show the report to the user. If the verdict is `INCOMPLETE`, say which personas didn't finish *before* anything else.

## Configuration

One file, `eval-reviewer.config.json`. The runner reads the copy in the reviewed repo's root; without one it falls back to the skill's own. Every field is optional.

| Field | Default | What it decides |
|---|---|---|
| `provider` | `pi` | `pi`, `claude-code`, or `codex` — which CLI runs each persona |
| `model` | `lm-studio/gemma-4-e2b-it` | the model string the provider resolves |
| `thinking` | `medium` | `off` … `xhigh` |
| `mode` | `local` | `local` or `docker` |
| `concurrency` | `6` | personas alive at once |
| `idleTimeoutSeconds` | `300` | seconds without output before a persona is stuck |
| `retries` | `2` | re-asks on JSON validation failure |
| `docker.image` | `sandcastle:eval-reviewer` | built on first docker-mode run |
| `docker.mounts` | pi's `auth.json`, `models.json` | files the container reads from the host |
| `docker.forwardEnv` | `OPENAI_API_KEY` | env vars copied into the container |
| `personas` | all six | `name` matches `references/<name>.md` |
| `failOn` | `high` | severity that exits non-zero |
| `outDir` | `.eval-reviewer` | where the report lands |

### Credentials

In `local` mode the script runs the agent CLI on this machine and inherits your shell, so whatever authenticates your harness authenticates the review.

In `docker` mode the container gets none of that — it carries only what `docker.mounts` and `docker.forwardEnv` specify. Mount the *files* the agent reads (not the directory it writes sessions into), and set `docker.forwardEnv` to the environment variables it needs.

Under CI the mode is forced to `local`: a runner is already a disposable VM.

## Personas (prompts in `references/`)

| Persona | Focus | Catches |
|---|---|---|
| **Skeptic** ★ | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** ★ | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Security** ★ | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

★ marks a persona the review can't be trusted without.

**Each file in `references/` is the prompt, sent as written.** `{{TARGET}}` is where the reviewed code lands. Nothing wraps it, so changing what a persona looks for is an edit to that one file — and adding a persona is a new file plus one line in `personas`.

## Report

`report.md`: a verdict line, a severity-count table, an agent-status table, a failure section when any persona didn't report, then findings grouped and sorted by severity.

`verdict.json`:
```json
{
  "overall": "PASS|CONTESTED|REJECT|INCOMPLETE",
  "breakdown": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "agents": {
    "skeptic": { "status": "done", "critical": true, "findings": 2, "verdict": "contest" }
  },
  "findings": [...],
  "target": "git diff main...HEAD",
  "model": "lm-studio/gemma-4-e2b-it",
  "timestamp": "..."
}
```

`PASS` requires that every selected persona reported. A star persona failing makes the run `INCOMPLETE`; any persona failing makes an otherwise-empty run `INCOMPLETE` too.
