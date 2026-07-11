---
name: handoff
description: Use when a piece of work will not finish in this context window, when you are about to compact or start a fresh session, or when passing work to another person or agent. Writes a compact document that carries the decisions and the open threads without dragging the transcript along. Use when the user says "hand this off", "write this up before we lose it", "continue in a new session", or when you notice the context is nearly full mid-task.
license: MIT
---

# Handoff

Context runs out. When it does, the transcript is lost and the *decisions inside it* go with it — unless you wrote them down.

A handoff is not a summary of the conversation. **It is the minimum a competent stranger needs to pick up exactly where you stopped.** Different document, different rules.

## When

- Context is filling and the work is not done. **Write it before you are forced to**, not at 95%. A handoff composed in a nearly-full window is a bad handoff, because you no longer have room to think about it.
- The next phase is a different job (design → build, build → review) and deserves a clean window.
- You are forking off a side-quest (a spike, a bug) and want the main thread intact.
- You are handing to a person, or to a sub-agent.

**Never compact or clear mid-phase.** Finish the coherent unit — the decision, the ticket, the diagnosis — *then* hand off. Compacting halfway through a diagnosis loses the half you cannot reconstruct: the theories you already killed.

## The shape

```md
# Handoff — <task>
2026-07-11

## Goal
What we are trying to achieve. One or two sentences. The whole thing,
not just the part that is left.

## State
What is true right now. Branch, what runs, what does not.

- Branch `feat/billing-cutover`, 4 commits, not pushed.
- `pnpm test` — green except `billing/refund.test.ts` (3 failing,
  expected: that's the ticket).
- The new service boots but has no auth yet.

## Decided (and why)
The decisions made in this session. The *why* is the point — without
it the next agent cannot tell whether the decision still holds.

- Dual-write, not migrate. Ops cannot give us a freeze window. (D1)
- The new service owns the PDF. Legacy renderer is 8 years old and
  has no tests; nobody will touch it. (D2)

## Killed
What we tried that did NOT work, and why. Without this, the next
agent will helpfully try it all again. This section saves more time
than any other.

- Tried reusing the legacy `InvoiceBuilder` — it reads directly from
  the session global. Dead end, not worth untangling.
- Assumed Stripe was the only provider. It is not. There is a
  PayPal path in `legacy/pay/pp.rb`, unused since 2021 but live.

## Open
What is still unresolved, and what it blocks.

- Refunds on partially-shipped orders: undecided. Blocking ticket #14.
  Finance needs to answer; asked in #billing, no reply yet.

## Next
The immediate next action. Specific enough to start on without
asking a question.

1. Make `refund.test.ts` pass — the ticket is #12.
2. Do NOT touch the PayPal path yet; ticket #18 covers it.

## Pointers
Where the real content lives. Do not restate it — link it.

- Spec: `docs/specs/2026-07-02-billing-cutover.md`
- Map: `docs/plans/billing-map.md`
- The tricky bit: `src/billing/dual-write.ts:40-95`
```

## Rules

**Link, do not restate.** If it is in the spec, the ADR, the map, the ticket, or the diff — *point at it*. A handoff that duplicates the spec will drift from the spec, and then there are two documents that disagree, which is worse than none.

**"Killed" is the section that earns its keep.** The next agent has the code, so it can see what exists. What it cannot see is the eight things that seemed reasonable and were not. That knowledge only exists in the transcript you are about to lose. Write it down.

**Say why, not just what.** "We chose dual-write" is a fact the next agent will feel free to overturn. "We chose dual-write *because Ops cannot give us a freeze window*" tells them exactly what would have to change for that to be revisited.

**Be honest about the mess.** If you left something broken, half-done, or hacked, say so, with the file and the line. The next agent will find it anyway — the only question is whether they find it in the document or by being bitten by it at 2am.

**Verified vs assumed.** Mark which claims you actually checked. "Tests pass" — did you run them, this session, after the last edit? Then say so. If not, say that instead.

**Zero-context test.** Read it back as someone who was not here. Every acronym, every "the usual approach", every "as discussed" is a hole. Fill them.

## After

Write it to a file — `docs/handoffs/YYYY-MM-DD-<task>.md`, or wherever the project keeps them. Not into the chat, where it dies with the window.

Then start the new session by reading it. Out loud, in one line, confirm you have it: *"Picking up billing cutover: dual-write decided, refund tests failing, next is #12."*

If you cannot say that sentence from the document alone, the handoff was not good enough. Go back and fix it now, while you still remember what was missing — you are the last person who can.
