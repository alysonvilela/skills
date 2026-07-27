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
                │ PASS / CONTESTED  │
                │ / REJECT /        │
                │ INCOMPLETE        │
                └───────────────────┘
```

Personas launch in batches of 4 concurrent (`MAX_CONCURRENT_AGENTS`); with all 6 selected that's two sequential batches, each fully awaited before the next starts — not one instant fan-out of six.

## How It Works

1. **Spawn** — The orchestrator launches each persona as an independent subprocess via the configured spawn strategy (default: `qwen` CLI headless, auto-approving with `--yolo`; `claude` with `--dangerously-skip-permissions` is the other implemented option — `generic` is an unfinished stub that always errors)
2. **Wait** — Orchestrator polls for `done.json` completion hooks in `.eval-reviewer/{persona}/`, relative to the skill's own directory, not the reviewed repo
3. **Merge** — All findings are deduplicated, ranked by severity, and compiled into a unified report — this step is plain code, not an LLM call
4. **Verdict** — **PASS** (all clean), **CONTESTED** (mixed findings), **REJECT** (critical issues), or **INCOMPLETE** (a critical persona — skeptic, architect, or security — timed out)

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
npm run review -- /path/to/diff.md              # All personas
npm run review:quick -- /path/to/diff.md        # Reduced timeout (120s)
npm run review:skeptic -- /path/to/diff.md      # Skeptic only
npm run review:core -- /path/to/diff.md         # Skeptic + Architect + Minimalist
npm run review:security -- /path/to/diff.md     # Security only
```

None of these scripts bake in a target — the `--` is required, or the orchestrator exits immediately on a missing-argument usage error.

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
- [Qwen Code](https://github.com/nicholasgriffintn/qwen) CLI (default spawn strategy), or the `claude` CLI for `--strategy claude`
- `gh` CLI if you're feeding it a GitHub PR — the orchestrator only accepts a local file path or inline text, it doesn't fetch URLs itself

Both spawn strategies run the reviewer CLI with permission checks off (`qwen --yolo`, `claude --dangerously-skip-permissions`). The persona prompts are reviewer-only by instruction, not by sandboxing.

## License

MIT
