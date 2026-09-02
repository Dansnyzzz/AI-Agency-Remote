import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

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
  if (/^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_FETCH || '')) return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup, and must not get one.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`${host} is a private address. This tool only reaches the public internet.`);
    }
    return null;
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

  /**
   * The verified answer goes back to the caller, and that is the point.
   *
   * Checking a name and then handing the *name* to something that resolves it
   * again is a time-of-check/time-of-use gap, and it is the standard way past a
   * guard like this one: a record with a one-second TTL answers with a public
   * address for the check and `169.254.169.254` for the connection a moment
   * later. Every careful thing above — reading all the records, re-checking each
   * redirect — rested on a second lookup nobody controlled.
   *
   * So the connection is pinned to what was actually verified. See `safeFetch`.
   */
  return records;
}

/**
 * One request, to an address that has already been checked.
 *
 * `node:https` rather than `fetch`, and the reason is the `lookup` option. Node's
 * `fetch` gives no way to say which address to connect to, so a verified name is
 * handed back to a resolver that answers again, independently — which is the
 * gap this whole module exists to close. `http.request` passes `lookup` down to
 * the socket, so the connection goes to the address that was actually checked.
 *
 * The URL is still what is passed in, so TLS SNI and the `Host` header are the
 * hostname rather than the IP: connecting by address alone would break every
 * virtual-hosted site and every certificate.
 *
 * The response is shaped like a `fetch` response in the four ways this codebase
 * uses one — `ok`, `status`, `statusText`, `headers.get()` — plus `text()` and a
 * `body` that is the Node stream, which both callers already iterate.
 */
function request(url, init, records) {
  const client = url.protocol === 'https:' ? https : http;

  const options = {
    method: init.method || 'GET',
    headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers,
    signal: init.signal,
    /**
     * No connection pooling.
     *
     * Node's global agent keeps sockets alive, and a caller that gives up on a
     * response without draining it — `if (!res.ok) throw`, which both callers do
     * — leaves one held open with the event loop still awake. A short script
     * simply never exits; a long-lived server accumulates them.
     *
     * There is a second reason, and it is the one that matters here: a pooled
     * socket outlives the check that approved it. This module's whole promise is
     * that a connection goes to an address that was verified for *this* request,
     * and reusing a socket from an earlier one quietly reintroduces exactly the
     * gap the pinning above closes.
     */
    agent: false,
  };

  /**
   * Pin the socket to a verified address.
   *
   * `records` is null when there was nothing to resolve — a literal IP, already
   * checked — or when ALLOW_PRIVATE_FETCH is on, in which case pinning would be
   * fighting the setting.
   */
  if (records?.length) {
    const [{ address, family }] = records;
    options.lookup = (hostname, opts, cb) => {
      if (opts?.all) return cb(null, [{ address, family }]);
      return cb(null, address, family);
    };
  }

  return new Promise((resolve, reject) => {
    const req = client.request(url, options, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: {
          get: (name) => {
            const value = res.headers[String(name).toLowerCase()];
            return value == null ? null : String(Array.isArray(value) ? value.join(', ') : value);
          },
        },
        body: res,
        async text() {
          let out = '';
          res.setEncoding('utf8');
          for await (const chunk of res) out += chunk;
          return out;
        },
      });
    });
    req.on('error', reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

/**
 * `fetch`, with every hop checked — and connected to the address that was
 * checked, rather than to whatever a second lookup says a moment later.
 *
 * Redirects are followed by hand rather than by the runtime, which is the only
 * way to inspect each destination before connecting to it.
 */
export async function safeFetch(input, init = {}) {
  let url = input instanceof URL ? input : new URL(String(input));

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const records = await assertPublic(url);

    const res = await request(url, init, records);
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    // Nothing reads a redirect's body, and leaving it unread holds the socket.
    res.body.resume();
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
