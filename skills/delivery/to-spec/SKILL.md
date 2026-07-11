---
name: to-spec
description: Use after a design conversation, to turn everything that was decided into a written spec that survives the context window. Captures decisions, explicit non-goals, and open questions - not implementation. Use when the user says "write this up", "turn this into a spec", or when a conversation has produced real decisions and is about to be lost.
license: MIT
---

# To Spec

A spec exists for one reason: **the conversation is about to be forgotten, and the decisions in it are expensive.**

It is not documentation, and it is not a design exercise. It is the compressed, durable residue of a thread that already happened. If you are inventing things while writing it, stop — you are not writing a spec, you are designing, and you should go back to `/grill` and do that with the user in the room.

## Before you write

You need a conversation with real decisions in it. If you do not have one — if half of this would be your guesses — you are not ready. Go grill.

Everything in the spec must be traceable to something the user actually said or explicitly agreed to. Anything else is an **open question**, and it goes in that section, honestly labelled.

## The shape

Write to `docs/specs/YYYY-MM-DD-<slug>.md`. Nine sections. Keep it under two pages.

```md
# <Feature>

**Status:** draft | agreed | building | shipped
**Date:** 2026-07-11

## Problem
Who is hurting, and how. Concrete. If you cannot name the person
and what they do today instead, this section is not finished.

## Goal
What is true when this is done. One or two sentences.

## Non-goals
What we are explicitly NOT doing, and why. This is the most valuable
section in the document. Everything here is a "no" that someone will
try to reopen in three weeks, and this is what you point at.

## Decisions
What we decided, and *why* — the reason matters more than the decision,
because the reason is what tells someone whether it still applies.

- Prices are frozen at order creation, not looked up live.
  Why: catalogue price changes must not retroactively alter an
  invoice that has already been sent. Legal requirement, not a preference.

## Model
The nouns, and what they mean. Link to CONTEXT.md rather than
restating it. Only the terms this feature introduces or changes.

## Behaviour
What the system does, as scenarios. Not implementation.

- Given an authorised Order, when the customer cancels within 30
  minutes, then the authorisation is voided and no refund is issued.
- Given an authorised Order older than 30 minutes, when the customer
  cancels, then a refund is issued and it may take 5 days.

## Edges
Empty, one, many. Concurrent. Failed halfway. What we decided for each.
Blank entries here are lies — write "undecided" instead.

## Open questions
What is still unknown, who can answer it, and whether it blocks the
build or can be resolved along the way. Never delete this section
to make the spec look finished.

## Out of scope for now
Things we will probably do later. Parked, not rejected. Keeping this
separate from Non-goals is what stops "later" from becoming "never"
by accident — or from being smuggled into this build.
```

## Rules

**Behaviour, not implementation.** No class names, no file paths, no library choices. If the spec says *how*, it will be wrong within a week, and then nobody will trust the parts that say *what*.

**Record the why with every decision.** A decision without its reason cannot be revisited — nobody knows whether the constraint that drove it still holds, so it either gets treated as sacred or gets casually undone. Both are bad.

**Non-goals are load-bearing.** They are the only defence against scope creep, and they are the first thing people skip. Write them.

**Do not hide the open questions.** A spec with an honest "we don't know how refunds interact with partial shipments — blocking, ask Finance" is a useful document. One that quietly picks an answer to look complete is a trap, and it will be discovered at the worst possible moment.

**Absorb the conversation, do not append to it.** The spec replaces the thread. Nobody should have to read both.

## After

Get an explicit yes on the spec from whoever owns the decision. Not "looks good" in passing — an actual yes on the actual document. This is the last cheap moment to be wrong.

Then slice it into tickets (`/to-tickets`), and — this matters — **keep the spec as the reference while you build.** A spec that gets written, approved, and never opened again was a ritual, not a tool. When the build contradicts the spec, one of them is wrong; go find out which, and update it.
