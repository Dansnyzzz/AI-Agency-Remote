/**
 * Key-fallback suite — the decisions, with no network in sight.
 *
 * `classify` and the cooldown registry are the whole of the judgement: which
 * failures are worth another key, which are worth waiting for, and which are
 * worth reporting immediately. They are pure enough to test directly, which is
 * the point of having pulled them out of the streaming loop.
 *
 * The reason this file exists: a key that died mid-answer ended the turn, and
 * the only way on was for somebody to type "continue" — which worked purely
 * because it started a fresh request where the failure landed before the first
 * token. Nothing tested the middle of an answer, so nothing noticed.
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

  // Some providers say it in prose and attach no status at all.
  check(
    'an invalid key by message alone',
    classify(new Error('Incorrect API key provided')).kind === 'KEY_DEAD',
  );
  // A bare "quota" is a limit until proven otherwise: resting a key for a
  // minute is recoverable, condemning it for the life of the process is not.
  check(
    'a bare quota message rests the key rather than condemning it',
    classify(new Error('Your quota has been exceeded')).kind === 'RATE_LIMITED',
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
