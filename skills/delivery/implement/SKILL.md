---
name: implement
description: Use when building from a spec or a ticket that already exists - the thinking is done and the job now is to land it correctly without drifting. Enforces re-deciding after every result, verifying at the layer of the claim, and stopping when the spec turns out to be wrong. Use when the user says "build it", "implement this ticket", "go", or hands you an agreed plan.
license: MIT
---

# Implement

You have a spec or a ticket. The thinking has happened. The job now is to land it — and the failure mode of this phase is not being wrong. It is **drifting**.

Drift is what happens when step 4 of the plan gets executed even though step 2's output already invalidated it. It is quiet, it feels productive, and by the time it surfaces you have built something nobody asked for.

## Before you touch anything

- **Re-read the ticket.** Not your memory of it. The actual text. Your memory has been quietly editing it to be easier.
- **Load the standing rules.** `CLAUDE.md`, `CONTEXT.md`, the ADRs, the lint config. Do not invent an approach for something this repo already has a rule about — that is a whole class of review comments you can avoid for free.
- **Open the code you are about to change**, and its neighbours. Not "should be around here". Actually open them. Designing against a remembered file is the single most common way agents produce plausible code that does not compile.
- **State the check.** In one sentence: how will you know it works? If you cannot say, you do not understand the ticket yet. Go back.

## The loop

Take the thinnest slice that produces a checkable result. Build it. Check it. Then decide again.

**Re-decide after every result.** Every tool result, every test run, every file you open either **confirms the plan or changes it.** Ask which. Out loud. Every single time.

This is the whole skill. The plan you started with was a hypothesis formed with less information than you have now. Executing it faithfully to the end is not discipline — it is momentum, and momentum is what carries you past the exit.

**When you learn something that changes the shape of the work — stop and say so.** Do not silently redesign. Do not quietly do it "the better way you found". The user agreed to a plan; if that plan is wrong, they need to know, and it will take you one sentence to tell them.

## Verify at the layer of the claim

Exit code 0 proves the layer *below* your claim. It does not prove your claim.

| The claim | What actually verifies it |
|---|---|
| "The tests pass" | Run them. Read the output. Paste it. |
| "The output is correct" | Look at the output. The real one. |
| "The page renders" | Load it. Screenshot it. *Read the screenshot.* |
| "The migration works" | Run it. Then query the table. |
| "It handles the empty case" | Send it an empty input and watch. |
| "I removed the old call" | Grep for it. Zero hits, or you did not. |

**"Should work" is not a state you are allowed to report from.** It means you have a hypothesis and have not tested it, and you are one keystroke away from finding out. Take the keystroke.

**Treat clean results as suspect.** A test that passes first try, a migration with no complaints, a refactor where nothing broke — these are sometimes real and are often a broken check. Before you move on, be able to say *why* the result is genuinely clean. If you cannot, your verification is what is broken, not the code.

## Stay in scope

**Preserve by default.** Touch only what the ticket requires. That adjacent function is ugly, and it is not yours today. Note it, move on, mention it in the report.

The two exceptions:

- **It blocks you.** You cannot land the ticket without touching it. Then say so, and keep the incidental change as small as it can be.
- **You are asked.** Then it is in scope.

Every unrequested change makes the diff harder to review, dilutes the actual change, and imports risk the ticket never signed up for.

## When the spec is wrong

It happens, and it is not a failure. Contact with the code is exactly when a spec's bad assumptions surface — that is a large part of why you build in slices.

When it does:

1. **Stop.** Do not build past it and do not build around it.
2. **Say what you found**, and why it invalidates the spec, concretely.
3. **Propose the fix** — the change to the spec, not just the workaround.
4. **Get a yes**, then update the spec, then continue.

The one thing you may not do is silently build something different because you decided it was better. Even when you are right, you have destroyed the user's ability to trust that what they read is what exists — and that costs more than the bad design would have.

## Done

Done is not "I finished the steps". Done is:

- [ ] The check from before you started **passes, and you watched it pass.**
- [ ] The full test suite is green. You ran it. You have the output.
- [ ] You re-read the ticket, and every "done when" box is genuinely ticked — not generously interpreted.
- [ ] The standing rules you loaded at the start were actually followed.
- [ ] The diff contains nothing you cannot justify.

## Report

- **What you built**, in one sentence.
- **What proves it** — the commands, the output, what you observed. Not what you intended.
- **What changed from the plan**, and why. If nothing did, say that too — it is worth knowing.
- **What you did not do**: assumptions you had to make, things you noticed and left alone, anything you could not verify.

Separate **verified** from **assumed**, explicitly. "I confirmed the refund path by running it against the Stripe test API; I am assuming the webhook retry behaviour matches the docs, because I could not trigger a failure."
