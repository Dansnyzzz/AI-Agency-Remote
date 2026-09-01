#!/usr/bin/env node
/**
 * PreToolUse guard for Bash / PowerShell calls.
 *
 * CLAUDE.md §2 draws the line plainly: a risk that can happen at any moment must
 * not merely be written down, it has to be enforced by code. A rule in a prompt
 * is a rule the model can talk itself out of at 2am on turn ninety; a non-zero
 * exit code is not.
 *
 * Exit 2 blocks the call and hands stderr back to the model as the reason, which
 * is why every message below says what to do instead rather than just "no".
 *
 * Deliberately narrow. A guard that blocks half of what a developer legitimately
 * types gets switched off within a week, and then it protects nothing at all.
 */

import process from 'node:process';
import { spawnSync } from 'node:child_process';

/**
 * The branch HEAD is on, or '' when that cannot be answered.
 *
 * Every rule below that uses this fails open when it is empty. A guard that
 * blocks because it could not run `git` is a guard that blocks in a worktree, in
 * a fresh clone, and on the day git is slow — which is to say, a guard that gets
 * removed.
 */
function currentBranch(cwd) {
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

const PROTECTED_BRANCH = /^(main|master)$/;

/** Each rule is [pattern, why]. `why` is read by the model, so it must be actionable. */
const RULES = [
  [
    /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/,
    'Recursive force-delete. Delete the specific paths you mean, or ask the user to run it themselves.',
  ],
  [
    // `--force-with-lease` must survive this, or the guard blocks the exact fix
    // its own message recommends — so `--force` needs the lookahead. `\b` alone
    // does not do it: the boundary matches at the hyphen.
    /\bgit\s+push\b[^\n|;&]*\s(--force(?!-with-lease)|-f)\b/,
    'Force-push rewrites published history. Use --force-with-lease, and only on a branch you own.',
  ],
  [
    /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)\b/,
    'This throws away uncommitted work irreversibly. Stash it first (git stash -u), then decide.',
  ],
  [
    /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    'Dropping a table or database destroys user data. Write a migration in server/store/schema.sql instead.',
  ],
  [
    /\bTRUNCATE\s+/i,
    'TRUNCATE empties a table with no undo. If this is a test fixture, scope it to the test database.',
  ],
  [
    // The local Postgres cluster lives here. Deleting it destroys every local
    // account, chat and stored key, and none of it is anywhere else.
    /\b(rm|rmdir|del|Remove-Item)\b[^\n|;&]*\bdata[\\/](pgdata|owner\.pid)/i,
    'data/pgdata is the local Postgres cluster — every account, chat and encrypted key lives there. Deleting it is not recoverable.',
  ],
  [
    /\b(rm|del|Remove-Item)\b[^\n|;&]*(^|[\s"'\\/])\.env(\s|$|["'])/i,
    '.env holds SESSION_SECRET and ENCRYPTION_KEY. Losing ENCRYPTION_KEY makes every stored provider key permanently undecryptable.',
  ],
  [
    // Naming the protected branch explicitly reaches it from anywhere, so this
    // one cannot be left to the current-branch rules below.
    /\bgit\s+push\b[^\n|;&]*\s(\S+\s+)?(main|master)(:\S+)?\s*$/,
    'This pushes the protected branch. Push the feature branch instead, and let the user decide what lands on main.',
  ],
  [
    /\bnpm\s+publish\b/,
    'This package is private and unpublished. Publishing it would push the whole workspace to the public registry.',
  ],
  [
    /\bvercel\s+(deploy|--prod|env\s+rm)\b/,
    'Deploying or removing production env vars is the user\'s call, not an automated step. Ask first.',
  ],
];

/**
 * Rules that apply only while HEAD is on `main` or `master`.
 *
 * The working agreement for an unattended run is: change code, run the gate,
 * commit — on a branch of its own. Merging, pushing and deploying stay with the
 * user. Written down, that agreement lasts until the first turn that finds it
 * inconvenient; here, it is an exit code.
 *
 * Note what is *not* here. Pushing a feature branch is not blocked — it is
 * simply absent from the allowlist in settings.json, so it asks. Blocking is for
 * what should never happen unattended; asking is for what needs a human present.
 */
const BRANCH_RULES = [
  [
    /\bgit\s+commit\b/,
    'This would commit straight onto the protected branch. Create a branch first (git checkout -b <name>), commit there, and let the user decide what lands.',
  ],
  [
    /\bgit\s+merge\b/,
    'Merging into the protected branch is the user\'s call. Leave the work on its branch and say it is ready.',
  ],
  [
    /\bgit\s+push\b/,
    'Pushing the protected branch publishes history the user has not reviewed. Push a feature branch instead — that asks rather than blocks.',
  ],
];

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  let command = '';
  let cwd = process.cwd();
  try {
    const payload = JSON.parse(raw || '{}');
    // Bash uses `command`; the PowerShell tool uses the same field name.
    command = String(payload.tool_input?.command || '');
    cwd = String(payload.cwd || process.cwd());
  } catch {
    // A guard that crashes on unexpected input must fail open, not wedge every
    // shell call in the session.
    process.exit(0);
  }

  const refuse = (why) => {
    process.stderr.write(`Blocked by .claude/hooks/guard-bash.js\n\n${why}\n`);
    process.exit(2);
  };

  for (const [pattern, why] of RULES) {
    if (pattern.test(command)) refuse(why);
  }

  // Only ask git which branch this is once something git-shaped has been typed —
  // most commands are not, and a subprocess on every shell call is a tax paid
  // all day for a rule that applies to a handful of them.
  if (/\bgit\s+(commit|merge|push)\b/.test(command)) {
    const branch = process.env.CLAUDE_GUARD_BRANCH || currentBranch(cwd);
    if (PROTECTED_BRANCH.test(branch)) {
      for (const [pattern, why] of BRANCH_RULES) {
        if (pattern.test(command)) refuse(`On branch \`${branch}\`. ${why}`);
      }
    }
  }

  process.exit(0);
});
