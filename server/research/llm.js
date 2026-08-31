import { streamCompletion } from '../providers/index.js';

/**
 * One model call for a research role, its output collected to a string and its
 * cost charged to the shared budget.
 *
 * The whole pipeline runs on the conversation's own model — the same `entry`
 * passed to every role, differing only in `system` — which is the cheap path
 * the design requires and the only affordable one when the model is a free one.
 * `stream` is injectable so the stages can be tested with scripted output; it
 * defaults to the real provider stream, which already carries key rotation and
 * fallback underneath it.
 *
 * `budget.spent` is the running token total the orchestrator checks against
 * `budget.cap`; `tokensIn`/`tokensOut` accumulate for the audit record.
 */
export async function askModel({ userId, entry, system, prompt, stream = streamCompletion, budget, signal }) {
  const messages = [{ id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', text: prompt }];
  let text = '';

  for await (const ev of stream({ userId, entry, system, messages, effort: 'high', signal })) {
    if (ev.type === 'text') text += ev.delta ?? '';
    else if (ev.type === 'done' && ev.usage && budget) {
      const inTok = ev.usage.input || 0;
      const outTok = ev.usage.output || 0;
      budget.spent += inTok + outTok;
      budget.tokensIn = (budget.tokensIn || 0) + inTok;
      budget.tokensOut = (budget.tokensOut || 0) + outTok;
    }
  }
  return text.trim();
}

/**
 * Pull the first JSON object out of a model reply, however it wrapped it.
 *
 * Models fence JSON, prefix it with "Sure!", or add a trailing sentence, none of
 * which `JSON.parse` tolerates. This finds the first balanced `{…}` and parses
 * that, returning null rather than throwing so a caller can retry or fall back.
 */
export function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === '{') depth += 1;
    else if (raw[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
