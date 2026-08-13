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
    /\bnpm\s+publish\b/,
    'This package is private and unpublished. Publishing it would push the whole workspace to the public registry.',
  ],
  [
    /\bvercel\s+(deploy|--prod|env\s+rm)\b/,
    'Deploying or removing production env vars is the user\'s call, not an automated step. Ask first.',
  ],
];

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  let command = '';
  try {
    const payload = JSON.parse(raw || '{}');
    // Bash uses `command`; the PowerShell tool uses the same field name.
    command = String(payload.tool_input?.command || '');
  } catch {
    // A guard that crashes on unexpected input must fail open, not wedge every
    // shell call in the session.
    process.exit(0);
  }

  for (const [pattern, why] of RULES) {
    if (pattern.test(command)) {
      process.stderr.write(`Blocked by .claude/hooks/guard-bash.js\n\n${why}\n`);
      process.exit(2);
    }
  }

  process.exit(0);
});
