/**
 * A NUL character from the outside world does not stop a run.
 *
 * A workflow step failed with "unsupported Unicode escape sequence": a web page
 * the assistant read contained U+0000, the tool result carrying it was written
 * into a JSONB column, and Postgres refuses `\u0000` in JSON — and a raw NUL
 * byte in a text column too. Nothing about the page was wrong enough to lose a
 * whole step over; the character carries no meaning in anything stored here.
 *
 * So every value the store writes is cleaned of it, at the one place every query
 * passes through. Checked against PGlite, which is Postgres and refuses the same
 * way Neon does.
 *
 *   node test/null-character.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { createPgStore } from '../server/store/pg.js';

process.env.ENCRYPTION_KEY ||= 'nul-test-encryption-key';

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

const NUL = String.fromCharCode(0);
const user = await store.createUser({ id: 'u-nul', email: 'nul@example.com', name: 'Nul', passwordHash: 'x', role: 'admin' });

const attempt = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

section('Postgres itself refuses the character — the failure being guarded against');
{
  const raw = await attempt(() => db.query('SELECT $1::jsonb AS v', [JSON.stringify({ text: `a${NUL}b` })]));
  check('a JSON \\u0000 escape is refused by jsonb', !raw.ok && /unsupported Unicode escape sequence/i.test(raw.error), raw.error);
}

section('a message carrying NUL is stored, without it');
{
  const chat = await store.createChat(user.id, { id: 'c-nul', title: `Tin${NUL} tức`, model: 'm' });
  check('a title with NUL is stored', !!chat);

  const page = `Trang web${NUL} có ký tự lạ${NUL}.`;
  const appended = await attempt(() =>
    store.appendMessage(user.id, 'c-nul', {
      id: 'm-1',
      role: 'tool',
      toolCallId: 't1',
      text: page,
      result: { content: page, nested: [{ deeper: `x${NUL}y` }] },
    }),
  );
  check('a tool result from a page with NUL is appended', appended.ok, appended.error);

  const [stored] = await store.listMessages(user.id, 'c-nul');
  check('and reads back without the character', stored?.text === 'Trang web có ký tự lạ.', JSON.stringify(stored?.text));
  check('including inside nested values', stored?.result?.nested?.[0]?.deeper === 'xy', JSON.stringify(stored?.result));

  const chats = await store.listChats(user.id);
  check('the title reads back without it too', chats.find((c) => c.id === 'c-nul')?.title === 'Tin tức', chats[0]?.title);
}

section('ordinary text is untouched');
{
  const text = 'Backslash-u text stays: \\u0000 and "quotes" and emoji 🚀';
  await store.appendMessage(user.id, 'c-nul', { id: 'm-2', role: 'user', text });
  const messages = await store.listMessages(user.id, 'c-nul');
  check('a literal backslash sequence is not mistaken for NUL', messages.find((m) => m.id === 'm-2')?.text === text, messages.find((m) => m.id === 'm-2')?.text);
}

await db.close();
console.log(failures === 0 ? '\n\x1b[32mAll NUL checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
