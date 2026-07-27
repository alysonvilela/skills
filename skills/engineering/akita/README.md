# Akita — Multi-Agent Reviewer with a Persona Matrix

**Code and plan reviewer inspired by Fabio Akita's principles.**

Multiple reviewers catch different things. "It works" is only 25% of the effort.
Start from desire, not architecture. Every finding should carry the minimum
needed now, plus a note on future evolution.

## Philosophy

This skill embeds principles drawn from Fabio Akita's writing:

| Principle | Origin |
|---|---|
| Multiple reviewers catch different things | Akita: Claude Code + Codex found different holes on the same PR |
| 75% Rule: "it works" is only 25% | 50 of 201 commits, 2 of 6 days |
| Start from desire, not architecture | Desire > technical spec |
| Idempotency above all | Non-idempotent jobs are time bombs |
| Null vs. zero | nil != 0; treating them as equal produces wrong conclusions |
| Every input is hostile | Security in multiple layers |

## Architecture

```
User → PR link or plan file
                    │
                    ▼
      ┌─────────────────────────────┐
      │        ORCHESTRATOR         │
      │  (you — prepares input,     │
      │   dispatches, collects,     │
      │   consolidates)             │
      └──────┬──────┬──────┬────────┘
             │      │      │
    ┌────────┘      │      └────────┐
    ▼               ▼               ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ Skeptic  │  │Architect │  │ Minimalist   │
│ · Bugs   │  │· Coupling│  │ · Over-eng.  │
│ · Edge   │  │· Bounds  │  │ · Simplify   │
│ · Errors │  │· Scale   │  │ · Delete     │
└──────────┘  └──────────┘  └──────────────┘
    ▼               ▼               ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ Security │  │Production│  │              │
│ · Data   │  │ · Tests  │  │              │
│ · Inject │  │ · Deploy │  │              │
│ · Secrets│  │ · Observ │  │              │
└──────────┘  └──────────┘  └──────────────┘
    │               │               │
    └───────────────┼───────────────┘
                    ▼
      ┌─────────────────────────────┐
      │       CONSOLIDATOR          │
      │  · Deduplicates             │
      │  · Ranks                    │
      │  · Minimum NOW               │
      │  · Future evolution note    │
      └─────────────────────────────┘
                    │
                    ▼
           Final structured report
```

## Usage

### Review a GitHub PR

```
@agent akita: https://github.com/org/repo/pull/123
```

Or:

```
@agent akita: review this PR https://github.com/org/repo/pull/123
```

### Review a plan

```
@agent akita: review this plan specs/005-something/plan.md
```

## Persona Matrix

| Persona | Inspiration | Focus | Catches |
|---|---|---|---|
| **Skeptic** | "Prove it works" | Correctness, edge cases | Bugs, race conditions, unhandled errors |
| **Minimalist** | "Start from desire" | Simplicity, necessity | Over-engineering, premature abstraction |
| **Architect** | "Structural decisions" | Design, coupling | Boundaries, responsibility leaks |
| **Security** | "Every input is hostile" | Safety, data | Vulnerabilities, secrets, exposure |
| **Production Eng.** | "75% is hardening" | Production readiness | Tests, deploy, observability, cost |
| **Consolidator** | Akita Boss (merge) | Synthesis, prioritization | Minimum now + future evolution |

## Output

The final report includes:

1. **Verdict**: PASS | CONTESTED | REJECT
2. **Executive summary**: count by severity
3. **Consolidated findings**: each with `minimumNow` and `futureEvolution`
4. **Production Readiness Checklist**: based on the Akita checklist
5. **Future Evolution Notes**: what doesn't need to happen now

## Example Output

```
## Akita Review Report
**Type:** PR
**Target:** https://github.com/org/repo/pull/123
**Final Verdict:** CONTESTED

### Executive Summary
- 1 critical, 3 high, 2 medium, 4 low
- Production readiness: 3/5 items

### Detailed Findings

#### 🔴 Critical
**Non-idempotent jobs** (skeptic, production)
`src/jobs/collector.ts:45`
- **Problem**: if the job runs twice, it duplicates records
- **Minimum NOW**: add `find_or_initialize_by(platform_post_id)`
- **Future evolution**: consider a 1h SNAPSHOT_DEDUP_WINDOW

### Production Readiness Checklist
[ ] Test coverage on changed paths → PARTIAL (unit ok, missing integration)
[ ] Security audit → N/A (no security-relevant change)
[✓] Observability → structured logs added
...

### Future Evolution Notes
- Once there are more than 10 profiles, the discovery pipeline will need
  per-profile rate limiting
- LLM cost tracking could be added as a Prometheus metric
```

## Requirements

- Access to `gh` (GitHub CLI) to fetch PR diffs
- Or web access to fetch PR URLs directly

## Inspiration

This skill is based on [Fabio Akita](https://akitaonrails.com/)'s writing and principles:

- ["Vibe Code: Do Zero à Produção em 6 DIAS"](https://akitaonrails.com/2026/02/16/vibe-code-do-zero-a-producao-em-6-dias-the-m-akita-chronicles/)
- ["Eu Fiz um Sistema de Data Mining pra Minha Namorada Influencer"](https://akitaonrails.com/2026/03/04/eu-fiz-um-sistema-de-data-mining-pra-minha-namorada-influencer-dicas-e-truques/)

## Differences from eval-reviewer

| Aspect | eval-reviewer | Akita |
|---|---|---|
| Engine | Bun script + qwen CLI | Oracle subagents via `task()` |
| Output | Raw findings | Minimum now + future evolution |
| Scope | Code only | Code + plans |
| Lens | Generic | Production-first (Akita) |
| Verdict | PASS/CONTESTED/REJECT | + production-readiness score |
| Inspiration | — | Fabio Akita, XP, 75% Rule |
