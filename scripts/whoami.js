import { initStore } from '../server/store/index.js';

/**
 * Who is in the local database?
 *
 * Mostly useful when a sign-in is failing and you need to know whether the
 * account exists at all before debugging anything else.
 *
 *   node scripts/whoami.js
 */
const store = await initStore();
const users = await store.listUsers();

console.log(`\n  Storage: ${store.kind}`);
if (!users.length) {
  console.log('\n  No accounts. Open the app and create one — the first becomes the administrator.\n');
} else {
  console.log(`\n  ${users.length} account${users.length === 1 ? '' : 's'}:\n`);
  for (const u of users) {
    const tags = [
      u.role,
      u.email_verified_at ? 'confirmed' : 'unconfirmed',
      u.suspended_at ? 'suspended' : null,
      `${u.chat_count} chats`,
    ].filter(Boolean);
    console.log(`    ${u.email.padEnd(30)} ${tags.join(' · ')}`);
  }
  console.log('');
}
process.exit(0);
