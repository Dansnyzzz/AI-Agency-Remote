import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initStore } from '../server/store/index.js';
import { hashPassword } from '../server/crypto.js';

/**
 * Set an account's password directly, from the machine that owns the database.
 *
 * The way back in when email is not configured and nobody can receive a reset
 * link — which is the normal state of a local install. Physical access to the
 * database is already total access, so this grants nothing that was not already
 * there; it just saves you from editing SQL by hand.
 *
 *   node scripts/reset-password.js you@example.com
 */
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('\n  Usage: node scripts/reset-password.js <email>\n');
  console.error('  Run `node scripts/whoami.js` to see which accounts exist.\n');
  process.exit(1);
}

const store = await initStore();
const user = await store.getUserByEmail(email);
if (!user) {
  console.error(`\n  No account for ${email}. Run \`node scripts/whoami.js\` to list them.\n`);
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const password = await rl.question(`New password for ${user.email} (min 10 chars): `);
rl.close();

if (password.length < 10) {
  console.error('\n  Too short — use at least 10 characters. Nothing was changed.\n');
  process.exit(1);
}

await store.setUserPassword(user.id, await hashPassword(password));
// Someone with the database can already read every mailbox-proof there is, so
// withholding the verified flag here would only lock them out of their own app.
await store.markEmailVerified(user.id);

console.log(`\n  Password updated for ${user.email}. Sign in with it now.\n`);
process.exit(0);
