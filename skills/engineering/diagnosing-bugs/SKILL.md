---
name: diagnosing-bugs
description: Use when something is broken and the cause is not obvious - a failing test, a regression, a crash, output that is subtly wrong, or a bug that resisted a first fix. Enforces a red-capable repro before any theorising, then narrows the search space by halving instead of guessing. Use when the user says "this is broken", "why is this failing", "debug this", or when a fix has already been attempted once and did not hold.
license: MIT
---

# Diagnosing Bugs

Most bugs are not hard. They feel hard because the diagnosis started before the evidence did.

The discipline here is narrow: **you may not propose a cause until you can make the bug happen on demand.** Everything else follows from that.

## Phase 1 — Get to red

Before any theory, build one command that fails *because of this bug* and would pass if the bug were gone.

A failing test. A `curl` that returns the wrong body. A CLI invocation that prints the wrong number. A script that replays the trace. It does not matter what it is, as long as it is:

- **Deterministic.** It fails every time, not one run in five. A flaky repro will confirm whatever you already believe.
- **Fast.** You will run this dozens of times. If it takes two minutes, spend ten minutes making it take two seconds. That trade always pays.
- **Owned by the bug.** It must go green when the bug is fixed, and it must not be green now for some unrelated reason.

Write the command down. You will refer to it as *the repro* for the rest of the session.

**No repro, no Phase 2.** If you cannot reproduce it, that is now the whole task: get more logs, get the real input, get the exact version, get access to the environment where it happens. Ask the user for what you are missing. A bug you cannot reproduce cannot be verified as fixed, so "fixing" it is theatre.

## Phase 2 — Shrink the repro

A repro that touches half the system tells you almost nothing. Cut it down until every element left is load-bearing.

Delete a piece. Run it. Still red? Keep it deleted. Went green? Put it back — that piece matters.

Strip fixtures, config, middleware, dependencies, input fields, and code paths until removing anything at all makes the failure disappear. What survives is the bug's actual surface area, and it is usually a tenth of what you started with.

This step feels like a detour and it is the highest-leverage thing in the whole process. A minimal repro often makes the cause self-evident before you have theorised at all.

## Phase 3 — Bisect, do not guess

Now you have a small red command. Find the cause by halving the search space, not by inspecting the most suspicious-looking code.

You are always bisecting along one of these axes:

- **Time.** It worked before and does not now. `git bisect` the commit range. This is the cheapest answer available and it is criminally underused — if a good commit exists, start here.
- **Space.** The bug is somewhere between the entry point and the output. Assert what you believe to be true at the midpoint of the pipeline. Correct there? The bug is downstream. Wrong there? Upstream. Repeat.
- **State.** It fails with this input and not that one. Move the two inputs toward each other one field at a time until a single change flips red to green.

Each probe must be able to come back either way. If you already know what the assert will print, it is not a probe — it is a comfort blanket, and it costs you a cycle.

**Look at the actual value.** Print it, dump it, breakpoint it. Do not print "reached here". Print the thing itself, and read it. Half of all bugs are visible the moment someone looks at the real value instead of the value they assumed was there.

## Phase 4 — Name the cause

You have the cause when you can say, in one sentence, *why* the code produces the wrong result — and then, from that sentence alone, correctly predict a second thing that should also be broken.

Go check that prediction. If it holds, you understand the bug. If it does not, you have found a correlation and are about to fix the wrong thing.

Distinguish two layers, out loud:

- **Mechanism** — the line that misbehaves. "It reads `user.id` but the object at that point is the DTO, where the field is `userId`, so it is `undefined`."
- **Cause** — why that was possible. "Two shapes flow into this function and nothing checks which one arrived."

Fix the mechanism to close the bug. Report the cause, because that is where the *next* three bugs come from.

## Phase 5 — Fix and verify

1. Run the repro. Confirm it is **red**. (Yes, again. You have been editing.)
2. Make the smallest change that addresses the mechanism.
3. Run the repro. Confirm it is **green**.
4. Run the surrounding tests. Confirm you broke nothing.
5. Revert your fix and confirm the repro goes red again.

Step 5 is not paranoia. It is the only thing that proves your change is what fixed it, rather than a cache clearing, a rebuild, or a race that happened to fall the other way this time.

If there was no test covering this bug, the repro from Phase 1 is now that test. Keep it.

## The two-strike rule

**Two failed fixes for the same bug means the diagnosis is wrong.** Not "the fix was incomplete" — *wrong*.

Stop patching. Both attempts were built on a shared assumption, and that assumption is the bug. Name it, then test it directly. This is the single most valuable rule in this file, and it is the one most often ignored, because a third patch always feels closer than starting over.

## Anti-patterns

| You are doing this | Do this instead |
|---|---|
| Reading code looking for something that "looks wrong" | Get the repro. Bisect. |
| Adding logs everywhere at once | One probe at the midpoint. Halve, then halve again. |
| Changing two things to see if the error goes away | One change. Otherwise you cannot attribute the result. |
| "Should be fixed now" | Run the repro. Watch it go green. Then say it. |
| Fixing the symptom the stack trace points at | The trace shows where it *surfaced*, not where it *started*. |
| Trusting the error message's account of itself | Error messages describe the failure, not the cause. Verify. |
| Concluding "it's flaky" | Flaky means there is a race or shared state you have not found. That is a bug, not a weather condition. |

## Report

State it in this order:

1. **What was wrong** — the mechanism, in one sentence.
2. **Why it was possible** — the cause.
3. **What proves it is fixed** — the exact repro command, and that you watched it go red before and green after.
4. **What is still open** — other places the same cause could bite, and anything you assumed but could not check.
