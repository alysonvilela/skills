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

## Architecture

```
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

1. **Configure** — `eval-reviewer.config.json`. The repo's copy wins; fallback to the skill's own.
2. **Run** — [Sandcastle](https://github.com/ai-hero-dev/sandcastle) sends each persona's prompt file to the configured agent (`provider`), locally or in Docker.
3. **Collect** — each persona emits `<review>` JSON. Sandcastle validates and retries on failure.
4. **Merge** — findings are deduplicated, ranked by severity. Plain code, not an LLM.
5. **Verdict** — **PASS**, **CONTESTED**, **REJECT**, or **INCOMPLETE**.

The target arrives as a Sandcastle prompt argument, which is inert by contract: `` !`command` `` and `{{KEY}}` inside an argument's value are never expanded, so nothing in the reviewed diff is interpreted as anything but text.

## Configuration

Everything lives in `eval-reviewer.config.json`. Copy [the skill's own](./eval-reviewer.config.json) to a repo's root to override it there. Every field is optional.

| Field | Default | What it decides |
|---|---|---|---|
| `provider` | `pi` | `pi`, `claude-code`, or `codex` |
| `model` | `lm-studio/gemma-4-e2b-it` | model string the provider resolves |
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

Flags: `--personas`, `--fail-on`, `--config`, `--diff`, `--pr`, `--repo`, `--mode`.

### Credentials

**Local mode**: the script runs the agent CLI on this machine and inherits your shell — whatever authenticates your harness authenticates the review.

**Docker mode**: a container gets none of the host's auth. It carries only what `docker.mounts` and `docker.forwardEnv` specify. Mount the *files* the agent reads (not the directory it writes sessions into), and set `docker.forwardEnv` to the environment variables it needs.

Under CI the mode is forced to `local`: a runner is already a disposable VM.

### OpenAI-compatible endpoints

The agent reaches any OpenAI-compatible endpoint through a provider entry in its config. For pi, that's `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "my-api": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "models": [{ "id": "my-model" }]
    }
  }
}
```

Then set `model: "my-api/my-model"` in `eval-reviewer.config.json`. In local mode that's all. In Docker mode, add `OPENAI_API_KEY` to `docker.forwardEnv` and ensure `~/.pi/agent/models.json` is in `docker.mounts`.

## Personas

| Persona | Focus | Catches |
|---------|-------|---------|
| **Skeptic** ★ | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** ★ | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Security** ★ | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

Each file in [`references/`](./references) is the prompt, sent to the agent as written — `{{TARGET}}` is where the reviewed code lands. Nothing wraps it, so a persona is changed by editing its file, and added by writing a new one plus a line in `review.personas`.

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

The CI workflow posts the report as a PR comment via `gh pr comment`. For inline review comments (previously a separate `pr-comment.ts` script), pass `--pr NUMBER` to `review.ts` — it validates anchors against the diff before posting.

## Requirements

- **Bun**, **Node 22.18+**, or `npx tsx`
- **An agent CLI on PATH** — whichever `provider` names in the config
- **Docker**, only for `mode: docker`

## Publish

This skill is indexed on [skills.sh](https://skills.sh). To publish your own version: fork the repo, keep the `SKILL.md` frontmatter (`name`, `description`), make the repository public, and it becomes installable with `npx skills add <your-org>/<repo>`.

## License

MIT
