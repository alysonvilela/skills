# Fable Skills

Agent skills built around one idea: **never reason from a guess when you can reason from evidence.**

Coding agents do not usually fail because the model is not smart enough. They fail because they build on an assumption nobody checked, declare victory without looking at the output, and report an intention as if it were an observation. These skills are the discipline that catches those moments.

They are small, composable, and harness-agnostic. Take the ones you want.

## Install

```bash
npx skills@latest add alysonvilela/skills
```

Pick the skills you want and the agents to install them on. Works with Claude Code, OpenCode, Codex, Cursor, and [70+ others](https://skills.sh).

```bash
# just the backbone
npx skills@latest add alysonvilela/skills --skill fable-mode

# everything, globally
npx skills@latest add alysonvilela/skills --skill '*' -g

# see what's in here without installing
npx skills@latest add alysonvilela/skills --list
```

## Start here

**[`/fable-mode`](./skills/core/fable-mode/SKILL.md)** is the backbone. It is a *method*, not a workflow — it changes how the agent executes whatever it is already doing, and routes to the specialist skills when the task has a clear shape.

Five gates, in order. Each must pass before the next opens:

1. **Scope before work** — define done, and write the check that proves it. If you cannot write the check, you do not understand the task.
2. **Evidence before reasoning** — open the file. Training memory is a hypothesis generator, not a source.
3. **Reason adversarially** — attack your own answer before someone else does. Two failed fixes means the diagnosis is wrong, not incomplete.
4. **Verify before declaring done** — verify at the layer of the claim. Exit code 0 proves the layer *below* your claim.
5. **Report calibrated** — separate what you verified from what you assumed, out loud.

`fable-mode` is **self-contained**: it embeds the full text of every skill below in its `references/`. Install it alone and it still routes correctly, reading the reference inline when the standalone skill is not present.

## The skills

### Engineering

| Skill | Use when | The one rule |
|---|---|---|
| [`/diagnosing-bugs`](./skills/engineering/diagnosing-bugs/SKILL.md) | Something is broken and the cause is not obvious | **No red-capable repro, no theory.** |
| [`/tdd`](./skills/engineering/tdd/SKILL.md) | Building anything you would otherwise have to eyeball | A test you have never seen fail is not a test. |
| [`/code-review`](./skills/engineering/code-review/SKILL.md) | Reviewing a diff, a branch, a PR | Spec and Standards are different questions. Report them separately. |
| [`/eval-reviewer`](./skills/engineering/eval-reviewer/SKILL.md) | Want adversarial review from multiple angles at once | Six personas review in parallel, independently — no anchoring on each other's findings. |
| [`/akita`](./skills/engineering/akita/SKILL.md) | Reviewing a PR or a plan for production-readiness (PT-BR) | It works is 25% of the effort. Minimum now, observed evolution later. |
| [`/codebase-design`](./skills/engineering/codebase-design/SKILL.md) | Deciding where code should live | Depth: a lot of behaviour behind a small interface. Apply the deletion test. |
| [`/domain-modeling`](./skills/engineering/domain-modeling/SKILL.md) | The words have gone fuzzy and arguments go in circles | Make each word mean one thing, write it down, use it in the code. |
| [`/prototype`](./skills/engineering/prototype/SKILL.md) | A decision is blocked on a fact only code can answer | Write the question first. Then throw the code away. |

### Delivery

| Skill | Use when | The one rule |
|---|---|---|
| [`/grill`](./skills/delivery/grill/SKILL.md) | About to build on an assumption | One question at a time. Force a choice. Follow the flinch. |
| [`/to-spec`](./skills/delivery/to-spec/SKILL.md) | A design conversation is about to be lost | Record the *why*, and never hide the open questions. |
| [`/to-tickets`](./skills/delivery/to-tickets/SKILL.md) | A spec is too big for one session | Slice through the layers, not across them. Ticket 1 must actually work. |
| [`/implement`](./skills/delivery/implement/SKILL.md) | The thinking is done, now land it | Re-decide after every result. Momentum is the enemy. |

### Process

| Skill | Use when | The one rule |
|---|---|---|
| [`/wayfinder`](./skills/process/wayfinder/SKILL.md) | The work is too foggy to plan | Chart the *decisions*, not the tasks. Resolve the scary one first. |
| [`/handoff`](./skills/process/handoff/SKILL.md) | Context is running out | Write down what you **killed**. That knowledge exists nowhere else. |
| [`/research`](./skills/process/research/SKILL.md) | A decision depends on a fact you do not have | Chase every claim to the thing that owns it. |

## How they fit together

```
                     ┌─────────────┐
                     │  fable-mode │  the backbone — always on
                     └──────┬──────┘
                            │ routes to
        ┌───────────────────┼───────────────────┐
        │                   │                   │
    something's          building            it's foggy
      broken             something            or too big
        │                   │                   │
  /diagnosing-bugs        /grill            /wayfinder
        │                   │                   │
       /tdd            /to-spec ──► /to-tickets │
        │                   │                   │
  /code-review          /implement ◄────────────┘
                            │
                        /handoff
```

Blocked on a fact at any point? `/research` if someone has written it down, `/prototype` if only running code can tell you.

## Design notes

**Skills are not documentation.** Each one is written to be *executed* by an agent mid-task, so they are imperative, opinionated, and short. They tell the agent what it may not do, not just what it could do.

**Every skill ends with a Report section.** This is deliberate: it is what feeds Gate 5, and it is why the skills compose. An agent that finishes `/diagnosing-bugs` hands `/code-review` something it can actually use.

**Nothing here is novel.** Tracer bullets, tight feedback loops, deep modules, red-green-refactor, ubiquitous language — all of it is decades old, and better books exist. What is here is the version that survives contact with an agent that will happily tell you the tests pass without running them.

## Contributing

Fork it, change it, keep it. Skills are meant to be adapted to your team — the ones here encode my defaults, and your defaults are probably different. That is fine, and it is the point.

If you find a skill that makes an agent do the wrong thing, open an issue with the transcript. That is the only bug report that matters for this kind of thing.

## License

MIT — see [LICENSE](./LICENSE).
