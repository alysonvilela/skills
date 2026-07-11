---
name: to-tickets
description: Use to split a spec into tickets that each ship something working end-to-end, rather than layers that only pay off when the last one lands. Slices by dependency and by user-visible value, never by architectural layer. Use when the user says "break this down", "make tickets", "how do we sequence this", or when a spec is too big for one session.
license: MIT
---

# To Tickets

There is only one hard question in breaking down work, and it is not "how big should a ticket be".

It is: **does this ticket produce something that works?**

## Slice through, not across

The instinct is to slice by layer: one ticket for the schema, one for the API, one for the UI, one for the tests. It feels organised. It is the worst possible split, for three reasons:

1. **Nothing works until the last one lands.** You have no feedback, no demo, and no idea whether the design is right until you have spent the entire budget.
2. **Every integration bug arrives at once**, at the end, when the schedule has no room left.
3. **You cannot stop.** Three tickets in, you have a schema and an API and nothing a human can use. Cancel now and you have shipped nothing.

Slice the other way. Each ticket takes **one narrow case all the way through** — schema, logic, API, UI, test — and leaves the system working.

> **Layered (bad):** `1. Order schema` · `2. Order API` · `3. Order UI` · `4. Tests`
>
> **Tracer bullets (good):** `1. A customer can place an order with one item, card payment only, no discounts — end to end, tested, deployed` · `2. Multiple line items` · `3. Discount codes` · `4. Split shipments`

After ticket 1, a real order goes through a real system. Everything after that is *widening* something that already works — and if the design is wrong, you find out on day two, for the price of one ticket.

## The first ticket is the important one

Make ticket 1 the **thinnest possible path that touches every layer.** Deliberately, almost embarrassingly narrow. One item. One payment method. No edge cases. Hardcode what you must and open a ticket for it.

It is doing a job that none of the others can do: proving the architecture holds together, exposing the integration pain while there is still time to react, and giving you a working system to widen instead of a pile of parts to assemble.

If ticket 1 cannot touch every layer, that is not a scheduling problem — it is a design problem, and you have just found it early. Good.

## What a ticket needs

If a competent person cannot pick it up and finish it without asking you a question, it is not a ticket yet.

```md
## <What a user can do afterwards that they could not do before>

**Why:** one line. Link the spec.

**Done when:**
- [ ] A specific, checkable outcome. Not "implement X" — "a customer
      with one item in their cart can pay by card and receives a
      confirmation email."
- [ ] Tested at the seam.
- [ ] Deployed / merged / behind a flag — whatever "shipped" means here.

**Not in this ticket:** the neighbouring things someone will be tempted
to also do. Name them, and link the ticket that covers each.

**Depends on:** #12 (or: nothing).
```

**Title it by what becomes possible**, not by what you will touch. `"Add orders table"` tells you nothing about whether it worked. `"Customer can place a single-item order"` can be verified by a human in ten seconds.

**"Done when" must be checkable by someone who did not build it.** "Refactor the order service" has no finish line, so it will not have one, and it will eat a week.

## Sequencing

Order by dependency, then by risk.

- **Dependencies first**, obviously — but be honest about which ones are real. Most claimed dependencies are preferences. You can hardcode the discount as zero and ship orders today.
- **Risk early.** The ticket most likely to explode the design goes as early as its dependencies allow. Discovering on ticket 8 that the payment provider cannot do partial captures is a catastrophe. Discovering it on ticket 2 is a Tuesday.
- **Boring last.** The fifth payment method, the admin screen, the CSV export. These will not teach you anything, and there is a real chance they get cancelled — which is a *win*, and only possible if they are last.

## Size

A ticket should be finishable in **one focused session, in one context window**, without a handoff.

Too big → you will compact mid-flight, lose the thread, and finish something subtly different from what you started. Too small (`"add the column"`) → you have re-invented the layer split with extra ceremony.

The real test is not hours. It is: **is there a coherent, checkable thing that is true at the end?** If yes, it is one ticket, even if it is a big one. If no, it is half a ticket, no matter how small.

## Report

The list, in order, with dependencies. Then, explicitly:

- **What ticket 1 proves.** If the answer is "nothing, it's just the schema", go back and re-slice.
- **What is deferred, and what happens if it is never done.** Some of it, honestly, would be fine.
- **Where the risk is** — which ticket is most likely to blow up the plan, and why it is not at the end.
