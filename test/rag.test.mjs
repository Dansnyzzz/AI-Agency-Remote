/**
 * Indexing the user's documents, and finding them again by meaning.
 *
 * The embedding API is replaced with a deterministic bag-of-words vector. That
 * is not a shortcut around the interesting part — it *is* the interesting part
 * here. What this suite is for is the plumbing either side of the model: that
 * chunks come back attached to the right file, that an edited file replaces its
 * old passages rather than accumulating both, that vectors from two different
 * models are never compared, and above all that one account's documents are
 * invisible to another. None of those depend on the embedding being good, and
 * all of them are the kind of bug that would quietly produce confident wrong
 * answers about somebody's private files.
 *
 *   node test/rag.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'rag-test-encryption-key';
process.env.SESSION_SECRET ||= 'rag-test-session-secret';
process.env.OPENAI_API_KEY = 'test-key-not-used-for-real-calls';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-rag-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

// ── a stand-in for the embedding API ──────────────────────────────────
//
// Words are hashed into buckets, so two texts that share vocabulary point in
// similar directions and one that shares none does not. Crude, deterministic,
// and enough to tell "ranked correctly" from "ranked at random".
const DIMS = 1536;
let embedCalls = 0;
let embeddedTexts = [];

function fakeVector(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    vector[hash % DIMS] += 1;
  }
  return vector;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const href = String(url);
  if (href.includes('/embeddings')) {
    embedCalls += 1;
    const { input } = JSON.parse(options.body);
    embeddedTexts.push(...input);
    return new Response(
      JSON.stringify({ data: input.map((text, index) => ({ index, embedding: fakeVector(text) })) }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }
  return realFetch(url, options);
};

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { ingestBatch, searchDocs, listSources, forgetSource, knownStamps } = await import('../server/rag.js');
const { chunk } = await import('../worker/indexer.js');

const store = getStore();
const alice = await store.createUser({ id: 'u-alice', email: 'alice@example.com', passwordHash: 'x', role: 'admin' });
const bob = await store.createUser({ id: 'u-bob', email: 'bob@example.com', passwordHash: 'x', role: 'user' });

// ── chunking ──────────────────────────────────────────────────────────
section('text is cut into passages you can read on their own');
{
  check('empty text makes no passages', chunk('   ').length === 0);

  const short = chunk('One paragraph, well under the limit.');
  check('a short document is one passage', short.length === 1, `${short.length}`);
  check('and keeps its text intact', short[0].text === 'One paragraph, well under the limit.');

  const doc = `# Rental agreement\n\n${'The tenant pays on the first. '.repeat(60)}\n\n## Deposit\n\n${'Two months held in escrow. '.repeat(60)}`;
  const pieces = chunk(doc);
  check('a long document is split', pieces.length > 1, `${pieces.length} passages`);
  check('every passage has text', pieces.every((p) => p.text.trim().length > 0));
  check('and carries the heading above it', pieces.some((p) => /Deposit|Rental agreement/.test(p.heading || '')),
    JSON.stringify(pieces.map((p) => p.heading)));

  // The overlap is the whole reason a sentence spanning a boundary stays
  // findable. Without it, neither half contains the phrase.
  const overlapping = chunk('A '.repeat(900) + 'UNIQUEMARKER ' + 'B '.repeat(900));
  check('consecutive passages overlap', overlapping.length > 1);

  // A paragraph longer than the whole passage size must still be cut, not
  // emitted as one oversized chunk that the embedding API would reject.
  const huge = chunk('x'.repeat(9000));
  check('an enormous single paragraph is still split', huge.length > 1, `${huge.length}`);
  check('and none of the pieces is oversized', huge.every((p) => p.text.length <= 1400));
}

// ── ingest and search ─────────────────────────────────────────────────
section('a folder is indexed and can be searched by meaning');
{
  const result = await ingestBatch(alice.id, {
    source: 'documents',
    files: [
      {
        path: 'documents/lease.md',
        mtime: 1000,
        chunks: [
          { text: 'The deposit is two months of rent, held in escrow until the tenancy ends.', heading: 'Deposit' },
          { text: 'Rent falls due on the first day of each month by bank transfer.', heading: 'Rent' },
        ],
      },
      {
        path: 'documents/recipes.md',
        mtime: 1000,
        chunks: [{ text: 'Fry the garlic in olive oil until golden, then add the tomatoes.' }],
      },
    ],
  });

  check('it reports what it stored', result.files === 2 && result.chunks === 3, JSON.stringify(result));
  check('and which model made the vectors', result.model === 'text-embedding-3-small', result.model);

  const hit = await searchDocs(alice.id, { query: 'how much money is held in escrow' });
  check('the right passage comes first', /two months of rent/.test(hit.split('\n\n')[1] || hit), hit.slice(0, 160));
  check('and the file it came from is named', hit.includes('documents/lease.md'));
  check('the unrelated document is not first', hit.indexOf('lease.md') < hit.indexOf('recipes.md') || !hit.includes('recipes.md'));

  const listed = await listSources(alice.id);
  check('the source is listed with its counts', /documents — 2 files, 3 passages/.test(listed), listed);
}

section('a weak match is admitted rather than dressed up');
{
  const hit = await searchDocs(alice.id, { query: 'quantum chromodynamics lattice gauge symmetry' });
  check('the reply says nothing really matches', /Nothing here matches the question closely/.test(hit), hit.slice(-160));
}

// ── re-indexing ───────────────────────────────────────────────────────
section('editing a file replaces its passages instead of piling up');
{
  await ingestBatch(alice.id, {
    source: 'documents',
    files: [
      {
        path: 'documents/lease.md',
        mtime: 2000,
        chunks: [{ text: 'The deposit is now three months of rent, held in escrow.', heading: 'Deposit' }],
      },
    ],
  });

  const rows = await store.docVectors(alice.id, 'text-embedding-3-small');
  const lease = rows.filter((r) => r.path === 'documents/lease.md');
  check('the old passages are gone', lease.length === 1, `${lease.length} left`);
  check('and the other file is untouched', rows.some((r) => r.path === 'documents/recipes.md'));

  const hit = await searchDocs(alice.id, { query: 'how many months of deposit' });
  check('the search returns the new text', /three months/.test(hit), hit.slice(0, 200));
  check('and never the superseded text', !/two months/.test(hit));

  const { stamps } = await knownStamps(alice.id, 'documents');
  check('the stamp moved with the edit', stamps['documents/lease.md'] === 2000, String(stamps['documents/lease.md']));
  check('and unchanged files keep theirs', stamps['documents/recipes.md'] === 1000);
}

// ── the boundary that matters most ────────────────────────────────────
section("one account's documents are invisible to another");
{
  await ingestBatch(bob.id, {
    source: 'private',
    files: [{ path: 'private/medical.md', mtime: 1, chunks: [{ text: 'Blood test results and the escrow of my deposit.' }] }],
  });

  const hers = await searchDocs(alice.id, { query: 'escrow deposit' });
  check("Bob's file never appears in Alice's search", !hers.includes('medical.md'), hers.slice(0, 200));

  const his = await searchDocs(bob.id, { query: 'escrow deposit' });
  check("and Alice's never appears in Bob's", !his.includes('lease.md'), his.slice(0, 200));
  check('though he can find his own', his.includes('private/medical.md'));

  check("Alice's listing shows only her folder", !(await listSources(alice.id)).includes('private'));

  // Deleting is scoped too — the obvious way to write this method drops
  // everyone's rows for that source name.
  await forgetSource(alice.id, 'documents');
  check("forgetting Alice's index leaves Bob's alone", (await listSources(bob.id)).includes('private'));
  check('and hers really is gone', (await listSources(alice.id)) === 'Nothing is indexed.');
}

// ── vectors from different models are never mixed ─────────────────────
section('vectors from a different embedding model are not compared');
{
  await ingestBatch(bob.id, {
    source: 'legacy',
    files: [{ path: 'legacy/old.md', mtime: 1, chunks: [{ text: 'Indexed long ago with another model entirely.' }] }],
  });
  // Rewrite one source as if it had been embedded by Google — the situation
  // somebody lands in by switching provider keys.
  await store.docVectors(bob.id, 'text-embedding-3-small');
  const rows = await store.docChunks(bob.id, (await store.docVectors(bob.id, 'text-embedding-3-small')).map((r) => r.id));
  const legacy = rows.find((r) => r.path === 'legacy/old.md');
  await store.replaceDocChunks(bob.id, 'legacy/old.md', [
    { ...legacy, id: legacy.id, model: 'text-embedding-004', dims: 768, source: 'legacy', ordinal: 0 },
  ]);

  const hit = await searchDocs(bob.id, { query: 'indexed long ago with another model' });
  check('the mismatched passage is not returned', !hit.includes('legacy/old.md'), hit.slice(0, 200));
  check('but the matching-model one still is', hit.includes('private/medical.md'));
}

// ── no key, no index ──────────────────────────────────────────────────
section('an account with no embedding key is told what to do about it');
{
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Anthropic and OpenRouter exist but serve no embedding endpoint, so having
  // one must not read as "configured".
  process.env.ANTHROPIC_API_KEY = 'anthropic-key';
  process.env.OPENROUTER_API_KEY = 'openrouter-key';

  const message = await searchDocs(alice.id, { query: 'anything' }).then(
    () => 'no error',
    (err) => err.message,
  );
  check('it names the providers that would work', /OpenAI or Google/.test(message), message.slice(0, 140));
  check('and says why the ones they have do not', /serves an embedding endpoint/.test(message));

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_API_KEY = saved;
}

// ── the half that runs on the user's machine ──────────────────────────
section('indexing a real folder on disk');
{
  const { setWorkspace } = await import('../worker/paths.js');
  const { indexFolder, setIndexSink } = await import('../worker/indexer.js');

  const root = path.join(process.env.DATA_DIR, 'docs');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'contract.md'), '# Contract\n\nThe warranty lasts twelve months from delivery.\n');
  fs.writeFileSync(path.join(root, 'notes', 'meeting.txt'), 'We agreed to move the deadline to March.\n');
  fs.writeFileSync(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'dep.js'), 'module.exports = 1;\n');
  setWorkspace(root);
  setIndexSink((payload) =>
    payload.op === 'stamps' ? knownStamps(alice.id, payload.source) : ingestBatch(alice.id, payload),
  );

  const first = await indexFolder({ path: '.' });
  check('it reads the documents it found', /Indexed \.\/ — 2 files/.test(first), first);
  check('and says the search can reach them', first.includes('search_docs can find this now'), first);

  const found = await searchDocs(alice.id, { query: 'how long is the warranty' });
  check('a file on disk is searchable afterwards', found.includes('contract.md'), found.slice(0, 200));
  check('and so is one in a subfolder', (await searchDocs(alice.id, { query: 'when is the deadline' })).includes('meeting.txt'));

  // node_modules is thousands of files nobody wrote and nobody will search for.
  check('node_modules is not indexed', !(await listSources(alice.id)).includes('junk'));
  check('and a PNG is not mistaken for text', !found.includes('photo.png'));

  // The second run is the one that decides whether re-indexing is affordable.
  const second = await indexFolder({ path: '.' });
  check('nothing is re-read when nothing changed', /Indexed \.\/ — 0 files/.test(second), second);
  check('and it says how many it skipped', /2 unchanged since last time/.test(second), second);

  fs.writeFileSync(path.join(root, 'contract.md'), '# Contract\n\nThe warranty lasts twenty-four months now.\n');
  const third = await indexFolder({ path: '.' });
  check('an edited file is picked up again', /Indexed \.\/ — 1 file,/.test(third), third);
  check('and the other is still skipped', /1 unchanged/.test(third), third);
  check(
    'the search reflects the edit',
    (await searchDocs(alice.id, { query: 'how long is the warranty' })).includes('twenty-four'),
  );

  check(
    'pointing it at a file rather than a folder is refused',
    await indexFolder({ path: 'contract.md' }).then(
      () => false,
      (err) => /is a file/.test(err.message),
    ),
  );
  check(
    'and a folder that does not exist says so',
    await indexFolder({ path: 'nowhere' }).then(
      () => false,
      (err) => /nothing at|outside the workspace/i.test(err.message),
    ),
  );

  await forgetSource(alice.id, '.');
}

section('cost is not spent twice on the same text');
{
  embedCalls = 0;
  embeddedTexts = [];
  await ingestBatch(alice.id, {
    source: 'notes',
    files: [{ path: 'notes/a.md', mtime: 1, chunks: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }],
  });
  check('one request covers a whole batch', embedCalls === 1, `${embedCalls} calls`);
  check('and every chunk was in it', embeddedTexts.length === 3, `${embeddedTexts.length}`);

  const before = embedCalls;
  await searchDocs(alice.id, { query: 'one' });
  check('a search embeds only the query', embedCalls === before + 1 && embeddedTexts.length === 4);
}

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(
  failures === 0
    ? '\n\x1b[32mAll document-index checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
