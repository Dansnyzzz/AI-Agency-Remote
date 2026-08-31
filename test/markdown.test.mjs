/**
 * The Markdown renderer, on the shapes chat models actually emit.
 *
 * Tables are the whole reason this file exists. A model writes a bold lead-in
 * line and then a table directly under it with no blank line between — which is
 * valid Markdown and is what every one of them does — and the renderer printed
 * the pipes as text. It happened because a table was recognised only at the top
 * of the block loop, so the paragraph gatherer below reached it first and ate it.
 */

import { renderMarkdown, escapeHtml } from '../public/js/markdown.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
function check(what, ok, note = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${what}${note ? ` — ${note}` : ''}`);
}

/* ── the bug in the screenshot ─────────────────────────────────── */

section('a table written straight under a line of text');
{
  // Copied from a real reply: a bold lead-in, then the table, no blank line.
  const html = renderMarkdown(
    ['**Trong đời thực:**', '| Tình huống | Câu mở đầu |', '|---|---|', '| Ở bar/party | "Bài này hay quá" |'].join(
      '\n',
    ),
  );

  check('is a table, not a paragraph of pipes', html.includes('<table>'), html.slice(0, 80));
  check('the lead-in stays its own paragraph', html.includes('<p><strong>Trong đời thực:</strong></p>'));
  check('the header row is a header', html.includes('<th>Tình huống</th>'));
  check('the body row is a body row', html.includes('<td>Ở bar/party</td>'));
  check('and no raw pipe survives', !html.includes('|'), html.slice(0, 120));
}

section('and one written under a bullet');
{
  const html = renderMarkdown(['- Bước một:', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'));
  check('the bullet ends where the table starts', html.includes('<li>Bước một:</li>'));
  check('and the table is a table', html.includes('<table>') && html.includes('<td>1</td>'), html.slice(0, 100));
}

section('with a blank line, as before');
{
  const html = renderMarkdown(['Trước.', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'Sau.'].join('\n'));
  check('still works', html.includes('<table>'));
  check('and the paragraphs either side survive', html.includes('<p>Trước.</p>') && html.includes('<p>Sau.</p>'));
}

/* ── the shapes models write ───────────────────────────────────── */

section('tables models actually emit');
{
  const bare = renderMarkdown(['Metric | Old | New', '--- | --- | ---', 'Documents | 408 | 275'].join('\n'));
  check('no outer pipes at all', bare.includes('<th>Metric</th>') && bare.includes('<td>275</td>'), bare.slice(0, 90));

  const aligned = renderMarkdown(['| Left | Mid | Right |', '|:---|:---:|---:|', '| a | b | c |'].join('\n'));
  check('alignment is honoured', aligned.includes('style="text-align:center"'), aligned.slice(0, 160));
  check('right too', aligned.includes('style="text-align:right"'));

  // A row shorter than the header used to lose its last column silently, which
  // is worse than an empty cell because the table still looks correct.
  const ragged = renderMarkdown(['| A | B | C |', '|---|---|---|', '| 1 | 2 |'].join('\n'));
  check('a short row is padded, not truncated', (ragged.match(/<td/g) || []).length === 3, ragged.slice(-90));

  const escaped = renderMarkdown(['| Cột | Ghi chú |', '|---|---|', '| a \\| b | ống |'].join('\n'));
  check('an escaped pipe stays in its cell', escaped.includes('<td>a | b</td>'), escaped.slice(-80));

  // Inline formatting inside cells, which is most of what a table is for.
  const rich = renderMarkdown(['| Mục | Giá trị |', '|---|---|', '| **đậm** | `mã` |'].join('\n'));
  check('cells are formatted, not printed raw', rich.includes('<strong>đậm</strong>') && rich.includes('<code>mã</code>'));
}

/* ── the second bug in the screenshot ──────────────────────────── */

section('a line break inside a cell');
{
  // GFM has no multi-line table cell, so every model writes <br> to stack
  // lines inside one — exactly what the screenshot showed printed as raw text.
  const html = renderMarkdown(['| Việc |', '|---|', '| 40-50 words<br>• 10 phút |'].join('\n'));
  check('<br> becomes a real break, not text', html.includes('40-50 words<br>• 10 phút'), html.slice(-90));
  check('and the raw tag is gone', !html.includes('&lt;br'), html.slice(-90));

  // The self-closing shapes a model also writes.
  const slash = renderMarkdown(['| A |', '|---|', '| one<br/>two<br />three |'].join('\n'));
  check('<br/> and <br /> too', (slash.match(/<br>/g) || []).length === 2, slash.slice(-70));

  // It works in ordinary prose as well, and this is the guard that matters:
  // only <br> is let back through — no other tag escapes escaping.
  const prose = renderMarkdown('line one<br>line two, and <script>alert(1)</script>');
  check('a break in prose is honoured', prose.includes('line one<br>line two'), prose.slice(0, 80));
  check('but nothing else is un-escaped', prose.includes('&lt;script&gt;'), prose.slice(0, 120));

  // A <br> written inside inline code stays literal — code is verbatim.
  const code = renderMarkdown('use `<br>` to break');
  check('a <br> inside code stays literal', code.includes('<code>&lt;br&gt;</code>'), code.slice(0, 80));
}

section('and things that only look like tables');
{
  const prose = renderMarkdown(['Chọn a | b tuỳ ý.', '-----------'].join('\n'));
  check('a sentence with a pipe is not a table', !prose.includes('<table>'), prose.slice(0, 90));

  const rule = renderMarkdown(['Trước.', '---', 'Sau.'].join('\n'));
  check('a rule under a paragraph ends it', rule.includes('<p>Trước.</p>') && rule.includes('<hr />'), rule);
}

/* ── the thing this renderer must never do ─────────────────────── */

section('nothing a model writes becomes markup');
{
  const html = renderMarkdown('| <img src=x onerror=alert(1)> | b |\n|---|---|\n| <script>x</script> | d |');
  check('a tag in a cell is text', !html.includes('<img') && !html.includes('<script>'), html.slice(0, 120));
  check('and it is still a table', html.includes('<table>'));
  check('escapeHtml is what does it', escapeHtml('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;');
}

console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll markdown checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
