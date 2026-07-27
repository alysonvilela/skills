---
name: eval-reviewer
description: Use when you want an adversarial code review from multiple independent angles at once. Six personas (skeptic, architect, minimalist, security, performance, test-coverage) each review in their own sandbox with no visibility into each other's findings, then a deterministic merge step dedupes and ranks them into one report with a PASS/CONTESTED/REJECT/INCOMPLETE verdict. Runs from any agent CLI or from GitHub Actions. Use when the user says "review this", "evaluate this code", asks for a second opinion on a diff or PR, or runs the CLI directly.
license: MIT
---

# Eval Reviewer

Six personas review the same diff independently and simultaneously — no persona sees another's findings before writing its own, so nothing anchors on anything else. Each runs in its own sandbox on its own git branch. The merge step that follows is plain code, not an LLM: same findings in, same verdict out, every time.

## The one rule

Run the orchestrator and present what it produces — the sandboxed personas do the reviewing, you don't. If the tool misbehaves mid-task, report it as a bug; hand-editing `scripts/orchestrator.ts` to route around the problem hides the failure instead of surfacing it.

## Steps

### 1 — Set the repo up, once

```bash
node <skill>/scripts/setup.mjs
```

Installs the one dependency, symlinks the orchestrator into the target repo as `.sandcastle/eval-reviewer.ts`, and builds the sandbox image. Everything it does is idempotent, so re-running it is how you check the setup rather than a thing to avoid. Add `--workflow` for a GitHub Actions workflow, `--agent NAME` to review with something other than the agent whose credential is already exported.

Its closing output names what is still missing — usually a credential. Read it and act on it.

**Done when:** `.sandcastle/eval-reviewer.ts` resolves, and setup printed no remaining "First:" items.

### 2 — Get the target onto disk

The orchestrator takes a **file path**, literal text, or `--diff <base-ref>` — never a URL, and it fetches nothing itself.

- Local branch: `--diff main` (it runs `git diff main...HEAD` for you)
- GitHub PR: `gh pr diff <url> > /tmp/eval-review-target.md`
- Existing file or codebase: pass the path

The target's full text is embedded in each persona's prompt, so the review covers it even though the sandbox worktree is branched from `HEAD` and won't contain uncommitted changes.

**Done when:** you have a path, or a base ref — not a summary of the change.

### 3 — Run it

```bash
node .sandcastle/eval-reviewer.ts --diff main
node .sandcastle/eval-reviewer.ts /tmp/eval-review-target.md --personas skeptic,security
```

`bun` and `npx tsx` run it equally well; use whichever the repo already uses. Everything tunable is an environment variable with a `--flag` twin — `node .sandcastle/eval-reviewer.ts --help` prints the full list. There is no config file.

Personas run in batches of `--concurrency` (default 3), each a full agent run in its own sandbox. Budget the wait: six personas at concurrency 3 is two sequential batches.

**Done when:** the process has exited. Its exit code is the gate: `0`=clean, `1`=findings at or above `--fail-on`, `2`=critical findings, `3`=incomplete run.

### 4 — Read the output

Written into the reviewed repo: `.eval-reviewer/report.md` and `.eval-reviewer/verdict.json`, with per-persona transcripts at `.eval-reviewer/<persona>/agent.log`. The directory ignores itself, so it never shows up in `git status`.

If a persona failed, both files say so by name and carry the error — `report.md` gets a "Personas That Did Not Report" section, and `verdict.json` puts the message on that persona's entry.

**Done when:** you've read both — the markdown is for the user, the JSON has the structured breakdown you need to reason about the verdict.

### 5 — Present

Show the report to the user. If the verdict is `INCOMPLETE`, say which personas didn't finish *before* anything else — an `INCOMPLETE` that reads like a clean run is a different claim than one with full coverage, and whoever reads it needs to know which they're getting.

## Configuration

Environment variables, each with a flag that overrides it. The defaults are chosen so that exporting one credential is enough.

| Variable | Flag | Default |
|---|---|---|
| `EVAL_AGENT` | `--agent` | the first of claude-code, pi, codex, cursor, opencode, copilot whose credential is set |
| `EVAL_MODEL` | `--model` | that agent's own default |
| `EVAL_EFFORT` | `--effort` | `medium` |
| `EVAL_SANDBOX` | `--sandbox` | `docker` locally, `none` when `CI` is set |
| `EVAL_IMAGE` | `--image` | `sandcastle:eval-reviewer-<agent>` |
| `EVAL_PERSONAS` | `--personas` | all six |
| `EVAL_CONCURRENCY` | `--concurrency` | `3` |
| `EVAL_IDLE_TIMEOUT` | `--timeout` | `600` seconds without agent output |
| `EVAL_RETRIES` | `--retries` | `2` re-asks when a persona's output fails validation |
| `EVAL_FAIL_ON` | `--fail-on` | `high` — the severity that makes the exit code non-zero |
| `EVAL_OUT` | `--out` | `<repo>/.eval-reviewer` |
| `EVAL_REPO` | `--repo` | git root above the working directory |

Credentials are read from the shell first, then from `<repo>/.sandcastle/.env`. They are forwarded into the sandbox at launch and never written anywhere.

## CI

`scripts/setup.mjs --workflow` writes `.github/workflows/eval-review.yml`: it installs the skill on the runner, runs the six personas against `git diff <base>...HEAD`, puts the report in the job summary, uploads `.eval-reviewer/` as an artifact, and fails the job at `EVAL_FAIL_ON`. Add the credential as a repository secret under the name the workflow's `env:` block references.

The workflow sets `EVAL_SANDBOX=none`: an Actions runner is already a disposable VM, so a container inside it would only add an image build to every run. On a developer's own machine the container is the boundary, and `docker` stays the default.

## Personas (prompts in `references/`)

| Persona | Focus | Catches |
|---|---|---|
| **Skeptic** ★ | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** ★ | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Security** ★ | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

★ marks a persona the review can't be trusted without. Adding a persona is a `references/<name>.md` prompt plus one line in the `PERSONAS` list at the top of `scripts/orchestrator.ts`.

## Report

`report.md`: a verdict line, a severity-count table, an agent-status table (persona / critical / status / finding count / that persona's own verdict), a failure section when any persona didn't report, then findings grouped and sorted by severity.

`verdict.json`:
```json
{
  "overall": "PASS|CONTESTED|REJECT|INCOMPLETE",
  "breakdown": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "agents": {
    "skeptic": { "status": "done", "critical": true, "findings": 2, "verdict": "contest" }
  },
  "target": "git diff main...HEAD",
  "agent": "claude-code",
  "model": "claude-sonnet-4-6",
  "sandbox": "docker",
  "timestamp": "..."
}
```

`PASS` requires that every selected persona reported. A star persona failing makes the run `INCOMPLETE`; any persona failing makes an otherwise-empty run `INCOMPLETE` too, because "nothing found" from a partial review is an unknown result rather than a clean one. Findings stand on their own either way.
