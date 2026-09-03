import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { redactSecrets } from '../redact.js';
import { readSkill, saveSkill } from '../skills.js';
import { runParallel } from '../subagents.js';
import { runDeepResearch } from '../research/index.js';
import { renderChart } from './chart.js';
import { evaluate } from './calc.js';
import { extractFromPage } from './extract.js';
import { resolveForUser } from '../autoPick.js';
import { parseSchedule } from '../scheduler.js';
import { normaliseSteps } from '../workflows.js';
import { CONNECTOR_CALLS } from '../connectors.js';
import { getPrefs, getApiKey } from '../settings.js';
import { sendEmail, emailBackend } from '../email.js';
import { safeFetch } from '../util/safeFetch.js';
import { searchDocs, listSources, forgetSource } from '../rag.js';
import { createDocument, extensionOf } from '../office/index.js';
import { saveGenerated } from '../attachments.js';
import { search, formatResults } from '../search.js';
import { untrusted } from './untrusted.js';
// Only to tell a real tool name from one the model invented — see loadToolsTool.
import { TOOLS_BY_NAME } from './definitions.js';

const MEMORY_KEY = 'memory';

/** Crude but dependency-free HTML → text. Good enough to feed a model. */
function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Refuse a response too large to hold in memory before reading a byte of it. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read a response, and stop reading at the cap.
 *
 * The `content-length` check above only catches a server that *says* how much it
 * is about to send. A chunked response declares nothing, and `res.text()` will
 * happily read gigabytes into memory before `max_chars` ever gets a chance to
 * clip it — so the limit that exists to protect the process was skipped by
 * precisely the responses most likely to need it. A model can be talked into
 * fetching any URL by the page it is reading, which makes this reachable rather
 * than theoretical.
 *
 * Truncating rather than throwing: most of a very long page is still a useful
 * answer, and `web_fetch` clips its output anyway.
 */
async function readCapped(res, host) {
  if (!res.body) return res.text();

  const decoder = new TextDecoder('utf-8');
  let read = 0;
  let text = '';
  try {
    for await (const chunk of res.body) {
      read += chunk.length;
      if (read > MAX_BODY_BYTES) {
        text += decoder.decode(chunk.subarray(0, chunk.length - (read - MAX_BODY_BYTES)));
        text += `\n\n[stopped reading — ${host} sent more than ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB]`;
        break;
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    // Let go of the connection rather than leaving it draining in the
    // background after we have stopped caring about it.
    res.body.destroy?.();
  }
  return text;
}

async function webFetch({ url, max_chars = 20000 }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }

  // `safeFetch` rather than `fetch`: the URL comes from a model, and a model
  // reads web pages that can tell it what to fetch next. Every hop is checked
  // against the private address ranges — cloud metadata and the local network
  // are not things this tool is for.
  const res = await safeFetch(parsed, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Remote/1.0)', Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${parsed.host} returned HTTP ${res.status} ${res.statusText}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error(`${parsed.host} returned ${declared} bytes, which is too large to read.`);
  }

  const type = res.headers.get('content-type') || '';
  const body = await readCapped(res, parsed.host);
  const text = /html/i.test(type) ? htmlToText(body) : body;
  const limit = Math.min(Math.max(Number(max_chars) || 20000, 500), 200_000);
  const clipped = text.slice(0, limit);

  return (
    `# ${parsed.href}\n\n` +
    // Wrapped, because this is the single most likely place for an instruction
    // aimed at the model to enter the conversation. See server/tools/untrusted.js.
    untrusted(parsed.href, clipped) +
    (text.length > limit ? `\n\n[truncated — ${text.length - limit} more characters]` : '')
  );
}

/**
 * Search, through the chain in `server/search.js`.
 *
 * One engine used to be the whole story, chosen by which key happened to be
 * set — so an expired key or a bad afternoon at one provider took the tool out
 * entirely, and the model had no way to tell that from "there is nothing about
 * this on the web". Now every engine is tried in turn and the answer says which
 * one spoke.
 */
async function webSearch({ query, count = 8 }) {
  return formatResults(query, await search(query, { count }));
}

/* ── documents the assistant makes ──────────────────────────────────── */

const humanSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/**
 * Write a document and put it in the conversation.
 *
 * The interesting return value is not the sentence — it is the `file`, which
 * travels out through the tool result and becomes a card the user can open and
 * download. The sentence exists so the model knows the id it will need to change
 * the thing later, and knows it does not have to repeat the document into its
 * reply.
 */
async function createFileTool({ name, format, content, title }, { userId, chatId }) {
  const built = createDocument({ format, name, content, title });
  const saved = await saveGenerated(userId, {
    name: built.name,
    mime: built.mime,
    data: built.buffer.toString('base64'),
    source: built.source,
    chatId,
  });

  return {
    content:
      `Created ${saved.name} (${humanSize(saved.bytes)}). It is in the conversation now — the user can open it ` +
      'in the viewer and download it, so do not paste its contents into your reply. ' +
      `Its id is ${saved.id}; pass that to update_file to change this same file rather than making a second one.`,
    file: { id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes, format: built.format },
  };
}

async function updateFileTool({ file_id: fileId, content, name }, { userId }) {
  const store = getStore();
  const existing = await store.getAttachment(userId, fileId);
  if (!existing) throw new Error(`There is no file with the id ${fileId} on this account.`);
  if (existing.origin !== 'generated') {
    throw new Error(`${existing.name} was uploaded by the user, not written by you, so it cannot be rewritten.`);
  }

  // The format belongs to the file, not to this call: renaming is allowed,
  // and "update it" must never quietly turn a .docx into a .md.
  const format = extensionOf(existing.name);
  const built = createDocument({ format, name: name || existing.name, content });

  const saved = await store.replaceAttachment(userId, fileId, {
    data: built.buffer.toString('base64'),
    bytes: built.buffer.length,
    source: built.source,
    name: built.name,
    mime: built.mime,
  });
  if (!saved) throw new Error('That file could not be updated.');

  return {
    content: `Rewrote ${saved.name} (${humanSize(saved.bytes)}). Same file, same id — the viewer shows the new version.`,
    file: {
      id: saved.id,
      name: saved.name,
      mime: saved.mime,
      kind: saved.kind,
      bytes: saved.bytes,
      format,
      // Bumped so the browser fetches the new bytes rather than the cached ones.
      version: Date.now(),
    },
  };
}

async function readGeneratedFileTool({ file_id: fileId }, { userId, chatId }) {
  const store = getStore();

  if (!fileId) {
    const files = await store.listGeneratedFiles(userId, chatId);
    if (!files.length) return 'No documents have been made in this conversation yet.';
    return files.map((file) => `- ${file.name} (${humanSize(file.bytes)}) — id ${file.id}`).join('\n');
  }

  const file = await store.getAttachment(userId, fileId);
  if (!file) throw new Error(`There is no file with the id ${fileId} on this account.`);
  if (file.origin !== 'generated') throw new Error(`${file.name} was uploaded, so it has no source to read back.`);
  if (!file.source) return `${file.name} has no stored source.`;
  return `--- source of ${file.name} ---\n${file.source}`;
}

/**
 * The drafts of a file, and going back to one.
 *
 * `update_file` keeps the file's id and files the outgoing copy as a version,
 * which the panel has shown since it started doing so. The assistant could not
 * see any of it — so "put the figure back to what it was before" meant
 * reconstructing the document from the conversation and hoping, when the exact
 * bytes were sitting in the database the whole time.
 */
async function fileVersionsTool({ file_id: fileId, revision, restore }, { userId }) {
  const store = getStore();

  const file = await store.getAttachment(userId, fileId);
  if (!file) throw new Error(`There is no file with the id ${fileId} on this account.`);
  if (file.origin !== 'generated') {
    throw new Error(`${file.name} was uploaded, so it has no version history — only files you made do.`);
  }

  const past = await store.listAttachmentVersions(userId, fileId);
  const live = past.length + 1;

  if (revision == null) {
    if (!past.length) return `${file.name} has only ever had one version — nothing has been rewritten yet.`;
    return [
      `${file.name} has ${live} versions:`,
      `- v${live} — the current one, ${humanSize(file.bytes)}`,
      ...past.map((v) => `- v${v.revision} — ${humanSize(v.bytes)}, saved ${new Date(v.created_at).toISOString()}`),
      '',
      'Pass revision to read one, and restore: true to put it back.',
    ].join('\n');
  }

  const wanted = Number(revision);
  if (wanted === live) return `v${live} is the current version. read_generated_file gives you its source.`;

  const copy = await store.getAttachmentVersion(userId, fileId, wanted);
  if (!copy) throw new Error(`${file.name} has no v${revision}. It has ${live} versions.`);

  if (!restore) {
    return copy.source
      ? `--- ${file.name} as it was at v${wanted} ---\n${copy.source}`
      : `v${wanted} of ${file.name} is ${humanSize(copy.bytes)} but has no stored source to show.`;
  }

  // Restoring is itself a rewrite, so what it replaces is kept in turn — going
  // backwards is never destructive, which is what makes it safe to offer.
  await store.replaceAttachment(userId, fileId, {
    data: copy.data,
    bytes: copy.bytes,
    source: copy.source,
    name: copy.name,
    mime: copy.mime,
  });
  return `${file.name} is back to what it was at v${wanted}. The copy that was current is kept as v${live}.`;
}

// Notes are per-account: one user's memory must never leak into another's
// context on the next conversation.
async function memoryWrite({ key, content }, { userId }) {
  const store = getStore();

  // A note outlives the conversation it came from and is read back into every
  // future one, so a credential that lands here keeps escaping. Strip them on
  // the way in, and say so rather than silently editing what was asked for.
  const { text, found } = redactSecrets(content);

  const memory = (await store.getUserSetting(userId, MEMORY_KEY)) || {};
  memory[key] = { content: text, updatedAt: new Date().toISOString() };
  await store.setUserSetting(userId, MEMORY_KEY, memory);

  if (!found.length) return `Saved note "${key}".`;
  return (
    `Saved note "${key}", with ${found.join(' and ')} removed first — notes are long-lived and ` +
    'credentials do not belong in them. Tell the user plainly that this was left out.'
  );
}

async function memoryRead({ key }, { userId }) {
  const memory = (await getStore().getUserSetting(userId, MEMORY_KEY)) || {};
  if (key) {
    const note = memory[key];
    return note ? note.content : `No note saved under "${key}".`;
  }
  const keys = Object.keys(memory);
  if (!keys.length) return 'No notes saved yet.';
  return keys.map((k) => `- ${k}: ${memory[k].content.slice(0, 120)}`).join('\n');
}

/**
 * Draw something in the transcript.
 *
 * The gap this fills: everything visual the assistant could make was a *file* —
 * something you open in the side panel, keep and download. Perfect for a report,
 * wrong for "here is the shape of what I found", which wants to be four
 * centimetres of picture inside the sentence it belongs to.
 *
 * The markup travels out on the tool result and is therefore stored with the
 * conversation, so reopening it a week later redraws the same picture rather than
 * needing a second source of truth. That is also why there is a size limit: this
 * is read back on every load of the conversation, and a megabyte of inline SVG
 * would be paid for every time.
 *
 * Sandboxed when it is drawn — see `widgetFrame` in render.js. This is markup a
 * model wrote, which is not the same as markup this repository wrote.
 */
const MAX_WIDGET_BYTES = 96 * 1024;

async function showWidgetTool({ title, svg, html }) {
  const caption = String(title || '').trim();
  if (!caption) throw new Error('Give the picture a short title, so it is labelled.');

  const markup = String(svg || html || '').trim();
  if (!markup) throw new Error('Give either `svg` or `html` to draw.');
  if (svg && html) {
    throw new Error('Give `svg` or `html`, not both — they are two different pictures.');
  }
  if (markup.length > MAX_WIDGET_BYTES) {
    throw new Error(
      `That is ${Math.round(markup.length / 1024)}KB of markup, over the ${MAX_WIDGET_BYTES / 1024}KB limit. ` +
        'A widget is re-read every time the conversation is opened. For something this large use `create_file` ' +
        'with format "html", which is a document rather than an inline picture.',
    );
  }
  if (svg && !/^<svg[\s>]/i.test(markup)) {
    throw new Error('`svg` has to start with an <svg> element. Use `html` for anything else.');
  }

  /**
   * Refuse what will not work rather than drawing a blank rectangle.
   *
   * The frame has no network and no parent access, so an external stylesheet or a
   * script tag is not a security problem here — it is simply a thing that will
   * silently do nothing, and a picture that renders empty is the hardest kind of
   * failure to diagnose from the other side.
   */
  if (/<script[\s>]/i.test(markup)) {
    throw new Error('A widget cannot run scripts. Draw the finished picture, or use `create_file` for something interactive.');
  }
  const external = markup.match(/(?:src|href)\s*=\s*["']?(https?:)?\/\//i);
  if (external) {
    throw new Error(
      'A widget cannot fetch anything — no images, fonts or stylesheets from the internet. ' +
        'Inline it, or draw it with shapes and text.',
    );
  }

  return {
    content:
      `Drew "${caption}" in the conversation. The user can see it, so describe what it shows rather than ` +
      'listing the numbers again.',
    widget: { title: caption, markup, kind: svg ? 'svg' : 'html' },
  };
}

/**
 * Add to a note without rewriting it.
 *
 * `memory_write` replaces, which makes a running list expensive and risky to keep:
 * the whole note has to be read back, re-sent and re-saved, and anything the model
 * has forgotten since is quietly lost. Appending is the operation a log actually
 * wants — decisions as they are made, facts as they turn up.
 */
/**
 * A chart from numbers, drawn in code.
 *
 * Goes out through the same widget channel as `show_widget`, so it inherits the
 * sandboxed frame and the sizing — the difference is who drew it. The model is
 * told what it shows rather than what it contains, so the reply describes the
 * picture instead of reciting the numbers a reader can already see.
 */
/**
 * Arithmetic, done rather than recalled.
 *
 * The answer comes back with the expression beside it so the working is on the
 * record: a number in a report should be checkable, and "the model said so" is
 * not a check.
 */
/**
 * Read a page for what was asked, on the account's own model.
 *
 * The page is fetched through the same `web_fetch` path, so it goes through
 * `safeFetch` and cannot be aimed at a private address any more than that one
 * can. What changes is where the text goes: into a call of its own rather than
 * into the conversation.
 */
async function extractTool({ url, what, fields }, { userId, chatId, signal }) {
  const prefs = await getPrefs(userId);
  const entry = await resolveForUser(userId, prefs.defaultModel, { vision: false });
  return extractFromPage({
    url,
    what,
    fields,
    userId,
    entry,
    signal,
    // So the spend lands against the conversation that caused it, the same way
    // an ordinary turn does — this call used to be booked nowhere at all.
    chatId,
    fetchPage: (target) => webFetch({ url: target, max_chars: 60000 }),
  });
}

/**
 * Hand the model tools it did not start the turn with.
 *
 * The work is done by the loop, not here: `runToolCalls` sees this call go
 * through and adds the names to the set that `availableTools` is rebuilt from,
 * so the schemas travel in the *next* request. No provider allows adding tools
 * to a request already in flight, and none needs to.
 *
 * What this returns is therefore only the acknowledgement — but it has to be an
 * honest one. A name that is not deferrable, or not a tool at all, is reported
 * rather than silently accepted, because the alternative is a model that
 * believes it now has something it will never be given and plans around it.
 */
async function loadToolsTool({ names }, { deliverable = null } = {}) {
  const asked = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!asked.length) throw new Error('Give the `names` of the tools to load.');

  /**
   * A name has to be *deliverable*, not merely real.
   *
   * This checked `TOOLS_BY_NAME` alone, so a genuine tool that `availableTools`
   * withholds for this account — a connector that is not linked, a local tool
   * with no worker online, a desktop tool on a machine that has not opted in —
   * was answered "Loaded send_email, you will have it from your next step
   * onward" and then never appeared. The model planned around a capability it
   * was never going to receive, which is exactly what the note on the deferred
   * list says must not happen.
   *
   * `deliverable` is the set the loop is willing to activate, passed in by the
   * caller because only the loop knows this account's worker, connectors and
   * keys. Absent, the old behaviour stands — a caller that cannot say must not
   * have its answers silently narrowed.
   */
  const real = asked.filter((n) => TOOLS_BY_NAME[n]);
  const unknown = asked.filter((n) => !TOOLS_BY_NAME[n]);
  const known = deliverable ? real.filter((n) => deliverable.has(n)) : real;
  const withheld = real.filter((n) => !known.includes(n));

  const notes = [
    unknown.length ? `Not tools, and ignored: ${unknown.join(', ')}.` : '',
    withheld.length
      ? `Not available on this account and not loaded: ${withheld.join(', ')} — the service is not connected, or the computer that runs them is not online. Do not plan around them; say so if the user asks.`
      : '',
  ].filter(Boolean);

  if (!known.length) {
    return (
      `Nothing was loaded. ${notes.join(' ')} ` +
      'Use the names exactly as they appear in the list on this tool, or carry on with what you have.'
    ).trim();
  }

  return (
    `Loaded ${known.join(', ')} — you will have ${known.length === 1 ? 'it' : 'them'} from your next step onward, ` +
    'so make that call then rather than now.' +
    (notes.length ? ` (${notes.join(' ')})` : '')
  );
}

async function calculateTool({ expression }) {
  const { value, expression: shown } = evaluate(expression);
  return `${shown} = ${value}`;
}

async function chartTool({ title, type, data, format }) {
  const caption = String(title || '').trim();
  if (!caption) throw new Error('Give the chart a short title, so it is labelled.');
  const markup = renderChart({ type, title: caption, data, format });
  return {
    content:
      `Drew the ${type} chart "${caption}" in the conversation. The user can see it, so say what it shows — the ` +
      'comparison, the trend, the outlier — rather than listing the numbers again.',
    widget: { title: caption, markup, kind: 'svg' },
  };
}

async function memoryAppend({ key, content }, { userId }) {
  const store = getStore();
  const { text, found } = redactSecrets(content);
  if (!String(text || '').trim()) throw new Error('There is nothing to append.');

  const memory = (await store.getUserSetting(userId, MEMORY_KEY)) || {};
  const existing = memory[key]?.content || '';
  // A blank line between entries, so an appended list stays readable rather than
  // running together into one paragraph.
  memory[key] = {
    content: existing ? `${existing.replace(/\s+$/, '')}\n\n${text}` : text,
    updatedAt: new Date().toISOString(),
  };
  // Merged, not overwritten: the agent runs up to four tool calls at once, so
  // two memory writes in one step both read the same object and a whole-value
  // write meant the second silently erased the first — while both reported
  // success, so the model told the user two notes were saved when one was gone.
  await store.mergeUserSetting(userId, MEMORY_KEY, { [key]: memory[key] });

  const created = existing ? '' : ' (the note did not exist, so it was created)';
  if (!found.length) return `Appended to "${key}"${created}.`;
  return (
    `Appended to "${key}"${created}, with ${found.join(' and ')} removed first. ` +
    'Tell the user plainly that this was left out.'
  );
}

/**
 * Change one part of a note.
 *
 * The same reasoning as `edit_file` against `write_file`: correcting a phone number
 * in a page of project notes should not mean re-sending the page, and re-sending it
 * from memory is how the other nine facts get subtly rewritten.
 */
async function memoryEdit({ key, old_string: oldString, new_string: newString }, { userId }) {
  const store = getStore();
  const memory = (await store.getUserSetting(userId, MEMORY_KEY)) || {};
  const note = memory[key];
  if (!note) {
    const keys = Object.keys(memory);
    throw new Error(
      keys.length ? `No note saved under "${key}". There is: ${keys.join(', ')}.` : `No notes are saved on this account.`,
    );
  }

  const find = String(oldString ?? '');
  if (!find) throw new Error('Give the text to replace.');
  const occurrences = note.content.split(find).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `That text is not in "${key}". Read it back with memory_read first — it must match exactly.`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `That text appears ${occurrences} times in "${key}". Include more surrounding words so it matches once only.`,
    );
  }

  const { text, found } = redactSecrets(String(newString ?? ''));
  memory[key] = { content: note.content.replace(find, text), updatedAt: new Date().toISOString() };
  // Only this note, so a concurrent write to a different one is not undone.
  await store.mergeUserSetting(userId, MEMORY_KEY, { [key]: memory[key] });

  return found.length
    ? `Updated "${key}", with ${found.join(' and ')} removed from the replacement. Say so.`
    : `Updated "${key}".`;
}

async function memoryDelete({ key }, { userId }) {
  const store = getStore();
  const memory = (await store.getUserSetting(userId, MEMORY_KEY)) || {};
  if (!(key in memory)) {
    const keys = Object.keys(memory);
    throw new Error(
      keys.length
        ? `No note saved under "${key}". The notes on this account are: ${keys.join(', ')}.`
        : `No note saved under "${key}" — there are no notes on this account at all.`,
    );
  }

  // Removes the one entry in SQL rather than writing back a copy of the object
  // that happens to be missing it — which would undo anything saved meanwhile.
  await store.removeUserSettingKey(userId, MEMORY_KEY, key);
  return `Deleted the note "${key}". It will not be read into future conversations any more.`;
}

/**
 * Fewer steps than this is not a plan, and drawing one anyway is the failure
 * this guards against: the list is resent *in full* on every update, so a
 * one-item list means the whole job is one step. A checklist above a two-line
 * answer makes a small request look like a project and puts furniture between
 * the user and what they asked for.
 *
 * Two is deliberately permissive rather than three. The prompt asks the model to
 * judge where the line is, and a mechanism that overrules a defensible judgement
 * is worse than one that only catches what is unarguable.
 */
export const PLAN_MIN_STEPS = 2;

/**
 * The plan as the user should actually see it.
 *
 * Normalised rather than trusted, because the interface renders this directly
 * and both of these are cheap for a model to get wrong:
 *
 *   **Exactly one `in_progress`.** The tool description asks for it and models
 *   still mark three things as started at once. Somebody reading the panel to
 *   find out where you are then cannot, which is the only reason the panel
 *   exists. First one wins; the rest go back to pending.
 *
 *   **A status outside the enum**, or a step with no title, would otherwise
 *   render as a blank row or an unstyled one.
 *
 * Exported because the agent loop emits the event and this tool answers the
 * model — if those two normalised differently, the user and the model would be
 * looking at different plans.
 */
export function normalisePlan(steps) {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      status: ['pending', 'in_progress', 'done'].includes(s.status) ? s.status : 'pending',
    }));

  let running = false;
  for (const step of list) {
    if (step.status !== 'in_progress') continue;
    if (running) step.status = 'pending';
    running = true;
  }

  return list;
}

/**
 * The plan is a UI affordance — the useful output is the event the agent loop
 * emits, so the model only needs a short acknowledgement back.
 */
async function updatePlan({ steps }) {
  const list = normalisePlan(steps);

  // Said back plainly rather than silently ignored. A model that gets "Plan
  // updated" for a plan nobody drew will keep sending it, and will describe a
  // checklist the user cannot see.
  if (list.length < PLAN_MIN_STEPS) {
    return (
      'No plan was shown — a checklist needs at least two steps to earn its space, ' +
      'and a job this short is quicker to simply do. Carry on and answer directly.'
    );
  }

  const done = list.filter((s) => s.status === 'done').length;
  const running = list.find((s) => s.status === 'in_progress');
  return (
    `Plan updated (${done}/${list.length} done)` +
    (running ? `, now on "${running.title}".` : '.')
  );
}

// ── skills, delegation, schedules, connected services ─────────────────

async function skillRead({ name }, { userId }) {
  return readSkill(userId, name);
}

async function skillWrite({ name, description, instructions }, { userId }) {
  const saved = await saveSkill(userId, { name, description, instructions });
  return `Saved the skill "${saved.name}". It will be offered to you in future conversations.`;
}

async function runParallelTool({ tasks }, { user, chatId, signal }) {
  return runParallel({ user, chatId, tasks, signal });
}

async function deepResearchTool({ question }, { userId, user, chatId, signal }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Give a question to research.');
  const { content } = await runDeepResearch({
    question: q,
    userId,
    user,
    chatId,
    signal,
    // The research pass reads its best few sources rather than trusting the
    // search engine's blurb. Passed in from here because web_fetch lives in
    // this file and importing it the other way would close a cycle. It is the
    // same guarded reader the model gets: safeFetch, so a page cannot redirect
    // the run at the local network or the cloud metadata service.
    deps: { readPage: (target) => webFetch({ url: target, max_chars: 12_000 }) },
  });
  return content;
}

/**
 * "17:00" means the user's five o'clock, not the server's.
 *
 * The HTTP routes have always taken the zone from the browser. This tool had
 * no way to, so `parseSchedule` fell back to the server clock — UTC on a
 * deployment — and a task set for five in the afternoon in Vietnam fired at
 * midnight, silently, for ever. The zone is recorded on the account at
 * bootstrap now, so the tool path and the route path finally agree.
 *
 * The confirmation is rendered in that same zone. It previously used the
 * server's, so it stated a time that was not the one that would fire — which is
 * worse than saying nothing, because it looks like it has been checked.
 */
async function scheduleTaskTool({ title, prompt, when, repeat = true }, { userId }) {
  const prefs = await getPrefs(userId);
  const tz = prefs.timezone || null;
  const { cron, nextRunAt } = parseSchedule(when, { once: repeat === false, tz });

  const task = await getStore().createTask(userId, {
    id: crypto.randomUUID(),
    title,
    prompt,
    model: prefs.defaultModel,
    cron,
    nextRunAt,
    tz,
  });

  const at = new Date(task.next_run_at).toLocaleString('en-GB', tz ? { timeZone: tz } : undefined);
  const where = tz ? ` (${tz})` : ' — server time, because this account has not told us its timezone';
  return cron
    ? `Scheduled "${title}" for ${cron}. First run: ${at}${where}.`
    : `Scheduled "${title}" to run once at ${at}${where}.`;
}

async function listTasksTool(_input, { userId }) {
  const tasks = await getStore().listTasks(userId);
  if (!tasks.length) return 'Nothing is scheduled on this account.';

  return [
    'Scheduled work on this account:',
    '',
    ...tasks.map((t) => {
      const when = t.cron ? `repeats ${t.cron}` : 'runs once';
      const next = t.next_run_at ? new Date(t.next_run_at).toISOString() : 'unknown';
      const last = t.last_run_at
        ? `last run ${new Date(t.last_run_at).toISOString()} (${t.last_status || 'no status'})`
        : 'never run';
      return [
        `- ${t.title} — id ${t.id}`,
        `    ${when}${t.enabled ? '' : ' (disabled)'}, next ${next}, ${last}`,
        `    prompt: ${String(t.prompt || '').replace(/\s+/g, ' ').slice(0, 160)}`,
      ].join('\n');
    }),
    '',
    'Pass an id to cancel_task to delete one.',
  ].join('\n');
}

async function cancelTaskTool({ id }, { userId }) {
  const store = getStore();
  // Checked first so a wrong id says so, rather than reporting success for a
  // delete that matched nothing — which is how somebody ends up believing a
  // daily job was stopped while it keeps running.
  const tasks = await store.listTasks(userId);
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    throw new Error(
      tasks.length
        ? `There is no scheduled task with the id "${id}". Call list_tasks to see what is there.`
        : 'There is nothing scheduled on this account to cancel.',
    );
  }

  await store.deleteTask(userId, id);
  return `Deleted the scheduled task "${task.title}". It will not run again.`;
}

/**
 * Create, change or delete a workflow.
 *
 * One tool for three verbs because the catalogue is charged against every
 * request's context window; see the note beside the definition.
 */
async function workflowWriteTool({ action, id, title, steps, when, repeat, enabled }, { userId }) {
  const store = getStore();

  if (action === 'delete') {
    // Checked first, the same way cancel_task is: reporting success for a delete
    // that matched nothing is how somebody comes to believe a job was stopped
    // while it keeps running.
    const workflow = id ? await store.getWorkflow(userId, id) : null;
    if (!workflow) throw new Error(`There is no workflow with the id "${id}". Call workflow_status to see them.`);
    await store.deleteWorkflow(userId, id);
    return `Deleted the workflow "${workflow.title}". It will not run again.`;
  }

  if (action === 'update') {
    const existing = id ? await store.getWorkflow(userId, id) : null;
    if (!existing) throw new Error(`There is no workflow with the id "${id}". Call workflow_status to see them.`);

    const patch = {};
    if (title !== undefined) patch.title = String(title).trim() || existing.title;
    if (steps !== undefined) patch.steps = normaliseSteps(steps);
    if (enabled !== undefined) patch.enabled = Boolean(enabled);
    if (when !== undefined) {
      if (when) Object.assign(patch, parseSchedule(when, { once: repeat === false }));
      else Object.assign(patch, { cron: null, nextRunAt: null });
    }

    const updated = await store.updateWorkflow(userId, id, patch);
    const schedule = updated.cron ? `repeats ${updated.cron}` : 'runs by hand';
    return `Updated "${updated.title}" — ${updated.steps.length} step(s), ${schedule}${updated.enabled ? '' : ', paused'}.`;
  }

  const ordered = normaliseSteps(steps);
  const prefs = await getPrefs(userId);
  // The account's own zone, for the same reason as `schedule_task` above.
  const tz = prefs.timezone || null;
  const schedule = when
    ? parseSchedule(when, { once: repeat === false, tz })
    : { cron: null, nextRunAt: null };

  const workflow = await store.createWorkflow(userId, {
    id: crypto.randomUUID(),
    title: String(title || '').trim() || 'Workflow',
    steps: ordered,
    model: prefs.defaultModel,
    cron: schedule.cron,
    nextRunAt: schedule.nextRunAt,
    tz,
  });

  const first = workflow.next_run_at
    ? new Date(workflow.next_run_at).toLocaleString('en-GB', tz ? { timeZone: tz } : undefined)
    : null;
  return [
    `Created the workflow "${workflow.title}" with ${ordered.length} step(s). Id ${workflow.id}.`,
    first ? `First run: ${first}${schedule.cron ? ` (repeats ${schedule.cron})` : ''}.` : 'It runs when asked, not on a clock.',
    'Each step runs in order in one conversation, and a step that is interrupted is never repeated automatically.',
  ].join(' ');
}

/** What is set up, and how the last run of each went — step by step. */
async function workflowStatusTool({ id }, { userId }) {
  const store = getStore();
  const workflows = id
    ? [await store.getWorkflow(userId, id)].filter(Boolean)
    : await store.listWorkflows(userId);

  if (!workflows.length) {
    return id ? `There is no workflow with the id "${id}".` : 'There are no workflows on this account.';
  }

  const lines = [];
  for (const wf of workflows) {
    const [run] = await store.listWorkflowRuns(userId, wf.id, 1);
    const schedule = wf.cron ? `repeats ${wf.cron}` : 'runs by hand';
    lines.push(`- ${wf.title} — id ${wf.id}`);
    lines.push(`    ${schedule}${wf.enabled ? '' : ' (paused)'}, ${wf.steps.length} step(s)`);

    if (!run) {
      lines.push('    never run');
      continue;
    }

    lines.push(`    last run ${new Date(run.started_at).toISOString()} — ${run.status}`);
    for (const [i, step] of (run.steps || []).entries()) {
      const detail = step.error ? ` — ${String(step.error).replace(/\s+/g, ' ').slice(0, 160)}` : '';
      lines.push(`      ${i + 1}. ${step.status}${detail}`);
    }
    if (run.status === 'needs_attention') {
      lines.push('    This one is waiting for a person. Nothing is repeated until it is dealt with.');
    }
  }

  return ['Workflows on this account:', '', ...lines].join('\n');
}

async function searchDocsTool({ query, limit, source }, { userId }) {
  return searchDocs(userId, { query, limit, source });
}

async function listIndexedTool(_input, { userId }) {
  return listSources(userId);
}

async function forgetDocsTool({ source }, { userId }) {
  return forgetSource(userId, source);
}

async function githubTool({ path, params }, { userId }) {
  return CONNECTOR_CALLS.githubCall(userId, path, params);
}

async function githubWriteTool({ path, method, body }, { userId }) {
  return CONNECTOR_CALLS.githubWrite(userId, path, method, body);
}

/**
 * Send an email as the deployment.
 *
 * Reuses the transport the app already has for confirmation codes, so there is
 * nothing new to configure — and nothing new to get wrong about credentials.
 *
 * The console backend is the case that matters. With neither Resend nor SMTP set
 * up, `sendEmail` prints to the server log and returns successfully, which is
 * right for a password-reset code during development and completely wrong here:
 * an assistant that says "I have emailed the client" when nothing left the
 * building is worse than one that cannot send email at all. So that case is
 * reported as the failure it is.
 */
async function sendEmailTool({ to, subject, body, html }) {
  const address = String(to || '').trim();
  // Deliberately loose. A real address parser rejects valid addresses, and the
  // provider is the one that actually knows — this is only here to catch a model
  // passing a name or an empty string.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(`"${to}" is not an email address.`);
  }
  const line = String(subject || '').trim();
  if (!line) throw new Error('An email with no subject line reads as spam. Give it one.');
  const text = String(body || '').trim();
  if (!text && !html) throw new Error('There is nothing to send — give a body.');

  if (emailBackend() === 'console') {
    throw new Error(
      'No mail provider is configured on this deployment, so nothing can actually be sent — it would only be ' +
        'printed to the server log. Tell the user plainly that the email was NOT sent, and that RESEND_API_KEY or ' +
        'SMTP_HOST has to be set for this tool to work. Do not claim to have sent it.',
    );
  }

  await sendEmail({ to: address, subject: line, text: text || undefined, html: html || undefined });
  return (
    `Sent an email to ${address} with the subject "${line}". ` +
    'It has left the building and cannot be recalled — say so, and say what you sent.'
  );
}

/**
 * Make a picture.
 *
 * Through Google's Imagen, on the account's own Google key. The shape here was
 * read off the installed SDK's own type definitions rather than remembered:
 * `models.generateImages({ model, prompt, config })` answering with
 * `generatedImages[].image.imageBytes` as base64.
 *
 * OpenAI can also do this and is deliberately not wired up. One verified path is
 * worth more than two half-checked ones, and the error below names exactly what
 * to add rather than failing vaguely.
 *
 * The result goes into the conversation as a file, the same way `create_file`
 * works, so it appears as something to look at and download rather than a wall of
 * base64 in the transcript.
 */
async function generateImageTool({ prompt, name, aspect_ratio: aspectRatio, count }, { userId, chatId }) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Describe the image you want.');

  const key = await getApiKey(userId, 'google');
  if (!key) {
    throw new Error(
      'Making pictures needs a Google API key, and this account has none. Tell the user to add one in ' +
        'Settings → Providers → Google Gemini. Their OpenRouter key cannot do this — image models are not part of ' +
        'that catalogue here.',
    );
  }

  const wanted = Math.min(Math.max(Number(count) || 1, 1), 4);
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: key });

  const response = await ai.models.generateImages({
    model: process.env.IMAGE_MODEL || 'imagen-4.0-generate-001',
    prompt: text,
    config: {
      numberOfImages: wanted,
      ...(aspectRatio ? { aspectRatio: String(aspectRatio) } : {}),
    },
  });

  const images = (response?.generatedImages || []).filter((image) => image?.image?.imageBytes);
  if (!images.length) {
    // A refusal is not an empty result, and reporting it as one would have the
    // model try again with the same prompt.
    const refused = response?.generatedImages?.find((image) => image?.raiFilteredReason)?.raiFilteredReason;
    throw new Error(
      refused
        ? `Google declined to make that image: ${refused}`
        : 'Google returned no image and gave no reason. Try describing it differently.',
    );
  }

  const base = String(name || text).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60).trim() || 'image';
  const saved = [];
  for (const [index, image] of images.entries()) {
    const mime = image.image.mimeType || 'image/png';
    const extension = mime.includes('jpeg') ? 'jpg' : mime.split('/')[1] || 'png';
    const file = await saveGenerated(userId, {
      name: `${base}${images.length > 1 ? ` ${index + 1}` : ''}.${extension}`,
      mime,
      data: image.image.imageBytes,
      chatId,
    });
    saved.push(file);
  }

  const first = saved[0];
  return {
    content:
      `Made ${saved.length} image${saved.length === 1 ? '' : 's'}: ${saved.map((f) => f.name).join(', ')}. ` +
      `${saved.length === 1 ? 'It is' : 'They are'} in the conversation now — the user can see and download ` +
      `${saved.length === 1 ? 'it' : 'them'}, so do not try to describe the pixels back to them.` +
      (images[0].enhancedPrompt ? `\n\nThe prompt was expanded to: ${images[0].enhancedPrompt}` : ''),
    file: { id: first.id, name: first.name, mime: first.mime, kind: first.kind, bytes: first.bytes },
  };
}

async function telegramSendTool({ chat_id: chatIdArg, text }, { userId }) {
  return CONNECTOR_CALLS.telegramSend(userId, chatIdArg, text);
}

async function metaPagePostTool({ message, link }, { userId }) {
  return CONNECTOR_CALLS.metaPagePost(userId, message, link);
}

async function notionSearchTool({ query }, { userId }) {
  return CONNECTOR_CALLS.notionSearch(userId, query);
}

async function slackPostTool({ channel, text }, { userId }) {
  return CONNECTOR_CALLS.slackPost(userId, channel, text);
}

export const CLOUD_IMPLEMENTATIONS = {
  create_file: createFileTool,
  update_file: updateFileTool,
  read_generated_file: readGeneratedFileTool,
  file_versions: fileVersionsTool,
  web_fetch: webFetch,
  load_tools: loadToolsTool,
  web_search: webSearch,
  show_widget: showWidgetTool,
  chart: chartTool,
  calculate: calculateTool,
  extract: extractTool,
  memory_write: memoryWrite,
  memory_read: memoryRead,
  memory_append: memoryAppend,
  memory_edit: memoryEdit,
  memory_delete: memoryDelete,
  update_plan: updatePlan,
  skill_read: skillRead,
  skill_write: skillWrite,
  run_parallel: runParallelTool,
  deep_research: deepResearchTool,
  schedule_task: scheduleTaskTool,
  list_tasks: listTasksTool,
  cancel_task: cancelTaskTool,
  workflow_write: workflowWriteTool,
  workflow_status: workflowStatusTool,
  search_docs: searchDocsTool,
  list_indexed: listIndexedTool,
  forget_docs: forgetDocsTool,
  github: githubTool,
  github_write: githubWriteTool,
  notion_search: notionSearchTool,
  slack_post: slackPostTool,
  telegram_send: telegramSendTool,
  meta_page_post: metaPagePostTool,
  send_email: sendEmailTool,
  generate_image: generateImageTool,
};
