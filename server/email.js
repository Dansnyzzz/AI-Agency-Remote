import nodemailer from 'nodemailer';
import { log } from './util/trace.js';

/**
 * Email delivery with three backends, chosen by whichever is configured:
 *
 *   1. Resend  — RESEND_API_KEY. Plain HTTPS, works on Vercel with no SMTP port.
 *   2. SMTP    — SMTP_HOST/PORT/USER/PASS. Any provider, including Gmail.
 *   3. Console — neither configured: the link is printed to the server log.
 *
 * The console fallback exists so local development and first-run setup are not
 * blocked on picking a mail provider. It is obviously not for production, and
 * `emailBackend()` reports which one is live so the UI can say so.
 */
export function emailBackend() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'console';
}

function fromAddress() {
  return process.env.EMAIL_FROM || 'AI Remote <onboarding@resend.dev>';
}

let transport = null;
function smtpTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transport;
}

async function sendViaResend({ to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
}

export async function sendEmail({ to, subject, html, text }) {
  const backend = emailBackend();
  try {
    if (backend === 'resend') await sendViaResend({ to, subject, html, text });
    else if (backend === 'smtp') await smtpTransport().sendMail({ from: fromAddress(), to, subject, html, text });
    else {
      console.log(`\n──────── email (no provider configured) ────────`);
      console.log(`  to:      ${to}`);
      console.log(`  subject: ${subject}\n`);
      console.log(text);
      console.log(`───────────────────────────────────────────────\n`);
    }
    return { ok: true, backend };
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
    <div style="color:#5ee6a8;font-weight:700;font-size:18px;margin-bottom:20px">AI Remote</div>
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
    subject: `${code} is your AI Remote password reset code`,
    html: shell(
      'Reset your password',
      'Type this code into the app to choose a new password. It is good for one hour and works once.',
      code,
      { href: link, label: 'Choose a new password' },
    ),
    text:
      `Your AI Remote password reset code is ${code}\n\n` +
      `It expires in one hour and can only be used once. You can also open this link:\n${link}\n\n` +
      'If you did not ask for this, ignore this message — your password has not changed.',
  };
}
