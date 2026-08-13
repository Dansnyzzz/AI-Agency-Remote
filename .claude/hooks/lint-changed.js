#!/usr/bin/env node
/**
 * PostToolUse: lint the one file that just changed.
 *
 * CLAUDE.md §5 requires lint to be clean before anything is called done. Waiting
 * until then to find out is the expensive order: by the time the suite runs, the
 * mistake is twenty edits back and the fix is a hunt. Linting the single file at
 * the moment it is written turns that into a sentence of feedback.
 *
 * One file, not the project — this runs after *every* edit, and `eslint .` over
 * a tree this size on each keystroke-sized change is the kind of tax that gets a
 * hook deleted.
 *
 * Exit 2 feeds stderr back to the model so it fixes the file it is still holding
 * in mind. Everything else exits 0: a missing eslint, a config error or a file
 * outside the lint scope must not block editing.
 */

import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  let file = '';
  let root = process.cwd();
  try {
    const payload = JSON.parse(raw || '{}');
    file = String(payload.tool_input?.file_path || '');
    root = String(payload.cwd || process.cwd());
  } catch {
    process.exit(0);
  }

  // The flat config covers JS only. Skipping quietly beats reporting a
  // non-problem on every markdown edit.
  if (!/\.(js|mjs|cjs)$/i.test(file)) process.exit(0);

  const rel = path.relative(root, path.resolve(root, file));
  if (rel.startsWith('..')) process.exit(0);
  // eslint.config.js ignores these; asking it to lint them prints a warning.
  if (/^(node_modules|data)[\\/]/i.test(rel)) process.exit(0);

  const run = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['eslint', '--format', 'compact', rel],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );

  // eslint exits 1 for lint errors and 2 for its own failures. Only the first is
  // the model's problem; a broken config is not something it should react to by
  // rewriting the file it just wrote.
  if (run.status === 1 && run.stdout.trim()) {
    process.stderr.write(`eslint found problems in ${rel}:\n\n${run.stdout.trim()}\n`);
    process.exit(2);
  }

  process.exit(0);
});
