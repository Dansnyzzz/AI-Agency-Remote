import os from 'node:os';

/**
 * The address this server is reachable at, from outside.
 *
 * Needed for one sentence in the interface, and that sentence is the whole
 * reason a deployment could not be connected to a computer: the Computers tab
 * has to print the exact command to run on that machine, and the command
 * contains this deployment's own URL. A person cannot be expected to know it
 * reliably — plenty of people never see the Vercel-assigned domain — and the
 * browser cannot be trusted to derive it either, since it may be looking at a
 * preview alias or a custom domain in front of a proxy.
 *
 * `PUBLIC_URL` wins when set, because that is somebody stating the answer.
 * Otherwise it is reconstructed from the request, honouring the proxy headers
 * Vercel sets — without them the scheme reads as `http` behind their TLS
 * terminator, and the printed command would point at a URL that redirects.
 */
export function publicUrlFor(req) {
  const stated = String(process.env.PUBLIC_URL || '').trim();
  if (stated) return stated.replace(/\/+$/, '');

  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req?.headers?.host || '';
  if (!host) return null;

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http');

  return `${proto}://${host}`.replace(/\/+$/, '');
}

/** Every IPv4 address a phone on the same Wi-Fi could reach this server on. */
export function lanAddresses(port) {
  const urls = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      urls.push(`http://${i.address}:${port}`);
    }
  }
  return urls;
}
