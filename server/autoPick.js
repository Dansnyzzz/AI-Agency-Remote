import { getApiKeys } from './settings.js';
import { resolve as resolveModelId } from './models.js';

/**
 * Auto model — "I don't know which model is strong, you choose".
 *
 * Auto is OpenRouter's own free router, `openrouter/free`
 * (https://openrouter.ai/openrouter/free). It used to be a hand-curated family
 * order picked from our library, which had two weaknesses the router does not:
 * the order was a quality judgement maintained by hand, and it could only see
 * the capabilities our metadata recorded. The router chooses per request among
 * the free models that are up right now and that support what the request
 * needs — tools, images — so there is no separate vision toggle to get wrong.
 *
 * The id is fixed rather than looked up in the library because the router is
 * not a row the daily refresh is guaranteed to carry; the entry below is what
 * the provider layer needs to run it.
 */
export const AUTO_ID = 'auto';

/** True for the special "let the system choose" model id. */
export const isAuto = (id) => id === AUTO_ID;

/** The runnable entry Auto expands to. Free, and routed by OpenRouter. */
export const AUTO_ROUTER = Object.freeze({
  id: 'openrouter/openrouter/free',
  provider: 'openrouter',
  model: 'openrouter/free',
  label: 'OpenRouter Free Router',
  context: 200_000,
  // Unknown per request — the router picks the model — so stated as nothing and
  // left to the cautious budget `outputBudget` applies to an entry with no cap.
  maxOutput: null,
  price: { in: 0, out: 0 },
  // The router sends a request carrying an image to a free model that reads
  // images, so the entry must not stop an image from being sent.
  vision: true,
  tags: ['free'],
  isFree: true,
});

/** Thrown, and emitted by the agent loop, when Auto cannot run. */
export const NO_AUTO_MESSAGE =
  'Auto uses OpenRouter\'s free router, so it needs an OpenRouter key. ' +
  'Add one in Settings → Providers, or pick a specific model.';

/**
 * The router entry when the account can reach OpenRouter right now, else null.
 *
 * `getApiKeys` already leaves out resting keys, so this is null only when every
 * OpenRouter key (and the deployment's shared one) is rate limited or absent.
 */
export async function pickAutoModel(userId) {
  const keys = await getApiKeys(userId, 'openrouter').catch(() => []);
  return keys.length ? { ...AUTO_ROUTER } : null;
}

/**
 * Resolve a model id to a runnable entry, expanding the special `auto` id.
 *
 * The single door every caller that resolves the account's default model goes
 * through — sub-agents, compaction, the context gauge — because `auto` is not a
 * real id and `resolve` cannot expand it. A concrete id passes straight through.
 *
 * @throws when auto is asked for but no OpenRouter key is usable.
 */
export async function resolveForUser(userId, wantId) {
  if (!isAuto(wantId)) return resolveModelId(wantId);
  const picked = await pickAutoModel(userId);
  if (!picked) throw new Error(NO_AUTO_MESSAGE);
  return picked;
}
