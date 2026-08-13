/**
 * Which server this computer answers to.
 *
 * The bug this exists to remove: `npm start` brought up a local web app *and* a
 * worker, and the worker talked to the local app because that is what
 * `SERVER_URL` defaults to. Somebody who had deployed the app to Vercel would
 * follow the instructions on their own deployment — clone, install, `npm start`
 * — read the pairing code off their terminal, type it into the deployed app,
 * and be told the code was invalid. It was: the code had been minted in the
 * PGlite database on their disk, and the deployment was asking Neon about it.
 * Two systems that had never spoken, and nothing on screen to say so.
 *
 * So the address becomes an argument, and it is remembered. Everything here is
 * pure text-in, text-out so the flag parsing and the file rewriting can be
 * tested without launching anything.
 */

/** The one place that decides what a usable server address looks like. */
export function normaliseServerUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Give an address, such as https://your-app.vercel.app');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `"${text}" is not a web address. It should look like https://your-app.vercel.app`,
    );
  }

  // Rejected rather than coerced. A `file:` or `ws:` address here is somebody
  // pasting the wrong thing, and quietly rewriting it produces a worker that
  // polls somewhere unexpected — a far worse outcome than being told no.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${text}" is not http or https, so a worker cannot poll it.`);
  }

  // Trailing slash stripped because every call site concatenates a path onto
  // this, and `//api/worker/jobs` is a 404 nobody enjoys diagnosing.
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const FLAGS = new Set(['--tunnel', '--no-server', '--no-worker', '--pair']);

/**
 * What the command line asked for.
 *
 * Three spellings of the address are accepted — `--server <url>`,
 * `--server=<url>`, and a bare URL — because all three are what people type,
 * and an argument parser that only understands one of them is a parser that
 * spends its life rejecting correct intent.
 */
export function parseLaunchArgs(argv = []) {
  const flags = new Set();
  let server = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);

    if (arg === '--server') {
      const next = argv[i + 1];
      if (!next || String(next).startsWith('--')) {
        throw new Error('--server needs an address after it, such as --server https://your-app.vercel.app');
      }
      server = normaliseServerUrl(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--server=')) {
      server = normaliseServerUrl(arg.slice('--server='.length));
      continue;
    }
    if (FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (/^https?:\/\//i.test(arg)) {
      server = normaliseServerUrl(arg);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`I do not know the option "${arg}".`);
    }
    throw new Error(`I do not know what to do with "${arg}".`);
  }

  /**
   * `--pair` means "connect this computer to a server elsewhere", so bringing up
   * a second web app on this machine is not merely redundant — it is the source
   * of the confusion this whole change is about. Two apps, two databases, and a
   * pairing code that belongs to exactly one of them.
   */
  const pair = flags.has('--pair');

  return {
    tunnel: flags.has('--tunnel'),
    server,
    pair,
    wantServer: !flags.has('--no-server') && !pair,
    wantWorker: !flags.has('--no-worker'),
  };
}

/** Parse a dotenv-shaped file into a plain object. Comments and blanks ignored. */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Point `worker/.env` at a server, and decide what that costs.
 *
 * A `WORKER_TOKEN` is only worth anything on the server that minted it. Moving
 * a worker to a different server while keeping the old token produces HTTP 401,
 * and the worker's own reaction to a 401 is to announce "This computer is no
 * longer paired" and ask for a fresh code. The recovery is right; the sentence
 * is wrong and alarming — the computer is still paired, just to somewhere else.
 *
 * So the address is stored beside the token, and a change of address drops the
 * token deliberately. The user gets a pairing code and an accurate explanation
 * instead of an error and a guess.
 *
 * Comments and unrelated settings in the file are preserved: it is somebody's
 * configuration, not scratch space.
 *
 * @returns {{ text: string, changed: boolean, droppedToken: boolean, previous: string|null }}
 */
export function planWorkerEnv(currentText, serverUrl) {
  const wanted = normaliseServerUrl(serverUrl);
  const current = parseEnvText(currentText);
  const previous = current.SERVER_URL ? String(current.SERVER_URL).replace(/\/+$/, '') : null;

  // A token minted by a different server cannot authenticate against this one.
  // No previous address means we have no idea where the token came from, so it
  // is left alone rather than thrown away on a guess.
  const droppedToken = !!current.WORKER_TOKEN && !!previous && previous !== wanted;
  const changed = previous !== wanted || droppedToken;

  const lines = String(currentText ?? '').split('\n');
  const kept = [];
  let wrote = false;

  for (const raw of lines) {
    if (/^\s*SERVER_URL\s*=/.test(raw)) {
      if (wrote) continue; // A duplicate key is a file that already disagrees with itself.
      kept.push(`SERVER_URL=${wanted}`);
      wrote = true;
      continue;
    }
    if (droppedToken && /^\s*WORKER_TOKEN\s*=/.test(raw)) continue;
    kept.push(raw);
  }

  if (!wrote) {
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    if (kept.length) kept.push('');
    kept.push('# The server this computer polls. Written by `npm run connect`.');
    kept.push(`SERVER_URL=${wanted}`);
  }

  const text = `${kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
  return { text, changed, droppedToken, previous };
}

/** Whether an address points back at this machine rather than out at a deployment. */
export const isLocalServer = (url) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(url ?? ''));
