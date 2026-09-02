---
name: token-budget
description: Use when changing anything that goes into a prompt — the tool catalogue, the system prompt, a project's sources, what a tool returns. Covers what is paid per step versus per turn, and how to measure rather than guess.
---

# What a change costs, per step

The one thing to internalise: **most of what you add to a prompt is paid once
per step, not once per turn.** A twenty-step job re-sends the tool catalogue and
the system prompt twenty times. A sentence that looks free in review costs
twenty times its length in production.

## The four things that are re-sent every step

| what | measured | where |
|---|---|---|
| tool catalogue | ~6,500 tok with deferral, ~12,000 without | `server/tools/definitions.js` |
| system prompt | grows with worker, connectors, MCP, project briefing | `buildSystemPrompt` |
| transcript | everything since the last summary | `activeTranscript` |
| tool results | forever, once returned | wherever the tool returns |

The last one surprises people. A `web_fetch` that drops 20,000 characters into
the transcript is not a one-off: it is re-sent on every remaining step of the
turn. That is exactly why `extract` exists — it reads the page in a call of its
own and returns only the answer.

## Measure, do not estimate

```
node -e "import('./server/tools/definitions.js').then(({availableTools,TOOLS})=>{
  const est=l=>Math.round(JSON.stringify(l.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))).length/4);
  const o={workerOnline:true,desktopOnline:true,policy:'guarded',connected:[],providers:[],context:200000};
  console.log('deferred:', est(availableTools({...o,activated:new Set()})));
  console.log('everything:', est(availableTools({...o,activated:new Set(TOOLS.map(t=>t.name))})));
})"
```

`test/toolbudget.test.mjs` pins the numbers this produces. If you add tools and
that suite still passes, check it is actually measuring what you changed rather
than assume you got away with it.

## Before adding a tool

Ask whether it belongs in `DEFERRABLE`. The rule is not "how useful is it" —
it is **how soon after the question does a turn need it**. Reading a file,
running a command, driving the browser: immediately, so they stay loaded.
Writing a spreadsheet, posting to Slack, defining a workflow: those can afford
one round trip, so they wait to be asked for.

Getting this wrong in the safe direction costs one extra step in the rare turns
that need the tool. Getting it wrong the other way costs its schema on every
step of every turn forever.

## Before adding to the system prompt

Two questions.

**Does it change per turn?** If so it does not belong in the system block at
all. That block carries the cache breakpoint, and prompt caching is a prefix
match — a system prompt that changes every turn does not merely fail to cache
itself, it invalidates the whole transcript behind it. This is what
`projectPrompt` got wrong for a long time; see `withProjectSources` for where
question-specific text goes instead.

**Would a shorter version do the same work?** The prompt is guidance, not
documentation. A paragraph that stops the model reaching for the wrong tool
earns its place; one that restates what a tool description already says does not.

## Checking whether caching is actually working

`usage.cache_read_input_tokens` is the only honest answer, and it is recorded
per call in `usage_events.cache_read_tokens`. Zero across repeated turns in one
conversation means something in the prefix is changing — a timestamp, a
reordered object, a varying tool set.

## Where the money actually goes

`store.usageByRole()` breaks spend down by what asked for it: the turn itself,
a sub-agent fan-out, a compaction, a research role, a page extraction. Before
optimising anything, look at that. The intuition about which of those dominates
is wrong about half the time, and compaction on a long conversation is usually
larger than people expect.
