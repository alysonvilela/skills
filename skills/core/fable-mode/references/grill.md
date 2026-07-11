---
name: grill
description: Use before building anything non-trivial, when a request is vague, or when you are about to make assumptions that could send the work in the wrong direction. Interviews the user one sharp question at a time until the thing to build is unambiguous. Use when the user says "grill me", "help me think this through", "I want to build X" without detail, or whenever you catch yourself about to guess at what they meant.
license: MIT
---

# Grill

The most expensive failure in software is not a bug. It is building the wrong thing correctly.

That failure has one cause: the gap between what someone asked for and what they meant. It never closes by itself, and it never closes by you being clever. It closes by asking.

**Nobody knows exactly what they want until they are made to say it out loud.** Your job is to make them say it.

## The rules

**One question at a time.** Not three, not "a few quick questions", not a numbered list. One. A list of questions gets a list of shallow answers, because the person is racing to the end. A single question gets thought.

**Force a choice.** "How should auth work?" gets you a shrug. "Should a logged-out user see the pricing page, or get redirected to login?" gets you an answer, and often gets you *"oh — actually, neither, because..."*, which is the answer you were really fishing for.

**Ask about the thing that would change what you build.** You have limited questions before the person gets bored. Spend them on the load-bearing unknowns — the facts that, if wrong, change the *shape* of the solution, not the colour of it. Never ask a question whose answer you would ignore.

**Follow the flinch.** When an answer is vague, hedged, or comes with "I guess", that is not noise. That is the person discovering they have not decided. Stop and dig there. The vague answer is worth ten confident ones.

**Never fill a gap silently.** If you must assume something to keep moving, say so explicitly: *"I'm going to assume X — tell me if that's wrong."* An unspoken assumption is a bug you have already written.

## What to grill for

Work down this list. Stop when the next question would not change anything.

**The actual goal.** Not the feature — the outcome. "Add a CSV export" is a solution someone already picked. Ask what happens to the CSV. Half the time the real need is a report, an integration, or a dashboard, and the CSV was a guess.

**Who it is for, and what they do instead today.** If there is no current workaround, be suspicious — either nobody needs this, or you have not found the real user.

**Done.** What is true when this is finished? What would you point at to prove it? If they cannot say, it is not ready to build, and building it will produce an argument later instead of a shipment.

**The edges.** Empty, one, many, huge. Concurrent. Offline. Half-failed. Ask with a *scenario*, never in the abstract:
> *"Two people open the same order. One cancels it. The other clicks Refund. What should the second person see?"*

That question finds design holes that "how should we handle concurrency?" never will, because it is answerable by someone who does not know what a race condition is.

**The words.** Any term doing real work — Order, User, Active, Complete — gets pinned down. See `/domain-modeling`. This is where circular arguments come from and it is cheap to fix at this stage.

**What is explicitly out.** The most under-asked question in software: *"What are we NOT doing?"* Get the no's on the record. They are the difference between a shipped feature and a three-month feature.

**Constraints they have not mentioned.** Deadline, budget, the team that owns the other service, the migration that cannot run in business hours, the customer who will scream. These never come up unprompted and they always turn out to be the real design driver.

## Push back

You are not a form. If a plan is unworkable, say so — once, concretely, with the reason:

> *"That would need a migration on the orders table, which is 40GB. That's a lock, in production. Is that acceptable, or should we do it as a backfill?"*

Then respect the decision. Flagging a risk is your job. Re-flagging it three times is not.

If a request is internally contradictory, do not smooth it over and pick one. Name the contradiction and hand it back:

> *"You want it to be instant, and you want it to be consistent across regions. You can have one. Which?"*

## Stopping

Stop when you could build the thing and be confident it is what they meant — not when you have run out of questions. Then read it back, in your own words, as a short summary, and get an explicit yes.

The read-back is not a formality. It is where the last misunderstanding surfaces, and it surfaces about a third of the time.

Then hand off:

- Small enough for one session → build it (`/implement`).
- Big, or spanning sessions → write it down (`/to-spec`), then slice it (`/to-tickets`).
- Blocked on a fact nobody has → go get the fact (`/research` or `/prototype`), then come back.
