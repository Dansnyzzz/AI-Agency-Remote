/**
 * Keep the worker running, so the computer is simply there.
 *
 * The promise the app makes is "sign in anywhere and your computer is already
 * connected". A worker somebody has to remember to start from a terminal after
 * every reboot is not that — it is a computer that is there until Tuesday.
 *
 *   node scripts/autostart.js --install
 *   node scripts/autostart.js --status
 *   node scripts/autostart.js --uninstall
 *
 * **At log on, never as a service.** A Windows service runs in session 0, which
 * has no desktop at all — UI Automation and SendInput have nothing to act on, so
 * every `desktop_*` tool would fail on a machine that looked perfectly connected.
 * The same reasoning is already in the README under the always-on VM.
 *
 * **Uninstall is not an afterthought.** Something that starts itself with the
 * machine and cannot say how to stop is something people remove by deleting the
 * folder and wondering what else it left behind. Every platform below prints its
 * own removal command, and `--uninstall` is expected to work even if `--install`
 * was run by a different copy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** One name across all three platforms, so `--status` can find what `--install` made. */
export const TASK_NAME = 'AI Remote worker';
const UNIX_LABEL = 'com.ai-remote.worker';

const flags = new Set(process.argv.slice(2));
const say = (text) => console.log(`  ${text}`);

/** The command being scheduled, in one place: `npm run connect` without the app. */
const workerArgs = [path.join(root, 'scripts', 'launch.js'), '--pair'];

// ── Windows ───────────────────────────────────────────────────────────

/**
 * A `.vbs` shim, because Task Scheduler cannot hide a console window.
 *
 * A scheduled task set to "run only when the user is logged on" — which is the
 * only setting that gives a desktop to drive — shows the console window of
 * whatever it starts. A black box appearing at every login and staying there is
 * not something to ship. `WScript.Shell.Run` with a window style of 0 starts the
 * same command with no window at all, and is present on every Windows install.
 *
 * Written as ASCII with CRLF: `wscript` reads a `.vbs` in the system code page,
 * so a single non-ASCII character silently breaks the line it lives in.
 */
const shimPath = () => path.join(root, 'data', 'autostart.vbs');

function writeShim() {
  const file = shimPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const command = `"${process.execPath}" "${workerArgs[0]}" ${workerArgs[1]}`;
  const body = [
    "' Starts the AI Remote worker with no console window.",
    "' Written by scripts/autostart.js — safe to delete once the task is gone.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${root.replace(/"/g, '""')}"`,
    `shell.Run "${command.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');

  fs.writeFileSync(file, body, 'ascii');
  return file;
}

/**
 * The per-user `Run` key, not Task Scheduler.
 *
 * `schtasks /Create /SC ONLOGON` was the first attempt and it fails with
 * "Access is denied" for an ordinary account — logon-triggered tasks want
 * elevation. Asking for administrator is not an option here: this runs from a
 * one-line installer that a stranger pastes, and a setup that needs admin is a
 * setup nobody should agree to.
 *
 * `HKCU\...\Run` needs no elevation, runs at every logon, and — the property
 * that decided it — appears in Task Manager's Startup tab, where somebody who
 * has forgotten what this is can turn it off without knowing any of the above.
 *
 * The cost against a scheduled task is no restart-on-failure. The worker already
 * loops through its own errors rather than exiting, so that buys little.
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const reg = (args) =>
  execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

function installWindows() {
  const shim = writeShim();
  reg(['add', RUN_KEY, '/v', TASK_NAME, '/t', 'REG_SZ', '/d', `wscript.exe "${shim}"`, '/f']);
  say('Installed. The worker will start when you log in, with no window.');
  say('Windows lists it under Task Manager → Startup, so you can turn it off there too.');
  say(`Remove it with:  node "${path.join(root, 'scripts', 'autostart.js')}" --uninstall`);
  return true;
}

function uninstallWindows() {
  try {
    reg(['delete', RUN_KEY, '/v', TASK_NAME, '/f']);
    say('Removed. The worker will no longer start at login.');
  } catch {
    say('There was nothing installed to remove.');
  }
  try {
    fs.rmSync(shimPath(), { force: true });
  } catch {
    /* the entry is gone either way, which is what was asked for */
  }
  return true;
}

function statusWindows() {
  try {
    return reg(['query', RUN_KEY, '/v', TASK_NAME]).includes(TASK_NAME);
  } catch {
    return false;
  }
}

// ── macOS ─────────────────────────────────────────────────────────────
//
// Written but NOT tested — there is no Mac here to run it on, and a green tick
// for a code path that never executed is worse than an honest gap. Said plainly
// in the README too.

const plistPath = () =>
  path.join(os.homedir(), 'Library', 'LaunchAgents', `${UNIX_LABEL}.plist`);

function installMac() {
  const file = plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const args = [process.execPath, ...workerArgs]
    .map((a) => `    <string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`)
    .join('\n');

  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${UNIX_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`,
    'utf8',
  );

  try {
    execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' });
  } catch {
    say('Wrote the agent, but launchctl would not load it. Log out and back in.');
  }
  say('Installed. The worker will start when you log in.');
  say(`Remove it with:  node "${path.join(root, 'scripts', 'autostart.js')}" --uninstall`);
  return true;
}

function uninstallMac() {
  const file = plistPath();
  try {
    execFileSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' });
  } catch {
    /* not loaded; removing the file is still the right outcome */
  }
  fs.rmSync(file, { force: true });
  say('Removed. The worker will no longer start at login.');
  return true;
}

const statusMac = () => fs.existsSync(plistPath());

// ── Linux ─────────────────────────────────────────────────────────────
//
// Also written but not tested, for the same reason.

const unitPath = () =>
  path.join(os.homedir(), '.config', 'systemd', 'user', 'ai-remote-worker.service');

function installLinux() {
  const file = unitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(
    file,
    `[Unit]
Description=AI Remote worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${process.execPath} ${workerArgs.join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
    'utf8',
  );

  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'ai-remote-worker'], { stdio: 'ignore' });
  } catch {
    say('Wrote the unit, but systemctl would not enable it. Try: systemctl --user enable --now ai-remote-worker');
  }
  say('Installed. The worker will start when you log in.');
  say(`Remove it with:  node "${path.join(root, 'scripts', 'autostart.js')}" --uninstall`);
  return true;
}

function uninstallLinux() {
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'ai-remote-worker'], { stdio: 'ignore' });
  } catch {
    /* not enabled; removing the unit is still the right outcome */
  }
  fs.rmSync(unitPath(), { force: true });
  say('Removed. The worker will no longer start at login.');
  return true;
}

const statusLinux = () => fs.existsSync(unitPath());

// ── dispatch ──────────────────────────────────────────────────────────

const BY_PLATFORM = {
  win32: { install: installWindows, uninstall: uninstallWindows, status: statusWindows },
  darwin: { install: installMac, uninstall: uninstallMac, status: statusMac },
  linux: { install: installLinux, uninstall: uninstallLinux, status: statusLinux },
};

export function autostartFor(platform = process.platform) {
  return BY_PLATFORM[platform] || null;
}

/** The shim's text, exposed so a test can check it without writing to disk. */
export const __testing = { shimPath, plistPath, unitPath, workerArgs, TASK_NAME };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const impl = autostartFor();
  if (!impl) {
    console.error(`\n  Starting at login is not set up for ${process.platform} here.`);
    console.error(`  Start it by hand instead:  npm run connect\n`);
    process.exit(1);
  }

  try {
    if (flags.has('--uninstall')) impl.uninstall();
    else if (flags.has('--status')) say(impl.status() ? 'Installed — it starts at login.' : 'Not installed.');
    else impl.install();
  } catch (err) {
    console.error(`\n  ${err?.message || err}\n`);
    process.exit(1);
  }
}
