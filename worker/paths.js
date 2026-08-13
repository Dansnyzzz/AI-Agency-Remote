import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the worker keeps state of its own — as distinct from the workspace,
 * which holds the user's work.
 *
 * The two must not be the same folder. A persistent browser profile written
 * into somebody's project directory is a surprise at best and a committed
 * 300MB of Chrome cache at worst.
 *
 * Deliberately does not create the directory: this is also called by probes
 * that only want to know whether something is there, and a read that creates a
 * folder as a side effect is a read that lies.
 */
export const dataDir = () => path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));

let workspaceRoot = null;

export function setWorkspace(dir) {
  workspaceRoot = path.resolve(dir);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

/**
 * Move the workspace to somewhere that already exists.
 *
 * The difference from `setWorkspace` is the refusal to create it. Starting up
 * points at a folder you have chosen, and making it is a kindness; changing it
 * later comes from a path typed into a web form or produced by a model, and
 * silently creating `D:\projekts` because somebody mistyped `D:\projects` would
 * turn a typo into an empty workspace and a confusing hour.
 */
export function moveWorkspace(dir) {
  const target = String(dir || '').trim();
  if (!target) throw new Error('Give a folder to work in.');

  const resolved = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`There is no folder at ${resolved} on this computer.`);
  }
  if (!stat.isDirectory()) throw new Error(`${resolved} is a file, not a folder.`);

  workspaceRoot = resolved;
  return workspaceRoot;
}

export function workspace() {
  if (!workspaceRoot) throw new Error('Workspace has not been configured.');
  return workspaceRoot;
}

/**
 * Whether the filesystem tools are confined to the workspace.
 *
 * `FILE_ACCESS=full` lets them read and write anywhere the OS account can,
 * matching what `run_command` has always been able to do. It is opt-in because
 * the default should be the narrow one, but be clear-eyed about what the
 * confinement is worth: it stops accidents and sloppy paths, not a determined
 * shell command.
 */
export const fullDiskAccess = () => /^(full|1|true)$/i.test(process.env.FILE_ACCESS || '');

/**
 * Resolve a model-supplied path against the workspace and refuse anything that
 * escapes it. `input` is untrusted — it comes from an LLM — so every filesystem
 * tool goes through here before touching disk, and symlinks are resolved so a
 * link inside the workspace cannot point out of it.
 */
export function resolveInWorkspace(input) {
  const root = workspace();

  // Full-disk mode: still resolve relative paths against the workspace so
  // day-to-day use is unchanged, but allow absolute paths through.
  if (fullDiskAccess()) return path.resolve(root, input ?? '.');

  const candidate = path.resolve(root, input ?? '.');

  // realpath the deepest ancestor that exists, so the check also covers paths
  // that are about to be created.
  let probe = candidate;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    real = probe;
  }
  const realRoot = fs.realpathSync(root);
  const suffix = path.relative(probe, candidate);
  const resolved = suffix ? path.join(real, suffix) : real;

  const rel = path.relative(realRoot, resolved);
  const inside = resolved === realRoot || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!inside) {
    throw new Error(`Path "${input}" resolves outside the workspace. Access denied.`);
  }
  return resolved;
}

/** Workspace-relative, forward-slashed path for display and tool output. */
export function rel(abs) {
  const r = path.relative(workspace(), abs);
  // Outside the workspace (only possible in full-disk mode) a relative path
  // full of ".." is harder to read than the absolute one.
  if (r.startsWith('..') || path.isAbsolute(r)) return abs;
  return r === '' ? '.' : r.split(path.sep).join('/');
}
