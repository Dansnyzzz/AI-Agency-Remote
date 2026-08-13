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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

let passed = 0;
let failed = 0;

const BLOCK = 2;
const ALLOW = 0;

/** Run a hook with a payload and assert the exit code. */
function check(hook, payload, expected, what) {
  const run = spawnSync(process.execPath, [path.join(here, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
    timeout: 90_000,
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
}

const bash = (command) => ({ tool_input: { command } });
const write = (file_path) => ({ cwd: root, tool_input: { file_path } });

console.log('\n[1mguard-bash[0m');
check('guard-bash.js', bash('npm test'), ALLOW, 'an ordinary command runs');
check('guard-bash.js', bash('git push origin feature'), ALLOW, 'a normal push runs');
check('guard-bash.js', bash('git push --force-with-lease origin feature'), ALLOW, '--force-with-lease is the safe form');
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

console.log(
  failed === 0
    ? `\n[32mAll ${passed} hook checks passed.[0m\n`
    : `\n[31m${failed} of ${passed + failed} hook checks failed.[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);
