#!/usr/bin/env node
/**
 * Stop / SubagentStop: do not let "it's done" out without evidence.
 *
 * CLAUDE.md §5 lists the gate and §10 says to report what actually ran rather
 * than what probably would have. Both are prose. This is the version that holds
 * at three in the morning on turn ninety of an unattended run, when the model
 * saying "all tests pass" has not, in fact, run any.
 *
 * The hard part is not detecting the claim, it is *not* firing the rest of the
 * time. A guard that interrupts every answer to a question gets switched off
 * within a week, and then it protects nothing — the same argument the other
 * guards in this directory are built on. So it blocks only where both halves are
 * true:
 *
 *   1. something changed that no completed gate covers, and
 *   2. the last thing said was a claim that the work is finished.
 *
 * Ask a question, get an answer, explain a file, read some code — none of that
 * is touched. Only the claim is.
 *
 * When there is unproven work but no claim, it says so as context rather than
 * blocking: a note, not a wall.
 */

import { readPayload, context, block, pass } from './io.js';
import { status } from './gate.js';

/**
 * Claims of completion, in both languages this repo is worked in.
 *
 * This list will be wrong in both directions and that is affordable. A false
 * positive costs one run of `npm run gate`. A miss costs one block that did not
 * happen. Neither loses work, which is why a blunt list beats a clever one.
 */
const CLAIMS = [
  // English
  /\b(all|the)?\s*tests?\s+(now\s+)?(pass|passed|passing|are\s+green)\b/i,
  /\ball\s+green\b/i,
  /\b(it'?s|that'?s|this\s+is|work\s+is|now)\s+(done|complete|finished)\b/i,
  // A line that is only "Done." — the commonest way of saying it in English,
  // and the Vietnamese half of this list already caught the bare "xong".
  // Anchored to a whole line so "not done yet" and "when done, run the gate"
  // are left alone.
  /(^|\n)\s*(all\s+)?done[.!]*\s*(\n|$)/i,
  /\b(implementation|change|feature|fix|task)\s+is\s+(done|complete|finished)\b/i,
  /\bready\s+to\s+(merge|ship|deploy|review)\b/i,
  /\bverified\b/i,
  /\bgate\s+is\s+green\b/i,
  // Vietnamese
  /\bxong\b/i,
  /hoàn\s*thành/i,
  /đã\s+(sửa|fix|test|kiểm\s*thử|chạy\s+test)/i,
  /chạy\s+test\s+(rồi|xong)/i,
  /(tất\s*cả|toàn\s*bộ)\s+test\s+(đều\s+)?(pass|xanh|qua)/i,
  /sẵn\s+sàng\s+(merge|deploy|triển\s*khai)/i,
];

/**
 * Words that turn a claim into its opposite. "not done yet" and "chưa xong" are
 * the honest reports this guard exists to encourage; blocking them would teach
 * exactly the wrong lesson.
 */
const NEGATED = /(ch[uư]a|kh[ôo]ng|not|isn'?t|aren'?t|won'?t|cannot|can'?t|no\s+longer)[\s\S]{0,16}$/i;

export function claimsCompletion(message) {
  const text = String(message || '');
  if (!text.trim()) return false;

  for (const re of CLAIMS) {
    const m = re.exec(text);
    if (!m) continue;
    // Look at what immediately precedes the match rather than the whole message:
    // a "not" three paragraphs earlier has nothing to do with this sentence.
    if (NEGATED.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    return true;
  }
  return false;
}

const payload = await readPayload();
const event = payload.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'Stop';

// The harness caps consecutive blocks and then forces the turn to end anyway.
// Once it has told us it is retrying, standing in the way a second time buys
// nothing and burns the cap.
if (payload.stop_hook_active) pass();

let state;
try {
  state = status();
} catch {
  pass(); // A ledger that cannot be read is not grounds for stopping the work.
}

const unproven =
  state.pending.length > 0 || state.fastOnly || (Boolean(state.lastGreen) && !state.current);

// Nothing changed, or the full gate already covers what did.
if (!unproven || state.verified) pass();

const names = state.pending.map((p) => p.file);
const shown = names.slice(0, 6).join(', ');
const more = names.length > 6 ? ` and ${names.length - 6} more` : '';

/**
 * Say which of the three reasons this actually is.
 *
 * The first version said "0 file(s) changed with no green gate since — the
 * working tree" after a commit, which is both confusing and untrue: nothing had
 * changed, the stamp had simply stopped matching HEAD. A guard that describes
 * the situation wrongly is one people learn to skim.
 *
 * A commit does invalidate the stamp, deliberately. The alternative is
 * fingerprinting the bytes on disk independently of git, and every cheap way of
 * doing that either touches the index or costs a full tree walk on every Stop.
 * Re-proving after a commit is the conservative side to err on, so long as it
 * says so plainly rather than inventing a changed file.
 */
const reason = names.length
  ? `Unproven: ${shown}${more}`
  : state.fastOnly
    ? 'The last stamp was the fast gate — lint and hooks only, not the 24 suites.'
    : 'The last green run no longer matches this tree — there has been a commit or an edit since.';

if (claimsCompletion(payload.last_assistant_message)) {
  const who =
    event === 'SubagentStop' ? `The ${payload.agent_type || 'sub'}-agent` : 'That message';

  block(
    `Blocked by .claude/hooks/verify-stop.js\n\n` +
      `${who} says the work is finished, but the gate has not run against what is ` +
      `on disk now.\n\n` +
      `${reason}\n` +
      (names.length && state.fastOnly
        ? `The last stamp was the fast gate — lint and hooks only, not the 24 suites.\n`
        : '') +
      `\nRun \`npm run gate\` and let it finish, then say what it actually reported ` +
      `(CLAUDE.md §5, §10).\nIf the claim was about something the gate does not ` +
      `cover, say that plainly instead — an honest "not verified" is never blocked.`,
  );
}

// No claim was made, so there is nothing to stop. Say what is outstanding and
// get out of the way.
context(
  event,
  `Ledger: ${reason} Run \`npm run gate\` before describing this work as finished.`,
);
