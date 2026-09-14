/**
 * Is it safe to talk to this server over the network in between?
 *
 * Everything the worker does goes through SERVER_URL: the bearer token that
 * proves this machine is paired, and every job it runs — `run_command`,
 * `write_file`, `delete_file`. Over plain `http` to a host on the internet, anyone
 * on the path (a café's Wi-Fi, a compromised router, the ISP) can read the token
 * and, worse, answer the job poll themselves: that is running commands on this
 * computer with nobody's approval. Nothing checked (SEC-032).
 *
 * - `https` is fine anywhere.
 * - `http` to this machine (localhost, 127.x, ::1) never leaves it.
 * - `http` to a private network address is the self-hosted-on-the-LAN case. It
 *   is allowed, with a warning, because refusing it would break a setup people
 *   really use; the exposure is the local network, not the internet.
 * - `http` to anything else is refused unless ALLOW_INSECURE_SERVER=1 says the
 *   owner has decided otherwise.
 *
 * Kept out of `index.js` so it can be tested without starting a worker.
 */
import net from 'node:net';
import { isPrivateAddress } from '../server/util/safeFetch.js';

const LOCAL_NAMES = ['localhost'];
const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal'];

/**
 * @param {string} url
 * @param {{ allowInsecure?: boolean }} [options]
 * @returns {{ level: 'ok' | 'warn' | 'refuse', message?: string }}
 */
export function serverTransport(url, { allowInsecure = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { level: 'refuse', message: `SERVER_URL is not a valid address: ${url}` };
  }
  if (parsed.protocol === 'https:') return { level: 'ok' };
  if (parsed.protocol !== 'http:') {
    return { level: 'refuse', message: `SERVER_URL must start with https:// (or http:// for this machine): ${url}` };
  }

  // URL keeps the brackets on an IPv6 hostname: `[::1]`.
  const named = parsed.hostname.toLowerCase();
  const host = named.startsWith('[') && named.endsWith(']') ? named.slice(1, -1) : named;
  const isLoopback =
    LOCAL_NAMES.includes(host) || host.endsWith('.localhost') || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
  if (isLoopback) return { level: 'ok' };

  const isLan = net.isIP(host) ? isPrivateAddress(host) : LAN_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (isLan) {
    return {
      level: 'warn',
      message:
        `SERVER_URL is plain http on the local network (${parsed.host}). Anyone on that network can read this computer's ` +
        'token and send it jobs. Use https if the network is not yours alone.',
    };
  }

  if (allowInsecure) {
    return {
      level: 'warn',
      message: `SERVER_URL is plain http to ${parsed.host}, allowed by ALLOW_INSECURE_SERVER. The token and every job travel unencrypted.`,
    };
  }
  return {
    level: 'refuse',
    message:
      `SERVER_URL is plain http to ${parsed.host}. Over the internet that lets anyone on the path read this computer's token ` +
      'and send it commands to run. Use the https:// address of the app, or set ALLOW_INSECURE_SERVER=1 if you have decided to accept that.',
  };
}
