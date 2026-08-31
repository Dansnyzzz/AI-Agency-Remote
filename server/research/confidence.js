/**
 * How much to trust a claim, decided by counting its sources rather than by
 * asking the model how sure it is.
 *
 * A model's self-reported confidence is famously worst-calibrated exactly when
 * it is confabulating — it says "I'm certain" in the same even tone whether it
 * is quoting a source or inventing one. Counting independent sources is an
 * objective fact about the evidence instead, and independence is by registrable
 * domain, so two pages of the same outlet do not double-count as agreement.
 *
 * CONFLICTING is not decided here: the grader can only count, not tell whether
 * sources agree. The debate marks a claim conflicting and the report carries
 * that label through, which keeps this function pure and testable.
 */

const RANK_ORDER = { primary: 3, reputable: 2, blog: 1, social: 0 };

/**
 * The domain two sources count as independent by — roughly the last two labels.
 *
 * A deliberate approximation: a true public-suffix list would pull in a
 * dependency and a megabyte of data to tell `co.uk` from `com`, and for
 * weighting evidence "reuters.com vs wordpress.com" is all that is needed. The
 * cost of the approximation is that `a.co.uk` and `b.co.uk` read as the same
 * registrable domain, which is the safe direction: it under-counts independence
 * rather than over-counting it.
 */
export function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  } catch {
    return String(url || '');
  }
}

/**
 * @param sourceIds ids the claim cites
 * @param ledger    Map<id, { url, rank }> — rank is primary|reputable|blog|social
 * @returns HIGH | MEDIUM | LOW
 */
export function grade(sourceIds, ledger) {
  const rows = (sourceIds || []).map((id) => ledger.get(id)).filter(Boolean);
  if (!rows.length) return 'LOW';

  const domains = new Set(rows.map((r) => registrableDomain(r.url)));
  const strong = rows.filter((r) => (RANK_ORDER[r.rank] ?? 0) >= RANK_ORDER.reputable);
  const strongDomains = new Set(strong.map((r) => registrableDomain(r.url)));

  // Two independent sources of real standing agreeing is the bar for HIGH.
  if (strongDomains.size >= 2) return 'HIGH';
  // One solid source, or several weak ones from different places, is MEDIUM.
  if (strong.length >= 1 || domains.size >= 2) return 'MEDIUM';
  return 'LOW';
}
