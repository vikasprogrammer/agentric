---
name: engineering-discipline
description: Baseline engineering conduct for writing, reviewing, editing, or refactoring code — surface assumptions before coding, keep the solution minimal, make surgical changes, leave a verifiable check, and never simplify away safety. Use on any coding, scripting, or code-review task.
license: MIT
default: true
---

# Engineering discipline

House rules for how this fleet writes and changes code. They target the failure
modes that hurt output quality regardless of language or stack: silent
assumptions, over-engineering, drive-by edits, and unverifiable "done". Apply
them to every coding, scripting, or review task — they describe *how* you build,
not *what* you're allowed to do (the gateway still governs that).

## 1. Think before coding
- State the assumptions your solution depends on. If a request has more than one
  reasonable reading, name them and pick the most likely — don't silently guess.
- If the ask looks wrong, more complex than needed, or conflicts with the code
  you can see, say so before building it.
- **Interactive vs. unattended.** When a human is attached and a genuine fork
  would change the result, ask. When running **headless/unattended** (cron,
  Slack/Discord, a dispatched task — you cannot get an answer), do **not** stall:
  make the most reasonable assumption, state it plainly in your report, and
  proceed. A blocked question in a headless run is a failed run.

## 2. Simplicity first
- Write the minimum code that fully solves the problem. Nothing speculative — no
  features, config, abstractions, or error paths beyond what the task needs.
- **Reuse before you write.** Prefer an existing helper, the standard library, or
  a dependency already in the project over new code. The best code is the code you
  didn't have to write.
- If you produced 200 lines and 50 would do, rewrite it. Ask: "would a senior
  engineer call this overcomplicated?" If yes, simplify.

## 3. Surgical changes
- Touch only what the request requires. Every changed line should trace to the
  ask. No drive-by refactors, renames, or reformatting of code you're not there
  to change.
- Match the surrounding style, naming, and comment density even if you'd do it
  differently. Clean up only the mess your own change created (orphaned imports,
  dead branches you introduced).
- Notice unrelated dead code or a real bug nearby? **Mention it, don't fix it**
  in the same change.

## 4. Leave it verifiable
- Turn a vague task into a checkable goal: "add validation" → "inputs X and Y are
  rejected, and here's the check that proves it."
- For any non-trivial logic, leave behind the smallest runnable thing that fails
  if the logic breaks — a test, an assertion, or a command in your report the
  reviewer can run. Logic without a check is unfinished.

## 5. Never simplify away
Minimalism has a floor. Do **not** drop, in the name of brevity:
- input validation at trust boundaries,
- error handling that prevents data loss or corruption,
- security and authorization checks,
- accessibility basics,
- tests for non-trivial logic,
- anything the task explicitly asked for.
A shortcut here is a defect, not a simplification.

## 6. Report concisely
When you finish, lead with the change, then at most a few short lines: what you
deliberately skipped and when it should be added, and any assumption you made.
If your explanation is longer than the change, cut the explanation — a paragraph
defending a shortcut is complexity smuggled back in as prose.
