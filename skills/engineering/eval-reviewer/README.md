# Eval Reviewer

**Multi-agent parallel code review with 6 specialized personas.**

Each persona reviews in its own sandboxed container, independently, then a deterministic merge step compiles their findings into a unified report with a clear verdict.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                           │
│                                                             │
│  1. Load references/config.yaml                             │
│  2. Embed the target in each persona's prompt               │
│  3. Run personas via Sandcastle (own container + branch)    │
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

Personas run in batches of `review.maxConcurrent` (default 3) — each batch is fully awaited before the next starts, so six personas is two sequential rounds of full agent runs, not one instant fan-out of six.

## How It Works

1. **Configure** — `references/config.yaml` holds the agent, the sandbox, the persona roster, and the timeouts. The orchestrator reads it; nothing about which agent runs is hardcoded in the script.
2. **Run** — [Sandcastle](https://github.com/mattpocock/sandcastle) puts each persona in its own container, on its own git branch in its own worktree, so concurrent personas never share a working directory.
3. **Collect** — Each persona emits its findings as JSON inside `<review>` tags. Sandcastle extracts and schema-validates it; a persona whose output fails validation is re-asked (`review.maxRetries`) by resuming its session, so it re-emits without redoing the review.
4. **Merge** — Findings are deduplicated, ranked by severity, and compiled into a unified report. This step is plain code, not an LLM call.
5. **Verdict** — **PASS** (all clean), **CONTESTED** (high-severity findings), **REJECT** (critical findings), or **INCOMPLETE** (a persona marked `critical: true` in the config failed).

The target's full text is embedded literally in each prompt rather than passed through Sandcastle's placeholder or shell-expansion pipeline, so nothing inside the reviewed diff is ever interpreted as a command.

## Configuration

Everything tunable lives in [`references/config.yaml`](./references/config.yaml):

```yaml
agent:
  provider: pi              # which coding agent reviews
  model: claude-sonnet-4-6
  thinking: medium

sandbox:
  provider: docker
  imageName: sandcastle:eval-reviewer

review:
  maxConcurrent: 3
  idleTimeoutSeconds: 600
  maxRetries: 2
  branchPrefix: eval-review/

personas:
  - name: skeptic
    critical: true
  # ...
```

**Swapping the agent.** Sandcastle ships providers for `pi`, `claudeCode`, `codex`, `cursor`, `opencode`, and `copilot`. Only `pi` is wired up in `scripts/orchestrator.ts` today — adding another is one entry in the `AGENTS` map there, then a change to `agent.provider`. Note that the schema-validation retry needs a provider that can resume a session (`pi`, `claudeCode`, `codex`); the others can't retry.

**Swapping the sandbox.** Same pattern: Sandcastle ships `docker`, `podman`, `vercel`, and `no-sandbox`; only `docker` is wired up in the `SANDBOXES` map.

Adding a persona is a `references/<name>.md` prompt plus an entry in the `personas` list — no code change.

### Credentials and OpenAI-compatible APIs

`agent.forwardEnv` names environment variables to forward from your shell into every persona's container. Names only — values are read at run time, so no key is written into the config or into git. A name listed there but missing from your environment aborts the run before any container starts.

pi reaches any OpenAI-compatible endpoint through a custom provider in its own `models.json`. Three pieces have to line up:

**1. Define the provider on the host** in `~/.pi/agent/models.json`. pi resolves the `apiKey` field itself, and it understands `$VAR` / `${VAR}` env references and `!command` shell lookups — so the literal key never lands in the file:

```json
{
  "providers": {
    "my-api": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

**2. Mount it into the container** so the sandboxed pi sees the same provider definition your host pi does.

**3. Forward the key and point at the model** — pi's `--model` takes `provider/id`:

```yaml
agent:
  provider: pi
  model: my-api/my-model
  forwardEnv:
    - OPENAI_API_KEY

sandbox:
  provider: docker
  imageName: sandcastle:eval-reviewer
  mounts:
    - hostPath: ~/.pi/agent/models.json
      sandboxPath: ~/.pi/agent/models.json
      readonly: true
```

Then `export OPENAI_API_KEY=...` before running. The key is passed to the container as an environment variable at launch; this skill never writes it to disk.

Sandcastle also resolves `.sandcastle/.env` and `process.env` on its own for the variables a provider is known to need — `forwardEnv` is for the ones it can't know about, like the key behind a custom provider.

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

### Setup

```bash
bun install
npx @ai-hero/sandcastle init   # builds the sandbox image
```

### CLI

```bash
# Review a diff or codebase with every configured persona
bun scripts/orchestrator.ts /path/to/diff.md

# Review with specific personas only
bun scripts/orchestrator.ts /path/to/diff.md --personas skeptic,architect,security

# Use a different config file
bun scripts/orchestrator.ts /path/to/diff.md --config ./my-config.yaml

# Review against a different repo (default: the git root above cwd)
bun scripts/orchestrator.ts /path/to/diff.md --repo ~/code/my-project
```

Each persona works in a git worktree branched from that repo's `HEAD`, so a repo is required even though the findings come from the target you pass in.

### NPM Scripts

```bash
npm run review -- /path/to/diff.md              # All personas
npm run review:core -- /path/to/diff.md         # Skeptic + Architect + Minimalist
npm run review:security -- /path/to/diff.md     # Security only
```

None of these scripts bake in a target — the `--` is required, or the orchestrator exits immediately on a missing-argument usage error.

### Exit codes

`0` PASS · `1` CONTESTED · `2` REJECT · `3` INCOMPLETE

## Output

The orchestrator generates:

- **`.eval-reviewer/report.md`** — Full markdown report with all findings
- **`.eval-reviewer/verdict.json`** — Structured verdict with severity breakdown
- **`.eval-reviewer/{persona}/agent.log`** — That persona's full agent transcript

These are written inside the skill's own directory, not the reviewed repo.

```json
{
  "overall": "CONTESTED",
  "breakdown": { "critical": 0, "high": 1, "medium": 2, "low": 0 },
  "agents": {
    "skeptic": { "status": "done", "critical": true, "findings": 2, "verdict": "contest" },
    "performance": { "status": "failed", "critical": false, "findings": 0, "verdict": "contest", "error": "..." }
  },
  "target": "/path/to/diff.md",
  "timestamp": "2026-07-27T12:00:00.000Z"
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
- [Docker](https://www.docker.com/) — the sandbox each persona runs in
- The [`pi`](https://github.com/earendil-works/pi) CLI (`@earendil-works/pi-coding-agent`), or another agent wired into the `AGENTS` map
- `gh` CLI if you're feeding it a GitHub PR — the orchestrator only accepts a local file path or inline text, it doesn't fetch URLs itself

The agent runs with permission checks off *inside the container* — that's what the container is for. The persona prompts are reviewer-only by instruction, and the container is the boundary that makes that safe to rely on. The worktree is branched from `HEAD`, so uncommitted working-tree changes are not visible to the agent; the review target itself is passed in the prompt, so it's covered either way.

## License

MIT
