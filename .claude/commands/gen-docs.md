---
description: Update documentation to match what the code actually does now.
argument-hint: [area, or leave blank to sweep]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, PowerShell, WebFetch
---

Bring the documentation back in line with the code. This is a verification task
before it is a writing task.

## Where documentation lives

- `README.md` — the long-form user-facing guide
- `docs/` — reasoning with nowhere else to live (`docs/vercel-config.md` exists
  because JSON cannot hold comments and an invented `comment` key fails Vercel's
  schema validation)
- `.env.example` — every variable documented, **never a real value**
- code comments — where a decision and its cost are recorded
- `CLAUDE.md` — the operating constitution. Do not edit without being asked.

## The actual job: find claims that have rotted

Numbers and external limits are believed precisely because they are written
down, and they drift silently. Both of these were live in this repo:

- the tool catalogue comment said "about 7000 tokens" when it had grown past
  10,000
- `vercel.json` and the README, in three places, described a Vercel Hobby cron
  limit that was not the actual limit — and the mistake argued for switching off
  a feature that works

So, in order:

1. **Check every stated number against the code.** Sizes, costs, limits,
   versions, token counts, timeouts. Measure rather than trust.
2. **Check every external claim against the vendor's current docs**, by fetching
   them. Plan limits change.
3. **Check the environment variables** in `.env.example` against what
   `server/secrets.js` and the code actually read.
4. **Check the commands** in the README against `package.json` scripts.
5. **When you correct a claim, grep for it elsewhere.** It is usually repeated.

## Then write

Match the house voice: explain why rather than what, plain declarative prose,
name the concrete failure, concrete numbers over adjectives, no marketing. See
`.claude/agents/technical-writer.md`.

Report what you changed and, specifically, **which claims turned out to be
wrong** — that list is the valuable output, not the word count.
