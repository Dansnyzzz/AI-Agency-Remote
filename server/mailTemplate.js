/**
 * What a sent email looks like.
 *
 * The assistant writes a message in Markdown; this turns it into an email a
 * person would be glad to receive — a branded header, the subject as a title,
 * readable typography, section headings, lists, tables, and a footer that says
 * who sent it and how to reach them — plus a clean plain-text twin.
 *
 * Email HTML is not web HTML. Gmail strips `<style>` blocks in some clients,
 * Outlook renders with Word, and nothing may load from the internet without
 * a warning. So everything here is:
 *
 *   - **tables for layout and inline styles** on every element;
 *   - **no images, fonts or scripts** — a system font stack, colour and spacing
 *     do the design, and nothing is fetched, which is also what keeps a message
 *     out of spam filters that score remote content and image-heavy mail;
 *   - **600px wide at most**, fluid below it, so a phone shows it without
 *     sideways scrolling;
 *   - **escaped before any markup is added**, like the chat renderer, so a
 *     message cannot inject HTML into someone's inbox. Links are http(s) only.
 */

const COLOR = {
  page: '#f3f5f8',
  card: '#ffffff',
  line: '#e5e9ef',
  text: '#1c2733',
  muted: '#667385',
  faint: '#98a3b3',
  accent: '#0e8f63',
  accentSoft: '#e8f6f0',
  codeBg: '#f1f3f6',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

export const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ── inline ─────────────────────────────────────────────────────────── */

function inline(text) {
  const slots = [];
  const hold = (html) => `\uE000${slots.push(html) - 1}\uE000`;
  let out = String(text)
    .replace(/`([^`]+)`/g, (whole, code) =>
      hold(
        `<code style="font-family:${MONO};font-size:13px;background:${COLOR.codeBg};border-radius:4px;padding:1px 5px;color:${COLOR.text}">${escapeHtml(code)}</code>`,
      ),
    )
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (whole, label, url) => hold(link(escapeHtml(url), escapeHtml(label))));
  out = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="font-weight:600;color:${COLOR.text}">$1</strong>`)
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>')
    // A bare link reads as its site — "nhandan.vn", not "https://nhandan.vn/".
    .replace(/(^|[\s(])(https?:\/\/[^\s<)\uE000]+)/g, (whole, lead, url) =>
      `${lead}${link(url, url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}`,
    );
  return out.replace(/\uE000(\d+)\uE000/g, (whole, i) => slots[Number(i)] ?? '');
}

/** Both arguments arrive escaped; only http(s) URLs are ever matched into one. */
function link(href, label) {
  return `<a href="${href}" style="color:${COLOR.accent};text-decoration:underline;text-underline-offset:2px">${label}</a>`;
}

/* ── blocks ─────────────────────────────────────────────────────────── */

const P = `margin:0 0 16px;font-size:15px;line-height:1.7;color:${COLOR.text}`;

/**
 * A line written in capitals is a section heading. Models writing plain text
 * for an email do exactly this ("CHỨNG KHOÁN VIỆT NAM"), and rendering it as a
 * shouted paragraph is most of what made those messages look unfinished.
 */
function isCapsHeading(line) {
  const text = line.trim();
  if (text.length < 3 || text.length > 80 || /[.!?,;]$/.test(text)) return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toLocaleUpperCase('vi') && letters !== letters.toLocaleLowerCase('vi');
}

function heading(text, level) {
  if (level === 'caps') {
    // Kept in the capitals it was written in — lower-casing it would also
    // lower-case the proper nouns ("VIỆT NAM") — and set smaller with a little
    // tracking, which is how capitals read as a label rather than a shout.
    return (
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 12px">` +
      `<tr><td width="4" style="background:${COLOR.accent};border-radius:2px">&nbsp;</td>` +
      `<td style="padding-left:12px;font-size:14px;line-height:1.4;font-weight:700;letter-spacing:0.05em;color:${COLOR.text}">${inline(text)}</td></tr></table>`
    );
  }
  if (level === 1) {
    return `<h2 style="margin:28px 0 12px;font-size:20px;line-height:1.35;font-weight:700;color:${COLOR.text}">${inline(text)}</h2>`;
  }
  // A section: an accent bar and a clear break from what came before.
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 12px">` +
    `<tr><td width="4" style="background:${COLOR.accent};border-radius:2px">&nbsp;</td>` +
    `<td style="padding-left:12px;font-size:${level === 2 ? 17 : 15}px;line-height:1.4;font-weight:700;color:${COLOR.text}">${inline(text)}</td></tr></table>`
  );
}

/** "Nguồn: …" / "Sources: …" — attribution, set small and quiet under its section. */
const SOURCE_LINE = /^(nguồn|nguồn tham khảo|source|sources)\s*:/i;

function tableHtml(head, rows) {
  const cell = (content, isHead, zebra) =>
    `<td style="padding:9px 12px;border-bottom:1px solid ${COLOR.line};font-size:14px;line-height:1.5;` +
    `${isHead ? `font-weight:600;color:${COLOR.muted};background:${COLOR.codeBg};` : `color:${COLOR.text};`}` +
    `${zebra ? 'background:#fafbfc;' : ''}">${inline(content)}</td>`;
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border:1px solid ${COLOR.line};border-radius:8px;border-collapse:separate;overflow:hidden">` +
    `<tr>${head.map((h) => cell(h, true, false)).join('')}</tr>` +
    rows.map((row, r) => `<tr>${head.map((_, c) => cell(row[c] ?? '', false, r % 2 === 1)).join('')}</tr>`).join('') +
    '</table>'
  );
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** The body of a message, Markdown in, email-safe HTML out. */
export function renderEmailBody(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      out.push(
        `<pre style="margin:0 0 16px;padding:14px 16px;background:${COLOR.codeBg};border-radius:8px;font-family:${MONO};font-size:13px;line-height:1.55;color:${COLOR.text};white-space:pre-wrap;word-break:break-word">${escapeHtml(body.join('\n'))}</pre>`,
      );
      continue;
    }

    const hashes = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hashes) {
      out.push(heading(hashes[2], Math.min(hashes[1].length, 3)));
      i += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      out.push(`<hr style="border:0;border-top:1px solid ${COLOR.line};margin:24px 0">`);
      i += 1;
      continue;
    }

    if (trimmed.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(tableHtml(head, rows));
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(
        `<div style="margin:0 0 16px;padding:12px 16px;background:${COLOR.accentSoft};border-left:3px solid ${COLOR.accent};border-radius:0 8px 8px 0;font-size:15px;line-height:1.65;color:${COLOR.text}">${quote.map(inline).join('<br>')}</div>`,
      );
      continue;
    }

    const bullet = /^\s*[-*•+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i += 1;
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
          item += ` ${lines[i++].trim()}`;
        }
        items.push(`<li style="margin:0 0 8px;padding-left:4px">${inline(item)}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} style="margin:0 0 16px;padding-left:22px;font-size:15px;line-height:1.65;color:${COLOR.text}">${items.join('')}</${tag}>`);
      continue;
    }

    if (isCapsHeading(line)) {
      out.push(heading(trimmed, 'caps'));
      i += 1;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,4}\s|>|[-*•+]\s|\d+[.)]\s)/.test(lines[i]) &&
      !(para.length && isCapsHeading(lines[i]))
    ) {
      para.push(lines[i++].trim());
    }
    const text = para.join('\n');
    if (SOURCE_LINE.test(text)) {
      out.push(`<p style="margin:-6px 0 16px;font-size:12.5px;line-height:1.6;color:${COLOR.faint}">${inline(text).replace(/\n/g, '<br>')}</p>`);
    } else {
      out.push(`<p style="${P}">${inline(text).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** The same message as plain text: Markdown marks removed, links spelled out. */
export function plainTextFrom(markdown) {
  return String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,4}\s+(.*)$/gm, (whole, text) => text.toLocaleUpperCase('vi'))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const WORDS = {
  en: { sentBy: 'Sent by', via: 'with', reply: 'Reply to this email to reach them directly.', brandLine: 'An AI workspace' },
  vi: { sentBy: 'Gửi bởi', via: 'qua', reply: 'Trả lời email này để liên hệ trực tiếp với người gửi.', brandLine: 'Không gian làm việc AI' },
};

function dateLine(language, now) {
  try {
    return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(now);
  } catch {
    return '';
  }
}

/**
 * The whole message around a body.
 *
 * @param {object} options
 * @param {string} options.brand        the deployment's name, in the header
 * @param {string} options.title        shown as the heading — usually the subject
 * @param {string} options.contentHtml  already rendered and escaped
 * @param {string} [options.preheader]  the preview line an inbox shows beside the subject
 * @param {string} [options.footerHtml] already escaped
 * @param {string} [options.language]   'vi' or 'en', for the date and the lang attribute
 */
export function layoutEmail({ brand, title, contentHtml, preheader = '', footerHtml = '', language = 'en', now = new Date() }) {
  const words = WORDS[language] || WORDS.en;
  const date = dateLine(language, now);
  return `<!doctype html>
<html lang="${language === 'vi' ? 'vi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page}">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT}">
    <tr><td style="padding:0 8px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="26" height="26" align="center" valign="middle" style="background:${COLOR.accent};border-radius:7px;color:#ffffff;font-size:15px;font-weight:700;line-height:26px;font-family:${FONT}">${escapeHtml(brand.charAt(0).toUpperCase())}</td>
        <td style="padding-left:10px;font-size:16px;font-weight:700;letter-spacing:-0.01em;color:${COLOR.text};font-family:${FONT}">${escapeHtml(brand)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:${COLOR.card};border:1px solid ${COLOR.line};border-radius:14px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td height="4" style="background:${COLOR.accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:30px 28px 8px">
          ${date ? `<div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:${COLOR.faint};margin:0 0 8px">${escapeHtml(date)}</div>` : ''}
          <h1 style="margin:0 0 22px;font-size:25px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:${COLOR.text}">${escapeHtml(title)}</h1>
          ${contentHtml}
        </td></tr>
        ${
          footerHtml
            ? `<tr><td style="padding:18px 28px 24px;border-top:1px solid ${COLOR.line};background:#fafbfc;font-size:13px;line-height:1.6;color:${COLOR.muted}">${footerHtml}</td></tr>`
            : ''
        }
      </table>
    </td></tr>
    <tr><td align="center" style="padding:18px 8px 0;font-size:12px;line-height:1.6;color:${COLOR.faint}">
      ${escapeHtml(brand)} · ${escapeHtml(words.brandLine)}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * A message the assistant sends for somebody: body, footer and plain twin.
 *
 * @returns {{ html: string, text: string }}
 */
export function composeMessage({ brand, subject, markdown, sender, language = 'en', now = new Date() }) {
  const words = WORDS[language] || WORDS.en;
  const text = plainTextFrom(markdown);
  const preheader = text.replace(/\s+/g, ' ').slice(0, 120);
  const who = sender?.email ? (sender.name ? `${sender.name} (${sender.email})` : sender.email) : '';
  const footerHtml = who
    ? `${escapeHtml(words.sentBy)} <strong style="color:${COLOR.text};font-weight:600">${escapeHtml(sender.name || sender.email)}</strong>` +
      `${sender.name ? ` &lt;<a href="mailto:${escapeHtml(sender.email)}" style="color:${COLOR.accent}">${escapeHtml(sender.email)}</a>&gt;` : ''}` +
      ` ${escapeHtml(words.via)} ${escapeHtml(brand)}.<br>${escapeHtml(words.reply)}`
    : '';
  const footerText = who ? `${words.sentBy} ${who} ${words.via} ${brand}. ${words.reply}` : '';
  return {
    html: layoutEmail({ brand, title: subject, contentHtml: renderEmailBody(markdown), preheader, footerHtml, language, now }),
    text: footerText ? `${text}\n\n—\n${footerText}` : text,
  };
}

/**
 * The password-reset message, on the same layout: the code large and first,
 * then a button, then the raw link for a client that will not show buttons.
 */
export function resetMessage({ brand, code, link }) {
  const button =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>` +
    `<td style="background:${COLOR.accent};border-radius:9px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Choose a new password</a></td>` +
    `</tr></table>`;
  const content =
    `<p style="${P}">Type this code into the app to choose a new password. It is good for one hour and works once.</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr>` +
    `<td align="center" style="padding:20px;background:${COLOR.accentSoft};border:1px solid #bfe5d4;border-radius:12px">` +
    `<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${COLOR.muted};margin:0 0 8px">Your code</div>` +
    `<div style="font-family:${MONO};font-size:34px;font-weight:700;letter-spacing:0.3em;color:${COLOR.accent}">${escapeHtml(code)}</div>` +
    `</td></tr></table>` +
    `<p style="margin:0 0 12px;font-size:14px;color:${COLOR.muted}">Or open the link instead:</p>` +
    button +
    `<p style="margin:0;font-size:12px;line-height:1.6;color:${COLOR.faint};word-break:break-all">If the button does not work, paste this into your browser:<br>${escapeHtml(link)}</p>`;
  return layoutEmail({
    brand,
    title: 'Reset your password',
    contentHtml: content,
    preheader: `${code} is your ${brand} reset code`,
    footerHtml: escapeHtml('If you did not ask for this, ignore this message — your password has not changed.'),
  });
}
