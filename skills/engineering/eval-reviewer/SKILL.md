---
name: eval-reviewer
description: Multi-agent parallel code review with 6 specialized personas. Spawns independent reviewer agents, waits for completion via file-based hooks, merges findings into a unified report.
---

# Eval Reviewer

Trigger a **multi-agent parallel code review** where 6 specialized personas independently analyze a diff or codebase. Each agent runs in isolation, writes a completion hook (`done.json`), and results are merged into a single verdict.

## When to Use

- User asks for a code review of a PR, diff, or codebase
- User wants adversarial review from multiple perspectives
- User says "review this", "evaluate this code", or runs the CLI directly

## Personas

| Persona | Focus | Catches |
|---------|-------|---------|
| **Skeptic** | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Security** | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

## How to Run

### CLI (automation)
```bash
bun scripts/orchestrator.ts <path-to-diff-or-code>
# Optional: select specific personas
bun scripts/orchestrator.ts <path> --personas skeptic,architect,security
# Optional: timeout per agent in seconds (default: 300)
bun scripts/orchestrator.ts <path> --timeout 600
```

### Inline (interactive)
When the user asks for a review, run the orchestrator with the target file or diff:
```bash
bun scripts/orchestrator.ts /path/to/diff.md
```

## How It Works

1. **Spawn** — Orchestrator launches each persona as an independent agent via the configured spawn strategy (default: `qwen` CLI headless)
2. **Wait** — Orchestrator polls for `done.json` completion hooks in `.eval-reviewer/{persona}/`
3. **Merge** — All findings are deduplicated, ranked by severity, and compiled into a unified report
4. **Verdict** — Output: PASS (all clean), CONTESTED (mixed findings), or REJECT (critical issues)

## Output Format

The orchestrator writes results to:
- `.eval-reviewer/report.md` — Full markdown report with all findings
- `.eval-reviewer/verdict.json` — Structured verdict with severity breakdown

Each agent writes to `.eval-reviewer/{persona}/done.json`:
```json
{
  "persona": "skeptic",
  "status": "done",
  "findings": [
    {
      "severity": "high",
      "file": "src/example.ts",
      "line": 42,
      "message": "Unhandled rejection if cancel() throws",
      "suggestion": "Wrap in try/catch or use .catch()"
    }
  ],
  "verdict": "contest"
}
```

## Reference Files

Persona-specific prompts are in `references/{persona}.md`. Read these to understand what each agent is instructed to look for.
