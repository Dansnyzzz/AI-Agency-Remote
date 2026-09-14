#!/usr/bin/env node
/**
 * One answer to "is the fence around `main` up right now?"
 *
 * This existed twice, in effect. `guard-bash.js` decided it, and `brief.js`
 * announced it — separately, from nothing. So when the owner's switch was added
 * the guard learned about it and the briefing did not, and every session opening
 * on `main` was told *"commits here are blocked by guard-bash.js"* while the
 * guard was letting commit, merge and push straight through.
 *
 * That is the worst shape a safety message can take. A missing warning makes an
 * agent cautious; a warning that is confidently wrong makes it rely on a stop
 * that is not there. The fix is not a better sentence in `brief.js` — it is that
 * there is one place that knows, and both files read it.
 */

import process from 'node:process';
import { spawnSync } from 'node:child_process';

export const PROTECTED_BRANCH = /^(main|master)$/;

/**
 * Has the owner opened the gate on the protected branch?
 *
 * Protection is on unless `AI_REMOTE_ALLOW_MAIN` is set in the environment
 * Claude Code itself runs in — `.claude/settings.json` under `env`, or an export
 * before `claude` starts.
 *
 * That the switch lives in the *environment* is the whole point, and it is worth
 * saying why, because the obvious alternative does not work.
 *
 * The guard runs as a PreToolUse hook: Claude Code spawns it, hands it the
 * proposed command as JSON on stdin, and only runs the shell if it exits 0. The
 * hook's `process.env` is Claude Code's, not the shell's. So writing
 * `AI_REMOTE_ALLOW_MAIN=1 git push origin main` sets nothing here — that
 * assignment would be executed by a shell that has not started yet, by a command
 * this hook is deciding whether to permit. The model cannot type its way past
 * this the way it could past a flag in the command string.
 *
 * Turning it on is therefore a deliberate act by a person editing a file, and it
 * is visible in that file afterwards rather than buried in one command in a
 * transcript.
 *
 * It lifts exactly three rules — commit, merge and push on the protected branch.
 * Force-push, `reset --hard`, `rm -rf`, `DROP TABLE`, `npm publish` and
 * `vercel deploy` are not branch protection and are never lifted by it.
 */
export const mainWritesAllowed = () =>
  /^(1|true|yes)$/i.test(String(process.env.AI_REMOTE_ALLOW_MAIN || ''));

/**
 * Which branch a hook should believe it is on.
 *
 * `CLAUDE_GUARD_BRANCH` overrides the real one. That is not a back door — the
 * guard's rules only ever get *stricter* when it names a protected branch, and
 * a test that has to be run on `main` to exercise the `main` rules is a test
 * that cannot be run. `hooks.test.mjs` states the branch it means instead of
 * inheriting whatever the checkout happens to be, which is the same lesson
 * CFG-011 taught about the switch above.
 */
export function currentBranch(cwd = process.cwd()) {
  if (process.env.CLAUDE_GUARD_BRANCH) return process.env.CLAUDE_GUARD_BRANCH;
  try {
    const run = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
    });
    return run.status === 0 ? String(run.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

/**
 * The sentence `brief.js` opens a session with, and the reason this module
 * exists. Three states, and the middle one is the one that used to be lied
 * about.
 */
export function branchNote(name) {
  if (!PROTECTED_BRANCH.test(name)) return '.';
  if (mainWritesAllowed()) {
    return ' — **protection is LIFTED here.** `AI_REMOTE_ALLOW_MAIN` is set in the'
      + ' environment, so guard-bash.js permits commit, merge and push on this'
      + ' branch. Nothing mechanical will stop you; branch anyway unless the owner'
      + ' asked for this specific change to land on main.';
  }
  return ' — commits here are blocked by guard-bash.js; branch before building.';
}
