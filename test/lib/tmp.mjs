import fs from 'node:fs';

/**
 * Remove a temporary directory, and never fail the suite for it.
 *
 * On Windows a file cannot be unlinked while a handle is open on it, and
 * PGlite's WASM layer releases its handles a moment after `close()` resolves.
 * `fs.rmSync` inside that window throws ENOTEMPTY — at the *end* of a run, after
 * every check has already passed — and the suite exits non-zero anyway.
 *
 * That failure mode is worse than it sounds. The gate goes red on a run where
 * nothing was wrong, which teaches people to re-run a red gate rather than read
 * it, and reading it is the entire point of having one.
 *
 * A few short retries cover the gap. If the directory genuinely will not go, it
 * is a temp directory named after this process: the operating system clears it
 * eventually, and nothing about it is worth a false red.
 */
export function removeTemp(dir, { attempts = 5, waitMs = 200 } = {}) {
  if (!dir) return;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Busy-wait rather than await: callers use this at module scope on the way
      // out, where there is no async context left to yield to.
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* let the handles close */ }
    }
  }
}
