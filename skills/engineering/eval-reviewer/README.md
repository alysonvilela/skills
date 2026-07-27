# Eval Reviewer

**Multi-agent parallel code review with 6 specialized personas.**

Each persona reviews independently, then a deterministic merge step compiles their findings into a unified report with a clear verdict.

One config file, no setup step, no credential to export. It runs on the agent CLI you already have open — pi, Claude Code, or Codex — in Docker, or in CI.

## Install

```bash
npx skills@latest add alysonvilela/skills --skill eval-reviewer
```

Then, from the repo you want reviewed:

```bash
bun <skill>/scripts/review.ts
```

That is the whole setup, and the whole invocation. With no arguments it reviews the work in progress — uncommitted changes, or a clean tree's branch against its base. The first run installs the skill's one-time dependencies; docker mode builds its image on first use.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                           │
│                                                             │
│  1. Read eval-reviewer.config.ts                            │
│  2. Substitute the target into each persona's prompt file   │
│  3. Run every persona at once via Sandcastle                │
│  4. Deduplicate, rank, and merge findings                   │
│  5. Generate report.md + verdict.json                       │
└──────────┬──────────────────────────────┬───────────────────┘
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

All six run at once by default (`execution.concurrency`), so the wait is the slowest persona, not the sum of six.

## How it works

1. **Configure** — one file, `eval-reviewer.config.ts`. The repo's copy wins; without one the skill's own defaults apply.
2. **Run** — [Sandcastle](https://github.com/ai-hero-dev/sandcastle) sends each persona's file to an agent as its prompt, on this machine or in a container.
3. **Collect** — each persona emits its findings as JSON inside `<review>` tags. Sandcastle extracts and schema-validates it; a persona whose output fails validation is re-asked (`execution.retries`) by resuming its session, so it re-emits without redoing the review.
4. **Merge** — findings are deduplicated, ranked by severity, and compiled into one report. Plain code, not an LLM call.
5. **Verdict** — **PASS** (all clean, all personas reported), **CONTESTED** (high-severity findings), **REJECT** (critical findings), or **INCOMPLETE** (a persona failed).

The target arrives as a Sandcastle prompt argument, which is inert by contract: `` !`command` `` and `{{KEY}}` inside an argument's value are never expanded, so nothing in the reviewed diff is interpreted as anything but text.

## Configuration

Everything lives in `eval-reviewer.config.ts`. Copy [the skill's own](./eval-reviewer.config.ts) to a repo's root to override it there. Every field is optional.

| Field | Default | What it decides |
|---|---|---|
| `agent.provider` | `pi` | `pi`, `claude-code`, or `codex` — which CLI runs each persona |
| `agent.model` | `lm-studio/gemma-4-e2b-it` | pi resolves `"provider/id"` against its own registry |
| `agent.thinking` | `medium` | `off` … `xhigh` |
| `execution.mode` | `local` | `local` (this machine) or `docker` (one container per persona) |
| `execution.concurrency` | `6` | personas alive at once — the default is all of them |
| `execution.idleTimeoutSeconds` | `300` | seconds without agent output before a persona is stuck |
| `execution.retries` | `2` | re-asks when a persona's JSON fails validation |
| `docker.image` | `sandcastle:eval-reviewer` | built on first docker-mode run |
| `docker.mounts` | `~/.pi/agent` (read-only) | host paths the container sees |
| `docker.forwardEnv` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | variable names copied into the container |
| `review.personas` | all six | `name` **is** the prompt file `references/<name>.md` |
| `review.failOn` | `high` | severity that makes the exit code non-zero (`never` to only report) |
| `review.outDir` | `.eval-reviewer` | where the report lands |

Four flags override it for one run: `--mode`, `--personas`, `--fail-on`, `--config`. The target is `--diff <base-ref>`, a file path, or literal text.

### Credentials

There is no credential to export. Local mode runs the CLI already installed on the machine and inherits the shell it was started from — whatever authenticates your harness authenticates the review.

Docker mode is the exception, because a container gets none of that. It carries exactly what `docker.mounts` and `docker.forwardEnv` hand it, and a run with neither populated fails at preflight rather than starting a container that cannot authenticate.

Under CI the mode is forced to `local`: a runner is already a disposable VM, and its secrets are already in the environment.

### OpenAI-compatible endpoints

pi reaches any OpenAI-compatible endpoint through a provider entry in `~/.pi/agent/models.json`, where `apiKey` may be a `$VAR` reference or a `!command` lookup rather than a literal key:

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

Point `agent.model` at `"my-api/my-model"` and local mode is done. Docker mode also needs `~/.pi/agent` in `docker.mounts` and `OPENAI_API_KEY` in `docker.forwardEnv` — the mount is what makes the sandboxed pi see the same provider definition the host pi does.

Some OpenAI-compatible servers reject the `developer` role or `reasoning_effort`; set `compat.supportsDeveloperRole` / `compat.supportsReasoningEffort` to `false` on the provider when that happens.

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
# The work in progress — no arguments, no decisions
bun <skill>/scripts/review.ts

# Against an explicit base
bun <skill>/scripts/review.ts --diff main

# A file, with a subset of personas
bun <skill>/scripts/review.ts /tmp/pr.diff --personas skeptic,architect,security

# A GitHub PR
gh pr diff 42 > /tmp/pr.diff && bun <skill>/scripts/review.ts /tmp/pr.diff

# In a container instead of on this machine
bun <skill>/scripts/review.ts --diff main --mode docker

# Report without gating
bun <skill>/scripts/review.ts --diff main --fail-on never
```

`node` (22.18+, native type stripping) and `npx tsx` work in place of `bun`.

### Exit codes

`0` clean · `1` findings at or above `review.failOn` · `2` critical findings · `3` incomplete run

## CI

Copy [`workflows/eval-review.yml`](./workflows/eval-review.yml) to `.github/workflows/`. It installs the agent CLI and the skill, reviews `git diff <base>...HEAD`, puts the report in the job summary, uploads `.eval-reviewer/` as an artifact, and fails the job at `review.failOn`.

Two details it handles that are easy to get wrong:

- `fetch-depth: 0`, because `git diff <base>...HEAD` needs both sides present.
- A guard against pull requests from forks, which get no secrets and could only fail.

For pi against a custom endpoint it also writes a one-provider `~/.pi/agent/models.json` from repository variables, because a fresh runner has no registry of its own.

## Output

- **`.eval-reviewer/report.md`** — the full report, and the GitHub job summary when running in Actions
- **`.eval-reviewer/verdict.json`** — structured verdict with severity breakdown and per-persona status
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
  "target": "git diff main...HEAD",
  "agent": "pi",
  "model": "lm-studio/gemma-4-e2b-it",
  "mode": "local",
  "timestamp": "2026-07-27T12:00:00.000Z"
}
```

A `PASS` requires that every selected persona reported. A critical persona failing makes the run `INCOMPLETE`; any persona failing makes an otherwise-empty run `INCOMPLETE` too, because "nothing found" from a partial review is an unknown result, not a clean one. Findings stand on their own either way.

## Requirements

- **Bun**, **Node 22.18+**, or `npx tsx`
- **One agent CLI on PATH** — `pi`, `claude`, or `codex`, whichever `agent.provider` names. Local mode uses the one you already have; docker mode installs it into the image.

  The run header prints the **full path** of the CLI it resolved, because more than one copy is easy to end up with — an `npm i -g` one and a `bun add -g` one, in different bin directories — and PATH order silently decides which runs. An old build that cannot load your extensions exits `0` having printed nothing, which reads like a review that found nothing. When a persona produces no output at all, the failure says so by name rather than blaming the missing tag:

  ```
  ✗ skeptic — failed: /home/lab/.nvm/versions/node/v24.15.0/bin/pi produced no
    output at all — the review never ran. […] A second, older copy of the CLI
    earlier on PATH fails exactly this way.
  ```

- **Docker**, only for `mode: "docker"`
- **`gh`** only if you feed it a GitHub PR — the runner accepts a local path, inline text, or a git ref, and fetches nothing itself

Personas run against the repo as it is — no worktree, no branch, no merge. That machinery exists to keep an agent's *commits* off your branch, and a reviewer makes none: the prompts are reviewer-only by instruction and the whole target is already in the prompt, so nothing is gained by paying for six checkouts of the repo.

## Publish

This skill is indexed on [skills.sh](https://skills.sh). To publish your own version: fork the repo, keep the `SKILL.md` frontmatter (`name`, `description`), make the repository public, and it becomes installable with `npx skills add <your-org>/<repo>`.

## License

MIT
