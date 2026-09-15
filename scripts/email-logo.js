#!/usr/bin/env node
/**
 * Make the logo that goes inside emails, from the web app's own logo.
 *
 * The web logo is 256px; an email shows it at 48px at most, so it is scaled to
 * 96px (sharp on a 2x screen) with the browser's high-quality resampling — the
 * one image scaler already on hand, through the Playwright that runs the UI
 * suite — and written to server/assets, the folder a Vercel function bundles.
 * The result is committed; run this again only when public/logo.png changes.
 *
 *   node scripts/email-logo.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

/* global document */ // the page.evaluate callback below runs in the browser

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'public', 'logo.png');
const TARGET = path.join(ROOT, 'server', 'assets', 'email-logo.png');
const SIZE = 96;

let browser;
for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
  try {
    browser = await chromium.launch({ ...options, headless: true });
    break;
  } catch {
    /* try the next one */
  }
}
if (!browser) {
  console.error('No Chrome, Edge or bundled Chromium to scale the logo with.');
  process.exit(1);
}

const page = await browser.newPage();
await page.goto(pathToFileURL(SOURCE).href);
const dataUrl = await page.evaluate(async (size) => {
  const img = document.querySelector('img');
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}, SIZE);
await browser.close();

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(TARGET, bytes);
console.log(`Wrote ${path.relative(ROOT, TARGET)}: ${SIZE}x${SIZE}, ${bytes.length} bytes`);
