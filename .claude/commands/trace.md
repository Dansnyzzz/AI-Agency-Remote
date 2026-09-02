---
description: Follow one agent turn end to end, from the id the browser saw.
---

Debug a turn using its correlation id, rather than by guessing which log lines
belong together.

## Getting the id

Every response carries `X-Request-Id`. A person reporting a problem can read it
from the network tab, or you can find the turn by account and time.

The id is in scope for everything that turn goes on to do — the agent loop, the
provider adapters, the tool executor — because it lives in `AsyncLocalStorage`
rather than being passed down. So every line the turn emitted carries it, and
nothing else does.

## Reading the trail

```
LOG_FORMAT=json npm run dev
```

Then filter on the id. The lines worth knowing:

| line | what it tells you |
|---|---|
| `turn started` | the model, and the moment the clock starts |
| `tools activated` | the model asked for a deferred tool — one extra step, by design |
| `role routed to a cheaper model` | a compaction or extraction moved off the flagship |
| `compaction failed` | the transcript could not be folded; the turn carried on and will fail on its own terms |
| `turn ended` | `ms` for the whole turn, including every resumed leg |

`ms` on `turn ended` is wall clock for one HTTP leg, not for the whole
conversation. A hosted run that was killed at the function timeout and resumed
produces several of these under one `runId` — that is the loop working, not a
fault.

## When there is no trail

Two honest possibilities, and they look identical from the outside:

- The turn never reached the server. Check the browser first.
- It reached a *different instance*. On a deployment each invocation is its own
  process, and nothing is aggregated anywhere by default — the platform's log
  view is the only place the lines are together.

## What is deliberately not logged

Message text, tool inputs and tool outputs. They are the most useful thing you
could want and they are the user's private work, on their own machine. What is
logged is the shape of the turn: which tools, how long, what failed. If you
genuinely need the content, ask the person for it rather than harvesting it.
