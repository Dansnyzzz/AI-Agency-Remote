#!/usr/bin/env node
/**
 * PreCompact: write down the things compaction is worst at keeping.
 *
 * Compaction summarises the conversation, and it is good at *what happened*. The
 * casualty is what was *asked* — the original instructions, the constraints
 * agreed three hours ago, the plan that is half executed. After a compact the
 * run keeps going, fluently, against a slightly wrong brief, and nothing about
 * it looks wrong from the inside. On a long unattended run that is the failure
 * that costs the most, because it is the one nobody notices until the end.
 *
 * So before the window is folded, this pulls the durable facts out of the
 * transcript and puts them in a file. `brief.js` reads it back on the other
 * side, and on every later session start.
 *
 * The transcript shape was read off a real session file rather than assumed:
 * JSONL, one record per line, `type: "user"` entries carrying
 * `message.content[]` blocks. Tool results arrive as `user` records too, which
 * is why they are filtered out — they are the bulk of the file and none of it is
 * an instruction.
 *
 * Never blocks: exit 0 whatever happens. Losing the journal is a worse run;
 * refusing to compact is a dead one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPayload, pass } from './io.js';
import { ROOT, stateDir, readLedger, branch } from './gate.js';

/** Keep the journal small enough that reading it back is never the problem. */
const MAX_BYTES = 8_000;
const MAX_PROMPT = 700;
const MAX_PROMPTS = 12;

const clip = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
};

/** Read a JSONL transcript into records, skipping anything unparseable. */
function records(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written last line is normal while a session is live.
    }
  }
  return out;
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');

/**
 * The instructions, as distinct from everything else wearing the user role.
 *
 * Genuine prompts carry a `promptSource`; harness-injected turns (a skill body,
 * a "continue from where you left off") do not. That discriminator was checked
 * against a real transcript, but it is a detail of one build — so when it
 * selects nothing at all, fall back to every non-tool-result user turn rather
 * than writing an empty journal.
 */
function instructions(recs) {
  const users = recs.filter(
    (r) =>
      r.type === 'user' &&
      r.message &&
      !r.isSidechain &&
      !(Array.isArray(r.message.content) && r.message.content.some((b) => b?.type === 'tool_result')),
  );

  const sourced = users.filter((r) => r.promptSource);
  const chosen = sourced.length ? sourced : users;

  return chosen
    .map((r) => clip(textOf(r.message.content), MAX_PROMPT))
    .filter(Boolean)
    .slice(-MAX_PROMPTS);
}

/** The last task list the run wrote, whatever state it reached. */
function todos(recs) {
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const r = recs[i];
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const call = r.message.content.find((b) => b?.type === 'tool_use' && b.name === 'TodoWrite');
    if (!call) continue;
    const list = call.input?.todos;
    if (!Array.isArray(list)) continue;
    return list.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${clip(t.content, 120)}`);
  }
  return [];
}

function git(args) {
  try {
    const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
    return run.status === 0 ? String(run.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

const payload = await readPayload();
const recs = payload.transcript_path ? records(payload.transcript_path) : [];

const asked = instructions(recs);
const plan = todos(recs);
const ledger = readLedger();
const pending = ledger.pending.map((p) => p.file);

const sections = [
  `# Run journal`,
  ``,
  `Written by \`.claude/hooks/journal.js\` at ${new Date().toISOString()}, just`,
  `before a ${payload.trigger === 'manual' ? 'manual' : 'automatic'} compaction.`,
  `The summary beside this says what happened; this says what was **asked**.`,
  ``,
  `**Branch** \`${branch() || 'unknown'}\``,
  ``,
];

if (asked.length) {
  sections.push(`## What the user asked, in order`, ``, ...asked.map((t) => `${t}\n`), ``);
}

if (payload.custom_instructions) {
  sections.push(`## Compaction instructions given`, ``, clip(payload.custom_instructions, 600), ``);
}

if (plan.length) sections.push(`## Task list as it stood`, ``, ...plan, ``);

if (pending.length) {
  sections.push(
    `## Changed, not yet proven by the gate`,
    ``,
    ...pending.slice(0, 30).map((f) => `- ${f}`),
    ``,
  );
}

const log = git(['log', '--oneline', '-5']);
if (log) sections.push(`## Recent commits`, ``, '```', log, '```', ``);

let body = sections.join('\n');
if (body.length > MAX_BYTES) body = `${body.slice(0, MAX_BYTES)}\n\n… journal truncated.\n`;

/**
 * An unreadable transcript must not cost the journal that is already there.
 *
 * Without this, the one case the journal exists for — a compaction where the
 * record cannot be rebuilt — is also the case where it gets overwritten by a
 * page of branch names and nothing else. Keeping a slightly stale journal beats
 * replacing a good one with an empty one.
 */
const substantive = asked.length > 0 || plan.length > 0;
const target = path.join(stateDir(), 'journal.md');
const alreadyThere = fs.existsSync(target);

if (substantive || !alreadyThere) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(target, body);
  } catch {
    // Nothing to be done about it here, and nothing worth stopping for.
  }
}

pass();
