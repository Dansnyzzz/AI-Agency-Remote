/**
 * Hear about a cancellation while a job is running.
 *
 * There was no way to. The worker claimed a job and ran it to completion, and
 * nothing it polled carried a stop. So when a person pressed stop, the server
 * marked the job finished and stopped waiting — and the command kept running
 * on their machine, a `delete_file` already underway finished, and the only
 * thing that changed was that nobody was listening for the result (AUTO-009).
 * CODE-017 made the message to the model honest about that; this is the part
 * that makes it true less often.
 *
 * The worker cannot be pushed to — every connection is one it opened — so it
 * asks. Only while a job is running, and only every few seconds: a job that
 * finishes in under that never asks at all, which is nearly all of them, and
 * the ones worth stopping are the ones that run long.
 *
 * Kept out of `index.js` so it can be tested without starting a worker.
 */

/** Statuses that mean the server has already closed this job. */
const CLOSED = new Set(['done', 'error', 'cancelled']);

/**
 * @param {string} jobId
 * @param {AbortController} controller  aborted with reason 'cancelled'
 * @param {{ getStatus: (id: string) => Promise<string|null>, intervalMs?: number }} options
 * @returns {() => void}  stop watching — call it when the job ends either way
 */
export function watchForCancel(jobId, controller, { getStatus, intervalMs = 5_000 }) {
  let stopped = false;
  let inFlight = false;

  const timer = setInterval(async () => {
    if (stopped || inFlight || controller.signal.aborted) return;
    inFlight = true;
    try {
      const status = await getStatus(jobId);
      if (!stopped && CLOSED.has(String(status))) controller.abort('cancelled');
    } catch {
      // The server being unreachable is not a cancellation. A job that loses its
      // connection keeps running and reports when it can, which is what it did
      // before this existed — failing closed here would kill work on a blip.
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
