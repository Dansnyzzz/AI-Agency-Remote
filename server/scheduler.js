import { log } from './util/trace.js';
import crypto from 'node:crypto';
import { getStore, isServerless } from './store/index.js';
import { getPrefs } from './settings.js';
import { runAgent, deriveTitle } from './agent.js';
import { redactSecrets } from './redact.js';

/**
 * Work that happens without anyone watching.
 *
 * "Summarise the campaign every Friday at 5." The task runs as a normal agent
 * turn in a conversation of its own, so the result is somewhere you can read it
 * and carry on from — not a notification with no context behind it.
 *
 * The clock is deliberately simple: a time of day, optionally pinned to one
 * weekday. Real cron expressions are powerful and almost nobody writes them
 * correctly, and everything this is for is "every day at" or "every Monday at".
 *
 * It is, however, the *user's* clock. "17:00" used to mean 17:00 wherever the
 * server happened to be standing — UTC on a deployment — so somebody in Vietnam
 * asking for five in the afternoon got midnight, silently, forever. Each task
 * now records the zone it was written in.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// ── time in somebody else's zone ──────────────────────────────────────
//
// No dependency needed: `Intl` already knows every zone and every DST rule the
// platform does. The only trick is that it converts one way — instant to wall
// clock — and a schedule needs the other way round.

/** Is this a zone the platform actually recognises? */
export function validZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading in `tz` at a given instant. */
function partsIn(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const out = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') out[type] = Number(value);
  }
  // Some platforms render midnight as hour 24 under hour12:false.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(date, tz) {
  const p = partsIn(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * A wall-clock reading in `tz` → the instant it names.
 *
 * Two passes, because the offset has to be sampled at the answer rather than at
 * the guess: on the night the clocks move, those are an hour apart and a single
 * pass lands an hour out.
 */
function instantOf({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const once = guess - offsetAt(new Date(guess), tz);
  return new Date(guess - offsetAt(new Date(once), tz));
}

/**
 * Parse "17:00" or "fri 17:00" into the next moment it means.
 *
 * @param tz  IANA zone the time is written in. Omitted, it falls back to the
 *            server's own clock — which is only ever right by luck, so callers
 *            that have the user's zone should pass it.
 * @returns {{ cron: string|null, nextRunAt: string }} cron is null for a
 *   one-off, which is what makes it retire after running.
 */
export function parseSchedule(input, { once = false, from = new Date(), tz = null } = {}) {
  const text = String(input || '').trim().toLowerCase();

  const parts = text.split(/\s+/);
  const time = parts.pop() || '';
  const day = parts.pop() || '';

  const match = TIME.exec(time);
  if (!match) {
    throw new Error('Give a time as HH:MM, optionally with a weekday first — "17:00" or "fri 17:00".');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  let weekday = -1;
  if (day) {
    weekday = WEEKDAYS.indexOf(day.slice(0, 3));
    if (weekday < 0) throw new Error(`"${day}" is not a weekday. Use mon, tue, wed, thu, fri, sat or sun.`);
  }

  const cron = once ? null : weekday >= 0 ? `${WEEKDAYS[weekday]} ${time}` : time;
  const zone = validZone(tz) ? tz : null;

  if (!zone) {
    // Server-local fallback, unchanged, for callers with no zone to offer.
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hour, minute);
    if (next <= from) next.setDate(next.getDate() + 1);
    if (weekday >= 0) {
      while (next.getDay() !== weekday) next.setDate(next.getDate() + 1);
    }
    return { cron, nextRunAt: next.toISOString() };
  }

  // Walk the calendar in the user's own zone rather than adding 24h to a
  // timestamp: "the same time tomorrow" is a calendar operation, and arithmetic
  // on the instant drifts by an hour across a daylight-saving change.
  const today = partsIn(from, zone);
  const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day));

  for (let i = 0; i < 8; i += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const date = cursor.getUTCDate();
    const at = instantOf({ year, month, day: date, hour, minute }, zone);

    if (at > from && (weekday < 0 || cursor.getUTCDay() === weekday)) {
      return { cron, nextRunAt: at.toISOString() };
    }
    cursor.setUTCDate(date + 1);
  }

  // Unreachable for any real weekday — eight days always contains one of each.
  throw new Error(`Could not find a time matching "${input}" in ${zone}.`);
}

/** When a repeating task should run again after firing now. */
function advance(cron, after = new Date(), tz = null) {
  if (!cron) return null;
  // A minute past is the floor; parseSchedule then walks forward to the weekday.
  const from = new Date(after.getTime() + 60_000);
  return parseSchedule(cron, { from, tz }).nextRunAt;
}

/**
 * Run one task to completion in its own conversation.
 *
 * Errors are recorded rather than thrown: a scheduler that dies because one
 * task failed stops running every other task too.
 */
async function runTask(task) {
  const store = getStore();
  const user = await store.getUserById(task.user_id);
  // The account was deleted between the claim and now. Retire the task rather
  // than leaving it to be re-claimed and fail identically every hour.
  if (!user) {
    await store.finishTask(task.id, { status: 'error: account no longer exists', chatId: null, nextRunAt: null });
    return { taskId: task.id, status: 'orphaned', chatId: null };
  }

  const prefs = await getPrefs(user.id);
  const chatId = crypto.randomUUID();
  let status = 'ok';

  try {
    await store.createChat(user.id, {
      id: chatId,
      title: deriveTitle(task.title) || task.title,
      model: task.model || prefs.defaultModel,
    });
    await store.appendMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'user',
      text: task.prompt,
    });

    // No `emit` consumer here — nobody is watching. The transcript in the
    // database is the output, which is the point: it is waiting when you look.
    await runAgent({
      userId: user.id,
      user,
      chatId,
      modelId: task.model || prefs.defaultModel,
      emit(event, data) {
        // Stored in last_status and shown in the interface, so a key quoted
        // back by a provider must not survive the trip.
        if (event === 'error') status = `error: ${redactSecrets(String(data?.message)).text.slice(0, 200)}`;
      },
    });
  } catch (err) {
    status = `error: ${redactSecrets(String(err?.message)).text.slice(0, 200)}`;
  }

  await store.finishTask(task.id, { status, chatId, nextRunAt: advance(task.cron, new Date(), task.tz) });
  return { taskId: task.id, status, chatId };
}

/**
 * Run everything that is due. Returns what it ran, so a cron endpoint can
 * report it and a test can assert on it.
 */
export async function runDueTasks({ limit = 5, userId = null } = {}) {
  const ran = [];
  for (let i = 0; i < limit; i += 1) {
    const task = await getStore().claimDueTask(new Date().toISOString(), userId);
    if (!task) break;
    ran.push(await runTask(task));
  }
  return ran;
}

/**
 * Catch-up for a deployment whose cron cannot fire often enough.
 *
 * Vercel's free tier allows one cron a day, which is not a scheduler: a task set
 * for this afternoon would otherwise wait until tomorrow. So opening the app
 * also nudges the queue along, for that account only.
 *
 * The awkward part is *where* this runs. The obvious version — kick it off
 * during `/bootstrap` and let the response go — does not work on a serverless
 * host: the instance is frozen once the response is sent, so a task could be
 * abandoned halfway through, having created its conversation, spent the tokens,
 * and written no answer. Worse, it would be re-run later and do it all again.
 *
 * So the browser calls this on its own endpoint and simply does not wait for the
 * reply. The request staying open is what keeps the function alive long enough
 * to finish honestly, and nobody is watching the response either way.
 *
 * @param userId  whose tasks — never a sweep of everybody's from a user request
 */
export async function runDueTasksForUser(userId, { limit = 2 } = {}) {
  if (!userId) return [];
  return runDueTasks({ limit, userId });
}

/**
 * Everything that has to be thrown away, in one place.
 *
 * Each of these had a function written for it and — for three of the four —
 * nothing that ever called it. That is the quiet kind of bug: the code reads as
 * though the tidying happens, the tables grow anyway, and nobody notices until
 * a database is unaccountably large.
 *
 *   rate_limits   expired throttle counters
 *   pairings      codes nobody claimed
 *   attachments   files picked, then thought better of, and never sent
 *   tool_jobs     the arguments and full output of every tool call ever made
 *
 * Failures are swallowed on purpose: housekeeping must never be the reason a
 * scheduler stops running work.
 */
export async function sweep() {
  const store = getStore();
  await Promise.allSettled([
    store.pruneRateLimits(),
    store.prunePairings(),
    store.pruneOrphanAttachments(),
    store.pruneFinishedJobs(),
    // Both write a few kilobytes per run and nothing was removing either. The
    // list above exists because three of its four pruners had been written and
    // never called; adding a fifth without calling it would be the same bug with
    // a different name.
    store.pruneWorkflowRuns(),
    store.pruneResearchRuns(),
  ]);
}

let timer = null;

/**
 * Poll for due work on a locally-run server.
 *
 * Serverless gets nothing here — there is no process to keep a timer in, so a
 * deployment schedules through the cron endpoint instead. A minute of latency
 * is irrelevant for something scheduled hours ahead.
 */
export function startScheduler() {
  if (timer || isServerless()) return;
  timer = setInterval(() => {
    runDueTasks().catch((err) => log.error('scheduled tasks failed', err));
    sweep();
  }, 60_000);
  timer.unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
