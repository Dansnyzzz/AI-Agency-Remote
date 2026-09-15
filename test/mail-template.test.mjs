/**
 * The layout of a sent email.
 *
 * What a person receives is the product's face in someone else's inbox, so the
 * checks here are the ones that would embarrass it: markup injected through a
 * message, a remote image or font that triggers "images are hidden" and spam
 * scoring, a heading that lower-cased a proper noun, and a plain-text part
 * full of Markdown punctuation.
 *
 *   node test/mail-template.test.mjs
 */
import { composeMessage, renderEmailBody, plainTextFrom, layoutEmail, resetMessage } from '../server/mailTemplate.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const markdown = [
  'CHỨNG KHOÁN VIỆT NAM',
  'VN-Index giảm **6,98 điểm** — xem https://nhandan.vn/tin-a/ và [PHS](https://phs.vn).',
  '',
  'Nguồn: https://vietnamfinance.vn',
  '',
  '## Chứng khoán Mỹ',
  '- S&P 500 giảm 0,48%',
  '- Nasdaq giảm `0,56%`',
  '',
  '| Chỉ số | Thay đổi |',
  '|---|---|',
  '| VN-Index | -6,98 |',
  '',
  '> Tổng kết tuần.',
].join('\n');

section('a message is laid out, not dumped');
{
  const body = renderEmailBody(markdown);
  check('a line in capitals is a section heading', /letter-spacing:0\.05em[^>]*>CHỨNG KHOÁN VIỆT NAM<\/td>/.test(body), body.slice(0, 300));
  check('and keeps its capitals, so proper nouns stay right', !body.includes('việt nam'));
  check('## is a section heading', />Chứng khoán Mỹ<\/td>/.test(body));
  check('bold is bold', /<strong[^>]*>6,98 điểm<\/strong>/.test(body));
  check('a bare link reads as its site', /<a href="https:\/\/nhandan\.vn\/tin-a\/"[^>]*>nhandan\.vn\/tin-a<\/a>/.test(body), body.match(/<a[^>]*nhandan[^<]*<\/a>/)?.[0]);
  check('a Markdown link keeps its label', /<a href="https:\/\/phs\.vn"[^>]*>PHS<\/a>/.test(body));
  check('a sources line is set small and quiet', /font-size:12\.5px[^>]*>Nguồn:/.test(body));
  check('bullets are a list', (body.match(/<li /g) || []).length === 2 && body.includes('S&amp;P 500'));
  check('inline code is code', /<code[^>]*>0,56%<\/code>/.test(body));
  check('a table is a table', body.includes('>VN-Index</td>') && body.includes('>Thay đổi</td>'));
  check('a quote is a callout', /border-left:3px solid[^>]*>Tổng kết tuần\.<\/div>/.test(body));
}

section('nothing in a message can become markup or a script');
{
  const body = renderEmailBody('Hi <img src=x onerror=alert(1)> **<script>x</script>** [click](javascript:alert(1)) `<b>`');
  check('tags are escaped', !/<img|<script|<b>/.test(body), body);
  check('a javascript: link is not a link', !/href="javascript/i.test(body));
  const quoted = renderEmailBody('[a](https://x.example/"onmouseover="alert(1))');
  check('a quote cannot break out of an href', !/"onmouseover=/.test(quoted), quoted);
  const title = layoutEmail({ brand: 'Synapse', title: '<b>Subject</b>', contentHtml: '' });
  check('the subject is escaped as the title', title.includes('&lt;b&gt;Subject&lt;/b&gt;') && !title.includes('<b>Subject'));
}

section('the email loads nothing from anywhere');
{
  const { html } = composeMessage({ brand: 'Synapse', subject: 'S', markdown, sender: { name: 'Lan', email: 'lan@example.com' }, language: 'vi' });
  check('no images', !/<img/i.test(html));
  check('no stylesheets, fonts or scripts', !/<link|<script|@import|url\(/i.test(html));
  check('no src attributes at all', !/\ssrc=/i.test(html));
  check('600px wide at most', html.includes('max-width:600px'));
  check('with a hidden preview line for the inbox', /display:none;max-height:0[^>]*>CHỨNG KHOÁN VIỆT NAM VN-Index/.test(html));
}

section('the footer and date speak the message language');
{
  const now = new Date('2026-09-15T05:00:00Z');
  const vi = composeMessage({ brand: 'Synapse', subject: 'S', markdown: 'x', sender: { name: 'Lan', email: 'lan@example.com' }, language: 'vi', now });
  check('Vietnamese footer', vi.html.includes('Gửi bởi <strong') && vi.html.includes('Trả lời email này'));
  check('Vietnamese date', /15 tháng 9, 2026/i.test(vi.html), vi.html.match(/THỨ|Thứ[^<]*/)?.[0]);
  const en = composeMessage({ brand: 'Synapse', subject: 'S', markdown: 'x', sender: { email: 'lan@example.com' }, language: 'en', now });
  check('English footer', en.html.includes('Sent by <strong') && en.text.includes('Sent by lan@example.com with Synapse'));
  const nobody = composeMessage({ brand: 'Synapse', subject: 'S', markdown: 'x', sender: null, language: 'en' });
  check('no sender, no footer', !nobody.html.includes('Sent by'));
}

section('the plain-text part reads as plain text');
{
  const text = plainTextFrom('## Heading\n**bold** and `code` and [PHS](https://phs.vn)\n\n\n\nend');
  check('headings become capitals', text.startsWith('HEADING'), text);
  check('marks are removed', !/\*\*|`|\[|\]\(/.test(text), text);
  check('links are spelled out', text.includes('PHS (https://phs.vn)'));
  check('runs of blank lines collapse', !text.includes('\n\n\n'));
}

section('the reset email shares the layout');
{
  const html = resetMessage({ brand: 'Synapse', code: '482913', link: 'https://app.example/r?t=a&b=c' });
  check('the code is shown large', /font-size:34px[^>]*>482913</.test(html));
  check('the link is escaped into the button', html.includes('href="https://app.example/r?t=a&amp;b=c"'));
  check('and nothing is loaded', !/<img|<link|<script|\ssrc=/i.test(html));
}

console.log(failures === 0 ? '\n\x1b[32mAll mail template checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
