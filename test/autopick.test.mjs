/**
 * Auto model picking — "choose the best free model" without a quality column.
 *
 * There is no objective "strength" in a model's metadata, so best is decided by
 * a curated family order (deepseek first, as the strongest free families tend to
 * lead) and, within a family, the newest and roomiest. What the tests pin is the
 * judgement around that: a model is only dropped when EVERY key for its provider
 * is resting — because someone stacking keys for fallback should have all of
 * them spent before a model disappears — and the vision filter, and that nothing
 * paid is ever chosen.
 *
 *   node test/autopick.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'autopick-test-encryption-key';
process.env.SESSION_SECRET ||= 'autopick-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-autopick-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const { pickAutoModel } = await import('../server/autoPick.js');
const { setApiKey, addApiKey, markKeyLimited, markKeyDead, clearKeyRest } = await import('../server/settings.js');

const uid = 'u-auto';
await store.createUser({
  id: uid,
  email: 'auto@example.com',
  name: 'Auto',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

/** Seed one shared-library row, filling the shape `normalise` produces. */
const model = (over) => ({
  id: over.id,
  provider: over.provider || 'openrouter',
  model: over.id.split('/').slice(1).join('/'),
  family: over.family,
  label: over.id,
  description: null,
  context: over.context ?? 64_000,
  maxOutput: 8192,
  priceIn: over.free === false ? 5 : 0,
  priceOut: over.free === false ? 25 : 0,
  isFree: over.free !== false,
  vision: !!over.vision,
  releasedAt: over.releasedAt || '2026-01-01T00:00:00.000Z',
});

await store.upsertModels([
  model({ id: 'openrouter/qwen/qwen3-30b:free', family: 'qwen', releasedAt: '2026-06-01T00:00:00.000Z' }),
  model({ id: 'openrouter/deepseek/deepseek-v4-flash:free', family: 'deepseek', releasedAt: '2026-05-01T00:00:00.000Z' }),
  model({ id: 'openrouter/deepseek/deepseek-r1:free', family: 'deepseek', releasedAt: '2026-07-01T00:00:00.000Z', vision: false }),
  model({ id: 'openrouter/deepseek/deepseek-vl:free', family: 'deepseek', releasedAt: '2026-03-01T00:00:00.000Z', vision: true }),
  model({ id: 'openrouter/meta-llama/llama-3.3:free', family: 'meta' }),
  model({ id: 'openrouter/anthropic/claude:paid', family: 'anthropic', free: false }),
]);

section('best free is chosen by family order, then recency');
{
  await setApiKey(uid, 'openrouter', 'k1');
  clearKeyRest(uid, 'openrouter');
  const m = await pickAutoModel(uid, { vision: false });
  // deepseek outranks qwen and meta; within deepseek the newest is r1 (Jul).
  check('a deepseek model wins over qwen and meta', m?.family === 'deepseek', m?.id);
  check('and the newest deepseek at that', m?.id === 'openrouter/deepseek/deepseek-r1:free', m?.id);
  check('and nothing paid is ever chosen', m?.isFree !== false, m?.id);
}

section('vision on narrows to models that can see');
{
  const m = await pickAutoModel(uid, { vision: true });
  // r1 has no vision; the only deepseek that sees is deepseek-vl.
  check('the chosen model can read images', m?.vision === true, m?.id);
  check('and it is still the best such deepseek', m?.id === 'openrouter/deepseek/deepseek-vl:free', m?.id);
}

section('a model is dropped only when every key for its provider is resting');
{
  // deepseek/qwen/meta are all openrouter here. Rest one of two keys: still
  // available, because the other key can serve them.
  await setApiKey(uid, 'openrouter', 'k1');
  await addApiKey(uid, 'openrouter', 'k2');
  clearKeyRest(uid, 'openrouter');
  markKeyLimited(uid, 'openrouter', 0, Date.now() + 60_000);
  const stillThere = await pickAutoModel(uid, { vision: false });
  check('one resting key of two does not drop the model', stillThere?.family === 'deepseek', stillThere?.id);

  // Rest the second key too: now no key can serve openrouter, so nothing free
  // is reachable and the pick is empty rather than a model that cannot run.
  markKeyLimited(uid, 'openrouter', 1, Date.now() + 60_000);
  const gone = await pickAutoModel(uid, { vision: false });
  check('both keys resting leaves no reachable model', gone === null, gone?.id || 'null');
  clearKeyRest(uid, 'openrouter');
}

section('no key and no free model both yield nothing, not a guess');
{
  const { setApiKey: setKey } = await import('../server/settings.js');
  // A provider the account has no key for: its free models are unreachable.
  await store.upsertModels([model({ id: 'orcarouter/deepseek/x:free', family: 'deepseek', provider: 'orcarouter' })]);
  clearKeyRest(uid, 'openrouter');
  await setKey(uid, 'openrouter', 'k1'); // openrouter yes, orcarouter no
  const m = await pickAutoModel(uid, { vision: false });
  check('an unreachable provider is skipped', m?.provider === 'openrouter', m?.id);

  // Strip every key: nothing is reachable at all.
  await setKey(uid, 'openrouter', '');
  markKeyDead(uid, 'orcarouter', 0);
  const none = await pickAutoModel(uid, { vision: false });
  check('no usable key yields null', none === null, none?.id || 'null');
}

section('resolveForUser expands auto, and passes a real id straight through');
{
  const { resolveForUser } = await import('../server/autoPick.js');
  const { setApiKey, clearKeyRest } = await import('../server/settings.js');
  await setApiKey(uid, 'openrouter', 'k1');
  clearKeyRest(uid, 'openrouter');

  // A real id is resolved as-is — auto handling must not touch the normal path.
  const real = await resolveForUser(uid, 'anthropic/claude-opus-5');
  check('a concrete id resolves to that model', real?.id === 'anthropic/claude-opus-5', real?.id);

  // 'auto' becomes a concrete, runnable free model — the thing sub-agents and
  // compaction could not do before, which crashed the moment auto was selected.
  const picked = await resolveForUser(uid, 'auto');
  check('auto resolves to a concrete free model', picked?.provider === 'openrouter' && picked?.id !== 'auto', picked?.id);

  // With nothing free reachable, it is a clear throw rather than a broken id.
  await setApiKey(uid, 'openrouter', '');
  let threw = '';
  try {
    await resolveForUser(uid, 'auto');
  } catch (err) {
    threw = err.message;
  }
  check('auto with no free model throws a clear error', /free model/i.test(threw), threw);
}

section('the library filters by provider, so a row limit cannot hide one');
{
  // The bug this pins: with hundreds of models and a default limit, the newest
  // (mostly one aggregator) fill the page and the other aggregator's models
  // never reach the client. A provider filter at the database keeps each one
  // reachable on its own tab.
  const orca = await store.listSharedModels({ provider: 'orcarouter', limit: 500 });
  check('only orcarouter rows come back', orca.length >= 1 && orca.every((m) => m.provider === 'orcarouter'), `${orca.length}`);
  const or = await store.listSharedModels({ provider: 'openrouter', limit: 500 });
  check('and openrouter is a separate set', or.length >= 1 && or.every((m) => m.provider === 'openrouter'), `${or.length}`);
  const all = await store.listSharedModels({ limit: 500 });
  check('no provider filter still returns both', all.some((m) => m.provider === 'orcarouter') && all.some((m) => m.provider === 'openrouter'));
}

await store.close?.();
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n\x1b[32mAll auto-pick checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
