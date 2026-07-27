---
name: eval-reviewer
description: Use when you want an adversarial code review from multiple independent angles at once. Six personas (skeptic, architect, minimalist, security, performance, test-coverage) each review in their own sandboxed container with no visibility into each other's findings, then a deterministic merge step dedupes and ranks them into one report with a PASS/CONTESTED/REJECT/INCOMPLETE verdict. Use when the user says "review this", "evaluate this code", asks for a second opinion on a diff or PR, or runs the CLI directly.
license: MIT
---

# Eval Reviewer

Six personas review the same diff independently and simultaneously — no persona sees another's findings before writing its own, so nothing anchors on anything else. Each runs in its own container on its own git branch. The merge step that follows is plain code, not an LLM: same findings in, same verdict out, every time.

## The one rule

Run the orchestrator and present what it produces — the sandboxed personas do the reviewing, you don't. If the tool misbehaves mid-task, report it as a bug; hand-editing `scripts/orchestrator.ts` to route around the problem hides the failure instead of surfacing it.

## Steps

### 1 — Check the prerequisites

The orchestrator needs Docker running, the `pi` CLI installed, and the sandbox image built once per repo:

```bash
npx @ai-hero/sandcastle init   # builds the image, scaffolds .sandcastle/
```

**Done when:** `docker info` succeeds and the image named in `references/config.yaml` exists.

### 2 — Get the target onto disk

The orchestrator takes a **file path** (or literal inline text as the argument) — never a URL, and it does not fetch anything itself.

- Local diff: `git diff main...HEAD > /tmp/eval-review-target.md`
- GitHub PR: `gh pr diff <url> > /tmp/eval-review-target.md`
- Existing file or codebase: pass the path directly

The target's full text is embedded in each persona's prompt, so the review covers it even though the sandbox worktree is branched from `HEAD` and won't contain uncommitted changes.

**Done when:** you have a path to the complete diff or code — not a summary of it.

### 3 — Run the orchestrator

```bash
bun scripts/orchestrator.ts <target> [--personas a,b,c] [--config PATH] [--repo PATH]
```

Everything else — which agent, which model, which sandbox, credentials, concurrency, timeouts, and which personas are load-bearing — lives in `references/config.yaml`. Change behaviour there, not with flags.

Each persona reviews in a git worktree, so the run needs a repo: `--repo` defaults to the git root above your working directory. Credentials reach the container through `agent.forwardEnv` in the config, which names environment variables to forward from your shell — a name listed there but unset aborts the run before any container starts.

Personas run in batches of `review.maxConcurrent` (default 3), each in its own container on its own branch. Budget wait time accordingly: six personas at concurrency 3 is two sequential batches of full agent runs.

**Done when:** the process has exited. Its exit code is the verdict: `0`=PASS, `1`=CONTESTED, `2`=REJECT, `3`=INCOMPLETE.

### 4 — Read the output

Written inside **this skill's own directory**, not the target repo: `.eval-reviewer/report.md` and `.eval-reviewer/verdict.json`, sitting next to `scripts/`. Per-persona agent logs are at `.eval-reviewer/<persona>/agent.log`.

If a persona failed, both files say so by name and carry the error — `report.md` gets a "Personas That Did Not Report" section, and `verdict.json` puts the message on that persona's entry.

**Done when:** you've read both — the markdown is for the user, the JSON has the structured breakdown you need to reason about the verdict.

### 5 — Present

Show the report to the user. If the verdict is `INCOMPLETE`, say which personas didn't finish *before* anything else — an `INCOMPLETE` that reads like a clean `REJECT` is a different claim than one with full coverage, and whoever reads it needs to know which they're getting.

## Personas (prompts in `references/`, roster in `references/config.yaml`)

| Persona | Focus | Catches |
|---|---|---|
| **Skeptic** | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Security** | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

Personas marked `critical: true` in the config — skeptic, architect, security by default — are the ones the review can't be trusted without. If any of them fails, the verdict is `INCOMPLETE` regardless of what the others found.

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
  "target": "...",
  "timestamp": "..."
}
```
