import nodemailer from 'nodemailer';
import { log } from './util/trace.js';

/**
 * Email delivery with three backends, chosen by whichever is configured:
 *
 *   1. Resend  — RESEND_API_KEY. Plain HTTPS, works on Vercel with no SMTP port.
 *   2. SMTP    — SMTP_HOST/PORT/USER/PASS. Any provider. Gmail has a shortcut:
 *                GMAIL_USER + GMAIL_APP_PASSWORD fill in the rest.
 *   3. Console — neither configured: the link is printed to the server log.
 *
 * The console fallback exists so local development and first-run setup are not
 * blocked on picking a mail provider. It is obviously not for production, and
 * `emailBackend()` reports which one is live so the UI can say so.
 */
export function emailBackend() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (smtpSettings()) return 'smtp';
  return 'console';
}

/**
 * The SMTP server to use, or null.
 *
 * Gmail is the common case for a deployment's own mailbox, and its settings are
 * fixed — so two variables (the address and an App Password, which Google issues
 * under Security → 2-Step Verification → App passwords) are enough. Explicit
 * SMTP_* values win when both are present.
 */
function smtpSettings() {
  if (process.env.SMTP_HOST) {
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    };
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return {
      host: 'smtp.gmail.com',
      port: 465,
      user: process.env.GMAIL_USER.trim(),
      // Google shows the App Password in groups of four with spaces.
      pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
    };
  }
  return null;
}

/** The mailbox mail is sent from: EMAIL_FROM, else the SMTP login, else Resend's test sender. */
function senderMailbox() {
  const configured = process.env.EMAIL_FROM || '';
  const inAngles = configured.match(/<([^>]+)>/);
  if (inAngles) return { name: configured.slice(0, configured.indexOf('<')).trim().replace(/^"|"$/g, ''), address: inAngles[1].trim() };
  if (configured.includes('@')) return { name: 'Synapse', address: configured.trim() };
  const login = smtpSettings()?.user;
  if (login && login.includes('@')) return { name: 'Synapse', address: login };
  return { name: 'Synapse', address: 'onboarding@resend.dev' };
}

/**
 * A display name safe to put in a header: no quotes, angle brackets or line
 * breaks, which are what would let a name write a second header or a second
 * address. Capped, because a From line is not the place for a paragraph.
 */
const cleanName = (name) =>
  String(name || '')
    .replace(/[\r\n"<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/**
 * The From header: the deployment's own name and mailbox, and nothing else.
 *
 * It used to read "Lan Nguyen via Synapse" <mailbox@gmail.com>. A display name
 * that names a person the address does not belong to is the pattern spam
 * filters are built to catch — it is what impersonation looks like — and it
 * sent real messages to the spam folder. Who the message is for now lives
 * where filters expect it: Reply-To, and a line at the foot of the message.
 */
function fromHeader() {
  const { name, address } = senderMailbox();
  const shown = cleanName(name);
  return shown ? `"${shown}" <${address}>` : address;
}

/** The deployment's display name, for the footer of a message. */
export function senderName() {
  return cleanName(senderMailbox().name) || 'Synapse';
}

const escapeHtml = (text) =>
  String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A plain message as a simple HTML page.
 *
 * A text-only message from a new sender scores worse with filters than one with
 * a well-formed HTML part beside the text. This is deliberately plain — escaped
 * text, paragraphs, line breaks and bare links — because heavy markup, images
 * and colours are the other thing filters score against.
 */
export function htmlFromText(text, footer = '') {
  const paragraphs = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const withLinks = escapeHtml(block).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
      return `<p style="margin:0 0 14px">${withLinks.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
  const foot = footer
    ? `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #ddd;color:#666;font-size:12px">${escapeHtml(footer)}</p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:640px">${paragraphs}${foot}</body></html>`;
}

let transport = null;
let transportKey = '';
function smtpTransport() {
  const settings = smtpSettings();
  const key = JSON.stringify(settings);
  // Rebuilt if the settings change, which in practice means between tests.
  if (!transport || key !== transportKey) {
    transportKey = key;
    transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: settings.port === 465,
      auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    });
  }
  return transport;
}

/** Test seam: replace the SMTP transport. */
export const __testing = {
  useTransport(fake) {
    transport = fake;
    transportKey = JSON.stringify(smtpSettings());
  },
  fromHeader,
  smtpSettings,
};

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

async function sendViaResend({ to, subject, html, text, replyTo, from }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: asList(to),
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: asList(replyTo) } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = await res.json().catch(() => ({}));
  return { messageId: body?.id || null, accepted: asList(to), rejected: [], response: `Resend accepted (id ${body?.id || 'unknown'})` };
}

/**
 * Send one message.
 *
 * @param {object} mail
 * @param {string|string[]} mail.to       one address or several
 * @param {string} mail.subject
 * @param {string} [mail.text]
 * @param {string} [mail.html]
 * @param {string} [mail.replyTo]         where a reply should go — the person the
 *                                        mail was sent for, not the shared mailbox
 */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const backend = emailBackend();
  const from = fromHeader();
  try {
    /*
     * What the provider actually said, kept and returned.
     *
     * An SMTP server can accept the connection and still refuse some of the
     * recipients — nodemailer resolves anyway and lists them in `rejected`. And
     * "accepted" only means the provider took the message: where it lands
     * (inbox, spam, a bounce minutes later) is decided after. The Message-ID and
     * the server's own reply line are what let somebody find the message in the
     * sending mailbox's Sent folder, or match it to a bounce.
     */
    let receipt = null;
    if (backend === 'resend') receipt = await sendViaResend({ to, subject, html, text, replyTo, from });
    else if (backend === 'smtp') {
      const info = await smtpTransport().sendMail({ from, to: asList(to), subject, html, text, ...(replyTo ? { replyTo } : {}) });
      receipt = {
        messageId: info?.messageId || null,
        accepted: (info?.accepted || []).map(String),
        rejected: (info?.rejected || []).map(String),
        response: info?.response || '',
      };
    } else {
      console.log(`\n──────── email (no provider configured) ────────`);
      console.log(`  to:      ${asList(to).join(', ')}`);
      console.log(`  subject: ${subject}\n`);
      console.log(text);
      console.log(`───────────────────────────────────────────────\n`);
    }
    if (receipt && receipt.rejected.length && !receipt.accepted.length) {
      throw new Error(`every recipient was refused (${receipt.rejected.join(', ')}): ${receipt.response}`);
    }
    // The id and the counts, not the addresses: a log is not the place for them.
    if (receipt) {
      log.info(`email via ${backend} accepted`, {
        backend,
        messageId: receipt.messageId,
        accepted: receipt.accepted.length,
        rejected: receipt.rejected.length,
      });
    }
    return { ok: true, backend, ...(receipt || {}) };
  } catch (err) {
    // Never let a mail failure break the request that triggered it — the user
    // can always ask for another link.
    //
    // Through the trace logger so the failure joins the request that caused it.
    // A password reset that silently did not arrive is diagnosed by finding the
    // one request it belonged to, and a bare console line has nothing to join on.
    log.error(`email via ${backend} failed`, err, { backend });
    return { ok: false, backend, error: err.message };
  }
}

/** Absolute base URL for links in emails. */
export function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req?.headers?.['x-forwarded-proto'] || (req?.secure ? 'https' : 'http');
  const host = req?.headers?.host || 'localhost:5173';
  return `${proto}://${host}`;
}

// ── templates ─────────────────────────────────────────────────────────

/**
 * The code comes first and the link second, deliberately: on a phone, typing
 * six digits back into the tab you already have open beats bouncing out to the
 * mail app and back.
 */
const shell = (heading, body, code, button) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0e11;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#11161b;border:1px solid #232d36;border-radius:16px;padding:32px;color:#e8eef4">
    <div style="color:#5ee6a8;font-weight:700;font-size:18px;margin-bottom:20px">Synapse</div>
    <h1 style="font-size:20px;margin:0 0 12px">${heading}</h1>
    <p style="color:#9aa8b5;line-height:1.6;margin:0 0 20px">${body}</p>
    <div style="background:#0d1216;border:1px solid #2f7f5f;border-radius:12px;padding:18px;text-align:center;margin:0 0 22px">
      <div style="color:#64727f;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px">Your code</div>
      <div style="color:#5ee6a8;font-size:32px;font-weight:700;letter-spacing:.28em;font-family:ui-monospace,Consolas,monospace">${code}</div>
    </div>
    <p style="color:#64727f;font-size:13px;line-height:1.6;margin:0 0 14px">Or click here instead:</p>
    <a href="${button.href}" style="display:inline-block;background:#5ee6a8;color:#06231a;font-weight:600;padding:12px 22px;border-radius:9px;text-decoration:none">${button.label}</a>
    <p style="color:#64727f;font-size:12px;line-height:1.6;margin:24px 0 0">
      If the button does not work, paste this into your browser:<br />
      <span style="color:#9aa8b5;word-break:break-all">${button.href}</span>
    </p>
  </div>
</div>`;


export function resetEmail(link, code) {
  return {
    subject: `${code} is your Synapse password reset code`,
    html: shell(
      'Reset your password',
      'Type this code into the app to choose a new password. It is good for one hour and works once.',
      code,
      { href: link, label: 'Choose a new password' },
    ),
    text:
      `Your Synapse password reset code is ${code}\n\n` +
      `It expires in one hour and can only be used once. You can also open this link:\n${link}\n\n` +
      'If you did not ask for this, ignore this message — your password has not changed.',
  };
}
