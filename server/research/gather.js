import { search as defaultSearch } from '../search.js';
import { registrableDomain, RANK_ORDER } from './confidence.js';

/**
 * Which outlets carry the standing that lets two of them make a claim HIGH.
 *
 * This was twelve Anglophone outlets and nothing else. `grade()` awards HIGH
 * only on two independent sources ranked `reputable` or better that were
 * actually opened, and every host not on the list ranks `blog` — so a claim
 * confirmed by VnExpress, Tuổi Trẻ and Thanh Niên, all fetched and read, was
 * capped at MEDIUM, while the same claim from two Reuters pages was HIGH
 * (ACC-006). For an app whose interface ships in Vietnamese and whose clients'
 * questions are largely about a Vietnamese market, the grader was marking down
 * exactly the sources most likely to be right about local facts, and a reader
 * seeing MEDIUM could not tell that apart from thin evidence.
 *
 * Two changes, and they are different kinds of change.
 *
 * `REGIONAL` is a judgement, and it is stated as one: the national wire service
 * (VNA) and the major national dailies and broadcasters, chosen by the same test
 * the comment on `rankSource` gives — does it carry the weight of a wire service
 * or a major outlet, or is it a blog. The owner of a deployment is better placed
 * to make that call than this file is, which is the reason for the second change.
 *
 * `RESEARCH_REPUTABLE_DOMAINS` adds registrable domains, comma-separated, without
 * editing code. A market this list does not know about needs a line in `.env`,
 * not a release.
 */
const GLOBAL = [
  'reuters.com', 'apnews.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com', 'wsj.com',
  'ft.com', 'economist.com', 'nature.com', 'science.org', 'bloomberg.com', 'theguardian.com',
];
const REGIONAL = [
  // Vietnam: the national news agency, then national dailies and broadcasters.
  'vnanet.vn', 'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'vietnamnet.vn',
  'nhandan.vn', 'vtv.vn', 'vov.vn', 'baochinhphu.vn', 'vneconomy.vn',
];
const configured = () =>
  String(process.env.RESEARCH_REPUTABLE_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
// Read per call rather than frozen at import, so a changed setting takes effect
// without depending on module load order — the import-time freeze this audit
// found twice elsewhere.
const reputable = () => new Set([...GLOBAL, ...REGIONAL, ...configured()]);
const PRIMARY = /(^|\.)gov($|\.)|(^|\.)edu($|\.)|europa\.eu$|who\.int$|arxiv\.org$/;
const SOCIAL = /(^|\.)(twitter|x|reddit|facebook|instagram|tiktok|medium)\.com$/;

/**
 * A coarse authority guess from the host — enough to weight evidence, never to
 * trust it blindly.
 *
 * The ranks feed `grade`, which is why the classes are deliberately broad:
 * "does this carry the weight of a wire service or a government, or is it a
 * blog" is a judgement a hostname can support; anything finer would be pretending
 * to a precision the host does not carry. Unknown hosts are `blog`, the cautious
 * default, so an unrecognised source never inflates a confidence score.
 */
export function rankSource(url) {
  const d = registrableDomain(url);
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return d;
    }
  })();
  if (PRIMARY.test(host)) return 'primary';
  if (reputable().has(d)) return 'reputable';
  if (SOCIAL.test(host)) return 'social';
  return 'blog';
}

/**
 * Run every query and fold the results into one ledger, deduped by url so a
 * source cited twice does not count as two independent ones. Each source keeps
 * a stable `S#` id that the draft cites and the report lists.
 *
 * A search that throws does not stop the run — it becomes a finding that records
 * why, so a missing engine reads as "this angle found nothing" rather than
 * taking the whole question down with it.
 *
 * @param search injectable; defaults to the real four-engine chain.
 * @returns { ledger: Map<id,{url,rank,title,published,snippet}>, findings: [{id,query,snippet}] }
 */
/**
 * How many of the gathered sources are actually opened and read.
 *
 * Reading costs a fetch each and a great deal of prompt, so this is not "all of
 * them". Three is enough to corroborate a claim across independent domains,
 * which is what the confidence grader is looking for, and small enough that a
 * run does not turn into a crawl.
 */
const READ_LIMIT = 3;

/** How much of each page travels into the debate. Whole articles do not. */
const BODY_CHARS = 4000;

/**
 * Open the best few sources and keep what they actually say.
 *
 * Everything here used to be the search engine's own blurb. The report cited a
 * URL for every claim and no page behind any of those URLs was ever opened, so
 * "two independent reputable sources" meant two snippets from two domains — and
 * a snippet is written to make you click, not to be accurate.
 *
 * Failures are recorded on the source rather than dropped, because "the page
 * would not load" and "the page does not say" are different answers and the
 * grader has to be able to tell them apart.
 */
async function readSources(ledger, readPage) {
  if (typeof readPage !== 'function') return;

  const best = [...ledger.entries()]
    .sort(([, a], [, b]) => (RANK_ORDER[b.rank] ?? 0) - (RANK_ORDER[a.rank] ?? 0))
    .slice(0, READ_LIMIT);

  await Promise.all(
    best.map(async ([, source]) => {
      try {
        const text = await readPage(source.url);
        const body = String(text || '').trim();
        if (body) {
          source.body = body.slice(0, BODY_CHARS);
          source.read = true;
        } else {
          source.readError = 'the page returned nothing';
        }
      } catch (err) {
        source.readError = err?.message || 'the page could not be read';
      }
    }),
  );
}

export async function gatherEvidence(queries, { search = defaultSearch, readPage, userId = null } = {}) {
  const ledger = new Map();
  const byUrl = new Map();
  const findings = [];
  let n = 0;

  for (const query of queries) {
    let out;
    try {
      out = await search(query, { userId });
    } catch (err) {
      findings.push({ id: null, query, snippet: `(search failed: ${err.message})` });
      continue;
    }
    for (const r of out.results || []) {
      let id = byUrl.get(r.url);
      if (!id) {
        id = `S${(n += 1)}`;
        byUrl.set(r.url, id);
        ledger.set(id, {
          url: r.url,
          rank: rankSource(r.url),
          title: r.title || undefined,
          published: r.published || undefined,
          snippet: r.snippet || '',
        });
      }
      findings.push({ id, query, snippet: r.snippet });
    }
  }

  await readSources(ledger, readPage);

  return { ledger, findings };
}
