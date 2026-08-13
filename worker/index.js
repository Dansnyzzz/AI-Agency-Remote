import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setWorkspace, moveWorkspace } from './paths.js';
import { LOCAL_IMPLEMENTATIONS, workerInfo } from './tools.js';
import { setFrameSink } from './screen.js';
import { setIndexSink } from './indexer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Load worker/.env, then the repo-root .env, without pulling in a dependency. */
function loadEnv() {
  for (const file of [path.join(here, '.env'), path.resolve(here, '../.env')]) {
    if (!fs.existsSync(file)) continue;
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
}

loadEnv();

const SERVER_URL = (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5173}`).replace(/\/$/, '');
const WORKSPACE = process.env.WORKSPACE || path.join(os.homedir(), 'AI-Remote-Workspace');
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname() || 'A computer';

/**
 * Where the pending pairing code is left for a co-located app to read.
 *
 * Under `data/`, which is already the folder this project keeps local state in
 * and already git-ignored — a secret that lasts ten minutes should still not be
 * something you can commit by accident.
 */
const PENDING_CODE_FILE = path.resolve(
  process.env.DATA_DIR || path.join(here, '..', 'data'),
  'pending-pairing.json',
);

setWorkspace(WORKSPACE);

/**
 * Get this computer a token, one way or another.
 *
 * Asking somebody to open a web app, find a settings tab, press a button, copy a
 * secret, find a file, paste it in and save was six steps of ceremony before the
 * thing could do anything — and every one of them a place to give up. So the
 * machine asks for a code and prints it, and the person types eight characters
 * into the app they already have open.
 *
 * The direction matters for more than convenience. Nothing here is authenticated,
 * because a computer that has never been paired has nothing to authenticate
 * with; what it gets in return for asking is a code, and a code is worth nothing
 * until somebody who *is* signed in decides this machine is theirs.
 *
 * Once paired, the token is written to worker/.env and this never runs again.
 */
async function pair() {
  const start = await fetch(`${SERVER_URL}/api/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DEVICE_NAME, info: workerInfo() }),
  });
  if (!start.ok) {
    throw new Error(`the server refused to start pairing (HTTP ${start.status})`);
  }
  const { id, code, expiresInSec } = await start.json();
  publishCode(code, expiresInSec);

  // Measured rather than hard-coded: a box whose right edge does not line up
  // looks like something went wrong, which is the opposite of what this moment
  // should convey.
  const line = `Pairing code:   ${code}`;
  const width = line.length + 12;
  const pad = (text = '') => `  │${text.padStart((width + text.length) / 2).padEnd(width)}│`;

  console.log(`\n  ┌${'─'.repeat(width)}┐`);
  console.log(pad());
  console.log(pad(line));
  console.log(pad());
  console.log(`  └${'─'.repeat(width)}┘\n`);
  console.log(`  Open ${SERVER_URL} on any device — a phone is fine — sign in, and press`);
  console.log('  "Computers" in the header. Enter the code above.\n');
  console.log('  It does not have to be your own account: whoever enters the code gets');
  console.log(`  this computer. Good for ${Math.round(expiresInSec / 60)} minutes. Waiting…\n`);

  const deadline = Date.now() + expiresInSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${SERVER_URL}/api/pair/poll?id=${encodeURIComponent(id)}`);
    if (!res.ok) continue;
    const outcome = await res.json();

    if (outcome.status === 'paired') {
      unpublishCode();
      return outcome;
    }
    if (outcome.status === 'expired' || outcome.status === 'unknown') break;
  }
  unpublishCode();

  throw new Error('nobody claimed this computer in time');
}

/**
 * Remember the token, so pairing is a thing that happens once.
 *
 * Written to `worker/.env` rather than held in memory: the whole promise is that
 * you sign in and your computer is simply there, and a machine that needed
 * re-pairing after every reboot would not be that.
 */
function saveToken(token) {
  const file = path.join(here, '.env');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const kept = existing
    .split('\n')
    .filter((line) => !/^\s*WORKER_TOKEN\s*=/.test(line))
    .join('\n')
    .replace(/\n+$/, '');

  const body = `${kept ? `${kept}\n` : ''}\n# Written by the pairing flow. Delete it to pair this computer again.\nWORKER_TOKEN=${token}\n`;
  fs.writeFileSync(file, body.replace(/^\n/, ''), { mode: 0o600 });
  return file;
}

/**
 * Leave the pending code where a co-located app can read it.
 *
 * Reading eight characters off a terminal and typing them into a browser is
 * fine, and mistyping them is also fine — but when the app happens to be running
 * on this same machine, it can simply show the code with a button that copies
 * it. That is the ordinary case for somebody who just ran `npm start`.
 *
 * A file rather than an API call, deliberately. The server has no idea which
 * unclaimed pairing belongs to the person looking at it — that is the whole
 * point of a code — so the only safe way to answer "what is *this* computer's
 * code" is to be on the same disk as the computer asking.
 */
function publishCode(code, expiresInSec) {
  try {
    fs.mkdirSync(path.dirname(PENDING_CODE_FILE), { recursive: true });
    fs.writeFileSync(
      PENDING_CODE_FILE,
      JSON.stringify({
        code,
        name: DEVICE_NAME,
        server: SERVER_URL,
        expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch {
    // The terminal already has the code; a missing convenience is not a failure.
  }
}

/** The code has been spent or has expired. Nothing should still be offering it. */
function unpublishCode() {
  try {
    fs.rmSync(PENDING_CODE_FILE, { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/** Forget a token the server no longer recognises, so the next start pairs. */
function clearToken() {
  const file = path.join(here, '.env');
  if (!fs.existsSync(file)) return;
  const kept = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*WORKER_TOKEN\s*=/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(file, kept, { mode: 0o600 });
}

let TOKEN = process.env.WORKER_TOKEN || '';
let WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * Keep asking until somebody adopts this computer.
 *
 * Not `process.exit(1)`, which is what it used to do. A code lasts ten minutes;
 * the person meant to type it may be in another room, or asleep, or have gone to
 * make tea. Quitting because nobody was quick enough turns "leave it running and
 * pair it when you get a moment" into "start it again and be quicker this time",
 * which is a strange thing to ask of a program whose whole job is waiting.
 *
 * Each round asks for a **fresh** code. They are single-use and short-lived, so
 * a code that was shown, expired, and reused would be exactly the loose end this
 * is meant not to leave.
 */
async function pairUntilAdopted() {
  for (;;) {
    try {
      return await pair();
    } catch (err) {
      console.error(`\n  Not paired yet: ${err.message}`);
      console.error(`  Asking for a new code. (server: ${SERVER_URL})\n`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (!TOKEN) {
  const paired = await pairUntilAdopted();
  TOKEN = paired.token;
  // The device id doubles as the worker id, so presence and identity are one row
  // rather than two things that have to be kept in step.
  WORKER_ID = paired.deviceId || WORKER_ID;
  const file = saveToken(TOKEN);
  console.log(`  Paired as "${paired.name || DEVICE_NAME}". Token saved to ${file}\n`);
}

/**
 * Rebuilt on every re-pair, so a machine that is adopted again carries on rather
 * than authenticating with a token somebody has just revoked.
 */
let authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/**
 * Start over, because this computer is no longer paired.
 *
 * Somebody removed it in the app, or the token was rotated. The old advice was
 * "delete a line from a file and run this again", which is a chore, and one that
 * has to be done at the machine — the exact thing pairing exists to avoid. It
 * simply asks for a new code instead, and prints it.
 */
async function repair() {
  console.log('\n  Asking to be paired again…\n');
  clearToken();

  const paired = await pairUntilAdopted();
  TOKEN = paired.token;
  WORKER_ID = paired.deviceId || WORKER_ID;
  authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  saveToken(TOKEN);
  console.log(`  Paired again as "${paired.name || DEVICE_NAME}".\n`);
}

// Frames from the browser sandbox and the desktop mirror both come through
// here, and go to the server, which hands them to whichever tab has the screen
// panel open.
setFrameSink(async (payload) => {
  const res = await fetch(`${SERVER_URL}/api/worker/screen`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
  });
  return res.ok ? res.json() : { watching: false };
});

/**
 * Chunked documents on their way to be embedded.
 *
 * The same shape of hop as the screen frames: this machine has the files and the
 * server has the API key, so the text goes up and the vectors come back as rows
 * in a table. Only the folder somebody named is ever walked.
 */
setIndexSink((payload) => post('/api/worker/index', payload));

async function post(pathname, body) {
  const res = await fetch(`${SERVER_URL}${pathname}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    // Surface the server's own sentence when it sent one. These reach the model
    // as the tool's error, and "add an OpenAI key in Settings" is actionable in
    // a way that "HTTP 400" is not.
    const body = await res.text().catch(() => '');
    let stated = '';
    try {
      stated = JSON.parse(body)?.error || '';
    } catch {
      /* not JSON — fall back to the raw body below */
    }
    throw new Error(stated || `${pathname} → HTTP ${res.status} ${body}`);
  }
  return res.json();
}

async function runJob(job) {
  const impl = LOCAL_IMPLEMENTATIONS[job.tool];
  const label = job.tool === 'run_command' ? `run_command: ${job.input?.command}` : job.tool;
  console.log(`  → ${label}`);

  if (!impl) {
    await post(`/api/worker/jobs/${job.id}/result`, {
      error: `This worker does not implement "${job.tool}".`,
    }).catch(() => {});
    return;
  }
  try {
    const output = await impl(job.input || {});
    await post(`/api/worker/jobs/${job.id}/result`, { output: String(output ?? '') });
    console.log(`  ✓ ${job.tool}`);
  } catch (err) {
    // Reporting the failure can itself fail — the server may have gone away
    // mid-job. Swallowing that is right: the agent times the job out and says
    // so, whereas an unhandled rejection here takes the whole worker down and
    // every other job with it.
    await post(`/api/worker/jobs/${job.id}/result`, { error: err?.message || String(err) }).catch(
      () => {},
    );
    console.log(`  ✗ ${job.tool}: ${err?.message || err}`);
  }
}

let online = false;

/**
 * Adopt settings chosen in the app.
 *
 * The reply to a heartbeat is the only channel there is — nothing on the
 * internet connects inward to this machine — and it is enough, because the
 * worker is already asking every fifteen seconds. So "work in D:\projects
 * instead" is something you type on a phone and this picks up, rather than
 * something that needs a file edited here and the process restarted.
 *
 * A bad path is reported and then left alone. Changing where the assistant works
 * is not worth stopping the worker over, and repeating the complaint every
 * fifteen seconds would bury everything else.
 */
let appliedWorkspace = null;
let workspaceComplaint = '';

function applyConfig(config) {
  const wanted = config?.workspace || null;
  if (wanted === appliedWorkspace) return;

  if (!wanted) {
    // Handed back to whatever this machine was started with.
    appliedWorkspace = null;
    workspaceComplaint = '';
    setWorkspace(WORKSPACE);
    console.log(`  Workspace reset to ${WORKSPACE}`);
    return;
  }

  try {
    const now = moveWorkspace(wanted);
    appliedWorkspace = wanted;
    workspaceComplaint = '';
    console.log(`  Workspace is now ${now}`);
  } catch (err) {
    if (workspaceComplaint !== err.message) {
      workspaceComplaint = err.message;
      console.error(`  Cannot use that workspace: ${err.message}`);
    }
  }
}

async function heartbeat() {
  try {
    const res = await post('/api/worker/heartbeat', {
      workerId: WORKER_ID,
      // `workerInfo()` reports the workspace actually in use, so the app shows
      // where the assistant really is rather than where it was asked to be.
      info: { ...workerInfo(), workspaceError: workspaceComplaint || undefined },
    });
    applyConfig(res?.config);

    if (!online) {
      online = true;
      // The server tells us which account this token belongs to — worth showing,
      // so you can see at a glance whose assistant can drive this machine.
      console.log(`  Connected${res?.account ? ` as ${res.account}` : ''}.`);
    }
  } catch (err) {
    if (online) console.log(`  Lost connection: ${err.message}`);
    online = false;
  }
}

/**
 * How many jobs may be in flight at once.
 *
 * The agent issues independent tool calls together and waits for all of them, so
 * running them strictly one after another turned every parallel fan-out back
 * into a queue — and a single `browser_wait 30` stalled the calls beside it into
 * the server's timeout.
 *
 * Not unbounded, though: these are real processes on somebody's computer, and
 * six simultaneous `npm install`s is its own kind of rude.
 */
const MAX_CONCURRENT_JOBS = Math.min(Math.max(Number(process.env.WORKER_CONCURRENCY) || 4, 1), 12);
let inFlight = 0;

/**
 * Poll for work. The server holds each request open for up to ~25s, so this is
 * effectively push with none of the inbound-firewall problems: nothing on the
 * internet ever connects to this machine.
 */
async function pollLoop() {
  let unauthorised = false;

  for (;;) {
    // Back off rather than claiming work there is no capacity to start: a job
    // claimed and left sitting is one the server is already timing.
    if (inFlight >= MAX_CONCURRENT_JOBS) {
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }

    try {
      const res = await fetch(`${SERVER_URL}/api/worker/jobs`, { headers: authHeaders });
      if (res.status === 401) {
        // A token belongs to one computer on one account, so a rejection means
        // this machine was unpaired in the app. Rather than telling somebody to
        // go and edit a file *on this machine* — the errand pairing exists to
        // remove — it simply offers a fresh code and waits to be adopted again.
        if (!unauthorised) {
          unauthorised = true;
          console.log('\n  This computer is no longer paired.');
          await repair();
        }
        continue;
      }
      unauthorised = false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { job } = await res.json();
      if (job) {
        // Not awaited: the point is to go straight back for the next job while
        // this one runs. `runJob` reports its own outcome and never throws.
        inFlight += 1;
        runJob(job)
          .catch((err) => console.log(`  ✗ ${job.tool}: ${err?.message || err}`))
          .finally(() => {
            inFlight -= 1;
          });
      }
    } catch (err) {
      if (online) console.log(`  Poll failed: ${err.message}`);
      online = false;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

console.log('\n  AI Remote worker\n');
console.log(`    server:    ${SERVER_URL}`);
console.log(`    computer:  ${DEVICE_NAME}`);
console.log(`    workspace: ${WORKSPACE}`);
console.log(`    device id: ${WORKER_ID}\n`);
console.log('  The assistant can now read, write and run commands inside that workspace.');
console.log('  Stop this process to cut off local access instantly.\n');

/**
 * Take the background commands down with the worker.
 *
 * They are spawned without `detached`, which on POSIX means a Ctrl-C reaches the
 * whole process group — but not on Windows, where killing a parent leaves its
 * children running. A dev server nobody can see, holding a port nobody can trace,
 * is exactly what `run_background` promises not to leave behind — so they are
 * stopped explicitly rather than relied on to die.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} — stopping background commands…`);
  const [{ stopAllBackground }, { closeBrowser }] = await Promise.all([
    import('./background.js'),
    import('./browser.js'),
  ]);
  await stopAllBackground().catch(() => {});
  await closeBrowser().catch(() => {});
  console.log('  Local access is cut off.\n');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

await heartbeat();
setInterval(heartbeat, 15_000);
pollLoop();
