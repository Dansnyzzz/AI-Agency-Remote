import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { initStore } from './store/index.js';
import { ensureLocalSecrets, assertSecrets } from './secrets.js';
import { startScheduler } from './scheduler.js';
import { lanAddresses } from './util/net.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader so local runs need no extra dependency. */
function loadEnvFile() {
  const file = path.resolve(here, '../.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

// Generating these per run would sign everyone out and orphan every stored API
// key on each restart, so they are written to .env the first time.
const { secrets, access } = ensureLocalSecrets(path.resolve(here, '..'));
if (secrets.length) {
  console.log(`\n  Generated ${secrets.join(' and ')} and saved them to .env.`);
}
if (access.length) {
  // This grants the assistant the run of the machine, so say so out loud the
  // one time it is switched on rather than letting it be a silent default.
  console.log(
    `\n  Set ${access.join(' and ')} in .env — the assistant can now reach the whole machine.` +
      '\n  Destructive actions still stop and ask; change the policy in Settings → Behaviour.',
  );
}
assertSecrets();

const port = Number(process.env.PORT) || 5173;

const store = await initStore();

// Scheduled work needs something ticking. A local run has a process that stays
// up, so it polls for itself; a deployment has none, and uses the cron endpoint.
startScheduler();

createApp().listen(port, '0.0.0.0', () => {
  console.log('\n  AI Remote is running.\n');
  for (const url of [`http://localhost:${port}`, ...lanAddresses(port)]) console.log(`    ${url}`);

  console.log(`\n  Storage: ${store.kind}`);
  console.log('\n  Open the app and create an account — the first one becomes the administrator.');
  console.log('  Everyone signs in with their own email and password.');
  console.log('\n  Open a LAN address on your phone (same Wi-Fi), or run `npm run share`');
  console.log('  for a public HTTPS URL you can reach from anywhere.\n');
});
