/**
 * Work running in the background shows up in the conversation list at once.
 *
 * A workflow run was underway — step 1 done, step 2 running — while the sidebar
 * said "no conversations yet". The conversation existed from the moment the run
 * started; the list simply never said so. What is pinned here is the server's
 * half: a conversation that a workflow run or a scheduled task is working in is
 * listed immediately (even before its first message) and flagged `running`,
 * and stops being flagged when the work ends. The browser's half — refreshing
 * while anything is running — is in the UI suite.
 *
 *   node test/live-runs.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { createPgStore } from '../server/store/pg.js';

process.env.ENCRYPTION_KEY ||= 'live-runs-test-encryption-key';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const db = await PGlite.create();
const store = createPgStore({
  async query(text, params = []) {
    return (await db.query(text, params)).rows;
  },
});
await store.init();

const user = await store.createUser({ id: 'u-live', email: 'live@example.com', name: 'Live', passwordHash: 'x', role: 'admin' });
const other = await store.createUser({ id: 'u-other', email: 'other@example.com', name: 'Other', passwordHash: 'x', role: 'member' });
const listed = async (id, who = user.id) => (await store.listChats(who)).find((c) => c.id === id);

section('a workflow run is listed the moment it starts');
{
  await store.createWorkflow(user.id, { id: 'wf-1', title: 'Bản tin sáng + email', steps: [{ instruction: 'a' }, { instruction: 'b' }] });
  await store.createChat(user.id, { id: 'c-wf', title: 'Bản tin sáng + email', model: 'm' });
  const run = await store.createWorkflowRun(user.id, { id: 'r-1', workflowId: 'wf-1', chatId: 'c-wf', status: 'running', steps: [] });

  const early = await listed('c-wf');
  check('listed before its first message', !!early, JSON.stringify(early));
  check('and flagged running', early?.running === true);
  check('another account does not see it', !(await listed('c-wf', other.id)));

  await store.appendMessage(user.id, 'c-wf', { id: 'm-1', role: 'user', text: 'Tóm tắt tin tức' });
  check('still running once messages arrive', (await listed('c-wf'))?.running === true);

  await store.saveWorkflowRun(run.id, { status: 'done', finished: true });
  const after = await listed('c-wf');
  check('when the run ends it stays listed, no longer running', after && after.running === false, JSON.stringify(after));
}

section('an empty conversation nothing is working in stays hidden');
{
  await store.createChat(user.id, { id: 'c-empty', title: 'Draft', model: 'm' });
  check('a brand-new empty chat is not listed', !(await listed('c-empty')));
  await store.createChat(user.id, { id: 'c-wf-done', title: 'Old run', model: 'm' });
  await store.createWorkflowRun(user.id, { id: 'r-old', workflowId: 'wf-1', chatId: 'c-wf-done', status: 'failed', steps: [] });
  check('nor one whose run already ended without writing anything', !(await listed('c-wf-done')));
}

section('a scheduled task run is flagged while it runs');
{
  const task = await store.createTask(user.id, { id: 't-1', title: 'Bản tin', prompt: 'x', nextRunAt: new Date(Date.now() - 1000).toISOString() });
  await db.query(`UPDATE scheduled_tasks SET run_state = 'running' WHERE id = $1`, [task.id]);
  await store.createChat(user.id, { id: 'c-task', title: 'Bản tin', model: 'm' });
  await store.appendMessage(user.id, 'c-task', { id: 'm-t', role: 'user', text: 'x' });
  await store.markTaskChat(task.id, 'c-task');
  check('the task conversation is running', (await listed('c-task'))?.running === true);
  await store.finishTask(task.id, { status: 'ok', chatId: 'c-task', nextRunAt: null });
  check('and not once the task finished', (await listed('c-task'))?.running === false);
}

section('a conversation turn holding the run lease is running; a stale lease is not');
{
  await store.createChat(user.id, { id: 'c-turn', title: 'Chat', model: 'm' });
  await store.appendMessage(user.id, 'c-turn', { id: 'm-c', role: 'user', text: 'hi' });
  check('idle to begin with', (await listed('c-turn'))?.running === false);
  await store.claimChatRun(user.id, 'c-turn', 'run-a');
  check('running while the lease is fresh', (await listed('c-turn'))?.running === true);
  await db.query(`UPDATE chats SET run_lock_at = NOW() - INTERVAL '10 minutes' WHERE id = 'c-turn'`);
  check('not running once the lease has gone stale', (await listed('c-turn'))?.running === false);
}

await db.close();
console.log(failures === 0 ? '\n\x1b[32mAll live-run checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
