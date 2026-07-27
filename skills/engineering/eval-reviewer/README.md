# Eval Reviewer

**Multi-agent parallel code review with 6 specialized personas.**

Spawn independent reviewer agents, wait for completion via file-based hooks, and merge findings into a unified report with a clear verdict.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                           │
│                                                             │
│  1. Setup workspace per persona                             │
│  2. Spawn agents (max 4 concurrent)                         │
│  3. Poll for done.json completion hooks                     │
│  4. Deduplicate, rank, and merge findings                   │
│  5. Generate report.md + verdict.json                       │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────┐
│   Skeptic            │      │   Architect          │
│   · Bugs             │      │   · Coupling         │
│   · Race conditions  │      │   · Boundaries       │
│   · Edge cases       │      │   · Scaling          │
│   · Error handling   │      │   · Patterns         │
└──────────────────────┘      └──────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────┐
│   Minimalist         │      │   Security           │
│   · Over-engineering │      │   · Data exposure    │
│   · Dead code        │      │   · Injection        │
│   · Premature abs.   │      │   · Secrets          │
│   · Unnecessary deps │      │   · Permissions      │
└──────────────────────┘      └──────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────┐
│   Performance        │      │   Test Coverage      │
│   · Blocking calls   │      │   · Missing cases    │
│   · N+1 queries      │      │   · Weak assertions  │
│   · Memory leaks     │      │   · Flaky tests      │
│   · Algorithmic cost │      │   · Mock abuse       │
└──────────────────────┘      └──────────────────────┘
           │                              │
           └──────────────┬───────────────┘
                          ▼
                ┌───────────────────┐
                │   Merge Results   │
                │                   │
                │  PASS / CONTESTED │
                │  / REJECT         │
                └───────────────────┘
```

## How It Works

1. **Spawn** — The orchestrator launches each persona as an independent agent via `qwen` CLI in headless mode
2. **Wait** — Orchestrator polls for `done.json` completion hooks in `.eval-reviewer/{persona}/`
3. **Merge** — All findings are deduplicated, ranked by severity, and compiled into a unified report
4. **Verdict** — Output: **PASS** (all clean), **CONTESTED** (mixed findings), or **REJECT** (critical issues)

## Personas

| Persona | Focus | Catches |
|---------|-------|---------|
| **Skeptic** | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Security** | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

## Usage

### CLI

```bash
# Review a diff or codebase with all 6 personas
bun scripts/orchestrator.ts /path/to/diff.md

# Review with specific personas only
bun scripts/orchestrator.ts /path/to/diff.md --personas skeptic,architect,security

# Custom timeout per agent (default: 300s)
bun scripts/orchestrator.ts /path/to/diff.md --timeout 600

# Use a different spawn strategy
bun scripts/orchestrator.ts /path/to/diff.md --strategy claude
```

### NPM Scripts

```bash
npm run review              # All personas
npm run review:quick        # Reduced timeout (120s)
npm run review:skeptic      # Skeptic only
npm run review:core         # Skeptic + Architect + Minimalist
npm run review:security     # Security only
```

## Output

The orchestrator generates:

- **`.eval-reviewer/report.md`** — Full markdown report with all findings
- **`.eval-reviewer/verdict.json`** — Structured verdict with severity breakdown

Each agent writes to **`.eval-reviewer/{persona}/done.json`**:

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

## Install

This skill is available on [skills.sh](https://skills.sh). Install it with:

```bash
npx skills add <owner>/eval-reviewer
```

## Publish

To publish your own version of this skill:

1. Fork or copy this repository to your own GitHub account
2. Ensure the `SKILL.md` file has the required frontmatter:
   ```yaml
   ---
   name: eval-reviewer
   description: Multi-agent parallel code review with 6 specialized personas.
   ---
   ```
3. Make the repository public — [skills.sh](https://skills.sh) automatically indexes public repos
4. Others can install it via: `npx skills add <your-github-org>/eval-reviewer`

## Requirements

- [Bun](https://bun.sh/) runtime
- [Qwen Code](https://github.com/nicholasgriffintn/qwen) CLI (default spawn strategy)

## License

MIT
