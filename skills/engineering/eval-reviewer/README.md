# Eval Reviewer

**Multi-agent parallel code review with 6 specialized personas.**

Each persona reviews independently, then a deterministic merge step compiles their findings into a unified report with a clear verdict.

One JSON config file, no setup step, no credential to export. Runs locally or in Docker, with the agent CLI you already have.

## Install

```bash
npx skills@latest add alysonvilela/skills --skill eval-reviewer
```

Then, from the repo you want reviewed:

```bash
bun <skill>/scripts/review.ts
```

That is the whole setup and invocation. With no arguments it reviews the work in progress — uncommitted changes, or a clean tree's branch against its base. The first run auto-installs the one dependency (`@ai-hero/sandcastle`).

Personas are auto-discovered from `references/*.md`. To disable one, move it to `references/_unused/`.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│               filesystem → references/*.md              │
│                    (auto-discovered)                    │
└───────────────────────────────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────┐
│                  review.ts (~190 lines)                │
│                                                       │
│  1. Read eval-reviewer.config.json                    │
│  2. Substitute target into each persona's prompt file │
│  3. Run all personas at once via Sandcastle           │
│  4. Dedup, rank, merge findings                       │
│  5. Write report.md + verdict.json, exit              │
└──────────┬──────────────────────────┬─────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────┐
│   Skeptic ★          │      │   Architect ★        │
│   · Bugs             │      │   · Coupling         │
│   · Race conditions  │      │   · Boundaries       │
│   · Edge cases       │      │   · Scaling          │
│   · Error handling   │      │   · Patterns         │
└──────────────────────┘      └──────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────┐
│   Minimalist         │      │   Security ★         │
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

★ = critical persona. If one fails, the verdict is INCOMPLETE.
```

All six run at once by default (`concurrency`), so the wait is the slowest persona, not the sum of six.

## How it works

1. **Personas** — auto-discovered from `references/*.md`. Each file's frontmatter sets `critical: true|false`.
2. **Configure** — `eval-reviewer.config.json`. The repo's copy wins; fallback to the skill's own.
3. **Run** — [Sandcastle](https://github.com/ai-hero-dev/sandcastle) sends each persona's prompt file to the configured agent (`provider`), locally or in Docker.
4. **Collect** — each persona emits `<review>` JSON. Sandcastle validates and retries on failure.
5. **Merge** — findings are deduplicated, ranked by severity. Plain code, not an LLM.
6. **Verdict** — **PASS**, **CONTESTED**, **REJECT**, or **INCOMPLETE**.

## Configuration

Everything lives in `eval-reviewer.config.json`. Copy [the skill's own](./eval-reviewer.config.json) to a repo's root to override it there. Every field is optional.

| Field | Default | What it decides |
|---|---|---|
| `provider` | `claude-code` | `pi`, `claude-code`, or `codex` — which CLI runs each persona |
| `model` | `claude-sonnet-4-6` | the model string the provider resolves |
| `mode` | `local` | `local` or `docker` |
| `concurrency` | `6` | personas alive at once |
| `idleTimeoutSeconds` | `300` | seconds without output before a persona is stuck |
| `retries` | `2` | re-asks on JSON validation failure |
| `failOn` | `high` | severity that exits non-zero |
| `outDir` | `.eval-reviewer` | where the report lands |

Flags: `--personas`, `--fail-on`, `--config`, `--diff`, `--pr`, `--repo`, `--mode`.

### Credentials

**Local mode**: the script runs the agent CLI on this machine and inherits your shell — whatever authenticates your harness authenticates the review.

**Docker mode**: a container gets none of the host's auth. It carries only what `docker.mounts` and `docker.forwardEnv` specify.

Under CI the mode is forced to `local`: a runner is already a disposable VM.

## Personas

Personas are auto-discovered from `references/*.md`. Each file's frontmatter sets `critical: true/false`:

```markdown
---
critical: true
---
```

| Persona | Critical | Focus | Catches |
|---|---|---|---|
| **Skeptic** | ★ | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** | ★ | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Security** | ★ | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Minimalist** | | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Performance** | | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

**Adding a persona**: drop a `.md` file in `references/` with frontmatter (`critical:`), the agent prompt (use `{{TARGET}}` for the diff), and instruct it to emit `<review>` JSON.

**Disabling a persona**: move it to `references/_unused/`. The runner ignores that directory.

## Usage

```bash
# The work in progress — no arguments
bun <skill>/scripts/review.ts

# Against a base ref
bun <skill>/scripts/review.ts --diff main

# A file, with a subset of personas
bun <skill>/scripts/review.ts /tmp/pr.diff --personas skeptic,architect,security

# Report without gating
bun <skill>/scripts/review.ts --diff main --fail-on never

# In a container
bun <skill>/scripts/review.ts --diff main --mode docker
```

`node` (22.18+) and `npx tsx` work in place of `bun`.

### Exit codes

`0` clean · `1` findings at or above `failOn` · `2` critical findings · `3` incomplete run

## CI

Copy [`workflows/eval-review.yml`](./workflows/eval-review.yml) to `.github/workflows/`. It installs the agent CLI, writes `~/.pi/agent/models.json` from repo variables, reviews the PR diff, posts the report as a PR comment, uploads `.eval-reviewer/` as an artifact, and fails the job at `failOn`.

Key details:
- `fetch-depth: 0` — `git diff` needs both sides present.
- Guard against fork PRs, which get no secrets.

## Output

- **`.eval-reviewer/report.md`** — the full report, and the GitHub job summary when running in Actions
- **`.eval-reviewer/verdict.json`** — the verdict, the severity breakdown, per-persona status, and the merged findings
- **`.eval-reviewer/<persona>/agent.log`** — that persona's full agent transcript

Written into the reviewed repo, in a directory that ignores itself — nothing to add to the repo's `.gitignore`.

```json
{
  "overall": "CONTESTED",
  "breakdown": { "critical": 0, "high": 1, "medium": 2, "low": 0 },
  "agents": {
    "skeptic": { "status": "done", "critical": true, "findings": 2, "verdict": "contest" },
    "performance": { "status": "failed", "critical": false, "findings": 0, "verdict": "contest", "error": "..." }
  },
  "findings": [
    {
      "severity": "high",
      "file": "src/math.js",
      "line": 6,
      "message": "Division by zero returns Infinity with no guard.",
      "suggestion": "Throw a RangeError when b === 0."
    }
  ],
  "target": "git diff main...HEAD",
  "mode": "local",
  "model": "claude-sonnet-4-6",
  "timestamp": "2026-07-27T12:00:00.000Z"
}
```

A `PASS` requires that every selected persona reported. A critical persona failing makes the run `INCOMPLETE`; any persona failing makes an otherwise-empty run `INCOMPLETE` too, because "nothing found" from a partial review is an unknown result, not a clean one. Findings stand on their own either way.

### Sending it somewhere

`verdict.json` carries the merged findings — nothing downstream has to parse markdown.

```bash
curl -X POST "$WEBHOOK" -d @.eval-reviewer/verdict.json
gh pr comment 42 --body-file .eval-reviewer/report.md
jq -e '.breakdown.critical == 0' .eval-reviewer/verdict.json
```

## Requirements

- **Bun**, **Node 22.18+**, or `npx tsx`
- **An agent CLI on PATH** — whichever `provider` names in the config (default: `claude-code`, get a token with `claude setup-token`)
- **Docker**, only for `mode: docker`

## Publish

This skill is indexed on [skills.sh](https://skills.sh). To publish your own version: fork the repo, keep the `SKILL.md` frontmatter (`name`, `description`), make the repository public, and it becomes installable with `npx skills add <your-org>/<repo>`.

## License

MIT
