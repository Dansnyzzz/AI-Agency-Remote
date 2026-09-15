import { vi } from './vi.js';

/**
 * The server's own sentences, in the reader's language.
 *
 * Everything the server says — an HTTP error, a status line while a turn runs,
 * the help text beside a connector — is authored in English next to the code
 * that decides it. Translating at each of those call sites would mean threading
 * a language through every function that can throw. Instead the English stays
 * where it is written, and the translation happens at the few places a sentence
 * leaves the server for a person: the `error` field of a JSON response, the
 * events of the agent stream, and the handful of payloads that carry help text.
 *
 * The dictionary is keyed by the sentence's *shape*: the English with `{0}`,
 * `{1}` … where the code interpolates a value. `scripts/server-messages.js` reads
 * those shapes straight out of the source, and `test/i18n.test.mjs` fails when a
 * sentence has no translation — so a new message cannot ship English-only
 * without somebody noticing.
 *
 * An interpolated value is translated too when it is itself a known sentence,
 * which is what makes "{0}: {1} stopped mid-answer" come out whole.
 *
 * Anything not in the dictionary passes through unchanged. A provider's own
 * error text, a filename, a model's words: those are data, and are never the
 * server's to rephrase.
 */

export const SERVER_LANGUAGES = new Set(['en', 'vi']);
const DICTIONARIES = { vi };

/** Escape a string for use inside a RegExp. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One compiled table per language: exact sentences in a Map, shapes with holes
 * as anchored patterns, longest first so a specific shape wins over a general
 * one that would also match ("{0} returned HTTP {1}: {2}" before "{0}").
 */
const compiled = new Map();
function tableFor(language) {
  if (compiled.has(language)) return compiled.get(language);
  const dictionary = DICTIONARIES[language] || {};
  const exact = new Map();
  const shapes = [];
  for (const [english, translated] of Object.entries(dictionary)) {
    if (!/\{\d+\}/.test(english)) {
      exact.set(english, translated);
      continue;
    }
    const order = [];
    const source = english
      .split(/(\{\d+\})/)
      .map((part) => {
        const hole = part.match(/^\{(\d+)\}$/);
        if (!hole) return escapeRegExp(part);
        order.push(Number(hole[1]));
        return '([\\s\\S]*?)';
      })
      .join('');
    // A shape that is nothing but holes would match every sentence.
    if (!english.replace(/\{\d+\}/g, '').trim()) continue;
    shapes.push({ pattern: new RegExp(`^${source}$`), order, translated, weight: english.length });
  }
  shapes.sort((a, b) => b.weight - a.weight);
  const table = { exact, shapes };
  compiled.set(language, table);
  return table;
}

/**
 * Translate one server sentence.
 *
 * @param {unknown} text      the English, as the server wrote it
 * @param {string} language   the reader's language; English is returned as is
 * @param {number} [depth]    guards the recursion into interpolated values
 */
export function translateMessage(text, language, depth = 0) {
  if (typeof text !== 'string' || !text || language === 'en' || !DICTIONARIES[language] || depth > 3) return text;
  const { exact, shapes } = tableFor(language);

  const whole = exact.get(text) ?? exact.get(text.trim());
  if (whole != null) return whole;

  for (const { pattern, order, translated } of shapes) {
    const match = text.match(pattern);
    if (!match) continue;
    const values = {};
    order.forEach((index, position) => {
      values[index] = translateMessage(match[position + 1], language, depth + 1);
    });
    return translated.replace(/\{(\d+)\}/g, (hole, index) => (index in values ? values[index] : hole));
  }
  return text;
}

/**
 * The language a request asked for.
 *
 * Sent by the browser on every call as `X-Language`, because the interface
 * already knows it before the account preference has loaded — and a sign-in
 * error, which is exactly when there is no account yet, still arrives in the
 * right language. Anything unrecognised is English.
 */
export function languageOf(req) {
  const asked = String(req.get?.('x-language') || '').toLowerCase().split('-')[0];
  return SERVER_LANGUAGES.has(asked) ? asked : 'en';
}

/**
 * Express middleware: every JSON response's `error` string is translated.
 *
 * `res.json` is wrapped rather than each route edited, so a route added
 * tomorrow is covered without anyone remembering to be. Only the `error` field:
 * a success payload's strings are the user's own data and are left alone.
 */
export function translateErrors(req, res, next) {
  const language = languageOf(req);
  req.language = language;
  if (language !== 'en') {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        body = { ...body, error: translateMessage(body.error, language) };
      }
      return json(body);
    };
  }
  next();
}

/** The fields of a stream event that are sentences for a person. */
const EVENT_FIELDS = ['message', 'reason', 'detail'];

/** Translate the human-readable fields of one agent-stream event. */
export function translateEvent(data, language) {
  if (language === 'en' || !data || typeof data !== 'object') return data;
  let out = data;
  for (const field of EVENT_FIELDS) {
    if (typeof data[field] === 'string') {
      if (out === data) out = { ...data };
      out[field] = translateMessage(data[field], language);
    }
  }
  if (data.stop && typeof data.stop === 'object') {
    out = out === data ? { ...data } : out;
    out.stop = translateEvent(data.stop, language);
  }
  // An approval prompt names why each action needs a yes.
  if (Array.isArray(data.toolCalls)) {
    out = out === data ? { ...data } : out;
    out.toolCalls = data.toolCalls.map((call) =>
      call && typeof call.reason === 'string' ? { ...call, reason: translateMessage(call.reason, language) } : call,
    );
  }
  return out;
}
