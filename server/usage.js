import crypto from 'node:crypto';
import { getStore } from './store/index.js';

/**
 * Per-account usage accounting.
 *
 * A limit is only meaningful when the account is spending someone else's money
 * — i.e. riding the deployment-wide key. Somebody using their own API key pays
 * their own provider directly, so capping them would be pointless paternalism.
 */
export function defaultTokenLimit() {
  const raw = Number(process.env.DEFAULT_MONTHLY_TOKEN_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function limitFor(user) {
  // An explicit 0 means "unlimited" and must not fall through to the default.
  if (user?.monthly_token_limit != null) {
    const own = Number(user.monthly_token_limit);
    return own > 0 ? own : null;
  }
  return defaultTokenLimit();
}

/**
 * @returns {{allowed: boolean, reason?: string, used: number, limit: number|null}}
 */
export async function checkQuota(user, { usingSharedKey, store = getStore() }) {
  const limit = limitFor(user);
  // One lookup, whichever branch is taken. It used to be written out twice, so
  // every allowed turn asked the database the same question a second time.
  const { tokens } = await store.usageThisMonth(user.id);

  if (!limit || !usingSharedKey) {
    return { allowed: true, used: tokens, limit: usingSharedKey ? limit : null };
  }
  if (tokens >= limit) {
    return {
      allowed: false,
      used: tokens,
      limit,
      reason:
        `You have used ${tokens.toLocaleString()} of your ${limit.toLocaleString()} shared tokens this month. ` +
        'Add your own API key in Settings → Providers to keep going without a limit.',
    };
  }
  return { allowed: true, used: tokens, limit };
}

/**
 * Book what a model call cost, whoever made it.
 *
 * `role` is the field that closes a real hole. This function had exactly two
 * callers — the agent loop and the sub-agent fan-out — so compaction, every
 * role of a deep_research run, and `web_extract`'s page reader all spent tokens
 * that appeared nowhere. On a deployment sharing one key that is not merely a
 * reporting gap: `checkQuota` enforces the monthly limit against the total in
 * this table, so an account could run research all day and never approach a cap
 * it was, on paper, subject to.
 *
 * Anything that calls a model passes its own role now, and the usage page can
 * finally say where the money went.
 */
export async function record(userId, { chatId, model, usage, costUsd, role = 'turn' }) {
  if (!usage) return;
  await getStore().recordUsage(userId, {
    id: crypto.randomUUID(),
    chatId,
    model,
    role,
    inputTokens: usage.input || 0,
    outputTokens: usage.output || 0,
    // A subset of inputTokens, not an addition to it — see estimateCost. Held
    // separately because the ratio between the two is the cache hit rate, which
    // there was previously no way to read at all.
    cacheReadTokens: usage.cacheRead || 0,
    costUsd: costUsd || 0,
  });
}

export async function summary(userId) {
  const store = getStore();
  const [month, byModel, byRole] = await Promise.all([
    store.usageThisMonth(userId),
    store.usageByModel(userId, 30),
    store.usageByRole(userId, 30),
  ]);
  // Cached input as a share of all input, which is the number to watch when
  // tuning what goes in the cached prefix and what does not.
  const cacheHitRate = month.tokens > 0 ? (month.cacheRead || 0) / month.tokens : 0;
  return { month: { ...month, cacheHitRate }, byModel, byRole };
}
