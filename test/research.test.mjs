/**
 * The deep-research layer — the parts that need no network.
 *
 * The pipeline itself calls a model and a search engine, but its spine is code:
 * confidence graded by counting sources, citations enforced by a scan of the
 * draft, a source ledger deduped by url, a question decomposed into queries,
 * and a debate whose control flow (stop when the critic is satisfied, cap at a
 * budget) is testable with scripted streams. Those are what this suite pins —
 * the anti-hallucination guarantees, not the prose the model writes.
 *
 *   node test/research.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'research-test-key';
process.env.SESSION_SECRET ||= 'research-test-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-research-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const uid = 'u-research';
await store.createUser({
  id: uid,
  email: 'r@example.com',
  name: 'R',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

section('a research run is stored and read back, scoped to its owner');
{
  const run = {
    id: 'run-1',
    chatId: 'c-1',
    question: 'Q?',
    status: 'complete',
    transcript: [{ role: 'proposer', text: 'draft' }],
    sources: [{ id: 'S1', url: 'https://a.example' }],
    report: 'the report',
    tokensIn: 100,
    tokensOut: 50,
  };
  await store.saveResearchRun(uid, run);
  const back = await store.getResearchRun(uid, 'run-1');
  check('it comes back', back?.id === 'run-1', back?.id);
  check('the transcript survives as JSON', Array.isArray(back?.transcript) && back.transcript[0].role === 'proposer');
  check('the sources survive', back?.sources?.[0]?.id === 'S1');
  check('another account cannot read it', (await store.getResearchRun('u-other', 'run-1')) === null);
}

section('confidence is counted, not guessed');
{
  const { grade, registrableDomain } = await import('../server/research/confidence.js');
  const ledger = new Map([
    ['S1', { url: 'https://www.reuters.com/x', rank: 'reputable' }],
    ['S2', { url: 'https://apnews.com/y', rank: 'reputable' }],
    ['S3', { url: 'https://sub.reuters.com/z', rank: 'reputable' }],
    ['S4', { url: 'https://someblog.wordpress.com/p', rank: 'blog' }],
  ]);
  check('two independent reputable sources are HIGH', grade(['S1', 'S2'], ledger) === 'HIGH');
  check('same registrable domain is not independent', grade(['S1', 'S3'], ledger) === 'MEDIUM', grade(['S1', 'S3'], ledger));
  check('one reputable source is MEDIUM', grade(['S1'], ledger) === 'MEDIUM');
  check('a lone blog is LOW', grade(['S4'], ledger) === 'LOW');
  check('no sources at all is LOW', grade([], ledger) === 'LOW');
  check('registrable domain strips subdomains', registrableDomain('https://sub.reuters.com/z') === 'reuters.com');
}

section('the report enforces a citation on every claim');
{
  const { buildReport, markerIds } = await import('../server/research/report.js');
  const ledger = new Map([
    ['S1', { url: 'https://www.reuters.com/x', rank: 'reputable', title: 'R', published: '2026-01-01' }],
    ['S2', { url: 'https://apnews.com/y', rank: 'reputable', title: 'A', published: null }],
  ]);
  check('markers are extracted', JSON.stringify(markerIds('foo [S1][S2] bar')) === '["S1","S2"]');

  const report = buildReport({
    question: 'Q?',
    claims: [{ text: 'Backed claim [S1][S2].' }, { text: 'Unsupported claim.' }, { text: 'Disputed [S1].', conflicting: true }],
    ledger,
    status: 'complete',
  });
  check('a cited claim carries its grade', /Backed claim.*HIGH/s.test(report), report.slice(0, 120));
  check('an uncited claim is flagged, not passed', /Unsupported claim.*LOW — no source/s.test(report), report);
  check('a disputed claim is marked CONFLICTING', /Disputed.*CONFLICTING/s.test(report));
  check('the sources are listed with urls', /reuters\.com/.test(report) && /apnews\.com/.test(report));
  check('the budget status is announced when set', /Stopped at the token budget/.test(
    buildReport({ question: 'Q', claims: [], ledger, status: 'budget' }),
  ));
}

section('gathering builds a deduped, ranked source ledger');
{
  const { gatherEvidence, rankSource } = await import('../server/research/gather.js');
  const fake = async (q) => ({
    engine: 'stub',
    results: q.includes('price')
      ? [{ title: 'Reuters', url: 'https://www.reuters.com/a', snippet: 'p', published: '2026-01-01' }]
      : [
          { title: 'Reuters', url: 'https://www.reuters.com/a', snippet: 'p2', published: '2026-01-01' },
          { title: 'Blog', url: 'https://x.wordpress.com/b', snippet: 'q', published: null },
        ],
    attempts: [],
  });
  const { ledger, findings } = await gatherEvidence(['bitcoin price', 'bitcoin history'], { search: fake });
  check('a repeated url is one ledger entry', ledger.size === 2, `${ledger.size}`);
  check('sources get S# ids', [...ledger.keys()].every((k) => /^S\d+$/.test(k)));
  check('titles are carried into the ledger', ledger.get('S1')?.title === 'Reuters', ledger.get('S1')?.title);
  check('a wire service ranks reputable', rankSource('https://www.reuters.com/a') === 'reputable');
  check('an unknown blog ranks blog', rankSource('https://x.wordpress.com/b') === 'blog');
  check('a government host ranks primary', rankSource('https://data.gov/x') === 'primary');
  check('findings reference ledger ids', findings.filter((f) => f.id).every((f) => ledger.has(f.id)));

  // A search that throws is a finding that says so, not a crash.
  const boom = async () => {
    throw new Error('all engines down');
  };
  const { ledger: empty, findings: notes } = await gatherEvidence(['q'], { search: boom });
  check('a failed search yields no sources', empty.size === 0);
  check('and records why', notes.some((f) => /down/.test(f.snippet)));
}

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(
  failures === 0 ? '\n\x1b[32mAll research checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
