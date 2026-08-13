/**
 * Desktop control for macOS and Linux.
 *
 * The Windows half of this is `host.ps1`, twenty-five kilobytes of UI Automation
 * reached through P/Invoke. This is the same protocol answered by two very
 * different operating systems, and the honest summary is that neither of them
 * hands it over as readily as Windows does:
 *
 *   macOS  System Events *is* the accessibility layer, and AppleScript is the
 *          way in. Real element enumeration, real labels — but every call is a
 *          process launch and an Apple Event round trip, so the listing is
 *          capped and the depth is shallow on purpose. Needs Accessibility
 *          rights, granted once, to whichever terminal starts the worker.
 *
 *   Linux  there is no single answer, because there is no single desktop. X11
 *          has `xdotool` and `wmctrl`, which do windows, pointer and keyboard
 *          well and expose no element tree at all. Wayland deliberately forbids
 *          one program driving another, so it needs `ydotool` and a uinput
 *          permission the user has to grant themselves.
 *
 * Where an element tree is unavailable the reply says so with an empty list
 * rather than inventing one, and `describe()` on the Node side already tells the
 * model to fall back to coordinates and keyboard shortcuts. That is a real
 * degradation and it is stated plainly; a fabricated `[7] button OK` would be
 * far worse than none, because the model would press it.
 *
 * Protocol, identical to host.ps1:
 *   stdin   {"id":1,"cmd":"look","args":{...}}
 *   stdout  {"ready":true} once, then {"id":1,"ok":true,"result":{...}}
 *                                  or {"id":1,"ok":false,"error":"..."}
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IS_MAC = process.platform === 'darwin';

const MAX_ELEMENTS = 120;
const MAX_TEXT = 4000;
const EXEC_TIMEOUT = 20_000;

/** Ask the shell for a program's path — used to say what is missing, not to guess. */
async function has(command) {
  try {
    await run(IS_MAC ? 'which' : 'which', [command], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

const missing = (tool, why) =>
  new Error(
    `${tool} is not installed on this computer, and ${why} needs it. ` +
      (IS_MAC ? `Install it with \`brew install ${tool}\`.` : `Install it with your package manager, e.g. \`sudo apt install ${tool}\`.`),
  );

// ── macOS ─────────────────────────────────────────────────────────────

/**
 * AppleScript, with the source on stdin.
 *
 * Not as an argument: window titles and typed text are arbitrary, and quoting
 * arbitrary text into a command line is a bug waiting for the first apostrophe.
 */
function osascript(source) {
  return new Promise((resolve, reject) => {
    const child = execFile('osascript', ['-'], { timeout: EXEC_TIMEOUT, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || err.message);
        // The one failure worth naming, because it is the one everybody hits and
        // the fix is a checkbox rather than a code change.
        if (/not allowed assistive|accessibility|-25211|-1743/i.test(text)) {
          return reject(
            new Error(
              'macOS has not granted this program Accessibility rights, so it cannot see or drive other applications. ' +
                'System Settings → Privacy & Security → Accessibility, and tick the terminal (or app) the worker runs from.',
            ),
          );
        }
        return reject(new Error(text.trim().split('\n')[0] || 'AppleScript failed.'));
      }
      resolve(String(stdout).trim());
    });
    child.stdin.end(source, 'utf8');
  });
}

/** AppleScript string literal — the only two characters that need escaping. */
const as = (value) => `"${String(value ?? '').replace(/[\\"]/g, '\\$&')}"`;

async function macWindows() {
  const out = await osascript(`
    set output to ""
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
      repeat with proc in (application processes whose visible is true)
        set procName to name of proc
        try
          repeat with w in (windows of proc)
            set isFront to (procName is frontApp)
            set output to output & procName & " — " & (name of w) & "\t" & (isFront as text) & linefeed
          end repeat
        end try
      end repeat
    end tell
    return output`);

  return {
    windows: out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [title, front] = line.split('\t');
        return { title, foreground: front === 'true', minimized: false };
      }),
  };
}

/**
 * One window's controls and text.
 *
 * `entire contents` is the expensive call — it walks the whole tree — so it is
 * wrapped in a try and the result is trimmed hard. A window with two thousand
 * elements is not more useful than one with a hundred; it is just slower and it
 * fills the model's context with scroll-bar parts.
 */
async function macLook(window) {
  const source = `
    tell application "System Events"
      set procRef to (first application process whose frontmost is true)
      ${window ? `try
        set procRef to (first application process whose name contains ${as(window)})
      end try` : ''}
      set w to missing value
      try
        set w to first window of procRef
      end try
      if w is missing value then return "ERR|no window"

      set out to "WIN|" & (name of w) & linefeed
      try
        set p to position of w
        set s to size of w
        set out to out & "BOX|" & (item 1 of p) & "|" & (item 2 of p) & "|" & (item 1 of s) & "|" & (item 2 of s) & linefeed
      end try

      set n to 0
      try
        repeat with el in (entire contents of w)
          if n > ${MAX_ELEMENTS} then exit repeat
          set role to ""
          try
            set role to role description of el
          end try
          set label to ""
          try
            set label to description of el
          end try
          if label is "" then
            try
              set label to name of el
            end try
          end if
          if label is "" then
            try
              set label to value of el as text
            end try
          end if
          if role is not "" then
            set n to n + 1
            set posText to ""
            try
              set ep to position of el
              set es to size of el
              set posText to (item 1 of ep) & "|" & (item 2 of ep) & "|" & (item 1 of es) & "|" & (item 2 of es)
            end try
            set out to out & "EL|" & n & "|" & role & "|" & label & "|" & posText & linefeed
          end if
        end repeat
      end try
      return out
    end tell`;

  const raw = await osascript(source);
  if (raw.startsWith('ERR|')) throw new Error('No window is open in that application.');

  const snapshot = { window: '', handle: window || '', elements: [], text: '', truncated: false };
  const words = [];

  for (const line of raw.split('\n')) {
    const [kind, ...rest] = line.split('|');
    if (kind === 'WIN') snapshot.window = rest.join('|');
    else if (kind === 'BOX') {
      const [x, y, width, height] = rest.map(Number);
      snapshot.bounds = { x, y, width, height };
    } else if (kind === 'EL') {
      const [ref, type, label, x, y, width, height] = rest;
      const element = { ref: Number(ref), type: type || 'element', label: (label || '').trim(), enabled: true };
      if (x !== undefined && x !== '') {
        element.bounds = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
      }
      snapshot.elements.push(element);
      if (element.label) words.push(element.label);
    }
  }

  snapshot.truncated = snapshot.elements.length >= MAX_ELEMENTS;
  snapshot.text = words.join(' · ').slice(0, MAX_TEXT);
  return snapshot;
}

async function macFocus(window) {
  await osascript(`
    tell application "System Events"
      set procRef to (first application process whose name contains ${as(window)})
      set frontmost of procRef to true
    end tell`);
  return macLook(window);
}

async function macLaunch(app, args) {
  const extra = (Array.isArray(args) ? args : []).filter(Boolean);
  await run('open', extra.length ? ['-a', app, '--args', ...extra] : ['-a', app], { timeout: EXEC_TIMEOUT });
  // Applications take a moment to put a window up; looking immediately reports
  // the app that was in front before.
  await new Promise((r) => setTimeout(r, 1200));
  try {
    return await macLook(app);
  } catch {
    return { note: 'It has started but has not put a window up yet. Call desktop_look in a moment.' };
  }
}

async function macClick({ ref, x, y, button, double }) {
  if (ref != null) {
    const snapshot = await macLook();
    const element = snapshot.elements.find((e) => e.ref === Number(ref));
    if (!element) throw new Error(`There is no [${ref}] in the window being worked on. Look again.`);
    if (!element.bounds) throw new Error(`[${ref}] does not report a position, so it cannot be clicked by number.`);
    x = element.bounds.x + element.bounds.width / 2;
    y = element.bounds.y + element.bounds.height / 2;
  }
  if (x == null || y == null) throw new Error('Give either a ref or x and y.');

  const point = `{${Math.round(x)}, ${Math.round(y)}}`;
  // System Events has no right-click verb; control-click is how the OS itself
  // expresses one.
  if (button === 'right') {
    await osascript(`tell application "System Events" to key down control
      tell application "System Events" to click at ${point}
      tell application "System Events" to key up control`);
  } else {
    await osascript(`tell application "System Events" to click at ${point}`);
    if (double) await osascript(`tell application "System Events" to click at ${point}`);
  }
  return { action: double ? 'Double-clicked' : 'Clicked' };
}

async function macType({ ref, text, submit }) {
  if (ref != null) await macClick({ ref });
  if (text) await osascript(`tell application "System Events" to keystroke ${as(text)}`);
  if (submit) await osascript('tell application "System Events" to key code 36');
  return { ok: true };
}

/**
 * Named keys, as macOS numbers them.
 *
 * `keystroke` sends characters; anything that is not a character has to go as a
 * key code, and the codes are a fixed hardware table rather than anything
 * derivable.
 */
const MAC_KEY_CODES = {
  enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

const MAC_MODIFIERS = {
  ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down',
  shift: 'shift down', cmd: 'command down', command: 'command down', win: 'command down', meta: 'command down',
};

async function macKey(keys) {
  const parts = String(keys).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const modifiers = parts.map((p) => MAC_MODIFIERS[p]).filter(Boolean);
  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';

  const code = MAC_KEY_CODES[key];
  const verb = code !== undefined ? `key code ${code}` : `keystroke ${as(key)}`;
  await osascript(`tell application "System Events" to ${verb}${using}`);
  return { ok: true };
}

async function macScroll(direction, amount) {
  // No wheel verb in System Events. Page keys are what a person without a mouse
  // uses, and they scroll the thing that has focus, which is the same thing a
  // wheel over it would have done.
  const code = direction === 'up' ? MAC_KEY_CODES.pageup : MAC_KEY_CODES.pagedown;
  for (let i = 0; i < Math.min(Math.max(Number(amount) || 3, 1), 10); i += 1) {
    await osascript(`tell application "System Events" to key code ${code}`);
  }
  return { ok: true };
}

async function macClose(window) {
  const snapshot = await macFocus(window);
  await osascript('tell application "System Events" to keystroke "w" using {command down}');
  return { title: snapshot.window || window };
}

// ── Linux ─────────────────────────────────────────────────────────────

const WAYLAND = !!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY;

async function tool(name, args) {
  try {
    const { stdout } = await run(name, args, { timeout: EXEC_TIMEOUT, maxBuffer: 8 << 20 });
    return String(stdout);
  } catch (err) {
    if (err.code === 'ENOENT') throw missing(name, 'desktop control');
    throw new Error(String(err.stderr || err.message).trim().split('\n')[0]);
  }
}

function waylandNote() {
  return new Error(
    'This is a Wayland session, which does not let one program drive another without help. ' +
      'Install ydotool and give it access to /dev/uinput (see its README), or log in to an X11 session instead.',
  );
}

async function linuxWindows() {
  const out = await tool('wmctrl', ['-l']);
  let active = '';
  try {
    active = (await tool('xdotool', ['getactivewindow'])).trim();
  } catch {
    /* no active window is not an error */
  }

  return {
    windows: out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // 0x03600007  0 hostname Title of the window
        const match = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+\S+\s+(.*)$/i);
        if (!match) return null;
        const id = parseInt(match[1], 16);
        return {
          title: match[3],
          handle: match[1],
          foreground: active !== '' && Number(active) === id,
          // Desktop -1 is the sticky/iconified pseudo-desktop on most managers.
          minimized: match[2] === '-1',
        };
      })
      .filter(Boolean),
  };
}

async function linuxWindowId(window) {
  if (!window) return (await tool('xdotool', ['getactivewindow'])).trim();
  const found = await tool('xdotool', ['search', '--name', String(window)]);
  const id = found.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!id) throw new Error(`No open window has "${window}" in its title.`);
  return id;
}

async function linuxLook(window) {
  const id = await linuxWindowId(window);
  const name = (await tool('xdotool', ['getwindowname', id])).trim();
  const geometry = await tool('xdotool', ['getwindowgeometry', '--shell', id]);

  const values = Object.fromEntries(
    geometry
      .split('\n')
      .map((line) => line.split('='))
      .filter((pair) => pair.length === 2)
      .map(([k, v]) => [k.trim(), Number(v)]),
  );

  return {
    window: name,
    handle: id,
    bounds: { x: values.X || 0, y: values.Y || 0, width: values.WIDTH || 0, height: values.HEIGHT || 0 },
    // X11 has no element tree without AT-SPI, and AT-SPI is not installed on
    // most systems. Saying so is the honest answer; the caller falls back to
    // coordinates and keyboard shortcuts, which do work.
    elements: [],
    text: '',
    truncated: false,
  };
}

async function linuxFocus(window) {
  const id = await linuxWindowId(window);
  await tool('xdotool', ['windowactivate', '--sync', id]);
  return linuxLook(window);
}

async function linuxLaunch(app, args) {
  const extra = (Array.isArray(args) ? args : []).filter(Boolean).map(String);
  const { spawn } = await import('node:child_process');
  const child = spawn(app, extra, { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    return await linuxLook(app);
  } catch {
    return { note: 'It has started but no window with that name is up yet. Call desktop_look in a moment.' };
  }
}

async function linuxClick({ x, y, button, double }) {
  if (WAYLAND) throw waylandNote();
  if (x == null || y == null) {
    throw new Error('This desktop exposes no element numbers, so a click needs x and y coordinates.');
  }
  await tool('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))]);
  const code = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  await tool('xdotool', ['click', ...(double ? ['--repeat', '2'] : []), code]);
  return { action: double ? 'Double-clicked' : 'Clicked' };
}

async function linuxType({ text, submit }) {
  if (WAYLAND) throw waylandNote();
  if (text) await tool('xdotool', ['type', '--clearmodifiers', '--delay', '12', String(text)]);
  if (submit) await tool('xdotool', ['key', 'Return']);
  return { ok: true };
}

/** X keysym names for the ones people write differently. */
const X_KEYS = {
  enter: 'Return', esc: 'Escape', del: 'Delete', backspace: 'BackSpace', pageup: 'Prior', pagedown: 'Next',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'space', tab: 'Tab', home: 'Home', end: 'End',
};
const X_MODIFIERS = { cmd: 'super', command: 'super', win: 'super', meta: 'super', control: 'ctrl', option: 'alt' };

async function linuxKey(keys) {
  if (WAYLAND) throw waylandNote();
  const combo = String(keys)
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => X_MODIFIERS[part] || X_KEYS[part] || part)
    .join('+');
  await tool('xdotool', ['key', '--clearmodifiers', combo]);
  return { ok: true };
}

async function linuxScroll(direction, amount) {
  if (WAYLAND) throw waylandNote();
  // 4 is wheel up, 5 is wheel down — the X11 convention.
  const button = direction === 'up' ? '4' : '5';
  await tool('xdotool', ['click', '--repeat', String(Math.min(Math.max(Number(amount) || 3, 1), 15)), button]);
  return { ok: true };
}

async function linuxClose(window) {
  const id = await linuxWindowId(window);
  const name = (await tool('xdotool', ['getwindowname', id])).trim();
  // The polite close a title-bar X sends, not a kill: the application still gets
  // to ask about unsaved work.
  await tool('wmctrl', ['-i', '-c', id]);
  return { title: name };
}

// ── the protocol ──────────────────────────────────────────────────────

const COMMANDS = {
  windows: () => (IS_MAC ? macWindows() : linuxWindows()),
  look: ({ window }) => (IS_MAC ? macLook(window) : linuxLook(window)),
  focus: ({ window }) => (IS_MAC ? macFocus(window) : linuxFocus(window)),
  launch: ({ app, args }) => (IS_MAC ? macLaunch(app, args) : linuxLaunch(app, args)),
  click: (args) => (IS_MAC ? macClick(args) : linuxClick(args)),
  type: (args) => (IS_MAC ? macType(args) : linuxType(args)),
  key: ({ keys }) => (IS_MAC ? macKey(keys) : linuxKey(keys)),
  scroll: ({ direction, amount }) => (IS_MAC ? macScroll(direction, amount) : linuxScroll(direction, amount)),
  close: ({ window }) => (IS_MAC ? macClose(window) : linuxClose(window)),
};

/**
 * A one-off check so the first failure names the missing package, not a syscall.
 *
 * @returns a sentence to refuse every call with, or null to carry on.
 */
async function preflight() {
  // Never reached through `desktop.js`, which starts host.ps1 on Windows — but
  // told plainly anyway, because "sudo apt install xdotool" on a Windows box
  // would send somebody a very long way in the wrong direction.
  if (process.platform === 'win32') {
    return 'This host is for macOS and Linux. Windows desktop control goes through worker/desktop/host.ps1.';
  }
  if (IS_MAC) return null;
  if (WAYLAND) return null; // reported per call, since some commands still work

  const needed = [];
  for (const command of ['xdotool', 'wmctrl']) {
    if (!(await has(command))) needed.push(command);
  }
  if (!needed.length) return null;
  return (
    `Desktop control needs ${needed.join(' and ')}, which ${needed.length === 1 ? 'is' : 'are'} not installed. ` +
    `Install with: sudo apt install ${needed.join(' ')}  (or the equivalent for your distribution).`
  );
}

const refusal = await preflight();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
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

    const reply = (payload) => process.stdout.write(`${JSON.stringify({ id: message.id, ...payload })}\n`);

    const implementation = COMMANDS[message.cmd];
    if (!implementation) {
      reply({ ok: false, error: `Unknown command "${message.cmd}".` });
      continue;
    }
    if (refusal) {
      reply({ ok: false, error: refusal });
      continue;
    }

    try {
      reply({ ok: true, result: (await implementation(message.args || {})) ?? {} });
    } catch (err) {
      reply({ ok: false, error: err?.message || String(err) });
    }
  }
});

process.stdout.write(`${JSON.stringify({ ready: true, platform: process.platform })}\n`);
