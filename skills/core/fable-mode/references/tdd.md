---
name: tdd
description: Use when implementing a feature, a bugfix, or any change whose correctness you would otherwise have to eyeball. Writes the failing test first, watches it fail for the right reason, then writes the least code that passes. Use when the user says "TDD", "test first", "write tests for this", or when a change is easy to get subtly wrong and "it looked right" is not good enough.
license: MIT
---

# Test-Driven Development

TDD is not a testing technique. It is a design technique that leaves tests behind as a by-product.

The point is not coverage. The point is that writing the test first forces you to state what "correct" means *before* you are emotionally invested in an implementation — which is the only moment you can still state it honestly.

## The loop

**Red → Green → Refactor.** One behaviour at a time. Never two.

### Red — write a test that fails

Write the smallest test that asserts one behaviour that does not exist yet.

Then **run it and watch it fail.** This is not a formality. You are verifying three things at once:

- The test actually runs (it is not skipped, misnamed, or in a file the runner ignores).
- It fails for the **reason you expect** — the assertion, not an import error, a typo, or a missing fixture. A test that fails because the module does not exist has told you nothing.
- The failure message would make sense to someone who did not write it.

**A test you have never seen fail is not a test.** It is a line of code you are hoping does something. Passing tests that have never failed are the most expensive kind of technical debt, because they buy false confidence at full price.

### Green — write the least code that passes

Not the elegant code. Not the general code. The *least* code.

Hardcoding the expected return value is legitimate here, and it is not a joke — if `return 42` makes the test pass, the test is not yet specifying the behaviour you meant, and you have just learned that for free. Write the next test that forbids the hardcode.

Resist building for the second test while writing the first. That instinct is where speculative generality comes from, and it is much harder to remove later than to add now.

Run the test. Watch it go green. Run the rest of the suite. Watch nothing else break.

### Refactor — now make it good

Only with a green bar. Only with the tests as your net.

Rename things to what they actually are. Collapse the duplication. Pull out the seam that has become obvious now that the code exists. Delete anything you wrote that no test demands.

Run the tests after each move. If a refactor turns the bar red, you did not refactor — you changed behaviour. Undo it.

**Do not skip this step.** A codebase built by TDD without the refactor step is worse than one built without TDD at all: all the ceremony, none of the design payoff.

## What to test

Test **at the seams you would keep even if you rewrote the internals.** A test coupled to internals is not a safety net — it is a second copy of the implementation that you now also have to maintain, and it will go red every time you improve the code.

The heuristic: *if I rewrote this module from scratch, keeping its public contract, would this test still be valid?*

- **Yes** → good test. It tests behaviour.
- **No** → you are testing implementation. Move it up a level, or delete it.

This means mocking is a smell, not a tool. Every mock is a claim about how the code works internally, frozen into a test. Mock what you cannot control — the network, the clock, the filesystem, payments. Do not mock your own modules just to isolate them; if two of your modules are so tangled that testing one requires faking the other, that is the design telling you something, and the mock is how you avoid hearing it.

## What a test looks like

One behaviour. One reason to fail.

**Arrange** the specific state. **Act** once. **Assert** the observable outcome.

Name it after the behaviour, not the function: `returns_empty_list_when_no_orders_match`, not `test_getOrders_2`. When it goes red at 2am in CI, the name is the only thing on screen — make it a sentence that says what broke.

Assert on the real value, not on a shape. `expect(result).toBeTruthy()` passes for `"undefined"`, `[]`, `{}`, and `NaN`-adjacent nonsense. Assert what it *is*.

Cover the tails deliberately, not exhaustively: the empty case, the single case, the boundary, and the one weird input that the domain actually produces. Three sharp tests beat thirty that all walk the happy path in different costumes.

## When not to TDD

TDD earns its keep where correctness is non-obvious and regressions are expensive. It does not earn it everywhere, and pretending otherwise is how teams learn to resent it.

Skip it for: throwaway spikes and prototypes (see `/prototype` — you are answering a question, not building a thing), pure config, generated code, and exploratory work where you do not yet know what the right answer looks like.

When you do skip it: say so, and say why. "I spiked this without tests to find out whether the API even supports it; now I know it does, I'll rebuild it test-first" is a professional sentence. Silently skipping is not.

## Rhythm

- **Typecheck** constantly. It is the fastest feedback you have; use it as a keystroke, not a step.
- **The single test file** on every red-green cycle. Seconds, not minutes.
- **The full suite** before you call the work done, and before anything leaves your machine.

If the single-file loop is slow enough that you start batching changes to avoid it, stop and fix the loop. A slow test suite does not just cost time — it silently converts TDD back into write-then-hope, and you will not notice it happening.

## Anti-patterns

| You are doing this | Why it is wrong |
|---|---|
| Writing the code, then the test | The test now encodes what the code does, including its bugs. |
| Writing five tests, then the code | You designed five things before validating one. Go one at a time. |
| Never seeing the test fail | You have no evidence it can fail. It may assert nothing. |
| Changing the test to make it pass | The test was the specification. You just moved the goalposts. |
| Testing a private method | It has no contract. Test through the seam that does. |
| Mocking your own module to test its caller | Test them together, or fix the coupling that made this feel necessary. |
| Skipping refactor because it is green | Green is the *permission* to refactor, not the finish line. |

## Report

Say which behaviours you specified, that you watched each test fail before it passed, and the exact command that runs the suite — plus its output. "Tests pass" without the output is a claim, not evidence.
