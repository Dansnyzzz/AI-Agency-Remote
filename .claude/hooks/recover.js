#!/usr/bin/env node
/**
 * PostToolUseFailure: answer the failures this repo actually produces.
 *
 * A failing tool call is where an unattended run either recovers in one step or
 * spends ten turns re-deriving something the repo already knows. Most of the
 * expensive ones here are not subtle — a port still held by a server nobody
 * stopped, a local Postgres that was never initialised, a Playwright suite with
 * no browser installed. Each has one right answer, written down in the codebase,
 * and no reason for anyone to work it out again.
 *
 * The rule that keeps this honest: **say nothing unless a pattern matches.** A
 * hook that offers a guess on every failure trains the reader to skip it, and
 * then the one time it knew the answer, nobody read it. Silence is the default
 * and most failures get it.
 *
 * Never blocks — the tool has already failed; this only adds a sentence.
 */

import { readPayload, context, pass } from './io.js';

/**
 * [pattern, advice]. Patterns are matched against the error text and, where it
 * narrows a false positive, the command that produced it.
 */
const KNOWN = [
  [
    /EADDRINUSE|address already in use|port \d+ is (already )?in use/i,
    'The port is still held — the app defaults to 5173 (server/index.js). Almost always a server or worker from an earlier run that was never stopped, not a code problem. Find the holder and stop it, or start this one with PORT set to something else, rather than changing the default.',
  ],
  [
    /ECONNREFUSED[\s\S]{0,80}(5432|postgres)|could not connect to server|database .* does not exist|role .* does not exist/i,
    'The local Postgres is not up or not initialised. `npm run db:init` creates the cluster under data/pgdata and applies the schema. Do not hand-edit data/pgdata — guard-write.js blocks it, and it is a binary format.',
  ],
  [
    /(SESSION_SECRET|ENCRYPTION_KEY)[\s\S]{0,60}(missing|required|not set|undefined)/i,
    'A required secret is unset. server/secrets.js lists both and why they are deliberately separate. Add it to .env — never to a tracked file — and document the name (not the value) in .env.example. Rotating ENCRYPTION_KEY makes every stored provider key permanently undecryptable, so do not invent a new one to get past this.',
  ],
  [
    /playwright|chromium|browserType\.launch|Executable doesn'?t exist/i,
    "Playwright has no browser to drive. `npx playwright install --with-deps chromium`, which is exactly what CI does before test:ui and test:sandbox. Note that test:ui skips itself when there is nothing to drive — a pass there can mean it never ran.",
  ],
  [
    /Blocked by \.claude[\\/]hooks[\\/]/i,
    'That was a guard in .claude/hooks, not a transient error. It printed what to do instead — do that. Re-running the same command, or working around the guard, is the one response that is always wrong.',
  ],
  [
    /ERR_MODULE_NOT_FOUND|Cannot find module/i,
    'A module is missing. Check the import path first — this repo is ESM ("type": "module"), so relative imports need the file extension. If it is genuinely a new dependency, install it with npm so package.json and the lockfile agree; guard-write.js blocks editing package-lock.json by hand.',
  ],
  [
    /Neon|@neondatabase|fetch failed[\s\S]{0,60}neon/i,
    'That is the serverless Postgres driver. Check DATABASE_URL is set and reachable from here — under VERCEL=1 the code takes different branches, which is what test/deploy.test.mjs exists to cover.',
  ],
];

const payload = await readPayload();

// An interrupt is a person changing their mind, not a fault to recover from.
if (payload.is_interrupt) pass();

const error = String(payload.error || '');
const command = String(payload.tool_input?.command || payload.tool_input?.file_path || '');
const haystack = `${error}\n${command}`;

if (!error.trim()) pass();

const hit = KNOWN.find(([pattern]) => pattern.test(haystack));
if (!hit) pass();

context('PostToolUseFailure', `${payload.tool_name || 'That tool'} failed. ${hit[1]}`);
