import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claim, publishFrame, release } from './screen.js';

/**
 * Desktop control — the assistant driving real applications.
 *
 * This is deliberately the same shape as the browser sandbox: look at a
 * numbered list of what is on screen, then act on a number. The numbers come
 * from the accessibility layer the operating system already exposes for screen
 * readers — UI Automation on Windows, System Events on macOS — so "click [7]"
 * reaches the actual button rather than a guess at where it might be in a
 * screenshot. Coordinates are the fallback, not the plan; they break the moment
 * a window moves.
 *
 * X11 is the exception and says so: there is no element tree without AT-SPI, so
 * `look` returns an empty list there and the model is told to work by
 * coordinate and keyboard shortcut, which do work. An invented list would be
 * worse than none — the model would press what it found.
 *
 * **Off unless you turn it on.** A browser sandbox is contained; this is not.
 * It types into whatever has focus and clicks whatever is under the pointer, so
 * it stays behind `DESKTOP_ACCESS=true`.
 *
 * This used to end "and every action needs approval". That was not true, and it
 * is the kind of untruth that matters: somebody reading it believes there is a
 * second control catching whatever the flag lets through, and there is not.
 *
 * What `assessRisk` in server/tools/definitions.js actually grades, and what the
 * default `guarded` policy does with it:
 *
 *   safe       desktop_look, desktop_windows            — never asks
 *   ordinary   desktop_focus, click, scroll, type, key  — runs without asking
 *   sensitive  desktop_key with a dangerous combination,
 *              desktop_close, desktop_launch of a shell — stops and asks
 *
 * So typing into whatever holds focus is unprompted. That is a deliberate
 * design rather than an oversight — the same file argues that asking about
 * everything and asking about nothing fail the same way, because neither leaves
 * any attention for the cases that matter — and `ask` mode exists for anyone who
 * wants the stricter behaviour. It is written out here so the trade is visible
 * at the point where somebody would otherwise assume it had been made for them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

/**
 * One protocol, three operating systems.
 *
 * Windows answers through PowerShell and UI Automation; macOS and Linux through
 * a Node host that reaches System Events and xdotool respectively. The line
 * protocol is identical, so everything below this point — the pending-call map,
 * the working-window memory, the descriptions handed to the model — is shared
 * rather than written three times.
 */
const HOST = IS_WIN
  ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'desktop', 'host.ps1')] }
  : { command: process.execPath, args: [path.join(here, 'desktop', 'host.mjs')] };

const CAMERA = IS_WIN
  ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'desktop', 'capture.ps1')] }
  : { command: process.execPath, args: [path.join(here, 'desktop', 'capture.mjs')] };

const CALL_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 25_000;

let host = null;
let starting = null;
let nextId = 1;
const pending = new Map();
let camera = null;

/**
 * Opt-in, on every platform.
 *
 * It used to be Windows-only because the host was, and the flag doubled as a
 * platform check. Now the flag means only what it says — the person at this
 * machine has agreed it may be driven — and what each desktop can actually
 * manage is reported by the host when a call is made, in a sentence naming the
 * package to install or the permission to grant.
 */
export const desktopAllowed = () => /^(1|true|yes)$/i.test(process.env.DESKTOP_ACCESS || '');


function reject(message) {
  for (const { reject: fail, timer } of pending.values()) {
    clearTimeout(timer);
    fail(new Error(message));
  }
  pending.clear();
}

function start() {
  if (host) return Promise.resolve(host);
  if (starting) return starting;

  starting = new Promise((resolve, fail) => {
    const child = spawn(HOST.command, HOST.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let ready = false;
    let buffer = '';
    let stderr = '';

    const readyTimer = setTimeout(() => {
      if (!ready) {
        child.kill();
        fail(new Error(`The desktop host did not start within 25s. ${stderr.slice(0, 400)}`));
      }
    }, READY_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      // One JSON object per line. Frames are large, so a reply routinely
      // arrives split across several chunks.
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // stray output is not fatal
        }

        if (message.ready && !ready) {
          ready = true;
          clearTimeout(readyTimer);
          host = child;
          resolve(child);
          continue;
        }

        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error || 'The desktop host refused that.'));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });

    child.on('exit', (code) => {
      clearTimeout(readyTimer);
      host = null;
      starting = null;
      stopCamera();
      release('desktop');
      reject(`The desktop host stopped (exit ${code}). ${stderr.slice(0, 300)}`);
      if (!ready) fail(new Error(`The desktop host failed to start. ${stderr.slice(0, 400)}`));
    });

    child.on('error', (err) => {
      clearTimeout(readyTimer);
      if (!ready) fail(new Error(`Could not start the desktop host (${HOST.command}): ${err.message}`));
    });
  }).finally(() => {
    starting = null;
  });

  return starting;
}

async function call(cmd, args = {}) {
  if (!desktopAllowed()) {
    throw new Error(
      'Desktop control is switched off. Set DESKTOP_ACCESS=true on the machine running the worker to allow it.',
    );
  }
  const child = await start();
  const id = nextId++;

  return new Promise((resolve, rejectCall) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new Error(`\`${cmd}\` took longer than 60 seconds and was given up on.`));
    }, CALL_TIMEOUT_MS);

    pending.set(id, { resolve, reject: rejectCall, timer });
    child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
  });
}

export async function stopDesktop() {
  stopCamera();
  release('desktop');
  if (host) {
    host.stdin.end();
    host.kill();
    host = null;
  }
}

// ── frames ────────────────────────────────────────────────────────────

/**
 * The camera is its own process on purpose. UI Automation calls routinely block
 * for most of a second, and a shared process meant the mirror froze precisely
 * while the assistant was doing something worth watching.
 */
function startCamera() {
  if (camera) return;

  const fps = Math.min(Math.max(Number(process.env.SCREEN_FPS) || 10, 0.2), 20);
  const child = spawn(
    CAMERA.command,
    [
      ...CAMERA.args,
      '-Fps', String(fps),
      '-Quality', String(Number(process.env.SCREEN_QUALITY) || 55),
      '-MaxWidth', String(Number(process.env.SCREEN_WIDTH) || 1280),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  // Discarding this is what made a camera that could not capture at all look
  // identical to a camera with nothing to show.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    for (const line of text.split('\n')) {
      if (line.trim()) console.error(`[screen] ${line.trim()}`);
    }
  });

  let buffer = '';
  let paused = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', async (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line || line.includes('"ready"')) continue;

      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }

      // Kept so a finished step can carry a picture of the screen into the
      // transcript. See `stepShot` for why this is the frame rather than a
      // capture of its own.
      latestFrame = { data: payload.frame, at: Date.now() };

      const watched = await publishFrame({
        frame: payload.frame,
        source: 'desktop',
        title: payload.title || 'Desktop',
        url: '',
        width: payload.width,
        height: payload.height,
      });

      // Stop grabbing the screen the moment nobody is looking, and start again
      // the moment they are — the camera itself never has to know why.
      if (watched === paused) {
        paused = !watched;
        child.stdin.write(`${JSON.stringify({ cmd: paused ? 'pause' : 'resume' })}\n`);
      }
    }
  });

  child.on('exit', () => {
    camera = null;
  });
  child.on('error', () => {
    camera = null;
  });

  camera = child;
}

function stopCamera() {
  if (!camera) return;
  try {
    camera.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
  } catch {
    /* already gone */
  }
  camera.kill();
  camera = null;
}

/**
 * The most recent frame the camera produced, kept for the transcript.
 *
 * **Why the live frame rather than a capture of its own.** A dedicated small
 * screenshot would be neater — the browser tools take one at 320px and it costs
 * about 4KB — but there is no warm process to ask for it here, and the desktop
 * capture host is not cheap to start: measured at **1516ms** for a one-off
 * spawn on Windows, which would be added to every desktop step. The camera is
 * already running (every desktop tool calls `takeScreen`), and its frames are
 * about 61KB at the streaming defaults. Reusing one costs nothing.
 *
 * So desktop thumbnails are larger than browser ones. That is the trade, and it
 * is the right way round: an extra 55KB on a step is cheaper than an extra
 * second and a half on every action somebody is watching.
 */
let latestFrame = null;

/** How stale a frame may be and still describe the step that just finished. */
const SHOT_MAX_AGE_MS = 1500;
const SHOT_WAIT_MS = 800;

/**
 * A picture of the screen as this step left it.
 *
 * Waits briefly for a frame *newer than the moment the action finished*, so the
 * transcript does not show the screen as it was before the click. `wake()` has
 * already resumed the camera by the time this runs, so one is normally along
 * within a frame interval. Gives up rather than delaying the result — a missing
 * illustration is a far smaller problem than a step that feels slow.
 */
async function stepShot() {
  const since = Date.now();
  const deadline = since + SHOT_WAIT_MS;

  while (Date.now() < deadline) {
    if (latestFrame && latestFrame.at >= since) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!latestFrame || Date.now() - latestFrame.at > SHOT_MAX_AGE_MS) return null;
  return { mime: 'image/jpeg', data: latestFrame.data };
}

/**
 * Nudge a paused camera awake. An action is a deliberate moment to show, even
 * if the panel was closed a second ago.
 */
function wake() {
  if (camera) {
    try {
      camera.stdin.write(`${JSON.stringify({ cmd: 'resume' })}\n`);
    } catch {
      /* the exit handler will clear it */
    }
  }
}

async function takeScreen() {
  await claim('desktop', async () => stopCamera());
  startCamera();
  wake();
}

// ── describing what is on screen ──────────────────────────────────────

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

/**
 * The window being worked on.
 *
 * Without this, every action reported on whatever happened to be in front
 * afterwards — and since element numbers are read fresh from each report, a
 * background app stealing focus silently re-pointed the numbers at itself. The
 * next "click [22]" then pressed something in a completely different program.
 * Once a window is launched, focused or looked at, it stays the subject until
 * the assistant deliberately moves.
 */
let working = null;

function remember(snapshot) {
  if (snapshot?.handle) working = { handle: snapshot.handle, title: snapshot.window };
  return snapshot;
}

/** An explicit window wins; otherwise stay on the one we were already on. */
const subject = (window) => window ?? working?.handle ?? undefined;

function describe(snapshot, note) {
  const lines = [];
  if (note) lines.push(note, '');

  lines.push(`Window: ${snapshot.window || '(untitled)'}`);
  if (snapshot.bounds) {
    const b = snapshot.bounds;
    lines.push(`Position: ${b.width}x${b.height} at ${b.x},${b.y}`);
  }
  lines.push('');

  const elements = asArray(snapshot.elements);
  if (elements.length) {
    lines.push('Things you can act on (use the number as `ref`):');
    for (const e of elements) {
      const state = e.enabled === false ? ' (disabled)' : '';
      lines.push(`  [${e.ref}] ${e.type}  ${e.label || '(no label)'}${state}`);
    }
    if (snapshot.truncated) lines.push('  … more elements exist than are listed.');
    lines.push('');
  } else {
    lines.push('This window exposes no controls to the accessibility layer.');
    lines.push('You can still click by coordinate, or use keyboard shortcuts with desktop_key.', '');
  }

  lines.push('Visible text:', snapshot.text || '(none)');
  return lines.join('\n');
}

/**
 * Every action ends by re-reading the window, so the model is never acting blind.
 *
 * Returns `{ text, shot }` — the text is what the model reads, the shot is what
 * the person scrolling the transcript tomorrow sees. The worker's job runner
 * understands both this shape and a plain string, so nothing else had to change.
 */
async function reportOn(window, note) {
  let snapshot;
  try {
    snapshot = remember(await call('look', { window: subject(window) }));
  } catch {
    // The window being worked in can legitimately vanish — clicking its own
    // close button is an ordinary thing to do — and the action that closed it
    // must not then be reported as having failed.
    working = null;
    try {
      snapshot = remember(await call('look', {}));
    } catch (err) {
      wake();
      /**
       * Do not report every failure as a closed window.
       *
       * This said "That window has closed" whatever went wrong — a host crash,
       * a 60-second timeout, a UI Automation fault. The model then went looking
       * for a window that was still there, or told the user their application
       * had shut when it had not. A confident wrong answer is worse here than
       * an uncertain right one, because the model acts on it.
       *
       * A timeout in particular means the opposite of what was being reported:
       * the host is busy, so the window is very likely still open.
       */
      const message = String(err?.message || '');
      const timedOut = /timed out|timeout/i.test(message);
      const reason = timedOut
        ? 'The desktop host did not answer in time, so the window may well still be open — try again, or call desktop_windows.'
        : /closed|not found|no such window/i.test(message)
          ? 'That window has closed. Call desktop_windows to see what is still open.'
          : `Reading that window failed: ${message || 'the desktop host gave no reason'}. Call desktop_windows to see what is still open.`;
      return {
        text: `${note}\n\n${reason}`,
        // Still worth a picture: "which window closed" is exactly the question
        // somebody reading this back will have.
        shot: await stepShot(),
      };
    }
  }
  wake();
  return { text: describe(snapshot, note), shot: await stepShot() };
}

// ── the tools ─────────────────────────────────────────────────────────

async function desktopList() {
  const { windows } = await call('windows');
  const list = asArray(windows);
  await takeScreen();
  wake();
  // Listing is a survey, not a move — it does not change what we are working on.

  if (!list.length) return { text: 'No application windows are open.', shot: await stepShot() };

  const lines = ['Open windows — pass a title fragment as `window` to act on one:', ''];
  for (const w of list) {
    const tags = [w.foreground ? 'in front' : null, w.minimized ? 'minimized' : null]
      .filter(Boolean)
      .join(', ');
    lines.push(`  ${w.title}${tags ? `  (${tags})` : ''}`);
  }
  return { text: lines.join('\n'), shot: await stepShot() };
}

async function desktopLook({ window }) {
  await takeScreen();
  // An explicit window is a deliberate move, so it becomes the new subject.
  if (window) working = null;
  return reportOn(window, window ? `Looking at "${window}":` : 'The window you are working in:');
}

async function desktopFocus({ window }) {
  if (!window) throw new Error('Say which window to bring to the front.');
  await takeScreen();
  const snapshot = remember(await call('focus', { window }));
  wake();
  return { text: describe(snapshot, `Brought "${snapshot.window}" to the front.`), shot: await stepShot() };
}

async function desktopLaunch({ app, args }) {
  if (!app) throw new Error('Say which application to launch, e.g. "notepad".');
  await takeScreen();
  const result = await call('launch', { app, args });
  wake();
  if (result.note) return { text: `Launched ${app}. ${result.note}`, shot: await stepShot() };
  return { text: describe(remember(result), `Launched ${app}.`), shot: await stepShot() };
}

async function desktopClick({ ref, x, y, button, double, description, window }) {
  await takeScreen();
  const result = await call('click', { ref, x, y, button, double });
  const what = ref != null ? `[${ref}]` : `${x},${y}`;
  return reportOn(
    window,
    `${result.action} ${what}${description ? ` (${description})` : ''}.`,
  );
}

async function desktopType({ ref, text, submit, window }) {
  await takeScreen();
  await call('type', { ref, text: String(text ?? ''), submit });
  return reportOn(
    window,
    `Typed${ref != null ? ` into [${ref}]` : ''}${submit ? ' and pressed Enter' : ''}.`,
  );
}

async function desktopKey({ keys, window }) {
  if (!keys) throw new Error('Say which key to press, e.g. "ctrl+s" or "enter".');
  await takeScreen();
  await call('key', { keys });
  return reportOn(window, `Pressed ${keys}.`);
}

async function desktopScroll({ window, direction = 'down', amount = 3 }) {
  await takeScreen();
  await call('scroll', { window, direction, amount });
  return reportOn(window, `Scrolled ${direction}.`);
}

async function desktopClose({ window }) {
  if (!window) throw new Error('Say which window to close.');
  const result = await call('close', { window });
  working = null;
  wake();
  return {
    text: `Closed "${result.title}". Anything unsaved in it was not saved by this action.`,
    shot: await stepShot(),
  };
}

async function desktopWait({ seconds = 3, window }) {
  const s = Math.min(Math.max(Number(seconds) || 3, 1), 30);
  await takeScreen();
  const until = Date.now() + s * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
  }
  return reportOn(window, `Waited ${s} seconds.`);
}

export const DESKTOP_IMPLEMENTATIONS = {
  desktop_windows: desktopList,
  desktop_look: desktopLook,
  desktop_focus: desktopFocus,
  desktop_launch: desktopLaunch,
  desktop_click: desktopClick,
  desktop_type: desktopType,
  desktop_key: desktopKey,
  desktop_scroll: desktopScroll,
  desktop_close: desktopClose,
  desktop_wait: desktopWait,
};
