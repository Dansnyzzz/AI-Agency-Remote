import { renderMarkdown, escapeHtml } from './markdown.js';
import { t } from './i18n.js';

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
        open.title = `Open ${file.name || 'this image'}`;
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
  caption.textContent = widget.title || 'Diagram';

  const frame = document.createElement('iframe');
  frame.className = 'widget__frame';
  frame.title = widget.title || 'Diagram';
  // No allow-scripts: a widget is a finished picture. Anything that needs to run
  // is a `create_file` artifact, which has its own frame and its own warning.
  frame.setAttribute('sandbox', '');
  frame.setAttribute('loading', 'lazy');

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
  open.textContent = 'Open';

  const download = el('a', 'btn btn--ghost filecard__btn');
  // The version marker only changes when the file is rewritten; without it a
  // browser holding the immutable first version would download that forever.
  download.href = `/api/attachments/${file.id}?download=1${file.version ? `&v=${file.version}` : ''}`;
  download.setAttribute('download', file.name);
  download.textContent = 'Download';

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
    '<button class="msg__action" type="button" data-act="copy" title="Copy" aria-label="Copy message">' +
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6">' +
    '<rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />' +
    '</svg></button>' +
    '<button class="msg__action" type="button" data-act="edit" title="Edit and ask again" aria-label="Edit message">' +
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

  const api = {
    node: wrap,

    appendThinking(delta) {
      if (!thinkingBlock) {
        thinkingBlock = el('details', 'block');
        thinkingBlock.append(el('summary', null, '<span class="spinner"></span> Reasoning'));
        thinkingBody = el('div', 'block__body');
        thinkingBody.append(el('pre'));
        thinkingBlock.append(thinkingBody);
        body.append(thinkingBlock);
      }
      thinkingBody.querySelector('pre').textContent += delta;
    },

    finishThinking() {
      if (thinkingBlock) {
        thinkingBlock.querySelector('summary').innerHTML = 'Reasoning';
      }
    },

    appendText(delta) {
      rawText += delta;
      if (!prose) {
        prose = el('div', 'prose');
        body.append(prose);
      }
      prose.innerHTML = renderMarkdown(rawText);
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
          inner.querySelector('pre').textContent = result.content || '(no output)';

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
        handle.complete(result || { content: '(no result recorded)', isError: false });
      }
      if (message.text) api.appendText(message.text);
      return api;
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
  line.textContent = `${replaced} earlier message${replaced === 1 ? '' : 's'} summarised to free up room`;
  wrap.append(line);

  if (text) {
    const fold = el('details', 'block compacted__fold');
    fold.append(el('summary', null, 'Read the summary'));
    const body = el('div', 'block__body');
    const pre = el('pre');
    pre.textContent = text;
    body.append(pre);
    fold.append(body);
    wrap.append(fold);
  }
  return wrap;
}

export function statusLine(text) {
  const node = el('div', 'status-line');
  node.innerHTML = `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
  return node;
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');

  // Repeating the same message stacks noise without adding information — the
  // second click of a failing button should not double the wall of red.
  for (const existing of host.children) {
    if (existing.dataset.message === message) return;
  }

  const node = el('div', `toast${kind === 'error' ? ' toast--error' : ''}`);
  node.dataset.message = message;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6500 : 3200);
}
