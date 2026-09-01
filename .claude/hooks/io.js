#!/usr/bin/env node
/**
 * The three things every hook here does with the harness, in one place.
 *
 * Read the JSON payload from stdin, hand text back to the model, or block the
 * call. The existing guards inline all of this because they were the only two;
 * with eight hooks the repetition is the bug — each copy is a place where the
 * fail-open path can quietly be got wrong.
 *
 * Fail-open is the rule that matters. A hook that throws on unexpected input
 * does not fail safe: it wedges every tool call in the session, and the fix is
 * to delete the hook. So every entry point here swallows and exits 0.
 */

import process from 'node:process';

/**
 * Read and parse the hook payload. Resolves to `{}` on anything unexpected —
 * empty stdin, malformed JSON, a payload shape from a newer harness.
 */
export function readPayload() {
  return new Promise((resolve) => {
    let raw = '';

    // If stdin never ends, the hook must not hang the turn waiting for it.
    const bail = setTimeout(() => resolve({}), 5_000);
    bail.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('error', () => {
      clearTimeout(bail);
      resolve({});
    });
    process.stdin.on('end', () => {
      clearTimeout(bail);
      try {
        const parsed = JSON.parse(raw || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Hand text to the model without blocking anything.
 *
 * The harness reads `hookSpecificOutput.additionalContext` on stdout for this
 * set of events; `hookEventName` must be echoed back or the payload is ignored.
 */
export function context(hookEventName, text) {
  if (!text) process.exit(0);
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })}\n`,
  );
  process.exit(0);
}

/**
 * Block the call. Exit 2 is what the harness reads as a refusal, and stderr is
 * what it hands the model as the reason — which is why every caller here says
 * what to do instead rather than just no.
 */
export function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Nothing to say. */
export function pass() {
  process.exit(0);
}
