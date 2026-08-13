#!/usr/bin/env node
/**
 * PreToolUse guard for Edit / Write / NotebookEdit.
 *
 * Some files in this tree look editable and are not. `data/pgdata` is a live
 * Postgres cluster in a binary on-disk format; `package-lock.json` is generated;
 * `.env` holds the two secrets that, if replaced, sign everyone out and orphan
 * every stored API key (server/secrets.js explains why those are separate).
 *
 * Writing to any of them by hand is never the intended fix, and the failure is
 * silent and late — a corrupted cluster does not complain until the next read.
 *
 * Exit 2 blocks; stderr is the reason the model sees.
 */

import process from 'node:process';
import path from 'node:path';

/** [matcher, why] — matcher runs against the path relative to the project root. */
const PROTECTED = [
  [
    (p) => /^data[\\/]pgdata/i.test(p),
    'This is the live local Postgres cluster, stored in a binary format. Change server/store/schema.sql and let the migration run instead.',
  ],
  [
    (p) => /^data[\\/]/i.test(p) && !/^data[\\/]samples[\\/]/i.test(p),
    'data/ is runtime state, not source. It is gitignored and rebuilt on demand — edit the code that writes it.',
  ],
  [
    (p) => /^\.env$/i.test(p) || /^worker[\\/]\.env$/i.test(p),
    'Editing .env can replace SESSION_SECRET or ENCRYPTION_KEY. Losing ENCRYPTION_KEY makes every stored provider key permanently undecryptable. Ask the user to change it, and document the variable in .env.example instead.',
  ],
  [
    (p) => /^package-lock\.json$/i.test(p),
    'This file is generated. Run the npm command that produces the change (npm install <pkg>) so the tree and the lockfile agree.',
  ],
  [
    (p) => /^node_modules[\\/]/i.test(p),
    'Editing a dependency in place is undone by the next install. Patch it in your own code, or pin a different version.',
  ],
];

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  let file = '';
  let root = '';
  try {
    const payload = JSON.parse(raw || '{}');
    file = String(payload.tool_input?.file_path || payload.tool_input?.notebook_path || '');
    root = String(payload.cwd || process.cwd());
  } catch {
    process.exit(0); // fail open rather than wedging every edit
  }

  if (!file) process.exit(0);

  // Compare relative to the project root so an absolute path and a relative one
  // are judged the same way.
  let rel;
  try {
    rel = path.relative(root, path.resolve(root, file));
  } catch {
    process.exit(0);
  }

  // Outside the project entirely — not this hook's business.
  if (rel.startsWith('..')) process.exit(0);

  for (const [matches, why] of PROTECTED) {
    if (matches(rel)) {
      process.stderr.write(`Blocked by .claude/hooks/guard-write.js\n\n${rel}\n${why}\n`);
      process.exit(2);
    }
  }

  process.exit(0);
});
