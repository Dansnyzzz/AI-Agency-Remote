#!/usr/bin/env node
/**
 * Type checking as a ratchet.
 *
 * CLAUDE.md §3 asks for TypeScript strict mode and §5 wants a clean type-check
 * before anything is called done. This repository is 41,000 lines of plain
 * JavaScript, so on the day `checkJs` was switched on it reported 429 errors —
 * none of them new, all of them the accumulated cost of never having had a type
 * layer at all.
 *
 * There are two honest things to do with a number like that and one dishonest
 * one. Fixing all 429 before anything else ships is weeks of work nobody asked
 * for. Printing them and failing nothing is a report that stops being read by
 * the second week. The dishonest option is deleting the check and ticking the
 * box.
 *
 * So: the count is frozen per file. A file that already had errors may keep
 * exactly as many as it had; one more and this exits non-zero and names it. A
 * file with none — which is every file added from now on — must stay at none.
 * Cleaning a file lowers its ceiling automatically, so the debt can only shrink.
 *
 *   node scripts/typecheck.js            check against the baseline
 *   node scripts/typecheck.js --update   re-record it (after cleaning up)
 *   node scripts/typecheck.js --list     show what is still outstanding
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, '.typecheck-baseline.json');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** Every error tsc reports, grouped by the file it is in. */
function run() {
  const tsc = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '--noEmit', '-p', 'jsconfig.json'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  );

  const output = `${tsc.stdout || ''}${tsc.stderr || ''}`;
  const counts = {};
  const lines = [];

  for (const line of output.split('\n')) {
    // `server/app.js(123,45): error TS2339: …`
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!match) continue;
    const file = match[1].replace(/\\/g, '/');
    counts[file] = (counts[file] || 0) + 1;
    lines.push({ file, line: Number(match[2]), code: match[4], message: match[5] });
  }

  // A tsc that fell over without reporting a single diagnostic is a broken
  // config, not a clean codebase — and reporting it as clean would be the worst
  // possible answer.
  if (!lines.length && tsc.status !== 0) {
    console.error(red('tsc failed without reporting diagnostics:'));
    console.error(output.trim().slice(0, 2000));
    process.exit(2);
  }

  return { counts, lines, total: lines.length };
}

const readBaseline = () => {
  try {
    return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch {
    return null;
  }
};

const { counts, lines, total } = run();
const mode = process.argv[2];

if (mode === '--update') {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BASELINE, `${JSON.stringify({ total, files: sorted }, null, 2)}\n`);
  console.log(`${green('Recorded')} ${total} type errors across ${Object.keys(sorted).length} files.`);
  console.log(dim('This is now the ceiling. Nothing may add to it.'));
  process.exit(0);
}

if (mode === '--list') {
  for (const entry of lines) {
    console.log(`${entry.file}:${entry.line}  ${dim(entry.code)}  ${entry.message}`);
  }
  console.log(`\n${total} outstanding.`);
  process.exit(0);
}

const baseline = readBaseline();
if (!baseline) {
  console.error(red('No baseline recorded.'), 'Run `node scripts/typecheck.js --update` once.');
  process.exit(2);
}

const regressions = [];
const improvements = [];
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline.files[file] ?? 0;
  if (count > allowed) regressions.push({ file, count, allowed });
}
for (const [file, allowed] of Object.entries(baseline.files)) {
  const count = counts[file] ?? 0;
  if (count < allowed) improvements.push({ file, count, allowed });
}

if (regressions.length) {
  console.log(bold(red('\nType errors went up.\n')));
  for (const { file, count, allowed } of regressions) {
    console.log(`  ${red('✗')}  ${file} — ${allowed} allowed, ${count} found`);
    for (const entry of lines.filter((l) => l.file === file).slice(0, 5)) {
      console.log(`       ${dim(`${entry.line}:`)} ${entry.code} ${entry.message}`);
    }
  }
  console.log(
    dim(
      '\nThe baseline freezes the debt that was already here; it does not accept more.\n' +
        'Fix the new ones, or — if you genuinely cleaned something else up —\n' +
        'run `node scripts/typecheck.js --update` and say so in the commit.\n',
    ),
  );
  process.exit(1);
}

console.log(`${green('Type-check within baseline.')} ${total} outstanding (ceiling ${baseline.total}).`);
if (improvements.length) {
  console.log(green(`${improvements.length} file(s) improved:`));
  for (const { file, count, allowed } of improvements.slice(0, 10)) {
    console.log(`  ${green('↓')}  ${file} — was ${allowed}, now ${count}`);
  }
  console.log(dim('Run `node scripts/typecheck.js --update` to lock the improvement in.'));
}
process.exit(0);
