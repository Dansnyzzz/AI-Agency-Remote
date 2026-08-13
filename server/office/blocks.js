/**
 * One shape for a document, whatever it was born as.
 *
 * Everything here — reading a .docx, reading a slide deck, turning Markdown into
 * a report — meets in the same handful of blocks, and everything that comes out
 * the other side is rendered from them: the HTML the preview draws, the text the
 * model is shown, the Word file somebody downloads.
 *
 * That is the whole reason it exists. Without a middle, six converters become
 * thirty: Markdown→Word, Markdown→slides, Word→HTML, Word→text, slides→text, and
 * each one its own set of bugs about bold inside a list inside a table. With a
 * middle there are readers, there are writers, and neither has to know the
 * other exists.
 *
 * A block is one of:
 *
 *   heading    { level: 1–6, runs }
 *   paragraph  { runs }
 *   quote      { runs }
 *   code       { text, language? }
 *   list       { ordered, items: [{ level, runs }] }
 *   table      { rows: [[{ runs }]], header }
 *   divider    {}
 *   pagebreak  {}
 *
 * A run is a piece of text with its formatting: `{ text, bold, italic,
 * underline, strike, code, link }`. Nothing nests except lists, which carry
 * their depth as a number — deliberately, because a tree of nested lists is
 * three times the code for a document nobody writes.
 */

const MAX_LEVEL = 6;
const MAX_LIST_DEPTH = 4;

const clamp = (value, low, high) => Math.min(Math.max(Number(value) || low, low), high);

/** Accept a bare string wherever runs are expected — most callers have one. */
function toRuns(input) {
  if (input == null) return [];
  if (typeof input === 'string') return input ? [{ text: input }] : [];
  if (!Array.isArray(input)) return toRuns(input.text);

  const runs = [];
  for (const run of input) {
    if (run == null) continue;
    if (typeof run === 'string') {
      if (run) runs.push({ text: run });
      continue;
    }
    const text = String(run.text ?? '');
    if (!text) continue;
    const clean = { text };
    if (run.bold) clean.bold = true;
    if (run.italic) clean.italic = true;
    if (run.underline) clean.underline = true;
    if (run.strike) clean.strike = true;
    if (run.code) clean.code = true;
    if (run.link && /^(https?:\/\/|mailto:|#)/i.test(String(run.link))) clean.link = String(run.link);
    runs.push(clean);
  }
  return runs;
}

/** Whether these runs amount to anything a reader would see. */
const hasText = (runs) => runs.some((run) => run.text.trim());

/**
 * Put a list of blocks into a state every writer can trust.
 *
 * Writers are where a malformed block becomes a file that will not open, so this
 * is the one place that checks — levels clamped, runs coerced, empty blocks
 * dropped, unknown types treated as paragraphs rather than thrown away.
 */
export function normaliseBlocks(input) {
  const out = [];
  for (const block of Array.isArray(input) ? input : []) {
    if (!block) continue;
    if (typeof block === 'string') {
      if (block.trim()) out.push({ type: 'paragraph', runs: toRuns(block) });
      continue;
    }

    switch (block.type) {
      case 'heading':
      case 'title': {
        const runs = toRuns(block.runs ?? block.text);
        if (hasText(runs)) {
          out.push({ type: 'heading', level: clamp(block.level ?? (block.type === 'title' ? 1 : 2), 1, MAX_LEVEL), runs });
        }
        break;
      }
      case 'quote': {
        const runs = toRuns(block.runs ?? block.text);
        if (hasText(runs)) out.push({ type: 'quote', runs });
        break;
      }
      case 'code': {
        const text = String(block.text ?? '');
        if (text.trim()) out.push({ type: 'code', text, language: block.language || undefined });
        break;
      }
      case 'list': {
        const items = (Array.isArray(block.items) ? block.items : [])
          .map((item) => ({
            level: clamp(item?.level ?? 0, 0, MAX_LIST_DEPTH),
            runs: toRuns(item?.runs ?? item?.text ?? item),
          }))
          .filter((item) => hasText(item.runs));
        if (items.length) out.push({ type: 'list', ordered: !!block.ordered, items });
        break;
      }
      case 'table': {
        const rows = (Array.isArray(block.rows) ? block.rows : [])
          .map((row) => (Array.isArray(row) ? row : [row]).map((cell) => ({ runs: toRuns(cell?.runs ?? cell) })))
          .filter((row) => row.length);
        if (rows.length) out.push({ type: 'table', header: block.header !== false, rows });
        break;
      }
      case 'image':
        // Carries a position into the media list rather than the bytes: a
        // document with thirty figures must not become a thirty-megabyte block
        // tree on its way through three functions.
        out.push({ type: 'image', index: Number(block.index) || 0, alt: String(block.alt || '') });
        break;
      case 'divider':
        out.push({ type: 'divider' });
        break;
      case 'pagebreak':
        out.push({ type: 'pagebreak' });
        break;
      default: {
        const runs = toRuns(block.runs ?? block.text);
        if (hasText(runs)) out.push({ type: 'paragraph', runs });
      }
    }
  }
  return out;
}

/* ── out to text ────────────────────────────────────────────────────── */

export const runsToText = (runs) => (runs || []).map((run) => run.text).join('');

/**
 * One block as bare text — no `#`, no `>`, no fences.
 *
 * `blocksToText` writes Markdown, which is right when the reader is a model or
 * a person looking at source. It is wrong when the destination is a spreadsheet
 * cell or a bullet on a slide, where a stray `>` is not formatting, it is a
 * character somebody has to delete.
 */
export function blockToPlainText(block) {
  if (!block) return '';
  switch (block.type) {
    case 'code':
      return String(block.text || '');
    case 'list':
      return (block.items || []).map((item) => runsToText(item.runs)).join('\n');
    case 'table':
      return (block.rows || []).map((row) => row.map((cell) => runsToText(cell.runs)).join(' | ')).join('\n');
    case 'image':
      return block.alt ? `[${block.alt}]` : '';
    case 'divider':
    case 'pagebreak':
      return '';
    default:
      return runsToText(block.runs);
  }
}

const bullet = (level, ordered, index) =>
  `${'  '.repeat(level)}${ordered ? `${index}.` : '-'} `;

/**
 * The document as plain text, shaped like Markdown.
 *
 * Markdown rather than bare prose because this is mostly read by a model, and a
 * heading that still looks like a heading is the difference between "summarise
 * section 3" working and not. It is also what a person sees if a preview cannot
 * be drawn, so it has to read properly on its own.
 */
export function blocksToText(blocks) {
  const lines = [];

  for (const block of normaliseBlocks(blocks)) {
    switch (block.type) {
      case 'heading':
        lines.push(`${'#'.repeat(block.level)} ${runsToText(block.runs)}`, '');
        break;
      case 'quote':
        lines.push(
          runsToText(block.runs)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
          '',
        );
        break;
      case 'code':
        lines.push('```' + (block.language || ''), block.text, '```', '');
        break;
      case 'list': {
        // Numbering restarts per level, the way a reader expects to see it.
        const counters = [];
        for (const item of block.items) {
          counters.length = item.level + 1;
          counters[item.level] = (counters[item.level] || 0) + 1;
          lines.push(`${bullet(item.level, block.ordered, counters[item.level])}${runsToText(item.runs)}`);
        }
        lines.push('');
        break;
      }
      case 'table': {
        const widths = [];
        const rows = block.rows.map((row) =>
          row.map((cell, i) => {
            const text = runsToText(cell.runs).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();
            widths[i] = Math.max(widths[i] || 0, text.length, 3);
            return text;
          }),
        );
        rows.forEach((row, index) => {
          const cells = widths.map((width, i) => (row[i] || '').padEnd(width));
          lines.push(`| ${cells.join(' | ')} |`);
          if (index === 0 && block.header) {
            lines.push(`| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`);
          }
        });
        lines.push('');
        break;
      }
      case 'image':
        // A Markdown image, so a model reading the text can tell a figure was
        // there and what it was of. No URL: the text rendering travels without
        // the bytes, and inventing a path would be worse than an empty one.
        lines.push(`![${block.alt || 'hình ảnh'}]()`, '');
        break;
      case 'divider':
        lines.push('---', '');
        break;
      case 'pagebreak':
        lines.push('', '');
        break;
      default:
        lines.push(runsToText(block.runs), '');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── out to HTML ────────────────────────────────────────────────────── */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Runs as HTML.
 *
 * Everything is escaped and every tag is one this function chose, so nothing a
 * document contains can become markup. That matters more here than anywhere
 * else in the app: this HTML is built from a file a stranger may have sent, and
 * it is rendered inside the user's own session.
 *
 * Links are the one place a document supplies an attribute value, so the scheme
 * is checked — `javascript:` in an `href` is a script, however it is spelled.
 */
export function runsToHtml(runs) {
  let out = '';
  for (const run of runs || []) {
    let piece = escapeHtml(run.text).replace(/\n/g, '<br>').replace(/\t/g, '&#9;');
    if (run.code) piece = `<code>${piece}</code>`;
    if (run.bold) piece = `<strong>${piece}</strong>`;
    if (run.italic) piece = `<em>${piece}</em>`;
    if (run.underline) piece = `<u>${piece}</u>`;
    if (run.strike) piece = `<s>${piece}</s>`;
    if (run.link && /^(https?:\/\/|mailto:|#)/i.test(run.link)) {
      piece = `<a href="${escapeHtml(run.link)}" target="_blank" rel="noopener noreferrer nofollow">${piece}</a>`;
    }
    out += piece;
  }
  return out;
}

/**
 * The document as a fragment of HTML — no document shell, no styles.
 *
 * @param mediaSrc  where picture number *n* can be fetched from. An image block
 *   carries a position rather than its bytes, so whoever is serving the
 *   document decides the URL — a route, a data URI, or nothing at all. Without
 *   it the pictures degrade to their captions rather than to broken icons.
 */
export function blocksToHtml(blocks, { mediaSrc = () => null } = {}) {
  const html = [];
  const model = normaliseBlocks(blocks);

  for (let i = 0; i < model.length; i += 1) {
    const block = model[i];
    switch (block.type) {
      case 'heading':
        html.push(`<h${block.level}>${runsToHtml(block.runs)}</h${block.level}>`);
        break;
      case 'quote':
        html.push(`<blockquote>${runsToHtml(block.runs)}</blockquote>`);
        break;
      case 'code':
        html.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
        break;
      case 'list':
        html.push(listToHtml(block));
        break;
      case 'table': {
        const row = (cells, tag) =>
          `<tr>${cells.map((cell) => `<${tag}>${runsToHtml(cell.runs)}</${tag}>`).join('')}</tr>`;
        const head = block.header ? `<thead>${row(block.rows[0], 'th')}</thead>` : '';
        const rest = block.rows.slice(block.header ? 1 : 0).map((cells) => row(cells, 'td')).join('');
        html.push(`<table>${head}<tbody>${rest}</tbody></table>`);
        break;
      }
      case 'image': {
        const src = mediaSrc(block.index);
        // No src means nobody offered a way to serve the bytes. A caption in
        // its place beats a broken-image icon.
        html.push(
          src
            ? '<figure class="figure">' +
                `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" loading="lazy" />` +
                (block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : '') +
                '</figure>'
            : `<p class="figure__missing">[${escapeHtml(block.alt || 'hình ảnh')}]</p>`,
        );
        break;
      }
      case 'divider':
        html.push('<hr>');
        break;
      case 'pagebreak':
        html.push('<div class="pagebreak"></div>');
        break;
      default:
        html.push(`<p>${runsToHtml(block.runs)}</p>`);
    }
  }
  return html.join('\n');
}

/**
 * Nested lists, rebuilt from the flat depth each item carries.
 *
 * Built as a tree first and rendered second, so a sublist lands *inside* the
 * item it belongs to. The shortcut — closing the `<li>` and opening a new
 * `<ul>` beside it — renders identically in every browser and is invalid HTML,
 * which matters the moment somebody copies the preview into anything else.
 */
function listToHtml(block) {
  const root = [];
  const stack = [{ level: -1, children: root }];

  for (const item of block.items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop();
    const node = { level: item.level, runs: item.runs, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  const tag = block.ordered ? 'ol' : 'ul';
  const render = (nodes) =>
    `<${tag}>${nodes
      .map((node) => `<li>${runsToHtml(node.runs)}${node.children.length ? render(node.children) : ''}</li>`)
      .join('')}</${tag}>`;

  return render(root);
}
