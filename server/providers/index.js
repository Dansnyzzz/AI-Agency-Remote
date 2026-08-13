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

/**
 * Whether another key would have done any better.
 *
 * Only the failures that are about *this key*: it is invalid, it is out of
 * credit, it has been rate limited. A model that does not exist, a malformed
 * request, a provider that is down — those fail identically on every key, and
 * retrying through five of them turns one clear error into five slow ones.
 */
function keyExhausted(error) {
  const status = error?.status || error?.statusCode || error?.response?.status;
  if ([401, 402, 403, 429].includes(Number(status))) return true;

  const message = String(error?.message || '').toLowerCase();
  return /invalid[ _-]?api[ _-]?key|incorrect api key|unauthorized|quota|insufficient|out of credit|rate limit|too many requests|billing/.test(
    message,
  );
}

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
export const __testing = { keyExhausted, outputBudget };
