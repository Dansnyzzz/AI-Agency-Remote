---
description: Check the agent still chooses well — and add a case when it stops.
---

Run the behaviour eval and act on what it says.

```
npm run eval
```

## What a failure means

The eval does not test code paths. It tests whether the assistant is still
*able* to behave correctly — that the right tool is on offer for the question,
that the rule telling it to stop at a sign-in page is still in the prompt, that
uploading a private key is still graded `sensitive`.

So a failure here is almost never "the eval is wrong". It is usually one of:

- a tool moved to the deferred list and is no longer offered on the first step
- a paragraph was edited out of `buildSystemPrompt` during an unrelated rewrite
- a risk pattern stopped matching after `DANGEROUS_COMMAND` was touched
- a project briefing lost a grounding rule

Each case carries a `why` explaining what breaks in the real world when it
fails. Read that before deciding the case is stale.

## What it cannot tell you

Scripted mode says the conditions are in place. It says nothing about what a
model does with them. `npm run eval:live` measures that against a real model —
it costs money per case and is not deterministic, so it belongs in a nightly
run, never in a merge gate.

If somebody reports the assistant *choosing* badly rather than being unable to
choose, scripted mode will pass and the live run is the one to reach for.

## Adding a case

Add to `test/eval/cases.mjs`. A case earns its place when it describes a
failure somebody would actually report, not a property that is convenient to
assert.

Write the `why` first. If you cannot say in one sentence what goes wrong for a
person when this regresses, the case is probably a unit test wearing a costume
and belongs in `test/` instead.

Then check it bites: break the thing on purpose, run the eval, confirm it fails
and names the case. A case that has never failed has never been shown to work.
