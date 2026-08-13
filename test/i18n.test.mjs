/**
 * Translation coverage, and the two ways it rots silently.
 *
 * **A key on one side and not the other.** The failure mode is not a crash — it
 * is a screen that is 90% Vietnamese with three English labels in it, shipped for
 * a year because nobody with Vietnamese as their language was the one reading the
 * diff. So the two dictionaries have to hold exactly the same key set, and this
 * fails the build when they do not.
 *
 * **A `data-i18n` attribute pointing at nothing.** The markup asks for a string
 * that was never written, `t()` returns the key, and the interface shows
 * `nav.projects` to a customer. Every attribute in the page is checked against
 * both dictionaries here.
 *
 *   node test/i18n.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { vi } = await import('../public/js/locales/vi.js');
const { en } = await import('../public/js/locales/en.js');

section('the two dictionaries describe the same interface');
{
  const viKeys = Object.keys(vi).sort();
  const enKeys = Object.keys(en).sort();

  const missingInVi = enKeys.filter((k) => !(k in vi));
  const missingInEn = viKeys.filter((k) => !(k in en));

  check('every English key has a Vietnamese string', missingInVi.length === 0, missingInVi.join(', '));
  check('and every Vietnamese key has an English one', missingInEn.length === 0, missingInEn.join(', '));
  check('both hold the same number of strings', viKeys.length === enKeys.length, `${viKeys.length} vs ${enKeys.length}`);

  // An empty string is worse than a missing one: it renders as nothing at all,
  // so a button loses its label rather than showing an obviously wrong one.
  const blank = [...viKeys, ...enKeys].filter((k) => !String(vi[k] ?? '').trim() || !String(en[k] ?? '').trim());
  check('no string is empty', blank.length === 0, [...new Set(blank)].join(', '));

  // `{name}` placeholders have to match, or one language silently drops the value.
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const mismatched = viKeys.filter((k) => k in en && holes(vi[k]) !== holes(en[k]));
  check(
    'placeholders match on both sides',
    mismatched.length === 0,
    mismatched.map((k) => `${k}: "${holes(vi[k])}" vs "${holes(en[k])}"`).join(' | '),
  );
}

section('every string the markup asks for exists');
{
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  const asked = [
    ...html.matchAll(/data-i18n(?:-html|-placeholder|-title)?="([^"]+)"/g),
  ].map((m) => m[1]);

  check('the page asks for some strings at all', asked.length > 0, `${asked.length} attributes`);

  const unknown = [...new Set(asked)].filter((key) => !(key in vi) || !(key in en));
  check('and every one of them is defined', unknown.length === 0, unknown.join(', '));
}

section('the strings the script builds are defined too');
{
  // `t('key')` calls in the modules. A literal argument can be checked; anything
  // computed cannot, and is skipped rather than guessed at.
  // Every module that imports `t`, not just the two big ones. `render.js` was
  // missing here, so a key used only by the transcript renderer could go
  // undefined and this suite would still pass.
  const roots = ['app.js', 'onboarding.js', 'render.js'];
  const asked = new Set();
  for (const name of roots) {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', name), 'utf8');
    for (const m of source.matchAll(/\bt\(\s*'([^']+)'/g)) asked.add(m[1]);
  }

  check('the script asks for strings', asked.size > 0, `${asked.size} keys`);
  const unknown = [...asked].filter((key) => !(key in vi) || !(key in en));
  check('and every one of them is defined', unknown.length === 0, unknown.join(', '));
}

section('the onboarding steps are all present');
{
  // Five steps, and each one has a title. A step that renders an empty panel is
  // the kind of thing only a real reader notices.
  for (let step = 1; step <= 5; step += 1) {
    check(`step ${step} has a title in both languages`, !!vi[`onb.${step}.title`] && !!en[`onb.${step}.title`]);
  }
  check('the step counter names both numbers', /\{n\}/.test(vi['onb.step']) && /\{total\}/.test(vi['onb.step']), vi['onb.step']);
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll i18n checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
