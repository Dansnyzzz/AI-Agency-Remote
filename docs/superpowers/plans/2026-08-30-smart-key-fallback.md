# Smart Key Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A key that is rate limited, dead, or dies mid-answer is handled by the system instead of by the user typing "continue".

**Architecture:** Replace the binary `keyExhausted()` with a four-way `classify()` that reads `Retry-After` / `X-RateLimit-Reset`; add a per-key cooldown registry to `settings.js` so a key known to be resting is never re-probed; replace the binary `streamed` flag with per-kind counters so a failure before any prose rotates invisibly; and add one `retry` event, used by every provider, that discards partial prose before restarting.

**Tech Stack:** Node 20 ESM, no new dependencies. Hand-rolled test harness (`node test/*.test.mjs`, `section()` / `check()` helpers).

## Global Constraints

- **No new dependencies.** Everything here is standard library.
- **`getApiKeys()` keeps returning an array.** `server/models.js:346` destructures it (`const [key] = await getApiKeys(...)`) and `getApiKey()` wraps it. Adding a return-shape change breaks both.
- **Never re-probe a key known to be resting.** A failed request still counts against OpenRouter's daily quota, so probing costs real budget to confirm what is already known.
- **Longest wait held inside one request: 60s** (`MAX_WAIT_MS`). Anything longer is a cooldown to record and report, not a wait to sit through.
- **Prefill is not available.** Assistant prefill returns HTTP 400 on `claude-opus-5`, `claude-sonnet-5` and `claude-opus-4-8` — all three Anthropic models in `server/providers/catalog.js`. Mid-stream resumption is discard-and-restart for every provider; there is no second path.
- **British-English prose comments explaining *why*,** matching the surrounding files. Identifiers and log text in English.
- **`npm run check` must pass** (lint + full test chain + sandbox + hooks).

---

### Task 1: Classify a provider failure

**Files:**
- Modify: `server/providers/index.js:60-76` (replace `keyExhausted`)
- Modify: `server/providers/index.js:152` (`__testing` export)
- Create: `test/fallback.test.mjs`
- Modify: `package.json` (add `test:fallback`, add to the `test` chain)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `classify(error) → { kind, retryAfterMs }` where `kind` is `'RATE_LIMITED' | 'KEY_DEAD' | 'UPSTREAM' | 'FATAL'` and `retryAfterMs` is a positive integer or `null`.
  - `headerOf(error, name) → string | null`
  - `waitFrom(error, now?) → number | null` (true milliseconds, unclamped)
  - All four exported on `__testing`.

- [ ] **Step 1: Write the failing test**

Create `test/fallback.test.mjs`:

```js
/**
 * Key-fallback suite — the decisions, with no network in sight.
 *
 * `classify` and the cooldown registry are the whole of the judgement: which
 * failures are worth another key, which are worth waiting for, and which are
 * worth reporting immediately. They are pure enough to test directly, which is
 * the point of having pulled them out of the streaming loop.
 *
 *   node test/fallback.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'fallback-test-encryption-key';
process.env.SESSION_SECRET ||= 'fallback-test-session-secret';

const { __testing } = await import('../server/providers/index.js');
const { classify, waitFrom, headerOf } = __testing;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/** An SDK error, near enough: the shape both SDKs actually throw. */
const err = (status, message = '', headers = null) =>
  Object.assign(new Error(message), { status, headers });

section('a failure is graded by what it says about the key');
{
  check('429 is a wait, not a dead key', classify(err(429, 'Rate limit exceeded')).kind === 'RATE_LIMITED');
  check('401 is a dead key', classify(err(401, 'Invalid API key')).kind === 'KEY_DEAD');
  check('402 is a dead key', classify(err(402, 'Insufficient credits')).kind === 'KEY_DEAD');
  check('403 is a dead key', classify(err(403, 'Forbidden')).kind === 'KEY_DEAD');
  check('503 is the provider, not the key', classify(err(503, 'Service unavailable')).kind === 'UPSTREAM');
  check('a socket hang up is upstream', classify(err(0, 'socket hang up')).kind === 'UPSTREAM');
  check('400 is fatal on every key', classify(err(400, 'messages: invalid role')).kind === 'FATAL');
  check('an unknown model is fatal', classify(err(404, 'model not found')).kind === 'FATAL');

  // The old code read 429 and 402 as the same thing. They are not: one wants a
  // few seconds, the other wants a different key, and treating a rate limit as
  // a dead key is what sent a single-key account straight to a hard failure.
  check(
    'a rate limit and an empty wallet are graded differently',
    classify(err(429)).kind !== classify(err(402)).kind,
  );

  // "quota" appears in plenty of 429 messages, so status has to win over the
  // wording, or every rate limit is misread as a spent key.
  check(
    'wording does not override the status',
    classify(err(429, 'You have exceeded your quota')).kind === 'RATE_LIMITED',
  );
}

section('how long to wait comes from the provider, not from a guess');
{
  check('Retry-After in seconds', waitFrom(err(429, '', { 'retry-after': '20' })) === 20_000);
  check('Retry-After is case-insensitive', waitFrom(err(429, '', { 'Retry-After': '5' })) === 5_000);

  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  check(
    'Retry-After as an HTTP date',
    waitFrom(err(429, '', { 'retry-after': new Date(now + 30_000).toUTCString() }), now) === 30_000,
  );

  // OpenRouter sends epoch milliseconds; others send epoch seconds, and some
  // send a plain duration. Magnitude tells them apart, because the header name
  // does not.
  check(
    'X-RateLimit-Reset as epoch milliseconds',
    waitFrom(err(429, '', { 'x-ratelimit-reset': String(now + 45_000) }), now) === 45_000,
  );
  check(
    'X-RateLimit-Reset as epoch seconds',
    waitFrom(err(429, '', { 'x-ratelimit-reset': String((now + 60_000) / 1000) }), now) === 60_000,
  );
  check(
    'X-RateLimit-Reset as a plain duration',
    waitFrom(err(429, '', { 'x-ratelimit-reset': '15' }), now) === 15_000,
  );

  check('nothing said means nothing known', waitFrom(err(429)) === null);

  // A daily cap resets hours away. Reporting it honestly is the job; holding
  // the request open until midnight is not.
  const tomorrow = waitFrom(err(429, '', { 'x-ratelimit-reset': String(now + 8 * 3600_000) }), now);
  check('a daily cap is reported in full, not clamped', tomorrow === 8 * 3600_000, String(tomorrow));
}

section('a Headers object reads the same as a plain object');
{
  const bag = new Headers({ 'retry-after': '7' });
  check('Headers instance', headerOf(err(429, '', bag), 'retry-after') === '7');
  check('plain object', headerOf(err(429, '', { 'retry-after': '7' }), 'retry-after') === '7');
  check('absent header', headerOf(err(429, '', {}), 'retry-after') === null);
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll fallback checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/fallback.test.mjs`
Expected: FAIL — `classify is not a function` (`__testing` currently exports only `keyExhausted` and `outputBudget`).

- [ ] **Step 3: Write minimal implementation**

In `server/providers/index.js`, replace the `keyExhausted` function (lines 60-76) with:

```js
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

const DEAD_KEY = /invalid[ _-]?api[ _-]?key|incorrect api key|unauthorized|no such key|out of credit|insufficient|billing/;
const TRANSIENT = /timeout|timed out|econnreset|econnrefused|socket hang up|fetch failed|network|aborted by the server/;

/**
 * What a failure says about the key that produced it.
 *
 * The old version of this answered one question — "would another key have done
 * better?" — and answered it the same way for a rate limit as for an empty
 * wallet. They are not the same. A 429 usually wants a few seconds and the
 * *same* key; a 402 wants a different key and will never want that one again.
 * Grading them alike is what turned a momentary limit on a single-key account
 * into a hard failure with nothing to fall back to.
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
  if (status === 429 || (!status && /rate limit|too many requests/.test(message))) {
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
```

Then change the `__testing` export on the last line of the file from:

```js
export const __testing = { keyExhausted, outputBudget };
```

to:

```js
/** Exposed for the suite that pins which failures are worth another key. */
export const __testing = { classify, waitFrom, headerOf, outputBudget };
```

At this point `streamCompletion` still calls `keyExhausted`, which no longer exists — leave that broken; Task 3 rewrites the loop. To keep the tree runnable between commits, temporarily add above `streamCompletion`:

```js
// Bridged until the rotation loop below is rewritten in terms of `classify`.
const keyExhausted = (error) => classify(error).kind !== 'FATAL';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/fallback.test.mjs`
Expected: PASS — "All fallback checks passed."

Then run the existing suite to confirm the bridge holds: `npm test`
Expected: PASS.

- [ ] **Step 5: Add the suite to the test chain**

In `package.json`, add to `scripts`:

```json
"test:fallback": "node test/fallback.test.mjs",
```

and insert `node test/fallback.test.mjs && ` into the `test` script, immediately after `node test/schema.test.mjs && `.

Run: `npm test`
Expected: PASS, and `fallback` checks appear in the output.

- [ ] **Step 6: Commit**

```bash
git add server/providers/index.js test/fallback.test.mjs package.json
git commit -m "Grade a provider failure instead of asking one yes-or-no question"
```

---

### Task 2: A cooldown registry, so a resting key is never re-probed

**Files:**
- Modify: `server/settings.js:164-207` (beside `cursor`, inside `getApiKeys`)
- Modify: `test/fallback.test.mjs` (append a section)

**Interfaces:**
- Consumes: `classify()` from Task 1 (only conceptually — no import).
- Produces, all exported from `server/settings.js`:
  - `markKeyLimited(userId, provider, index, untilMs) → void`
  - `markKeyDead(userId, provider, index) → void`
  - `keyRestingUntil(userId, provider) → number | null` — soonest reset across all resting keys, or `null` if none are resting.
  - `clearKeyRest(userId, provider) → void` — used by the existing `setApiKey` / `addApiKey` paths.
  - `getApiKeys(userId, provider, options?)` — `options.includeResting` (default `false`) returns the full list regardless of cooldown. Return shape is unchanged: `[{ key, index, shared }]`.

- [ ] **Step 1: Write the failing test**

Append to `test/fallback.test.mjs`, before the final `console.log`:

```js
section('a key known to be resting is not probed again');
{
  const settings = await import('../server/settings.js');
  const { markKeyLimited, markKeyDead, keyRestingUntil, clearKeyRest, __testing: keys } = settings;
  const { isResting } = keys;

  const uid = 'u-rest';
  clearKeyRest(uid, 'openrouter');

  check('nothing is resting to begin with', keyRestingUntil(uid, 'openrouter') === null);

  const until = Date.now() + 30_000;
  markKeyLimited(uid, 'openrouter', 0, until);
  check('a limited key is resting', isResting(uid, 'openrouter', 0) === true);
  check('its neighbour is not', isResting(uid, 'openrouter', 1) === false);
  check('the soonest reset is reported', keyRestingUntil(uid, 'openrouter') === until);

  // The whole point: the second key rests longer, but the caller is told about
  // the one that frees up first, because that is when work can resume.
  markKeyLimited(uid, 'openrouter', 1, until + 60_000);
  check('the soonest of several is reported', keyRestingUntil(uid, 'openrouter') === until);

  // A cooldown in the past is over. Nothing sweeps it; it simply stops counting.
  markKeyLimited(uid, 'openrouter', 2, Date.now() - 1000);
  check('an elapsed cooldown has lifted', isResting(uid, 'openrouter', 2) === false);

  // A dead key never comes back on its own — no reset time can be right for
  // "this key is invalid", so it rests until the process restarts or the key
  // is edited.
  markKeyDead(uid, 'openrouter', 3);
  check('a dead key stays down', isResting(uid, 'openrouter', 3) === true);
  check('a dead key sets no reset time', keyRestingUntil(uid, 'openrouter') === until);

  clearKeyRest(uid, 'openrouter');
  check('editing the keys clears the slate', isResting(uid, 'openrouter', 0) === false);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/fallback.test.mjs`
Expected: FAIL — `markKeyLimited is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/settings.js`, immediately after the `rememberWorkingKey` function (line 179), insert:

```js
/**
 * Which keys are resting, and until when.
 *
 * Separate from `cursor` because it answers a different question. The cursor is
 * an optimisation — where to *start* — and being wrong costs one request. This
 * is a fact worth acting on: a key that returned 429 with a reset an hour away
 * will return 429 again if asked, and on OpenRouter a failed request still
 * counts against the daily allowance. Probing it is not a free way to check;
 * it is paying budget to be told what we already know.
 *
 * `Infinity` means dead rather than resting: no reset time is right for "this
 * key is invalid", so it stays down until the process restarts or somebody
 * edits the keys.
 *
 * In memory, like `cursor`, and for the same reason — on a serverless instance
 * it is a hint that fails safe. The worst a cold start costs is one probe.
 */
const resting = new Map();

const restKey = (userId, provider, index) => `${userId}:${provider}:${index}`;

/** This key returned a rate limit; leave it alone until `untilMs`. */
export function markKeyLimited(userId, provider, index, untilMs) {
  const until = Number(untilMs);
  if (!Number.isFinite(until)) return;
  resting.set(restKey(userId, provider, index), until);
}

/** This key is invalid or spent. It does not come back on a timer. */
export function markKeyDead(userId, provider, index) {
  resting.set(restKey(userId, provider, index), Infinity);
}

/** Whether this key is currently resting. An elapsed cooldown has lifted. */
function isResting(userId, provider, index) {
  const until = resting.get(restKey(userId, provider, index));
  if (until == null) return false;
  if (until === Infinity) return true;
  if (until > Date.now()) return true;
  resting.delete(restKey(userId, provider, index));
  return false;
}

/**
 * When the first resting key frees up, or null if none is on a timer.
 *
 * Dead keys are deliberately not counted: they have no reset, and reporting
 * `Infinity` as "try again at" would be a lie with a timestamp on it.
 */
export function keyRestingUntil(userId, provider) {
  const prefix = `${userId}:${provider}:`;
  let soonest = null;
  for (const [key, until] of resting) {
    if (!key.startsWith(prefix) || until === Infinity) continue;
    if (until <= Date.now()) continue;
    if (soonest == null || until < soonest) soonest = until;
  }
  return soonest;
}

/** Forget everything about this account's keys for a provider. */
export function clearKeyRest(userId, provider) {
  const prefix = `${userId}:${provider}:`;
  for (const key of [...resting.keys()]) {
    if (key.startsWith(prefix)) resting.delete(key);
  }
}
```

Change the `getApiKeys` signature and body (currently lines 191-207) to skip resting keys:

```js
export async function getApiKeys(userId, provider, { includeResting = false } = {}) {
  const list = keyList(await storedKeys(userId), provider);

  const own = [];
  list.forEach((entry, index) => {
    const decrypted = decryptSecret(entry.cipher);
    if (!decrypted) return;
    // A key we already know is rate limited or dead is worse than useless: on
    // OpenRouter the failed request it would earn still counts against the
    // day's allowance. `includeResting` exists so the caller can tell "no keys
    // at all" apart from "none free just now" and say the right thing.
    if (!includeResting && isResting(userId, provider, index)) return;
    own.push({ key: decrypted, index, shared: false });
  });

  const start = cursor.get(cursorKey(userId, provider)) || 0;
  const from = own.findIndex((entry) => entry.index === start);
  const ordered = from > 0 ? [...own.slice(from), ...own.slice(0, from)] : own;

  const environment = process.env[ENV_KEYS[provider]];
  if (environment && (includeResting || !isResting(userId, provider, -1))) {
    ordered.push({ key: environment, index: -1, shared: true });
  }
  return ordered;
}
```

Add `isResting` to a testing export at the end of `server/settings.js`:

```js
/** Exposed for the suite that pins when a key is left alone. */
export const __testing = { isResting };
```

If `server/settings.js` already exports `__testing`, add `isResting` to the existing object rather than declaring a second one.

Finally, clear the rest state wherever the cursor is already cleared — `setApiKey` (line 235) and the sibling at line 270 both call `cursor.delete(cursorKey(userId, provider))`. Add on the line after each:

```js
  clearKeyRest(userId, provider);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/fallback.test.mjs`
Expected: PASS.

Run: `npm test`
Expected: PASS — `getApiKeys` gained an optional parameter, so existing callers are unaffected.

- [ ] **Step 5: Commit**

```bash
git add server/settings.js test/fallback.test.mjs
git commit -m "Stop paying a request to rediscover a key that is still resting"
```

---

### Task 3: Rotate on what was actually emitted, and wait when waiting is the answer

**Files:**
- Modify: `server/providers/index.js:78-152` (the whole of `streamCompletion` and the bridge from Task 1)
- Modify: `test/fallback.test.mjs` (append a section)

**Interfaces:**
- Consumes: `classify` (Task 1); `markKeyLimited`, `markKeyDead`, `keyRestingUntil`, `getApiKeys` (Task 2).
- Produces:
  - `streamCompletion(opts)` — unchanged signature. New optional `opts.streamOne` for tests, defaulting to the real dispatcher, and new optional `opts.sleep` defaulting to a real timer.
  - A new event: `{ type: 'retry', reason }` yielded before any restart that discards prose already sent.
  - `__testing.rotate` is **not** added; the loop is tested through `streamCompletion` with `streamOne` and `sleep` injected, following the pattern `runOne` in `server/subagents.js` already uses.

- [ ] **Step 1: Write the failing test**

Append to `test/fallback.test.mjs`, before the final `console.log`:

```js
section('the rotation reacts to what actually came out');
{
  const { streamCompletion } = await import('../server/providers/index.js');
  const { setApiKey, addApiKey, clearKeyRest } = await import('../server/settings.js');

  const uid = 'u-rot';
  const entry = { provider: 'openrouter', model: 'x/y:free', context: 128_000, maxOutput: 4096 };

  await setApiKey(uid, 'openrouter', 'key-one');
  await addApiKey(uid, 'openrouter', 'key-two');

  /** Drive the loop with scripted outcomes, one per key it reaches for. */
  const drive = async (script) => {
    clearKeyRest(uid, 'openrouter');
    const seen = [];
    const events = [];
    const streamOne = async function* (_entry, common) {
      const step = script[seen.length];
      seen.push(common.apiKey);
      for (const event of step.emit || []) yield event;
      if (step.throw) throw step.throw;
    };
    let error = null;
    try {
      for await (const event of streamCompletion({
        userId: uid, entry, messages: [], streamOne, sleep: async () => {},
      })) {
        events.push(event);
      }
    } catch (err) {
      error = err;
    }
    return { seen, events, error };
  };

  // Nothing was shown, so nothing is lost: the second key picks the turn up and
  // the user never learns there was a first.
  {
    const run = await drive([
      { throw: err(429, 'Rate limit') },
      { emit: [{ type: 'text', delta: 'hello' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('a limit before any output rotates', run.seen.length === 2, run.seen.join(','));
    check('and the answer arrives', run.events.some((e) => e.type === 'text' && e.delta === 'hello'));
    check('with no retry event, because nothing was discarded', !run.events.some((e) => e.type === 'retry'));
    check('and no error', run.error === null, String(run.error?.message || ''));
  }

  // Thinking is not the answer. Replaying it costs nothing a reader can see,
  // so it must not pin the turn to a key that has already failed.
  {
    const run = await drive([
      { emit: [{ type: 'thinking', delta: 'hmm' }], throw: err(429, 'Rate limit') },
      { emit: [{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('thinking alone does not pin the turn to a dead key', run.seen.length === 2);
    check('no prose was discarded, so no retry event', !run.events.some((e) => e.type === 'retry'));
  }

  // This is the case that used to end the turn and make somebody type
  // "continue". Prose was on screen, so the restart has to say so.
  {
    const run = await drive([
      { emit: [{ type: 'text', delta: 'half a sen' }], throw: err(429, 'Rate limit') },
      { emit: [{ type: 'text', delta: 'a whole answer' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('a limit mid-answer still rotates', run.seen.length === 2);
    check('and announces the discard', run.events.some((e) => e.type === 'retry'));
    check(
      'the retry is announced before the replacement text',
      run.events.findIndex((e) => e.type === 'retry') <
        run.events.findLastIndex((e) => e.type === 'text'),
    );
  }

  // A broken request is broken on every key. Walking the rest turns one clear
  // error into several slow ones.
  {
    const run = await drive([{ throw: err(400, 'messages: invalid role') }]);
    check('a fatal error burns exactly one key', run.seen.length === 1);
    check('and is reported', run.error !== null);
  }

  // One key, momentarily limited, is the ordinary free-tier situation. Waiting
  // is the whole answer, and used to be the one thing the code could not do.
  {
    await setApiKey(uid, 'openrouter', 'only-key');
    const run = await drive([
      { throw: err(429, 'Rate limit', { 'retry-after': '1' }) },
      { emit: [{ type: 'text', delta: 'worth the wait' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('a single key waits rather than failing', run.error === null, String(run.error?.message || ''));
    check('and answers on the second attempt', run.seen.length === 2);
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/fallback.test.mjs`
Expected: FAIL — the injected `streamOne` is ignored, so the loop tries a real network call.

- [ ] **Step 3: Write minimal implementation**

In `server/providers/index.js`, delete the temporary `keyExhausted` bridge added in Task 1, and replace the whole of `streamCompletion` with:

```js
/** Wait, but give up the moment the caller does. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How long to pause before trying a stumbling provider again. */
const backoff = (attempt) => Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

const UPSTREAM_TRIES = 3;
const ROUNDS = 2;

/**
 * One streaming interface over every provider, and every key they have.
 *
 * An account can hold several keys per provider, and they are tried in order
 * until one answers. That is the whole point of holding more than one: a key
 * that runs out at eleven should cost a moment, not the rest of the day.
 *
 * Three things decide what happens when one fails, and they are separate
 * questions that the previous version ran together:
 *
 * **What kind of failure was it** — `classify`. A rate limit wants time, a dead
 * key wants a different key, a 500 wants the same key a moment later, and a
 * malformed request wants reporting rather than four more attempts.
 *
 * **What had already come out** — a failure before the first word of prose can
 * be retried invisibly, and most can: the model was still thinking, or still
 * announcing a tool call. Only prose the user has actually read makes a restart
 * visible, and then it is announced with a `retry` event so the half-sentence
 * is cleared rather than being written over or grown a duplicate. Resuming
 * instead of restarting would be better still, and is not available: assistant
 * prefill returns 400 on every Anthropic model in the catalogue, and is honoured
 * inconsistently behind OpenRouter. One predictable path beats two that differ
 * by provider.
 *
 * **Whether anything else could work** — a key known to be resting is skipped
 * rather than probed, because on OpenRouter a failed request still spends the
 * day's allowance. When every key is resting and the soonest is close, waiting
 * is the answer; when it is hours away, saying so is.
 *
 * Yields: {type:'text'|'thinking', delta} · {type:'tool_call_start', id, name}
 *       · {type:'notice', text} · {type:'retry', reason}
 *       · {type:'done', stopReason, toolCalls, usage, raw?}
 */
export async function* streamCompletion(opts) {
  const entry = opts.entry;
  const label = PROVIDERS[entry.provider]?.label || entry.provider;
  const provider = entry.provider;
  const { userId, signal } = opts;
  const dispatch = opts.streamOne || streamOne;
  const wait = opts.sleep || pause;

  let refused = null;

  for (let round = 0; round < ROUNDS; round += 1) {
    const keys = await getApiKeys(userId, provider);

    if (!keys.length) {
      // Nothing usable. Whether that is a missing key or a resting one changes
      // what there is to say, and a wrong answer here sends somebody to Settings
      // to fix a key that was never broken.
      const all = await getApiKeys(userId, provider, { includeResting: true });
      if (!all.length) throw new Error(`No API key for ${label}. Add one in Settings → Providers.`);

      const until = keyRestingUntil(userId, provider);
      const left = until == null ? null : until - Date.now();
      if (left != null && left <= MAX_WAIT_MS && round < ROUNDS - 1) {
        yield { type: 'notice', text: `${label}: every key is rate limited. Waiting ${Math.ceil(left / 1000)}s.` };
        await wait(left, signal);
        continue;
      }
      throw new Error(
        until
          ? `${label}: every key is rate limited until ${new Date(until).toLocaleTimeString()}.`
          : `${label}: every key was refused${refused ? ` (${refused})` : ''}.`,
      );
    }

    for (const { key, index, shared } of keys) {
      const which = shared ? 'the deployment key' : `key ${index + 1}`;
      const common = {
        ...opts,
        apiKey: key,
        model: entry.model,
        entry,
        baseURL: baseUrlFor(entry.provider),
        maxTokens: opts.maxTokens ?? outputBudget(entry),
      };

      for (let attempt = 0; attempt < UPSTREAM_TRIES; attempt += 1) {
        // Counted rather than flagged. "Something came out" lumps a discarded
        // thinking delta in with a paragraph somebody is reading, and only one
        // of those makes a restart visible.
        const emitted = { text: 0, thinking: 0, toolCalls: 0 };
        let failure = null;

        try {
          for await (const event of dispatch(entry, common)) {
            if (event.type === 'text') emitted.text += 1;
            else if (event.type === 'thinking') emitted.thinking += 1;
            else if (event.type === 'tool_call_start') emitted.toolCalls += 1;
            yield event;
          }
          if (!shared) rememberWorkingKey(userId, provider, index);
          return;
        } catch (err) {
          failure = err;
        }

        const { kind, retryAfterMs } = classify(failure);
        if (kind === 'FATAL') throw failure;

        refused = `${which} was refused: ${failure.message}`;

        // Same key, in a moment — the provider stumbled rather than the key
        // being wrong. Only while nothing has been read: a retry that replaces
        // prose has to be announced, and this branch is the silent one.
        if (kind === 'UPSTREAM' && attempt < UPSTREAM_TRIES - 1 && !emitted.text) {
          await wait(retryAfterMs ?? backoff(attempt), signal);
          continue;
        }

        if (kind === 'RATE_LIMITED') {
          markKeyLimited(userId, provider, index, Date.now() + (retryAfterMs ?? 60_000));
        } else if (kind === 'KEY_DEAD') {
          markKeyDead(userId, provider, index);
        }

        // Said out loud rather than swallowed: a fallback that nobody can see is
        // indistinguishable from the first key having worked, right up until the
        // bill or the outage says otherwise.
        yield { type: 'notice', text: `${label}: ${which} was refused, trying the next one.` };
        if (emitted.text) {
          yield { type: 'retry', reason: `${label}: ${which} stopped mid-answer; starting that reply again.` };
        }
        break;
      }
    }
  }

  throw new Error(`${label}: every key was refused${refused ? ` (${refused})` : ''}.`);
}
```

Update the import at the top of the file (line 4) to pull in the new helpers:

```js
import {
  getApiKeys,
  baseUrlFor,
  rememberWorkingKey,
  markKeyLimited,
  markKeyDead,
  keyRestingUntil,
} from '../settings.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/fallback.test.mjs`
Expected: PASS.

Run: `npm test`
Expected: PASS.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/providers/index.js test/fallback.test.mjs
git commit -m "Carry a turn across keys instead of ending it where one key stopped"
```

---

### Task 4: Clear the half-sentence when a turn restarts

**Files:**
- Modify: `server/agent.js:624-640` (the event switch)
- Modify: `public/js/render.js:587-598` (beside `appendText`)
- Modify: `public/js/app.js:1644-1650` (beside the `text` handler)

**Interfaces:**
- Consumes: the `{ type: 'retry', reason }` event from Task 3.
- Produces: no new module exports. The assistant turn gains `resetText()`, and the SSE stream gains a `retry` event carrying `{ reason }`. The client dispatcher is `handlers[event]?.(payload)` (`public/js/api.js:277`), so no transport change is needed.

- [ ] **Step 1: Write the failing test**

There is no DOM in the harness, so this task is pinned at the server boundary — that the agent loop forwards the event and forgets the discarded text, which is the part that would otherwise be persisted and shown twice. Append to `test/fallback.test.mjs`, before the final `console.log`:

```js
section('a restart clears the text the reader had already seen');
{
  const { __testing: agentTesting } = await import('../server/agent.js');
  const { applyStreamEvent } = agentTesting;

  const assistant = { id: 'a1', role: 'assistant', text: '', toolCalls: [] };
  const sent = [];
  const emit = (event, data) => sent.push([event, data]);

  applyStreamEvent({ type: 'text', delta: 'half a sen' }, assistant, emit);
  check('text accumulates', assistant.text === 'half a sen');

  applyStreamEvent({ type: 'retry', reason: 'key 1 stopped' }, assistant, emit);
  check('a retry empties the draft', assistant.text === '');
  check('and tells the browser', sent.some(([event]) => event === 'retry'));

  applyStreamEvent({ type: 'text', delta: 'a whole answer' }, assistant, emit);
  check('the replacement stands alone', assistant.text === 'a whole answer');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/fallback.test.mjs`
Expected: FAIL — `applyStreamEvent is not a function`.

- [ ] **Step 3: Write minimal implementation**

**`server/agent.js`** — the loop at line 624 currently reads:

```js
        if (ev.type === 'text') {
```

Lift that chain into a named function so it can be tested without a provider. Immediately above `export async function runAgent`, add:

```js
/**
 * Fold one stream event into the assistant turn being built.
 *
 * Pulled out of the loop so the `retry` case can be tested without standing up
 * a provider: it is the one event that *removes* something, and a draft that
 * kept its discarded half would be persisted and then shown twice.
 */
export function applyStreamEvent(ev, assistant, emit) {
  if (ev.type === 'text') {
    assistant.text += ev.delta ?? '';
    emit('text', { delta: ev.delta });
  } else if (ev.type === 'retry') {
    // The provider is starting this reply again on another key. Everything sent
    // so far is being replaced, not continued.
    assistant.text = '';
    emit('retry', { reason: ev.reason || '' });
  }
  return ev;
}
```

Then, inside `runAgent`, replace the `if (ev.type === 'text') { ... }` branch and add a `retry` branch by delegating both to the helper. The existing chain becomes:

```js
        if (ev.type === 'text' || ev.type === 'retry') {
          applyStreamEvent(ev, assistant, emit);
        } else if (ev.type === 'thinking') {
```

Leave the `thinking`, `tool_call_start`, `notice` and `done` branches exactly as they are.

Add `applyStreamEvent` to the `__testing` export at the end of `server/agent.js`. If the file has no `__testing` export, add one:

```js
/** Exposed for the suite that pins how a restart is folded into a turn. */
export const __testing = { applyStreamEvent };
```

**`public/js/render.js`** — beside `appendText` (after line 598), add to the `api` object:

```js
    /**
     * Throw away the prose written so far.
     *
     * A provider restarting a reply on another key is replacing it, not
     * continuing it. Growing a duplicate would be the quiet kind of wrong: the
     * reader has no way to tell a repeated paragraph from an intended one.
     */
    resetText() {
      rawText = '';
      if (prose) {
        prose.remove();
        prose = null;
      }
    },
```

**`public/js/app.js`** — beside the `text` handler (after line 1650), add:

```js
        retry: ({ reason }) => {
          const turn = nextBlock();
          turn.resetText();
          if (reason) toast(reason);
          setStatus('Starting that reply again…');
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/fallback.test.mjs`
Expected: PASS.

Run: `npm run check`
Expected: PASS — lint, every suite, sandbox and hooks.

- [ ] **Step 5: Commit**

```bash
git add server/agent.js public/js/render.js public/js/app.js test/fallback.test.mjs
git commit -m "Clear the half-sentence a restart replaces, rather than growing a duplicate"
```

---

### Task 5: Say what changed

**Files:**
- Modify: `README.md` (the "Spare API keys" row of the capability table)

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-4.
- Produces: nothing code depends on.

- [ ] **Step 1: Update the row**

`README.md` currently says:

```
| **Spare API keys** | Several keys per provider, tried in order. One running out mid-afternoon costs a moment rather than the rest of the day. |
```

Replace with:

```
| **Spare API keys** | Several keys per provider, tried in order — including mid-answer, which is when a free-tier key usually goes. A rate limit is waited out rather than mistaken for a dead key, a key known to be resting is skipped rather than re-probed, and when every key is limited you are told when the first one frees up. |
```

- [ ] **Step 2: Check nothing else has drifted**

Run: `grep -n "continue" README.md | grep -i "key\|limit\|quota"`
Expected: no line telling the reader to send "continue" to move to the next key. If one exists, remove it — it is now describing behaviour that no longer happens.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Say that spare keys now cover the middle of an answer"
```

---

## Self-Review

**Spec coverage.** Every section of `docs/superpowers/specs/2026-08-30-smart-fallback-and-deep-research-design.md` part A maps to a task: the four-way grading and the header reading to Task 1; the cooldown registry and the "no keys at all" versus "none free just now" distinction to Task 2; the `emitted` counters, the wait-and-retry ladder, the notices and the honest exhausted-message to Task 3; the single discard-and-restart path to Tasks 3 and 4; documentation to Task 5. The spec's model-swap axis is deliberately absent — it was removed from the spec because a free-tier limit follows the key, not the model.

**Known gap, stated rather than hidden.** The spec's test list includes "a key that is resting costs no extra request". Task 2 pins that at the registry level (`getApiKeys` does not return a resting key), which is where the decision is made, but no test counts HTTP requests end to end — the suite has no provider to count against. That is a real limit of testing this without a network, not an oversight.

**Trade-off carried from the spec.** When prose has already been read and the retry also fails, the reader ends with an error and no partial text, where today they would keep the partial. That is deliberate: a half-answer that reads like a whole one is the more dangerous of the two failures. Task 3 only emits `retry` when another attempt genuinely follows, so the text is never discarded for nothing.
