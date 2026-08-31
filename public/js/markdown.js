/**
 * A small, dependency-free Markdown renderer.
 *
 * Everything is escaped before any markup is generated, so model output can
 * never inject HTML. Supports headings, lists, code fences, inline formatting,
 * blockquotes, tables, links and rules — the subset chat models actually emit.
 */

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A placeholder the source text cannot contain.
 *
 * Inline code is lifted out before emphasis is applied and put back afterwards,
 * which needs a marker to stand in for it. A fixed one is a string a model can
 * simply write — and then its own text addresses somebody else's slot in the
 * array. Nothing escapes (every character was escaped before this runs), but the
 * output is wrong, and "wrong rather than exploitable" is a poor thing to rest
 * on. A token minted per call cannot be guessed by text written beforehand.
 */
const marker = () => `\u0000${Math.random().toString(36).slice(2, 10)}\u0000`;

function inline(text) {
  let out = escapeHtml(text);

  // Inline code first, so its contents are not re-processed as emphasis.
  const codes = [];
  const token = marker();
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `${token}${codes.length - 1}${token}`;
  });

  out = out
    // The one tag let back through after escaping. A model writes `<br>` to
    // stack lines inside a table cell — GFM has no multi-line cell, so this is
    // the only way — and it turns up in ordinary prose as a hard break too.
    // Done here, after code has been tokenised out above, so a `<br>` written
    // inside inline code stays literal; and only `<br>` is un-escaped, so no
    // other tag rides along.
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*(?!\s)(.+?)(?<!\s)\*/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    // Only http(s) and relative links — no javascript: URLs.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const restore = new RegExp(`${token}(\\d+)${token}`, 'g');
  return out.replace(restore, (_, i) => `<code>${codes[Number(i)] ?? ''}</code>`);
}

function codeBlock(language, body) {
  const label = language || 'text';
  return (
    `<div class="codeblock">` +
    `<div class="codeblock__bar"><span>${escapeHtml(label)}</span>` +
    `<button class="copy-btn" type="button" data-copy>Copy</button></div>` +
    `<pre><code>${escapeHtml(body)}</code></pre>` +
    `</div>`
  );
}

/**
 * One row of a table into its cells.
 *
 * The outer pipes are optional — plenty of models write `a | b | c` with none —
 * so they are stripped if present rather than required. `\|` is an escaped pipe
 * inside a cell and must not split it.
 */
function tableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (/(^|[^\\])\|$/.test(text)) text = text.slice(0, -1);
  return text
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** `|---|:--:|` — the line under a header that makes the rows above it a table. */
function alignments(line) {
  const cells = tableRow(line);
  if (!cells.length || !cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells.map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '',
  );
}

/**
 * Does a table begin on this line?
 *
 * Asked in three places, not one. A table was only recognised at the top of the
 * block loop, which meant it was invisible to the paragraph gatherer and the
 * list-item gatherer below — so a table written directly under a line of text,
 * with no blank line between, was swallowed into that paragraph and printed as
 * raw pipes. Models write exactly that, constantly.
 *
 * The cell counts must agree, which is what stops an ordinary sentence
 * containing a pipe from turning the line under it into a table header.
 */
function tableAt(lines, i) {
  const head = lines[i];
  if (!head || !head.includes('|')) return false;
  const aligns = alignments(lines[i + 1] || '');
  return !!aligns && aligns.length === tableRow(head).length;
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      html.push(codeBlock(fence[1], body.join('\n')));
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
      html.push('<hr />');
      i += 1;
      continue;
    }

    // Table: a header row followed by a |---|---| separator
    if (tableAt(lines, i)) {
      const head = tableRow(line);
      const aligns = alignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableRow(lines[i++]));
      const at = (c) => (aligns[c] ? ` style="text-align:${aligns[c]}"` : '');
      html.push(
        '<table><thead><tr>' +
          head.map((cell, c) => `<th${at(c)}>${inline(cell)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (row) =>
                // Padded to the header width. A short row silently dropping its
                // last column is worse than an empty cell, because the table
                // still looks right.
                `<tr>${head.map((_, c) => `<td${at(c)}>${inline(row[c] ?? '')}</td>`).join('')}</tr>`,
            )
            .join('') +
          '</tbody></table>',
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i += 1;
        // Absorb wrapped continuation lines into the same bullet — but not a
        // table starting under it, which is a block of its own.
        while (
          i < lines.length &&
          lines[i].trim() &&
          !bullet.test(lines[i]) &&
          !numbered.test(lines[i]) &&
          !/^```/.test(lines[i]) &&
          !tableAt(lines, i)
        ) {
          item += ` ${lines[i].trim()}`;
          i += 1;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // Paragraph: gather until a blank line or a block-level construct.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^([-*_])\1{2,}\s*$/.test(lines[i].trim()) &&
      !tableAt(lines, i) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    html.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return html.join('');
}

/** Delegated copy-to-clipboard for every rendered code block. */
export function wireCopyButtons(root) {
  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1400);
    } catch {
      btn.textContent = 'Press ⌘/Ctrl+C';
    }
  });
}
