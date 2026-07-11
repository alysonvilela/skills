---
name: prototype
description: Use when a design decision is blocked on a fact you do not have - does this library support X, is this fast enough, does that API return what the docs claim, will this interaction feel right. Builds a throwaway spike that answers exactly one question, then deletes it. Use when the user says "spike this", "can we even do X", "try it and see", or when a plan has stalled on an argument that only evidence can settle.
license: MIT
---

# Prototype

A prototype is an **experiment**, not a draft. It exists to answer one question, and then it dies.

The failure mode is not building a bad prototype. It is building a good one — and then shipping it, because it works, and because throwing away working code feels insane. That is how the throwaway spike becomes the load-bearing module that nobody can explain.

## Write the question down first

Before any code, one sentence, in writing:

> **"I am building this to find out whether ___."**

It must be answerable with evidence, and it must be able to come back **no**. If there is no result that would change what you do next, you are not prototyping — you are starting the implementation and calling it a spike to avoid writing tests.

Good questions:

- *Can the Stripe webhook survive a 30-second processing delay, or does it retry?*
- *Does Postgres full-text search hold up at 2M rows on our hardware, or do we need Elastic?*
- *Does this drag interaction feel right, or is 60fps not the actual problem?*
- *Does this library's TypeScript inference survive our generic wrapper?*

Bad questions:

- *Let me try building the feature.* (No fact. That is just the feature.)
- *Let me see if this architecture works out.* (Unfalsifiable. Nothing comes back "no".)

## Rules for the spike

- **No tests.** You are going to delete it. Testing a spike is like proofreading a shopping list.
- **No error handling.** Crash on everything. The crash *is* the signal.
- **No abstraction.** Hardcode. Copy-paste. One file. Global variables are fine.
- **Real data.** This is the one rule that cannot bend. A spike against fixtures answers a question about fixtures. Get the real API, the real volume, the real weird rows. The entire value of the spike is that it touches reality, and fake data throws that away.
- **Timebox it.** Say how long before you start. When the box is empty, stop and report what you learned — including "I could not find out in the time I had", which is itself a finding, and an important one.
- **Keep it out of the way.** A scratch directory, a branch you will never merge, a file called `spike-<question>.ts`. It must be *obviously* not production.

## Then throw it away

When the question is answered, **delete the code.**

Keep only:

1. **The answer** — yes, no, or "it depends, and here is on what".
2. **The evidence** — the number you measured, the response body you got, the error it threw. Not your impression of it.
3. **What surprised you.** This is usually the most valuable line, and it is the one people leave out. The thing you did not expect is the thing your design was silently wrong about.
4. **What it means for the design** — what you will now do differently.

Then build the real thing, test-first (`/tdd`), informed by what you learned.

**"But it works already."** It works for the one path you drove it down, with no errors handled, no edge cases, no tests, and a design you chose in five minutes while thinking about something else. It does not work. It *demonstrated* something. Those are different, and the gap between them is where the next six months of bugs live.

If some *specific* piece is genuinely worth keeping — a tricky regex, a config incantation that took an hour to get right — copy that piece out deliberately, and rewrite everything around it. Do not promote the spike. Harvest it.

## When not to prototype

If the question can be answered by **reading** — the docs, the source, an existing test in the library's repo, the actual response of one `curl` — read. Do not build. A spike is what you reach for when the fact is not written down anywhere, and it costs hours where reading costs minutes.

Check `/research` first. Most "we need to spike this" turns out to be "nobody has read the docs".

## Report

> **Question:** Can we do all order search in Postgres, or do we need a search index?
>
> **Answer:** Yes, for now. No index needed before ~5M orders.
>
> **Evidence:** Seeded 2.1M real order rows from the staging dump. `to_tsvector` with a GIN index: p50 40ms, p99 180ms. Without the GIN index it was 4.2s — the index is doing all the work here.
>
> **Surprise:** The p99 is dominated entirely by rows with >50 line items. There are 900 of them and they are all from one customer. That customer is going to be a problem for more than just search.
>
> **Design impact:** Skip Elastic. Add the GIN index in the migration. Open a ticket for the bulk-order customer, because they will break other things.
>
> **Spike deleted:** `spike-search.ts` — gone. The seed script is worth keeping; moved to `scripts/seed-orders.ts`.
