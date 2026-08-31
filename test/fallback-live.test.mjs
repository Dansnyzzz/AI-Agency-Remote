/**
 * Key fallback down the real adapter, not a stubbed generator.
 *
 * `fallback.test.mjs` injects `streamOne`, which is right for pinning the
 * rotation logic but skips the two layers underneath it: the OpenAI SDK, and
 * `classify` reading whatever shape of error that SDK actually throws. A 401
 * from a mocked function is not a 401 from `openai` — the status lands on a
 * different field, or not at all — so the injected suite could stay green while
 * the real path failed to rotate.
 *
 * This drives `streamCompletion` with no injection, against a throwaway HTTP
 * server pretending to be an OpenAI-compatible endpoint. It is the closest thing
 * to a spent key that does not cost a real one.
 *
 *   node test/fallback-live.test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'fallback-live-encryption-key';
process.env.SESSION_SECRET ||= 'fallback-live-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-fallback-live-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/** One OpenAI-style SSE reply that says `text` and then stops. */
function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * A stand-in OpenAI endpoint whose behaviour is decided per request by the
 * bearer token, so one server covers every case. Records the keys it saw and
 * how many times, which is the whole point: it proves which key answered.
 */
const seen = [];
let plan = {};
const server = http.createServer((req, res) => {
  const key = (req.headers.authorization || '').replace(/^Bearer /, '');
  seen.push(key);
  const behaviour = plan[key] || 'ok';

  if (behaviour === 'dead') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  } else if (
    behaviour === 'limited-always' ||
    (behaviour === 'limited-once' && seen.filter((k) => k === key).length === 1)
  ) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
  } else {
    sse(res, `answered by ${key}`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
process.env.OPENAI_BASE_URL = base;

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const { streamCompletion } = await import('../server/providers/index.js');
const { setApiKey, addApiKey, clearKeyRest } = await import('../server/settings.js');

const uid = 'u-live';
await store.createUser({
  id: uid,
  email: 'live@example.com',
  name: 'Live',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

const entry = { id: 'openai/gpt-x', provider: 'openai', model: 'gpt-x', context: 128_000, maxOutput: 1024 };

/** Run one turn to its text, through the real adapter. */
async function run() {
  const events = [];
  for await (const ev of streamCompletion({ userId: uid, entry, messages: [{ id: 'u1', role: 'user', text: 'hi' }] })) {
    events.push(ev);
  }
  return events;
}

section('a dead key rotates, down the real SDK and error path');
{
  seen.length = 0;
  plan = { 'dead-key': 'dead', 'good-key': 'ok' };
  await setApiKey(uid, 'openai', 'dead-key');
  await addApiKey(uid, 'openai', 'good-key');
  clearKeyRest(uid, 'openai');

  const events = await run();
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  // The proof the injected suite cannot give: the 401 that came back was a real
  // `openai` SDK error, and `classify` still read it as a dead key.
  check('the answer comes from the second key', text.includes('good-key'), text);
  check('and the first key was actually tried', seen.includes('dead-key'), seen.join(','));
  check('and only rotated once', seen.length === 2, seen.join(','));
}

section('a 429 is waited out on the same key, not bounced to the next');
{
  seen.length = 0;
  plan = { 'only-live-key': 'limited-once' };
  await setApiKey(uid, 'openai', 'only-live-key');
  clearKeyRest(uid, 'openai');

  const started = Date.now();
  const events = await run();
  const elapsed = Date.now() - started;
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

  // The single-key free-tier case, end to end: rate limited once, waited on the
  // strength of the retry-after header, answered on the retry. If the SDK's own
  // retries were still on, the wait would be doubled and the key hit more than
  // twice; this pins that streamCompletion is the only layer retrying.
  check('it still answers', text.includes('only-live-key'), text);
  check('having tried the one key exactly twice', seen.length === 2, `${seen.length} hits`);
  check('and waited about the second the provider asked for', elapsed >= 900 && elapsed < 4000, `${elapsed}ms`);
}

section('a rate-limited key is left for the next one, not retried under us');
{
  seen.length = 0;
  plan = { 'busy-key': 'limited-always', 'spare-key': 'ok' };
  await setApiKey(uid, 'openai', 'busy-key');
  await addApiKey(uid, 'openai', 'spare-key');
  clearKeyRest(uid, 'openai');

  const events = await run();
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

  // With another key waiting, a 429 on the first should move straight to the
  // second — not sit through the SDK's own retries on a key already known to be
  // limited. If the SDK still retried, `busy-key` would appear three times
  // before `spare-key`; streamCompletion being the only retry layer means it
  // appears once.
  check('the spare key answers', text.includes('spare-key'), text);
  check('the busy key was tried once, then dropped', seen.filter((k) => k === 'busy-key').length === 1, seen.join(','));
}

server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\n\x1b[32mAll live-fallback checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
