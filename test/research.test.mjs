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

section('planning turns a question into search queries');
{
  const { parsePlan, planQuestions } = await import('../server/research/plan.js');
  check('queries are pulled from JSON in a fence', JSON.stringify(parsePlan('```json\n{"queries":["a","b"]}\n```')) === '["a","b"]');
  check('queries survive surrounding prose', JSON.stringify(parsePlan('Sure! {"queries":["a"]} done')) === '["a"]');
  check('garbage yields nothing rather than throwing', Array.isArray(parsePlan('not json')) && parsePlan('not json').length === 0);

  const fakeStream = async function* () {
    yield { type: 'text', delta: '{"queries":["x","y","z"]}' };
    yield { type: 'done', usage: { input: 10, output: 5 } };
  };
  const budget = { spent: 0, cap: 1e9, tokensIn: 0, tokensOut: 0 };
  const qs = await planQuestions('Q?', { userId: 'u', entry: { provider: 'x' }, stream: fakeStream, budget });
  check('the queries come back', qs.length === 3 && qs[0] === 'x', JSON.stringify(qs));
  check('usage is charged to the budget', budget.spent === 15, String(budget.spent));

  const badStream = async function* () {
    yield { type: 'text', delta: 'nope' };
    yield { type: 'done', usage: {} };
  };
  const fell = await planQuestions('Fallback question', { userId: 'u', entry: {}, stream: badStream, budget: { spent: 0, cap: 1e9 } });
  check('unparseable output falls back to the question itself', fell.length === 1 && fell[0] === 'Fallback question');
}

section('the debate drafts, criticises, and settles');
{
  const { runDebate } = await import('../server/research/debate.js');
  const ledger = new Map([['S1', { url: 'https://www.reuters.com/a', rank: 'reputable' }]]);
  const findings = [{ id: 'S1', query: 'q', snippet: 'evidence' }];

  // A stream scripted by call order: proposer draft, satisfied critic, arbiter.
  const scriptOf = (lines) => {
    let i = 0;
    return async function* () {
      const line = lines[Math.min(i, lines.length - 1)];
      i += 1;
      yield { type: 'text', delta: line };
      yield { type: 'done', usage: { input: 1, output: 1 } };
    };
  };

  const calls = [];
  const spy = (lines) => {
    const s = scriptOf(lines);
    return (opts) => {
      calls.push(opts.system.slice(0, 20));
      return s(opts);
    };
  };

  const budget = { spent: 0, cap: 1e9 };
  const stream = spy([
    'Claim A [S1].', // proposer draft
    '{"objections":[]}', // critic: satisfied
    '{"claims":[{"text":"Claim A [S1].","conflicting":false}]}', // arbiter
  ]);
  const { claims, transcript } = await runDebate({
    question: 'Q?', findings, ledger, userId: 'u', entry: {}, stream, budget, rounds: 2,
  });
  check('the final claim keeps its citation', claims[0]?.text.includes('[S1]'), JSON.stringify(claims));
  check('a satisfied critic stops the debate early', calls.length === 3, `${calls.length} calls`);
  check('the transcript records every role', transcript.some((t) => t.role === 'proposer') && transcript.some((t) => t.role === 'critic') && transcript.some((t) => t.role === 'arbiter'));

  // An arbiter that returns prose rather than JSON still yields a usable claim
  // rather than losing the answer.
  const proseStream = spy(['draft [S1]', '{"objections":[]}', 'The answer is X [S1].']);
  const out = await runDebate({ question: 'Q', findings, ledger, userId: 'u', entry: {}, stream: proseStream, budget: { spent: 0, cap: 1e9 }, rounds: 2 });
  check('unparseable arbiter output becomes one claim, not nothing', out.claims.length >= 1 && out.claims[0].text.length > 0);
}

section('the whole pipeline, end to end with fakes');
{
  const { runDeepResearch } = await import('../server/research/index.js');

  // A stream that answers by role, so plan → debate all run through one fake.
  const byRole = async function* ({ system }) {
    const reply = /planner/i.test(system)
      ? '{"queries":["deepseek price","deepseek history"]}'
      : /Proposer/.test(system)
        ? 'DeepSeek is free [S1].'
        : /Critic/.test(system)
          ? '{"objections":[]}'
          : '{"claims":[{"text":"DeepSeek is free [S1].","conflicting":false}]}';
    yield { type: 'text', delta: reply };
    yield { type: 'done', usage: { input: 100, output: 50 } };
  };
  const fakeSearch = async () => ({
    engine: 'stub',
    results: [{ title: 'Reuters', url: 'https://www.reuters.com/a', snippet: 'it is free', published: '2026-01-01' }],
    attempts: [],
  });

  const run = await runDeepResearch({
    question: 'Is DeepSeek free?',
    userId: uid,
    user: { id: uid },
    chatId: 'c-research',
    deps: { search: fakeSearch, stream: byRole, entry: { provider: 'x' } },
  });
  check('the report cites a source', /reuters\.com/.test(run.content), run.content.slice(0, 120));
  check('and grades a conclusion', /confidence:/.test(run.content));
  check('a run id comes back', !!run.runId);
  const saved = await store.getResearchRun(uid, run.runId);
  check('and the run is persisted', saved?.question === 'Is DeepSeek free?', saved?.status);
  check('with its transcript', Array.isArray(saved?.transcript) && saved.transcript.length > 0);

  // An empty search must not become a confident answer.
  const emptyRun = await runDeepResearch({
    question: 'Q?', userId: uid, user: { id: uid }, chatId: 'c2',
    deps: { search: async () => ({ engine: null, results: [], attempts: [] }), stream: byRole, entry: { provider: 'x' } },
  });
  check('an empty search yields no fabricated sources', /No sources were found|no source/i.test(emptyRun.content), emptyRun.content.slice(-200));

  // A tiny budget cap stops the run and still persists what it had.
  const capped = await runDeepResearch({
    question: 'Q3?', userId: uid, user: { id: uid }, chatId: 'c3',
    deps: { search: fakeSearch, stream: byRole, entry: { provider: 'x' }, cap: 1 },
  });
  check('a hit budget is reported, not hidden', /token budget/i.test(capped.content), capped.content.slice(0, 120));
  check('and the capped run is still saved', (await store.getResearchRun(uid, capped.runId))?.status === 'budget');
}

section('deep_research is a top-level tool, never handed to a sub-agent');
{
  const { availableTools } = await import('../server/tools/definitions.js');
  const forMain = availableTools({ workerOnline: false, desktopOnline: false, policy: 'guarded' }).map((t) => t.name);
  const forSub = availableTools({ workerOnline: false, desktopOnline: false, policy: 'readonly', subagent: true }).map((t) => t.name);
  check('the main loop is offered deep_research', forMain.includes('deep_research'));
  check('a sub-agent is not — no research-of-research fan-out', !forSub.includes('deep_research'));
  check('nor run_parallel — a sub-agent does not spawn sub-agents', !forSub.includes('run_parallel'));
}

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(
  failures === 0 ? '\n\x1b[32mAll research checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
