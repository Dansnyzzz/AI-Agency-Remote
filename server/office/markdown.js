/**
 * Markdown in, blocks out.
 *
 * The assistant writes documents in Markdown because that is what it is best at
 * — headings, lists and tables come out right without being asked twice, and a
 * person can read the source. Everything downstream is a rendering of the blocks
 * this produces: a Word file, a slide deck, a spreadsheet, an HTML page.
 *
 * That is one converter instead of four, and it means "make this a .docx
 * instead" is a different last step rather than a different document.
 *
 * The dialect is the common one: ATX headings, `-`/`*`/`+` and `1.` lists with
 * two-space nesting, GitHub tables, fenced code, blockquotes, thematic breaks,
 * and inline `**bold**`, `*italic*`, `` `code` ``, `~~strike~~` and
 * `[text](url)`. Reference links, footnotes, HTML blocks and setext headings are
 * not handled — they do not appear in generated documents, and each one is more
 * surface than it is worth.
 */

/* ── inline ─────────────────────────────────────────────────────────── */

/**
 * A line of Markdown as formatted runs.
 *
 * Written as one pass over the string rather than a chain of regular
 * expressions, because the chain approach cannot tell that the asterisks inside
 * `` `a * b` `` are not emphasis — and code spans full of punctuation are
 * exactly what an assistant writes.
 */
export function parseInline(source, inherited = {}) {
  const text = String(source ?? '');
  const runs = [];
  let plain = '';

  const flush = () => {
    if (plain) runs.push({ text: plain, ...inherited });
    plain = '';
  };

  const at = (i) => text[i];

  for (let i = 0; i < text.length; ) {
    const char = at(i);

    // A backslash escapes the next character, which is how a document says
    // "an actual asterisk".
    if (char === '\\' && i + 1 < text.length && /[\\`*_~[\]()#+\-.!|>]/.test(at(i + 1))) {
      plain += at(i + 1);
      i += 2;
      continue;
    }

    if (char === '`') {
      // A code span is delimited by a run of backticks of the same length, so
      // ``a ` b`` works.
      let ticks = 0;
      while (at(i + ticks) === '`') ticks += 1;
      const fence = '`'.repeat(ticks);
      const end = text.indexOf(fence, i + ticks);
      if (end !== -1) {
        flush();
        const body = text.slice(i + ticks, end);
        // One leading and trailing space is stripped, per CommonMark, so
        // `` ` `` can hold a backtick.
        runs.push({ text: body.replace(/^ (.*) $/, '$1'), ...inherited, code: true });
        i = end + ticks;
        continue;
      }
    }

    if (char === '[') {
      const link = matchLink(text, i);
      if (link) {
        flush();
        runs.push(...parseInline(link.label, { ...inherited, link: link.href }));
        i = link.end;
        continue;
      }
    }

    // Images become their alt text: a document model with no picture in it
    // should say what the picture was, not swallow the line.
    if (char === '!' && at(i + 1) === '[') {
      const link = matchLink(text, i + 1);
      if (link) {
        flush();
        if (link.label) runs.push({ text: link.label, ...inherited, italic: true });
        i = link.end;
        continue;
      }
    }

    const emphasis = matchEmphasis(text, i);
    if (emphasis) {
      flush();
      runs.push(...parseInline(emphasis.body, { ...inherited, ...emphasis.format }));
      i = emphasis.end;
      continue;
    }

    plain += char;
    i += 1;
  }

  flush();
  return runs;
}

/** `[label](href)`, with balanced parentheses in the target. */
function matchLink(text, start) {
  let depth = 0;
  let close = -1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || text[close + 1] !== '(') return null;

  let parens = 0;
  let end = -1;
  for (let i = close + 1; i < text.length; i += 1) {
    if (text[i] === '(') parens += 1;
    else if (text[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  // A title after the URL — `[a](b "c")` — is not carried anywhere, so it is
  // dropped rather than becoming part of the address.
  const href = text
    .slice(close + 2, end)
    .trim()
    .replace(/\s+"[^"]*"$/, '')
    .replace(/^<|>$/g, '');
  return { label: text.slice(start + 1, close), href, end: end + 1 };
}

const DELIMITERS = [
  { mark: '***', format: { bold: true, italic: true } },
  { mark: '___', format: { bold: true, italic: true } },
  { mark: '~~', format: { strike: true } },
  { mark: '**', format: { bold: true } },
  { mark: '__', format: { bold: true } },
  { mark: '*', format: { italic: true } },
  { mark: '_', format: { italic: true } },
];

function matchEmphasis(text, start) {
  for (const { mark, format } of DELIMITERS) {
    if (!text.startsWith(mark, start)) continue;
    // Emphasis cannot open on whitespace: `a * b * c` is arithmetic, not italics.
    if (/\s/.test(text[start + mark.length] || '')) continue;

    // Underscores inside a word are part of the word — `snake_case_name`.
    if (mark === '_' && start > 0 && /[\wÀ-ɏ]/.test(text[start - 1])) continue;

    let at = start + mark.length;
    while (at < text.length) {
      const found = text.indexOf(mark, at);
      if (found === -1) break;
      if (text[found - 1] === '\\' || /\s/.test(text[found - 1])) {
        at = found + 1;
        continue;
      }
      if (mark === '_' && /[\wÀ-ɏ]/.test(text[found + mark.length] || '')) {
        at = found + 1;
        continue;
      }
      return { body: text.slice(start + mark.length, found), format, end: found + mark.length };
    }
  }
  return null;
}

/* ── blocks ─────────────────────────────────────────────────────────── */

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const DIVIDER = /^\s{0,3}([-*_])\s*(\1\s*){2,}$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/;
const PAGE_BREAK = /^\s*(\\pagebreak|<!--\s*pagebreak\s*-->|\+\+\+)\s*$/i;

/** Split a table row on unescaped pipes. */
function splitCells(line) {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (line[i] === '|') {
      cells.push(current);
      current = '';
    } else current += line[i];
  }
  cells.push(current);
  // The leading and trailing pipes produce empty cells at both ends.
  if (!cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((cell) => cell.trim());
}

/**
 * Markdown → blocks.
 *
 * @param source the document
 * @returns blocks ready for any of the writers
 */
export function markdownToBlocks(source) {
  const lines = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;

  const paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n').trim();
    paragraph.length = 0;
    if (text) blocks.push({ type: 'paragraph', runs: parseInline(text) });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const body = [];
      i += 1;
      while (i < lines.length) {
        const closing = FENCE.exec(lines[i]);
        if (closing && closing[1][0] === marker && closing[1].length >= fence[1].length) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', text: body.join('\n'), language: fence[2] || undefined });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        // Closing hashes — `## Title ##` — are decoration, not text.
        runs: parseInline(heading[2].replace(/\s+#+\s*$/, '').trim()),
      });
      i += 1;
      continue;
    }

    if (DIVIDER.test(line)) {
      flushParagraph();
      blocks.push({ type: 'divider' });
      i += 1;
      continue;
    }

    if (PAGE_BREAK.test(line)) {
      flushParagraph();
      blocks.push({ type: 'pagebreak' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', runs: parseInline(body.join('\n').trim()) });
      continue;
    }

    // A table needs its separator row to be a table at all, which is what keeps
    // a paragraph containing a pipe from becoming one.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph();
      const rows = [splitCells(TABLE_ROW.exec(line)[1])];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(splitCells(TABLE_ROW.exec(lines[i])[1]));
        i += 1;
      }
      const width = Math.max(...rows.map((row) => row.length));
      blocks.push({
        type: 'table',
        header: true,
        rows: rows.map((row) =>
          Array.from({ length: width }, (_, column) => ({ runs: parseInline(row[column] || '') })),
        ),
      });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flushParagraph();
      const ordered = !BULLET.test(line);
      const items = [];

      while (i < lines.length) {
        const bullet = BULLET.exec(lines[i]);
        const numbered = NUMBERED.exec(lines[i]);
        const match = ordered ? numbered : bullet;

        if (!match) {
          // A wrapped line belongs to the item above it.
          if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !bullet && !numbered) {
            const last = items[items.length - 1];
            last.text += ` ${lines[i].trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        // A bullet in the middle of a numbered list — or the other way round —
        // starts a new list rather than joining this one.
        if ((ordered && bullet && !numbered) || (!ordered && numbered && !bullet)) break;

        items.push({ level: Math.floor(match[1].replace(/\t/g, '  ').length / 2), text: match[3] });
        i += 1;
      }

      blocks.push({
        type: 'list',
        ordered,
        items: items.map((item) => ({ level: item.level, runs: parseInline(item.text) })),
      });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * The first heading in a document, which is what its title should be.
 *
 * Used to name a file when nobody said what to call it — "Q3 report.docx" beats
 * "document.docx", and the model already wrote the words.
 */
export function markdownTitle(source) {
  const heading = /^#{1,6}\s+(.+)$/m.exec(String(source ?? ''));
  if (!heading) return null;
  return heading[1].replace(/[*_`~]/g, '').replace(/\s+#+\s*$/, '').trim() || null;
}
