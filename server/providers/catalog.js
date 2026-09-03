/**
 * Model catalog. IDs are `provider/model` so a conversation records exactly what
 * produced it.
 *
 * `price` is USD per 1M tokens and is only filled in where it is verified.
 * Where it is null the UI shows token counts instead of inventing a number —
 * users can always add a custom model or pull the live OpenRouter catalog.
 */
export const CATALOG = [
  // ---- Anthropic ------------------------------------------------------------
  {
    /**
     * The one to reach for on demanding reasoning and long-horizon agentic work
     * — which is most of what this app is for.
     *
     * `cacheRead` is the reason this entry carries an override at all. Fable
     * 5.1 reads a cached prompt at **2.5%** of the input rate rather than the
     * usual 10%, and the note on `cacheRates` below always said adding one of
     * these should be a data change rather than a code change. This is that
     * change. Getting it wrong in the other direction would overstate a
     * well-cached agentic conversation by four times on the cached portion,
     * which on a $10/MTok model is not a rounding error.
     *
     * Thinking is adaptive and always on here, so there is nothing to opt out
     * of; `effort` defaults to `high` exactly as the adapter already sends.
     * Verified against platform.claude.com/docs models overview, 2026-09-03.
     */
    id: 'anthropic/claude-fable-5-1',
    provider: 'anthropic',
    model: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    context: 1_000_000,
    maxOutput: 128_000,
    thinking: true,
    price: { in: 10, out: 50 },
    cacheRead: 0.025,
    tags: ['flagship', 'agentic', 'reasoning'],
  },
  {
    id: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    model: 'claude-opus-5',
    label: 'Claude Opus 5',
    context: 1_000_000,
    // 128k is what the model actually allows, and the adapter streams, which is
    // the condition attached to asking for an output that large. At 64_000 a
    // long report was being cut off half way for no reason but this line.
    maxOutput: 128_000,
    thinking: true,
    price: { in: 5, out: 25 },
    tags: ['flagship', 'agentic'],
  },
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    context: 1_000_000,
    maxOutput: 128_000,
    thinking: true,
    // $3/$15 was Sonnet 4.6's price, carried over by mistake — every Sonnet 5
    // estimate read 50% high. Checked against platform.claude.com/docs pricing
    // on 2026-09-02, which also records that the increase to $3/$15 once
    // scheduled for 2026-09-01 was cancelled and $2/$10 is now the standard.
    price: { in: 2, out: 10 },
    tags: ['balanced'],
  },
  {
    id: 'anthropic/claude-opus-4-8',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    context: 1_000_000,
    maxOutput: 64_000,
    thinking: true,
    price: { in: 5, out: 25 },
    tags: [],
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    context: 200_000,
    /**
     * 64k, not the 32k this said.
     *
     * Understating a model's output cap is not the safe direction it looks
     * like: this is the model `roleModel.js` routes compaction to, and
     * compaction is the largest prompt the app sends. A summary of a long
     * conversation was being cut off at half the length the model would have
     * allowed — and a truncated summary silently loses the decisions the rest
     * of the conversation rests on. Checked against platform.claude.com/docs
     * models overview, 2026-09-03.
     */
    maxOutput: 64_000,
    // Haiku 4.5 predates adaptive thinking and rejects `output_config.effort`.
    thinking: false,
    effort: false,
    price: { in: 1, out: 5 },
    tags: ['fast', 'cheap'],
  },

  // ---- OpenAI ---------------------------------------------------------------
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    model: 'gpt-5',
    label: 'GPT-5',
    context: 400_000,
    maxOutput: 32_000,
    price: null,
    tags: ['flagship'],
  },
  {
    id: 'openai/gpt-5-mini',
    provider: 'openai',
    model: 'gpt-5-mini',
    label: 'GPT-5 mini',
    context: 400_000,
    maxOutput: 32_000,
    price: null,
    tags: ['fast'],
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'openai',
    model: 'gpt-4.1',
    label: 'GPT-4.1',
    context: 1_000_000,
    maxOutput: 32_000,
    price: null,
    tags: [],
  },
  {
    id: 'openai/o4-mini',
    provider: 'openai',
    model: 'o4-mini',
    label: 'o4-mini',
    context: 200_000,
    maxOutput: 32_000,
    price: null,
    tags: ['reasoning'],
  },

  /* ---- Google ---------------------------------------------------------------
   *
   * The aliases, not the version numbers.
   *
   * `gemini-2.5-flash` shipped here as a built-in and stopped working — not
   * removed, but restricted: Google's own `ListModels` still returns it, and a
   * call to it answers *"no longer available to new users"*. A named version is
   * a catalogue entry with an expiry date nobody is told about, and the first
   * anybody hears of it is a wall of JSON halfway through a sentence.
   *
   * `-latest` is Google's answer to that: a pointer that moves as models rotate.
   * The context limits below are what the account's own `ListModels` reported
   * rather than anything remembered, and **Settings → Models → Check models**
   * calls each of these with your key, because being listed and being callable
   * are different questions.
   */
  {
    id: 'google/gemini-pro-latest',
    provider: 'google',
    model: 'gemini-pro-latest',
    label: 'Gemini Pro (latest)',
    context: 1_048_576,
    maxOutput: 64_000,
    price: null,
    tags: ['flagship'],
  },
  {
    id: 'google/gemini-flash-latest',
    provider: 'google',
    model: 'gemini-flash-latest',
    label: 'Gemini Flash (latest)',
    context: 1_048_576,
    maxOutput: 64_000,
    price: null,
    tags: ['fast'],
  },
  {
    id: 'google/gemini-flash-lite-latest',
    provider: 'google',
    model: 'gemini-flash-lite-latest',
    label: 'Gemini Flash-Lite (latest)',
    context: 1_048_576,
    maxOutput: 64_000,
    price: null,
    tags: ['fast', 'cheap'],
  },
];

export const PROVIDERS = {
  anthropic: { label: 'Anthropic', keyHint: 'sk-ant-…', console: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', keyHint: 'sk-…', console: 'https://platform.openai.com/api-keys' },
  google: { label: 'Google Gemini', keyHint: 'AIza…', console: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', keyHint: 'sk-or-v1-…', console: 'https://openrouter.ai/keys' },
  orcarouter: { label: 'OrcaRouter', keyHint: 'sk-orca-…', console: 'https://www.orcarouter.ai/keys' },
};

/**
 * How many output tokens to allow a library model, when nobody has said.
 *
 * OpenRouter publishes a real figure for most models and it is stored; this is
 * for the rest. Half the context window, floored at 1024 and capped at the
 * 32000 the adapters used to assume unconditionally.
 *
 * Deriving it rather than reaching for the constant matters in both directions.
 * `openai/gpt-4` has an 8191-token window, so asking for 32000 output was asking
 * for four times the whole context. And a 1M-context model does not have a 1M
 * output budget either — the two numbers are unrelated, which is exactly why
 * guessing one from the other has to stay conservative.
 */
function derivedMaxOutput(context) {
  const window = Number(context);
  if (!Number.isFinite(window) || window <= 0) return 32_000;
  return Math.min(32_000, Math.max(1024, Math.floor(window / 2)));
}

/**
 * Resolve `provider/model` into a catalog entry.
 *
 * `sharedRow` is the matching row from the shared model library, when the
 * caller has already looked it up — that is where everything beyond the
 * built-in first-party models lives.
 */
export function resolveModel(id, sharedRow = null) {
  // Every first-party model here reads images. They are the flagships of the
  // three vendors and all of them have for years.
  const found = CATALOG.find((m) => m.id === id);
  if (found) return { vision: true, ...found };

  if (sharedRow) {
    return {
      id: sharedRow.id,
      provider: sharedRow.provider,
      model: sharedRow.model,
      label: sharedRow.label || sharedRow.model,
      context: sharedRow.context ? Number(sharedRow.context) : null,
      // The provider's own figure where it published one, a conservative
      // fraction of the context window where it did not. Never the flat 32000
      // this used to be, which asked `openai/gpt-4` for four times its window.
      maxOutput: Number(sharedRow.max_output) || derivedMaxOutput(sharedRow.context),
      price:
        sharedRow.price_in == null
          ? null
          : { in: Number(sharedRow.price_in), out: Number(sharedRow.price_out) },
      // Roughly half the catalogue cannot be shown a picture, and sending one
      // anyway does not degrade the answer — the provider rejects the request.
      vision: !!sharedRow.vision,
      tags: sharedRow.is_free ? ['free'] : [],
    };
  }

  // A hand-typed `provider/model` for a provider we support still works, so
  // nobody is blocked waiting for the library to catch up.
  const slash = String(id || '').indexOf('/');
  if (slash > 0) {
    const provider = id.slice(0, slash);
    const model = id.slice(slash + 1);
    if (PROVIDERS[provider] && model.trim()) {
      return {
        id,
        provider,
        model,
        label: model,
        context: null,
        maxOutput: 32_000,
        price: null,
        // Unknown, so assumed capable: refusing to send an image to a model that
        // can take one is a worse mistake than the reverse, which now explains
        // itself rather than failing.
        vision: true,
        tags: ['custom'],
      };
    }
    // Naming a provider that does not exist is a typo, not a custom model, and
    // saying so here beats an opaque failure from an adapter that was never
    // going to be able to run it.
    if (!PROVIDERS[provider]) {
      throw new Error(
        `"${id}" names the provider "${provider}", which is not one of: ${Object.keys(PROVIDERS).join(', ')}.`,
      );
    }
  }
  throw new Error(`Unknown model "${id}". Pick one from the model browser.`);
}

/**
 * What a cached prompt token costs, as a multiple of the ordinary input rate.
 *
 * Anthropic's published ratios, and the same shape everywhere else that bills
 * for caching at all. Reading from the cache is the whole reason to write to it:
 * a tenth of the price, against a quarter more paid once to put it there.
 */
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;
// Both are per-model in principle — Fable 5.1 and Mythos 5.1 read at 0.025x —
// so an entry may say so. Nothing in this catalogue does yet; the override
// exists so that adding one of them is a data change rather than a code change.
const cacheRates = (entry) => ({
  read: Number.isFinite(entry?.cacheRead) ? entry.cacheRead : CACHE_READ_RATE,
  write: Number.isFinite(entry?.cacheWrite) ? entry.cacheWrite : CACHE_WRITE_RATE,
});

/**
 * Price a turn, taking cached prompt tokens at the rate they were actually
 * billed at.
 *
 * `usage.input` is the whole prompt — the gauge needs that — and `cacheRead` /
 * `cacheWrite` are subsets of it. Charging the full input rate for all three,
 * which is what this did before, overstates a well-cached agentic conversation
 * by close to ten times on the cached portion. That is not a rounding error on a
 * page whose only job is to tell somebody what they are spending.
 *
 * Defensive about the arithmetic: a provider that reports a cached count larger
 * than the prompt it belongs to must not produce a negative bill.
 */
export function estimateCost(entry, usage) {
  if (!entry?.price || !usage) return null;

  const total = usage.input || 0;
  const read = Math.min(usage.cacheRead || 0, total);
  const written = Math.min(usage.cacheWrite || 0, Math.max(0, total - read));
  const fresh = Math.max(0, total - read - written);

  const rate = cacheRates(entry);
  const input = (fresh + read * rate.read + written * rate.write) / 1e6 * entry.price.in;
  const output = (usage.output || 0) / 1e6 * entry.price.out;
  return input + output;
}

/**
 * What a turn cost, preferring the provider's own figure over our arithmetic.
 *
 * `estimateCost` is exactly that — an estimate, from a price table somebody has
 * to keep current, and null for the large majority of the model library where
 * no price was ever verified. OpenRouter and OrcaRouter both report the real
 * billed amount on `usage.cost`, in dollars, on the final streamed chunk. When
 * a provider has told us what it charged, believing it beats recomputing it:
 * the figure is right even for a model whose price we never knew, and it stays
 * right when a provider changes its rates without telling anybody.
 *
 * `source` travels with the number so the interface can be honest about which
 * of the two it is showing. "$0.0043" and "about $0.0043" are different claims,
 * and a usage page that cannot tell them apart is inviting somebody to trust
 * the wrong one.
 *
 * @returns {{usd: number, source: 'provider'|'estimate'}|null}
 *   null only when neither the provider said and nor we can work it out.
 */
export function priceTurn(entry, usage) {
  const stated = Number(usage?.costUsd);
  if (Number.isFinite(stated) && stated >= 0) return { usd: stated, source: 'provider' };

  const worked = estimateCost(entry, usage);
  return worked == null ? null : { usd: worked, source: 'estimate' };
}
