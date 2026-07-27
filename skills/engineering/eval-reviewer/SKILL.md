---
name: eval-reviewer
description: Use when you want an adversarial code review from multiple independent angles at once. Six personas (skeptic, architect, minimalist, security, performance, test-coverage) each review the same target with no visibility into each other's findings, then a deterministic merge dedupes and ranks them into one report with a PASS/CONTESTED/REJECT/INCOMPLETE verdict. Runs with {{agent}} in {{mode}} mode on your machine or in CI. Use when the user says "review this", "evaluate this code", asks for a second opinion on a diff or PR, or runs the CLI directly.
license: MIT
---

# Eval Reviewer

Six personas review the same target independently and simultaneously — no persona sees another's findings before writing its own, so nothing anchors on anything else. The merge step that follows is plain code, not an LLM: same findings in, same verdict out, every time.

## The one rule

Run it and present what it produces — the personas do the reviewing, you don't.

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

`node` (22.18+) and `npx tsx` work in place of `bun`. There is no setup step: the first run auto-installs `@ai-hero/sandcastle`.

Personas are discovered from `references/*.md`. To disable one, move it to `references/_unused/`.

All discovered personas run at once by default (`concurrency`), so the wait is the slowest persona rather than the sum.

**Done when:** the process has exited. Its exit code is the gate: `0`=clean, `1`=findings at or above `failOn`, `2`=critical findings, `3`=incomplete run.

### 2 — Read the output

Written into the reviewed repo: `.eval-reviewer/report.md` and `.eval-reviewer/verdict.json`, with per-persona transcripts at `.eval-reviewer/<persona>/agent.log`. The directory ignores itself, so it never shows up in `git status`.

If a persona failed, both files say so by name and carry the error — `report.md` gets a "Personas That Did Not Report" section, and `verdict.json` puts the message on that persona's entry.

**Done when:** you've read both — the markdown is for the user, the JSON has the structured breakdown you need to reason about the verdict.

### 3 — Present

Show the report to the user. If the verdict is `INCOMPLETE`, say which personas didn't finish *before* anything else.

## Configuration

One file, `eval-reviewer.config.json`. The runner reads the copy in the reviewed repo's root; without one it falls back to the skill's own. Every field is optional.

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

Personas are **not** configured in JSON. Each `.md` file in `references/` is a persona; move one to `references/_unused/` to disable it. Each file's frontmatter marks its `critical` status.

### Credentials

In `local` mode the script runs the agent CLI on this machine and inherits your shell, so whatever authenticates your harness authenticates the review.

In `docker` mode the container gets none of that — it carries only what `docker.mounts` and `docker.forwardEnv` specify.

Under CI the mode is forced to `local`: a runner is already a disposable VM.

## Personas

Personas are auto-discovered from `references/*.md`. Each file's frontmatter sets `critical: true/false`:

```markdown
---
critical: true
---
```

| Persona | Critical | Focus |
|---|---|---|
| **Skeptic** | ★ | Correctness, completeness, edge cases |
| **Architect** | ★ | Structural fitness, coupling, boundaries |
| **Security** | ★ | Data exposure, injection, permissions |
| **Minimalist** | | Necessity, simplicity, over-engineering |
| **Performance** | | Bottlenecks, efficiency, scaling |
| **Test Coverage** | | Missing cases, weak assertions, flaky tests |

★ = critical persona — if this persona fails, the verdict is `INCOMPLETE`.

To add a persona, drop a `.md` file in `references/` with the format:
- Frontmatter: `critical: true|false`
- Body: the prompt sent to the agent, using `{{TARGET}}` where the diff lands
- Output instruction: emit JSON inside `<review>` tags with `findings` and `verdict`

To disable a persona without deleting it, move it to `references/_unused/`.

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

## Requirements

- **Bun**, **Node 22.18+**, or `npx tsx`
- **An agent CLI on PATH** — whichever `provider` names in the config (default: `claude-code`, get a token with `claude setup-token`)
- **Docker**, only for `mode: docker`

## License

MIT
