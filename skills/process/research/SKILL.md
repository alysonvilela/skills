---
name: research
description: Use when a decision depends on a fact you do not have - how a library actually behaves, what an API really returns, whether an approach is viable, what the existing code already does. Goes to primary sources and reports claims with citations, separating what was verified from what was inferred. Use when the user says "look into X", "how does Y work", "is Z possible", or when you are about to answer from memory about anything that could have changed.
license: MIT
---

# Research

Training memory is a **hypothesis generator**. It is not a source. It is confidently wrong about version numbers, deprecations, default values, and anything that changed after the cutoff — and it gives you no signal about which of those it is being wrong about right now.

Research is the discipline of replacing what you *think* is true with what you have *checked* is true, and being explicit about which is which.

## Start with the question

Write down what you are actually trying to find out, and **what you would do differently depending on the answer.**

If the answer changes nothing, do not go and get it. Research expands to fill the time available; the only defence is knowing when you are done before you start.

Good: *"Does Stripe's PaymentIntent survive a 30s webhook delay, or does it retry and double-charge? If it retries, we need idempotency keys everywhere — that's a day of work."*

Bad: *"Look into Stripe webhooks."* You will read for an hour and come back with a summary of the docs page, which the user could have read themselves.

## Source hierarchy

Go as far up this list as you can. **Every step down is a step further from the truth**, and blog posts are two steps down and eighteen months old.

1. **The running system.** Call the API. Read the response. Query the database. Run the code. Nothing beats an observation you made yourself.
2. **The source.** The library's actual code in `node_modules`, the vendored module, the repo. It cannot lie about what it does. It is also usually faster to read than the docs.
3. **Official docs and specs** for the exact version you are on. Check the version. The docs site defaults to latest, and you are probably not on latest.
4. **Issues, changelogs, release notes.** Where you find out that the documented behaviour has a known bug.
5. **Blog posts, Stack Overflow, model memory.** These generate hypotheses. They do not settle questions. Anything you get here must be confirmed further up the list before you report it as fact.

**Inside the codebase, the hierarchy is the same.** Read the code, not the README. Run the test, do not assume it passes. Check the migration, not the model file.

## Chase every claim to its owner

When you find a claim, find the thing that *owns* it. A blog post says the timeout is 30 seconds — who says? Find the doc. The doc says 30s — but does the code? Find the constant. Follow it until you hit something that cannot be wrong, or until you hit a wall and can say precisely where the wall is.

Most research failures are one of these two:

- **Stopping at the first plausible answer**, because it matched what you already believed. Confirmation is not verification.
- **Reading around the question** — gathering context, understanding the landscape, building sympathy for the problem — and never actually answering it.

## Timebox, then report

Say how long before you start. When the box is empty, stop and report — **including what you failed to find out.**

"I could not determine whether the webhook retries; the docs are silent, the source is minified, and I did not have a test account to trigger it" is a **useful, complete result.** It tells the user exactly what to do next. Guessing to fill the gap is not a service, it is a liability.

## Report

Lead with the answer. Then the evidence. Then what you are not sure about.

> **Q: Does Stripe retry PaymentIntent webhooks on a 30s delay?**
>
> **A: Yes — it retries for up to 3 days with backoff, and your handler can be invoked more than once for the same event. We need idempotency.**
>
> **Verified:**
> - Retry schedule and at-least-once delivery: [Stripe docs, Webhook retries](https://stripe.com/docs/webhooks#retries), read 2026-07-11.
> - Confirmed against the running system: sent a `payment_intent.succeeded` to a handler that slept 45s and returned 500. It arrived **4 times** over 20 minutes. Event ID identical each time — so `event.id` is a usable idempotency key.
> - Our handler at `src/webhooks/stripe.ts:22` is **not** idempotent today. It calls `fulfilOrder()` unconditionally. This is a live double-fulfilment bug, not a hypothetical.
>
> **Inferred, not verified:**
> - The 3-day window is from the docs; I only observed 20 minutes. Not worth confirming.
>
> **Could not determine:**
> - Whether retries stop early on a 200 after a 500. Docs imply yes, I did not test it. Does not affect the decision.
>
> **So:** key `fulfilOrder` on `event.id` before anything else. This is a bug today, independent of the feature we were discussing.

Note the shape: the **answer first**, evidence **with citations and dates**, verified separated from inferred, an honest gap, and a **consequence the user did not ask for but needs.** That last one is often the most valuable thing research produces.
