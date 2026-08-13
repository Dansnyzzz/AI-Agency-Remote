/**
 * Turning free text into filters.
 *
 * A query like "free claude >200k <$1" should not be sent to the database as a
 * literal string — it means four separate things. This reads that intent out of
 * the words people already type, and hands back only the leftovers as text.
 *
 * Kept free of DOM references on purpose so it can be unit-tested in Node.
 */

/** Aliases so "claude", "gpt" or "gemini" reach the right vendor. */
export const FAMILY_ALIASES = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  gpt: 'openai',
  chatgpt: 'openai',
  openai: 'openai',
  gemini: 'google',
  google: 'google',
  llama: 'meta',
  meta: 'meta',
  mistral: 'mistral',
  deepseek: 'deepseek',
  qwen: 'qwen',
  grok: 'xai',
  xai: 'xai',
};

export const FAMILY_LABELS = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Gemini',
  meta: 'Llama',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  xai: 'Grok',
  cohere: 'Cohere',
  microsoft: 'Phi',
  nvidia: 'NVIDIA',
  perplexity: 'Perplexity',
};

export const familyLabel = (family) =>
  FAMILY_LABELS[family] || String(family).replace(/(^|[-_])(\w)/g, (_, sep, c) => sep + c.toUpperCase());

/**
 * Understands: free / paid · a vendor name · >200k or >=128000 · <$1 or <0.5
 * @returns {{tier, family, minContext, maxPrice, text}}
 */
export function parseQuery(raw) {
  const filters = { tier: null, family: null, minContext: null, maxPrice: null };
  const rest = [];

  for (const word of String(raw || '').trim().split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase();

    if (lower === 'free') {
      filters.tier = 'free';
      continue;
    }
    if (lower === 'paid') {
      filters.tier = 'paid';
      continue;
    }
    if (FAMILY_ALIASES[lower]) {
      filters.family = FAMILY_ALIASES[lower];
      continue;
    }

    // ">200k" / ">=128000" — context window at least this big.
    const ctx = lower.match(/^>=?(\d+(?:\.\d+)?)(k|m)?$/);
    if (ctx) {
      const scale = ctx[2] === 'm' ? 1e6 : ctx[2] === 'k' ? 1e3 : 1;
      filters.minContext = Number(ctx[1]) * scale;
      continue;
    }

    // "<$1" / "<0.5" — at most this much per million input tokens.
    const price = lower.match(/^<=?\$?(\d+(?:\.\d+)?)$/);
    if (price) {
      filters.maxPrice = Number(price[1]);
      continue;
    }

    rest.push(word);
  }

  filters.text = rest.join(' ');
  return filters;
}
