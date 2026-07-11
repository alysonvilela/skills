---
name: domain-modeling
description: Use when naming things, when two people in a thread are using the same word to mean different things, when the code's vocabulary has drifted from the business's, or before designing anything in an unfamiliar domain. Maintains CONTEXT.md as the project's shared dictionary and records genuinely hard decisions as ADRs. Use when the user says "what should we call this", "define the model", or when a discussion keeps going in circles.
license: MIT
---

# Domain Modeling

Most "architecture disagreements" are vocabulary disagreements wearing a costume. Two people say "order" and mean different things, and they argue about the code for an hour before anyone notices.

The fix is boring and it works: **make the words mean one thing each, write them down, and use exactly those words in the code.**

## CONTEXT.md is the dictionary

One file at the repo root. Every term the domain uses, with a definition that is specific enough to *exclude* things.

```md
# Context

**Order** — a customer's committed intent to buy, after payment authorisation.
Before authorisation it is a Cart. An Order can never be empty, and its
line prices are frozen at creation; they do not follow the catalogue.

**Cart** — a mutable, unauthenticated collection of line items. May be empty.
May contain items that are now out of stock. Has no price guarantee.

**Fulfilment** — the physical movement of goods for one Order. One Order may
have several (split shipments). Not the same as Delivery, which is one leg
of a Fulfilment.
```

The test of a good definition: **it tells you what the thing is *not*.** "An Order is an order that a customer places" is not a definition, it is an echo. "An Order can never be empty, and prices are frozen" is a definition — it forbids things, which means the code can check it.

Read this file before you design or name anything. Update it the moment a term gets pinned down. A `CONTEXT.md` that is not maintained is worse than none, because people trust it.

## Hunt the fuzzy words

Some words are fuzzy in every domain, and they are where the bugs live. Whenever you see one, stop and resolve it:

- **User** — the human? the account? the row? the session? the person who pays, or the person who logs in? These are four different things and they are only occasionally the same.
- **Status** — one flag holding a state machine that nobody has drawn. Draw it.
- **Item** — item of what? A catalogue entry, a cart line, an order line, and a shipped unit are four types with four lifecycles.
- **Active**, **valid**, **processed**, **complete** — according to whom, and for how long?
- **Sync**, **update**, **handle**, **manage**, **process** — verbs with no content. They mean "something happens here".

When you find one, ask *one* sharp question: **"When you say X, do you mean A or B?"** Give two concrete options. Open questions get vague answers; forced choices get real ones.

Then write the answer into `CONTEXT.md`, and go rename the code.

## The same word everywhere

Once a word is pinned, use it — in the class, the table, the endpoint, the variable, the ticket, and in conversation with the business.

Every translation layer between "what the business calls it" and "what the code calls it" is a place where meaning gets lost and where every new person has to learn a mapping that exists for no reason. If the business says "consignment", the class is `Consignment`. Not `Shipment`, not `Package`, not `DeliveryUnit`.

**And when the code needs two words where the business has one, that is a discovery.** It means the business is overloading the term and has not noticed. Go back and tell them. That conversation is worth more than the refactor.

## Make illegal states unrepresentable

The definitions in `CONTEXT.md` are constraints. Push them into types wherever the language lets you.

- An Order can never be empty → its constructor takes a non-empty list, not a list you check later.
- Prices are frozen at creation → the line item stores a `Money`, not a reference to the catalogue.
- A Cart has no price guarantee → it does not have a `total` field at all. Ask for a quote.
- An email is a string that has been validated → then it is an `Email`, not a `string`. Validate at the boundary, once, and let the type carry the proof inward.

Every constraint you encode is a class of bug that becomes impossible to write, rather than a class of bug you have to remember to test for.

## ADRs — and when not to write one

An Architecture Decision Record is a short doc: **context, options, decision, consequences.**

Write one only when **all three** are true:

1. It is **expensive to reverse.** A database choice, a public API shape, an auth model. Not a file layout.
2. There was a **real trade-off.** Two options were genuinely viable and you gave something up.
3. The outcome is **surprising.** Someone six months from now will look at it, think "why on earth", and be about to undo it.

If any of those is missing, do not write an ADR. Most decisions do not need one, and a directory of forty ADRs documenting obvious choices means nobody reads the four that matter.

The most important section is **Consequences**, and it is the one everyone skips. Write down what this decision makes *hard*, not just what it makes possible. That is the sentence your successor needs.

## Report

When you resolve a term, say: what was ambiguous, what it now means, what it explicitly excludes, and which code you renamed to match. A definition that did not change any code was probably not load-bearing — which is fine, but say that too.
