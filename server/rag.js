/**
 * Semantic search over the user's own documents.
 *
 * The split follows the one the rest of the project already lives by: the files
 * are on the user's machine and never leave it wholesale, but embedding needs an
 * API key, and keys live on the server. So the worker reads, extracts and chunks
 * locally, and sends up only the chunks — text that was going to be searched
 * anyway — while this module turns them into vectors and answers questions
 * about them.
 *
 * Two things are worth being explicit about, because they are choices rather
 * than defaults:
 *
 * **The vectors are compared in JavaScript.** No pgvector, no index. It is a
 * dot product over normalised float32 arrays, which for one person's documents
 * — call it fifty thousand chunks at the outside — runs in well under a second
 * and works identically on Neon and on the in-process Postgres a laptop uses.
 * The moment somebody indexes a million chunks this is the wrong answer, and the
 * fix is a `vector` column and an HNSW index on the Neon side only.
 *
 * **Vectors from different models are not comparable.** A chunk embedded by
 * OpenAI and a query embedded by Google produce a similarity score that is
 * meaningless rather than merely wrong, so the model is stored per chunk and the
 * search only ever ranks within one.
 */
import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { getApiKey, baseUrlFor } from './settings.js';

/**
 * Embedding models, in the order they are tried.
 *
 * Anthropic and OpenRouter are absent because neither serves an embedding
 * endpoint — Anthropic has never had one, and OpenRouter routes chat only. An
 * account with only those keys gets a clear sentence saying so rather than a
 * 404 from somewhere in the stack.
 */
const EMBEDDERS = {
  openai: { model: 'text-embedding-3-small', dims: 1536, batch: 96 },
  google: { model: 'text-embedding-004', dims: 768, batch: 100 },
};

const MAX_CHUNKS_PER_CALL = 128;

/** Which provider will do the embedding for this account, if any. */
export async function embedderFor(userId) {
  for (const [provider, spec] of Object.entries(EMBEDDERS)) {
    if (await getApiKey(userId, provider)) return { provider, ...spec };
  }
  return null;
}

function noEmbedder() {
  return new Error(
    'Indexing documents needs an embedding model, and this account has no key that provides one. ' +
      'Add an OpenAI or Google key in Settings → Providers. Anthropic and OpenRouter keys cannot do this — ' +
      'neither serves an embedding endpoint.',
  );
}

// ── vectors ───────────────────────────────────────────────────────────

/**
 * Unit-length, so cosine similarity is a plain dot product at search time.
 *
 * Doing it once on the way in rather than twice per comparison is most of why
 * scoring fifty thousand chunks is cheap enough to do in the request.
 */
function normalise(values) {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum);
  if (length > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
  return vector;
}

const pack = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');

function unpack(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < n; i += 1) total += a[i] * b[i];
  return total;
}

// ── talking to the embedding APIs ─────────────────────────────────────

async function embedOpenAI(texts, apiKey, model) {
  const base = (baseUrlFor('openai') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The embedding request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();

  // Sorted by index rather than trusted to arrive in order — the API documents
  // that it may not, and a silently shuffled batch attaches every vector to the
  // wrong chunk, which produces a search that is confidently wrong.
  return (json.data || []).sort((a, b) => a.index - b.index).map((row) => row.embedding);
}

async function embedGoogle(texts, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The embedding request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  return (json.embeddings || []).map((e) => e.values);
}

/** Embed a list of strings, in batches the provider will accept. */
async function embed(userId, texts) {
  const embedder = await embedderFor(userId);
  if (!embedder) throw noEmbedder();
  const apiKey = await getApiKey(userId, embedder.provider);

  const out = [];
  for (let i = 0; i < texts.length; i += embedder.batch) {
    const slice = texts.slice(i, i + embedder.batch);
    const raw =
      embedder.provider === 'openai'
        ? await embedOpenAI(slice, apiKey, embedder.model)
        : await embedGoogle(slice, apiKey, embedder.model);

    if (raw.length !== slice.length) {
      throw new Error(`The embedding API returned ${raw.length} vectors for ${slice.length} chunks.`);
    }
    for (const values of raw) out.push(normalise(values));
  }
  return { vectors: out, embedder };
}

// ── ingest ────────────────────────────────────────────────────────────

/**
 * What the machine already sent, so it can skip files nobody has touched.
 *
 * The model is part of the answer on purpose: switching embedding provider makes
 * every stored vector incomparable, so those files have to be re-read even
 * though their timestamps have not moved.
 */
export async function knownStamps(userId, source) {
  const embedder = await embedderFor(userId);
  const rows = await getStore().docStamps(userId, String(source || ''));
  const stamps = {};
  for (const row of rows) {
    if (embedder && row.model !== embedder.model) continue;
    stamps[row.path] = Number(row.mtime) || 0;
  }
  return { stamps, model: embedder?.model || null };
}

/**
 * Take a batch of chunked files from the machine, embed them, and store them.
 *
 * One file's chunks are replaced as a unit, so a re-index of an edited file
 * cannot leave stale text behind for the search to find.
 */
export async function ingestBatch(userId, { source, files }) {
  const list = Array.isArray(files) ? files : [];
  const flat = [];
  for (const file of list) {
    for (const [ordinal, chunk] of (file.chunks || []).entries()) {
      const text = String(chunk?.text ?? chunk ?? '').trim();
      if (text) flat.push({ path: String(file.path || ''), ordinal, heading: chunk?.heading || null, text, mtime: file.mtime });
    }
  }
  if (!flat.length) return { files: 0, chunks: 0 };
  if (flat.length > MAX_CHUNKS_PER_CALL) {
    throw new Error(`Too many chunks in one call (${flat.length}). Send at most ${MAX_CHUNKS_PER_CALL}.`);
  }

  const { vectors, embedder } = await embed(userId, flat.map((c) => c.text));

  const byPath = new Map();
  for (const [i, chunk] of flat.entries()) {
    if (!byPath.has(chunk.path)) byPath.set(chunk.path, []);
    byPath.get(chunk.path).push({
      id: crypto.randomUUID(),
      source: String(source || ''),
      ordinal: chunk.ordinal,
      heading: chunk.heading,
      text: chunk.text,
      embedding: pack(vectors[i]),
      dims: embedder.dims,
      model: embedder.model,
      mtime: chunk.mtime ?? null,
    });
  }

  const store = getStore();
  for (const [path, rows] of byPath) await store.replaceDocChunks(userId, path, rows);
  return { files: byPath.size, chunks: flat.length, model: embedder.model };
}

// ── search ────────────────────────────────────────────────────────────

/**
 * Neighbouring chunks of the same file, merged.
 *
 * A question often straddles a chunk boundary, and returning chunks 4 and 5 of
 * the same document as two separate results wastes half the answer repeating
 * where it came from. Merging them also restores the sentence that the split cut
 * in half.
 */
function mergeAdjacent(hits) {
  const sorted = [...hits].sort((a, b) => a.path.localeCompare(b.path) || a.ordinal - b.ordinal);
  const merged = [];
  for (const hit of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.path === hit.path && hit.ordinal - last.lastOrdinal === 1) {
      last.text += `\n${hit.text}`;
      last.lastOrdinal = hit.ordinal;
      last.score = Math.max(last.score, hit.score);
      continue;
    }
    merged.push({ ...hit, lastOrdinal: hit.ordinal });
  }
  return merged.sort((a, b) => b.score - a.score);
}

const MAX_ANSWER_CHARS = 24_000;

export async function searchDocs(userId, { query, limit = 6, source = null }) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Give something to search for.');

  const embedder = await embedderFor(userId);
  if (!embedder) throw noEmbedder();

  const store = getStore();
  const rows = await store.docVectors(userId, embedder.model);
  if (!rows.length) {
    const sources = await store.docSources(userId);
    if (!sources.length) {
      return 'Nothing has been indexed yet. Use index_folder on a folder of the user\'s documents first, and tell them that is what you are about to do.';
    }
    return (
      `Nothing is indexed with ${embedder.model}, which is the embedding model this account's key provides. ` +
      `What is stored was indexed with ${sources.map((s) => s.model).join(', ')} — vectors from different models cannot be compared. ` +
      'Re-index those folders, or restore the provider key that was used before.'
    );
  }

  const { vectors } = await embed(userId, [text]);
  const needle = vectors[0];

  const wanted = Math.min(Math.max(Number(limit) || 6, 1), 20);
  // Over-fetch, because merging adjacent chunks collapses some of them.
  const scored = rows
    .map((row) => ({ id: row.id, path: row.path, score: dot(needle, unpack(row.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, wanted * 3);

  const full = await store.docChunks(userId, scored.map((s) => s.id));
  const byId = new Map(full.map((row) => [row.id, row]));

  let hits = scored
    .map((s) => {
      const row = byId.get(s.id);
      return row ? { ...s, ordinal: row.ordinal, heading: row.heading, text: row.text, source: row.source } : null;
    })
    .filter(Boolean);

  if (source) {
    const needleSource = String(source).toLowerCase();
    hits = hits.filter((h) => h.source.toLowerCase().includes(needleSource));
    if (!hits.length) return `Nothing indexed under a source matching "${source}".`;
  }

  const results = mergeAdjacent(hits).slice(0, wanted);

  // A weak best match is worth saying out loud. The model cannot see the scores
  // and will otherwise present the nearest paragraph in the corpus as an answer,
  // however unrelated it happens to be.
  const best = results[0]?.score ?? 0;
  const caveat =
    best < 0.3
      ? '\n\n[Nothing here matches the question closely — the best score was low. Say the documents do not seem to cover this rather than stretching these passages to fit.]'
      : '';

  let body = '';
  for (const [i, hit] of results.entries()) {
    const block =
      `## ${i + 1}. ${hit.path}${hit.heading ? ` — ${hit.heading}` : ''}  (${hit.score.toFixed(3)})\n${hit.text}\n\n`;
    if (body.length + block.length > MAX_ANSWER_CHARS) break;
    body += block;
  }

  return `${results.length} passage${results.length === 1 ? '' : 's'} for "${text}":\n\n${body.trim()}${caveat}`;
}

export async function listSources(userId) {
  const rows = await getStore().docSources(userId);
  if (!rows.length) return 'Nothing is indexed.';
  return rows
    .map(
      (r) =>
        `- ${r.source} — ${r.files} file${r.files === 1 ? '' : 's'}, ${r.chunks} passages, embedded with ${r.model}` +
        `, last indexed ${new Date(r.indexed_at).toLocaleString()}`,
    )
    .join('\n');
}

export async function forgetSource(userId, source) {
  const removed = await getStore().deleteDocs(userId, source || null);
  if (!removed) return source ? `Nothing was indexed under "${source}".` : 'There was nothing indexed to forget.';
  return source
    ? `Forgot ${removed} passages from "${source}". The files themselves are untouched.`
    : `Forgot every indexed document — ${removed} passages. The files themselves are untouched.`;
}
