---
name: code-review
description: Use when reviewing a diff, a pull request, a branch, or a change someone (including you) just finished. Reviews along two independent axes - does it meet the spec, and does it meet the standards - and reports them separately. Use when the user says "review this", "check my PR", "is this good", or before merging anything that matters.
license: MIT
---

# Code Review

Most reviews fail in one of two ways: they nitpick style on a change that does not do what was asked, or they bless a change that does what was asked while quietly making the codebase worse.

These are different failures because they are different questions. **Review them separately and report them separately.**

- **Spec** — does this change do what was asked?
- **Standards** — is this change code we want to keep?

A change can pass one and fail the other. Collapsing them into a single verdict is how that gets missed.

## Before you review anything

You cannot review a diff you have not read, and you cannot review it against a spec you do not have.

1. **Get the diff.** All of it. `git diff main...HEAD`, the PR files, whatever it takes. Reviewing a summary of a change is reviewing a work of fiction.
2. **Get the ask.** The ticket, the issue, the spec, the message in the thread. If there is no written ask, reconstruct it and *state your reconstruction* — you are about to judge the change against it, so it had better be right.
3. **Get the standards.** `CLAUDE.md`, `CONTEXT.md`, `CONTRIBUTING.md`, ADRs, the linter config. The repo's own rules beat any general principle you carry in, including everything in this file.
4. **Read the surrounding code.** A change is only good or bad relative to what it lives next to. A pattern that is wrong in the abstract may be exactly right here because everything else does it that way.

## Axis 1 — Spec

Line the change up against what was asked. Three questions, in this order:

- **Missing** — what was asked for and is not here?
- **Partial** — what is here but only handles some of the cases? The happy path implemented, the error path forgotten. One of three call sites updated.
- **Extra** — what is here that nobody asked for? Scope creep is not a gift. It is unrequested code that now needs review, tests, and maintenance, and it hides the actual change inside a bigger diff.

Then find where it is simply **wrong**: it satisfies the letter of the ask and produces an incorrect result.

For anything you flag as a correctness bug, you must be able to state **concrete inputs or state that produce a wrong output or a crash.** If you cannot, you do not have a bug — you have a bad feeling. Say it is a bad feeling, or say nothing. Unfalsifiable findings are how reviews lose their authority.

## Axis 2 — Standards

**If the repo documents its standards, those are the standards.** Apply them. Stop.

If it does not, fall back to a smell baseline. These are judgement calls, not violations — each one is a question worth asking, not a rule that was broken:

- **Mysterious name** — you had to read the body to learn what it does.
- **Duplicated logic** — the same decision is now made in two places, and they will drift.
- **Long function / long parameter list** — it is doing several things, or it needs an object it was not given.
- **Primitive obsession** — a `string` that is really an email, a `number` that is really cents, a `boolean` that is really a state machine.
- **Data clump** — the same three parameters travel everywhere together and have never been given a name.
- **Feature envy** — a method that spends its life reaching into another object's data. It probably belongs over there.
- **Shotgun surgery** — one conceptual change forces edits in seven files.
- **Divergent change** — one file has to be edited for seven unrelated reasons.
- **Speculative generality** — an abstraction, a hook, a flag, or a config option with exactly one caller and no second one on the horizon.
- **Message chain** — `a.b().c().d()`. Now the caller knows the whole object graph.
- **Middle man** — a class that only forwards calls.
- **Refused bequest** — an implementation that inherits an interface and throws on half of it.

**Do not report anything the tooling already enforces.** If the formatter, the linter, or the typechecker will catch it, that is their job, and spending human review attention on it is how the important findings get skimmed past.

## Severity

Rank every finding. An unranked list of twelve items reads as twelve equal items, and the author will start at the top and stop at the third.

- **Blocking** — it is wrong, unsafe, loses data, or does not do what was asked.
- **Should fix** — it works, but it will cost someone later. Say who, and when.
- **Consider** — a genuine judgement call. The author may reasonably disagree, and that is fine.

If you find nothing blocking, say so plainly. **"This is solid" is a complete and legitimate review.** Manufacturing a finding to look diligent is worse than finding nothing, because it trains the author to discount everything you say.

## Steelman before you object

Before you flag a design decision, assume it was made deliberately and try to say why.

If you can construct a plausible reason, respect it — or object to the *reason*, which is a far more useful conversation than objecting to the code. If you genuinely cannot construct one, now your objection has teeth, and you can say: "I tried to see why this was done this way and could not — what am I missing?"

This is not politeness. It is accuracy. Most code you do not understand was written by someone who knew something you do not.

## How to write a finding

Every finding needs three things:

1. **Where** — `path/to/file.ts:42`. Clickable, specific.
2. **What breaks** — the concrete failure. Inputs, state, result. Not "this could be a problem."
3. **What to do** — the change you would make. If you cannot propose one, say that too, honestly.

Bad: *"Error handling here is weak."*

Good: *"`src/orders.ts:88` — when `fetchUser` rejects, the catch returns `null` and the caller at `:120` does `user.email`, so a network blip becomes a TypeError instead of a 503. Rethrow, or return a Result the caller has to unwrap."*

The second one can be acted on without a reply. The first one starts a thread.

## Report

Two sections. Never merged.

```
## Spec
- [Blocking] ...
- [Should fix] ...

## Standards
- [Should fix] ...
- [Consider] ...
```

Then one line: what you verified yourself (ran the tests, traced the call path, checked the config) versus what you took on trust. A reviewer who does not distinguish those two is guessing with confidence.
