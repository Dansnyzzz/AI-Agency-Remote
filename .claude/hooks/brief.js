#!/usr/bin/env node
/**
 * SessionStart and PostCompact: start knowing where you are.
 *
 * Two moments look identical from the inside — the first turn of a new session,
 * and the first turn after a compaction. In both, the model is confident and
 * under-informed: it does not know which branch it is on, whether the tree is
 * dirty, whether the last thing anyone proved is still true, or what the run was
 * asked to do before the window folded.
 *
 * Every one of those is cheap to look up and expensive to guess wrong. So this
 * hands them over: a few hundred tokens against a whole run spent on the wrong
 * branch.
 *
 * On PostCompact it pairs with the harness's own summary rather than repeating
 * it. That summary is a good account of what happened; the journal is the record
 * of what was asked, which is the half compaction loses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPayload, pass } from './io.js';
import { ROOT, stateDir, status } from './gate.js';
import { branchNote, currentBranch } from './branch.js';

function git(args) {
  try {
    const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
    return run.status === 0 ? String(run.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

const payload = await readPayload();
const event = payload.hook_event_name === 'PostCompact' ? 'PostCompact' : 'SessionStart';
const lines = [];

/* ---- where the repository stands ---------------------------------------- */

let state = null;
try {
  state = status();
} catch {
  state = null;
}

/*
 * `currentBranch` first, `status()` second — the reverse of the old order.
 *
 * They agree in every ordinary case. They differ when a test names the branch it
 * means via `CLAUDE_GUARD_BRANCH`, and in that case the named one is the answer:
 * this line and the guard have to be describing the same branch, or the sentence
 * below can be right about a branch the guard is not looking at.
 */
const onBranch = currentBranch(ROOT) || state?.branch || 'unknown';
const dirty = git(['status', '--porcelain'])
  .split('\n')
  .filter(Boolean);

/*
 * What this sentence says is now read from the same module the guard enforces
 * from. It used to be built here, from nothing, and said "commits here are
 * blocked" on every protected branch — including after the owner's switch was
 * added, which lifts exactly that block. An agent told the stop is in place
 * leans on it instead of on judgement, so a warning that is confidently wrong
 * is worse than none. See CFG-012 and `branch.js`.
 */
lines.push(`Branch \`${onBranch}\`${branchNote(onBranch)}`);

if (dirty.length) {
  const shown = dirty.slice(0, 8).map((l) => l.trim()).join('; ');
  lines.push(`Working tree dirty (${dirty.length}): ${shown}${dirty.length > 8 ? ' …' : ''}`);
} else {
  lines.push('Working tree clean.');
}

if (state) {
  if (state.verified) {
    lines.push('Gate: green and current — the full suite covers what is on disk.');
  } else if (state.fastOnly) {
    lines.push('Gate: fast stamp only (lint + hooks). The full suite has not run against this tree.');
  } else if (state.pending.length) {
    const names = state.pending.map((p) => p.file);
    lines.push(
      `Gate: ${names.length} file(s) changed with no green run since — ` +
        `${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}. \`npm run gate\` proves it.`,
    );
  } else if (!state.lastGreen) {
    lines.push('Gate: never run in this checkout. `npm run gate` when there is something to prove.');
  } else {
    lines.push('Gate: last stamp no longer matches this tree. Re-run `npm run gate` before claiming anything.');
  }
}

/* ---- what the run was asked to do --------------------------------------- */

let journal = '';
try {
  journal = fs.readFileSync(path.join(stateDir(), 'journal.md'), 'utf8');
} catch {
  journal = '';
}

// A journal from a previous, finished piece of work is noise at the top of a
// fresh session. It is only certainly relevant when picking up mid-run.
const continuing =
  event === 'PostCompact' || ['compact', 'resume', 'fork'].includes(payload.source);

if (journal && continuing) {
  lines.push('', '--- run journal (what was asked, before the window was folded) ---', journal.trim());
} else if (journal) {
  lines.push(
    '',
    'A run journal from an earlier session exists at `.claude/state/journal.md` — read it if this is a continuation.',
  );
}

if (event === 'PostCompact' && payload.compact_summary) {
  lines.push(
    '',
    'The summary above this covers what happened; the journal covers what was asked. Where they disagree, the journal is the instruction.',
  );
}

const text = lines.filter((l) => l !== undefined).join('\n');

// SessionStart can name the session too, which is what makes several of these
// distinguishable when they are running side by side.
const out = { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
if (event === 'SessionStart' && onBranch && onBranch !== 'unknown') {
  out.hookSpecificOutput.sessionTitle = `AI Remote · ${onBranch}`;
}

process.stdout.write(`${JSON.stringify(out)}\n`);
pass();
