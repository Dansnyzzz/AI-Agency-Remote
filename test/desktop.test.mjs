/**
 * Desktop control across three operating systems.
 *
 * The Windows host is PowerShell and the macOS/Linux one is Node, but they
 * answer the same line protocol — and that protocol is the whole contract, so it
 * is what gets tested. The host is started for real and spoken to over its own
 * stdin, which is the only way to catch the failures that actually happen here:
 * a host that never says `ready`, a reply on the wrong id, a crash on a command
 * it does not know.
 *
 * Off the host's native platform the OS-touching commands cannot be exercised —
 * there is no macOS window server on a Windows box — so those are skipped rather
 * than mocked. What is checked everywhere is the part that has been wrong
 * before: the framing, the routing, and that a missing dependency is reported as
 * a sentence naming the package rather than as a stack trace.
 *
 *   node test/desktop.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const skip = (label, why) => console.log(`  \x1b[33m–\x1b[0m  skipped: ${label} (${why})`);

// ── the files exist and pair up ───────────────────────────────────────
section('every platform has a host and a camera');
{
  for (const file of ['host.ps1', 'capture.ps1', 'host.mjs', 'capture.mjs']) {
    check(`worker/desktop/${file}`, fs.existsSync(path.join(root, 'worker', 'desktop', file)));
  }

  const wiring = fs.readFileSync(path.join(root, 'worker', 'desktop.js'), 'utf8');
  check('desktop.js picks the host by platform', /IS_WIN\s*\?/.test(wiring) && /host\.mjs/.test(wiring));
  check('and the camera too', /capture\.mjs/.test(wiring));
  check(
    'the switch is no longer wired to Windows',
    !/desktopAllowed = \(\) =>\s*\n?\s*process\.platform === 'win32'/.test(wiring),
    'the flag should mean consent, not platform',
  );
}

// ── speaking the protocol ─────────────────────────────────────────────

/** Start a host and talk to it the way desktop.js does. */
function startHost() {
  const child = spawn(process.execPath, [path.join(root, 'worker', 'desktop', 'host.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const waiting = new Map();
  let ready = null;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.ready) {
        ready(message);
        continue;
      }
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });

  let id = 0;
  return {
    ready: readyPromise,
    call(cmd, args = {}) {
      const mine = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${cmd} never answered`)), 25_000);
        waiting.set(mine, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ id: mine, cmd, args })}\n`);
      });
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

section('the host speaks the protocol');
{
  const host = startHost();

  const hello = await Promise.race([
    host.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 25_000)),
  ]).catch((err) => ({ error: err.message }));

  check('it announces itself once, on one line', hello?.ready === true, JSON.stringify(hello));
  check('and says which platform it is', hello?.platform === process.platform, hello?.platform);

  // The failure this catches: a host that throws on anything it does not
  // recognise takes the whole connection down, and every queued call with it.
  const unknown = await host.call('no-such-command');
  check('an unknown command is refused, not fatal', unknown.ok === false, JSON.stringify(unknown));
  check('and names what it did not understand', /no-such-command/.test(unknown.error || ''), unknown.error);

  // Replies are matched by id. Answering out of order — which is normal, since
  // some calls are slow — must not hand one call's answer to another.
  const [first, second] = await Promise.all([host.call('no-such-a'), host.call('no-such-b')]);
  check('replies carry the id they answer', first.id !== second.id, `${first.id} vs ${second.id}`);
  check('and the host is still alive after both', first.ok === false && second.ok === false);

  host.stop();
}

section('what this machine can actually do');
{
  const host = startHost();
  await host.ready;

  if (process.platform === 'win32') {
    // The Node host is not the one Windows uses; what matters here is that it
    // refuses honestly rather than half-working.
    const windows = await host.call('windows');
    check(
      'on Windows the Node host declines rather than pretending',
      windows.ok === false,
      windows.error || 'it answered, which it should not on this platform',
    );
    // And declines *usefully*. "sudo apt install xdotool" on a Windows box
    // would send somebody a very long way in the wrong direction.
    check(
      'and points at the host Windows actually uses',
      /host\.ps1/.test(windows.error || '') && !/apt install/.test(windows.error || ''),
      windows.error,
    );
    skip('window listing, clicking and typing', 'those go through host.ps1 on Windows');
  } else {
    const windows = await host.call('windows');
    if (windows.ok) {
      check('it lists open windows', Array.isArray(windows.result?.windows), JSON.stringify(windows.result).slice(0, 120));
    } else {
      // The honest outcome on a headless box or one missing xdotool — and the
      // message is the thing being tested.
      check(
        'or says exactly what is missing',
        /install|accessibility|uinput|Wayland/i.test(windows.error || ''),
        windows.error,
      );
    }
  }

  host.stop();
}

// ── the messages a person has to act on ───────────────────────────────
section('the failures name the fix');
{
  const source = fs.readFileSync(path.join(root, 'worker', 'desktop', 'host.mjs'), 'utf8');

  check('macOS is told which permission to grant', /Privacy & Security → Accessibility/.test(source));
  check('X11 is told which packages to install', /apt install/.test(source));
  check('Wayland is told why it cannot just work', /uinput/.test(source) && /Wayland/.test(source));
  check(
    'an absent element tree is reported as empty, not invented',
    /elements: \[\]/.test(source),
    'a fabricated control is one the model would press',
  );

  // Typed text and window titles are arbitrary. Building AppleScript by string
  // concatenation without escaping is how a title with a quote in it becomes a
  // syntax error at best.
  check('AppleScript strings are escaped', /replace\(\/\[\\\\"\]\/g/.test(source));
  check('and the script goes in on stdin, not the command line', /execFile\('osascript', \['-'\]/.test(source));

  const camera = fs.readFileSync(path.join(root, 'worker', 'desktop', 'capture.mjs'), 'utf8');
  check('the camera answers pause and resume', /'pause'/.test(camera) && /'resume'/.test(camera));
  check('and quit', /'quit'/.test(camera));
  check('it tries more than one screenshot program', (camera.match(/name: '/g) || []).length >= 3);
  check('and complains once rather than every frame', /complained/.test(camera));
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll desktop-host checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
