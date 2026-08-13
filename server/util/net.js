import os from 'node:os';

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
