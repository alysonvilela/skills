---
name: eval-reviewer
description: Use when you want an adversarial code review from multiple independent angles at once. Six personas (skeptic, architect, minimalist, security, performance, test-coverage) each review the same target with no visibility into each other's findings, then a deterministic merge dedupes and ranks them into one report with a PASS/CONTESTED/REJECT/INCOMPLETE verdict. Runs on the agent CLI you already have open, in Docker, or in CI. Use when the user says "review this", "evaluate this code", asks for a second opinion on a diff or PR, or runs the CLI directly.
license: MIT
---

# Eval Reviewer

Six personas review the same target independently and simultaneously — no persona sees another's findings before writing its own, so nothing anchors on anything else. The merge step that follows is plain code, not an LLM: same findings in, same verdict out, every time.

## The one rule

Run it and present what it produces — the personas do the reviewing, you don't. If it misbehaves mid-task, report it as a bug; hand-editing `scripts/orchestrator.ts` to route around a problem hides the failure instead of surfacing it.

## Steps

### 1 — Run it

```bash
bun <skill>/scripts/review.ts
```

**Do not ask the user what to review.** With no arguments it reviews the work in progress — uncommitted changes, or, if the tree is clean, this branch against its base. That is what "review this" means mid-task, and the runner picks it without you.

Pass a target only when the user named one:

| They said | You run |
|---|---|
| "review against main" | `--diff main` |
| a GitHub PR | `gh pr diff <url> > /tmp/target.diff` then pass that path |
| a specific file | pass the path |

Never a URL — the runner fetches nothing itself.

`node` (22.18+) and `npx tsx` work in place of `bun`. There is no setup step: the first run installs the skill's dependencies, and docker mode builds its image on first use.

All six personas run at once, each a full agent run, so the wait is the slowest persona rather than the sum.

**Done when:** the process has exited. Its exit code is the gate: `0`=clean, `1`=findings at or above `review.failOn`, `2`=critical findings, `3`=incomplete run.

### 2 — Read the output

Written into the reviewed repo: `.eval-reviewer/report.md` and `.eval-reviewer/verdict.json`, with per-persona transcripts at `.eval-reviewer/<persona>/agent.log`. The directory ignores itself, so it never shows up in `git status`.

If a persona failed, both files say so by name and carry the error — `report.md` gets a "Personas That Did Not Report" section, and `verdict.json` puts the message on that persona's entry.

Read that error before theorising. `produced no output at all` is an environment problem — usually a second, older copy of the agent CLI earlier on PATH, and the header names the exact binary that ran. `tag <review> not found` with a talkative transcript is the opposite: the CLI worked and the model ignored the format, which is a `agent.model` decision, not a prompt bug. Do not go editing `references/` for either one.

**Done when:** you've read both — the markdown is for the user, the JSON has the structured breakdown you need to reason about the verdict.

### 3 — Present

Show the report to the user. If the verdict is `INCOMPLETE`, say which personas didn't finish *before* anything else — an `INCOMPLETE` that reads like a clean run is a different claim than one with full coverage, and whoever reads it needs to know which they're getting.

## Configuration

One file, `eval-reviewer.config.ts`. The runner reads the copy in the reviewed repo's root; without one it falls back to the skill's own, which is also the file to copy when a repo needs its own settings. Every field is optional.

```ts
export default {
  agent: {
    provider: "pi",                          // pi | claude-code | codex
    model: "lm-studio/gemma-4-e2b-it",       // pi resolves "provider/id"
    thinking: "medium",
  },
  execution: { mode: "local", concurrency: 6, idleTimeoutSeconds: 300, retries: 2 },
  docker: {
    image: "sandcastle:eval-reviewer",
    mounts: [{ hostPath: "~/.pi/agent/auth.json", sandboxPath: "~/.pi/agent/auth.json", readonly: true }, ...],
    forwardEnv: ["OPENAI_API_KEY"],
  },
  review: { personas: [...], failOn: "high", outDir: ".eval-reviewer" },
};
```

Four flags override it for one run: `--mode`, `--personas`, `--fail-on`, `--config`. `--help` prints the list.

## Credentials

**There is no credential to export.** `mode: "local"` runs the agent CLI already installed on the machine and inherits the shell it was started from, so whatever authenticates your harness — an OAuth token on disk, `~/.pi/agent/models.json`, an exported key — authenticates the review. If the CLI is on PATH, the run proceeds.

`mode: "docker"` is the exception: a container gets none of that, so it carries exactly what `docker.mounts` and `docker.forwardEnv` hand it. The default mounts the *files* pi reads — `auth.json`, `models.json`, `extensions/` — and deliberately not the `~/.pi/agent` directory, which pi writes its sessions into. A docker run with neither list populated fails at preflight rather than starting a container that cannot authenticate.

Under CI the mode is forced to `local`: a runner is already a disposable VM, and its secrets are in the environment — exactly what local mode inherits.

## OpenAI-compatible endpoints

pi reaches any OpenAI-compatible endpoint through a provider entry in `~/.pi/agent/models.json`, where `apiKey` may be a `$VAR` reference rather than a literal key:

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

Then `agent.model: "my-api/my-model"`. Local mode needs nothing else. Docker mode also needs `~/.pi/agent` in `docker.mounts` and `OPENAI_API_KEY` in `docker.forwardEnv`.

## CI

Copy `workflows/eval-review.yml` to `.github/workflows/`. It reviews `git diff <base>...HEAD`, puts the report in the job summary, uploads `.eval-reviewer/` as an artifact, and fails the job at `review.failOn`. Its comments name the two things to set: the agent CLI to install, and the secret to export.

## Personas (prompts in `references/`)

| Persona | Focus | Catches |
|---|---|---|
| **Skeptic** ★ | Correctness, completeness | Bugs, race conditions, unhandled errors, unproven assumptions |
| **Architect** ★ | Structural fitness | Coupling, boundary violations, scaling assumptions, responsibility leaks |
| **Security** ★ | Safety boundaries | Data exposure, unsafe modifications, third-party API risks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction, dead complexity |
| **Performance** | Bottlenecks, efficiency | Blocking calls, N+1 queries, memory leaks, thread misuse |
| **Test Coverage** | Scenario completeness | Missing edge cases, weak assertions, untested error paths |

★ marks a persona the review can't be trusted without.

**Each file in `references/` is the prompt, sent as written.** `{{TARGET}}` is where the reviewed code lands. Nothing wraps it, so changing what a persona looks for is an edit to that one file — and adding a persona is a new file plus one line in `review.personas`.

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
  "target": "git diff main...HEAD",
  "agent": "pi",
  "model": "lm-studio/gemma-4-e2b-it",
  "mode": "local",
  "timestamp": "..."
}
```

`PASS` requires that every selected persona reported. A star persona failing makes the run `INCOMPLETE`; any persona failing makes an otherwise-empty run `INCOMPLETE` too, because "nothing found" from a partial review is an unknown result rather than a clean one. Findings stand on their own either way.
