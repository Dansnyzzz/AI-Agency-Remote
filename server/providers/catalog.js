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
    id: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    model: 'claude-opus-5',
    label: 'Claude Opus 5',
    context: 1_000_000,
    maxOutput: 64_000,
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
    maxOutput: 64_000,
    thinking: true,
    price: { in: 3, out: 15 },
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
    maxOutput: 32_000,
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

export function estimateCost(entry, usage) {
  if (!entry?.price || !usage) return null;
  const input = (usage.input || 0) / 1e6 * entry.price.in;
  const output = (usage.output || 0) / 1e6 * entry.price.out;
  return input + output;
}
