#!/usr/bin/env node
/**
 * The evidence ledger, and the only thing allowed to write a green stamp.
 *
 * CLAUDE.md §5 lists a Definition of Done and §10 says not to claim a change is
 * finished without having actually run the gate. Both are prose, and prose is
 * the thing a model can talk itself out of on turn ninety of an unattended run.
 * This file is the part that cannot be talked out of: a stamp exists only if the
 * process that wrote it is the process that ran the tests and read their exit
 * codes itself.
 *
 * That constraint is the whole design. The tempting alternative — watch the
 * output of `npm test` go past in a PostToolUse hook and stamp when it "looks
 * like a pass" — is exactly the self-deception the ledger exists to prevent. A
 * suite that printed a tally and then exited 1 looks, in a scrollback, almost
 * identical to one that passed.
 *
 * A stamp expires on its own. It records the commit and a hash of the working
 * tree's dirty set, so the next edit or the next commit invalidates it with no
 * bookkeeping. There is deliberately no time-based expiry: an hour-old stamp on
 * an untouched tree is still true, and a one-second-old stamp on a tree that has
 * changed since is not.
 *
 * Used as a library by the hooks, and as a CLI by the model:
 *
 *   node .claude/hooks/gate.js run [--fast]   run the gate, stamp only if green
 *   node .claude/hooks/gate.js status         print the ledger as JSON
 *   node .claude/hooks/gate.js note <file>    record a file as unverified
 *
 * Nothing here imports anything outside Node's standard library. These run on
 * every matching event, and a hook that needs `npm install` to work is a hook
 * that breaks the session it was meant to protect.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Project root — two levels up from `.claude/hooks/`. */
export const ROOT = path.resolve(HERE, '../..');

/**
 * Where the ledger lives. Overridable so the test suite can run against a
 * temporary directory instead of stamping the real one — a test that reports
 * the working tree as verified would be worse than no test at all.
 */
export function stateDir() {
  return process.env.CLAUDE_GATE_STATE || path.join(ROOT, '.claude', 'state');
}

const ledgerPath = () => path.join(stateDir(), 'gate.json');

/** Never let a missing directory turn into a thrown hook. */
function ensureDir() {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

const EMPTY = { pending: [], lastGreen: null };

export function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    return {
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      lastGreen: parsed.lastGreen && typeof parsed.lastGreen === 'object' ? parsed.lastGreen : null,
    };
  } catch {
    // Absent, unreadable or corrupt all mean the same thing: nothing is proven.
    return { ...EMPTY, pending: [] };
  }
}

function writeLedger(ledger) {
  if (!ensureDir()) return false;
  try {
    fs.writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** A git command that returns '' rather than throwing when git is unavailable. */
function git(args) {
  try {
    const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
    return run.status === 0 ? String(run.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

export const head = () => git(['rev-parse', 'HEAD']);
export const branch = () => git(['rev-parse', '--abbrev-ref', 'HEAD']);

/**
 * A fingerprint of everything git considers changed, tracked or not. Cheaper and
 * more honest than hashing file contents: it moves the moment anything in the
 * tree does, which is precisely when a stamp stops meaning anything.
 */
export function dirtyHash() {
  const porcelain = git(['status', '--porcelain']);
  return crypto.createHash('sha256').update(porcelain).digest('hex').slice(0, 16);
}

/**
 * Paths that changing does not invalidate a test run. Documentation and the
 * ledger's own state are the obvious cases — demanding twenty-four suites for a
 * typo fix in a README is how a gate earns its way into being switched off.
 */
const NOT_SOURCE = [
  /^\.claude[\\/]state[\\/]/i,
  /^docs[\\/]/i,
  /\.(md|markdown|txt|png|jpe?g|gif|svg|ico|webp|pdf)$/i,
  /^\.gitignore$/i,
  /^LICENSE$/i,
];

export function isSource(rel) {
  if (!rel || rel.startsWith('..')) return false;
  return !NOT_SOURCE.some((re) => re.test(rel));
}

/** Record a file as changed-but-unproven. Returns the relative path, or ''. */
export function note(file) {
  let rel;
  try {
    rel = path.relative(ROOT, path.resolve(ROOT, file));
  } catch {
    return '';
  }
  if (!isSource(rel)) return '';

  const ledger = readLedger();
  if (!ledger.pending.some((p) => p.file === rel)) {
    ledger.pending.push({ file: rel, at: new Date().toISOString() });
    // A run that touches hundreds of files does not need hundreds of names in
    // the reminder; the count is what matters past the first handful.
    if (ledger.pending.length > 50) ledger.pending = ledger.pending.slice(-50);
    writeLedger(ledger);
  }
  return rel;
}

/** Write the green stamp. Only ever called after a real, successful run. */
export function stamp(scope) {
  const ledger = readLedger();
  ledger.lastGreen = { at: new Date().toISOString(), head: head(), dirty: dirtyHash(), scope };
  ledger.pending = [];
  writeLedger(ledger);
  return ledger.lastGreen;
}

/**
 * The question every consumer actually asks: is what is on disk right now backed
 * by a run that happened?
 *
 * `verified` requires the full gate. A `--fast` stamp is genuine evidence that
 * lint and the hook suite passed, and is reported as such, but it is not
 * evidence that the twenty-four suites did — so it does not satisfy a claim that
 * a piece of work is finished.
 */
export function status() {
  const ledger = readLedger();
  const g = ledger.lastGreen;
  const current = Boolean(g) && g.head === head() && g.dirty === dirtyHash();
  const clean = ledger.pending.length === 0;

  return {
    pending: ledger.pending,
    lastGreen: g,
    branch: branch(),
    /** The stamp still describes the tree as it stands. */
    current,
    /** Full gate, still current, nothing edited since. */
    verified: current && clean && g.scope === 'full',
    /** Lint + hooks only — real, but not the whole gate. */
    fastOnly: current && clean && g.scope === 'fast',
  };
}

/* ---------------------------------------------------------------- CLI ----- */

/** The gate itself, in the order that fails cheapest first. */
const STEPS = {
  fast: [
    ['run', 'lint'],
    ['run', 'test:hooks'],
  ],
  full: [
    ['run', 'lint'],
    ['test'],
    ['run', 'test:hooks'],
  ],
};

function runGate(fast) {
  const scope = fast ? 'fast' : 'full';
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  for (const args of STEPS[scope]) {
    process.stdout.write(`\n[1m› npm ${args.join(' ')}[0m\n`);
    const run = spawnSync(npm, args, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 20 * 60_000,
      shell: process.platform === 'win32',
    });

    if (run.status !== 0) {
      process.stdout.write(
        `\n[31mGate red at \`npm ${args.join(' ')}\` (exit ${run.status}).[0m\n` +
          'Nothing was stamped. Fix the failure and run the gate again — do not\n' +
          'describe this change as finished until it is green.\n',
      );
      return 1;
    }
  }

  const green = stamp(scope);
  process.stdout.write(
    `\n[32mGate green (${scope}).[0m Stamped at ${green.at} on ${green.head.slice(0, 7) || 'no commit'}.\n` +
      (fast
        ? 'This was the fast gate: lint and the hook suite only. A claim that the\n' +
          'work is finished still needs the full run.\n'
        : ''),
  );
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === 'run') return runGate(rest.includes('--fast'));

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(status(), null, 2)}\n`);
    return 0;
  }

  if (cmd === 'note') {
    const rel = note(rest[0] || '');
    process.stdout.write(rel ? `noted ${rel}\n` : 'not a source file; nothing noted\n');
    return 0;
  }

  process.stdout.write('usage: gate.js run [--fast] | status | note <file>\n');
  return cmd ? 1 : 0;
}

// Only act as a CLI when invoked directly, so importing this from a hook is free
// of side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
