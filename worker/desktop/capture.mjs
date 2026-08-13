/**
 * Desktop capture for macOS and Linux — the live mirror's camera.
 *
 * Same contract as `capture.ps1`, so `desktop.js` does not care which one it
 * started:
 *
 *   stdout  one JSON frame per line: {frame, title, width, height}
 *   stdin   {"cmd":"pause"} | {"cmd":"resume"} | {"cmd":"fps","value":10} | {"cmd":"quit"}
 *
 * Each platform has a screenshot program already installed, or has one that is
 * the obvious thing to install, so the frame comes from spawning it rather than
 * from a native binding. That is slower than Windows' BitBlt — a process per
 * frame — which is exactly why the frame rate is a setting and why capture stops
 * dead the moment nobody has the panel open.
 *
 * JPEG rather than PNG wherever the tool offers a choice: a screen full of text
 * is several megabytes as PNG and a few hundred kilobytes as JPEG, and this goes
 * over somebody's phone connection.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IS_MAC = process.platform === 'darwin';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  options.set(process.argv[i].replace(/^-+/, '').toLowerCase(), process.argv[i + 1]);
}

let fps = Math.min(Math.max(Number(options.get('fps')) || 10, 0.2), 20);
const quality = Math.min(Math.max(Number(options.get('quality')) || 55, 1), 100);
const maxWidth = Math.min(Math.max(Number(options.get('maxwidth')) || 1280, 320), 3840);

const shot = path.join(os.tmpdir(), `ai-remote-frame-${process.pid}.jpg`);

const say = (message) => process.stderr.write(`${message}\n`);

/** Try each in turn; remember the one that worked so it is not re-probed. */
let grabber = null;

const GRABBERS = IS_MAC
  ? [
      // -x is "no camera shutter sound", which somebody watching their own
      // screen being mirrored ten times a second would not forgive.
      { name: 'screencapture', args: (file) => ['-x', '-t', 'jpg', file] },
    ]
  : [
      // Wayland first when we are in one — grim is the compositor-side tool and
      // the X11 ones capture a black rectangle there.
      ...(process.env.WAYLAND_DISPLAY ? [{ name: 'grim', args: (file) => ['-t', 'jpeg', '-q', String(quality), file] }] : []),
      { name: 'maim', args: (file) => ['-u', '-f', 'jpg', '-m', String(Math.round(quality / 10)), file] },
      { name: 'scrot', args: (file) => ['-o', '-q', String(quality), file] },
      // ImageMagick. `import -window root` is the fallback that exists almost
      // everywhere, and is the slowest of the lot.
      { name: 'import', args: (file) => ['-window', 'root', '-quality', String(quality), file] },
      { name: 'gnome-screenshot', args: (file) => ['-f', file] },
    ];

async function capture() {
  for (const candidate of grabber ? [grabber] : GRABBERS) {
    try {
      await run(candidate.name, candidate.args(shot), { timeout: 10_000 });
      grabber = candidate;
      return await fsp.readFile(shot);
    } catch (err) {
      if (grabber) throw err; // the one that was working has stopped working
      if (err.code !== 'ENOENT') say(`${candidate.name} failed: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(
    IS_MAC
      ? 'screencapture is missing, which should be impossible on macOS. Screen Recording permission may also be needed: System Settings → Privacy & Security → Screen Recording.'
      : 'No screenshot program is installed. Install one of: grim (Wayland), maim, scrot, or imagemagick.',
  );
}

/** Whatever is in front, for the panel's caption. Best-effort by design. */
async function frontWindow() {
  try {
    if (IS_MAC) {
      const { stdout } = await run(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 4000 },
      );
      return String(stdout).trim();
    }
    const { stdout } = await run('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 4000 });
    return String(stdout).trim();
  } catch {
    return 'Desktop';
  }
}

let paused = false;
let stopped = false;

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const { cmd, value } = JSON.parse(line);
      if (cmd === 'pause') paused = true;
      else if (cmd === 'resume') paused = false;
      else if (cmd === 'fps') fps = Math.min(Math.max(Number(value) || fps, 0.2), 20);
      else if (cmd === 'quit') stopped = true;
    } catch {
      /* stray input is not fatal */
    }
  }
});

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

let complained = false;

while (!stopped) {
  const started = Date.now();

  if (paused) {
    await new Promise((r) => setTimeout(r, 120));
    continue;
  }

  try {
    const image = await capture();
    const title = await frontWindow();
    process.stdout.write(
      `${JSON.stringify({
        frame: image.toString('base64'),
        title,
        // The real dimensions are inside the JPEG; the panel scales to fit and
        // does not need them, and decoding a header per frame to fill in a
        // field nobody reads would be a strange way to spend a millisecond.
        width: maxWidth,
        height: 0,
      })}\n`,
    );
    complained = false;
  } catch (err) {
    // Once, not ten times a second. A camera that cannot capture floods the
    // worker's log with the same line otherwise, and buries everything else.
    if (!complained) {
      complained = true;
      say(err.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }

  const spent = Date.now() - started;
  const wait = Math.max(0, 1000 / fps - spent);
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

await fsp.rm(shot, { force: true }).catch(() => {});
