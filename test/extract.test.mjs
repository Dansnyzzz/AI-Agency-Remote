/**
 * Reading a page for the few facts wanted, instead of pasting the whole thing in.
 *
 * `web_fetch` drops up to 20,000 characters of page into the conversation — some
 * 5,000 tokens, per page, carried in the context of every turn that follows.
 * Read five competitor pages and the transcript is mostly boilerplate nav and
 * cookie notices. This does the reading in a call of its own and returns only
 * the structured answer, so the conversation carries the facts rather than the
 * page.
 *
 *   node test/extract.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'extract-test-key';
process.env.SESSION_SECRET ||= 'extract-test-secret';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { extractFromPage } = await import('../server/tools/extract.js');

const page = async () => 'Acme Pro costs $49/month. Acme Lite costs $19/month. Support: 24/7.';
const replies = (text) =>
  async function* () {
    yield { type: 'text', delta: text };
    yield { type: 'done', usage: { input: 10, output: 5 } };
  };

section('a page becomes the facts asked for, not the page');
{
  const out = await extractFromPage({
    url: 'https://example.com/pricing',
    what: 'the plans and their prices',
    fields: ['plan', 'price'],
    userId: 'u',
    entry: { provider: 'x' },
    stream: replies('{"items":[{"plan":"Acme Pro","price":"$49/month"},{"plan":"Acme Lite","price":"$19/month"}]}'),
    fetchPage: page,
  });
  check('the structured answer comes back', /Acme Pro/.test(out) && /49/.test(out), out.slice(0, 80));
  check('and the page itself does not', !/cookie|Support: 24\/7/.test(out), out.slice(0, 120));
  check('the source url is stated', out.includes('example.com/pricing'), out.slice(0, 60));
}

section('nothing found is said plainly, not invented');
{
  const out = await extractFromPage({
    url: 'https://example.com/x',
    what: 'the share price',
    userId: 'u',
    entry: {},
    stream: replies('{"items":[]}'),
    fetchPage: page,
  });
  check('an empty result says so', /nothing|no .*found|not on the page/i.test(out), out);
}

section('a reply that is not JSON is still usable, not a crash');
{
  const out = await extractFromPage({
    url: 'https://example.com/x',
    what: 'the plans',
    userId: 'u',
    entry: {},
    stream: replies('Acme Pro is $49 and Acme Lite is $19.'),
    fetchPage: page,
  });
  check('prose comes through rather than throwing', /Acme Pro/.test(out), out.slice(0, 80));
}

section('a page that cannot be read fails with the reason');
{
  let message = '';
  try {
    await extractFromPage({
      url: 'https://example.com/x',
      what: 'anything',
      userId: 'u',
      entry: {},
      stream: replies('{}'),
      fetchPage: async () => {
        throw new Error('example.com returned HTTP 503');
      },
    });
  } catch (err) {
    message = err.message;
  }
  check('the fetch failure is surfaced', /503/.test(message), message);
}

section('bad input is refused');
{
  const bad = async (args) => {
    try {
      await extractFromPage({ userId: 'u', entry: {}, stream: replies('{}'), fetchPage: page, ...args });
      return '';
    } catch (err) {
      return err.message;
    }
  };
  check('a missing url is refused', (await bad({ what: 'x' })).length > 0);
  check('a missing "what" is refused', (await bad({ url: 'https://example.com' })).length > 0);
  check('a non-http url is refused', /http/i.test(await bad({ url: 'file:///etc/passwd', what: 'x' })));
}

console.log(
  failures === 0 ? '\n\x1b[32mAll extract checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
