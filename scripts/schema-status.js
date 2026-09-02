import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore, getStore } from '../server/store/index.js';
import { SCHEMA_VERSION } from '../server/store/pg.js';

/**
 * What the database actually looks like, versus what the code expects.
 *
 * `schema.sql` only runs when the stored `schema_version` differs from the one
 * in the code. That mechanism is right, and it has one failure mode that is very
 * hard to diagnose from the outside: a column the code writes to is simply not
 * there, and the error names whichever query lost a race. `summary()` runs three
 * queries in a `Promise.all`, so the same stale database reports
 * `column "cache_read_tokens" does not exist` on one request and
 * `column "role" does not exist` on the next — which reads like two bugs and is
 * one.
 *
 * So this prints the stamp, and then checks the columns the code is known to
 * depend on against what the database really has. Two numbers and a list, rather
 * than a guess.
 *
 *   node scripts/schema-status.js                     the local database
 *   DATABASE_URL=postgres://… node scripts/schema-status.js    a deployment's
 *
 * **It applies pending DDL, and that is not a side effect to discover by
 * accident.** Opening the store is what runs `schema.sql` when the stamp is
 * behind — that is how the app upgrades itself on start, and this uses the same
 * door. So pointing it at a production DATABASE_URL brings that database up to
 * date as well as reporting on it, which is usually exactly what you want when
 * a deployment is throwing `column "..." does not exist`, and is never
 * something to run without meaning to.
 *
 * Every statement in schema.sql is idempotent, so a database that is already
 * current is untouched.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The same minimal .env loader `server/index.js` uses. */
function loadEnvFile() {
  const file = path.resolve(here, '../.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

/**
 * Columns the code writes to or reads by name, and would fail on if absent.
 *
 * Deliberately not derived from schema.sql: the point is to catch the case where
 * schema.sql and the database disagree, and a check generated from schema.sql
 * would agree with schema.sql by construction.
 */
const EXPECTED = [
  ['usage_events', 'cache_read_tokens'],
  ['usage_events', 'role'],
  ['usage_events', 'input_tokens'],
  ['usage_events', 'cost_usd'],
  ['chats', 'project_id'],
  ['chats', 'run_lock_by'],
  ['doc_chunks', 'model'],
  ['workflow_runs', 'cursor'],
  ['devices', 'workspace'],
  ['shared_models', 'max_output'],
];

const store = await initStore();
const driver = getStore();

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log(`\n  Storage: ${store.kind}`);

const stamped = await driver.schemaStamp();

const missing = [];
for (const [table, column] of EXPECTED) {
  let exists = false;
  try {
    exists = await driver.columnExists(table, column);
  } catch (err) {
    console.log(red(`  Could not inspect ${table}.${column}: ${err.message}`));
  }
  if (!exists) missing.push(`${table}.${column}`);
}

console.log(`  Code expects schema version: ${SCHEMA_VERSION}`);
console.log(`  Database is stamped:         ${stamped ?? dim('(could not read)')}\n`);

if (!missing.length) {
  console.log(green('  Every column the code depends on is present.\n'));
  if (stamped !== SCHEMA_VERSION) {
    console.log(
      dim(
        `  The stamp is ${stamped} rather than ${SCHEMA_VERSION}, so the DDL will run once more on the\n` +
          '  next start. Harmless — every statement is idempotent.\n',
      ),
    );
  }
} else {
  console.log(red(`  ${missing.length} column(s) the code writes to are missing:\n`));
  for (const name of missing) console.log(red(`    - ${name}`));
  console.log(
    dim(
      '\n  This is what produces `column "..." does not exist`. The app applies schema.sql on\n' +
        '  start only when the stamp differs from the code, so:\n\n' +
        `    - stamp ${stamped} and code ${SCHEMA_VERSION} differing means it has not been restarted since\n` +
        '      the upgrade — restart it, or redeploy.\n' +
        '    - stamp and code being equal with columns missing means the DDL ran and did not\n' +
        '      finish. Send this output rather than guessing.\n',
    ),
  );
}

await store.close?.();
process.exit(missing.length ? 1 : 0);
