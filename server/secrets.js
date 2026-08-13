import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * The two secrets a local run cannot work without.
 *
 * They are deliberately separate: SESSION_SECRET is meant to be rotated to sign
 * everyone out, and if provider keys were encrypted with it, doing that would
 * also destroy every stored API key.
 */
const REQUIRED = {
  SESSION_SECRET: 'signs session cookies',
  ENCRYPTION_KEY: 'encrypts stored provider API keys',
};

/**
 * How much of the machine the assistant may touch, on a *local* run.
 *
 * Both default to on, and that is a deliberate choice rather than an oversight.
 * A local run means you started the server on your own computer, and only the
 * administrator account — yours — reaches it at all; the point of the app is to
 * drive that machine. Shipping it half-crippled taught people to fight the
 * error messages instead of the setting.
 *
 * What keeps this safe is the approval policy, not the reach: everything
 * destructive still stops and asks. Set either to `false` in .env to narrow it.
 */
const LOCAL_DEFAULTS = {
  FILE_ACCESS: {
    value: 'full',
    why: 'lets the file tools read and write anywhere, not only inside the workspace',
  },
  DESKTOP_ACCESS: {
    value: 'true',
    why: 'lets the assistant drive real applications on this machine',
  },
  BROWSER_HEADLESS: {
    value: 'false',
    why: 'shows the sandbox window, which is what gives a video sound - headless Chrome has no audio device at all',
  },
};

/**
 * Generate anything missing and persist it to .env, so a fresh clone works on
 * the first `npm start` and keeps working across restarts.
 *
 * @returns {{ secrets: string[], access: string[] }} what was written
 */
export function ensureLocalSecrets(root) {
  const envFile = path.join(root, '.env');
  const append = (line) => fs.appendFileSync(envFile, `${line}\n`);
  const secrets = [];
  const access = [];

  for (const name of Object.keys(REQUIRED)) {
    // ACCESS_TOKEN is honoured as a legacy fallback for both.
    if (process.env[name] || process.env.ACCESS_TOKEN) continue;

    const value = crypto.randomBytes(32).toString('base64url');
    append(`${name}=${value}`);
    process.env[name] = value;
    secrets.push(name);
  }

  // Written out rather than merely defaulted in code, so the setting is visible
  // and editable in the file people already look at.
  for (const [name, { value, why }] of Object.entries(LOCAL_DEFAULTS)) {
    if (process.env[name] !== undefined) continue;
    append(`\n# ${why}`);
    append(`${name}=${value}`);
    process.env[name] = value;
    access.push(name);
  }

  return { secrets, access };
}

/**
 * Hosted deployments have a read-only filesystem, so nothing can be generated
 * there — fail loudly at boot rather than halfway through someone saving a key.
 */
export function assertSecrets() {
  const missing = Object.entries(REQUIRED)
    .filter(([name]) => !process.env[name] && !process.env.ACCESS_TOKEN)
    .map(([name, why]) => `    ${name} — ${why}`);

  if (missing.length) {
    throw new Error(
      `Missing required environment variables:\n${missing.join('\n')}\n\n` +
        '  Add them in your hosting dashboard and redeploy.',
    );
  }
}
