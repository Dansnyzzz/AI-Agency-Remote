---
description: Performance review against CLAUDE.md §7, weighted for a free-tier deployment.
allowed-tools: Read, Grep, Glob, Bash, PowerShell
---

Audit performance. Measure where you can; where you cannot, look only for the
cheap known anti-patterns rather than speculating (CLAUDE.md §7).

Weight everything by where this actually runs: a **serverless function with no
warm process**, and a **free-tier Postgres over HTTP**.

## 1. Cold start — the free tier's real latency

Every import in the path of a request is paid on a cold invocation.

- `server/store/index.js` imports PGlite **lazily and deliberately**: it is a
  25MB devDependency, and a static import gets it traced into the serverless
  bundle whether or not the branch is taken. `test:deploy` pins this. Look for
  any new static import of something large or local-only.
- Check nothing heavy is imported at module scope in `api/index.js` or
  `server/app.js` that only some routes need.

## 2. The database

The Neon HTTP driver does **one round trip per statement**, so a loop of queries
is a loop of network calls.

- **N+1**: any `await` on a query inside a `for` over rows. This is the single
  most likely real finding.
- **Indexes**: everything filtered or joined on, in `server/store/schema.sql`.
  Nearly every table is scoped by `user_id` — that column earns an index almost
  everywhere.
- **Unbounded reads**: a query with no `LIMIT` over a table that grows forever —
  chats, messages, jobs, usage.
- **Housekeeping**: `sweep()` runs on the local scheduler's minute tick and, on a
  deployment, only from `/api/cron/run-tasks`. Confirm every table that grows is
  actually swept; four of them would otherwise grow without bound.

## 3. The agent loop

- Tool calls that could run concurrently but are awaited in sequence.
- Streaming: the first token must reach the browser as it arrives, not after the
  whole reply is buffered. Buffering also risks the 300s ceiling.
- Anything polling — `runViaWorker` polls at `POLL_MS` (400ms). Check intervals
  are not tighter than the work needs.

## 4. Frontend

`public/js/app.js` is ~150KB and `public/css/app.css` ~154KB, served unbundled.

- Confirm caching headers are right for static assets, since there is no build
  step or content hashing.
- Look for re-render churn on streaming updates: appending a token must not
  re-render the whole transcript.
- Image weight: `public/logo.png` (38KB) is the one served — `index.html`
  references `/logo.png`, which resolves inside `public/`. The 512KB `logo.png`
  at the repo root is a **test fixture** for `edit_image` in
  `test/capabilities.test.mjs` and does not ship. Confirm that is still true
  before "optimising" it away.

## 5. Report

Ranked findings, each with the evidence that it is real. Do not propose
optimisations that trade readability for milliseconds outside a hot path — §7 is
explicit that this is not wanted.
