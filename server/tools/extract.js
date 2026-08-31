import { askModel, extractJson } from '../research/llm.js';

/**
 * Read a page for the few facts wanted, rather than pasting the page in.
 *
 * `web_fetch` is the right tool when the model needs to read something properly.
 * It is the wrong one for "what does this competitor charge": it drops up to
 * 20,000 characters — navigation, cookie notice, footer and all — into the
 * conversation, where it is then re-sent on every following turn. Five pages of
 * that and the transcript is mostly boilerplate, which on a free model's window
 * is the difference between finishing the job and running out of room.
 *
 * So the reading happens in a call of its own, and only the answer comes back.
 * The page never enters the conversation, and the reply names its source, so a
 * figure can be traced to where it was found.
 */

const SYSTEM = [
  'You read a web page and pull out exactly what was asked for. Nothing else.',
  '',
  'Rules that matter more than completeness:',
  '- Take only what is actually on the page. Never infer, estimate or fill a gap.',
  '- If what was asked for is not there, return an empty list. That is a useful',
  '  answer; a plausible invention is not.',
  '- Keep values as the page writes them — the price with its currency, the date',
  '  in its own form.',
  '',
  'Reply with JSON only: {"items": [ {...}, ... ]}. One object per thing found.',
].join('\n');

/** A compact, readable rendering of whatever the model returned. */
function present(url, what, json, raw) {
  const items = json?.items;
  if (Array.isArray(items)) {
    if (!items.length) {
      return `Nothing matching "${what}" is on ${url} — it is not on the page, so there is nothing to report.`;
    }
    return `From ${url} — ${what}:\n${JSON.stringify(items, null, 2)}`;
  }
  // Not the shape asked for: hand back what was said rather than losing it. The
  // model can still read prose; a thrown error would lose the work entirely.
  return `From ${url} — ${what}:\n${raw}`;
}

/**
 * @param fetchPage injectable page reader; defaults to the tool's own fetch.
 * @returns a string for the model: the structured findings, or a plain
 *   statement that the page does not contain them.
 */
export async function extractFromPage({ url, what, fields, userId, entry, stream, signal, fetchPage, budget }) {
  const target = String(url || '').trim();
  const wanted = String(what || '').trim();
  if (!target) throw new Error('Give the `url` of the page to read.');
  if (!wanted) throw new Error('Say what to extract, in `what` — for example "the plans and their prices".');
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`"${target}" is not an http(s) URL. This reads web pages, not local files.`);
  }

  // A fetch failure is the caller's to hear: "the page would not load" and "the
  // page does not say" are different answers and must not be confused.
  const text = await fetchPage(target);

  const shape = Array.isArray(fields) && fields.length
    ? `\n\nEach item should have these keys: ${fields.map((f) => String(f)).join(', ')}.`
    : '';
  const prompt = `Page: ${target}\n\nExtract: ${wanted}${shape}\n\n--- page text ---\n${text}`;

  const reply = await askModel({ userId, entry, system: SYSTEM, prompt, stream, budget, signal });
  return present(target, wanted, extractJson(reply), reply);
}
