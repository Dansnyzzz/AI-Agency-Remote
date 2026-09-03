/**
 * The model-capability layer, with no network in sight.
 *
 * Three things every adapter used to throw away, now pulled into pure functions
 * that can be tested directly:
 *
 *   - why a reply stopped (`normaliseStop`) — the difference between a finished
 *     answer and one cut off, refused, or filtered, which the browser showed as
 *     identical right up until this existed;
 *   - what a turn's usage was worth, cached tokens and the provider's own
 *     invoice included (`readUsage` on each adapter, `priceTurn`);
 *   - that the effort dial reaches Gemini at all (`THINKING_LEVEL`).
 *
 *   node test/stop.test.mjs
 */
import { normaliseStop, refusalDetail, isComplete, STOP_KINDS } from '../server/providers/stop.js';
import { priceTurn, estimateCost } from '../server/providers/catalog.js';
import { __testing as openai } from '../server/providers/openaiCompatible.js';
import { __testing as google } from '../server/providers/google.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

section('a finished reply is told apart from a stopped one');
{
  check('end_turn is complete, and says nothing', isComplete('end_turn') && normaliseStop('end_turn').message === null);
  check('a bare stop (OpenAI) is complete', normaliseStop('stop').kind === 'end_turn');
  check('tool_use is complete — the loop just continues', isComplete('tool_use'));
  check('a stop_sequence is a finish, not a fault', isComplete('stop_sequence') && normaliseStop('stop_sequence').message === null);
  // The whole reason the layer exists: these three look like a finished answer
  // and are not.
  check('max_tokens is a truncation, and it is not complete', normaliseStop('max_tokens').kind === 'truncated' && !isComplete('truncated'));
  check('and it carries a sentence to show', /maximum output length/.test(normaliseStop('max_tokens').message || ''));
  check('a refusal is surfaced, not swallowed', normaliseStop('refusal').kind === 'refused' && !!normaliseStop('refusal').message);
  check('content_filter (OpenAI) is filtered', normaliseStop('content_filter').kind === 'filtered');
}

section('every provider spells these differently, and all are understood');
{
  // Gemini shouts.
  check('Gemini MAX_TOKENS is a truncation', normaliseStop('MAX_TOKENS').kind === 'truncated');
  check('Gemini SAFETY is filtered', normaliseStop('SAFETY').kind === 'filtered');
  check('Gemini RECITATION has its own kind', normaliseStop('RECITATION').kind === 'recitation');
  check('Gemini PROHIBITED_CONTENT is filtered', normaliseStop('PROHIBITED_CONTENT').kind === 'filtered');
  // OpenAI's older wording.
  check('OpenAI length is a truncation', normaliseStop('length').kind === 'truncated');
  check('OpenAI tool_calls is a tool turn', normaliseStop('tool_calls').kind === 'tool_use');
  // Case does not matter — these are enum values, not prose.
  check('matching ignores case', normaliseStop('Max_Tokens').kind === 'truncated');
}

section('an unrecognised reason is surfaced, never read as success');
{
  const weird = normaliseStop('some_new_reason_2027');
  check('an unknown reason becomes unknown, not end_turn', weird.kind === 'unknown');
  check('and it says so rather than staying silent', !!weird.message);
  // Silence is the one thing treated as a clean finish — several
  // OpenAI-compatible servers omit finish_reason on the final chunk.
  check('but a genuinely absent reason is a clean finish', normaliseStop('').kind === 'end_turn' && normaliseStop(undefined).kind === 'end_turn');
  check('every kind in the vocabulary is a known string', STOP_KINDS.length === new Set(STOP_KINDS).size);
}

section('a refusal category is passed through when the provider gives one');
{
  check('a non-refusal detail is nothing', refusalDetail({ type: 'other' }) === null && refusalDetail(null) === null);
  const detail = refusalDetail({ type: 'refusal', category: 'illicit', explanation: 'no can do' });
  check('the category and explanation both survive', /illicit/.test(detail) && /no can do/.test(detail));
  const carried = normaliseStop('refusal', detail);
  check('and they reach the sentence the user sees', /illicit/.test(carried.message) && /provider said/.test(carried.message));
}

section('cost prefers the provider’s invoice over our arithmetic');
{
  const priced = { price: { in: 3, out: 15 } };
  // OpenRouter and OrcaRouter put the real billed dollars on usage.cost.
  const real = priceTurn(priced, { input: 1000, output: 100, costUsd: 0.0042 });
  check('a stated cost is taken as the truth', real.usd === 0.0042 && real.source === 'provider');

  const worked = priceTurn(priced, { input: 1_000_000, output: 0 });
  check('with no stated cost, it is estimated from the table', worked.source === 'estimate' && worked.usd === 3);

  // The case the whole priceTurn change is for: a model the price table never
  // knew, that the provider nonetheless invoiced.
  const unknownButBilled = priceTurn({ price: null }, { input: 500, output: 20, costUsd: 0.0009 });
  check('an unpriced model still shows a cost when the provider gave one', unknownButBilled?.usd === 0.0009 && unknownButBilled.source === 'provider');
  check('and shows nothing when nobody knows', priceTurn({ price: null }, { input: 500 }) === null);

  // A zero from the provider is a real claim (a free model), not "unknown".
  check('a stated zero is honoured, not treated as missing', priceTurn({ price: null }, { input: 5, costUsd: 0 })?.usd === 0);
}

section('cached tokens are billed at the cached rate, not the full one');
{
  const entry = { price: { in: 10, out: 10 } };
  // 1000 input tokens, 900 of them read from cache at 0.1x.
  const withCache = estimateCost(entry, { input: 1000, output: 0, cacheRead: 900 });
  const noCache = estimateCost(entry, { input: 1000, output: 0 });
  check('a cached turn costs less than the same turn uncached', withCache < noCache);
  // 100 fresh @ full + 900 read @ 0.1 = 100 + 90 = 190 units.
  check('the cached portion is a tenth of the price', Math.abs(withCache - (190 / 1e6 * 10)) < 1e-12);
}

section('the OpenAI-shaped usage reader keeps cached and cost apart');
{
  const u = openai.readUsage({
    prompt_tokens: 1200,
    completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 50 },
    completion_tokens_details: { reasoning_tokens: 120 },
    cost: 0.0031,
  });
  check('input is the whole prompt', u.input === 1200);
  check('cached reads are a subset carried alongside', u.cacheRead === 1000);
  check('cache writes are separate — they cost more, not less', u.cacheWrite === 50);
  check('reasoning tokens are noted', u.reasoning === 120);
  check('the provider’s billed cost is carried', u.costUsd === 0.0031);
  // A free model reports cost:0 → treated as "not stated" so it does not read
  // as a definitive zero bill on a priced model. priceTurn handles a genuine
  // provider zero from usage.costUsd; the adapter only forwards a positive one.
  const free = openai.readUsage({ prompt_tokens: 10, completion_tokens: 2, cost: 0 });
  check('a zero cost is not forwarded as a bill', !('costUsd' in free));
  check('a usage block with no details does not throw', openai.readUsage({ prompt_tokens: 5, completion_tokens: 1 }).cacheRead === 0);
  check('a null usage block is null', openai.readUsage(null) === null);
}

section('the Gemini usage reader adds thoughts to output and keeps cache apart');
{
  const u = google.readUsage({
    promptTokenCount: 800,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 150,
    cachedContentTokenCount: 600,
  });
  check('input is the prompt count', u.input === 800);
  // thoughtsTokenCount is billed as output and is NOT inside candidatesTokenCount.
  check('output includes the thinking tokens', u.output === 350);
  check('cached content is a subset carried alongside', u.cacheRead === 600);
  check('reasoning is reported', u.reasoning === 150);
  check('a null metadata block is null', google.readUsage(null) === null);
}

section('the effort dial reaches Gemini');
{
  const { THINKING_LEVEL } = google;
  check('low maps to LOW', THINKING_LEVEL.low === 'LOW');
  check('high maps to HIGH', THINKING_LEVEL.high === 'HIGH');
  // Our scale has two rungs above Gemini's top one; both land on HIGH rather
  // than sending a value it would reject.
  check('xhigh and max both clamp to HIGH', THINKING_LEVEL.xhigh === 'HIGH' && THINKING_LEVEL.max === 'HIGH');
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll stop-reason checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
