import { initStore } from '../server/store/index.js';

/**
 * Promote an account to administrator from the machine that owns the database.
 *
 * There is a genuine chicken-and-egg here: admin powers are granted in the app,
 * under Settings → People, which only an admin can open. If the first account
 * is lost, abandoned, or was created by accident, nothing in the interface can
 * fix it. Physical access to the database is already total access, so this
 * grants nothing new — it just saves writing the UPDATE by hand.
 *
 *   node scripts/make-admin.js you@example.com
 */
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('\n  Usage: node scripts/make-admin.js <email>\n');
  console.error('  Run `node scripts/whoami.js` to see which accounts exist.\n');
  process.exit(1);
}

const store = await initStore();
const user = await store.getUserByEmail(email);
if (!user) {
  console.error(`\n  No account for ${email}. Run \`node scripts/whoami.js\` to list them.\n`);
  process.exit(1);
}

if (user.role === 'admin') {
  console.log(`\n  ${user.email} is already an administrator.\n`);
  process.exit(0);
}

await store.setUserRole(user.id, 'admin');
console.log(`\n  ${user.email} is now an administrator. Sign out and back in to see Settings → People.\n`);
process.exit(0);
