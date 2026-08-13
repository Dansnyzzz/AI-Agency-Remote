/**
 * Searching the web, and having somewhere to fall back to.
 *
 * Every engine here is stubbed. The point is not whether Exa can find things —
 * it can, and a test that depended on the live internet would fail on a train —
 * but whether the chain behaves when one of them will not answer, which is the
 * case the chain exists for and the one nobody exercises by hand.
 *
 *   node test/search.test.mjs
 */

// Read before the module is imported: the pacing interval is fixed at load.
process.env.DDG_MIN_INTERVAL_MS = '300';
process.env.EXA_API_KEY = 'exa-test-key';
process.env.TAVILY_API_KEY = 'tavily-test-key';
process.env.BRAVE_API_KEY = 'brave-test-key';
delete process.env.SEARCH_ORDER;

const { search, formatResults, searchChain } = await import('../server/search.js');
const { __testing: providers } = await import('../server/providers/index.js');

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/**
 * Stand in for the network.
 *
 * `plan` maps a fragment of the URL to what that host should do this time, so a
 * test reads as "Exa is rate limited, DuckDuckGo is blocked, Tavily answers".
 */
const calls = [];
function stubFetch(plan) {
  calls.length = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, at: Date.now(), body: init?.body });
    for (const [fragment, respond] of Object.entries(plan)) {
      if (url.includes(fragment)) return respond();
    }
    throw new Error(`nothing stubbed for ${url}`);
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

const ddgPage = (n) =>
  Array.from({ length: n }, (_, i) => {
    const target = encodeURIComponent(`https://example.com/${i}`);
    return (
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=${target}">Result ${i}</a>` +
      `<a class="result__snippet">Snippet ${i}</a>`
    );
  }).join('');

// ── the order ───────────────────────────────────────────────────────
section('which engines, in which order');
{
  check('the default chain is Exa, DuckDuckGo, Tavily, Brave', searchChain().join(',') === 'exa,duckduckgo,tavily,brave', searchChain().join(','));

  process.env.SEARCH_ORDER = 'tavily, exa';
  check('the order can be overridden', searchChain().join(',') === 'tavily,exa', searchChain().join(','));
  delete process.env.SEARCH_ORDER;

  const key = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  check('an engine with no key is skipped', !searchChain().includes('exa'), searchChain().join(','));
  check('but the one that needs no key stays', searchChain().includes('duckduckgo'));
  process.env.EXA_API_KEY = key;
}

// ── the happy path ──────────────────────────────────────────────────
section('the first engine answers');
{
  stubFetch({
    'api.exa.ai': () =>
      json({
        results: [
          {
            title: 'Giá vàng hôm nay',
            url: 'https://example.com/gold',
            highlights: ['Vàng tăng 1%.', 'Chốt phiên ở 4,031 USD.'],
            publishedDate: '2026-08-04T00:00:00Z',
          },
        ],
      }),
  });

  const outcome = await search('giá vàng', { count: 5 });
  check('Exa answers', outcome.engine === 'Exa', outcome.engine);
  check('nothing else was called', calls.length === 1, `${calls.length} requests`);
  check('the highlights become the snippet', /Vàng tăng 1%\. … Chốt phiên/.test(outcome.results[0].snippet), outcome.results[0].snippet);
  check('the published date survives', outcome.results[0].published === '2026-08-04T00:00:00Z');

  const sent = JSON.parse(calls[0].body);
  check('asked for highlights, which is the point of Exa', sent.contents?.highlights === true, JSON.stringify(sent.contents));
  check('and for the documented default search type', sent.type === 'auto', sent.type);
  check('with the count it was given', sent.numResults === 5, String(sent.numResults));

  const text = formatResults('giá vàng', outcome);
  check('the answer says who found it', /results from Exa/.test(text), text.split('\n')[0]);
}

// ── the whole point ─────────────────────────────────────────────────
section('falling through to the next engine');
{
  stubFetch({
    // Out of credit — the exact case somebody keeps a second engine for.
    'api.exa.ai': () => json({ error: { detail: 'insufficient credits' } }, 402),
    // Rate limited, which DuckDuckGo serves as a cheerful 200.
    'duckduckgo.com': () => html('<html><body>Our systems have detected unusual traffic</body></html>'),
    'api.tavily.com': () =>
      json({ results: [{ title: 'Third time lucky', url: 'https://example.com/t', content: 'Found it.' }] }),
  });

  const outcome = await search('anything');
  check('the chain reaches the engine that works', outcome.engine === 'Tavily', outcome.engine);
  check('and records what the others said', outcome.attempts.length === 2, JSON.stringify(outcome.attempts));
  check(
    'in the provider\'s own words, not just a status code',
    /insufficient credits/.test(outcome.attempts[0].error),
    outcome.attempts[0].error,
  );
  check(
    'a rate-limit page is a failure, not an empty result',
    /rate-limit page/.test(outcome.attempts[1].error),
    outcome.attempts[1].error,
  );

  const text = formatResults('anything', outcome);
  check('and the failover is said out loud', /after Exa, DuckDuckGo failed/.test(text), text.split('\n')[0]);
}

section('every engine refusing is an answer too');
{
  stubFetch({
    'api.exa.ai': () => json({}, 500),
    'duckduckgo.com': () => html('nothing here'),
    'api.tavily.com': () => json({}, 500),
    'api.search.brave.com': () => json({ error: { detail: 'The provided subscription token is invalid.' } }, 422),
  });

  const outcome = await search('anything');
  check('no results rather than a thrown error', outcome.results.length === 0 && outcome.engine === null);
  const text = formatResults('anything', outcome);
  check('and the reply names every engine tried', /Exa.*DuckDuckGo.*Tavily.*Brave/s.test(text), text);
  check('with the reason for each', /subscription token is invalid/.test(text), text.slice(0, 200));
}

// ── being a good citizen ────────────────────────────────────────────
section('DuckDuckGo is paced');
{
  process.env.SEARCH_ORDER = 'duckduckgo';
  stubFetch({ 'duckduckgo.com': () => html(ddgPage(3)) });

  const started = Date.now();
  const [a, b, c] = await Promise.all([search('one'), search('two'), search('three')]);
  const elapsed = Date.now() - started;

  check('all three searches answer', [a, b, c].every((r) => r.results.length === 3));
  check(
    'but they went one at a time',
    elapsed >= 600,
    `${elapsed}ms for three at ${process.env.DDG_MIN_INTERVAL_MS}ms apart`,
  );
  const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at);
  check('with a gap between each', gaps.every((gap) => gap >= 250), gaps.join('ms, ') + 'ms');

  check('the redirect wrapper is unwrapped', a.results[0].url === 'https://example.com/0', a.results[0].url);
  check('and the snippet comes with it', a.results[0].snippet === 'Snippet 0', a.results[0].snippet);
  delete process.env.SEARCH_ORDER;
}

section('nothing configured at all');
{
  const saved = { ...process.env };
  delete process.env.EXA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  process.env.SEARCH_ORDER = 'exa,tavily';

  let error = null;
  await search('x').catch((err) => (error = err));
  check('says so rather than failing obscurely', error?.code === 'no_search_engine', error?.message);
  check('and names what to set', /EXA_API_KEY/.test(error?.message || ''), error?.message);

  process.env.EXA_API_KEY = saved.EXA_API_KEY;
  process.env.TAVILY_API_KEY = saved.TAVILY_API_KEY;
  process.env.BRAVE_API_KEY = saved.BRAVE_API_KEY;
  delete process.env.SEARCH_ORDER;
}

// ── which model failures deserve another key ────────────────────────
section('when a second API key would help');
{
  const worth = providers.keyExhausted;
  check('an unauthorised key', worth({ status: 401 }));
  check('one out of credit', worth({ status: 402 }));
  check('one being rate limited', worth({ status: 429 }));
  check('and one the provider names in prose', worth(new Error('Your quota has been exceeded')));
  check('and an invalid key by message alone', worth(new Error('Incorrect API key provided')));

  check('but not a model that does not exist', !worth({ status: 404 }));
  check('nor a malformed request', !worth({ status: 400, message: 'unsupported parameter' }));
  check('nor the provider being down', !worth({ status: 503 }), 'every key fails the same way; five slow errors help nobody');
}

console.log(
  failures === 0
    ? '\n[32mAll search checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
