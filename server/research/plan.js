import { askModel, extractJson } from './llm.js';

const SYSTEM = [
  'You are a research planner. Break the question into 4 to 6 web-search queries',
  'that together cover it from different angles — different wordings, sub-questions,',
  'and the specific facts a good answer would need. Prefer queries that would reach',
  'primary and reputable sources over ones that would reach opinion.',
  '',
  'Reply with JSON only, no prose: {"queries": ["...", "..."]}',
].join('\n');

/** The queries out of the model's JSON, or [] if there are none to find. */
export function parsePlan(text) {
  const json = extractJson(text);
  const queries = json?.queries;
  if (!Array.isArray(queries)) return [];
  return queries.map((q) => String(q || '').trim()).filter(Boolean);
}

/**
 * Decompose a question into search queries with one model call.
 *
 * Searching several angles beats searching once and concluding — it is what
 * turns "look it up" into "cross-check". On unparseable output it retries once
 * (models sometimes answer in prose the first time and JSON the second), then
 * falls back to the question itself, so the run always has something to search
 * rather than stalling on a formatting slip.
 */
export async function planQuestions(question, { userId, entry, stream, budget, signal, chatId = null }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // `low` effort on purpose: this turns one question into a handful of search
    // queries. It is a rewriting job, not a reasoning one, and paying for deep
    // thinking on it buys nothing measurable.
    const text = await askModel({
      userId, entry, system: SYSTEM, prompt: question, stream, budget, signal,
      chatId, role: 'research.plan', effort: 'low',
    });
    const queries = parsePlan(text);
    if (queries.length) return queries.slice(0, 6);
  }
  return [question];
}
