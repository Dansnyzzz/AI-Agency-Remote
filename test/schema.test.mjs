/**
 * Upgrading a database that already exists.
 *
 * This suite exists because of a bug that no other suite could have caught.
 * `schema.sql` is only applied when the stored `schema_version` differs from
 * the one in the code — so adding a table or a column without bumping that
 * number does exactly nothing on a database that has been in use, while every
 * test carries on passing, because every test starts from an empty folder where
 * the DDL runs regardless.
 *
 * The result was a working app on a fresh clone and `column "project_id" of
 * relation "chats" does not exist` on the machine that had been running it for
 * a week. So: create a database, put it back to an older version with the new
 * things removed, open it again, and check the upgrade happens.
 *
 *   node test/schema.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.tmpdir(), `ai-remote-schema-test-${process.pid}`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { createPgStore } = await import('../server/store/pg.js');

const db = await PGlite.create(path.join(DATA_DIR, 'pgdata'));
const driver = {
  async query(text, params = []) {
    return (await db.query(text, params)).rows;
  },
};

const columnExists = async (table, column) =>
  (
    await driver.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    )
  ).length > 0;

const tableExists = async (table) =>
  (await driver.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).length > 0;

section('a fresh database gets everything');
{
  await createPgStore(driver).init();
  check('the projects table is there', await tableExists('projects'));
  check('and its files', await tableExists('project_files'));
  check('and chats know their project', await columnExists('chats', 'project_id'));
  check('and the document index', await tableExists('doc_chunks'));

  check('and the MCP server table', await tableExists('mcp_servers'));
  check('and workflows', await tableExists('workflows'));
  check('and the runs that keep their position', await tableExists('workflow_runs'));
  check('which is the whole point of them', await columnExists('workflow_runs', 'cursor'));
  // The real output cap, so a request stops asking every model for 32000 tokens
  // it may not be able to produce.
  check('and shared models record their output cap', await columnExists('shared_models', 'max_output'));

  const stamped = await driver.query("SELECT value FROM settings WHERE key = 'schema_version'");
  check('and the version is stamped', Number(stamped[0]?.value) > 0, `${stamped[0]?.value}`);
}

section('the newest tables reach a database that predates them');
{
  /**
   * The failure this file exists for, exercised on the two most recent additions.
   *
   * `mcp_servers` and `shared_models.max_output` are the things added last, so
   * they are the ones most likely to have been added to schema.sql without the
   * version being bumped — in which case every machine that has been running the
   * app for a while gets a missing table and a query that fails, while every test
   * passes because tests start from an empty folder.
   */
  await driver.query('DROP TABLE IF EXISTS workflow_runs');
  await driver.query('DROP TABLE IF EXISTS workflows');
  await driver.query('DROP TABLE IF EXISTS mcp_servers');
  await driver.query('ALTER TABLE shared_models DROP COLUMN IF EXISTS max_output');
  await driver.query("UPDATE settings SET value = '1' WHERE key = 'schema_version'");

  check('they really are gone first', !(await tableExists('mcp_servers')), 'otherwise this proves nothing');
  check('the workflow tables too', !(await tableExists('workflows')), 'otherwise this proves nothing');

  await createPgStore(driver).init();
  check('opening it creates mcp_servers', await tableExists('mcp_servers'));
  check('and adds max_output back', await columnExists('shared_models', 'max_output'));
  // The newest addition, and therefore the one most likely to have been written
  // into schema.sql with the version left alone.
  check('and the workflow tables arrive', await tableExists('workflows') && await tableExists('workflow_runs'));

  // Per account, or one person could choose what another person's turn executes.
  check('MCP servers belong to an account', await columnExists('mcp_servers', 'user_id'));
}

section('a database from an earlier release is brought up to date');
{
  // Wind it back: an older stamp, and the newest things gone. This is the state
  // of a machine that was running the app before those were written.
  await driver.query('ALTER TABLE chats DROP COLUMN IF EXISTS project_id');
  await driver.query('DROP TABLE IF EXISTS project_files');
  await driver.query('DROP TABLE IF EXISTS projects');
  await driver.query('DROP TABLE IF EXISTS doc_chunks');
  await driver.query("UPDATE settings SET value = '1' WHERE key = 'schema_version'");

  check('the column really is gone first', !(await columnExists('chats', 'project_id')), 'otherwise this proves nothing');

  // A second store, because the first memoised the fact that it had run.
  await createPgStore(driver).init();

  check('opening it adds the missing tables', await tableExists('projects'));
  check('and the missing column', await columnExists('chats', 'project_id'));
  check('and the document index', await tableExists('doc_chunks'));
}

section('and the stamp is what decides');
{
  // The failure this all guards against, stated directly: with the stamp left
  // at the current version, nothing runs. That is the behaviour — and the
  // reason the number has to be bumped by hand whenever schema.sql changes.
  await driver.query('ALTER TABLE chats DROP COLUMN IF EXISTS project_id');
  await createPgStore(driver).init();
  check(
    'an up-to-date stamp skips the DDL entirely',
    !(await columnExists('chats', 'project_id')),
    'so adding to schema.sql without bumping SCHEMA_VERSION does nothing on an existing database',
  );
}

await db.close();

/**
 * One process at a time.
 *
 * PGlite has no cross-process locking. Two processes on one folder both write,
 * and the write-ahead log ends up with a checkpoint neither can read — a
 * database that will not start and that PGlite ships no tool to repair. This
 * suite exists because that happened: a script opened the live data directory
 * while the app was running, and the conversations in it were gone.
 */
section('two processes cannot open the same database');
{
  const { spawn } = await import('node:child_process');
  const { createPgliteStore } = await import('../server/store/pglite.js');

  const dir = `${DATA_DIR}-lock`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // A real process that is really alive, because the check is `kill(pid, 0)`
  // and a made-up number would prove nothing.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.writeFileSync(`${dir}/owner.pid`, `${holder.pid}\n${new Date().toISOString()}\n`);

  let refused = null;
  await createPgliteStore(dir).catch((err) => (refused = err));
  check('a second process is turned away', refused?.code === 'database_in_use', refused?.message?.slice(0, 70));
  check('before it has written anything', !fs.existsSync(`${dir}/pgdata`), 'the claim is made before Postgres starts');
  check('and it names the process holding it', String(refused?.message).includes(String(holder.pid)));

  holder.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // The lock is a claim, not a gravestone: once the holder is gone it means
  // nothing, or every crash would need a manual cleanup.
  const store = await createPgliteStore(dir);
  check('a lock from a process that died is ignored', !!store, 'otherwise every crash needs a human');
  check('and the new owner takes it', fs.readFileSync(`${dir}/owner.pid`, 'utf8').startsWith(String(process.pid)));

  await store.close();
  check('closing releases it', !fs.existsSync(`${dir}/owner.pid`));

  fs.rmSync(dir, { recursive: true, force: true });
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll schema checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
