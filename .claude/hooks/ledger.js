#!/usr/bin/env node
/**
 * PostToolUse: record the file that just changed as unproven.
 *
 * Kept separate from `lint-changed.js`, which fires on the same event, because
 * the two answer different questions — that one asks whether this file is
 * well-formed now, this one remembers that the tree stopped being verified. One
 * hook doing both would have to fail as one, and a lint problem is not a reason
 * to stop keeping the ledger.
 *
 * Never blocks. Writing a file is not something to argue with; the argument, if
 * there is one, belongs at the point where the work is called finished.
 */

import { readPayload, pass } from './io.js';
import { note } from './gate.js';

const payload = await readPayload();
const file = String(payload.tool_input?.file_path || payload.tool_input?.notebook_path || '');

if (file) {
  try {
    note(file);
  } catch {
    // A ledger that cannot be written is a weaker gate, not a broken session.
  }
}

pass();
