# Eval Reviewer

**Multi-agent parallel code review with 6 specialized personas.**

Each persona reviews in its own sandbox, independently, then a deterministic merge step compiles their findings into a unified report with a clear verdict.

One dependency, no config file, no per-project setup beyond a symlink. Runs from any agent CLI, from a terminal, or from GitHub Actions.

## Install

```bash
npx skills@latest add alysonvilela/skills --skill eval-reviewer --skill setup-eval-reviewer
```

Then, from the repo you want reviewed:

```bash
node <skill>/scripts/setup.mjs          # or /setup-eval-reviewer from your agent
export CLAUDE_CODE_OAUTH_TOKEN=...      # whichever agent's credential you have
node .sandcastle/eval-reviewer.ts --diff main
```

Setup installs the dependency, symlinks the orchestrator into `.sandcastle/`, and builds the sandbox image. It is idempotent, so re-running it is how you verify a setup.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                           │
│                                                             │
│  1. Read the environment: agent, sandbox, personas, gate    │
│  2. Embed the target in each persona's prompt               │
│  3. Run personas via Sandcastle (own sandbox + branch)      │
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

Personas run in batches of `EVAL_CONCURRENCY` (default 3) — each batch is fully awaited before the next starts, so six personas is two sequential rounds of full agent runs, not one instant fan-out of six.

## How It Works

1. **Configure** — environment variables, each with a `--flag` twin. Exporting one credential is enough; the agent is picked from whichever credential is present.
2. **Run** — [Sandcastle](https://github.com/ai-hero-dev/sandcastle) puts each persona in its own container, on its own git branch in its own worktree, so concurrent personas never share a working directory.
3. **Collect** — Each persona emits its findings as JSON inside `<review>` tags. Sandcastle extracts and schema-validates it; a persona whose output fails validation is re-asked (`EVAL_RETRIES`) by resuming its session, so it re-emits without redoing the review.
4. **Merge** — Findings are deduplicated, ranked by severity, and compiled into a unified report. This step is plain code, not an LLM call.
5. **Verdict** — **PASS** (all clean, all personas reported), **CONTESTED** (high-severity findings), **REJECT** (critical findings), or **INCOMPLETE** (a persona failed).

The target's full text is embedded literally in each prompt rather than passed through Sandcastle's placeholder or shell-expansion pipeline, so nothing inside the reviewed diff is ever interpreted as a command.

## Configuration

No config file. Every knob is an environment variable with a flag that overrides it — `node .sandcastle/eval-reviewer.ts --help` prints the list.

| Variable | Flag | Default |
|---|---|---|
| `EVAL_AGENT` | `--agent` | the first of `claude-code`, `pi`, `codex`, `cursor`, `opencode`, `copilot` whose credential is set |
| `EVAL_MODEL` | `--model` | that agent's own default |
| `EVAL_EFFORT` | `--effort` | `medium` (`off`…`xhigh`) |
| `EVAL_SANDBOX` | `--sandbox` | `docker` locally, `none` when `CI` is set (`podman` also wired up) |
| `EVAL_IMAGE` | `--image` | `sandcastle:eval-reviewer-<agent>` |
| `EVAL_MOUNTS` | `--mounts` | none — `host:sandbox[:ro]` pairs, comma-separated |
| `EVAL_PERSONAS` | `--personas` | all six |
| `EVAL_CONCURRENCY` | `--concurrency` | `3` |
| `EVAL_IDLE_TIMEOUT` | `--timeout` | `600` seconds without agent output |
| `EVAL_RETRIES` | `--retries` | `2` |
| `EVAL_FAIL_ON` | `--fail-on` | `high` — severity that makes the exit code non-zero (`never` to only report) |
| `EVAL_OUT` | `--out` | `<repo>/.eval-reviewer` |
| `EVAL_REPO` | `--repo` | git root above the working directory |
| `EVAL_DIFF` | `--diff` | none — review `git diff <base>...HEAD` instead of a file |

### Credentials

Read from the shell first, then from `<repo>/.sandcastle/.env` (gitignored; `setup.mjs` writes a `.env.example` naming the right variable). They are forwarded into the sandbox at launch and are never written anywhere by this skill.

| Agent | Accepted, best first |
|---|---|
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| `pi` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| `codex` | `OPENAI_KEY`, `OPENAI_API_KEY` |
| `cursor` | `CURSOR_API_KEY` |
| `opencode` | `OPENCODE_API_KEY` |
| `copilot` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |

Missing credentials fail before any sandbox starts — a wrong key otherwise surfaces as six agents erroring at once, minutes and one image pull later.

### OpenAI-compatible endpoints

pi reaches any OpenAI-compatible endpoint through a custom provider in its own `~/.pi/agent/models.json`, where `apiKey` may be a `$VAR` reference or a `!command` lookup rather than a literal key. Three pieces line up:

```bash
export EVAL_AGENT=pi
export EVAL_MODEL=my-api/my-model            # pi resolves "provider/id"
export EVAL_MOUNTS=~/.pi/agent/models.json:/home/agent/.pi/agent/models.json:ro
export OPENAI_API_KEY=...                    # what models.json refers to
```

The mount is what makes the sandboxed pi see the same provider definition the host pi does.

## Personas

| Persona | Focus | Catches |
|---------|-------|---------|
| **Skeptic** ★ | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** ★ | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Security** ★ | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

Prompts are in [`references/`](./references). Adding a persona is a `references/<name>.md` file plus one line in the `PERSONAS` list at the top of [`scripts/orchestrator.ts`](./scripts/orchestrator.ts).

## Usage

```bash
# Everything, against the current branch
node .sandcastle/eval-reviewer.ts --diff main

# A file, with a subset of personas
node .sandcastle/eval-reviewer.ts /tmp/pr.diff --personas skeptic,architect,security

# A GitHub PR
gh pr diff 42 > /tmp/pr.diff && node .sandcastle/eval-reviewer.ts /tmp/pr.diff

# Report without gating
node .sandcastle/eval-reviewer.ts --diff main --fail-on never
```

`bun` and `npx tsx` work in place of `node` — the orchestrator is a single file using only Node APIs, so it runs under any of the three. Node needs to be 22.18 or newer for native type stripping.

### Exit codes

`0` clean · `1` findings at or above `--fail-on` · `2` critical findings · `3` incomplete run

## CI

`scripts/setup.mjs --workflow` writes `.github/workflows/eval-review.yml`. It installs the skill on the runner, reviews `git diff <base>...HEAD`, puts the report in the job summary, uploads `.eval-reviewer/` as an artifact, and fails the job at `EVAL_FAIL_ON`. Add the credential as a repository secret under the name the workflow's `env:` block references.

The workflow sets `EVAL_SANDBOX=none`: an Actions runner is already a disposable VM, so a container inside it would only add an image build to every run. It installs the agent CLI directly instead — about twenty seconds against a couple of minutes.

Two details it handles that are easy to get wrong:

- `fetch-depth: 0`, because `git diff <base>...HEAD` needs both sides present.
- A guard against pull requests from forks, which get no secrets and could only fail.

## Output

- **`.eval-reviewer/report.md`** — the full report, and the GitHub job summary when running in Actions
- **`.eval-reviewer/verdict.json`** — structured verdict with severity breakdown and per-persona status
- **`.eval-reviewer/{persona}/agent.log`** — that persona's full agent transcript

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
  "agent": "claude-code",
  "model": "claude-sonnet-4-6",
  "sandbox": "docker",
  "timestamp": "2026-07-27T12:00:00.000Z"
}
```

A `PASS` requires that every selected persona reported. A critical persona failing makes the run `INCOMPLETE`; any persona failing makes an otherwise-empty run `INCOMPLETE` too, because "nothing found" from a partial review is an unknown result, not a clean one. Findings stand on their own either way.

## Requirements

- **Node 22.18+**, or Bun, or `npx tsx`
- **Docker or Podman** for local runs — the sandbox each persona reviews in. `--sandbox none` skips it and runs the agent on the host, which is what CI uses.
- **One agent CLI**, installed in the sandbox image by `setup.mjs` (or on your PATH for `--sandbox none`)
- **`gh`** only if you feed it a GitHub PR — the orchestrator accepts a local path, inline text, or a git ref, and fetches nothing itself

Inside the container the agent runs with permission checks off — that is what the container is for. Under `--sandbox none` the checks stay on unless `CI` is set, so a host run cannot quietly bypass them. The persona prompts are reviewer-only by instruction; the worktree is branched from `HEAD`, so uncommitted working-tree changes are invisible to the agent, and the review target is passed in the prompt so it is covered either way.

## Publish

This skill is indexed on [skills.sh](https://skills.sh). To publish your own version: fork the repo, keep the `SKILL.md` frontmatter (`name`, `description`), make the repository public, and it becomes installable with `npx skills add <your-org>/<repo>`.

## License

MIT
