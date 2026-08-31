import { getStore } from './store/index.js';
import { getApiKeys } from './settings.js';

/**
 * Auto model selection — pick the best free model so somebody who does not know
 * which model is strong does not have to choose.
 *
 * "Best" has no objective column to sort on: a model's metadata says how big its
 * window is and whether it reads images, not how clever it is. So best is a
 * curated family order, and within a family the newest and roomiest. The order
 * is maintained by hand because that is the honest place for a quality judgement
 * to live — a heuristic that reached for "largest context" would confidently
 * pick a big, weak model. When a family ships a new free model it is chosen
 * automatically (it sorts to the top of its family); when a new family becomes
 * worth trusting, it is added here.
 */
export const AUTO_ID = 'auto';

/** True for the special "let the system choose" model id. */
export const isAuto = (id) => id === AUTO_ID;

/**
 * Strongest free families first. Deepseek leads because its free releases have
 * been the strongest, and the user named it. A family not listed still competes,
 * just after every listed one — so a genuinely new name is used rather than
 * hidden, it simply does not outrank a known-good family until it is added.
 */
const FAMILY_PRIORITY = [
  'deepseek',
  'qwen',
  'meta',
  'mistral',
  'google',
  'xai',
  'microsoft',
  'nvidia',
  'cohere',
];

/** Lower is better; unlisted families sort after every listed one. */
function familyRank(family) {
  const i = FAMILY_PRIORITY.indexOf(String(family || '').toLowerCase());
  return i === -1 ? FAMILY_PRIORITY.length : i;
}

const released = (row) => (row.released_at ? Date.parse(row.released_at) : 0) || 0;
const context = (row) => Number(row.context) || 0;

/**
 * Which of these providers the account can actually reach right now.
 *
 * A provider is reachable when `getApiKeys` returns at least one key — and that
 * function already leaves out keys that are resting, so a provider drops out
 * only when EVERY one of its keys is rate limited or dead. Someone who stacks
 * several keys for fallback gets all of them spent before a model backed by that
 * provider disappears from the auto choice. Looked up once per provider rather
 * than once per model.
 */
async function reachableProviders(userId, providers) {
  const reachable = new Set();
  await Promise.all(
    [...providers].map(async (provider) => {
      const keys = await getApiKeys(userId, provider).catch(() => []);
      if (keys.length) reachable.add(provider);
    }),
  );
  return reachable;
}

/**
 * The best free model the account can run right now, or null.
 *
 * @param vision  when true, only models that can read an image are considered.
 * @returns the shared-library row, or null when nothing free is reachable —
 *          the caller turns null into a plain message rather than quietly
 *          spending money on a paid model.
 */
export async function pickAutoModel(userId, { vision = false } = {}) {
  const rows = await getStore()
    .listSharedModels({ tier: 'free', limit: 500 })
    .catch(() => []);
  if (!rows.length) return null;

  const providers = new Set(rows.map((r) => r.provider));
  const reachable = await reachableProviders(userId, providers);

  const usable = rows.filter((r) => reachable.has(r.provider) && (!vision || r.vision === true));
  if (!usable.length) return null;

  usable.sort(
    (a, b) => familyRank(a.family) - familyRank(b.family) || released(b) - released(a) || context(b) - context(a),
  );

  const row = usable[0];
  // Present the row the rest of the app expects: `is_free`/`released_at` come
  // off the database as snake_case, so mirror the camelCase `normalise` shape
  // the picker and tests read.
  return { ...row, id: row.id, provider: row.provider, family: row.family, isFree: true, vision: !!row.vision };
}

/** Exposed for the suite that pins the ordering rules. */
export const __testing = { familyRank, FAMILY_PRIORITY };
