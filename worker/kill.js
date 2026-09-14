/**
 * End a command and everything it started, on every platform.
 *
 * Commands run with `shell: true`, so the direct child is a shell and the
 * program somebody asked for is its child. Killing the direct child ends the
 * shell and nothing else:
 *
 * - On Windows `cmd.exe` goes and the build it launched carries on. `taskkill /T`
 *   takes the tree, and has since AUTO-009.
 * - On Linux and macOS it was never handled (CODE-030). `SIGKILL` reached
 *   `/bin/sh`, the grandchild kept running and kept the output pipe open, so a
 *   cancelled thirty-second command still took thirty seconds to report — and a
 *   timed-out one kept running after the tool said it had been stopped. Found by
 *   CI on ubuntu; every local run of the gate was on Windows, where it passed.
 *
 * Process groups (`detached: true` plus a negative pid) would be the textbook
 * answer and are deliberately not used: a detached command outlives a worker
 * that crashes, and `background.js` already chose "dies with the worker" for
 * exactly that reason. So the tree is read from `ps` once, before anything is
 * signalled — after the shell dies its children are re-parented and the links
 * are gone — and every member is signalled directly.
 */
import { spawn, spawnSync } from 'node:child_process';

const NEWLINE = String.fromCharCode(10);

/**
 * Every descendant of `root`, deepest last, from a `[pid, ppid]` table.
 *
 * Pure, so the walk can be tested on any platform with a table made up by hand.
 *
 * @param {number} root
 * @param {Array<[number, number]>} rows
 * @returns {number[]}
 */
export function descendantsOf(root, rows) {
  const children = new Map();
  for (const [pid, ppid] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const next = queue.shift();
    for (const pid of children.get(next) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/**
 * The live process table as `[pid, ppid]` rows. Empty if `ps` cannot run.
 *
 * @returns {Array<[number, number]>}
 */
function processTable() {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (listed.status !== 0 || !listed.stdout) return [];
  return listed.stdout
    .split(NEWLINE)
    .map((line) => line.split(' ').filter(Boolean).map(Number))
    .filter((cells) => cells.length === 2 && cells.every(Number.isInteger))
    .map(([pid, ppid]) => /** @type {[number, number]} */ ([pid, ppid]));
}

/**
 * Signal a child process and every process under it.
 *
 * Returns the descendants it signalled. A caller escalating later (SIGTERM, then
 * SIGKILL after a grace period) must pass them back as `known`: once the shell
 * has exited its children are re-parented, and a second listing cannot find them.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} [signal]  ignored on Windows, where `taskkill /F` is the only honest stop
 * @param {number[]} [known]  descendants from an earlier call
 * @returns {number[]}
 */
export function killTree(child, signal = 'SIGKILL', known = []) {
  if (!child?.pid) return [];

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
    return [];
  }

  const tree = [...new Set([...known, ...descendantsOf(child.pid, processTable())])];
  for (const pid of [...tree].reverse()) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone between the listing and the signal. That is the outcome wanted.
    }
  }
  child.kill(signal);
  return tree;
}
