# Deep Research + Debate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `deep_research` tool the model calls for hard questions: it fans out searches, drafts an answer through a Proposer→Critic→Arbiter debate, grades each conclusion's confidence in code, enforces citations, and files the whole transcript for audit.

**Architecture:** A new `server/research/` folder, one file per stage, orchestrated by `index.js`. Every LLM role uses the conversation's own model (Auto free included) via `resolveForUser`, differing only by persona/system prompt — the cheap path the spec requires. Confidence is graded by code, not asked of the model; citations are enforced by a pass over the draft, not requested in a prompt. The debate and the sources are persisted to a new `research_runs` table so the transcript is auditable without bloating the conversation.

**Tech Stack:** Node 20 ESM, no new dependencies. Reuses `search()` (`server/search.js`), `streamCompletion` (`server/providers/index.js`), `resolveForUser` (`server/autoPick.js`), the cloud-tool wiring (`server/tools/`), and the hand-rolled test harness.

## Global Constraints

- **No new dependencies.**
- **Every role uses the conversation's model** via `resolveForUser(userId, prefs.defaultModel, {vision})` — same model, different persona. Never hard-code a model.
- **Confidence is graded in code**, from counting independent sources — never by asking the model how sure it is.
- **Citations are enforced by a scan** of the draft: a claim with no `[S#]` marker is labelled `LOW — no source`, not passed silently.
- **A hard token budget** caps a run; hitting it stops and returns what exists with `status: 'budget'`, never a silent truncation.
- **Read-only.** Gathering uses the safe search path; the tool `readOnly: true`, `scope: 'cloud'`.
- **British-English "why" comments**, matching the repo.
- **`npm run check` green** (lint + all suites + sandbox + hooks).

## File Structure

```
server/research/
  index.js        runDeepResearch() — orchestrator, budget, persistence
  plan.js         planQuestions() — decompose into sub-questions + queries
  gather.js       gatherEvidence() — run searches, build the source ledger
  confidence.js   grade() — HIGH/MEDIUM/LOW/CONFLICTING from the ledger (pure)
  report.js       buildReport() — assemble sections, enforce citation markers (pure)
  debate.js       runDebate() — Proposer → Critic → Proposer → Critic → Arbiter
```

Touched existing files: `server/store/schema.sql` (table), `server/store/pg.js` + `pglite.js` (two methods), `server/tools/definitions.js` (tool def), `server/tools/cloud.js` (impl), `server/tools/execute.js` (already routes cloud tools — no change), `package.json` (test wiring).

---

### Task 1: The `research_runs` table and its two store methods

**Files:**
- Modify: `server/store/schema.sql` (append the table)
- Modify: `server/store/pg.js` (add `saveResearchRun`, `getResearchRun`)
- Modify: `server/store/pglite.js` (same two, matching)
- Test: `test/research.test.mjs` (new)
- Modify: `package.json` (add to test chain + `test:research`)

**Interfaces:**
- Produces:
  - `saveResearchRun(userId, run)` where `run = { id, chatId, question, status, transcript, sources, report, tokensIn, tokensOut }` → the stored row.
  - `getResearchRun(userId, id)` → the row or null. Scoped by `user_id` (tenancy).

- [ ] **Step 1: Write the failing test**

Create `test/research.test.mjs`:

```js
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
const check = (l, ok, d = '') => { console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`); if (!ok) failures += 1; };

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const uid = 'u-research';
await store.createUser({ id: uid, email: 'r@example.com', name: 'R', passwordHash: await hashPassword('a-sufficiently-long-password'), role: 'admin' });

section('a research run is stored and read back, scoped to its owner');
{
  const run = { id: 'run-1', chatId: 'c-1', question: 'Q?', status: 'complete',
    transcript: [{ role: 'proposer', text: 'draft' }], sources: [{ id: 'S1', url: 'https://a.example' }],
    report: 'the report', tokensIn: 100, tokensOut: 50 };
  await store.saveResearchRun(uid, run);
  const back = await store.getResearchRun(uid, 'run-1');
  check('it comes back', back?.id === 'run-1', back?.id);
  check('the transcript survives as JSON', Array.isArray(back?.transcript) && back.transcript[0].role === 'proposer');
  check('the sources survive', back?.sources?.[0]?.id === 'S1');
  check('another account cannot read it', (await store.getResearchRun('u-other', 'run-1')) === null);
}

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(failures === 0 ? '\n\x1b[32mAll research checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run, verify it fails** — `node test/research.test.mjs` → `saveResearchRun is not a function`.

- [ ] **Step 3: Add the table** to `server/store/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS research_runs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id      TEXT,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL,
  transcript   JSONB NOT NULL,
  sources      JSONB NOT NULL,
  report       TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_runs_user_idx ON research_runs (user_id, created_at DESC);
```

- [ ] **Step 4: Add the methods** to `server/store/pg.js` (near `createTask`):

```js
async saveResearchRun(userId, run) {
  const rows = await q(
    `INSERT INTO research_runs (id, user_id, chat_id, question, status, transcript, sources, report, tokens_in, tokens_out, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, transcript = EXCLUDED.transcript,
       sources = EXCLUDED.sources, report = EXCLUDED.report, tokens_in = EXCLUDED.tokens_in,
       tokens_out = EXCLUDED.tokens_out, completed_at = NOW()
     RETURNING *`,
    [run.id, userId, run.chatId ?? null, run.question, run.status,
     JSON.stringify(run.transcript ?? []), JSON.stringify(run.sources ?? []),
     run.report ?? null, run.tokensIn ?? 0, run.tokensOut ?? 0],
  );
  return rows[0];
},
async getResearchRun(userId, id) {
  const rows = await q('SELECT * FROM research_runs WHERE user_id = $1 AND id = $2', [userId, id]);
  return rows[0] ?? null;
},
```

For `pglite.js`, follow whatever JSON convention its sibling methods use (pglite stores JSONB the same way; if its helper parses JSON columns, mirror `listMcpServers`/`getSharedModel` there). Read the two nearest methods in `pglite.js` before writing, and match them exactly.

- [ ] **Step 5: Run** — `node test/research.test.mjs` → PASS. Then `npm test`.

- [ ] **Step 6: Wire into test chain** — add `node test/research.test.mjs && ` after `test/autopick.test.mjs` in `package.json`'s `test` script, and a `"test:research": "node test/research.test.mjs"` line.

- [ ] **Step 7: Commit** — `git add server/store test/research.test.mjs package.json && git commit -m "Store a research run's transcript and sources for audit"`

---

### Task 2: Confidence grading (pure, the anti-hallucination spine)

**Files:**
- Create: `server/research/confidence.js`
- Test: extend `test/research.test.mjs`

**Interfaces:**
- Consumes: a claim's supporting source ids and the source ledger.
- Produces:
  - `registrableDomain(url) → string` — the domain two sources are "independent" by.
  - `grade(sourceIds, ledger) → 'HIGH'|'MEDIUM'|'LOW'|'CONFLICTING'` where `ledger` is `Map<id, { url, rank }>` and `rank` is one of `'primary'|'reputable'|'blog'|'social'`.

- [ ] **Step 1: Write the failing test** (append a section):

```js
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
  check('same registrable domain is not independent', grade(['S1', 'S3'], ledger) === 'MEDIUM', grade(['S1','S3'], ledger));
  check('one reputable source is MEDIUM', grade(['S1'], ledger) === 'MEDIUM');
  check('a lone blog is LOW', grade(['S4'], ledger) === 'LOW');
  check('no sources at all is LOW', grade([], ledger) === 'LOW');
  check('registrable domain strips subdomains', registrableDomain('https://sub.reuters.com/z') === 'reuters.com');
}
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `server/research/confidence.js`:

```js
/**
 * How much to trust a claim, decided by counting its sources rather than by
 * asking the model how sure it is — a model's self-reported confidence is
 * famously worst exactly when it is confabulating. Independence is by
 * registrable domain, so two pages of the same outlet do not double-count.
 */

const RANK_ORDER = { primary: 3, reputable: 2, blog: 1, social: 0 };

/** The domain two sources count as independent by: last two labels, roughly. */
export function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  } catch {
    return String(url || '');
  }
}

export function grade(sourceIds, ledger) {
  const rows = (sourceIds || []).map((id) => ledger.get(id)).filter(Boolean);
  if (!rows.length) return 'LOW';

  const domains = new Set(rows.map((r) => registrableDomain(r.url)));
  const strong = rows.filter((r) => (RANK_ORDER[r.rank] ?? 0) >= RANK_ORDER.reputable);
  const strongDomains = new Set(strong.map((r) => registrableDomain(r.url)));

  if (strongDomains.size >= 2) return 'HIGH';
  if (strong.length >= 1) return 'MEDIUM';
  if (domains.size >= 2) return 'MEDIUM';
  return 'LOW';
}
```

(CONFLICTING is set by the caller when sources disagree — the grader cannot see agreement, only counts; the debate marks a claim conflicting and `report.js` carries that label through. This keeps `grade` pure and testable.)

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "Grade a claim's confidence by counting independent sources"`

---

### Task 3: Report assembly with enforced citations (pure)

**Files:**
- Create: `server/research/report.js`
- Test: extend `test/research.test.mjs`

**Interfaces:**
- Consumes: `grade` (Task 2).
- Produces:
  - `markerIds(text) → string[]` — the `S#` ids referenced in a line, e.g. `"x [S1][S4]"` → `['S1','S4']`.
  - `buildReport({ question, claims, ledger, status }) → string` where `claims` is `[{ text, conflicting? }]`. Each claim line is graded from its own markers; a claim with no marker is labelled `LOW — no source`.

- [ ] **Step 1: Write the failing test:**

```js
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
    claims: [
      { text: 'Backed claim [S1][S2].' },
      { text: 'Unsupported claim.' },
    ],
    ledger,
    status: 'complete',
  });
  check('a cited claim carries its grade', /Backed claim.*HIGH/s.test(report), report.slice(0, 200));
  check('an uncited claim is flagged, not passed', /Unsupported claim.*LOW — no source/s.test(report), report);
  check('the sources are listed with urls', /reuters\.com/.test(report) && /apnews\.com/.test(report));
}
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `server/research/report.js`:

```js
import { grade } from './confidence.js';

/** The S# ids a line cites. */
export function markerIds(text) {
  return [...String(text || '').matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
}

/**
 * Assemble the final report, and make the citation rule real rather than
 * requested. Every claim is graded from the markers it actually carries; a
 * claim with no marker is labelled LOW — no source instead of passing as
 * ordinary prose. This is what turns "please don't hallucinate" into something
 * the system can see when the model does.
 */
export function buildReport({ question, claims, ledger, status }) {
  const lines = [`# ${question}`, ''];
  if (status === 'budget') lines.push('_Stopped at the token budget; this is what was gathered so far._', '');

  lines.push('## Conclusions', '');
  for (const claim of claims || []) {
    const ids = markerIds(claim.text);
    const label = claim.conflicting ? 'CONFLICTING' : ids.length ? grade(ids, ledger) : 'LOW — no source';
    lines.push(`- ${claim.text}  \n  _confidence: ${label}_`);
  }

  lines.push('', '## Sources', '');
  for (const [id, s] of ledger) {
    lines.push(`- **${id}** ${s.title || s.url} — ${s.url}${s.published ? ` (${s.published})` : ''}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "Assemble the report and flag any claim that cites no source"`

---

### Task 4: Gather evidence and build the source ledger

**Files:**
- Create: `server/research/gather.js`
- Test: extend `test/research.test.mjs` (inject a fake `search`)

**Interfaces:**
- Consumes: `search` (`server/search.js`) — injectable for tests.
- Produces:
  - `rankSource(url) → 'primary'|'reputable'|'blog'|'social'` — a coarse authority guess from the host.
  - `gatherEvidence(queries, { search }) → { ledger, findings }` — runs each query, dedupes by url, assigns `S#` ids and a rank, returns `ledger: Map<id,{url,title,rank,published,snippet}>` and `findings: [{ id, query, snippet }]`.

- [ ] **Step 1: Write the failing test:**

```js
section('gathering builds a deduped, ranked source ledger');
{
  const { gatherEvidence, rankSource } = await import('../server/research/gather.js');
  const fake = async (q) => ({
    engine: 'stub',
    results: q.includes('price')
      ? [{ title: 'Reuters', url: 'https://www.reuters.com/a', snippet: 'p', published: '2026-01-01' }]
      : [{ title: 'Reuters', url: 'https://www.reuters.com/a', snippet: 'p2', published: '2026-01-01' },
         { title: 'Blog', url: 'https://x.wordpress.com/b', snippet: 'q', published: null }],
    attempts: [],
  });
  const { ledger, findings } = await gatherEvidence(['bitcoin price', 'bitcoin history'], { search: fake });
  check('a repeated url is one ledger entry', ledger.size === 2, `${ledger.size}`);
  check('sources get S# ids', [...ledger.keys()].every((k) => /^S\d+$/.test(k)));
  check('a wire service ranks reputable', rankSource('https://www.reuters.com/a') === 'reputable');
  check('an unknown blog ranks blog', rankSource('https://x.wordpress.com/b') === 'blog');
  check('findings reference ledger ids', findings.every((f) => ledger.has(f.id)));
}
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `server/research/gather.js`:

```js
import { search as defaultSearch } from '../search.js';
import { registrableDomain } from './confidence.js';

const REPUTABLE = new Set([
  'reuters.com', 'apnews.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com', 'wsj.com',
  'ft.com', 'economist.com', 'nature.com', 'science.org', 'bloomberg.com',
]);
const PRIMARY = /\.gov$|\.gov\.|\.edu$|\.edu\.|europa\.eu$|who\.int$|arxiv\.org$/;
const SOCIAL = /(^|\.)(twitter|x|reddit|facebook|instagram|tiktok|medium)\.com$/;

/** A coarse authority guess from the host — enough to weight, not to trust blindly. */
export function rankSource(url) {
  const d = registrableDomain(url);
  if (PRIMARY.test(d)) return 'primary';
  if (REPUTABLE.has(d)) return 'reputable';
  if (SOCIAL.test(d)) return 'social';
  return 'blog';
}

/**
 * Run every query and fold the results into one ledger, deduped by url so a
 * source cited twice does not count as two. Each source keeps a stable S# id
 * that the draft cites and the report lists.
 */
export async function gatherEvidence(queries, { search = defaultSearch } = {}) {
  const byUrl = new Map();
  const findings = [];
  let n = 0;

  for (const query of queries) {
    let out;
    try {
      out = await search(query);
    } catch (err) {
      findings.push({ id: null, query, snippet: `(search failed: ${err.message})` });
      continue;
    }
    for (const r of out.results || []) {
      let id = byUrl.get(r.url);
      if (!id) {
        id = `S${(n += 1)}`;
        byUrl.set(r.url, id);
      }
      findings.push({ id, query, snippet: r.snippet });
    }
  }

  const ledger = new Map();
  for (const [url, id] of byUrl) {
    const first = findings.find((f) => f.id === id);
    ledger.set(id, { url, rank: rankSource(url), snippet: first?.snippet || '', title: undefined, published: undefined });
  }
  // Backfill title/published from the raw results kept alongside.
  return { ledger, findings };
}
```

Note at Step 3: the test's fake returns title/published; carry them into the ledger by keying the raw result too (store `{title, published}` when first seen). Adjust the loop to capture them — the test asserts dedupe and ids, and Task 7's integration test asserts titles reach the report, so wire them through.

- [ ] **Step 4: Run, verify pass. Commit** — `git commit -m "Gather search results into one deduped, ranked source ledger"`

---

### Task 5: Decompose the question into sub-questions and queries

**Files:**
- Create: `server/research/plan.js`
- Test: extend `test/research.test.mjs` (inject a fake LLM stream)

**Interfaces:**
- Consumes: `streamCompletion`-shaped async generator (injectable).
- Produces:
  - `parsePlan(text) → string[]` — pull queries out of the model's JSON, tolerant of fences/prose around it.
  - `planQuestions(question, { userId, entry, stream }) → string[]` — one LLM call, returns 4–6 search queries; on unparseable output, retries once then falls back to `[question]`.

- [ ] **Step 1: Write the failing test:**

```js
section('planning turns a question into search queries');
{
  const { parsePlan, planQuestions } = await import('../server/research/plan.js');
  check('queries are pulled from JSON in a fence', JSON.stringify(parsePlan('```json\n{"queries":["a","b"]}\n```')) === '["a","b"]');
  check('garbage yields nothing rather than throwing', Array.isArray(parsePlan('not json')) && parsePlan('not json').length === 0);

  const fakeStream = async function* () { yield { type: 'text', delta: '{"queries":["x","y","z"]}' }; yield { type: 'done', usage: { input: 1, output: 1 } }; };
  const qs = await planQuestions('Q?', { userId: 'u', entry: { provider: 'x' }, stream: fakeStream });
  check('the queries come back', qs.length === 3 && qs[0] === 'x', JSON.stringify(qs));

  const badStream = async function* () { yield { type: 'text', delta: 'nope' }; yield { type: 'done', usage: {} }; };
  const fell = await planQuestions('Fallback question', { userId: 'u', entry: {}, stream: badStream });
  check('unparseable output falls back to the question itself', fell.length === 1 && fell[0] === 'Fallback question');
}
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `server/research/plan.js` — a system prompt asking for `{"queries":[...]}` (4–6, different angles), drive the stream collecting text, `parsePlan`, retry once, fall back to `[question]`. Accumulate usage on a passed-in `budget` object. (Full prompt text written at implementation; keep it short and imperative.)

- [ ] **Step 4: Run, verify pass. Commit.**

---

### Task 6: The Proposer→Critic→Arbiter debate

**Files:**
- Create: `server/research/debate.js`
- Test: extend `test/research.test.mjs` (scripted streams per role)

**Interfaces:**
- Consumes: `streamCompletion`-shaped stream (injectable), the findings + ledger from Task 4.
- Produces:
  - `runDebate({ question, findings, ledger, userId, entry, stream, budget, rounds }) → { claims, transcript }` where `claims` is `[{ text, conflicting? }]` (text carries `[S#]` markers) and `transcript` records each role's turn. Stops early when the Critic raises no new objection; caps at `rounds` (default 2).

- [ ] **Step 1: Write the failing test** with three scripted role streams (Proposer emits a draft with `[S1]`, Critic emits "no further objections", Arbiter emits final claims). Assert: claims carry markers; early stop when the critic is satisfied (Proposer called once); transcript records every role.

- [ ] **Step 2–4:** Implement personas as distinct system prompts (Proposer: "synthesise from the findings ONLY, cite every claim with [S#]"; Critic: "find unsupported or overstated claims"; Arbiter: "settle it; where sources genuinely disagree, present both and mark CONFLICTING"). Proposer receives findings only, never the conversation, so it has nothing to lean on but evidence. Accumulate usage on `budget`; stop when `budget.spent >= budget.cap`. Commit.

---

### Task 7: Orchestrator, tool definition, and wiring

**Files:**
- Create: `server/research/index.js`
- Modify: `server/tools/definitions.js` (the `deep_research` def), `server/tools/cloud.js` (impl)
- Test: extend `test/research.test.mjs` (end-to-end with fakes)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `runDeepResearch({ question, userId, user, chatId, signal, deps }) → { content, runId }` — plan → gather → debate → grade → report; persists via `saveResearchRun`; enforces the token cap; on empty search says so with LOW confidence rather than inventing. `deps` injects `search`/`stream`/`store` for tests.
  - `deep_research` tool: `scope:'cloud'`, `readOnly:true`, params `{ question: string }`.

- [ ] **Step 1: Integration test** — fakes for search + stream, assert: a full run returns a report with sources and confidence labels; an empty search yields a LOW/no-source report, not a fabricated claim; hitting a tiny budget cap returns `status:'budget'` and still persists; the run is saved and readable via `getResearchRun`.

- [ ] **Step 2–4:** Implement `runDeepResearch` orchestrating the stages with a `budget = { spent: 0, cap }`. Resolve the model once via `resolveForUser(userId, prefs.defaultModel, {vision:false})` and pass `entry` to every role. Wire the tool def + `CLOUD_IMPLEMENTATIONS.deep_research = (input, ctx) => runDeepResearch({ ...input, ...ctx })`. The tool returns `{ content: report, ... }`. Commit.

---

### Task 8: Docs and final gate

- [ ] Update `README.md` capability table with a `deep_research` row.
- [ ] `npm run check` green end to end.
- [ ] Commit.

---

## Self-Review

**Spec coverage:** plan/gather/debate/confidence/report/orchestrator + research_runs all map to tasks 1–7; enforced citations (Task 3), code-graded confidence (Task 2), budget cap (Task 7), audit table (Task 1), same-model personas (Task 6/7 via `resolveForUser`), empty-search honesty (Task 7). The "two independent sources" rule is Task 2's `HIGH`.

**Placeholder check:** Tasks 5, 6 leave the exact prompt wording to implementation ("written at implementation") — acceptable because the prompt is prose, not an interface, and each has a full failing test pinning the parsing and control flow around it. Every code interface (function names, params, returns) is concrete.

**Type consistency:** `ledger` is `Map<id,{url,rank,title,published,snippet}>` throughout (Tasks 2,3,4,6,7). `claims` is `[{text,conflicting?}]` (Tasks 3,6,7). `grade(ids, ledger)` signature is stable. `budget = {spent, cap}` across Tasks 5–7.

**Known risk (from spec):** one model as both Proposer and Critic tends to agree with itself; personas reduce it, and the door to a different provider for the Critic is left open (the `stream`/`entry` are per-role parameters, so a future change passes a different entry to the Critic without restructuring).
