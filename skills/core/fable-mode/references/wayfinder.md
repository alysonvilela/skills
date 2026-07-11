---
name: wayfinder
description: Use when the work is large, the destination is foggy, and you cannot plan it because you do not yet know what the decisions are. Charts the map of open decisions first, then resolves them one at a time in dependency order. Use when the user says "I don't know where to start", "this is a big one", "we need to migrate/rewrite/replatform X", or when a plan keeps collapsing because every step reveals three more.
license: MIT
---

# Wayfinder

Some work is too foggy to plan. Not because it is big — big is fine, `/to-tickets` handles big — but because **you do not yet know what the decisions are.**

The tell: every attempt to plan it produces a step that immediately splits into three unknowns, and each of those splits again. Planning bottoms out in fog, so you plan again, and you have now spent a day producing nothing.

Stop planning. **Chart the map first.**

## The map is a map of decisions

Not tasks. Not phases. **Decisions** — the forks where the work could go two ways, and where picking wrong is expensive.

Write it to `docs/plans/<effort>-map.md` and share it. It is the shared artefact for the whole effort, and everything that follows hangs off it.

```md
# Migrating billing off the legacy monolith — Map

**Where we're trying to get to:** Billing runs in its own service.
Legacy billing code is deleted. No customer notices.

## Decisions

### D1. Do we migrate the data, or dual-write and cut over? [OPEN] [BLOCKING]
Everything downstream depends on this. Dual-write means both systems
stay correct for weeks; a migration means a freeze window.
- Need to know: can we tolerate a freeze at all? Ask Ops.
- Blocks: D3, D4, D6

### D2. Does the new service own the invoice PDF, or just the data? [OPEN]
- Blocks: D5

### D3. Which database? [BLOCKED by D1]
If we dual-write, it must speak the same schema. If we migrate, it's free.

### D4. What happens to in-flight subscriptions at cutover? [OPEN] [SCARY]
Nobody has an answer. This is the one that will hurt.

### D5. PDF rendering — reuse the legacy renderer or rewrite? [OPEN]
Low stakes, reversible. Decide late.

### D6. Rollback plan. [BLOCKED by D1]

## Known
- 40GB of invoice data, 12 years. (checked: prod dump, 2026-07-10)
- Legacy billing has no tests. (checked)
- Three internal services call it directly. (checked: grep, 3 callers)

## Assumed — not yet checked
- Stripe is the only payment provider. (nobody has confirmed this)
- Nothing reads the billing tables directly. (unverified, and if this
  is false, D1 changes completely)
```

## How to build it

**Start from the destination.** One paragraph: what is true when this is over. If you cannot write it, that is the first thing to go and find out, and the map is premature.

**Then work backwards, listing forks.** Not "what do we do first" — *"what could this depend on that we haven't decided?"* Keep going until new questions stop appearing. It will feel like you are making the problem worse. You are making it visible; it was always this big.

**Mark every decision:**
- `[OPEN]` — needs deciding.
- `[BLOCKED by Dn]` — cannot be decided until something upstream is.
- `[BLOCKING]` — a lot hangs off this. These are the ones that matter.
- `[SCARY]` — nobody has an answer and everyone has been avoiding it. **These are the most important entries on the map.** They are why the effort feels foggy. Name them explicitly, in writing, where the team can see them.
- `[DECIDED]` — with the answer, and the *why*.

**Separate Known from Assumed, ruthlessly.** Anything in Known must have been *checked* — a grep, a query, a doc, a person who said yes. Everything else goes in Assumed, and every entry in Assumed is a landmine you have at least had the sense to flag.

## Then resolve, one at a time

Take the most `[BLOCKING]` open decision. Resolve *only* that one.

Resolve it with **evidence, not discussion**. Read the code. Query prod. Ask the person who knows. Spike it (`/prototype`). A decision made in a meeting from collective memory is a guess with a quorum.

Write the answer into the map, with the why. Then re-read the whole map — because a resolved decision often **deletes** downstream ones, or reveals a fork nobody had seen. The map is a living document. If it is not changing, you are not learning.

**Do not resolve the easy ones first to feel productive.** D5 (the PDF renderer) is tempting because it is decidable and small. Deciding it changes nothing. D1 changes everything, and it is uncomfortable, which is exactly why it has not been decided yet.

## When to stop and plan

When the `[BLOCKING]` and `[SCARY]` decisions are all `[DECIDED]`, the fog is gone. What is left is *big*, but it is *known* — and known-big is a planning problem.

Hand off to `/to-spec` and `/to-tickets`. Wayfinding is done. Do not keep mapping; there is nothing left to map, and continuing is just a comfortable way of not starting.

## Between sessions

An effort like this will not fit in one context window, and it must not try. The map **is** the handoff artefact — that is its second job. Each session: open the map, pick the next blocking decision, resolve it, write it down, stop. See `/handoff`.

If you find yourself deep in a session with the map unopened, you have gone back to charging ahead in the fog. Go re-open it.
