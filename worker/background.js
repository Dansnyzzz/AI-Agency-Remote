import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveInWorkspace, rel } from './paths.js';

/**
 * Long-running commands: dev servers, watchers, tunnels, builds you want to keep.
 *
 * `run_command` cannot do this and never could. It waits for the process to exit
 * and kills it at the timeout, so `npm run dev` was a two-minute wait ending in a
 * dead server — which meant the assistant could write a web app and had no way to
 * *start* it, or to check that the thing it wrote actually serves a page.
 *
 * Three decisions worth stating:
 *
 *   **The output is kept in a ring buffer, not streamed.** A watcher can print
 *   megabytes in a morning. The last 400 lines are what anybody reads, and they
 *   are what a model can be handed without drowning the conversation.
 *
 *   **Nothing is detached.** These die with the worker. A process that outlives
 *   the thing that started it is a process nobody remembers to stop, and the
 *   symptom is a port already in use tomorrow with no visible owner.
 *
 *   **There is a limit.** Six at once, so a model in a loop cannot fill the
 *   machine with node processes while reporting success each time.
 */

const MAX_JOBS = 6;
const KEEP_LINES = 400;
const STOP_GRACE_MS = 3000;

/** id → { command, cwd, child, lines, startedAt, exit } */
const jobs = new Map();

const trim = (lines) => (lines.length > KEEP_LINES ? lines.slice(-KEEP_LINES) : lines);

function summarise(job) {
  const ran = ((Date.now() - job.startedAt) / 1000).toFixed(0);
  const state = job.exit == null ? `running for ${ran}s` : `exited with code ${job.exit.code ?? 'unknown'}`;
  return `[${job.id}] ${job.command}  (in ${job.cwd}/) — ${state}, ${job.lines.length} line(s) of output`;
}

function startBackground({ command, cwd = '.', name }) {
  const text = String(command || '').trim();
  if (!text) throw new Error('Give a command to run.');

  const live = [...jobs.values()].filter((j) => j.exit == null);
  if (live.length >= MAX_JOBS) {
    throw new Error(
      `${live.length} background commands are already running, which is the limit. ` +
        'Stop one with run_background_stop first — and check run_background_logs before starting another, ' +
        'because the one you want may already be up.',
    );
  }

  const abs = resolveInWorkspace(cwd);
  const id = String(name || '').trim() || randomUUID().slice(0, 8);
  if (jobs.has(id) && jobs.get(id).exit == null) {
    throw new Error(`A background command called "${id}" is already running. Stop it first, or choose another name.`);
  }

  const child = spawn(text, {
    cwd: abs,
    shell: true,
    windowsHide: true,
    // No `detached`: these are meant to die with the worker rather than becoming
    // an orphan holding a port that nobody can trace tomorrow.
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  const job = { id, command: text, cwd: rel(abs), child, lines: [], startedAt: Date.now(), exit: null };
  jobs.set(id, job);

  const collect = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.length) job.lines.push(line);
    }
    job.lines = trim(job.lines);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  child.on('error', (err) => {
    job.lines.push(`[could not start: ${err.message}]`);
    job.exit = { code: null, signal: null };
  });
  child.on('close', (code, signal) => {
    job.exit = { code, signal };
  });

  return job;
}

/**
 * Start it, then wait a moment and report what it said.
 *
 * The pause is the difference between a useful answer and a useless one. A
 * command that fails immediately — a missing script, a port already taken — has
 * already printed the reason by the time this returns, so the model reads the
 * failure now instead of reporting "started" and discovering it two steps later.
 */
async function runBackground({ command, cwd, name, settle_ms: settleMs = 1500 }) {
  const job = startBackground({ command, cwd, name });
  const wait = Math.min(Math.max(Number(settleMs) || 1500, 0), 15_000);
  await new Promise((r) => setTimeout(r, wait));

  const head = job.lines.slice(0, 40).join('\n');
  if (job.exit) {
    return [
      `[${job.id}] exited immediately with code ${job.exit.code ?? 'unknown'} — it is NOT running.`,
      '',
      head || '(no output)',
      '',
      'Fix the cause rather than starting it again unchanged.',
    ].join('\n');
  }

  return [
    `[${job.id}] started: ${job.command}  (in ${job.cwd}/)`,
    'It keeps running after this call returns. Read it with run_background_logs, stop it with run_background_stop.',
    '',
    head || '(no output yet)',
  ].join('\n');
}

function backgroundLogs({ id, lines = 120 }) {
  const live = [...jobs.values()];
  if (!live.length) return 'No background commands have been started.';

  if (!id) {
    return ['Background commands:', '', ...live.map(summarise)].join('\n');
  }

  const job = jobs.get(id);
  if (!job) {
    throw new Error(`There is no background command called "${id}". The ones there are: ${live.map((j) => j.id).join(', ')}.`);
  }

  const count = Math.min(Math.max(Number(lines) || 120, 1), KEEP_LINES);
  const tail = job.lines.slice(-count);
  return [
    summarise(job),
    '',
    tail.join('\n') || '(no output)',
    job.lines.length > tail.length ? `\n[showing the last ${tail.length} of ${job.lines.length} lines]` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Ask it to stop, then insist.
 *
 * SIGTERM first so a dev server can close its sockets and a build can finish
 * writing the file it is part-way through. Killed outright after three seconds,
 * because a process that ignores the polite request is exactly the one somebody
 * is asking to be rid of.
 */
async function stopBackground({ id }) {
  if (!id) {
    const live = [...jobs.values()].filter((j) => j.exit == null);
    if (!live.length) return 'Nothing is running in the background.';
    const stopped = [];
    for (const job of live) {
      await stopOne(job);
      stopped.push(job.id);
    }
    return `Stopped ${stopped.length} background command(s): ${stopped.join(', ')}.`;
  }

  const job = jobs.get(id);
  if (!job) throw new Error(`There is no background command called "${id}".`);
  if (job.exit) return `[${id}] had already exited with code ${job.exit.code ?? 'unknown'}.`;

  await stopOne(job);
  return `Stopped [${id}] (${job.command}). Its last output is still readable with run_background_logs.`;
}

async function stopOne(job) {
  const done = new Promise((resolve) => {
    if (job.exit) return resolve();
    job.child.once('close', resolve);
    return undefined;
  });

  // On Windows there are no signals worth the name; `taskkill /T` is what
  // actually stops a shell and the tree of processes it started, which is what a
  // dev server is.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    job.child.kill('SIGTERM');
    setTimeout(() => {
      if (!job.exit) job.child.kill('SIGKILL');
    }, STOP_GRACE_MS).unref?.();
  }

  await Promise.race([done, new Promise((r) => setTimeout(r, STOP_GRACE_MS + 1500))]);
  if (!job.exit) job.exit = { code: null, signal: 'forced' };
}

/** Called when the worker is shutting down, so nothing is left holding a port. */
export async function stopAllBackground() {
  for (const job of [...jobs.values()].filter((j) => j.exit == null)) {
    await stopOne(job).catch(() => {});
  }
}

export const BACKGROUND_IMPLEMENTATIONS = {
  run_background: runBackground,
  run_background_logs: backgroundLogs,
  run_background_stop: stopBackground,
};

export const __testing = { jobs };
