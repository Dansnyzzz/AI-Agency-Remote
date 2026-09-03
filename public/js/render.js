import { renderMarkdown, escapeHtml } from './markdown.js';
import { t } from './i18n.js';

/**
 * One repaint per frame, and a real fallback when there are no frames.
 *
 * A backgrounded tab does not run `requestAnimationFrame` at all, so a reply
 * streaming into a tab the user has switched away from would never paint and
 * would arrive all at once on return. `setTimeout` still fires there (throttled,
 * which is fine — nobody is looking), so the streamed text keeps accumulating
 * into the DOM either way.
 */
const raf = (fn) =>
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16))(fn);

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
};

const ms = (n) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

/** The nearest ancestor that actually scrolls sideways, if there is one. */
function sidewaysScroller(node) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    if (/auto|scroll|hidden/.test(getComputedStyle(el).overflowX)) return el;
  }
  return null;
}

/**
 * Centre the thing you just chose in the strip that holds it.
 *
 * Several strips here scroll sideways because they hold more than fits — nine
 * settings tabs, a dozen vendor chips. Picking one off the edge, or arriving at
 * a tab because a button sent you there, left the selection outside the visible
 * strip: you could see that the panel had changed and not see which tab was lit.
 *
 * Merely *reaching* it is not enough. Scrolling the minimum leaves your choice
 * pinned against the edge it came from, with the neighbours you might pick next
 * still hidden behind it — so the chip you tapped lands in the middle, where
 * both directions are visible. The ends are the exception: clamping to the
 * scrollable range keeps the first and last chips against their own edge rather
 * than pulling empty space into view to satisfy the arithmetic.
 *
 * Only the strip is scrolled, never the page — this is called from inside sheets
 * that must not jump under the pointer.
 */
export function revealInStrip(node) {
  if (!node) return;
  const strip = sidewaysScroller(node);
  if (!strip) return; // Nothing scrolls; it is already as visible as it gets.

  const box = node.getBoundingClientRect();
  const view = strip.getBoundingClientRect();
  const centred = strip.scrollLeft + (box.left - view.left) - (view.width - box.width) / 2;
  const left = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, centred));
  if (Math.abs(left - strip.scrollLeft) < 1) return;

  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    strip.scrollTo({ left, behavior: still ? 'auto' : 'smooth' });
  } catch {
    strip.scrollLeft = left; // Older Safari: a jump beats an off-screen selection.
  }
}

/** One-line preview of a tool's arguments, so the timeline reads at a glance. */
export function summariseToolInput(name, input = {}) {
  switch (name) {
    case 'run_command':
      return input.command || '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return input.path || '';
    case 'glob':
      return input.pattern || '';
    case 'grep':
      return `/${input.pattern || ''}/${input.path ? ` in ${input.path}` : ''}`;
    case 'web_search':
      return input.query || '';
    case 'web_fetch':
      return input.url || '';
    case 'create_file':
      return `${input.name || 'document'}${input.format ? ` (${input.format})` : ''}`;
    case 'update_file':
      return input.name || 'rewriting the document';
    case 'memory_write':
    case 'memory_read':
      return input.key || 'all notes';
    case 'update_plan':
      return `${(input.steps || []).length} steps`;
    default: {
      const json = JSON.stringify(input);
      return json.length > 90 ? `${json.slice(0, 90)}…` : json;
    }
  }
}

/**
 * A tool call, in words somebody would use.
 *
 * `summariseToolInput` above answers "what were the arguments"; this answers
 * "what happened", which is a different question and the one anybody watching is
 * actually asking. A run of ten browser calls used to read as ten lines of
 * `browser_click {"ref":"7"}` — technically complete, and unreadable at the
 * speed the steps go past.
 *
 * Anything not listed falls through to the old behaviour, so a tool added later
 * is plain rather than broken.
 */
const STEP_VERBS = {
  browser_open: 'step.browser.open',
  browser_tabs: 'step.browser.tabs',
  browser_switch: 'step.browser.switchTab',
  browser_close_tab: 'step.browser.closeTab',
  browser_look: 'step.browser.look',
  browser_click: 'step.browser.click',
  browser_type: 'step.browser.type',
  browser_press: 'step.browser.press',
  browser_back: 'step.browser.back',
  browser_forward: 'step.browser.forward',
  browser_select: 'step.browser.select',
  browser_hover: 'step.browser.hover',
  browser_scroll: 'step.browser.scroll',
  browser_wait: 'step.browser.wait',
  browser_close: 'step.browser.close',
  desktop_windows: 'step.desktop.windows',
  desktop_launch: 'step.desktop.launch',
  desktop_look: 'step.desktop.look',
  desktop_focus: 'step.desktop.focus',
  desktop_click: 'step.desktop.click',
  desktop_type: 'step.desktop.type',
  desktop_key: 'step.desktop.key',
  desktop_scroll: 'step.desktop.scroll',
  desktop_wait: 'step.desktop.wait',
  desktop_close: 'step.desktop.close',
};

/** A URL as somebody would say it aloud: the host, and the path if it says anything. */
function readableUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    const host = url.host.replace(/^www\./, '');
    const tail = url.pathname.replace(/\/$/, '');
    return tail && tail !== '' ? `${host}${tail}` : host;
  } catch {
    return text;
  }
}

const clip = (text, max = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function describeStep(name, input = {}) {
  const key = STEP_VERBS[name];
  if (!key) return { verb: name, detail: summariseToolInput(name, input) };

  const seconds = (n) => t('step.seconds').replace('{n}', String(Number(n) || 0));

  switch (name) {
    case 'browser_open':
      return { verb: t(key), detail: readableUrl(input.url) };
    case 'browser_click':
    case 'browser_hover':
      // The model's own description of what it is clicking beats a reference
      // number, which means nothing to the person reading.
      return { verb: t(key), detail: clip(input.description || (input.ref != null ? `[${input.ref}]` : '')) };
    case 'browser_type':
    case 'desktop_type':
      return { verb: t(key), detail: clip(input.text, 48) };
    case 'browser_press':
    case 'desktop_key':
      return { verb: t(key), detail: clip(input.key) };
    case 'browser_select':
      return { verb: t(key), detail: clip(input.value) };
    case 'browser_scroll':
    case 'desktop_scroll':
      return { verb: t(key), detail: clip(input.direction || 'down') };
    case 'browser_wait':
    case 'desktop_wait':
      return { verb: t(key), detail: seconds(input.seconds ?? 3) };
    case 'browser_switch':
    case 'browser_close_tab':
      return { verb: t(key), detail: input.tab != null ? String(input.tab) : '' };
    case 'desktop_launch':
      return { verb: t(key), detail: clip(input.app || input.path || '') };
    case 'desktop_focus':
    case 'desktop_close':
      return { verb: t(key), detail: clip(input.title || input.window || '') };
    default:
      return { verb: t(key), detail: '' };
  }
}

/**
 * Which run of steps this call belongs to, or null for "on its own".
 *
 * Only the two families that come in long runs are grouped. Grouping everything
 * would fold a single `read_file` into a card you have to open to see, which
 * costs a click to learn something that was already on screen.
 */
export function stepFamily(name) {
  if (/^browser_/.test(name)) return 'browser';
  if (/^desktop_/.test(name)) return 'desktop';
  return null;
}

/** A file's extension, upper-cased, as the stand-in for a thumbnail. */
const extensionBadge = (name) => String(name || 'file').split('.').pop().slice(0, 4).toUpperCase();

/** What kind of thing this is, in words, for the line under a filename. */
const FILE_NOUN = {
  docx: 'Word document',
  doc: 'Word document',
  xlsx: 'Excel workbook',
  xls: 'Excel workbook',
  pptx: 'PowerPoint deck',
  ppt: 'PowerPoint deck',
  pdf: 'PDF',
  csv: 'Spreadsheet data',
  md: 'Markdown',
  html: 'Web page',
  json: 'JSON',
  txt: 'Text',
};

const humanSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * What was sent, above what was said about it.
 *
 * `preview` is a local object URL for something just picked, which the browser
 * already holds; `id` is a stored one, fetched from the server. Both end up in
 * the same markup — the difference only matters for where the bytes come from.
 *
 * Anything already stored is a button, because it can be opened: a Word
 * document or a spreadsheet is unreadable as a name in a bubble, and the whole
 * point of attaching one is that both parties can see it. A file still
 * uploading has nothing to open yet and stays inert.
 */
function attachmentStrip(files) {
  const strip = el('div', 'bubble__files');

  for (const file of files) {
    const src = file.preview || (file.id ? `/api/attachments/${file.id}` : null);
    const image = file.preview ? true : /^image\//i.test(file.mime || '');

    if (src && image) {
      const img = el('img', 'bubble__image');
      img.src = src;
      img.alt = file.name || '';
      img.loading = 'lazy';
      if (file.id) {
        const open = el('button', 'bubble__thumb');
        open.type = 'button';
        open.dataset.file = file.id;
        open.title = t('chat.openNamed').replace('{name}', file.name || '');
        open.append(img);
        strip.append(open);
      } else {
        strip.append(img);
      }
      continue;
    }

    const chip = el(file.id ? 'button' : 'span', 'bubble__file');
    if (file.id) {
      chip.type = 'button';
      chip.dataset.file = file.id;
      chip.title = `Open ${file.name || 'this file'}`;
    }
    const kind = el('span', 'bubble__file-ext');
    kind.textContent = extensionBadge(file.name);
    const label = el('span');
    label.textContent = file.name || 'file';
    chip.append(kind, label);
    strip.append(chip);
  }
  return strip;
}

/**
 * A document the assistant made.
 *
 * Deliberately not a line of prose saying a file was written. A file people can
 * see the size of, open, and download is the difference between "here is your
 * quotation" and a paragraph claiming there is one — and the two buttons are the
 * two things anybody does next.
 */
/**
 * A widget, drawn in the transcript.
 *
 * **In an iframe, and that is not optional.** This is markup a model wrote, and
 * putting it in the page directly would give it the same origin as the session —
 * one `<img onerror>` away from reading the conversation or the cookie. Sandboxed
 * with `allow-scripts` withheld and no `allow-same-origin`, it can draw and
 * nothing else, which is the whole job. The same reasoning as the artifact frame
 * in viewer.js, one step stricter because a widget never needs to run anything.
 *
 * `srcdoc` rather than a URL, because the markup lives in the tool result rather
 * than in a file with an id to fetch.
 *
 * The height comes from the content: an iframe defaults to 150px and would crop
 * most diagrams, and there is no way to measure inside a frame we deliberately
 * cannot script into. So the frame reports its own height once, through the one
 * channel a sandboxed document still has — and if it never does, the CSS floor
 * keeps the picture visible rather than clipped to nothing.
 */
export function widgetFrame(widget) {
  const host = document.createElement('figure');
  host.className = 'widget';

  const caption = document.createElement('figcaption');
  caption.className = 'widget__caption';
  caption.textContent = widget.title || t('chat.diagram');

  const frame = document.createElement('iframe');
  frame.className = 'widget__frame';
  frame.title = widget.title || t('chat.diagram');
  /**
   * No `allow-scripts`: a widget is a finished picture. Anything that needs to
   * run is a `create_file` artifact, which has its own frame and its own warning.
   *
   * `allow-same-origin` is here only so this page can measure the drawing and
   * size the frame to it — without it the frame gets an opaque origin and its
   * height is unreadable, which is why every widget used to be exactly 340px
   * whether it held a four-bar chart or a thirty-row table. It grants nothing to
   * the markup: with scripts still forbidden, there is nothing inside to use it.
   */
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('loading', 'lazy');

  /**
   * Fit the frame to the picture.
   *
   * Measured after load rather than guessed: a chart and a table want very
   * different heights, and a fixed one is wrong for both — empty space under the
   * small one, a scrollbar through the middle of the large one. The CSS keeps a
   * max-height, so something genuinely enormous still scrolls instead of pushing
   * the conversation off the screen.
   */
  const fit = () => {
    try {
      const body = frame.contentDocument?.body;
      if (!body) return;
      const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
      if (height > 0) frame.style.height = `${height + 4}px`;
    } catch {
      // Cross-origin or detached: leave the CSS height, which still works.
    }
  };
  frame.addEventListener('load', fit);

  // A document rather than a fragment, so the picture is not styled by this page
  // and cannot reach out of its box.
  frame.srcdoc =
    '<!doctype html><meta charset="utf-8">' +
    '<style>' +
    'html,body{margin:0;padding:0;background:transparent;' +
    "font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#c8d3de}" +
    'body{padding:10px}svg{max-width:100%;height:auto;display:block}' +
    'table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #2a3642;padding:4px 8px}' +
    'a{color:#7cc7ff}' +
    '</style>' +
    `<body>${widget.markup}</body>`;

  host.append(caption, frame);
  return host;
}

export function fileCard(file) {
  const card = el('div', 'filecard');
  card.dataset.file = file.id;

  const icon = el('span', 'filecard__icon');
  icon.textContent = extensionBadge(file.name);

  const body = el('div', 'filecard__body');
  const name = el('span', 'filecard__name');
  name.textContent = file.name;
  const meta = el('span', 'filecard__meta');
  meta.textContent = [FILE_NOUN[extensionBadge(file.name).toLowerCase()], humanSize(file.bytes || 0)]
    .filter(Boolean)
    .join(' · ');
  body.append(name, meta);

  const open = el('button', 'btn btn--ghost filecard__btn');
  open.type = 'button';
  open.dataset.file = file.id;
  open.textContent = t('chat.open');

  const download = el('a', 'btn btn--ghost filecard__btn');
  // The version marker only changes when the file is rewritten; without it a
  // browser holding the immutable first version would download that forever.
  download.href = `/api/attachments/${file.id}?download=1${file.version ? `&v=${file.version}` : ''}`;
  download.setAttribute('download', file.name);
  download.textContent = t('chat.download');

  card.append(icon, body, open, download);
  return card;
}

export function userMessage(text, files = [], id = null) {
  const wrap = el('div', 'msg msg--user');
  if (id) wrap.dataset.messageId = id;
  const bubble = el('div', 'bubble');

  if (files.length) bubble.append(attachmentStrip(files));

  if (text) {
    const body = el('div', 'bubble__text');
    body.textContent = text;
    bubble.append(body);
  }

  wrap.append(bubble);

  /**
   * Copy and edit, under the bubble and only while you are pointing at it.
   *
   * Always-visible controls on every turn would put two buttons beside every
   * line of a conversation, which is a lot of furniture for something used
   * rarely. They appear on hover, and on keyboard focus as well — otherwise
   * they would be reachable by tabbing to a control nobody can see.
   */
  const actions = el('div', 'msg__actions');
  actions.innerHTML =
    `<button class="msg__action" type="button" data-act="copy" title="${escapeHtml(t('chat.copy'))}" aria-label="${escapeHtml(t('chat.copy'))}">` +
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6">' +
    '<rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />' +
    '</svg></button>' +
    `<button class="msg__action" type="button" data-act="edit" title="${escapeHtml(t('chat.edit'))}" aria-label="${escapeHtml(t('chat.edit'))}">` +
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z" />' +
    '</svg></button>';
  wrap.append(actions);

  return wrap;
}

/**
 * An assistant turn. Reasoning, tool calls and prose all land in one block so
 * the transcript reads as a single continuous action rather than a pile of
 * disconnected cards.
 */
export function assistantMessage() {
  // No "ASSISTANT" label. In a two-party conversation where one side is in a
  // bubble on the right and the other is not, saying which is which every turn
  // is a caption on an unambiguous picture — it adds a line of chrome to every
  // reply and tells nobody anything they did not already know.
  const wrap = el('div', 'msg msg--assistant');

  const body = el('div', 'msg__body');
  wrap.append(body);

  let thinkingBlock = null;
  let thinkingBody = null;
  let prose = null;
  let rawText = '';
  /** Whether a repaint is already scheduled for the next frame — see appendText. */
  let paintQueued = false;

  /**
   * A run of steps in one family, drawn as a single card.
   *
   * Held open while it is being added to, so you watch the work happen, and
   * collapsed the moment the run ends — at which point it is history, and eight
   * expanded browser actions between you and the answer are eight things to
   * scroll past. `closeGroup` is what "the run ended" means, and it is called
   * from exactly two places: prose arriving, and a step of a different family.
   */
  let group = null;

  function closeGroup() {
    if (!group) return;
    group.node.querySelector('.spinner')?.remove();
    group.node.open = false;
    group = null;
  }

  /** Redraw the one line somebody reads without opening the card. */
  function paintGroupSummary() {
    if (!group) return;
    const label = group.family === 'desktop' ? t('steps.desktop') : t('steps.browser');
    const count = t('steps.count').replace('{n}', String(group.count));
    group.title.textContent = label;
    group.tally.textContent = count;
    if (group.failed) group.node.classList.add('steps--error');
  }

  /**
   * One step inside a run.
   *
   * A row rather than a card: the verb, what it acted on, how long it took, and
   * — once it finishes — a thumbnail of what the screen looked like. The raw
   * tool output is still there, behind a disclosure, because when something goes
   * wrong that text is the only thing that explains it.
   */
  function startStep(call, family) {
    const run = groupFor(family);
    run.count += 1;
    paintGroupSummary();

    const { verb, detail } = describeStep(call.name, call.input);

    const item = el('li', 'step');
    const mark = el('span', 'step__mark', '<span class="spinner"></span>');
    const label = el('span', 'step__label');
    const verbNode = el('span', 'step__verb');
    verbNode.textContent = verb;
    label.append(verbNode);
    if (detail) {
      const detailNode = el('span', 'step__detail');
      detailNode.textContent = detail;
      label.append(detailNode);
    }
    const time = el('span', 'step__time');
    item.append(mark, label, time);
    run.list.append(item);

    return {
      complete(result) {
        item.classList.toggle('step--error', !!result.isError);
        mark.innerHTML = '';
        mark.textContent = result.isError ? '✗' : '✓';
        if (result.ms != null) time.textContent = ms(result.ms);
        if (result.isError) {
          run.failed = true;
          paintGroupSummary();
        }

        /**
         * What the screen looked like when this step finished.
         *
         * The single most useful thing in the whole card, and the reason it is
         * a thumbnail rather than a full frame: eight full-width screenshots
         * turn a run into a scroll, while eight thumbnails read as a strip you
         * can take in at once. Clicking one opens it properly.
         */
        if (result.shot?.id) {
          const shot = el('button', 'step__shot');
          shot.type = 'button';
          shot.dataset.file = result.shot.id;
          const img = el('img');
          img.src = `/api/attachments/${result.shot.id}`;
          img.alt = `${verb}${detail ? ` — ${detail}` : ''}`;
          img.loading = 'lazy';
          shot.append(img);
          item.append(shot);
        }

        // Errors are opened, successes are not. A failed step is the one thing
        // in the run somebody needs to read, and making them find and click it
        // is making them work for information the interface already has.
        const out = el('details', 'step__out');
        out.open = !!result.isError;
        out.append(el('summary', null, escapeHtml(t('step.output'))));
        const pre = el('pre');
        pre.textContent = result.content || t('chat.noOutput');
        out.append(pre);
        item.append(out);

        if (result.file?.id) {
          const card = fileCard(result.file);
          const existing = [...body.querySelectorAll('.filecard')].find(
            (node) => node.dataset.file === result.file.id,
          );
          if (existing) existing.replaceWith(card);
          else body.append(card);
        }
        if (result.widget?.markup) body.append(widgetFrame(result.widget));
      },
    };
  }

  /** The card this call belongs in, opening a new one if the run just started. */
  function groupFor(family) {
    if (group && group.family === family) return group;
    closeGroup();

    const node = el('details', 'block steps');
    node.open = true;
    const summary = el('summary');
    summary.innerHTML = '<span class="spinner"></span>';
    const title = el('span', 'steps__title');
    const tally = el('span', 'steps__tally');
    summary.append(title, tally);
    node.append(summary);

    const list = el('ol', 'steps__list');
    node.append(list);
    body.append(node);

    group = { family, node, list, title, tally, count: 0, failed: false };
    return group;
  }

  const api = {
    node: wrap,

    appendThinking(delta) {
      if (!thinkingBlock) {
        thinkingBlock = el('details', 'block');
        thinkingBlock.append(
          el('summary', null, `<span class="spinner"></span> ${escapeHtml(t('chat.reasoning'))}`),
        );
        thinkingBody = el('div', 'block__body');
        thinkingBody.append(el('pre'));
        thinkingBlock.append(thinkingBody);
        body.append(thinkingBlock);
      }
      thinkingBody.querySelector('pre').textContent += delta;
    },

    finishThinking() {
      if (thinkingBlock) {
        thinkingBlock.querySelector('summary').innerHTML = escapeHtml(t('chat.reasoning'));
      }
    },

    /**
     * Add to the reply, and repaint at most once a frame.
     *
     * This used to re-parse and re-insert the *whole* reply on every delta.
     * `renderMarkdown` is a line-scanning parse with a dozen regex passes over
     * the accumulated text, so running it per token is O(n²) in reply length: a
     * 20,000-character answer arriving four characters at a time is about 5,000
     * parses averaging 10,000 characters, each followed by throwing away and
     * rebuilding the entire prose subtree. It was the most expensive thing in
     * the client, on its hottest path.
     *
     * Two consequences were worse than the jank, because they are things a
     * person notices without knowing why: **you could not select text in a
     * streaming reply** — the selection was destroyed every token — and any
     * `<details>` a reply had opened snapped shut continuously.
     *
     * Coalescing to one paint per animation frame collapses ~16ms of tokens
     * into a single parse, which on a fast stream is a 10–50× cut with no
     * change to what is finally shown. `flushText` exists so the end of a turn
     * is never left waiting on a frame that may not come — a backgrounded tab
     * does not run rAF at all.
     */
    appendText(delta) {
      rawText += delta;
      if (!prose) {
        // Prose is the natural boundary between two pieces of work: the
        // assistant stopped acting and said something. Folding the steps either
        // side of that into one card would claim a structure the turn does not have.
        closeGroup();
        prose = el('div', 'prose');
        body.append(prose);
      }
      if (paintQueued) return;
      paintQueued = true;
      raf(() => {
        paintQueued = false;
        // `prose` can have been torn down by `resetText` between scheduling and
        // painting — a provider restarting the reply on another key does exactly
        // that — and painting into the removed node would resurrect the draft
        // this whole mechanism exists to discard.
        if (prose) prose.innerHTML = renderMarkdown(rawText);
      });
    },

    /** Paint whatever is pending right now, without waiting for a frame. */
    flushText() {
      paintQueued = false;
      if (prose) prose.innerHTML = renderMarkdown(rawText);
    },

    /**
     * Throw away the prose written so far.
     *
     * A provider that restarts a reply on another key is replacing it, not
     * continuing it. Letting the replacement accumulate on top would be the
     * quiet kind of wrong: a reader has no way to tell a repeated paragraph
     * from an intended one, and might carry it off and use it.
     */
    resetText() {
      rawText = '';
      // Cancel any frame still owed. Without this the queued paint would run
      // after the node was removed — harmless now that `appendText` re-checks
      // `prose`, but leaving a scheduled write to a discarded draft in flight is
      // not a thing to rely on being harmless.
      paintQueued = false;
      if (prose) {
        prose.remove();
        prose = null;
      }
    },

    setPlan(steps) {
      let plan = body.querySelector('.plan');
      if (!plan) {
        plan = el('div', 'plan');
        // The heading was hard-coded English, which left the one panel the user
        // watches while they wait untranslated on a Vietnamese account.
        const heading = el('h4');
        heading.textContent = t('chat.plan');
        const list = el('ul');
        /**
         * The plan rewrites itself as the work moves, and a screen reader was
         * told none of it — the steps simply changed underneath. `polite`
         * announces the current step when it changes without interrupting
         * whatever is being read; `false` re-reads the whole list rather than
         * just the changed node, which is what makes "step 3 of 6" make sense.
         */
        list.setAttribute('aria-live', 'polite');
        list.setAttribute('aria-atomic', 'false');
        plan.append(heading, list);
        body.append(plan);
      }
      plan.querySelector('ul').innerHTML = (steps || [])
        .map((s) => {
          const cls = s.status === 'done' ? 'is-done' : s.status === 'in_progress' ? 'is-active' : '';
          const mark = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▸' : '○';
          // The mark is decorative — the status it encodes is already carried by
          // aria-current and the list order, and read aloud it is a shape.
          return (
            `<li class="${cls}"${s.status === 'in_progress' ? ' aria-current="step"' : ''}>` +
            `<span aria-hidden="true">${mark}</span><span>${escapeHtml(s.title)}</span></li>`
          );
        })
        .join('');
      // Keep the plan pinned above the prose it describes.
      body.prepend(plan);
    },

    /** Start a collapsed card for a tool call; returns a handle to complete it. */
    startTool(call) {
      const family = stepFamily(call.name);
      if (family) return startStep(call, family);

      // A call that is not part of a run ends whatever run was in progress:
      // `read_file` between two browser actions really is a change of activity.
      closeGroup();

      const block = el('details', 'block tool');
      const summary = el('summary');
      summary.innerHTML =
        `<span class="spinner"></span>` +
        `<span class="tool__name">${escapeHtml(call.name)}</span>` +
        `<span class="tool__arg">${escapeHtml(summariseToolInput(call.name, call.input))}</span>`;
      block.append(summary);

      const inner = el('div', 'block__body');
      inner.append(el('pre'));
      block.append(inner);
      body.append(block);

      return {
        complete(result) {
          block.classList.toggle('tool--error', !!result.isError);
          summary.innerHTML =
            `<span>${result.isError ? '✗' : '✓'}</span>` +
            `<span class="tool__name">${escapeHtml(call.name)}</span>` +
            `<span class="tool__arg">${escapeHtml(summariseToolInput(call.name, call.input))}</span>` +
            (result.ms != null ? `<span class="tool__time">${ms(result.ms)}</span>` : '');
          inner.querySelector('pre').textContent = result.content || t('chat.noOutput');

          /**
           * A document came out of this call.
           *
           * The card goes beside the collapsed tool block rather than inside it:
           * the tool call is machinery nobody opens, and the file is the thing
           * that was asked for. A rewrite replaces the card for that same id, so
           * a document edited three times is one card, not four.
           */
          if (result.file?.id) {
            const card = fileCard(result.file);
            const existing = [...body.querySelectorAll('.filecard')].find(
              (node) => node.dataset.file === result.file.id,
            );
            if (existing) existing.replaceWith(card);
            else body.append(card);
          }

          /**
           * A picture drawn into the conversation itself.
           *
           * Beside the tool block like a file card, for the same reason: the call
           * is machinery and the picture is the point. Unlike a file it is not
           * something to open — it is already open, which is what makes it the
           * right shape for "here is what I found" rather than "here is a report".
           */
          if (result.widget?.markup) body.append(widgetFrame(result.widget));
        },
      };
    },

    /** Rebuild from a persisted message when reloading a conversation. */
    hydrate(message, resultsByCallId) {
      if (message.thinking) {
        api.appendThinking(message.thinking);
        api.finishThinking();
      }
      for (const call of message.toolCalls || []) {
        if (call.name === 'update_plan') api.setPlan(call.input?.steps);
        const handle = api.startTool(call);
        const result = resultsByCallId?.get(call.id);
        handle.complete(result || { content: t('chat.noResult'), isError: false });
      }
      if (message.text) api.appendText(message.text);
      api.finish();
      return api;
    },

    /**
     * The turn is over.
     *
     * A run of steps that is never closed keeps its spinner and stays expanded
     * for the rest of the conversation — a turn that finished an hour ago still
     * drawn as though it were working.
     */
    finish() {
      // The last tokens of a reply may still be owed a frame. A turn that ends
      // must show all of what it said, not all but the final sentence.
      if (paintQueued) api.flushText();
      closeGroup();
    },
  };

  return api;
}

/**
 * Where the earlier part of a conversation was folded up.
 *
 * Shown as a quiet rule rather than hidden, because the transcript the model
 * sees and the one you read have just parted company — and the moment that
 * happened is exactly the thing worth being able to point at when an answer
 * later seems to have forgotten something. The summary itself is behind the
 * disclosure: available, not in the way.
 */
export function summaryDivider(replaced, text) {
  const wrap = el('div', 'compacted');
  const line = el('div', 'compacted__line');
  // Two keys rather than a plural rule: this dictionary has no plural machinery
  // on purpose, and Vietnamese does not inflect the noun anyway.
  line.textContent =
    replaced === 1 ? t('chat.compactedOne') : t('chat.compacted').replace('{n}', String(replaced));
  wrap.append(line);

  if (text) {
    const fold = el('details', 'block compacted__fold');
    fold.append(el('summary', null, escapeHtml(t('chat.summaryFold'))));
    const body = el('div', 'block__body');
    const pre = el('pre');
    pre.textContent = text;
    body.append(pre);
    fold.append(body);
    wrap.append(fold);
  }
  return wrap;
}

/**
 * Why the reply above this line is not a finished answer.
 *
 * Drawn into the transcript rather than toasted, and that is the whole point of
 * it: a toast is gone in three seconds, and the question "was this answer cut
 * off?" is asked while scrolling back through a conversation an hour later. The
 * three outcomes it covers — truncated at the output cap, declined by a safety
 * classifier, blocked by a content filter — used to leave nothing behind at all,
 * so a half-written answer and a complete one looked the same for ever.
 *
 * `role="status"` rather than `alert`: it is worth announcing to a screen reader
 * when it appears, and it is not an interruption.
 */
export function stopNote(kind, text) {
  const wrap = el('div', `stopnote stopnote--${kind || 'unknown'}`);
  wrap.setAttribute('role', 'status');
  const line = el('div', 'stopnote__line');
  line.textContent = text;
  wrap.append(line);
  return wrap;
}

export function statusLine(text) {
  const node = el('div', 'status-line');
  node.innerHTML = `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
  return node;
}

export function toast(message, kind = 'info') {
  // An error goes to the assertive region: it is why the thing the user just
  // asked for did not happen, and a polite announcement queues behind whatever
  // is being read — which for a streaming reply is a long time.
  const host = document.getElementById(kind === 'error' ? 'toasts-alert' : 'toasts');

  // Repeating the same message stacks noise without adding information — the
  // second click of a failing button should not double the wall of red.
  // Checked across both regions, so a message cannot appear once in each.
  for (const region of ['toasts', 'toasts-alert']) {
    const node = document.getElementById(region);
    for (const existing of node ? node.children : []) {
      if (existing.dataset.message === message) return;
    }
  }

  const node = el('div', `toast${kind === 'error' ? ' toast--error' : ''}`);
  node.dataset.message = message;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6500 : 3200);
}
