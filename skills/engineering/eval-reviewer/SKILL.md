---
name: eval-reviewer
description: Use when you want an adversarial code review from multiple independent angles at once. Six personas (skeptic, architect, minimalist, security, performance, test-coverage) each run in an isolated subprocess with no visibility into each other's findings, then a deterministic merge step dedupes and ranks them into one report with a PASS/CONTESTED/REJECT/INCOMPLETE verdict. Use when the user says "review this", "evaluate this code", asks for a second opinion on a diff or PR, or runs the CLI directly.
license: MIT
---

# Eval Reviewer

Six personas review the same diff independently and simultaneously — no persona sees another's findings before writing its own, so nothing anchors on anything else. The merge step that follows is plain code, not an LLM: same findings in, same verdict out, every time.

## The one rule

You run the orchestrator and present what it produces. You do not review the code yourself — that's what the six subprocess personas are for — and you do not hand-edit `scripts/orchestrator.ts` or `scripts/spawn-agent.ts` mid-task to route around a problem. If the tool misbehaves, that's a bug to report, not a patch to make silently.

## Steps

### 1 — Get the target onto disk

The orchestrator takes a **file path** (or literal inline text passed as the argument) — never a URL, and it does not fetch anything itself.

- Local diff: `git diff main...HEAD > /tmp/eval-review-target.md`
- GitHub PR: `gh pr diff <url> > /tmp/eval-review-target.md`
- Existing file or codebase: pass the path directly

**Done when:** you have a path to the complete diff or code — not a summary of it.

### 2 — Run the orchestrator

```bash
bun scripts/orchestrator.ts <target> [--personas a,b,c] [--timeout 300] [--strategy qwen]
```

Defaults: all 6 personas, 300s timeout each, `qwen` CLI headless. Only `qwen` and `claude` are implemented — `generic` is an unfinished stub that always writes an error result, don't select it.

Personas launch in batches of 4 concurrent, and the orchestrator waits for each batch to fully exit before starting the next — with all 6 selected, that's two sequential batches, not one instant fan-out of six. Budget wait time accordingly.

Both spawn strategies run the reviewer CLI in an auto-approve mode (`qwen --yolo`, `claude --dangerously-skip-permissions`). The persona prompt instructs "review only, never edit" but nothing at the process level enforces that — don't point this at a target you wouldn't hand to an unsupervised agent.

**Done when:** the process has exited. Its exit code is the verdict: `0`=PASS, `1`=CONTESTED, `2`=REJECT, `3`=INCOMPLETE.

### 3 — Read the output

Written inside **this skill's own directory**, not the target repo: `.eval-reviewer/report.md` and `.eval-reviewer/verdict.json`, sitting next to `scripts/`. If a persona timed out, `verdict.json`'s `agents` map shows which one and that its `status` isn't `"done"`.

**Done when:** you've read both — the markdown is for the user, the JSON has the structured breakdown you need to reason about the verdict.

### 4 — Present

Show the report to the user. If the verdict is `INCOMPLETE`, say which personas didn't finish *before* anything else — an `INCOMPLETE` that reads like a clean `REJECT` is a different claim than one with full coverage, and whoever reads it needs to know which they're getting.

## Personas (references in `references/`)

| Persona | Focus | Catches |
|---|---|---|
| **Skeptic** | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Security** | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

`skeptic`, `architect`, and `security` are the critical personas — if any of those three time out, the verdict is forced to `INCOMPLETE` regardless of what the others found.

## Report

`report.md`: a verdict line, a severity-count table, an agent-status table (persona / status / finding count / that persona's own verdict), then findings grouped and sorted by severity.

`verdict.json`:
```json
{
  "overall": "PASS|CONTESTED|REJECT|INCOMPLETE",
  "breakdown": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "agents": { "skeptic": { "status": "done", "findings": 2, "verdict": "contest" } },
  "target": "...",
  "timestamp": "..."
}
```
