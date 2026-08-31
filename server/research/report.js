import { grade } from './confidence.js';

/** The S# ids a line cites, in order. */
export function markerIds(text) {
  return [...String(text || '').matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
}

/**
 * Assemble the final report, and make the citation rule real rather than merely
 * requested.
 *
 * Every claim is graded from the markers it actually carries; a claim with no
 * `[S#]` marker is labelled `LOW — no source` instead of passing as ordinary
 * prose. This is the difference between telling the model "please don't
 * hallucinate" (which does nothing) and a system that can *see* when it did:
 * the uncited sentence still appears, but it appears flagged, so a reader — or
 * an audit — can tell what rests on evidence from what does not.
 *
 * @param claims [{ text, conflicting? }] — text carries the `[S#]` markers
 * @param ledger Map<id, { url, rank, title, published }>
 * @param status complete | budget | failed | aborted
 */
export function buildReport({ question, claims, ledger, status }) {
  const lines = [`# ${question}`, ''];
  if (status === 'budget') {
    lines.push('_Stopped at the token budget; this is what was gathered so far._', '');
  }

  lines.push('## Conclusions', '');
  for (const claim of claims || []) {
    const ids = markerIds(claim.text);
    const label = claim.conflicting ? 'CONFLICTING' : ids.length ? grade(ids, ledger) : 'LOW — no source';
    lines.push(`- ${claim.text}  \n  _confidence: ${label}_`);
  }
  if (!claims || !claims.length) lines.push('_No conclusion could be drawn from the evidence gathered._');

  lines.push('', '## Sources', '');
  if (ledger.size === 0) {
    lines.push('_No sources were found. Treat every conclusion above as unverified._');
  } else {
    for (const [id, s] of ledger) {
      lines.push(`- **${id}** ${s.title || s.url} — ${s.url}${s.published ? ` (${s.published})` : ''}`);
    }
  }
  return lines.join('\n');
}
