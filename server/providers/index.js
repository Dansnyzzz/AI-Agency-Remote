import { streamAnthropic } from './anthropic.js';
import { streamOpenAICompatible } from './openaiCompatible.js';
import { streamGoogle } from './google.js';
import { getApiKeys, baseUrlFor, rememberWorkingKey } from '../settings.js';
import { resolveModel, PROVIDERS } from './catalog.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function openrouterHeaders() {
  const referer = process.env.PUBLIC_URL || 'https://github.com/';
  return { 'HTTP-Referer': referer, 'X-Title': 'AI Remote' };
}

/** One provider's stream, for one key. */
async function* streamOne(entry, common) {
  switch (entry.provider) {
    case 'anthropic':
      yield* streamAnthropic(common);
      return;
    case 'openai':
      yield* streamOpenAICompatible(common);
      return;
    case 'openrouter':
      yield* streamOpenAICompatible({ ...common, baseURL: OPENROUTER_BASE, headers: openrouterHeaders() });
      return;
    case 'google':
      yield* streamGoogle(common);
      return;
    default:
      throw new Error(`Unsupported provider "${entry.provider}"`);
  }
}

/**
 * How many output tokens to ask this model for.
 *
 * Every adapter used to default to 32000 and nothing ever passed anything else,
 * so a request to `ai21/jamba-large-1.7` (4096) or `amazon/nova-lite-v1` (5120)
 * asked for several times what the provider had already published as its limit —
 * and a request to `openai/gpt-4` asked for four times its entire 8191-token
 * window. Forty-five of the models in the catalogue cap below 32000.
 *
 * Decided here rather than in each adapter because this is the one place that
 * holds the resolved catalogue entry, so the three adapters cannot drift.
 *
 * Also kept inside the window: `max_tokens` and the prompt share the context, so
 * asking for an output larger than the whole window cannot be satisfied whatever
 * the model's own cap says.
 */
export function outputBudget(entry) {
  const stated = Number(entry?.maxOutput);
  const wanted = Number.isFinite(stated) && stated > 0 ? stated : 32_000;

  const context = Number(entry?.context);
  if (!Number.isFinite(context) || context <= 0) return wanted;

  // Leave the prompt somewhere to live. A model whose window is smaller than the
  // reply it is being asked for cannot produce that reply.
  return Math.max(256, Math.min(wanted, context - 1024));
}

/** The longest we will hold one request open waiting for a limit to lift. */
const MAX_WAIT_MS = 60_000;

/** Beyond a day, a header is lying or a clock is wrong. */
const MAX_SANE_WAIT_MS = 24 * 3600_000;

/**
 * A header off an SDK error, whichever shape the SDK chose.
 *
 * The Anthropic and OpenAI SDKs both attach the response headers, but one hands
 * back a `Headers` instance and the other a plain object, and header names
 * arrive in whatever case the server used.
 */
function headerOf(error, name) {
  const bag = error?.headers || error?.response?.headers;
  if (!bag) return null;
  if (typeof bag.get === 'function') return bag.get(name) ?? null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(bag)) {
    if (String(key).toLowerCase() === wanted) return value == null ? null : String(value);
  }
  return null;
}

/**
 * How long the provider says to wait, in milliseconds.
 *
 * Returned in full rather than clamped: the caller needs the difference between
 * "twenty seconds" and "tomorrow morning". One is worth waiting for inside the
 * request; the other is worth recording and saying out loud.
 */
function waitFrom(error, now = Date.now()) {
  const sane = (ms) => (Number.isFinite(ms) && ms > 0 && ms <= MAX_SANE_WAIT_MS ? Math.round(ms) : null);

  // `Retry-After` is either a number of seconds or an HTTP date.
  const after = headerOf(error, 'retry-after');
  if (after != null && String(after).trim() !== '') {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return sane(seconds * 1000);
    const when = Date.parse(String(after));
    if (Number.isFinite(when)) return sane(when - now);
  }

  // `X-RateLimit-Reset` has no agreed unit. OpenRouter sends epoch
  // milliseconds, others send epoch seconds, and a few send a plain duration —
  // so tell them apart by magnitude rather than by trusting the name.
  const reset = Number(headerOf(error, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    if (reset > 1e12) return sane(reset - now);
    if (reset > 1e9) return sane(reset * 1000 - now);
    return sane(reset * 1000);
  }

  return null;
}

const DEAD_KEY =
  /invalid[ _-]?api[ _-]?key|incorrect api key|unauthorized|no such key|out of credit|insufficient|billing/;
const TRANSIENT = /timeout|timed out|econnreset|econnrefused|socket hang up|fetch failed|network/;

/**
 * What a failure says about the key that produced it.
 *
 * The version this replaced answered one question — "would another key have
 * done any better?" — and answered it the same way for a rate limit as for an
 * empty wallet. They are not the same. A 429 usually wants a few seconds and
 * the *same* key; a 402 wants a different key and will never want that one
 * again. Grading them alike is what turned a momentary limit on a single-key
 * account into a hard failure with nothing to fall back to.
 *
 * - `RATE_LIMITED` — this key, later. `retryAfterMs` when the provider said.
 * - `KEY_DEAD`     — this key, never again this run. Try the next one.
 * - `UPSTREAM`     — the provider stumbled. Same key, after a pause.
 * - `FATAL`        — broken in a way every key shares. Report it and stop:
 *                    walking five keys turns one clear error into five slow ones.
 */
function classify(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status) || 0;
  const message = String(error?.message || '').toLowerCase();
  const retryAfterMs = waitFrom(error);

  // Status first. Plenty of 429 bodies say "quota", and reading that as a spent
  // key is exactly the misgrading this function exists to stop.
  // "quota" with no status attached is almost always a limit rather than a
  // spent key, so it rests this key and moves on rather than condemning it for
  // the life of the process on the strength of one vague sentence.
  if (status === 429 || (!status && /rate limit|too many requests|quota/.test(message))) {
    return { kind: 'RATE_LIMITED', retryAfterMs };
  }
  if ([401, 402, 403].includes(status) || (!status && DEAD_KEY.test(message))) {
    return { kind: 'KEY_DEAD', retryAfterMs: null };
  }
  if (status === 408 || status >= 500 || (!status && TRANSIENT.test(message))) {
    return { kind: 'UPSTREAM', retryAfterMs };
  }
  return { kind: 'FATAL', retryAfterMs: null };
}

// Bridged until the rotation loop below is rewritten in terms of `classify`.
const keyExhausted = (error) => classify(error).kind !== 'FATAL';

/**
 * One streaming interface over every provider, and every key they have.
 *
 * An account can hold several keys per provider, and they are tried in order
 * until one answers. That is the whole point of holding more than one: a key
 * that runs out at eleven should cost a moment, not the rest of the day.
 *
 * The rotation stops the instant anything has been streamed. Once the user has
 * seen half a sentence, starting again on another key would either repeat it or
 * silently replace it — so a failure mid-answer is reported as a failure, and
 * only a failure *before* the first token is retried. That is the difference
 * between a fallback and a duplicate.
 *
 * Yields: {type:'text'|'thinking', delta} · {type:'tool_call_start', id, name}
 *       · {type:'notice', text} · {type:'done', stopReason, toolCalls, usage, raw?}
 */
export async function* streamCompletion(opts) {
  const entry = opts.entry;
  const label = PROVIDERS[entry.provider]?.label || entry.provider;
  const keys = await getApiKeys(opts.userId, entry.provider);

  if (!keys.length) {
    throw new Error(`No API key for ${label}. Add one in Settings → Providers.`);
  }

  let refused = null;

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const { key, index, shared } = keys[attempt];
    const common = {
      ...opts,
      apiKey: key,
      model: entry.model,
      entry,
      baseURL: baseUrlFor(entry.provider),
      // Whatever this model actually produces, rather than the 32000 every
      // adapter used to fall back to. A caller may still override it.
      maxTokens: opts.maxTokens ?? outputBudget(entry),
    };

    let streamed = false;
    try {
      for await (const event of streamOne(entry, common)) {
        streamed = true;
        yield event;
      }
      // This one worked; start here next time rather than rediscovering the
      // dead keys ahead of it on every turn.
      if (!shared) rememberWorkingKey(opts.userId, entry.provider, index);
      return;
    } catch (err) {
      const last = attempt === keys.length - 1;
      if (streamed || last || !keyExhausted(err)) {
        // The last key's failure is the one worth reporting, but a reader
        // deserves to know the others were tried at all.
        if (refused && !streamed) err.message = `${err.message} (${refused})`;
        throw err;
      }

      const which = shared ? 'the deployment key' : `key ${index + 1}`;
      refused = `${which} was refused: ${err.message}`;
      // Said out loud rather than swallowed: a fallback that nobody can see is
      // indistinguishable from the first key having worked, right up until the
      // bill or the outage says otherwise.
      yield { type: 'notice', text: `${label}: ${which} was refused, trying the next one.` };
    }
  }
}

export { resolveModel, PROVIDERS };

/** Exposed for the suite that pins which failures are worth another key. */
export const __testing = { classify, waitFrom, headerOf, outputBudget };
