---
name: akita
description: Use when reviewing a GitHub PR or a plan file and the question is production-readiness, not just correctness. Dispatches five independent personas — skeptic, architect, minimalist, security, production engineer — in parallel, then a consolidator merges findings into a minimum-now vs. evolve-later verdict, inspired by Fabio Akita's writing. Use when the user says "review this PR", "review this plan", or asks whether something is ready to ship.
license: MIT
---

# Akita — Multi-Agent Reviewer with a Persona Matrix

Inspired by Fabio Akita's principles: **multiple reviewers catch different things** — Claude Code and Codex, reviewing the same PR, each found different holes. **"It works" is only 25% of the effort**; the rest is hardening. And every consolidated finding has two parts that must not be conflated: the minimum needed to not break **now**, and an observation about how this **evolves later**.

```
PR or plan
     │
     ▼
┌─────────────┐     ┌──────────┐ ┌──────────┐ ┌─────────────┐
│ Orchestrator│ ──▶ │ Skeptic  │ │Architect │ │ Minimalist  │  (parallel)
│  (you)      │     └──────────┘ └──────────┘ └─────────────┘
└─────────────┘     ┌──────────┐ ┌─────────────┐
                     │ Security │ │Production Eng│
                     └──────────┘ └─────────────┘
                            │
                            ▼
                      Consolidator
                            │
                            ▼
                  Final report + verdict
```

## The one rule

You orchestrate and consolidate. You do not review — that's the personas' job — and you do not edit: this is a review tool, full stop. If you catch yourself wanting to fix something you're reading, that observation becomes a finding in the report, not a change to the diff.

## Steps

### 1 — Capture the input

**GitHub PR:** accept any link shape (`.../pull/123`, `.../pull/123/files`, `org/repo#123`) and extract org/repo/number. Fetch both the diff **and** the description — a persona that only sees the diff can't tell over-engineering from a legitimately larger ask:
```bash
gh pr view <url> --json title,body,additions,deletions,files
gh pr diff <url>
```
No `gh` available: web-fetch the PR URL with `.diff` appended.

**Plan file:** read it in full.

**Done when:** you hold the complete diff/plan — not a summary of it. A persona working from a description of the code finds different bugs than one reading the code itself.

### 2 — Dispatch the persona matrix

Fire all five personas — Skeptic, Architect, Minimalist, Security, Production Engineer — as background `oracle` subagents, in parallel. Each one's prompt is the content of `references/{persona}.md` plus the full input from step 1.

**Done when:** you hold five task IDs. Four dispatched and "essentially the matrix" is not the matrix — a persona that never ran is a blind spot nobody knows exists.

### 3 — Collect every result

Wait on each task ID; pull results with `background_output(task_id=...)`.

**Done when:** each of the five has either returned findings or hit its timeout. A persona that times out is not dropped — mark it `timed_out` and carry that into the report. Letting a slow persona silently fall out of the merge is how a REJECT-worthy finding disappears.

### 4 — Consolidate

Invoke the Consolidator (`references/consolidator.md`) as a sixth, synchronous `oracle` call, with every persona's findings attached — including any `timed_out` markers.

**Done when:** you have a verdict (PASS / CONTESTED / REJECT) and the full structured findings back.

### 5 — Present

Show the consolidated report to the user in the format under Report.

## Personas (references in `references/`)

| Persona | Focus | Catches |
|---|---|---|
| **Skeptic** | Correctness, completeness | Bugs, race conditions, unhandled errors |
| **Architect** | Structural fitness | Coupling, boundary violations, responsibility leaks |
| **Minimalist** | Necessity, simplicity | Over-engineering, premature abstraction |
| **Security** | Safety boundaries | Data exposure, injection, secrets |
| **Production Eng.** | Production readiness | Tests, deploy, observability, cost |

## Report

```
## Akita Review Report
**Type:** PR | Plan
**Target:** <link or file>
**Final Verdict:** PASS | CONTESTED | REJECT

### Executive Summary
- X critical, Y high, Z medium, W low
- Production readiness: N/M items
- Personas: 5/5 complete (or: N/5 — name who timed out)

### Detailed Findings
[by severity, each with: the problem, minimum needed NOW, future-evolution note]

### Production Readiness Checklist
[based on the Production Engineer's checklist]

### Future Evolution Notes
[things that don't need to happen now, but are worth recording]
```

If any persona timed out, say so before the verdict, not after — a REJECT that's actually "4 of 5 opinions, Security never responded" is different information from a REJECT with full coverage, and whoever reads the report needs to know which one they're getting.
