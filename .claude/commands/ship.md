---
description: Take one piece of work from idea to a reviewed, tested, committed branch without stopping at every step.
argument-hint: [what to build or fix]
allowed-tools: Bash, PowerShell, Read, Grep, Glob, Edit, Write, Task, TodoWrite
---

Carry **$ARGUMENTS** through the whole loop in CLAUDE.md §1 — Explore, Plan,
Build, Verify — and stop only where stopping is genuinely the user's call.

The point of this command is that the checks happen *because the loop runs them*,
not because someone remembered. Where a step delegates, delegate: a subagent
reads what it needs in its own context and reports back, which is what keeps the
main conversation able to hold the whole job.

## 1. Branch first

```
git rev-parse --abbrev-ref HEAD
```

On `main` or `master`, create a branch now — `git checkout -b <short-name>`.
`guard-bash.js` blocks commits on the protected branch, so discovering this at
commit time wastes the work in between.

## 2. Explore

Read the code that will change and the code that calls it. Follow the existing
conventions rather than importing habits from elsewhere. Note every other place
that shares the thing you are about to touch — CLAUDE.md §0: a display bug in a
shared component is a display bug everywhere it is used.

Delegate breadth to the `Explore` agent when the sweep is wide. Keep depth here.

## 3. Plan — and stop

Write the plan out: what changes, in what order, what could break, what you
deliberately are **not** doing. Name the trade-offs.

**Stop here and show it.** This is the first of only two required stops, and it
is the cheap one — a wrong plan caught now costs a paragraph, caught after the
build it costs the build. Use Plan Mode for anything touching several files, the
schema, an API contract, or auth.

## 4. Build, test-first

Write the failing test before the code that passes it. In this repo that means a
plain `.mjs` suite under `test/` — no framework, no `describe`/`it`; read
`test/deploy.test.mjs` for the shape, and add any new suite to the `test` script
in `package.json` or it will not run in CI. The `qa-tester` agent knows where
each kind of test belongs.

Anything touching per-account data goes in `isolation.test.mjs`. That is not a
style preference: it is the suite that runs real SQL and then tries to cross the
boundary between two accounts.

Commit as you go, in small pieces that each make sense on their own. Commits on a
feature branch are allowed without asking; that is what the branch is for.

## 5. Prove it

```
npm run gate
```

Let it finish — it runs lint, twenty-four suites, and the hook tests, and stamps
the ledger only if all three exit clean. Nothing else can write that stamp, so
there is no shortcut worth looking for.

Red twice for the same reason is the **second required stop**: bring it back with
what failed and what you think it means, rather than trying a third variation
alone. Two failures with one cause usually means the plan was wrong, and that is
a conversation, not a debugging loop.

`npm run gate -- --fast` exists for the middle of the work — lint and hooks only,
seconds instead of minutes. It is real evidence but not the whole gate, and it
will not satisfy the completion check.

## 6. Review before you believe yourself

Hand the finished diff to `code-reviewer`. Where the change touched auth, routes,
the store or the tool catalogue, hand it to `security-auditor` as well. Both read
it cold, which is the entire value — you cannot review a diff you are still
anchored to.

Take the findings seriously and verify them; a review comment can be wrong, and
agreeing with a wrong one is its own failure.

## 7. Report what happened

Say which gates ran and what they said. Name what is still unverified — anything
needing a live model, a real browser, or a device you do not have. CLAUDE.md §10:
do not claim there are no bugs; claim exactly which checks passed.

Then stop. Merging, pushing and deploying are the user's, and the guards will say
so if you forget.
