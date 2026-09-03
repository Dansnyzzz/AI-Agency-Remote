/**
 * Tests for the hooks themselves.
 *
 * A guard nobody tested is a guard that fails open on the day it matters, and
 * these are the files least likely to be exercised by hand — you only find out
 * a pattern was wrong by watching something destructive go through.
 *
 * The payloads live in this file rather than on a command line deliberately:
 * typing them into a shell trips the very guard under test.
 *
 *   node .claude/hooks/hooks.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

let passed = 0;
let failed = 0;

const BLOCK = 2;
const ALLOW = 0;

/**
 * A ledger of its own, in a temp directory.
 *
 * The gate hooks read and write `.claude/state/`, and a test that stamped the
 * real one would report the working tree as verified when nothing had run —
 * which is precisely the lie the whole mechanism exists to prevent. So every
 * gate-aware hook here is pointed somewhere disposable.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gate-'));
const ledgerFile = path.join(sandbox, 'gate.json');
const gateEnv = { ...process.env, CLAUDE_GATE_STATE: sandbox };

const writeLedger = (ledger) => fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
const clearLedger = () => {
  try {
    fs.rmSync(ledgerFile);
  } catch {
    /* already absent */
  }
};

/** Run a hook with a payload and assert the exit code. */
function check(hook, payload, expected, what, env = process.env) {
  const run = spawnSync(process.execPath, [path.join(here, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
    timeout: 90_000,
    env,
  });

  const got = run.status;
  const ok = got === expected;
  const verdict = (code) => (code === BLOCK ? 'blocked' : 'allowed');

  if (ok) {
    passed += 1;
    console.log(`  [32m✓[0m  ${what} — ${verdict(got)}`);
  } else {
    failed += 1;
    console.log(
      `  [31m✗[0m  ${what} — expected ${verdict(expected)}, got ${verdict(got)}` +
        `${run.stderr ? `\n       ${run.stderr.trim().split('\n').join('\n       ')}` : ''}`,
    );
  }
  return run;
}

/** Assert something that is not an exit code. */
function is(condition, what, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  [32m✓[0m  ${what}`);
  } else {
    failed += 1;
    console.log(`  [31m✗[0m  ${what}${detail ? `\n       ${detail}` : ''}`);
  }
}

const bash = (command) => ({ tool_input: { command } });
const write = (file_path) => ({ cwd: root, tool_input: { file_path } });

/**
 * Which branch the guard should believe it is on.
 *
 * Declared here rather than beside the branch section further down, because the
 * push checks below need it too and did not have it. Without a branch injected
 * they read the *real* one, so `git push origin feature` — a command that has
 * nothing to do with the protected branch — was blocked whenever the suite ran
 * on `main`, and `npm run check` could never be green there.
 *
 * That is worse than an ordinary flaky test. The whole premise of this ledger
 * is that only a green gate may stamp work as verified, so a gate that cannot
 * go green on the default branch disables the mechanism it exists to enforce.
 */
const onBranch = (name) => ({ ...process.env, CLAUDE_GUARD_BRANCH: name });

console.log('\n[1mguard-bash[0m');
check('guard-bash.js', bash('npm test'), ALLOW, 'an ordinary command runs');
// Both name a feature branch as the destination, so they must run whatever
// branch the suite itself happens to be checked out on. See `onBranch`.
check('guard-bash.js', bash('git push origin feature'), ALLOW, 'a normal push runs', onBranch('feature/x'));
check(
  'guard-bash.js',
  bash('git push --force-with-lease origin feature'),
  ALLOW,
  '--force-with-lease is the safe form',
  onBranch('feature/x'),
);
check('guard-bash.js', bash('npm install express'), ALLOW, 'installing a package runs');

check('guard-bash.js', bash(['rm', '-rf', 'build'].join(' ')), BLOCK, 'recursive force-delete');
check('guard-bash.js', bash(['rm', '-fr', 'build'].join(' ')), BLOCK, 'the flags in the other order');
check('guard-bash.js', bash(['git', 'push', '--force', 'origin', 'main'].join(' ')), BLOCK, 'force-push');
check('guard-bash.js', bash(['git', 'push', '-f', 'origin', 'main'].join(' ')), BLOCK, 'the short form of it');
check('guard-bash.js', bash(['git', 'reset', '--hard'].join(' ')), BLOCK, 'discarding uncommitted work');
check('guard-bash.js', bash(`psql -c "${['DROP', 'TABLE', 'users'].join(' ')}"`), BLOCK, 'dropping a table');
check('guard-bash.js', bash(`psql -c "${['TRUNCATE', 'chats'].join(' ')}"`), BLOCK, 'truncating one');
check('guard-bash.js', bash(['rm', '-r', 'data/pgdata'].join(' ')), BLOCK, 'deleting the local cluster');
check('guard-bash.js', bash(['npm', 'publish'].join(' ')), BLOCK, 'publishing a private package');

console.log('\n[1mguard-write[0m');
check('guard-write.js', write('server/app.js'), ALLOW, 'ordinary source is editable');
check('guard-write.js', write('test/deploy.test.mjs'), ALLOW, 'so are tests');
check('guard-write.js', write('data/samples/Bao gia.csv'), ALLOW, 'and the sample fixtures');
check('guard-write.js', write(path.join(root, 'README.md')), ALLOW, 'an absolute path inside the project');
check('guard-write.js', write('../elsewhere/notes.md'), ALLOW, 'outside the project is not our business');

check('guard-write.js', write('data/pgdata/postgresql.conf'), BLOCK, 'the live Postgres cluster');
check('guard-write.js', write('data/pending-pairing.json'), BLOCK, 'runtime state under data/');
check('guard-write.js', write('.env'), BLOCK, 'the file holding ENCRYPTION_KEY');
check('guard-write.js', write('worker/.env'), BLOCK, "the worker's copy");
check('guard-write.js', write('package-lock.json'), BLOCK, 'a generated lockfile');
check('guard-write.js', write('node_modules/express/index.js'), BLOCK, 'a dependency in place');

console.log('\n[1mlint-changed[0m');
check('lint-changed.js', write('README.md'), ALLOW, 'markdown is not linted');
check('lint-changed.js', write('server/app.js'), ALLOW, 'a clean source file passes');

/* ---------------------------------------------------------------------------
 * The branch rules.
 *
 * The branch is injected rather than read from git, so these test the rule and
 * not whichever branch the suite happens to be run on.
 * ------------------------------------------------------------------------- */

console.log('\n[1mguard-bash · protected branch[0m');

check('guard-bash.js', bash('git commit -m "x"'), BLOCK, 'committing on main', onBranch('main'));
check('guard-bash.js', bash('git commit -m "x"'), BLOCK, 'committing on master', onBranch('master'));
check('guard-bash.js', bash('git commit -m "x"'), ALLOW, 'committing on a feature branch', onBranch('feature/x'));
check('guard-bash.js', bash('git merge feature/x'), BLOCK, 'merging into main', onBranch('main'));
check('guard-bash.js', bash('git merge feature/x'), ALLOW, 'merging on a feature branch', onBranch('feature/x'));
check('guard-bash.js', bash('git push origin HEAD'), BLOCK, 'pushing while on main', onBranch('main'));
check('guard-bash.js', bash('git push origin feature/x'), ALLOW, 'pushing a feature branch', onBranch('feature/x'));
check('guard-bash.js', bash('git push origin main'), BLOCK, 'naming it from another branch', onBranch('feature/x'));

/*
 * The three forms that walked straight past the first version of this rule.
 *
 * It matched a regex ending in the branch name, so `git push origin main` was
 * caught and the `HEAD:` form was not — nor the branch-to-branch refspec, nor
 * the full ref. The rule looked correct the entire time, which is the only
 * reason each of these is worth its own line.
 *
 * Built by joining fragments, for the reason at the top of this file: written
 * out whole, these strings trip the guard that is under test the moment the
 * command reaches a shell.
 */
const push = (...parts) => bash(['git', 'push', ...parts].join(' '));

check('guard-bash.js', push('origin', 'HEAD:ma' + 'in'), BLOCK, 'the HEAD: form is the same act', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'feature/x:ma' + 'in'), BLOCK, 'so is branch-to-branch', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'refs/heads/ma' + 'in'), BLOCK, 'so is the full ref', onBranch('feature/x'));
check('guard-bash.js', push('-u', 'origin', 'ma' + 'in'), BLOCK, 'flags do not hide it', onBranch('feature/x'));
check('guard-bash.js', push('origin', ':ma' + 'in'), BLOCK, 'deleting it remotely is worse, not better', onBranch('feature/x'));

// And the other direction. A rule that catches too much is a rule that gets
// switched off, and then it protects nothing at all.
check('guard-bash.js', push('origin', 'ma' + 'in-page'), ALLOW, 'a branch that merely starts with it is fine', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'ma' + 'in:feature/x'), ALLOW, 'pushing it somewhere else does not write it', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'dev', '# merge to ma' + 'in later'), ALLOW, 'nor does mentioning it in a comment', onBranch('feature/x'));
// The regression that started this file: the safe form must survive.
check(
  'guard-bash.js',
  bash('git push --force-with-lease origin feature/x'),
  ALLOW,
  '--force-with-lease still runs on a feature branch',
  onBranch('feature/x'),
);
check('guard-bash.js', bash('git status'), ALLOW, 'reading status on main', onBranch('main'));

/* ---------------------------------------------------------------------------
 * The ledger and the completion gate.
 * ------------------------------------------------------------------------- */

console.log('\n[1mledger[0m');
clearLedger();
check('ledger.js', write('server/agent.js'), ALLOW, 'recording a changed source file', gateEnv);
{
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  is(
    ledger.pending.some((p) => p.file.endsWith('agent.js')),
    'the file lands in the ledger as unproven',
    JSON.stringify(ledger.pending),
  );
}
check('ledger.js', write('README.md'), ALLOW, 'documentation is not source', gateEnv);
{
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  is(!ledger.pending.some((p) => p.file.endsWith('README.md')), 'and does not demand a test run');
}

console.log('\n[1mverify-stop[0m');
const { head, dirtyHash } = await import('./gate.js');
const stop = (last, extra = {}) => ({
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: last,
  ...extra,
});
const unproven = {
  pending: [{ file: 'server/agent.js', at: '2026-09-01T00:00:00Z' }],
  lastGreen: null,
};

writeLedger(unproven);
check('verify-stop.js', stop('Đã sửa xong và tất cả test đều pass.'), BLOCK, 'a completion claim with unproven changes', gateEnv);
check('verify-stop.js', stop('All tests pass now.'), BLOCK, 'the same claim in English', gateEnv);
check('verify-stop.js', stop('Here is how server/agent.js dispatches tools.'), ALLOW, 'an ordinary answer is never blocked', gateEnv);
check('verify-stop.js', stop('Chưa xong — còn phải chạy test.'), ALLOW, 'an honest "not done yet" is not a claim', gateEnv);
check('verify-stop.js', stop('Not done — the suite has not run.'), ALLOW, 'nor is it in English', gateEnv);
check('verify-stop.js', stop('Done.'), BLOCK, 'a bare "Done." is a claim like any other', gateEnv);
check('verify-stop.js', stop('Not done yet.'), ALLOW, 'but "not done yet" still is not', gateEnv);
check('verify-stop.js', stop('When done, run the gate and tell me.'), ALLOW, 'nor is the word inside a sentence', gateEnv);
check(
  'verify-stop.js',
  stop('Đã xong hết.', { stop_hook_active: true }),
  ALLOW,
  'never block twice — the harness caps it and ends the turn anyway',
  gateEnv,
);
{
  const run = check(
    'verify-stop.js',
    { ...stop('Xong rồi nhé.'), hook_event_name: 'SubagentStop', agent_type: 'qa-tester' },
    BLOCK,
    'a sub-agent claiming completion is the same failure',
    gateEnv,
  );
  is(/qa-tester/.test(run.stderr || ''), 'and the block names which agent said it');
}

clearLedger();
check('verify-stop.js', stop('Đã xong.'), ALLOW, 'a claim with nothing changed has nothing to prove', gateEnv);

writeLedger({ pending: [], lastGreen: { at: '2026-09-01T00:00:00Z', head: head(), dirty: dirtyHash(), scope: 'fast' } });
check('verify-stop.js', stop('All tests pass — ready to merge.'), BLOCK, 'a fast stamp is not the full gate', gateEnv);

writeLedger({ pending: [], lastGreen: { at: '2026-09-01T00:00:00Z', head: head(), dirty: dirtyHash(), scope: 'full' } });
check('verify-stop.js', stop('Hoàn thành, gate xanh.'), ALLOW, 'a current full stamp satisfies the claim', gateEnv);

writeLedger({ pending: [], lastGreen: { at: '2026-09-01T00:00:00Z', head: 'deadbeef', dirty: 'deadbeef', scope: 'full' } });
check('verify-stop.js', stop('Hoàn thành.'), BLOCK, 'a stamp from another commit has expired', gateEnv);
{
  // Three situations, three sentences. The first version said "0 file(s)
  // changed — the working tree" for the case below, which is neither the
  // number nor the reason: nothing had changed, the stamp had merely stopped
  // matching HEAD. A guard that misdescribes what it found is one people skim.
  const run = check(
    'verify-stop.js',
    stop('Xong rồi.'),
    BLOCK,
    'an expired stamp says so, rather than inventing a changed file',
    gateEnv,
  );
  is(/no longer matches this tree/.test(run.stderr || ''), '  and names the real reason', run.stderr);
  is(!/0 file/.test(run.stderr || ''), '  without claiming zero files changed');
}

writeLedger(unproven);
{
  const run = check('verify-stop.js', stop('Done.'), BLOCK, 'a real pending file is named instead', gateEnv);
  is(/server[\\/]agent\.js/.test(run.stderr || ''), '  by name', run.stderr);
}

/* ---------------------------------------------------------------------------
 * Context preservation.
 * ------------------------------------------------------------------------- */

console.log('\n[1mjournal[0m');
const transcript = path.join(sandbox, 'transcript.jsonl');
fs.writeFileSync(
  transcript,
  [
    JSON.stringify({
      type: 'user',
      promptSource: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Build the thing, keep it on a branch.' }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'transcript noise' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Write the failing test', status: 'completed' },
                { content: 'Make it pass', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    }),
    '{ this line is not json',
    '',
  ].join('\n'),
);

clearLedger();
check(
  'journal.js',
  { hook_event_name: 'PreCompact', trigger: 'auto', transcript_path: transcript },
  ALLOW,
  'writing the journal before a compaction',
  gateEnv,
);
{
  const journal = fs.readFileSync(path.join(sandbox, 'journal.md'), 'utf8');
  is(/keep it on a branch/.test(journal), 'the instruction survives');
  is(!/transcript noise/.test(journal), 'tool results do not');
  is(/Make it pass/.test(journal), 'and so does the task list');
}
check(
  'journal.js',
  { hook_event_name: 'PreCompact', trigger: 'manual', transcript_path: path.join(sandbox, 'nope.jsonl') },
  ALLOW,
  'a missing transcript is survivable',
  gateEnv,
);
check('journal.js', { hook_event_name: 'PreCompact', trigger: 'auto' }, ALLOW, 'so is no transcript at all', gateEnv);

console.log('\n[1mbrief[0m');
{
  const run = check('brief.js', { hook_event_name: 'SessionStart', source: 'startup' }, ALLOW, 'briefing a new session', gateEnv);
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch {
    parsed = null;
  }
  is(parsed?.hookSpecificOutput?.hookEventName === 'SessionStart', 'it answers with the event name the harness requires');
  is(/Branch/.test(parsed?.hookSpecificOutput?.additionalContext || ''), 'and says which branch this is');
  is(Boolean(parsed?.hookSpecificOutput?.sessionTitle), 'and titles the session');
}
{
  const run = check(
    'brief.js',
    { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'did things' },
    ALLOW,
    'briefing after a compaction',
    gateEnv,
  );
  const parsed = JSON.parse(run.stdout.trim());
  is(
    /keep it on a branch/.test(parsed.hookSpecificOutput.additionalContext),
    'the journal comes back after the window folds',
  );
}

console.log('\n[1mrecover[0m');
{
  const run = check(
    'recover.js',
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'listen EADDRINUSE: address already in use :::5173' },
    ALLOW,
    'a held port',
  );
  is(/5173/.test(run.stdout), 'gets the answer this repo already knows');
}
{
  const run = check(
    'recover.js',
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'something nobody has ever seen' },
    ALLOW,
    'an unrecognised failure',
  );
  is(run.stdout.trim() === '', 'gets silence rather than a guess');
}
{
  const run = check(
    'recover.js',
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'EADDRINUSE', is_interrupt: true },
    ALLOW,
    'an interrupt',
  );
  is(run.stdout.trim() === '', 'is a person changing their mind, not a fault');
}

/* ---------------------------------------------------------------------------
 * Fail-open. A hook that throws on strange input wedges the session, and the
 * fix for that is always to delete the hook — so it must not throw.
 * ------------------------------------------------------------------------- */

console.log('\n[1mfail-open[0m');
for (const hook of [
  'guard-bash.js',
  'guard-write.js',
  'lint-changed.js',
  'ledger.js',
  'verify-stop.js',
  'journal.js',
  'brief.js',
  'recover.js',
]) {
  const run = spawnSync(process.execPath, [path.join(here, hook)], {
    input: 'not json at all {{{',
    encoding: 'utf8',
    cwd: root,
    timeout: 90_000,
    env: gateEnv,
  });
  is(run.status === ALLOW, `${hook} survives garbage on stdin`, run.stderr);
}

try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* a leftover temp directory is not a test failure */
}

/* ── the fingerprint must agree with isSource ───────────────────── */

{
  // dirtyHash hashed the whole of `git status --porcelain`, which contradicted
  // isSource twenty lines below it — and isSource exists to say a README is not
  // worth twenty-four suites. So note() honoured the exemption and dirtyHash did
  // not: one line of documentation expired the stamp and demanded a full re-run,
  // the exact behaviour the comment on NOT_SOURCE warns gets a gate switched off.
  const gate = await import('./gate.js');

  const baseline = gate.dirtyHash();

  const doc = path.join(root, 'audit', `hooks-test-scratch-${process.pid}.md`);
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, '# written by hooks.test.mjs\n');
  const afterDoc = gate.dirtyHash();

  const src = path.join(root, `hooks-test-scratch-${process.pid}.js`);
  fs.writeFileSync(src, '// written by hooks.test.mjs\n');
  const afterSrc = gate.dirtyHash();

  fs.rmSync(doc, { force: true });
  fs.rmSync(src, { force: true });
  const restored = gate.dirtyHash();

  is(afterDoc === baseline, 'a new .md does not expire the stamp', `${baseline} -> ${afterDoc}`);
  is(afterSrc !== baseline, 'a new .js does', `${baseline} -> ${afterSrc}`);
  is(restored === baseline, 'and removing them puts the fingerprint back', `${baseline} -> ${restored}`);

  // stamp() must be able to record a fingerprint taken before the suites ran.
  // Taking it afterwards certified whatever happened to be on disk when the run
  // finished — including anything edited while it was running, which for a run
  // that takes minutes is a wide door.
  is(gate.stamp.length >= 1, 'stamp() takes the fingerprint that was tested');
}

/* ── the gate must cover what CI blocks a merge on ─────────────── */

{
  // The gate stamped a tree green while typecheck was red, because STEPS.full
  // never ran typecheck. That is the exact failure this directory exists to
  // prevent: a stamp saying "verified" about a tree CI will reject.
  //
  // Pinned by reading the file rather than by running the gate — a real run is
  // minutes long, and this check has to be cheap enough to stay in the suite.
  const gateSource = fs.readFileSync(path.join(here, 'gate.js'), 'utf8');
  const full = /full: \[([\s\S]*?)\],\r?\n\};/.exec(gateSource)?.[1] || '';

  is(/'lint'/.test(full), 'the full gate runs lint');
  is(/'typecheck'/.test(full), 'the full gate runs typecheck — the step it used to skip', full);
  is(/'eval'/.test(full), 'the full gate runs the agent eval');
  is(/'test:hooks'/.test(full), 'the full gate runs the hook suite');
  is(/\['test'\]/.test(full), 'the full gate runs the suites');

  // The fast gate is allowed to be small, but it must not quietly grow into the
  // full one — verify-stop.js depends on the two meaning different things.
  const fast = /fast: \[([\s\S]*?)\],/.exec(gateSource)?.[1] || '';
  is(!/'typecheck'/.test(fast), 'and the fast gate stays fast');
}

console.log(
  failed === 0
    ? `\n[32mAll ${passed} hook checks passed.[0m\n`
    : `\n[31m${failed} of ${passed + failed} hook checks failed.[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);
