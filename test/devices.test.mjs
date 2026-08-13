/**
 * Devices, pairing, and the new-model announcement.
 *
 * Three features that all turn on the same question — "is this the right
 * account?" — and all of which touch the one boundary this project treats as
 * non-negotiable: an account must never reach another account's computer.
 *
 * Pairing is the interesting one, because two of its endpoints are
 * unauthenticated. That is unavoidable (a computer that has never been paired
 * has nothing to authenticate with) and therefore worth pinning down hard: what
 * an unclaimed pairing can do, what a code is worth once spent, and what happens
 * when two people race for the same one.
 *
 *   node test/devices.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'devices-test-encryption-key';
process.env.SESSION_SECRET ||= 'devices-test-session-secret';
// Force the relay path. Without it the first account — an admin on a locally-run
// server — gets the in-process tools and never consults a paired device at all,
// which is correct behaviour and the wrong thing to be testing here.
process.env.WORKER_MODE = 'remote';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-devices-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();

const PORT = 5199;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body, headers = {}) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 120) };
      }
      return { status: res.status, json };
    },
  };
}

const anon = jar();
const alice = jar();
const bob = jar();

await alice.call('POST', '/api/register', {
  email: 'alice@example.com',
  password: 'a-long-enough-password',
  name: 'Alice',
});
await bob.call('POST', '/api/register', {
  email: 'bob@example.com',
  password: 'bobs-long-enough-password',
  name: 'Bob',
});

// ── the pairing code ────────────────────────────────────────────────
section('pairing codes');
{
  const { normaliseCode, pairingCode } = await import('../server/devices.js');

  const code = pairingCode();
  check('a code is ABCD-2K7M shaped', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);
  check(
    'and avoids the characters people misread',
    !/[IO01]/.test(code.replace('-', '')),
    code,
  );
  check('codes differ', new Set(Array.from({ length: 40 }, pairingCode)).size > 35);

  // Typed off a screen, so it has to survive being typed badly.
  check('lower case is accepted', normaliseCode('abcd-2k7m') === 'ABCD-2K7M');
  check('a missing dash is accepted', normaliseCode('ABCD2K7M') === 'ABCD-2K7M');
  check('spaces are accepted', normaliseCode(' ABCD 2K7M ') === 'ABCD-2K7M');
  check('the wrong length is refused', normaliseCode('ABCD') === null);
  check('nothing is refused', normaliseCode('') === null);
}

// ── what an unpaired computer can do ────────────────────────────────
section('an unclaimed pairing grants nothing');
let pairingId;
let pairingCodeValue;
{
  const started = await anon.call('POST', '/api/pair/start', {
    name: "Alice's laptop",
    info: { platform: 'win32 x64', workspace: 'D:\\projects' },
  });
  check('a computer may ask to be adopted', started.status === 201, `got ${started.status}`);
  check('and gets a code back', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(started.json?.code || ''), started.json?.code);
  check('with an expiry', started.json?.expiresInSec > 0, `${started.json?.expiresInSec}s`);

  pairingId = started.json.id;
  pairingCodeValue = started.json.code;

  const polled = await anon.call('GET', `/api/pair/poll?id=${pairingId}`);
  check('polling before anyone claims it says so', polled.json?.status === 'pending', JSON.stringify(polled.json));
  check('and hands out no token', !polled.json?.token);

  // The whole security argument: this request names no account and is attached
  // to none, so there is nothing for it to reach.
  const unknown = await anon.call('GET', '/api/pair/poll?id=not-a-real-pairing');
  check('an invented pairing id gets nothing', unknown.json?.status === 'unknown', JSON.stringify(unknown.json));

  const noSession = await anon.call('GET', '/api/devices');
  check('and the device list still needs a session', noSession.status === 401, `got ${noSession.status}`);
}

// ── claiming ────────────────────────────────────────────────────────
section('claiming a computer');
let laptopToken;
let laptopId;
{
  const wrong = await alice.call('POST', '/api/devices/pair', { code: 'ZZZZ-ZZZZ' });
  check('a code nobody is showing is refused', wrong.status === 400, `got ${wrong.status}`);

  const malformed = await alice.call('POST', '/api/devices/pair', { code: 'nope' });
  check('a malformed code is refused', malformed.status === 400, `got ${malformed.status}`);

  const claimed = await alice.call('POST', '/api/devices/pair', { code: pairingCodeValue });
  check('the right code pairs the computer', claimed.status === 201, JSON.stringify(claimed.json));
  check('and it keeps the name the machine gave', claimed.json?.device?.name === "Alice's laptop", claimed.json?.device?.name);
  check(
    'the browser is never given the token',
    !JSON.stringify(claimed.json).toLowerCase().includes('token'),
    JSON.stringify(claimed.json),
  );

  const collected = await anon.call('GET', `/api/pair/poll?id=${pairingId}`);
  check('the computer collects its token', collected.json?.status === 'paired', JSON.stringify(collected.json).slice(0, 80));
  check('and it is a real token', (collected.json?.token || '').length > 20);
  laptopToken = collected.json.token;
  laptopId = collected.json.deviceId;

  const again = await anon.call('GET', `/api/pair/poll?id=${pairingId}`);
  check('collected exactly once, then the row is gone', again.json?.status === 'unknown', JSON.stringify(again.json));

  const replay = await alice.call('POST', '/api/devices/pair', { code: pairingCodeValue });
  check('and the code cannot be spent twice', replay.status === 400, `got ${replay.status}`);
}

// ── every pairing is its own code ───────────────────────────────────
section('a code is never reused');
{
  const codes = [];
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const started = await anon.call('POST', '/api/pair/start', { name: `box-${i}` });
    codes.push(started.json.code);
    ids.push(started.json.id);
  }
  check('six pairings, six different codes', new Set(codes).size === 6, codes.join(' '));
  check('and six different ids', new Set(ids).size === 6);

  // The one already spent above must stay spent, whatever else is in flight.
  const replay = await bob.call('POST', '/api/devices/pair', { code: pairingCodeValue });
  check('a spent code stays spent', replay.status === 400, `got ${replay.status}`);

  // Claiming one of these must not disturb the others: each is its own offer.
  const claimed = await bob.call('POST', '/api/devices/pair', { code: codes[2] });
  check('claiming one works', claimed.status === 201, JSON.stringify(claimed.json).slice(0, 80));
  const other = await anon.call('GET', `/api/pair/poll?id=${ids[3]}`);
  check('and leaves the rest waiting', other.json?.status === 'pending', JSON.stringify(other.json));

  const spent = await alice.call('POST', '/api/devices/pair', { code: codes[2] });
  check('but that one cannot be claimed twice', spent.status === 400, `got ${spent.status}`);

  // Tidy up so later counts are predictable.
  const bobsBox = (await bob.call('GET', '/api/devices')).json.devices.find((d) => d.name === 'box-2');
  if (bobsBox) await bob.call('DELETE', `/api/devices/${bobsBox.id}`);
}

section('pairing does not care whose account it is');
{
  // The whole point of a code: the machine names nobody, so whoever is signed in
  // and holding it adopts it. A shared office computer, a colleague's laptop —
  // it is the person with the code who decides, which is what a code is for.
  const started = await anon.call('POST', '/api/pair/start', { name: 'Shared workstation' });
  const claimed = await bob.call('POST', '/api/devices/pair', { code: started.json.code });
  check("a second account can adopt a machine", claimed.status === 201, `got ${claimed.status}`);

  const bobs = (await bob.call('GET', '/api/devices')).json.devices;
  check('and it is theirs', bobs.some((d) => d.name === 'Shared workstation'));

  const alices = (await alice.call('GET', '/api/devices')).json.devices;
  check('not the other account\'s', !alices.some((d) => d.name === 'Shared workstation'));

  const box = bobs.find((d) => d.name === 'Shared workstation');
  await bob.call('DELETE', `/api/devices/${box.id}`);
}

section('the manual token path is gone');
{
  // One token per account meant adding a second computer silently cut off the
  // first, and it took a text editor and a restart. Pairing replaced it.
  const gone = await alice.call('POST', '/api/devices/token');
  check('generating an account-wide token is no longer offered', gone.status === 404, `got ${gone.status}`);

  const html = await (await fetch(`${base}/index.html`)).text();
  check('and the button is out of the interface', !/gen-worker-token/.test(html));
  check('replaced by a pairing sheet', /id="pair"/.test(html));
  check('reachable from the header', /id="pair-chip"/.test(html));
  check('with a copy button for the code', /id="pair-copy"/.test(html));
}

// ── the token works, and only for its owner ─────────────────────────
section('a device token is scoped to its account');
{
  const auth = { Authorization: `Bearer ${laptopToken}` };

  const beat = await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'win32 x64' } }, auth);
  check('the computer can check in', beat.status === 200, JSON.stringify(beat.json));
  check('and is told whose it is', beat.json?.account === 'alice@example.com', beat.json?.account);
  check('and what it is called', beat.json?.device === "Alice's laptop", beat.json?.device);

  const mine = await alice.call('GET', '/api/devices');
  check('it appears on the owner list', mine.json?.devices?.length === 1, `${mine.json?.devices?.length}`);
  check('as online', mine.json?.devices?.[0]?.online === true);
  check('with its platform', mine.json?.devices?.[0]?.platform === 'win32 x64', mine.json?.devices?.[0]?.platform);

  const theirs = await bob.call('GET', '/api/devices');
  check("and on nobody else's", theirs.json?.devices?.length === 0, `${theirs.json?.devices?.length}`);

  const stolen = await bob.call('DELETE', `/api/devices/${laptopId}`);
  check("another account cannot unpair it", stolen.status === 404, `got ${stolen.status}`);
  check(
    'and it is still there',
    (await alice.call('GET', '/api/devices')).json.devices.length === 1,
  );

  const garbage = await anon.call('POST', '/api/worker/heartbeat', { info: {} }, { Authorization: 'Bearer nonsense' });
  check('an invented token is refused', garbage.status === 401, `got ${garbage.status}`);
}

// ── more than one computer ──────────────────────────────────────────
section('an account can hold several computers');
{
  // The whole point: this used to invalidate the first machine.
  const started = await anon.call('POST', '/api/pair/start', {
    name: "Alice's desktop",
    info: { platform: 'linux x64' },
  });
  await alice.call('POST', '/api/devices/pair', { code: started.json.code });
  const collected = await anon.call('GET', `/api/pair/poll?id=${started.json.id}`);
  const desktopToken = collected.json.token;
  const desktopId = collected.json.deviceId;

  await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'linux x64' } }, {
    Authorization: `Bearer ${desktopToken}`,
  });

  const devices = (await alice.call('GET', '/api/devices')).json.devices;
  check('both are listed', devices.length === 2, `${devices.length}`);
  check('with different names', new Set(devices.map((d) => d.name)).size === 2);

  // And — the regression that made multi-device impossible before — the first
  // one still works.
  const stillAlive = await anon.call('POST', '/api/worker/heartbeat', { info: {} }, {
    Authorization: `Bearer ${laptopToken}`,
  });
  check(
    'pairing the second did not cut off the first',
    stillAlive.status === 200,
    `got ${stillAlive.status} — the old single-token scheme broke exactly here`,
  );

  // With two online, the assistant must act on one deliberately rather than
  // whichever polled first.
  const statusRes = await alice.call('GET', '/api/devices/status');
  const status = statusRes.json?.worker;
  check('the worker status answers', !!status, `${statusRes.status} ${JSON.stringify(statusRes.json).slice(0, 160)}`);
  check('the status names an active machine', !!status?.activeId, status?.activeId || 'none');
  check('and lists them both', status.machines?.length === 2, `${status.machines?.length}`);

  await alice.call('PUT', '/api/prefs', { activeDevice: laptopId });
  const switched = (await alice.call('GET', '/api/devices/status')).json.worker;
  check('the choice is honoured', switched.activeId === laptopId, switched.activeId);

  // A job is addressed, so the other machine must not be able to take it.
  await store.enqueueJob((await store.getUserByEmail('alice@example.com')).id, {
    id: 'job-for-laptop',
    chatId: null,
    tool: 'list_dir',
    input: { path: '.' },
    deviceId: laptopId,
  });
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  check(
    'the desktop cannot claim the laptop\'s job',
    (await store.claimJob(aliceId, desktopId)) === null,
  );
  check(
    'and the laptop can',
    (await store.claimJob(aliceId, laptopId))?.id === 'job-for-laptop',
  );

  // Unpairing must not leave work queued for a machine that will never answer.
  await store.enqueueJob(aliceId, {
    id: 'job-orphaned',
    chatId: null,
    tool: 'list_dir',
    input: {},
    deviceId: desktopId,
  });
  await alice.call('DELETE', `/api/devices/${desktopId}`);
  const orphan = await store.getJob(aliceId, 'job-orphaned');
  check('unpairing fails its queued jobs', orphan.status === 'error', orphan.status);
  check(
    'rather than leaving the agent to wait out the timeout',
    /unpaired/i.test(JSON.stringify(orphan.result)),
    JSON.stringify(orphan.result),
  );

  const revoked = await anon.call('POST', '/api/worker/heartbeat', { info: {} }, {
    Authorization: `Bearer ${desktopToken}`,
  });
  check('and its token stops working', revoked.status === 401, `got ${revoked.status}`);
  check(
    'while the other computer carries on',
    (await anon.call('POST', '/api/worker/heartbeat', { info: {} }, {
      Authorization: `Bearer ${laptopToken}`,
    })).status === 200,
  );
}

// ── changing where a computer works ─────────────────────────────────
section('the working folder is changed from the app');
{
  const auth = { Authorization: `Bearer ${laptopToken}` };

  const before = (await alice.call('GET', '/api/devices')).json.devices[0];
  check('a fresh device has no chosen folder', before.wanted === null, String(before.wanted));

  const relative = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'projects' });
  check('a relative path is refused', relative.status === 400, `got ${relative.status}`);
  check('and says what is wanted', /absolute path/i.test(relative.json?.error || ''), relative.json?.error);

  const tooLong = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, {
    path: `D:\\${'x'.repeat(500)}`,
  });
  check('an absurd path is refused', tooLong.status === 400, `got ${tooLong.status}`);

  const set = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'D:\\projects\\shop' });
  check('an absolute path is accepted', set.status === 200, JSON.stringify(set.json));
  check('and remembered', set.json?.device?.wanted === 'D:\\projects\\shop', set.json?.device?.wanted);

  // The reply to a heartbeat is the only channel to the machine — nothing on the
  // internet connects inward — so this is how the setting actually gets there.
  const beat = await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'win32 x64' } }, auth);
  check(
    'the machine is told on its next heartbeat',
    beat.json?.config?.workspace === 'D:\\projects\\shop',
    JSON.stringify(beat.json?.config),
  );

  // What it is really using, versus what it was asked to use.
  await anon.call('POST', '/api/worker/heartbeat', {
    info: { platform: 'win32 x64', workspace: 'D:\\projects\\shop' },
  }, auth);
  const adopted = (await alice.call('GET', '/api/devices')).json.devices[0];
  check('and reports back where it actually is', adopted.workspace === 'D:\\projects\\shop', adopted.workspace);
  check('with no complaint', !adopted.workspaceError, adopted.workspaceError);

  // A folder that is not there is the machine's problem to notice, and the app
  // has to show that rather than a path quietly not in use.
  await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'D:\\nope' });
  await anon.call('POST', '/api/worker/heartbeat', {
    info: { platform: 'win32 x64', workspace: 'D:\\projects\\shop', workspaceError: 'There is no folder at D:\\nope' },
  }, auth);
  const failed = (await alice.call('GET', '/api/devices')).json.devices[0];
  check('a bad folder surfaces as an error', /no folder/i.test(failed.workspaceError || ''), failed.workspaceError);
  check('and it keeps working where it was', failed.workspace === 'D:\\projects\\shop', failed.workspace);

  const cleared = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: '' });
  check('clearing it is allowed', cleared.status === 200, JSON.stringify(cleared.json));
  check('and hands the choice back to the machine', cleared.json?.device?.wanted === null, String(cleared.json?.device?.wanted));

  const theirs = await bob.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'D:\\mine' });
  check("another account cannot move somebody else's computer", theirs.status === 400, `got ${theirs.status}`);
}

section('set_workspace asks first');
{
  const { assessRisk, riskReason, TOOLS_BY_NAME } = await import('../server/tools/definitions.js');

  check('the tool is offered', !!TOOLS_BY_NAME.set_workspace);
  check('it runs on the machine', TOOLS_BY_NAME.set_workspace.scope === 'local');
  check('and is not read-only', TOOLS_BY_NAME.set_workspace.readOnly === false);

  // Moving the boundary the file tools are confined to is the user's call, not
  // something the assistant settles on its own along the way.
  check(
    'moving the workspace always stops for a yes',
    assessRisk('set_workspace', { path: 'D:\\projects' }) === 'sensitive',
    assessRisk('set_workspace', { path: 'D:\\projects' }),
  );
  check(
    'and says where it is going',
    /D:\\projects/.test(riskReason('set_workspace', { path: 'D:\\projects' }) || ''),
    riskReason('set_workspace', { path: 'D:\\projects' }),
  );

  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');
  check('the worker implements it', typeof LOCAL_IMPLEMENTATIONS.set_workspace === 'function');
}

// ── a new model has arrived ─────────────────────────────────────────
section('new-model announcement');
{
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();

  // Already in the library before anybody looked: this must never be announced,
  // whatever its release date, or the first sign-in is a stack of catch-up.
  await store.upsertModels([
    {
      id: 'openrouter/nobody/ancient-model',
      provider: 'openrouter',
      model: 'nobody/ancient-model',
      family: 'nobody',
      label: 'Ancient Model',
      context: 4096,
      priceIn: 1,
      priceOut: 1,
      isFree: false,
      releasedAt: old,
    },
    {
      id: 'openrouter/google/pre-existing-gemini',
      provider: 'openrouter',
      model: 'google/pre-existing-gemini',
      family: 'google',
      label: 'Pre-existing Gemini',
      context: 1_000_000,
      priceIn: 2,
      priceOut: 8,
      isFree: false,
      releasedAt: recent,
    },
  ]);

  // "New" means arrived after this account started watching, not "released
  // recently" — otherwise a fresh account meets a queue of modals catching it up
  // on the whole of last month, one per reload, which is how a useful notice
  // becomes the thing people close without reading.
  const firstLook = await alice.call('GET', '/api/models/news');
  check(
    'the first look announces nothing',
    firstLook.json?.model === null,
    'there is no news on the day you subscribe',
  );
  await bob.call('GET', '/api/models/news'); // draw Bob's line too

  // Now something genuinely arrives.
  await store.upsertModels([
    {
      id: 'openrouter/anthropic/claude-fictional-9',
      provider: 'openrouter',
      model: 'anthropic/claude-fictional-9',
      family: 'anthropic',
      label: 'Claude Fictional 9',
      description: 'A model invented by the test suite.',
      context: 500_000,
      priceIn: 4,
      priceOut: 20,
      isFree: false,
      releasedAt: recent,
    },
  ]);

  const news = await alice.call('GET', '/api/models/news');
  check('a model that arrives afterwards is announced', news.json?.model?.id === 'openrouter/anthropic/claude-fictional-9', news.json?.model?.id || 'none');

  const m = news.json.model;
  check('with the vendor named', m.vendor === 'Claude', m.vendor);
  check('the context window', m.context === 500_000, String(m.context));
  check('the price', m.price?.in === 4 && m.price?.out === 20, JSON.stringify(m.price));
  check('the release date', !!m.releasedAt);
  check('and what it is', /invented by the test suite/.test(m.description || ''), m.description);

  check('the same news is waiting for another account', (await bob.call('GET', '/api/models/news')).json?.model?.id === m.id);

  // Declining is a decision, and decisions are not re-litigated.
  const declined = await alice.call('POST', '/api/models/news', { id: m.id, action: 'decline' });
  check('declining is accepted', declined.status === 200, JSON.stringify(declined.json).slice(0, 80));
  check('and does not change the default model', declined.json?.prefs?.defaultModel !== m.id, declined.json?.prefs?.defaultModel);
  check('asked once per account', (await alice.call('GET', '/api/models/news')).json?.model === null);

  // Alice's decision is Alice's. Checked against the stored state rather than by
  // re-asking, because Bob is inside his own once-a-day quiet period — asking
  // would answer null for a completely different and equally correct reason.
  const bobId = (await store.getUserByEmail('bob@example.com')).id;
  const bobState = await store.getUserSetting(bobId, 'modelNews');
  check(
    "one person's answer is not recorded against another",
    !bobState?.seen?.[m.id],
    JSON.stringify(bobState?.seen || {}),
  );
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  const aliceState = await store.getUserSetting(aliceId, 'modelNews');
  check('while her own is', aliceState?.seen?.[m.id]?.action === 'decline', JSON.stringify(aliceState?.seen?.[m.id]));

  // Applying is the point of the button: being told and then having to go
  // hunting in a picker is a half-finished feature.
  const applied = await bob.call('POST', '/api/models/news', { id: m.id, action: 'apply' });
  check('applying sets it as the default', applied.json?.prefs?.defaultModel === m.id, applied.json?.prefs?.defaultModel);
  check('and is also only asked once', (await bob.call('GET', '/api/models/news')).json?.model === null);

  check(
    'an old model is never announced',
    (await alice.call('GET', '/api/models/news')).json?.model === null,
    'nothing recent and notable is left',
  );

  const bogus = await alice.call('POST', '/api/models/news', { id: 'made/up', action: 'apply' });
  check('a model that is not in the library cannot become a default', bogus.status === 400, `got ${bogus.status}`);

  const nonsense = await alice.call('POST', '/api/models/news', { id: m.id, action: 'sideways' });
  check('and neither is a made-up decision', nonsense.status === 400, `got ${nonsense.status}`);

  check('the announcement needs a session', (await anon.call('GET', '/api/models/news')).status === 401);
}

server.close();
await new Promise((r) => server.once('close', r));
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\n[32mAll device and announcement checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
