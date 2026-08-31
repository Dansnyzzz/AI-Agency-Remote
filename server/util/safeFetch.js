import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Fetching a URL the model chose, without handing it the inside of the network.
 *
 * `web_fetch` looks like the most harmless tool in the list and is the most
 * dangerous one to leave open, because the model does not have to be malicious
 * to misuse it — a page it reads can tell it what to fetch next. On a hosted
 * deployment that reaches the cloud metadata service, which hands out
 * credentials to anyone who asks from inside. On somebody's laptop it reaches
 * their router, their NAS, and every admin panel on their Wi-Fi.
 *
 * So: resolve the name first, refuse anything that lands on a private address,
 * and re-check on every redirect — because a public hostname that 302s to
 * 169.254.169.254 defeats a check done only on the URL you were given.
 */

const MAX_REDIRECTS = 5;

/** Address ranges that are not the public internet. */
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::' || lower === '::1') return true; // unspecified, loopback
    if (lower.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(lower)) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 coat.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  // Not an address we can reason about; refuse rather than guess.
  return true;
}

/**
 * Check one hop. Throws with a message the model can act on rather than retry.
 *
 * Set `ALLOW_PRIVATE_FETCH=true` when the whole point is to reach something on
 * the local network — an internal wiki, a service on the same host. It is off by
 * default because the safe case has to be the one you get without deciding.
 */
export async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Only http and https URLs can be fetched — "${url.protocol}" is not one.`);
  }
  if (/^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_FETCH || '')) return;

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup, and must not get one.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`${host} is a private address. This tool only reaches the public internet.`);
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve "${host}".`);
  }
  if (!records.length) throw new Error(`Could not resolve "${host}".`);

  // Every record, not just the first: a name that resolves to one public and one
  // private address is the textbook way round a check that stops at [0].
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `"${host}" resolves to the private address ${address}. This tool only reaches the public internet.`,
      );
    }
  }
}

/**
 * `fetch`, with every hop checked.
 *
 * Redirects are followed by hand rather than by the runtime, which is the only
 * way to inspect each destination before connecting to it.
 */
export async function safeFetch(input, init = {}) {
  let url = input instanceof URL ? input : new URL(String(input));

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublic(url);

    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, url);

    // Credentials must not survive a cross-origin hop, and a body must not be
    // replayed to somewhere the caller never named.
    if (next.origin !== url.origin && init.headers) {
      init = { ...init, headers: stripAuth(init.headers) };
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method === 'POST')) {
      init = { ...init, method: 'GET', body: undefined };
    }
    url = next;
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

function stripAuth(headers) {
  const out = { ...(headers instanceof Headers ? Object.fromEntries(headers) : headers) };
  for (const key of Object.keys(out)) {
    if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) delete out[key];
  }
  return out;
}

export const __testing = { isPrivateAddress, assertPublic };
