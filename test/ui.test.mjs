/**
 * Interface regression suite — the real app, in a real browser.
 *
 * Separate from `npm test` because it needs Chrome and a listening server, and
 * the tenancy suite must stay fast enough to run constantly. It earns its keep:
 * every check below was written against a bug that shipped.
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'ui-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-test');
// A folder for the workspace browser to actually browse.
process.env.WORKSPACE = path.join(os.tmpdir(), 'ai-remote-ui-workspace');
fs.rmSync(process.env.WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(path.join(process.env.WORKSPACE, 'src'), { recursive: true });
fs.writeFileSync(path.join(process.env.WORKSPACE, 'readme.md'), '# Ghi ch\u00fa\n\nM\u1ed9t d\u00f2ng.\n');
removeTemp(process.env.DATA_DIR);

// Quiet the console-email fallback; a confirmation code per signup is noise here.
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const PORT = 5194;
/**
 * Build the schema before serving, the way `server/index.js` does.
 *
 * `createApp()` deliberately does not: on a serverless deployment every
 * invocation may be cold, so the wait belongs in a per-request guard rather than
 * at startup. Locally, `server/index.js` awaits `initStore()` before it listens —
 * and this suite was not, so the very first request paid for the entire PGlite
 * DDL run. That is **21 seconds** on a fresh data directory, inside a 30-second
 * navigation timeout, which made the suite fail on how many modules the page
 * happens to import rather than on anything it is testing.
 */
const { initStore } = await import('../server/store/index.js');
await initStore();

const { createApp } = await import('../server/app.js');
const server = (await createApp()).listen(PORT);
await new Promise((r) => server.once('listening', r));

const { chromium } = await import('playwright-core');

/**
 * Whatever browser this machine has.
 *
 * Chrome and Edge first, because on a developer's machine one of them is
 * already there and needs no download. The bundled build last — it only exists
 * if somebody ran `playwright install`, which is exactly what CI does, so
 * without this fallback the whole suite skipped itself on every CI run and
 * reported success for having tested nothing.
 */
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
  realLog('\n  Skipped: no Chrome, Edge or bundled Chromium to drive.');
  realLog('  Run `npx playwright install chromium` to enable this suite.\n');
  server.close();
  process.exit(0);
}

const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Every element that can actually scroll, and in which direction.
 *
 * Containers that hide their scrollbar (the chip rows) scroll sideways by
 * design and are not counted; a *visible* bar is what this is looking for.
 */
const SCROLLERS = (selector = 'body') => {
  const out = [];
  for (const el of document.querySelectorAll(`${selector} *`)) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const style = getComputedStyle(el);
    const barHidden = style.scrollbarWidth === 'none';
    const canY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
    const canX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2;
    if (canY || (canX && !barHidden)) {
      out.push({ id: el.id || '', cls: `${el.className}`.slice(0, 40), y: canY, x: canX && !barHidden });
    }
  }
  return out;
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

section('signing in');
await page.fill('#gate-email', 'ui@test.local');
await page.fill('#gate-password', 'a-long-enough-password');
check('the gate asks for no invite code', !(await page.$('#gate-invite')));

// A password you cannot read is how people lock themselves out of a new
// account on the first try, so the eye has to be there and has to work.
await page.click('[data-reveal="gate-password"]');
check('the eye reveals the password', (await page.getAttribute('#gate-password', 'type')) === 'text');
await page.click('[data-reveal="gate-password"]');
check('and hides it again', (await page.getAttribute('#gate-password', 'type')) === 'password');
check(
  'signing up is not offered "remember me" — it already signs you in',
  await page.isHidden('#gate-remember-row'),
);

await page.click('#gate-submit');
await page.waitForTimeout(1600);
check('the app opened', await page.isVisible('#model-chip'));

/**
 * The guide is the first thing a new account meets, and then it is gone.
 *
 * Asserted here rather than later because "on the very first sign-in" is the
 * whole claim, and it cannot be re-tested once the account has answered. It is a
 * modal, so everything behind it is inert — which is why the rest of this suite
 * dismisses it first, exactly as a person would.
 */
section('a new account is shown the guide, once');
{
  await page.waitForTimeout(1200);
  const first = await page.evaluate(() => ({
    open: !!document.getElementById('onboarding')?.open,
    step: document.getElementById('onb-step')?.textContent.trim() || '',
    // The new-model announcement is also a modal. Two on a first visit is worse
    // than either alone, so the guide wins and the news waits.
    news: !!document.querySelector('#model-news[open]'),
  }));
  check('the guide opens on a first sign-in', first.open === true);
  check('at step 1', /1/.test(first.step), first.step);
  check('and the model announcement does not stack on top of it', first.news === false);

  // Skipping is an answer, and it has to stick.
  await page.click('#onb-skip');
  await page.waitForTimeout(700);
  check('skipping closes it', !(await page.$('#onboarding[open]')));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('and it does not come back after a reload', !(await page.$('#onboarding[open]')));
  check('leaving the app usable', await page.isVisible('#model-chip'));
  /**
   * Pressing a suggestion has to arm the send button.
   *
   * This was broken in two places for the same reason: setting `.value` from script
   * fires no `input` event, so the button stayed grey **and disabled**. Pressing a
   * suggestion looked like nothing happened, and pressing send then also did
   * nothing — which reads as a broken app rather than a missing line.
   */
  const idle = await page.evaluate(() => ({
    ready: document.getElementById('send').classList.contains('is-ready'),
    disabled: document.getElementById('send').disabled,
  }));
  check('the send button starts unlit', !idle.ready && idle.disabled);

  await page.click('#suggestions .suggestion');
  await page.waitForTimeout(400);
  const armed = await page.evaluate(() => ({
    typed: document.getElementById('input').value.trim(),
    ready: document.getElementById('send').classList.contains('is-ready'),
    disabled: document.getElementById('send').disabled,
    caretAtEnd: document.getElementById('input').selectionStart === document.getElementById('input').value.length,
  }));
  check('pressing a suggestion fills the box', armed.typed.length > 0, armed.typed.slice(0, 40));
  check('and lights the send button', armed.ready === true, 'a grey button reads as "this does not work"');
  check('and enables it, so pressing it actually sends', armed.disabled === false);
  check('with the caret after the text', armed.caretAtEnd === true);

  await page.evaluate(() => {
    const box = document.getElementById('input');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

section('a fresh account is not caught up on old news');
{
  // The library populates itself on first load and holds hundreds of models,
  // dozens of them recent. Announcing those would greet a new account with a
  // queue of modals — one per reload — which is precisely how a useful notice
  // becomes the thing people close without reading. The first look draws a line
  // and says nothing; only what arrives afterwards is news.
  await page.waitForTimeout(2500);
  check('no modal on first sign-in', !(await page.$('#model-news[open]')));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('and none on reload either', !(await page.$('#model-news[open]')));
}

section('the chat window is fixed, only the transcript scrolls');
// Enough content to overflow, without needing a model or an API key.
await page.evaluate(() => {
  const thread = document.getElementById('thread');
  for (let i = 0; i < 40; i += 1) {
    const d = document.createElement('div');
    d.style.padding = '18px';
    d.textContent = `message ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}`;
    thread.appendChild(d);
  }
});
await page.waitForTimeout(300);

const shell = await page.evaluate(() => {
  const scrolls = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) {
      scrolls.push(el.id || `${el.tagName.toLowerCase()}.${`${el.className}`.slice(0, 20)}`);
    }
  }
  const root = document.documentElement;
  return {
    pageOverflow: root.scrollHeight - root.clientHeight,
    appHeight: Math.round(document.getElementById('app').getBoundingClientRect().height),
    viewport: window.innerHeight,
    scrolls,
    composerVisible: document.getElementById('composer').getBoundingClientRect().bottom <= window.innerHeight + 1,
    topbarVisible: document.querySelector('.topbar').getBoundingClientRect().top >= -1,
  };
});
check('the page itself does not scroll', shell.pageOverflow <= 1, `${shell.pageOverflow}px`);
check('the shell is exactly one screen tall', Math.abs(shell.appHeight - shell.viewport) <= 1);
check('the transcript is what scrolls', shell.scrolls.join() === 'thread', shell.scrolls.join(' ') || 'nothing');
check('the composer stays on screen', shell.composerVisible);
check('the header stays on screen', shell.topbarVisible);

section('the send button answers "will this do anything"');
{
  const idle = await page.evaluate(() => {
    const btn = document.getElementById('send');
    const box = btn.getBoundingClientRect();
    return {
      ready: btn.classList.contains('is-ready'),
      disabled: btn.disabled,
      // Round, not a rounded rectangle.
      round: Math.abs(box.width - box.height) < 2 && parseFloat(getComputedStyle(btn).borderRadius) >= box.width / 2 - 1,
      background: getComputedStyle(btn).backgroundColor,
    };
  });
  check('it is round', idle.round, `${idle.background}`);
  check('and unlit while the box is empty', !idle.ready, 'a permanently green button stops meaning "ready"');
  check('and does nothing if pressed', idle.disabled);

  await page.fill('#input', 'hello');
  await page.waitForTimeout(200);
  const typed = await page.evaluate(() => {
    const btn = document.getElementById('send');
    return {
      ready: btn.classList.contains('is-ready'),
      disabled: btn.disabled,
      background: getComputedStyle(btn).backgroundColor,
    };
  });
  check('typing lights it', typed.ready, typed.background);
  check('and enables it', !typed.disabled);
  check('and the colour really changed', typed.background !== idle.background, `${idle.background} → ${typed.background}`);

  await page.fill('#input', '   ');
  await page.waitForTimeout(200);
  check(
    'whitespace alone does not count',
    await page.evaluate(() => !document.getElementById('send').classList.contains('is-ready')),
  );
  await page.fill('#input', '');
}

section('no ASSISTANT label');
{
  // In a two-party conversation where one side is in a bubble on the right and
  // the other is not, captioning every reply says nothing anyone did not know.
  const labelled = await page.evaluate(() => {
    const wrap = document.createElement('div');
    document.body.append(wrap);
    return document.querySelectorAll('.msg__role').length;
  });
  check('no role captions in the transcript', labelled === 0, `${labelled} found`);
  check('and none in the renderer', !(await page.$('.msg--assistant .msg__role')));
}

section('attaching photos and files');
{
  const composer = await page.evaluate(() => {
    const attach = document.getElementById('attach');
    const input = document.getElementById('file-input');
    const strip = document.getElementById('attachments');
    const box = document.querySelector('.composer__box');
    const kids = [...box.children].map((c) => c.id || c.className);
    return {
      hasButton: !!attach,
      hasInput: !!input,
      multiple: input?.multiple,
      accept: input?.accept || '',
      stripHidden: strip?.hidden,
      // The + belongs on the left of the text, the way every chat box does it.
      buttonFirst: kids.indexOf('attach') < kids.indexOf('input'),
      stripAboveBox: !!document.querySelector('.composer > #attachments'),
    };
  });
  check('there is a + button', composer.hasButton);
  check('on the left of the text box', composer.buttonFirst);
  check('it takes several files', composer.multiple === true);
  check('images among them', /image\//.test(composer.accept), composer.accept.slice(0, 40));
  check('and PDFs', /application\/pdf/.test(composer.accept));
  check('the preview strip is above the box, not inside it', composer.stripAboveBox);
  check('and hidden until something is attached', composer.stripHidden === true);

  // Drive a real file through the real picker.
  await page.setInputFiles('#file-input', {
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('container GCXU6471654'),
  });
  await page.waitForTimeout(1200);

  const staged = await page.evaluate(() => {
    const strip = document.getElementById('attachments');
    return {
      shown: !strip.hidden,
      count: strip.querySelectorAll('.attachment').length,
      name: strip.querySelector('.attachment__name')?.textContent,
      meta: strip.querySelector('.attachment__meta')?.textContent,
      removable: !!strip.querySelector('.attachment__remove'),
      sendReady: document.getElementById('send').classList.contains('is-ready'),
    };
  });
  check('the preview appears', staged.shown && staged.count === 1, `${staged.count} shown`);
  check('naming the file', staged.name === 'note.txt', staged.name);
  // `B` as well as KB and MB. This asserted /KB|MB/ against a 21-byte file, which
  // only passed because humanSize rounded everything under a megabyte up to at
  // least "1 KB" — so the check was pinning the rounding bug rather than the
  // behaviour. The unified formatter says "21 B", which is what the file is.
  check('and its size once uploaded', /\d+\s?(B|KB|MB)\b/.test(staged.meta || ''), staged.meta);
  check('a file alone lights the send button', staged.sendReady, 'a photo with no caption is a complete message');
  check('and it can be removed', staged.removable);

  await page.click('.attachment__remove');
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({
    hidden: document.getElementById('attachments').hidden,
    sendReady: document.getElementById('send').classList.contains('is-ready'),
  }));
  check('removing it hides the strip', cleared.hidden);
  check('and unlights send again', !cleared.sendReady);

  // An image gets a thumbnail rather than an extension badge.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.setInputFiles('#file-input', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForTimeout(1200);
  check(
    'an image previews as a thumbnail',
    !!(await page.$('.attachment__thumb')),
    'not an extension badge',
  );
  await page.click('.attachment__remove');
  await page.waitForTimeout(300);
}

section('the approval policy sits beside send');
{
  const placed = await page.evaluate(() => {
    const actions = document.querySelector('.composer__actions');
    const order = [...actions.children].map((c) => c.id);
    const policy = document.getElementById('policy-chip');
    const send = document.getElementById('send');
    return {
      insideComposer: !!actions.querySelector('#policy-chip'),
      order,
      // Immediately to the left of the send button, not floating elsewhere.
      leftOfSend: policy.getBoundingClientRect().right <= send.getBoundingClientRect().left + 1,
      sameRow: Math.abs(
        policy.getBoundingClientRect().top - send.getBoundingClientRect().top,
      ) < 6,
      label: policy.textContent.trim(),
      notInTopbar: !document.querySelector('.topbar #policy-chip'),
    };
  });
  check('it is in the composer', placed.insideComposer, placed.order.join(', '));
  check('to the left of send', placed.leftOfSend);
  check('on the same row', placed.sameRow);
  check('and no longer duplicated in the header', placed.notInTopbar);
  check('it names the current policy', /guarded|auto|ask|read/i.test(placed.label), placed.label);

  await page.click('#policy-chip');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('policy-menu');
    const box = m.getBoundingClientRect();
    return {
      open: !m.hidden,
      items: [...m.querySelectorAll('.menu__item')].length,
      hasHints: [...m.querySelectorAll('.menu__hint')].length,
      icons: [...m.querySelectorAll('.menu__icon svg')].length,
      effortDots: [...m.querySelectorAll('.effort-dot')].length,
      marksCurrent: !!m.querySelector('.menu__item.is-active'),
      onScreen: box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
    };
  });
  check('clicking it opens the choices', menu.open);
  check('all five of them', menu.items === 5, `${menu.items}`);
  check('each explaining what it does', menu.hasHints === 5, `${menu.hasHints}`);
  check('and each carrying its own glyph', menu.icons === 5, `${menu.icons}`);
  check('with the current one marked', menu.marksCurrent);
  check('the effort dial rides along', menu.effortDots === 5, `${menu.effortDots}`);
  check('and it stays on screen', menu.onScreen);

  // Choosing one has to actually take effect, not just close the menu.
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('#policy-menu .menu__item')];
    items.find((i) => /auto/i.test(i.textContent))?.click();
  });
  await page.waitForTimeout(900);
  const after = await page.evaluate(async () => ({
    label: document.getElementById('policy-label').textContent,
    loud: document.getElementById('policy-chip').classList.contains('is-loud'),
    saved: (await (await fetch('/api/bootstrap')).json()).prefs.toolPolicy,
    // There is no second copy of this control any more. One setting, one home.
    duplicateInSettings: !!document.getElementById('tool-policy'),
    duplicateEffort: !!document.getElementById('effort'),
  }));
  check('the choice takes', /auto/i.test(after.label), after.label);
  check('the one that runs everything looks like it', after.loud, 'an always-amber control stops being a warning');
  check('and it is saved, not just shown', after.saved === 'auto', after.saved);
  check('settings does not repeat the mode picker', !after.duplicateInSettings);
  check('nor the effort picker', !after.duplicateEffort);

  // Put it back so later checks see the default.
  await page.evaluate(async () => {
    await fetch('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolPolicy: 'guarded' }),
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
}

section('the context gauge');
{
  const gauge = await page.evaluate(() => {
    const g = document.getElementById('context-gauge');
    return {
      exists: !!g,
      // Hidden until there is a conversation to measure — a ring at zero on an
      // empty chat is a question nobody asked.
      hiddenWhenEmpty: g?.hidden,
      isRing: !!g?.querySelector('.gauge__fill'),
      // It measures the message you are about to send, so it lives where you
      // are writing it — next to the attach button, not up in the header.
      inComposer: !!document.querySelector('.composer__box #context-gauge'),
      notInTopbar: !document.querySelector('.topbar #context-gauge'),
      nextToAttach:
        document.getElementById('attach')?.nextElementSibling?.id === 'context-gauge',
    };
  });
  check('there is a gauge', gauge.exists);
  check('drawn as a ring', gauge.isRing);
  check('in the composer', gauge.inComposer);
  check('immediately beside the attach button', gauge.nextToAttach);
  check('and no longer in the header', gauge.notInTopbar);
  check(
    'and hidden until there is something to measure',
    gauge.hiddenWhenEmpty === true,
    'a ring at zero on an empty chat is a question nobody asked',
  );

  // The colours are read one at a time with a pause, because the stroke is
  // transitioned — reading it the instant the class changes returns the colour
  // it is leaving, not the one it is going to.
  const paint = async (ratio) => {
    await page.evaluate((r) => {
      const g = document.getElementById('context-gauge');
      const fill = g.querySelector('.gauge__fill');
      g.hidden = false;
      fill.style.strokeDasharray = `${2 * Math.PI * 13 * r} ${2 * Math.PI * 13}`;
      g.classList.toggle('is-warm', r >= 0.6);
      g.classList.toggle('is-hot', r >= 0.85);
    }, ratio);
    await page.waitForTimeout(450);
    return page.evaluate(() => getComputedStyle(document.querySelector('.gauge__fill')).stroke);
  };

  const calm = await paint(0.2);
  const warm = await paint(0.7);
  const hot = await paint(0.95);
  check('a quarter full is the accent colour', calm !== warm, calm);
  check('past two-thirds it goes amber', warm !== calm && warm !== hot, warm);
  check('and nearly full it goes red', hot !== warm, hot);
  check(
    'the ring fills rather than jumping',
    await page.evaluate(() =>
      /stroke-dasharray/.test(getComputedStyle(document.querySelector('.gauge__fill')).transitionProperty),
    ),
    'that is what makes it read as a gauge',
  );

  /**
   * A circle inside a not-quite-circle.
   *
   * The padding used to lean right to leave room for a number that is absent
   * most of the time, and the row stretches its controls to a common height —
   * so the quiet state came out 36 wide by 38 tall with the ring 6px from one
   * edge and 10px from the other. Nobody can name that, everybody can see it.
   */
  const box = async (withNumber) => {
    await page.evaluate((show) => {
      const g = document.getElementById('context-gauge');
      g.hidden = false;
      document.getElementById('context-percent').textContent = show ? '65%' : '';
      g.classList.toggle('has-number', show);
    }, withNumber);
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const g = document.getElementById('context-gauge');
      const b = g.getBoundingClientRect();
      const s = g.querySelector('svg').getBoundingClientRect();
      // Whatever it is sitting next to — the attach button, since it moved into
      // the composer. Two round controls of different diameters side by side is
      // the kind of thing you cannot name but can see.
      const sibling = document.getElementById('attach').getBoundingClientRect();
      return {
        w: Math.round(b.width),
        h: Math.round(b.height),
        left: +(s.left - b.left).toFixed(1),
        right: +(b.right - s.right).toFixed(1),
        top: +(s.top - b.top).toFixed(1),
        bottom: +(b.bottom - s.bottom).toFixed(1),
        matchesRow: Math.abs(b.height - sibling.height) < 1,
      };
    });
  };

  const quiet = await box(false);
  check('with no number the gauge is square', quiet.w === quiet.h, `${quiet.w}x${quiet.h}`);
  check('the same size as the buttons beside it', quiet.matchesRow);
  check('with the ring dead centre', quiet.left === quiet.right && quiet.top === quiet.bottom, JSON.stringify(quiet));

  const wide = await box(true);
  check('a number makes it a pill, still the same height', wide.w > wide.h && wide.h === quiet.h, `${wide.w}x${wide.h}`);
  check('and the ring keeps its own margin', wide.left > 4, `${wide.left}px`);
  await box(false);

  /**
   * Now the real path: a conversation with something in it.
   *
   * The gauge is driven from a server measurement, and its menu refuses to open
   * without one — a menu that says "0% of ?" would be worse than no menu. So
   * this sends a message and reopens the chat, which is where the measurement
   * comes from.
   */
  await page.click('#new-chat');
  await page.waitForTimeout(900);
  await page.fill('#input', 'a message long enough to measure');
  await page.click('#send');
  await page.waitForTimeout(2500);
  await page.click('.chat-item');
  await page.waitForTimeout(1600);

  const live = await page.evaluate(() => {
    const g = document.getElementById('context-gauge');
    return { shown: !g.hidden, title: g.title, dash: g.querySelector('.gauge__fill').style.strokeDasharray };
  });
  check('a real conversation shows the gauge', live.shown);
  check('with the numbers in the tooltip', /tokens/.test(live.title || ''), live.title);
  check('and the ring drawn to a real value', !!live.dash, live.dash);

  await page.click('#context-gauge');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('context-menu');
    return {
      open: !m.hidden,
      head: m.querySelector('.menu__head')?.textContent,
      actions: [...m.querySelectorAll('.menu__item')].map((i) => i.textContent.split('\n')[0].trim()),
    };
  });
  check('clicking it says how full, in numbers', menu.open && /used/.test(menu.head || ''), menu.head);
  check('and offers to fold the earlier turns now', menu.actions.some((a) => /compact now/i.test(a)), menu.actions.join(' | '));
  check('and to turn the automatic one off', menu.actions.some((a) => /auto-compact/i.test(a)), menu.actions.join(' | '));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes it', await page.evaluate(() => document.getElementById('context-menu').hidden));
}

section('the menu closes from its own edge, and reopens from the logo');
{
  // Open: an ordinary close button at the far right of the header, where every
  // panel keeps one. The logo is a logo and nothing else.
  const open = await page.evaluate(() => {
    const head = document.querySelector('.sidebar__head');
    const collapse = document.getElementById('sidebar-collapse');
    const brand = document.getElementById('sidebar-toggle');
    const headBox = head.getBoundingClientRect();
    const box = collapse.getBoundingClientRect();
    return {
      visible: !!box.width && getComputedStyle(collapse).display !== 'none',
      atTheRightEdge: headBox.right - box.right < 4,
      pastTheLogo: box.left > brand.getBoundingClientRect().right - 1,
      labelled: collapse.getAttribute('aria-label'),
      logoIsInert: brand.disabled,
      logoSaysNothing: !brand.getAttribute('aria-label'),
    };
  });
  check('there is a close button while the menu is open', open.visible);
  check('at the far right of the header', open.atTheRightEdge);
  check('not folded into the logo', open.pastTheLogo);
  check('and it says what it does', /collapse/i.test(open.labelled || ''), open.labelled);
  check('the logo is not a control here', open.logoIsInert);
  check('so it announces nothing to a screen reader', open.logoSaysNothing);

  // A disabled button still matches :hover, so the swap has to be off too —
  // otherwise the open menu's logo flickers into a glyph that does nothing.
  await page.hover('#sidebar-toggle');
  await page.waitForTimeout(350);
  const hoveredOpen = await page.evaluate(() => ({
    toggle: Number(getComputedStyle(document.querySelector('.brand__toggle')).opacity),
    mark: Number(getComputedStyle(document.querySelector('.brand__mark')).opacity),
  }));
  check('hovering the logo does not swap in a glyph', hoveredOpen.toggle < 0.1, String(hoveredOpen.toggle));
  check('the mark stays put', hoveredOpen.mark > 0.9, String(hoveredOpen.mark));

  const wide = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
  await page.click('#sidebar-collapse');
  await page.waitForTimeout(500);
  const collapsed = await page.evaluate(() => {
    const brand = document.getElementById('sidebar-toggle');
    return {
      width: document.querySelector('.sidebar').getBoundingClientRect().width,
      isRail: document.getElementById('app').classList.contains('is-rail'),
      closeGone: getComputedStyle(document.getElementById('sidebar-collapse')).display === 'none',
      logoLive: !brand.disabled,
      // A native tooltip appears below the cursor a moment later — a second,
      // differently-placed explanation of a control that already explains
      // itself by swapping its own icon.
      noNativeTooltip: !brand.getAttribute('title'),
      labelled: !!brand.getAttribute('aria-label'),
    };
  });
  check('clicking it collapses the sidebar', collapsed.width < wide - 100, `${Math.round(wide)} → ${Math.round(collapsed.width)}`);
  check('and it is collapsed', collapsed.isRail);
  check('the close button goes with it — the rail has no edge to hold one', collapsed.closeGone);
  check('so the logo takes the job back', collapsed.logoLive);
  check('with no native tooltip to appear underneath', collapsed.noNativeTooltip);
  check('but a name for a screen reader', collapsed.labelled);

  // Collapsed, the two icons occupy the same square: one replaces the other.
  const stacked = await page.evaluate(() => {
    const mark = document.querySelector('.brand__mark').getBoundingClientRect();
    const toggle = document.querySelector('.brand__toggle').getBoundingClientRect();
    return {
      overlapX: Math.abs(mark.left + mark.width / 2 - (toggle.left + toggle.width / 2)) < 8,
      overlapY: Math.abs(mark.top + mark.height / 2 - (toggle.top + toggle.height / 2)) < 8,
      toggleHidden: Number(getComputedStyle(document.querySelector('.brand__toggle')).opacity) === 0,
    };
  });
  check('the two icons share one square', stacked.overlapX && stacked.overlapY, JSON.stringify(stacked));
  check('and the glyph is invisible until pointed at', stacked.toggleHidden);

  await page.hover('#sidebar-toggle');
  await page.waitForTimeout(350);
  const hovered = await page.evaluate(() => ({
    toggle: Number(getComputedStyle(document.querySelector('.brand__toggle')).opacity),
    mark: Number(getComputedStyle(document.querySelector('.brand__mark')).opacity),
  }));
  check('hovering brings the glyph up', hovered.toggle > 0.9, String(hovered.toggle));
  check('and takes the logo away, in the same place', hovered.mark < 0.1, String(hovered.mark));

  await page.click('#sidebar-toggle');
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
  check('and clicking it brings the menu back', Math.abs(back - wide) < 2, `${Math.round(back)}`);
}

section('the panels move rather than snap');
{
  const eased = await page.evaluate(() => {
    const app = getComputedStyle(document.getElementById('app'));
    return {
      property: app.transitionProperty,
      duration: app.transitionDuration,
    };
  });
  // Both panels are grid columns, so one transition covers the sidebar folding
  // to a rail and the detail rail sliding in — they cannot get out of step.
  check('the shell animates its columns', /grid-template-columns/.test(eased.property), eased.property);
  check('over a real duration', parseFloat(eased.duration) > 0.1, eased.duration);
}

section('computer status is not said twice');
{
  const said = await page.evaluate(() => ({
    inSidebar: !!document.getElementById('worker-pill'),
    inHeader: !!document.getElementById('pair-chip'),
  }));
  check('the sidebar no longer carries a worker pill', !said.inSidebar);
  check('the header chip is the one place it is said', said.inHeader);
}

section('the opening screen has a sky, and only the opening screen');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(900);

  const fresh = await page.evaluate(() => {
    const galaxy = document.getElementById('galaxy');
    const s = getComputedStyle(galaxy);
    return {
      lit: document.getElementById('app').classList.contains('is-fresh'),
      opacity: Number(s.opacity),
      visibility: s.visibility,
      // Decorative: it must never eat a click or be read out as content.
      inert: s.pointerEvents === 'none' && galaxy.getAttribute('aria-hidden') === 'true',
      behind: Number(s.zIndex) < Number(getComputedStyle(document.getElementById('thread')).zIndex),
      drifting: getComputedStyle(document.querySelector('.galaxy__cloud')).animationPlayState,
      stars: document.querySelectorAll('.galaxy__stars').length,
      // The page must not gain a scrollbar because a decorative layer is
      // wider than the window it sits in.
      pageWide: document.body.scrollWidth > window.innerWidth + 1,
    };
  });
  // Not `=== 1`: it fades in over most of a second, so a strict compare here
  // tests the stopwatch rather than the behaviour.
  check('an empty conversation gets one', fresh.lit && fresh.opacity > 0.9, JSON.stringify(fresh));
  check('it drifts', fresh.drifting === 'running');
  check('with stars at two depths', fresh.stars === 2, `${fresh.stars}`);
  check('it sits behind everything you can touch', fresh.behind);
  check('and cannot be touched or heard', fresh.inert);
  check('and it does not widen the page', !fresh.pageWide);

  await page.fill('#input', 'hello');
  await page.click('#send');
  await page.waitForTimeout(1500);
  const busy = await page.evaluate(() => ({
    lit: document.getElementById('app').classList.contains('is-fresh'),
    opacity: Number(getComputedStyle(document.getElementById('galaxy')).opacity),
    // Faded out is not enough — an animation nobody can see is just a warm
    // laptop, so it has to actually stop.
    drifting: getComputedStyle(document.querySelector('.galaxy__cloud')).animationPlayState,
  }));
  check('the moment there is something to read, it goes', !busy.lit && busy.opacity === 0, JSON.stringify(busy));
  check('and stops animating rather than idling unseen', busy.drifting === 'paused');
}

section('projects: instructions and sources a conversation inherits');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  const rail = await page.evaluate(() => ({
    label: document.getElementById('open-projects')?.querySelector('.rail__label')?.textContent,
    // The model picker moved to the header chip and Settings → Models; the
    // sidebar slot goes to the thing you come back to across days.
    modelLibraryGone: !document.getElementById('open-library'),
    pickerStillReachable: !!document.getElementById('model-chip'),
  }));
  check('the sidebar offers Projects', rail.label === 'Projects', rail.label);
  check('in place of the model library', rail.modelLibraryGone);
  check('which is still one press away on the header chip', rail.pickerStillReachable);

  // Projects is a page now, and making one goes through the form on it.
  await page.click('#open-projects');
  await page.waitForTimeout(700);
  await page.click('#page-new');
  await page.waitForTimeout(500);
  await page.fill('#project-form-name', 'UI project');
  await page.click('#project-form-save');
  await page.waitForTimeout(1200);

  // Creating one lands *in* it, on its own page — you named it because you were
  // about to use it, not to admire it on a shelf.
  const opened = await page.evaluate(() => ({
    onPage: !document.getElementById('project-page').hidden,
    shelfGone: document.getElementById('page').hidden,
    crumb: document.getElementById('project-page-crumb').textContent,
    name: document.getElementById('project-page-name').textContent,
    asks: document.getElementById('project-page-ask').placeholder,
    cards: [...document.querySelectorAll('#project-page-side .panel-card__name')].map((n) => n.textContent),
  }));
  check('creating one opens its page', opened.onPage && opened.shelfGone, JSON.stringify(opened));
  check('titled with its name', opened.name === 'UI project', opened.name);
  check('under a breadcrumb back to the shelf', opened.crumb === 'UI project', opened.crumb);
  check('with a composer, not a form', opened.asks === 'How can I help you today?', opened.asks);
  check(
    'and what it knows down the side',
    JSON.stringify(opened.cards) === JSON.stringify(['Instructions', 'Memory', 'Context']),
    JSON.stringify(opened.cards),
  );

  // Memory in this application is per *account*. A card headed "Memory" on a
  // project page has to say so, or it is a quiet lie that nobody catches until
  // they wonder why another project knows the same thing.
  const honest = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#project-page-side .panel-card')];
    const memory = cards.find((c) => c.querySelector('.panel-card__name')?.textContent === 'Memory');
    return { tag: memory?.querySelector('.panel-card__tag')?.textContent, say: memory?.textContent || '' };
  });
  check('the memory card admits it is account-wide', honest.tag === 'account-wide', honest.tag);
  check('and says so in words too', /every project/i.test(honest.say), honest.say.slice(0, 120));

  // The Context menu offers only what exists here. Claude's has GitHub and
  // Drive; an entry that opens an apology is worse than no entry.
  await page.click('#pp-add-source');
  await page.waitForTimeout(300);
  const sources = await page.evaluate(() =>
    [...document.querySelectorAll('.cardmenu button')].map((b) => b.textContent.trim()),
  );
  check('adding context offers a file', sources.some((s) => /Upload from device/.test(s)), sources.join(' | '));
  check('or text pasted in', sources.some((s) => /Add text content/.test(s)));
  check('and nothing this app cannot do', !sources.some((s) => /GitHub|Drive/i.test(s)), sources.join(' | '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // A source has to be something that can be quoted, so a picture is refused at
  // the moment it is added rather than sitting in the list looking like
  // knowledge that is never once consulted.
  const added = await page.evaluate(async () => {
    const id = (await (await fetch('/api/projects')).json()).projects[0].id;
    const b64 = (s) => btoa(s);
    const post = (body) =>
      fetch(`/api/projects/${id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const text = await post({ name: 'rules.md', mime: 'text/markdown', data: b64('The pass mark is 5.0.') });
    const image = await post({ name: 'photo.png', mime: 'image/png', data: b64('nope') });
    return { text: text.status, image: image.status, why: image.body.error };
  });
  check('a text source is taken', added.text === 201, `${added.text}`);
  check('a picture is not', added.image === 400, `${added.image}`);
  check('because a source has to be quotable', /quote/i.test(added.why || ''), added.why);

  // Typing into the composer starts the conversation, carrying the first
  // message with it — nothing exists until it is sent.
  await page.fill('#project-page-ask', 'what is the pass mark');
  await page.waitForTimeout(200);
  check(
    'send lights up once there is something to send',
    !(await page.evaluate(() => document.getElementById('project-page-send').disabled)),
  );
  await page.click('#project-page-send');
  await page.waitForTimeout(2500);

  const chip = await page.evaluate(() => {
    const el = document.getElementById('project-chip');
    return {
      shown: !el.hidden,
      text: el.textContent,
      grounded: el.classList.contains('is-grounded'),
      title: el.title,
    };
  });
  // A grounded answer and an ordinary one look identical on the page, so the
  // header is the one place the difference can live.
  check('a chat started in a project says so', chip.shown && chip.text === 'UI project', JSON.stringify(chip));
  check('and that it is held to the sources', chip.grounded);
  check('with how many there are', /1 source/.test(chip.title || ''), chip.title);

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(1200);
  check(
    'an ordinary conversation carries no such claim',
    await page.evaluate(() => document.getElementById('project-chip').hidden),
  );
}

section('copying and editing what you said');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(400);
  await page.fill('#input', 'the question as first asked');
  await page.click('#send');
  await page.waitForTimeout(2200);

  const bubble = '#messages .msg--user';
  const idle = await page.evaluate((sel) => {
    const m = document.querySelector(sel);
    const actions = m?.querySelector('.msg__actions');
    return {
      hasId: !!m?.dataset.messageId,
      acts: [...(m?.querySelectorAll('.msg__action') || [])].map((b) => b.dataset.act).join(','),
      opacity: actions ? Number(getComputedStyle(actions).opacity) : null,
      // Reserved space, not display:none — a transcript that shifts under the
      // pointer as you move down it is unusable.
      height: actions ? Math.round(actions.getBoundingClientRect().height) : 0,
    };
  }, bubble);
  check('a sent message knows its own id', idle.hasId, 'without it there is nothing to edit');
  check('it offers copy and edit', idle.acts === 'copy,edit', idle.acts);
  check('invisible while you are not pointing at it', idle.opacity === 0, `${idle.opacity}`);
  check('but keeping its space', idle.height > 0, `${idle.height}px`);

  await page.hover(bubble);
  await page.waitForTimeout(350);
  const shown = await page.evaluate(
    (sel) => Number(getComputedStyle(document.querySelector(`${sel} .msg__actions`)).opacity),
    bubble,
  );
  check('and appearing when you do', shown === 1, `${shown}`);

  /**
   * And going away again afterwards.
   *
   * A clicked button keeps focus, so a `:focus-within` reveal left the row lit
   * on that message after the pointer had moved on — visible controls on a
   * message nobody was pointing at.
   */
  await page.click(`${bubble} [data-act="copy"]`);
  await page.mouse.move(20, 20);
  await page.waitForTimeout(500);
  const afterCopy = await page.evaluate((sel) => {
    const m = document.querySelector(sel);
    return {
      opacity: Number(getComputedStyle(m.querySelector('.msg__actions')).opacity),
      stillFocused: m.contains(document.activeElement),
    };
  }, bubble);
  check('they go once the pointer leaves, even after a copy', afterCopy.opacity === 0, `${afterCopy.opacity}`);
  check('and the button does not keep focus from a click', !afterCopy.stillFocused);

  // Keyboard focus is a different matter: that is how somebody without a mouse
  // gets to them at all, so it still reveals the row.
  const byKeyboard = await page.evaluate((sel) => {
    const button = document.querySelector(`${sel} .msg__action`);
    button.focus();
    // Playwright's .focus() does not set :focus-visible, so ask the browser
    // whether the rule would match rather than reading the computed opacity.
    return { rule: !!document.querySelector(`${sel}:has(.msg__action:focus-visible), ${sel}:focus-within`) };
  }, bubble);
  check('but a keyboard user can still reach them', byKeyboard.rule);

  await page.hover(bubble);
  await page.click(`${bubble} [data-act="edit"]`);
  await page.waitForTimeout(400);
  const editing = await page.evaluate((sel) => {
    const box = document.querySelector(`${sel} .bubble__edit`);
    return { open: !!box, value: box?.value, buttons: document.querySelectorAll(`${sel} [data-edit]`).length };
  }, bubble);
  check('editing opens a box holding what you wrote', editing.open && editing.value === 'the question as first asked', editing.value);
  check('with a way out and a way on', editing.buttons === 2);

  await page.fill(`${bubble} .bubble__edit`, 'the question as it should have been');
  await page.click('[data-edit="save"]');
  await page.waitForTimeout(2500);

  const after = await page.evaluate(async () => {
    const { chats } = await (await fetch('/api/chats')).json();
    const full = await (await fetch(`/api/chats/${chats[0].id}`)).json();
    return {
      onScreen: document.querySelector('#messages .msg--user .bubble__text')?.textContent,
      stored: full.messages.filter((m) => m.role === 'user').map((m) => m.text),
      total: full.messages.length,
    };
  });
  check('saving rewrites the message', after.onScreen === 'the question as it should have been', after.onScreen);
  check('and stores the new wording', after.stored.join('|') === 'the question as it should have been', after.stored.join('|'));
  // Everything after it was a reply to a question that has been withdrawn.
  check('with everything that followed dropped', after.total === 1, `${after.total} messages left`);

  const assistant = await page.evaluate(() => !!document.querySelector('#messages .msg--assistant .msg__action'));
  check('an assistant turn offers no edit — that would be forging the record', !assistant);
}

section('a conversation nobody spoke in is not history');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  const before = await page.evaluate(async () => (await (await fetch('/api/chats')).json()).chats.length);

  // Press New chat three times and walk away. This used to leave three
  // identical "New chat" rows in the sidebar forever.
  for (let i = 0; i < 3; i += 1) {
    await page.click('#new-chat');
    await page.waitForTimeout(250);
  }

  const idle = await page.evaluate(async () => ({
    stored: (await (await fetch('/api/chats')).json()).chats.length,
    rows: document.querySelectorAll('#chat-list .chat-row').length,
    // Nothing in the sidebar is selected, because what you are looking at is
    // not in it yet.
    selected: document.querySelectorAll('#chat-list .chat-row.is-active').length,
    title: document.getElementById('chat-title').textContent,
    blank: !document.getElementById('empty-state').hidden,
  }));
  check('opening a blank chat stores nothing', idle.stored === before, `${before} → ${idle.stored}`);
  check('and adds no row to the sidebar', idle.rows === before, `${idle.rows}`);
  check('with nothing shown as selected', idle.selected === 0);
  check('the screen is a fresh one', idle.blank && idle.title === 'New chat', idle.title);

  // The first message is what brings it into existence.
  await page.fill('#input', 'the first thing said');
  await page.click('#send');
  await page.waitForTimeout(2000);

  const saved = await page.evaluate(async () => ({
    stored: (await (await fetch('/api/chats')).json()).chats.length,
    rows: document.querySelectorAll('#chat-list .chat-row').length,
  }));
  check('speaking in it saves it', saved.stored === before + 1, `${saved.stored}`);
  check('and it appears in the sidebar', saved.rows === before + 1, `${saved.rows}`);
}

section('there is no chat/agent toggle');
check('the toggle is gone', !(await page.$('#mode-toggle')));

section('the composer floats over the transcript');
const dock = await page.evaluate(() => {
  const composer = document.getElementById('composer').getBoundingClientRect();
  const thread = document.getElementById('thread');
  const box = thread.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(thread).paddingBottom);
  const dockH = document.getElementById('dock').offsetHeight;
  return {
    // The transcript runs the full height; the composer sits on top of it.
    threadReachesBottom: Math.abs(box.bottom - composer.bottom) < 2,
    composerInside: composer.bottom <= window.innerHeight + 1,
    padding: pad,
    dockH,
    gradientIgnoresClicks: getComputedStyle(document.getElementById('dock')).pointerEvents === 'none',
  };
});
check('the transcript extends under the composer', dock.threadReachesBottom);
check('the composer is on screen', dock.composerInside);
check('the dock does not block scrolling', dock.gradientIgnoresClicks);
check(
  'bottom padding matches the dock height',
  dock.padding >= dock.dockH && dock.padding <= dock.dockH + 20,
  `pad ${Math.round(dock.padding)} vs dock ${dock.dockH}`,
);

section('progress and the screen live in a side rail');
check('the rail exists', !!(await page.$('#detail')));
check('the screen panel is inside it', await page.evaluate(() => !!document.querySelector('#detail #screen')));
check('and not above the conversation', await page.evaluate(() => !document.querySelector('.main #screen')));

const railClosed = await page.evaluate(() => !document.getElementById('app').classList.contains('is-detail'));
check('it starts closed', railClosed);
await page.click('#detail-toggle');
await page.waitForTimeout(400);
const railOpen = await page.evaluate(() => {
  const detail = document.getElementById('detail').getBoundingClientRect();
  const thread = document.getElementById('thread').getBoundingClientRect();
  return {
    open: document.getElementById('app').classList.contains('is-detail'),
    width: Math.round(detail.width),
    // Beside the conversation, not on top of it.
    besideNotOver: detail.left >= thread.right - 2,
    onScreen: detail.right <= window.innerWidth + 1,
  };
});
check('the toggle opens it', railOpen.open, `${railOpen.width}px wide`);
check('it sits beside the conversation', railOpen.besideNotOver);
check('it stays on screen', railOpen.onScreen);

// A plan should fill it in and count itself off.
await page.evaluate(() => {
  const list = document.getElementById('progress-steps');
  list.innerHTML = '';
  const steps = [
    { title: 'Read the spec', status: 'done' },
    { title: 'Write the code', status: 'in_progress' },
    { title: 'Run the tests', status: 'pending' },
  ];
  for (const s of steps) {
    const li = document.createElement('li');
    li.className = s.status === 'done' ? 'is-done' : s.status === 'in_progress' ? 'is-active' : '';
    li.innerHTML = `<span>${s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▸' : '○'}</span><span>${s.title}</span>`;
    list.append(li);
  }
  document.getElementById('progress-count').textContent = '1 of 3';
});
await page.waitForTimeout(200);
const steps = await page.$$eval('#progress-steps li', (els) =>
  els.map((e) => `${e.className || 'pending'}:${e.textContent.trim()}`),
);
check('steps render with their state', steps.length === 3 && steps[0].startsWith('is-done'), steps.join(' | ').slice(0, 70));
check('and are counted', (await page.textContent('#progress-count')) === '1 of 3');

await page.click('#detail-close');

/**
 * A long queued message must not carry its own controls off the screen.
 *
 * This shipped: `.queue__item` was a grid whose middle column was `1fr`, and a
 * grid item's automatic minimum is its min-content width — so one pasted
 * paragraph grew the row to 1729px inside a 780px composer and pushed "Send
 * now" and the delete button around 900px past the right edge of the window.
 * Both were rendered the entire time and neither could be clicked, which is
 * indistinguishable from their not existing, and is how it was reported.
 */
section('a long queued message stays inside the composer');
{
  const LONG =
    'đảm bảo tất cả các file này sẽ xóa vì tôi không train AI nữa: 1. Cache & file tạm thời ' +
    'AI/ML (khoảng 20+ GB) các file .arrow trong cache (625MB-6.4GB mỗi file) và toàn bộ thư mục ' +
    'huggingface, torch hub, cùng mọi checkpoint đã tải về trước đó không còn dùng đến nữa.';

  const box = await page.evaluate((text) => {
    const host = document.getElementById('queue');
    host.hidden = false;
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    // The same shape `renderQueue` builds. Injected rather than driven, because
    // queueing needs a running turn and that needs a provider key.
    host.innerHTML =
      '<div class="queue__item">' +
      '<span class="queue__wait" aria-hidden="true"></span>' +
      '<div class="queue__body">' +
      `<p class="queue__text" id="queue-text-0">${esc(text)}</p>` +
      '<button class="queue__more" data-more="0" type="button">Show more</button>' +
      '</div>' +
      '<div class="queue__actions">' +
      '<button class="queue__now" type="button">Send now</button>' +
      '<button class="queue__drop" type="button" aria-label="Remove">✕</button>' +
      '</div></div>';

    const r = (sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) };
    };
    const text0 = document.getElementById('queue-text-0');
    const clampedH = text0.clientHeight;
    const fullH = text0.scrollHeight;

    document.querySelector('.queue__item').classList.add('is-open');
    const openedH = document.getElementById('queue-text-0').clientHeight;

    return {
      viewport: window.innerWidth,
      item: r('.queue__item'),
      composer: r('.composer__box'),
      now: r('.queue__now'),
      drop: r('.queue__drop'),
      clampedH,
      fullH,
      openedH,
    };
  }, LONG);

  const onScreen = (b) => b.right <= box.viewport && b.left >= 0;
  check('the row does not outgrow the composer', box.item.right <= box.composer.right + 1, `${box.item.right} vs ${box.composer.right}`);
  check('"Send now" is reachable', onScreen(box.now), `right ${box.now.right} of ${box.viewport}`);
  check('and so is the delete button', onScreen(box.drop), `right ${box.drop.right} of ${box.viewport}`);
  check('the text is clamped rather than shown whole', box.clampedH < box.fullH, `${box.clampedH}px of ${box.fullH}px`);
  check('and opening it shows more', box.openedH > box.clampedH, `${box.openedH}px`);
}
await page.waitForTimeout(300);
check('closing works', await page.evaluate(() => !document.getElementById('app').classList.contains('is-detail')));

section('the screen panel says which browser you are looking at');
const labelled = await page.evaluate(() => {
  // The panel lives in the detail rail, so the rail has to be open for any of
  // it to be visible at all.
  document.getElementById('app').classList.add('is-detail');
  const panel = document.getElementById('screen');
  panel.hidden = false;
  // Pretend a sandbox frame arrived, then a desktop one.
  const badge = document.getElementById('screen-source');
  const closeBtn = document.getElementById('screen-stop');
  return { hasBadge: !!badge, hasClose: !!closeBtn };
});
check('there is a source badge', labelled.hasBadge);
check('and a way to close the sandbox yourself', labelled.hasClose);

// Taking the controls is off until asked for: a stray click while reading
// should not land in a page the assistant is midway through using.
const drive = await page.evaluate(() => {
  const btn = document.getElementById('screen-drive');
  return { exists: !!btn, pressed: btn?.getAttribute('aria-pressed'), focusable: document.getElementById('screen-img')?.tabIndex };
});
check('there is a take-control button', drive.exists);
check('control starts off', drive.pressed === 'false');

// The panel is a browser window somebody else is driving, so it has the row a
// browser has — and above the picture, where a browser puts it.
const chrome = await page.evaluate(() => {
  const nav = document.getElementById('screen-nav');
  const img = document.getElementById('screen-img');
  return {
    exists: !!nav,
    buttons: ['screen-back', 'screen-forward', 'screen-reload'].filter((id) => document.getElementById(id)).length,
    // Navigation is not behind "take control": watching a wrong turn with no
    // way to press Back is a strange kind of helplessness.
    outsideDriveMode: !document.getElementById('screen').classList.contains('is-driving'),
    // 4 is DOCUMENT_POSITION_FOLLOWING: the picture comes after the row.
    aboveThePicture: nav && img ? !!(nav.compareDocumentPosition(img) & 4) : false,
    urlInside: !!nav?.querySelector('#screen-url'),
  };
});
// The sandbox has always had real tabs; the panel only ever showed the focused
// one, so a second page read as the first one disappearing.
const strip = await page.evaluate(() => {
  const el = document.getElementById('screen-tabs');
  const nav = document.getElementById('screen-nav');
  return {
    exists: !!el,
    hiddenWithOneTab: el?.hidden !== false,
    aboveTheAddress: el && nav ? !!(el.compareDocumentPosition(nav) & 4) : false,
  };
});
check('the panel has a tab strip', strip.exists);
check('hidden while there is only one tab', strip.hiddenWithOneTab, 'a tab strip with one tab is furniture');
check('and it sits above the address row', strip.aboveTheAddress);

check('the panel has an address row', chrome.exists);
check('with back, forward and reload', chrome.buttons === 3, `${chrome.buttons}`);
check('above the page, where a browser keeps it', !!chrome.aboveThePicture);
check('and the address in it', chrome.urlInside);
check('usable without taking control first', chrome.outsideDriveMode);
check('the frame can receive keys once driving', drive.focusable === 0);

await page.click('#screen-drive');
await page.waitForTimeout(200);
const driving = await page.evaluate(() => ({
  pressed: document.getElementById('screen-drive').getAttribute('aria-pressed'),
  marked: document.getElementById('screen').classList.contains('is-driving'),
}));
check('it toggles on', driving.pressed === 'true');
check('and says so visibly', driving.marked);

// The chart that would not pan. An <img> is draggable by default, so pressing
// on the mirror and pulling started a native image drag and the gesture was
// never ours to forward.
const dragging = await page.evaluate(() => {
  const img = document.getElementById('screen-img');
  const style = getComputedStyle(img);
  // Does a real press-move-release reach the page as a drag rather than being
  // eaten by the browser's own image dragging?
  let started = false;
  const spy = () => { started = true; };
  img.addEventListener('dragstart', spy);
  const box = img.getBoundingClientRect();
  const at = (dx) => ({
    bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1,
    clientX: box.left + box.width / 2 + dx, clientY: box.top + box.height / 2,
  });
  img.dispatchEvent(new PointerEvent('pointerdown', at(0)));
  img.dispatchEvent(new PointerEvent('pointermove', at(120)));
  const midDrag = document.getElementById('screen').classList.contains('is-dragging');
  img.dispatchEvent(new PointerEvent('pointerup', at(120)));
  img.removeEventListener('dragstart', spy);
  return {
    nativeDragBlocked: style.webkitUserDrag === 'none' || style.userSelect === 'none',
    startedNativeDrag: started,
    midDrag,
    settled: !document.getElementById('screen').classList.contains('is-dragging'),
    cursor: style.cursor,
  };
});
check('the picture is not natively draggable', dragging.nativeDragBlocked, 'otherwise the gesture never reaches us');
check('a press and pull registers as a drag', dragging.midDrag, 'the panel marks itself while the gesture is live');
check('and the mark is cleared on release', dragging.settled);
check('the cursor invites it', /grab/.test(dragging.cursor), dragging.cursor);

await page.click('#screen-drive');

section('the screen panel expands to fill the window');
{
  // It was `grid-template-rows: auto 1fr` over four children, so the `1fr`
  // landed on the tab strip and the picture had no room at all: pressing the
  // expand button made the thing you wanted to see disappear.
  const before = await page.evaluate(() => document.querySelector('.screen__frame').getBoundingClientRect().height);
  await page.click('#screen-expand');
  await page.waitForTimeout(250);

  const expanded = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    const frame = panel.querySelector('.screen__frame');
    const bar = panel.querySelector('.screen__bar').getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    const img = document.getElementById('screen-img').getBoundingClientRect();
    return {
      marked: panel.classList.contains('is-expanded'),
      frameHeight: box.height,
      panelHeight: panel.getBoundingClientRect().height,
      viewport: innerHeight,
      barVisible: bar.height > 0,
      bottom: box.bottom,
      imageWithinFrame: img.height <= box.height + 1 && img.width <= box.width + 1,
    };
  });

  check('the panel is marked expanded', expanded.marked);
  check('it fills the window', Math.abs(expanded.panelHeight - expanded.viewport) < 2,
    `${expanded.panelHeight} vs ${expanded.viewport}`);
  check('the picture gets the space, not the tab strip', expanded.frameHeight > before,
    `${before}px → ${expanded.frameHeight}px`);
  check('and most of the window', expanded.frameHeight > expanded.viewport * 0.6, `${expanded.frameHeight}px`);
  check('the bar is still there to close it with', expanded.barVisible);
  check('nothing hangs off the bottom', expanded.bottom <= expanded.viewport + 1, `${expanded.bottom}`);
  check('and the picture fits inside its frame', expanded.imageWithinFrame, 'never cropped, never overflowing');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const collapsed = await page.evaluate(() =>
    document.getElementById('screen').classList.contains('is-expanded'));
  check('Escape puts it back', !collapsed);
}

section('the conversation row menu');
// It used to call prompt(), which browsers suppress after a few uses — the
// click then silently did nothing at all.
await page.evaluate(() => {
  window.__dialogs = 0;
  for (const fn of ['prompt', 'confirm', 'alert']) {
    window[fn] = () => {
      window.__dialogs += 1;
      return null;
    };
  }
});
await page.click('#new-chat');
await page.waitForTimeout(900);
const hasRow = await page.$('.chat-row__menu');
check('a conversation row exists', !!hasRow);

await page.click('.chat-row__menu');
await page.waitForTimeout(300);
const menu = await page.evaluate(() => {
  const el = document.getElementById('row-menu');
  const box = el.getBoundingClientRect();
  return {
    open: !el.hidden,
    items: [...el.querySelectorAll('.menu__item span:first-of-type')].map((s) => s.textContent),
    keys: [...el.querySelectorAll('.menu__key')].map((s) => s.textContent),
    onScreen: box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
    usedBrowserDialog: window.__dialogs > 0,
  };
});
check('the menu opens', menu.open);
check('it offers pin, rename and delete', menu.items.join(',') === 'Pin,Rename,Delete', menu.items.join(' '));
check('with shortcut letters', menu.keys.join('') === 'PRD', menu.keys.join(''));
check('it stays on screen', menu.onScreen);
check('no browser dialog was used', !menu.usedBrowserDialog);

// Delete must take two clicks, so a mis-click cannot destroy a conversation.
await page.click('.menu__item--danger');
await page.waitForTimeout(200);
const armed = await page.evaluate(() => ({
  stillOpen: !document.getElementById('row-menu').hidden,
  label: document.querySelector('.menu__item--danger span').textContent,
}));
check('deleting arms rather than fires', armed.stillOpen && /really/i.test(armed.label), armed.label);

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape closes it', await page.evaluate(() => document.getElementById('row-menu').hidden));

// Renaming happens in the row itself.
await page.click('.chat-row__menu');
await page.waitForTimeout(250);
await page.click('#row-menu .menu__item:nth-child(2)');
await page.waitForTimeout(250);
check('rename edits in place', !!(await page.$('.chat-item--editing')));
await page.fill('.chat-item--editing', 'Renamed by the test');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const titles = await page.$$eval('.chat-item', (els) => els.map((e) => e.textContent.trim()));
check('the new title stuck', titles.includes('Renamed by the test'), titles.join(' | ').slice(0, 60));

section('the model dialog scrolls in exactly one place');
await page.click('#model-chip');
await page.waitForTimeout(1400);

// Scoped to the dialog: the transcript behind it scrolls too, correctly.
const scrollers = await page.evaluate(SCROLLERS, '#models');
check('one scrolling region, not several', scrollers.length === 1, `${scrollers.length} found`);
check('and it is the model list', scrollers[0]?.id === 'model-results', scrollers[0]?.id || 'none');
check('nothing has a horizontal scrollbar', !scrollers.some((s) => s.x));

// A grid column sized to max-content once made this 4054px wide inside a 658px
// dialog, which is what put a horizontal bar under the whole sheet.
const fit = await page.evaluate(() => {
  const d = document.getElementById('models');
  const search = document.getElementById('model-search').getBoundingClientRect();
  return {
    overflowX: d.scrollWidth - d.clientWidth,
    overflowY: d.scrollHeight - d.clientHeight,
    searchInside: search.right <= d.getBoundingClientRect().right + 1,
  };
});
check('the dialog does not overflow horizontally', fit.overflowX <= 1, `${fit.overflowX}px`);
check('the dialog does not overflow vertically', fit.overflowY <= 1, `${fit.overflowY}px`);
check('the search box stays inside the dialog', fit.searchInside);

section('choosing a model by provider');
const providers = await page.$$eval('#provider-filter .seg__btn', (els) => els.map((e) => e.dataset.provider));
check(
  'every provider is offered',
  providers.join() === 'all,anthropic,openai,google,openrouter,orcarouter',
  providers.join(' '),
);

/**
 * `auto` is not a provider's model and is deliberately in every list.
 *
 * It is the "I don't know which model is strong" answer, resolved per turn to
 * the best free model the account can run, and `renderResults` puts it above
 * everything on every tab except Paid. Filtering it out here is the difference
 * between testing the provider filter and testing that the Auto card exists —
 * which the check below does directly, so that it cannot quietly disappear.
 */
const AUTO = 'auto';

for (const [provider, pattern] of [
  ['anthropic', /^anthropic\//],
  ['openai', /^openai\//],
  ['google', /^google\//],
]) {
  await page.click(`#provider-filter [data-provider="${provider}"]`);
  await page.waitForTimeout(500);
  const view = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('[data-model]')].map((e) => e.dataset.model),
    chipsHidden: document.getElementById('vendor-row').hidden,
  }));
  const own = view.ids.filter((id) => id !== AUTO);
  check(
    `${provider} shows only its own models`,
    own.length > 0 && own.every((id) => pattern.test(id)),
    `${own.length} models${own.find((id) => !pattern.test(id)) ? `, stray ${own.find((id) => !pattern.test(id))}` : ''}`,
  );
  check(`${provider} offers Auto alongside them`, view.ids.includes(AUTO), view.ids.slice(0, 3).join(','));
  check(`${provider} hides the vendor chips`, view.chipsHidden === true);
}

await page.click('#provider-filter [data-provider="openrouter"]');
await page.waitForTimeout(800);
const library = await page.evaluate(() => ({
  ids: [...document.querySelectorAll('[data-model]')].map((e) => e.dataset.model),
  chipsHidden: document.getElementById('vendor-row').hidden,
}));
const libraryOwn = library.ids.filter((id) => id !== AUTO);
check(
  'OpenRouter shows the library and nothing built in',
  libraryOwn.length > 0 && libraryOwn.every((id) => id.startsWith('openrouter/')),
  `${libraryOwn.length} models${
    libraryOwn.find((id) => !id.startsWith('openrouter/'))
      ? `, stray ${libraryOwn.find((id) => !id.startsWith('openrouter/'))}`
      : ''
  }`,
);
check('OpenRouter brings the vendor chips back', library.chipsHidden === false);

// The chip you tap should land in the middle of its strip, not against the edge
// it came from — the neighbours you might pick next are the whole point of a
// row that scrolls.
{
  const strip = await page.evaluate(() => {
    const bar = document.getElementById('family-filter');
    const chips = [...bar.querySelectorAll('.chip-btn')];
    return { scrolls: bar.scrollWidth > bar.clientWidth + 2, count: chips.length };
  });
  if (!strip.scrolls) {
    realLog(`  ·  the vendor strip fits this viewport (${strip.count} chips) — nothing to centre`);
  } else {
    // A chip from the middle of a long strip has room to reach the centre, so
    // this is where "centred" is actually provable rather than merely allowed.
    const mid = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#family-filter .chip-btn')];
      return chips[Math.min(4, chips.length - 1)].dataset.family;
    });
    await page.click(`#family-filter [data-family="${mid}"]`);
    await page.waitForTimeout(800);
    const middle = await page.evaluate(() => {
      const bar = document.getElementById('family-filter');
      const el = bar.querySelector('.chip-btn.is-active');
      const b = bar.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return { off: Math.round(e.left + e.width / 2 - (b.left + b.width / 2)) };
    });
    check('the vendor you pick lands in the middle of the strip', Math.abs(middle.off) < 24, `${middle.off}px off centre`);

    const last = await page.evaluate(
      () => [...document.querySelectorAll('#family-filter .chip-btn')].pop().dataset.family,
    );
    await page.click(`#family-filter [data-family="${last}"]`);
    await page.waitForTimeout(800);
    const where = await page.evaluate(() => {
      const bar = document.getElementById('family-filter');
      const el = bar.querySelector('.chip-btn.is-active') || bar.querySelector('.chip-btn');
      const b = bar.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return {
        off: Math.round(e.left + e.width / 2 - (b.left + b.width / 2)),
        atEnd: bar.scrollLeft >= bar.scrollWidth - bar.clientWidth - 2,
        inside: e.left >= b.left - 1 && e.right <= b.right + 1,
      };
    });
    // The last chip cannot reach the middle, so the rule there is "clamped to
    // the end and fully visible" rather than "centred".
    check('picking a vendor off the edge brings it fully into view', where.inside, JSON.stringify(where));
    check('and the strip stops at its end rather than scrolling past', where.atEnd, JSON.stringify(where));
  }
}

// "Anthropic + Free" is legitimately empty. Saying why beats shrugging.
await page.click('#provider-filter [data-provider="anthropic"]');
await page.click('#tier-filter [data-tier="free"]');
await page.waitForTimeout(500);
const empty = await page.textContent('#model-results .hint').catch(() => '');
check('an empty combination explains itself', /no free models/i.test(empty || ''), (empty || '').slice(0, 60));

section('appearance');
{
  // Declared in the markup for a long time — `data-theme`, `color-scheme:
  // dark light` — and never actually written, so the switch pointed at nothing.
  const before = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    attr: document.documentElement.dataset.theme ?? null,
  }));

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.waitForTimeout(150);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(150);
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  check('light and dark are actually different', light !== dark, `${light} vs ${dark}`);
  check('light really is light', /^rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)$/.test(light), light);
  check('dark really is dark', /^rgb\(1?[0-9]?[0-9], /.test(dark), dark);
  check('the toggle exists in settings', !!(await page.$('#theme')));
  check('and offers a system option', await page.$eval('#theme', (s) => !!s.querySelector('[value="system"]')));

  await page.evaluate((value) => {
    if (value) document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }, before.attr);
}

/**
 * The chip and Settings are one setting, and must never show two values.
 *
 * This is the bug as reported: Settings read `google/gemini-pro-latest` while the
 * header chip on the conversation read `gemini-flash-latest`. Two causes, both
 * real. The chip had **two** click listeners — one opened Settings → Models, the
 * other opened the picker — so pressing it stacked the picker over a sheet
 * showing a different value. And a conversation carried its own stored model, so
 * even once the sheet was closed the two were genuinely different numbers.
 *
 * There is one model now, and — since the duplicate field was removed from
 * Settings → Models — exactly one control for it. The surest way for two places
 * to disagree is for there to be two places, so what is checked here is that the
 * second one is gone and that the remaining one survives a reload and an old
 * conversation being reopened.
 */
section('the model is one setting, with one control');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);

  // Pressing the chip must open exactly one thing. Two listeners used to fire.
  await page.click('#model-chip');
  await page.waitForTimeout(1000);
  const opened = await page.evaluate(() =>
    [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id));
  check('the chip opens the picker and nothing else', opened.join() === 'models', opened.join(' ') || 'nothing');

  // An earlier section leaves the tier filter on "free", under which no built-in
  // model matches; the picker keeps one state object for the whole page life.
  await page.click('#tier-filter [data-tier="all"]');
  await page.waitForTimeout(400);
  await page.click('#provider-filter [data-provider="google"]');
  await page.waitForTimeout(700);
  const viaChip = await page.$eval('[data-model]', (el) => el.dataset.model);
  await page.click(`[data-model="${viaChip}"]`);
  await page.waitForTimeout(1000);

  check('the chip shows what was picked', await page.evaluate(
    (m) => document.getElementById('model-chip').title.includes(m), viaChip), viaChip);

  // The duplicate that used to live in Settings → Models is gone. Its own hint
  // admitted it was the same act as pressing the chip, and two controls for one
  // value is the arrangement every check above it existed to police.
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="models"]');
  await page.waitForTimeout(300);
  const settingsPanel = await page.evaluate(() => ({
    field: !!document.getElementById('default-model-display'),
    button: !!document.getElementById('pick-default-model'),
    stillUseful: !!document.getElementById('add-model'),
  }));
  check('Settings no longer carries a second copy of the model', !settingsPanel.field);
  check('nor a second way to change it', !settingsPanel.button);
  check('while the rest of the Models tab remains', settingsPanel.stillUseful);

  // The reload is what used to expose the disagreement.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.click('.chat-item');
  await page.waitForTimeout(1500);

  const reloaded = await page.evaluate(() => document.getElementById('model-chip').title);
  check('after a reload the chip still shows it', reloaded.includes(viaChip), reloaded);
  check(
    'and reopening an older conversation shows the same model, not a stored one',
    reloaded.includes(viaChip),
    reloaded,
  );

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

/**
 * Many tabs in the sandbox must be reachable.
 *
 * The strip had `overflow-x: auto` with the scrollbar hidden on both engines, so
 * with five tabs open it genuinely scrolled and nothing said so — the tabs past
 * the right-hand edge simply did not appear to exist.
 */
section('the sandbox tab strip can be scrolled to');
{
  const strip = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    const bar = document.getElementById('screen-tabs');
    panel.hidden = false;
    bar.hidden = false;
    bar.innerHTML = '';
    for (let i = 1; i <= 8; i += 1) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `screen__tab${i === 1 ? ' is-active' : ''}`;
      b.textContent = `averylongtabhost-${i}.example.com`;
      bar.append(b);
    }
    const style = getComputedStyle(bar);
    return {
      overflows: bar.scrollWidth > bar.clientWidth + 2,
      overflowX: style.overflowX,
      // `none` is what hid it. Anything else means there is a bar to grab.
      scrollbarWidth: style.scrollbarWidth,
      canScroll: (() => {
        bar.scrollLeft = 9999;
        const moved = bar.scrollLeft > 0;
        bar.scrollLeft = 0;
        return moved;
      })(),
    };
  });

  check('eight tabs overflow the strip', strip.overflows, 'otherwise there is nothing to prove');
  check('the strip scrolls horizontally', strip.overflowX === 'auto' || strip.overflowX === 'scroll', strip.overflowX);
  check('and the scrollbar is no longer hidden', strip.scrollbarWidth !== 'none', strip.scrollbarWidth);
  check('so the tabs past the edge can be reached', strip.canScroll);

  await page.evaluate(() => {
    document.getElementById('screen-tabs').innerHTML = '';
    document.getElementById('screen-tabs').hidden = true;
    document.getElementById('screen').hidden = true;
  });
}

/**
 * The guide a new account sees, and the language it speaks.
 *
 * Two things worth pinning. It has to appear **once** — a guide that comes back
 * after being dismissed has stopped being help — and it must not appear over the
 * new-model announcement, because two stacked modals on a first visit is worse
 * than either alone.
 */
section('the getting-started guide');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);

  // This account has been through the app already, so the guide is dismissed by
  // now. Reopening it from Settings is the path somebody actually uses.
  await page.click('#open-settings');
  await page.waitForTimeout(400);
  await page.click('.tab[data-tab="behaviour"]');
  await page.waitForTimeout(300);
  check('Settings offers the guide again', await page.isVisible('#open-onboarding'));

  await page.click('#open-onboarding');
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({
    open: document.getElementById('onboarding').open,
    others: [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id),
    step: document.getElementById('onb-step').textContent.trim(),
    title: document.querySelector('#onb-body .onb__title')?.textContent.trim() || '',
    backHidden: document.getElementById('onb-back').hidden,
  }));
  check('the guide opens', opened.open === true);
  check('and it is the only thing open', opened.others.join() === 'onboarding', opened.others.join(' '));
  check('it starts at step 1 of 5', /1/.test(opened.step) && /5/.test(opened.step), opened.step);
  check('with a title', opened.title.length > 0, opened.title);
  check('and no Back button on the first step', opened.backHidden === true);

  // Walk all five steps. Each one has to render something.
  const titles = [opened.title];
  for (let i = 2; i <= 5; i += 1) {
    await page.click('#onb-next');
    await page.waitForTimeout(350);
    const at = await page.evaluate(() => ({
      step: document.getElementById('onb-step').textContent.trim(),
      title: document.querySelector('#onb-body .onb__title')?.textContent.trim() || '',
      body: document.getElementById('onb-body').textContent.trim().length,
      backHidden: document.getElementById('onb-back').hidden,
    }));
    check(`step ${i} renders`, at.title.length > 0 && at.body > 40, `${at.title} (${at.body} chars)`);
    check(`step ${i} can be gone back from`, at.backHidden === false);
    titles.push(at.title);
  }
  check('all five steps are different', new Set(titles).size === 5, titles.join(' | '));

  /**
   * Step 2 tracks whether a key exists, in both directions.
   *
   * This account has none yet, so it has to say so and offer the way to fix it.
   * Then a key is saved — through the interface, the way somebody would — and the
   * step has to notice **while it is still open behind the settings sheet**. A
   * guide that tells you to paste a key you have just pasted is a guide arguing
   * with you.
   */
  await page.click('#onb-back');
  await page.click('#onb-back');
  await page.click('#onb-back');
  await page.waitForTimeout(400);
  const noKey = await page.evaluate(() => ({
    step: document.getElementById('onb-step').textContent.trim(),
    todo: !!document.querySelector('#onb-body .onb__state.is-todo'),
    prompts: !!document.getElementById('onb-keys'),
  }));
  check('back reaches step 2', /2/.test(noKey.step), noKey.step);
  check('step 2 says there is no key yet', noKey.todo === true);
  check('and offers the way to add one', noKey.prompts === true);

  // Follow that button, save a key, and come back to the guide still open behind.
  await page.click('#onb-keys');
  await page.waitForTimeout(600);
  check('it opens the key settings', await page.isVisible('#provider-list'));
  await page.fill('[data-key="openrouter"]', 'sk-or-v1-ui-test-key');
  await page.click('[data-save-key="openrouter"]');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.getElementById('settings').close());
  await page.waitForTimeout(500);

  const withKey = await page.evaluate(() => ({
    open: !!document.getElementById('onboarding')?.open,
    step: document.getElementById('onb-step').textContent.trim(),
    done: !!document.querySelector('#onb-body .onb__state.is-done'),
    prompts: !!document.getElementById('onb-keys'),
  }));
  check('the guide is still open behind the sheet', withKey.open === true);
  check('still on step 2', /2/.test(withKey.step), withKey.step);
  check('and it now sees the key that was just saved', withKey.done === true);
  check('so it stops asking for one', withKey.prompts === false);

  // Step 4 hands a sentence to the composer and closes.
  await page.click('#onb-next');
  await page.click('#onb-next');
  await page.waitForTimeout(400);
  const tries = await page.$$eval('#onb-body .onb__try', (els) => els.map((e) => e.textContent.trim()));
  check('step 4 offers something to try', tries.length === 3, tries.length + ' suggestions');
  await page.click('#onb-body .onb__try');
  await page.waitForTimeout(500);
  const handed = await page.evaluate(() => ({
    closed: !document.getElementById('onboarding').open,
    typed: document.getElementById('input').value.trim(),
  }));
  check('pressing one closes the guide', handed.closed === true);
  check('and puts the question in the composer', handed.typed.length > 0, handed.typed);

  await page.evaluate(() => {
    document.getElementById('input').value = '';
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

section('the interface speaks Vietnamese');
{
  await page.click('#open-settings');
  await page.waitForTimeout(400);
  await page.click('.tab[data-tab="behaviour"]');
  await page.waitForTimeout(300);

  const offered = await page.$$eval('#language option', (els) => els.map((e) => e.value));
  check('both languages are offered', offered.join() === 'vi,en', offered.join(' '));

  const before = await page.evaluate(() => ({
    newChat: document.querySelector('#new-chat .rail__label').textContent.trim(),
    lang: document.documentElement.lang,
  }));

  await page.selectOption('#language', 'vi');
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => ({
    newChat: document.querySelector('#new-chat .rail__label').textContent.trim(),
    settings: document.querySelector('#open-settings .rail__label').textContent.trim(),
    modelsTab: document.querySelector('.tab[data-tab="models"]').textContent.trim(),
    placeholder: document.getElementById('input').placeholder,
    lang: document.documentElement.lang,
  }));
  check('the sidebar changes language', after.newChat !== before.newChat, `${before.newChat} → ${after.newChat}`);
  check('and it is actually Vietnamese', /Cuộc trò chuyện/.test(after.newChat), after.newChat);
  check('settings label too', /Cài đặt/.test(after.settings), after.settings);
  check('the settings tabs too', /Model/.test(after.modelsTab), after.modelsTab);
  check('and the composer placeholder', /Hỏi bất cứ điều gì/.test(after.placeholder), after.placeholder.slice(0, 40));
  check('the document language is stamped', after.lang === 'vi', after.lang);
  check('no untranslated key leaked through', !/^[a-z]+\.[a-z]+/i.test(after.newChat), after.newChat);

  // It has to survive a reload — that is what "per account" means.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const kept = await page.evaluate(() => ({
    newChat: document.querySelector('#new-chat .rail__label').textContent.trim(),
    lang: document.documentElement.lang,
  }));
  check('the choice survives a reload', /Cuộc trò chuyện/.test(kept.newChat), kept.newChat);
  check('and the stamp with it', kept.lang === 'vi', kept.lang);

  // Back to English so later sections read the labels they expect.
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="behaviour"]');
  await page.waitForTimeout(300);
  await page.selectOption('#language', 'en');
  await page.waitForTimeout(700);
  const restored = await page.evaluate(() => document.querySelector('#new-chat .rail__label').textContent.trim());
  check('and switching back to English works', restored === 'New chat', restored);

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

section('no third-party requests');
{
  // A self-hosted app that announces every page load to a CDN is not
  // self-hosted, and the Content-Security-Policy would block it anyway.
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  check('no external stylesheets', !/<link[^>]+href="https?:\/\//i.test(html));
  check('no external scripts', !/<script[^>]+src="https?:\/\//i.test(html));
  check('no font CDN preconnect', !/fonts\.(googleapis|gstatic)\.com/i.test(html));
}

section('a chosen tab scrolls itself into view');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#open-settings');
  await page.waitForTimeout(500);

  const strip = await page.evaluate(() => {
    const tabs = document.querySelector('#settings .sheet__tabs');
    return { scrolls: tabs.scrollWidth > tabs.clientWidth + 2, left: tabs.scrollLeft };
  });
  check('the tab strip is wider than the sheet', strip.scrolls, 'otherwise there is nothing to prove');
  check('and starts at the left', strip.left < 5, `${strip.left}px`);

  /** Is the tab fully inside the visible part of its strip? */
  const visible = (name) =>
    page.evaluate((tab) => {
      const strip = document.querySelector('#settings .sheet__tabs');
      const el = document.querySelector(`.tab[data-tab="${tab}"]`);
      const s = strip.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return { inside: e.left >= s.left - 1 && e.right <= s.right + 1, scrollLeft: strip.scrollLeft };
    }, name);

  // The last tab is off the right-hand edge to begin with — that is the bug.
  const beforeLast = await visible('admin');
  await page.click('.tab[data-tab="account"]');
  await page.waitForTimeout(600);
  const afterRight = await visible('account');
  check('clicking a tab near the right brings it into view', afterRight.inside, JSON.stringify(afterRight));
  check('by scrolling right', afterRight.scrollLeft > beforeLast.scrollLeft, `${beforeLast.scrollLeft} → ${afterRight.scrollLeft}`);

  // And back the other way.
  await page.click('.tab[data-tab="providers"]');
  await page.waitForTimeout(600);
  const afterLeft = await visible('providers');
  check('and going back scrolls left again', afterLeft.inside && afterLeft.scrollLeft < afterRight.scrollLeft, JSON.stringify(afterLeft));

  /**
   * Arriving at a tab because something else selected it.
   *
   * This is the case from the report: the panel changed and the tab that was now
   * lit sat outside the visible strip, so it looked as though nothing had been
   * chosen. Driven by scrolling the strip away first and then selecting a tab at
   * the other end — which is what a button that jumps to a settings tab does.
   */
  await page.evaluate(() => {
    document.querySelector('#settings .sheet__tabs').scrollLeft = 9999;
  });
  await page.waitForTimeout(200);
  const scrolledAway = await visible('providers');
  check('a tab can start off-screen', !scrolledAway.inside, JSON.stringify(scrolledAway));

  await page.click('.tab[data-tab="providers"]');
  await page.waitForTimeout(600);
  const broughtBack = await visible('providers');
  check('and selecting it brings it back into view', broughtBack.inside, JSON.stringify(broughtBack));

  /**
   * Not merely inside — centred.
   *
   * Scrolling the minimum leaves the tab you picked pinned against the edge it
   * came from, with the neighbours you might pick next still hidden behind it.
   * A tab from the middle of the strip has room to be centred; the ends stay
   * clamped, which is the other half of the rule.
   */
  const offset = (tab) =>
    page.evaluate((name) => {
      const strip = document.querySelector('#settings .sheet__tabs');
      const el = document.querySelector(`.tab[data-tab="${name}"]`);
      const s = strip.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return {
        off: Math.round(e.left + e.width / 2 - (s.left + s.width / 2)),
        atStart: strip.scrollLeft < 2,
        atEnd: strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 2,
      };
    }, tab);

  await page.click('.tab[data-tab="skills"]');
  await page.waitForTimeout(700);
  const centred = await offset('skills');
  const clamped = centred.atStart || centred.atEnd;
  check(
    'a chosen tab is centred, or clamped when the strip is out of room',
    Math.abs(centred.off) < 24 || clamped,
    `${centred.off}px off centre${clamped ? ' (strip at its limit)' : ''}`,
  );

  await page.click('.tab[data-tab="providers"]');
  await page.waitForTimeout(700);
  const first = await offset('providers');
  check('but the first tab stays against its own edge', first.atStart, JSON.stringify(first));
}

section('pairing a computer');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);

  // The control lives in the header now, beside the model and policy chips,
  // because connecting a computer is the thing people do once and cannot find.
  const chip = await page.evaluate(() => {
    const pair = document.getElementById('pair-chip');
    const right = document.querySelector('.topbar__right');
    const order = [...right.children].map((c) => c.id);
    return {
      exists: !!pair,
      label: pair?.textContent.trim(),
      firstInTheRow: order[0] === 'pair-chip',
      order,
    };
  });
  check('there is a Computers chip in the header', chip.exists, chip.label);
  check('ahead of the policy and model chips', chip.firstInTheRow, chip.order.join(', '));
  // This suite runs the app on the machine it works on, so the honest label is
  // "This computer" — there is nothing to pair for this account. What matters is
  // that it says *something* about the state rather than a static word.
  check(
    'and it names the state rather than sitting there inert',
    /this computer|add a computer|computers?$/i.test(chip.label || ''),
    chip.label,
  );

  await page.click('#pair-chip');
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => {
    const d = document.getElementById('pair');
    const box = d.getBoundingClientRect();
    return {
      open: d.open,
      centred: Math.abs(box.left + box.width / 2 - window.innerWidth / 2) < 3,
      hasInput: !!document.getElementById('pair-code'),
      hasButton: !!document.getElementById('pair-submit'),
      hasList: !!document.getElementById('device-list'),
      hasCopy: !!document.getElementById('pair-copy'),
      offerHidden: document.getElementById('pair-offer').hidden,
    };
  });
  check('the chip opens the pairing sheet', sheet.open);
  check('centred', sheet.centred);
  check('with a code box', sheet.hasInput);
  check('a Pair button', sheet.hasButton);
  check('the list of computers', sheet.hasList);
  check('and a copy button for this machine\'s own code', sheet.hasCopy);
  check(
    'the offer is hidden when this machine is not waiting to be added',
    sheet.offerHidden,
    'the test server runs no worker',
  );

  check(
    'the device list has an honest empty state',
    /no computers paired/i.test((await page.textContent('#device-list')) || ''),
    (await page.textContent('#device-list'))?.slice(0, 60),
  );

  // A wrong code has to fail visibly rather than silently.
  await page.fill('#pair-code', 'ZZZZ-ZZZZ');
  await page.click('#pair-submit');
  await page.waitForTimeout(900);
  check(
    'a code nobody is showing says so',
    /not valid|expired|already been used/i.test((await page.textContent('#pair-status')) || ''),
    (await page.textContent('#pair-status'))?.slice(0, 70),
  );

  await page.evaluate(() => document.getElementById('pair').close());
}

section('the manual token path is gone from the interface');
{
  check('no "generate worker token" button', !(await page.$('#gen-worker-token')));
  check('and no token output box', !(await page.$('#worker-token-out')));
  check(
    'the Computers tab points at pairing instead',
    !!(await page.$('#open-pair')),
    'one way in, not two',
  );
}

section('the new-model modal');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(200);

  const shape = await page.evaluate(() => {
    const dialog = document.getElementById('model-news');
    if (!dialog) return null;
    // Fill it the way the app does, then open it and measure.
    document.getElementById('news-title').textContent = 'Claude Fictional 9';
    document.getElementById('news-vendor').textContent = 'Claude';
    document.getElementById('news-id').textContent = 'openrouter/anthropic/claude-fictional-9';
    document.getElementById('news-facts').innerHTML =
      '<dt>Made by</dt><dd>Claude</dd><dt>Released</dt><dd>1 August 2026</dd>' +
      '<dt>Context window</dt><dd>500K tokens</dd><dt>Price</dt><dd>$4 in · $20 out per 1M tokens</dd>';
    document.getElementById('news-description').textContent = 'A model invented by the test suite.';
    dialog.showModal();

    const box = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      // Centred is the whole point: a corner toast is dismissed by reflex.
      centredX: Math.abs(box.left + box.width / 2 - window.innerWidth / 2) < 3,
      centredY: Math.abs(box.top + box.height / 2 - window.innerHeight / 2) < 3,
      onScreen: box.top >= -1 && box.bottom <= window.innerHeight + 1,
      buttons: [...dialog.querySelectorAll('.news__actions button')].map((b) => b.id),
      facts: dialog.querySelectorAll('#news-facts dt').length,
      overflowX: dialog.scrollWidth - dialog.clientWidth,
    };
  });

  check('the modal exists', !!shape);
  check('it opens', shape?.open === true);
  check('centred horizontally', shape?.centredX === true);
  check('centred vertically', shape?.centredY === true);
  check('and fits on screen', shape?.onScreen === true);
  check('with exactly two answers', shape?.buttons.length === 2, (shape?.buttons || []).join(', '));
  check(
    'apply and decline',
    shape?.buttons.includes('news-apply') && shape?.buttons.includes('news-decline'),
    (shape?.buttons || []).join(', '),
  );
  check('the details are spelled out', shape?.facts >= 4, `${shape?.facts} facts`);
  check('and it does not scroll sideways', shape?.overflowX <= 1, `${shape?.overflowX}px`);

  await page.evaluate(() => document.getElementById('model-news').close());
}

section('the change-password form is reachable');
{
  const box = await page.evaluate(() => {
    const el = document.getElementById('password-block');
    return { exists: !!el, hidden: el?.hidden ?? null };
  });
  check('#password-block exists', box.exists);
  check('and is not hidden', box.hidden === false, `hidden=${box.hidden}`);
}

section('the settings sheet');
// Close whatever is open rather than pressing Escape and hoping: more than one
// dialog can be stacked, and a click on the page behind them never lands.
await page.evaluate(() => {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
});
await page.waitForTimeout(300);
await page.click('#open-settings');
await page.waitForTimeout(900);
check('the settings sheet opened', await page.evaluate(() => !!document.getElementById('settings')?.open));
section('the composer row is level');
{
  // The attach button sat visibly high in its circle. It was the character "+":
  // a glyph is centred on the font's maths axis, which is not the middle of the
  // line box, so the box was centred correctly and the ink inside it was not.
  const row = await page.evaluate(() => {
    const centre = (el) => {
      const box = el.getBoundingClientRect();
      return box.height ? box.top + box.height / 2 : null;
    };
    const attach = document.getElementById('attach');
    const send = document.getElementById('send') || document.querySelector('.icon-btn--send');
    const text = document.getElementById('input');
    return {
      drawn: !!attach.querySelector('svg'),
      noGlyph: attach.textContent.trim() === '',
      attach: centre(attach),
      send: send ? centre(send) : null,
      textCentre: centre(text),
      textHeight: text.getBoundingClientRect().height,
      attachHeight: attach.getBoundingClientRect().height,
    };
  });

  check('the plus is drawn, not typed', row.drawn && row.noGlyph, 'a text glyph cannot be centred reliably');
  check('the attach and send buttons share a centre line',
    row.send === null || Math.abs(row.attach - row.send) <= 1, `${row.attach} vs ${row.send}`);
  check('and the writing box is the same height as them',
    Math.abs(row.textHeight - row.attachHeight) <= 1, `${row.textHeight} vs ${row.attachHeight}`);
  check('so the whole row sits on one line',
    Math.abs(row.attach - row.textCentre) <= 1.5, `${row.attach} vs ${row.textCentre}`);
}

section('scrollbars are not part of the furniture');
{
  const quiet = await page.evaluate(() => {
    const thread = document.getElementById('thread');
    // The thumb is a `::-webkit-scrollbar-thumb`, so that is what has to be
    // asked. Reading `scrollbarColor` off the element tested the *other*
    // mechanism — and passed while the visible scrollbar was Chrome's own.
    const before = getComputedStyle(thread, '::-webkit-scrollbar-thumb').backgroundColor;
    thread.dispatchEvent(new Event('scroll'));
    return {
      marked: thread.classList.contains('scroll-quiet'),
      chatsMarked: document.getElementById('chat-list').classList.contains('scroll-quiet'),
      restingColour: before,
      showsWhileScrolling: thread.classList.contains('is-scrolling'),
      // Setting either standard property makes Chromium drop every
      // ::-webkit-scrollbar rule on the element and draw its own Fluent
      // scrollbar instead — steppers and all. Declaring both alongside the
      // pseudo-elements is what put arrow buttons on the transcript.
      standardPropsLeftAlone: getComputedStyle(thread).scrollbarColor === 'auto'
        && getComputedStyle(thread).scrollbarWidth === 'auto',
      steppers: getComputedStyle(thread, '::-webkit-scrollbar-button').display,
    };
  });

  check('the transcript uses the quiet scrollbar', quiet.marked);
  check('and so does the conversation list', quiet.chatsMarked);
  // Computed style resolves `transparent` to rgba(0, 0, 0, 0); both spellings
  // mean the same nothing.
  check(
    'at rest there is no grey trough',
    /transparent|rgba\(0, 0, 0, 0\)/.test(quiet.restingColour),
    quiet.restingColour,
  );
  check('it appears while you are scrolling', quiet.showsWhileScrolling);
  check('and it has no stepper arrows on it', quiet.steppers === 'none', quiet.steppers);
  check(
    'because the styled scrollbar is the one being drawn',
    quiet.standardPropsLeftAlone,
    'scrollbar-color/-width must stay `auto` in Chromium or the custom bar is discarded',
  );

  // And goes again once the scrolling stops — which is what makes it vanish at
  // the end of the transcript rather than sitting there.
  await page.waitForTimeout(900);
  const settled = await page.evaluate(() =>
    document.getElementById('thread').classList.contains('is-scrolling'));
  check('and goes when it stops', !settled);
}

/**
 * An artifact, actually running.
 *
 * Nothing else in this suite proves the feature: the server can serve the right
 * bytes with the right policy and the page can still fail to execute, which is
 * the only thing anybody cares about. So this makes one, opens it, and reads
 * back what its own script wrote into the DOM.
 */
section('artifacts');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  const made = await page.evaluate(async () => {
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { chat } = await res.json();
    return { chat: chat.id };
  });

  // Made through the tool, because that is the path a real turn takes — the
  // browser has no way to create one and should not have.
  const { executeTool } = await import('../server/tools/execute.js');
  const { initStore } = await import('../server/store/index.js');
  const store = await initStore();
  const owner = await store.getUserByEmail('ui@test.local').catch(() => null);

  if (!owner) {
    check('an account to attribute the artifact to', false, 'ui@test.local not found');
  } else {
    const page1 = [
      '<!doctype html><html><body>',
      '<h1 id="out">not run</h1>',
      `<script>document.getElementById("out").textContent = "ran " + (2 + 3);</${'script'}>`,
      '</body></html>',
    ].join('');

    const result = await executeTool({
      user: owner,
      chatId: made.chat,
      name: 'create_file',
      input: { name: 'thu-nghiem', format: 'html', content: page1 },
    });
    check('the assistant can make a page', result.isError === false, result.content?.slice(0, 60));

    // Open it through the shelf, which is the way somebody would find it.
    await page.click('#open-artifacts');
    await page.waitForTimeout(700);

    const listed = await page.evaluate(() => ({
      open: !document.getElementById('page').hidden,
      title: document.getElementById('page-title').textContent.trim(),
      count: document.querySelectorAll('.card--artifact').length,
      first: document.querySelector('.card--artifact .card__name')?.textContent || '',
      peek: document.querySelector('.card__peek')?.textContent?.trim() || '',
    }));
    check('the shelf opens from the menu bar', listed.open && listed.title === 'Artifacts', listed.title);
    check('and lists it', listed.count >= 1 && /thu-nghiem\.html/.test(listed.first), `${listed.count}: ${listed.first}`);
    check(
      'showing a window onto what is in it',
      /doctype|html|out/i.test(listed.peek),
      'a row of identical file icons tells you nothing about which document is which',
    );

    await page.click('.card--artifact');
    await page.waitForTimeout(1200);

    const running = await page.evaluate(() => {
      const frame = document.querySelector('#viewer-body iframe');
      return {
        framed: !!frame,
        sandbox: frame?.getAttribute('sandbox') || '',
        src: frame?.getAttribute('src') || '',
        tabs: [...document.querySelectorAll('#viewer-tabs .fmode')].map((t) => t.getAttribute('aria-label')),
      };
    });
    check('it opens running, not as source', running.framed && /\/run/.test(running.src), running.src);
    check('in a sandbox with no same-origin', /allow-scripts/.test(running.sandbox) && !/allow-same-origin/.test(running.sandbox), running.sandbox);
    check('with its code one press away', running.tabs.includes('Code'), running.tabs.join(', '));

    /*
     * The proof: what the page's own script wrote.
     *
     * Waited for rather than slept on. A fixed pause read the frame before it
     * had finished loading roughly one run in three — which is worse than a
     * failing test, because a suite that fails at random teaches people to
     * re-run it until it is green and then to ignore it when it is not.
     */
    let text = null;
    for (let i = 0; i < 40 && text !== 'ran 5'; i += 1) {
      const frame = page.frames().find((f) => /\/run/.test(f.url()));
      text = frame
        ? await frame.evaluate(() => document.getElementById('out')?.textContent).catch(() => null)
        : null;
      if (text !== 'ran 5') await page.waitForTimeout(150);
    }
    check('and the script inside it actually ran', text === 'ran 5', String(text));

    await page.click('#viewer-close');
    // No dialog to close. Artifacts became a shelf — `#open-artifacts` calls
    // `gotoShelf('artifacts')`, and this section checks `#page` above — but the
    // `<dialog id="artifacts">` it replaced was left in index.html, and this
    // line went on closing it. An already-closed dialog closes silently, so the
    // line passed for as long as the dead markup survived and threw the moment
    // it was removed. Nothing here needs the shelf shut: the checks below read
    // `#settings`, and the next section opens the shelves itself.
    await page.waitForTimeout(200);
  }
}

const settingsScrollers = await page.evaluate(SCROLLERS, '#settings');
check('at most one scrolling region', settingsScrollers.length <= 1, `${settingsScrollers.length} found`);
check('nothing scrolls sideways', !settingsScrollers.some((s) => s.x));

/**
 * The shelves: Projects, Artifacts, Scheduled.
 *
 * Pages rather than dialogs, sharing one header. What this checks is that each
 * one takes the place of the conversation, draws its own tools, and comes back
 * to the transcript when you leave — the three things a page has to do that a
 * sheet did not.
 */
section('the shelves');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  for (const [rail, title, action] of [
    ['#open-projects', 'Projects', 'New project'],
    ['#open-artifacts', 'Artifacts', 'New artifact'],
    ['#open-workflows', 'Workflows', 'New workflow'],
    ['#open-scheduled', 'Scheduled tasks', 'New task'],
  ]) {
    await page.click(rail);
    await page.waitForTimeout(700);

    const shown = await page.evaluate(() => ({
      page: !document.getElementById('page').hidden,
      thread: !document.getElementById('thread').hidden,
      dock: !document.getElementById('dock').hidden,
      title: document.getElementById('page-title').textContent.trim(),
      action: document.getElementById('page-new').textContent.trim(),
      sort: document.getElementById('page-sort').textContent.replace(/\s+/g, ' ').trim(),
      serif: /serif/i.test(getComputedStyle(document.getElementById('page-title')).fontFamily),
    }));

    check(`${title} opens as a page`, shown.page && !shown.thread, JSON.stringify(shown).slice(0, 80));
    check('  with the conversation and its composer out of the way', !shown.dock);
    check('  titled', shown.title === title, shown.title);
    check('  with its own action', shown.action === action, shown.action);
    check('  and a way to order it', shown.sort.length > 0, shown.sort);
    check('  the title is the one serif in the app', shown.serif, 'a shelf is a place you arrive at');
  }

  // The empty states are what somebody sees first, so they have to say
  // something rather than being a blank rectangle.
  const empty = await page.evaluate(() => ({
    ring: !!document.querySelector('.blank__ring'),
    say: document.querySelector('.blank__say')?.textContent || '',
    ideas: document.querySelectorAll('.idea').length,
  }));
  check('an empty shelf explains itself', /No scheduled tasks/.test(empty.say), empty.say);
  check('with something to press', empty.ideas >= 3, `${empty.ideas} suggestions`);
  check('and a mark rather than a bare space', empty.ring);

  // Every suggestion has to be a thing this application can really do.
  const ideas = await page.evaluate(() =>
    [...document.querySelectorAll('.idea__name')].map((n) => n.textContent.trim()),
  );
  check(
    'the suggestions are this app\'s, not a screenshot of somebody else\'s',
    !ideas.some((name) => /inbox|calendar|meeting/i.test(name)),
    ideas.join(', '),
  );

  // Manual setup opens the form from the screenshot.
  await page.click('#page-new');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => ({
    open: !document.getElementById('page-new-menu').hidden,
    items: [...document.querySelectorAll('#page-new-menu button')].map((b) => b.textContent.trim()),
  }));
  check('New task offers both ways in', menu.open && menu.items.length === 2, menu.items.join(' / '));

  await page.click('#page-new-menu button:last-child');
  await page.waitForTimeout(500);
  const form = await page.evaluate(() => ({
    open: document.getElementById('task-form').open,
    fields: ['task-form-name', 'task-form-prompt', 'task-form-when', 'task-form-repeat'].every((id) =>
      document.getElementById(id),
    ),
  }));
  check('and the form opens with what it needs', form.open && form.fields);
  await page.evaluate(() => document.getElementById('task-form').close());

  // A suggestion fills the form in rather than making an empty one.
  await page.click('.idea');
  await page.waitForTimeout(500);
  const filled = await page.evaluate(() => ({
    name: document.getElementById('task-form-name').value,
    prompt: document.getElementById('task-form-prompt').value.length,
  }));
  check('a suggestion arrives filled in', filled.name.length > 0 && filled.prompt > 40, `${filled.name}, ${filled.prompt} chars`);
  await page.evaluate(() => document.getElementById('task-form').close());

  // And back to the conversation.
  await page.click('#new-chat');
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({
    page: !document.getElementById('page').hidden,
    thread: !document.getElementById('thread').hidden,
  }));
  check('starting a chat leaves the shelf', !back.page && back.thread, JSON.stringify(back));
}

/**
 * Searching a shelf, and the ⋮ on one of its cards.
 *
 * The search bug was two affordances at once: a round magnifier with nothing
 * left to do, sitting beside a box that read as a second, different search.
 * Pressing the icon has to *become* the field and clearing has to give it back.
 */
section('a workflow shows the state of every step');
{
  /*
   * The reason this screen exists. A scheduled task reports one status line for
   * a job with four parts, so "it didn't arrive" has no answer; a workflow has
   * to name the step that stopped. Checked in the real DOM because the whole
   * value is in what is on screen.
   */
  const made = await page.evaluate(async () => {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Monday sales pack',
        steps: ['Pull last week numbers', 'Chart them', 'Email the team'],
      }),
    });
    return { status: res.status, body: await res.json() };
  });
  check('a workflow can be created', made.status === 201, `${made.status}`);

  await page.click('#open-workflows');
  await page.waitForTimeout(700);

  const shelf = await page.evaluate(() => {
    const card = document.querySelector('.wf');
    const steps = [...document.querySelectorAll('.wf__step')];
    return {
      cards: document.querySelectorAll('.wf').length,
      name: card?.querySelector('.wf__name')?.textContent.trim() || '',
      when: card?.querySelector('.wf__when')?.textContent.replace(/\s+/g, ' ').trim() || '',
      steps: steps.length,
      first: steps[0]?.querySelector('.wf__step-text')?.textContent.replace(/\s+/g, ' ').trim() || '',
      marks: steps.every((s) => (s.querySelector('.wf__step-mark')?.textContent || '').trim().length > 0),
      words: steps.every((s) => /waiting|running|done|failed|interrupted/.test(s.textContent)),
      acts: [...(card?.querySelectorAll('.wf__acts button') || [])].map((b) => b.textContent.trim()),
    };
  });

  check('the shelf shows it', shelf.cards === 1, `${shelf.cards} cards`);
  check('  named', shelf.name === 'Monday sales pack', shelf.name);
  check('  and says it runs on demand', /press it/.test(shelf.when), shelf.when);
  check('  every step is drawn', shelf.steps === 3, `${shelf.steps}`);
  check('  in the order they were written', /Pull last week numbers/.test(shelf.first), shelf.first);
  // Colour alone would leave the state unreadable to anyone who cannot separate
  // the red one from the green one, so each step carries a mark and a word.
  check('  each carries a mark, not only a colour', shelf.marks);
  check('  and says its state in words', shelf.words);
  check('  with the actions a person needs', shelf.acts.includes('Run now') && shelf.acts.includes('Edit'), shelf.acts.join(','));

  const sheet = await page.evaluate(() => {
    document.querySelector('[data-edit]')?.click();
    return true;
  });
  await page.waitForTimeout(500);
  const form = await page.evaluate(() => ({
    open: !!document.getElementById('workflow-form')?.open,
    title: document.getElementById('workflow-form-title')?.textContent.trim() || '',
    steps: document.getElementById('workflow-form-steps')?.value || '',
  }));
  check('editing opens the sheet', sheet && form.open, JSON.stringify(form).slice(0, 60));
  check('  titled as an edit', form.title === 'Edit workflow', form.title);
  check('  with one step per line, ready to reorder', form.steps.split('\n').length === 3, JSON.stringify(form.steps));

  await page.evaluate(() => document.getElementById('workflow-form')?.close());
}

section('a shelf is searched from one field, not two');
{
  await page.click('#open-projects');
  await page.waitForTimeout(800);

  const shut = await page.evaluate(() => ({
    icon: !document.getElementById('page-search-open').hidden,
    field: !document.getElementById('page-search-box').hidden,
  }));
  check('the magnifier is what you see first', shut.icon && !shut.field, JSON.stringify(shut));

  await page.click('#page-search-open');
  await page.waitForTimeout(300);
  const openState = await page.evaluate(() => {
    const box = document.getElementById('page-search-box');
    const at = box.getBoundingClientRect();
    return {
      icon: !document.getElementById('page-search-open').hidden,
      field: !box.hidden,
      focused: document.activeElement === document.getElementById('page-search'),
      mark: !!box.querySelector('.find__mark'),
      clear: !!box.querySelector('.find__clear'),
      // Inside the row, not overflowing it — the misalignment in the report.
      inside: at.right <= document.getElementById('page').getBoundingClientRect().right + 1,
      placeholder: document.getElementById('page-search').placeholder,
    };
  });
  check('pressing it replaces it with the field', openState.field && !openState.icon, JSON.stringify(openState));
  check('  which is already focused', openState.focused);
  check('  carries the magnifier inside it', openState.mark);
  check('  and a way to clear it', openState.clear);
  check('  sits inside the header row', openState.inside);
  check('  and says what it searches', /projects/i.test(openState.placeholder), openState.placeholder);

  await page.fill('#page-search', 'zzzz-nothing-matches');
  await page.waitForTimeout(300);
  check(
    'typing filters the shelf',
    /No project matches/.test(await page.evaluate(() => document.getElementById('page-body').textContent)),
  );

  await page.click('#page-search-clear');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    icon: !document.getElementById('page-search-open').hidden,
    field: !document.getElementById('page-search-box').hidden,
    cards: document.querySelectorAll('[data-project]').length,
  }));
  check('clearing gives the magnifier back', closed.icon && !closed.field, JSON.stringify(closed));
  check('and the shelf with it', closed.cards >= 1, `${closed.cards} cards`);

  // The ⋮ on a card. Hidden until the card is under the pointer, because a menu
  // button on every card is furniture on a shelf made for scanning.
  const resting = await page.evaluate(() => {
    const more = document.querySelector('[data-more]');
    return { exists: !!more, colour: getComputedStyle(more).color };
  });
  check('every card carries a ⋮', resting.exists);
  check('  invisible until wanted', /rgba\(0, 0, 0, 0\)|transparent/.test(resting.colour), resting.colour);

  await page.hover('[data-project]');
  await page.waitForTimeout(200);
  const hovered = await page.evaluate(() => getComputedStyle(document.querySelector('[data-more]')).color);
  check('  and there on hover', !/rgba\(0, 0, 0, 0\)|transparent/.test(hovered), hovered);

  await page.click('[data-more]');
  await page.waitForTimeout(300);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.cardmenu button')].map((b) => b.dataset.label),
  );
  check('it offers Pin', items.includes('Pin'), items.join(' / '));
  check('  Edit details', items.includes('Edit details'));
  check('  Archive', items.includes('Archive'));
  check('  and Delete', items.includes('Delete'));
  check(
    '  with Delete set apart',
    await page.evaluate(() => !!document.querySelector('.cardmenu button.is-danger') && !!document.querySelector('.cardmenu hr')),
  );
  check(
    '  and the menu clear of its card',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cardmenu')).position === 'fixed'),
    'absolute inside a card gets clipped by it',
  );

  // Pinning, and what a pin is for: first place, whatever the ordering.
  await page.click('.cardmenu [data-label="Pin"]');
  await page.waitForTimeout(900);
  check(
    'pinning marks the card',
    await page.evaluate(() => !!document.querySelector('.card__pin')),
  );
  check(
    'and pins it to the front',
    await page.evaluate(
      () => document.querySelectorAll('[data-project]')[0]?.querySelector('.card__pin') !== null,
    ),
  );

  // Archiving takes it off this shelf and puts it on the other one.
  const before = await page.evaluate(() => document.querySelectorAll('[data-project]').length);
  await page.hover('[data-project]');
  await page.click('[data-more]');
  await page.waitForTimeout(300);
  await page.click('.cardmenu [data-label="Archive"]');
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => document.querySelectorAll('[data-project]').length);
  check('archiving takes it off the shelf', after === before - 1, `${before} → ${after}`);

  await page.click('#page-sort');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    [...document.querySelectorAll('#page-sort-menu button')].find((b) => /Archived/.test(b.textContent)).click();
  });
  await page.waitForTimeout(900);
  const archived = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-project]').length,
    pill: document.getElementById('page-sort').textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('and onto the archived one', archived.cards === 1, `${archived.cards}`);
  check('  which says so rather than "Sort by Archived"', archived.pill === 'Archived', archived.pill);

  // Put it back, so the rest of the run sees the shelf it expects.
  await page.hover('[data-project]');
  await page.click('[data-more]');
  await page.waitForTimeout(300);
  await page.click('.cardmenu [data-label="Restore"]');
  await page.waitForTimeout(900);
  check(
    'an archived project can come back',
    await page.evaluate(() => document.querySelectorAll('[data-project]').length === 0),
    'it left the archived shelf',
  );
}

/**
 * The workspace, edited by hand.
 *
 * The routes are covered elsewhere; what this proves is the part no route test
 * can — that somebody can open the folder in the interface, click into it, type
 * into a file and have the bytes on disk change.
 */
section('the workspace file browser');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  await page.click('#open-workspace');
  await page.waitForTimeout(900);

  const listed = await page.evaluate(() => ({
    open: document.getElementById('workspace').open,
    where: document.getElementById('workspace-where').textContent,
    names: [...document.querySelectorAll('.entry__name')].map((n) => n.textContent.trim()),
  }));
  check('it opens from the menu bar', listed.open);
  check('and says which folder it is showing', /ai-remote-ui-workspace/.test(listed.where), listed.where);
  check('listing what is in it, folders first', listed.names[0] === 'src', listed.names.join(', '));

  // Into the folder and back out, through the breadcrumb.
  await page.click('[data-open-dir$="src"]');
  await page.waitForTimeout(600);
  const inside = await page.evaluate(() => document.querySelectorAll('.entry--up').length);
  check('a folder opens, with a way back up', inside === 1, String(inside));
  await page.click('.crumbs__step');
  await page.waitForTimeout(600);

  await page.click('[data-open-file$="readme.md"]');
  await page.waitForTimeout(700);

  const opened = await page.evaluate(() => ({
    editor: !!document.getElementById('workspace-editor'),
    content: document.getElementById('workspace-editor')?.value || '',
  }));
  check('a file opens in an editor', opened.editor);
  check('with its real contents', /Ghi chú/.test(opened.content), opened.content.slice(0, 30));

  await page.fill('#workspace-editor', '# Đã sửa trong trình duyệt\n');
  await page.click('#workspace-save');
  await page.waitForTimeout(900);

  const onDisk = fs.readFileSync(path.join(process.env.WORKSPACE, 'readme.md'), 'utf8');
  check('saving writes the file on the machine', /Đã sửa trong trình duyệt/.test(onDisk), onDisk.slice(0, 40));
  check(
    'and the accents survive the round trip',
    onDisk.includes('Đã sửa'),
    'the one thing a text editor must not get wrong',
  );

  await page.evaluate(() => document.getElementById('workspace').close());
  await page.waitForTimeout(200);
}

/**
 * Full screen has to actually be full screen.
 *
 * `position: fixed` escapes overflow but not a stacking context, and the panel
 * lives inside the detail rail, which has one — so "full screen" was drawn
 * underneath the sidebar, and disappeared altogether when the rail was closed,
 * because a closed rail hides its contents.
 */
section('the sandbox, full screen');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    document.getElementById('screen').hidden = false;
  });
  await page.waitForTimeout(200);

  await page.click('#screen-expand');
  await page.waitForTimeout(400);

  const full = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    const box = panel.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const middle = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    // Whatever is drawn where the sidebar sits: the panel, or the sidebar
    // through it.
    const overSidebar = sidebar
      ? document.elementFromPoint(sidebar.left + sidebar.width / 2, sidebar.top + sidebar.height / 2)
      : null;
    return {
      parent: panel.parentElement?.tagName,
      covers: box.width === window.innerWidth && box.height === window.innerHeight,
      onTopInMiddle: !!middle && panel.contains(middle),
      onTopOverSidebar: !!overSidebar && panel.contains(overSidebar),
    };
  });

  check('it leaves the rail it normally lives in', full.parent === 'BODY', full.parent);
  check('and covers the whole window', full.covers);
  check('nothing is drawn over the middle of it', full.onTopInMiddle);
  check('not even the sidebar', full.onTopOverSidebar, 'the bug: the rail is a stacking context, so z-index lost');

  // And back, into exactly the place it came from.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    return {
      parent: panel.parentElement?.className || '',
      expanded: panel.classList.contains('is-expanded'),
    };
  });
  check('Escape brings it back', !back.expanded);
  check('to the rail it came from', /detail__body/.test(back.parent), back.parent);

  await page.evaluate(() => {
    document.getElementById('screen').hidden = true;
  });
}

/**
 * Opening a document without leaving the conversation.
 *
 * The thing being proved is that a Word file and a spreadsheet — neither of
 * which a browser can render — arrive on screen as a page and as a grid. The
 * files are built here rather than kept as fixtures, so the writer and the
 * reader are both under test and nobody has to diff a binary.
 */
section('the file viewer');
{
  const { writeDocx } = await import('../server/office/docx.js');
  const { writeXlsx } = await import('../server/office/xlsx.js');
  const { markdownToBlocks } = await import('../server/office/markdown.js');
  const { MIME_FOR } = await import('../server/office/index.js');

  const docx = writeDocx({
    blocks: markdownToBlocks('# Biên bản họp\n\nNội dung **quan trọng**.\n\n- Điểm một\n- Điểm hai'),
    title: 'Biên bản',
  }).toString('base64');
  const xlsx = writeXlsx({
    sheets: [{ name: 'Chi phí', rows: [['Hạng mục', 'Số tiền'], ['Vận chuyển', 1250000]] }],
  }).toString('base64');

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  // Straight through the API: the composer's file picker cannot be driven
  // without a real file on disk, and what is being tested is downstream of it.
  const made = await page.evaluate(
    async ([word, sheet, wordMime, sheetMime]) => {
      const post = async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return res.json();
      };
      const a = await post('/api/attachments', { name: 'bien-ban.docx', mime: wordMime, data: word });
      const b = await post('/api/attachments', { name: 'chi-phi.xlsx', mime: sheetMime, data: sheet });
      const { chat } = await post('/api/chats', {});
      await post(`/api/chats/${chat.id}/messages`, {
        text: 'xem giúp hai file này',
        attachments: [a.attachment.id, b.attachment.id],
      });
      return { chat: chat.id, kinds: [a.attachment.kind, b.attachment.kind] };
    },
    [docx, xlsx, MIME_FOR.docx, MIME_FOR.xlsx],
  );
  check('both files upload as office documents', made.kinds.join(',') === 'office,office', made.kinds.join(','));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.click('.chat-row');
  await page.waitForTimeout(700);

  const chips = await page.$$('.bubble__file');
  check('each file is a chip in the bubble', chips.length === 2, `${chips.length} found`);
  check(
    'and the chips are buttons, because they open',
    await page.$eval('.bubble__file', (el) => el.tagName === 'BUTTON'),
  );

  await chips[0].click();
  await page.waitForTimeout(900);
  const word = await page.evaluate(() => {
    const pane = document.getElementById('filepane');
    const box = pane.getBoundingClientRect();
    const thread = document.getElementById('thread').getBoundingClientRect();
    return {
      open: !pane.hidden,
      // Beside the conversation, not over it: the whole point of the change.
      besideIt: box.left >= thread.right - 2 && thread.width > 100,
      railOpen: document.getElementById('app').classList.contains('is-detail'),
      planHidden: !document.querySelector('#progress-steps')?.getClientRects().length,
      title: document.getElementById('viewer-title').textContent,
      kind: document.getElementById('viewer-kind').textContent,
      heading: document.querySelector('#viewer-body .doc h1')?.textContent || '',
      bold: !!document.querySelector('#viewer-body .doc strong'),
      items: document.querySelectorAll('#viewer-body .doc li').length,
    };
  });
  check('clicking one opens the panel', word.open);
  check('beside the conversation, not over it', word.besideIt, JSON.stringify(word).slice(0, 110));
  check('opening the rail if it was shut', word.railOpen);
  check('and standing the plan down while it is there', word.planHidden, 'two things in a 380px column is neither');
  check('titled with the filename', word.title === 'bien-ban.docx', word.title);
  check('with what it is beside the name', /DOCX/.test(word.kind), word.kind);
  check('the Word document is drawn as a page', word.heading === 'Biên bản họp', word.heading);
  check('with its formatting', word.bold && word.items === 2, `${word.items} list items`);

  // Full size, and the bug that made it worth testing: the rail has a
  // transform, so a `fixed` child of it is positioned against the rail rather
  // than the window and drew underneath the sidebar.
  await page.click('#viewer-expand');
  await page.waitForTimeout(300);
  const full = await page.evaluate(() => {
    const pane = document.getElementById('filepane');
    const box = pane.getBoundingClientRect();
    const mid = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return {
      parent: pane.parentElement.tagName,
      covers: box.width >= window.innerWidth - 1 && box.height >= window.innerHeight - 1,
      onTop: pane.contains(mid),
      overSidebar: pane.contains(document.elementFromPoint(40, window.innerHeight / 2)),
    };
  });
  check('⤢ gives it the whole window', full.covers, JSON.stringify(full));
  check('  by leaving the rail it lives in', full.parent === 'BODY');
  check('  with nothing drawn over it', full.onTop);
  check('  not even the sidebar', full.overSidebar, 'the rail is a stacking context, so z-index alone loses');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(
    'Escape brings it back to the rail',
    await page.evaluate(() => {
      const pane = document.getElementById('filepane');
      return !pane.hidden && pane.parentElement.tagName !== 'BODY';
    }),
  );

  await page.click('#viewer-close');
  await page.waitForTimeout(300);
  check(
    'closing it lets go of the document',
    await page.evaluate(
      () =>
        document.getElementById('filepane').hidden &&
        document.getElementById('viewer-body').children.length === 0,
    ),
  );
  check(
    'and gives the rail back to the plan',
    await page.evaluate(() => !document.getElementById('app').classList.contains('is-filepane')),
  );

  (await page.$$('.bubble__file'))[1].click();
  await page.waitForTimeout(900);
  const sheet = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#viewer-body .grid td')].map((td) => td.textContent);
    return {
      grid: !!document.querySelector('#viewer-body .grid'),
      columns: [...document.querySelectorAll('#viewer-body .grid thead th')].map((th) => th.textContent),
      cells,
      numberAligned: !!document.querySelector('#viewer-body .grid td.is-number'),
      action: document.getElementById('viewer-do').textContent.trim(),
    };
  });
  check('a spreadsheet is drawn as a grid', sheet.grid);
  check('with column letters', sheet.columns.join('') === 'AB', sheet.columns.join(''));
  check('the values in it', sheet.cells.includes('Vận chuyển') && sheet.cells.includes('1250000'), sheet.cells.join('|'));
  check('numbers set apart from text', sheet.numberAligned);

  /**
   * The one button, and the arrow beside it.
   *
   * What the button says depends on the machine on the other end: this app runs
   * its worker tools in-process when it is a local install, so on a desktop
   * with Excel installed the button really does say "Open in Excel" — resolved
   * from the file association, not guessed from the extension.
   *
   * The check is that the button and the machine agree. Asserting a fixed
   * label would only prove which software the test runner happens to have.
   */
  const opener = await page.evaluate(async () => {
    // The id from the chip that was just clicked. /api/files lists what the
    // assistant made, and these two were uploaded.
    const id = [...document.querySelectorAll('.bubble__file')][1].dataset.file;
    return (await fetch(`/api/attachments/${id}/opener`)).json();
  });
  check(
    'the button offers what this machine can actually do',
    opener.launchable ? /^Open/.test(sheet.action) : sheet.action === 'Download',
    `${sheet.action} — launchable: ${opener.launchable}, app: ${opener.app}`,
  );
  check(
    '  naming the application when it can be resolved',
    !opener.app || sheet.action === `Open in ${opener.app}`,
    sheet.action,
  );

  await page.click('#viewer-more');
  await page.waitForTimeout(300);
  const more = await page.evaluate(() =>
    [...document.querySelectorAll('.cardmenu button')].map((b) => b.dataset.label),
  );
  check('and something to print, which is how a PDF gets made', more.some((l) => /Print/.test(l)), more.join(' / '));
  check('  a way to reveal it on the disk', more.includes('Show in folder'), more.join(' / '));
  check('  and the download it is no longer leading with', more.includes('Download'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const scrollers = await page.evaluate(SCROLLERS, '#filepane');
  check('one scrolling region inside the viewer', scrollers.length <= 1, `${scrollers.length} found`);

  /**
   * What a print — and therefore a Save as PDF — actually contains.
   *
   * There is no PDF writer on the server, so this is the road to one, and it is
   * only a road if the page that comes out is the document rather than the
   * application around it. Checked by emulating print media, which is as close
   * as a test can get to the print dialog.
   */
  // Printing expands the panel first, because the print rules isolate a child
  // of <body> and the panel normally lives three levels down in the rail.
  await page.evaluate(() => {
    document.getElementById('viewer-expand').click();
    document.body.classList.add('is-printing');
  });
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  const printed = await page.evaluate(() => {
    // Asked as "is it laid out", not "what is its display" — a computed style
    // is the element's own, and reports `flex` quite happily from inside an
    // ancestor that is `display: none`.
    const shown = (selector) => {
      const el = document.querySelector(selector);
      return !!el && el.getClientRects().length > 0;
    };
    return {
      document: shown('#viewer-body'),
      sidebar: shown('.sidebar'),
      composer: shown('.composer'),
      chrome: shown('#filepane .filepane__bar'),
      background: getComputedStyle(document.getElementById('filepane')).backgroundColor,
    };
  });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => document.body.classList.remove('is-printing'));

  check('printing keeps the document', printed.document);
  check('and leaves the app behind', !printed.sidebar && !printed.composer, JSON.stringify(printed));
  check('including the viewer\'s own buttons', !printed.chrome);
  check('on white, not on the dark theme', /255, 255, 255/.test(printed.background), printed.background);

  /**
   * The bug that made Save as PDF useless: page one and nothing else.
   *
   * An expanded panel is `position: fixed` with `height: 100dvh` — pinned to
   * the viewport, and a viewport is one page. Everything after the first
   * screenful was silently dropped, and every `overflow` in the chain clipped
   * whatever was left. Measured rather than eyeballed: the panel must be
   * static, and it must be as tall as its contents.
   */
  await page.evaluate(() => document.body.classList.add('is-printing'));
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  const layout = await page.evaluate(() => {
    const pane = document.getElementById('filepane');
    const body = document.getElementById('viewer-body');
    const style = getComputedStyle(pane);
    return {
      position: style.position,
      overflow: getComputedStyle(body).overflowY,
      // How tall the panel is against how tall its contents are. Clipped to the
      // window, the first is a screenful and the second is the document.
      paneHeight: Math.round(pane.getBoundingClientRect().height),
      contentHeight: body.scrollHeight,
      viewport: window.innerHeight,
    };
  });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => document.body.classList.remove('is-printing'));

  check('the panel is not pinned to one screen', layout.position === 'static', layout.position);
  check('  nor clipping what did not fit', layout.overflow === 'visible', layout.overflow);
  check(
    '  so every page of a long document prints',
    layout.paneHeight >= layout.contentHeight - 4,
    `panel ${layout.paneHeight}px vs content ${layout.contentHeight}px (window ${layout.viewport}px)`,
  );

  await page.click('#viewer-close');
  await page.waitForTimeout(200);
}

/**
 * A document the assistant makes opens itself.
 *
 * The rules that decide it are unit-tested in test/autopreview.test.mjs, where
 * they can be stated one at a time. What only a browser can show is that the
 * setting is really on the page, really saved, and really read back — and that
 * the wiring between the stream and the panel has not been quietly removed,
 * which is checked against the source rather than by faking a model turn.
 */
section('a new document opens itself');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  await page.click('#open-settings');
  await page.waitForTimeout(500);

  const setting = await page.evaluate(() => {
    const el = document.getElementById('auto-preview');
    return {
      there: !!el,
      value: el?.value,
      options: [...(el?.options || [])].map((o) => o.value),
      label: document.querySelector('label[for="auto-preview"]')?.textContent?.trim(),
    };
  });
  check('there is a setting for it', setting.there);
  check('  on by default', setting.value === 'on', setting.value);
  check('  with a way to turn it off', setting.options.join(',') === 'on,off', setting.options.join(','));
  check('  named for what it governs', /document/i.test(setting.label || ''), setting.label);

  const off = await page.evaluate(async () => {
    document.getElementById('auto-preview').value = 'off';
    document.getElementById('save-behaviour').click();
    await new Promise((r) => setTimeout(r, 800));
    return (await (await fetch('/api/bootstrap')).json()).prefs.autoPreview;
  });
  check('  turning it off is saved to the account', off === false, String(off));

  const on = await page.evaluate(async () => {
    document.getElementById('auto-preview').value = 'on';
    document.getElementById('save-behaviour').click();
    await new Promise((r) => setTimeout(r, 800));
    return (await (await fetch('/api/bootstrap')).json()).prefs.autoPreview;
  });
  check('  and turning it back on is too', on === true, String(on));

  await page.evaluate(() => document.getElementById('settings').close());
  await page.waitForTimeout(200);

  /**
   * The wiring, read rather than driven.
   *
   * Driving it would mean standing up a fake model to produce a real turn, or
   * exporting a hook from app.js for the test to call — one is a second HTTP
   * server's worth of machinery, the other is production code that exists only
   * for a test. Both are worse than asserting that the three lines connecting
   * the stream to the panel are still there.
   */
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  check(
    'a file arriving from the stream is offered to the panel',
    /noteFile\(result\.file\)/.test(app) && /function noteFile[\s\S]{0,400}offerPreview\(file\)/.test(app),
    'tool_result → noteFile → offerPreview',
  );
  check(
    '  the decision goes through the tested policy',
    /shouldAutoPreview\(previewConditions\(/.test(app),
    'so the rules cannot drift away from test/autopreview.test.mjs',
  );
  check(
    '  and every turn starts with a clean slate',
    /setRunning\(true\);[\s\S]{0,200}resetAutoPreview\(\)/.test(app),
    'otherwise closing it once would silence it forever',
  );
  check(
    '  while a rewrite refreshes what is open instead of popping',
    /viewer\.showing\(\) === file\.id[\s\S]{0,200}viewer\.reopen\(\)/.test(app),
  );
}

/**
 * The guide is shown once, and "once" means once — not once per completion.
 *
 * It used to be recorded as seen only when it was *finished*, so reloading the page
 * halfway, or closing the tab and coming back, meant it had never finished and it
 * opened again. That is exactly the complaint: it reappears on a later visit to an
 * account that has already been set up.
 *
 * Now it is marked the moment it opens. This checks the case that was broken:
 * reload while it is on screen, having pressed nothing at all.
 */
section('the guide does not come back after a mid-way reload');
{
  // A second account, because the first has already answered and cannot be asked
  // again — and this is a claim about the first sight of it.
  await page.evaluate(() => document.getElementById('logout')?.click());
  await page.waitForTimeout(1200);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  await page.click('#gate-switch').catch(() => {});
  await page.waitForTimeout(400);
  await page.fill('#gate-name', 'Người mới');
  await page.fill('#gate-email', 'nguoi-moi@example.com');
  await page.fill('#gate-password', 'mot-mat-khau-dai');
  await page.click('#gate-submit');
  await page.waitForTimeout(2600);

  check('the new account is shown the guide', !!(await page.$('#onboarding[open]')));

  // Reload with the guide still open and nothing pressed. This is the case that
  // used to bring it back.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  check('and after a reload it is gone', !(await page.$('#onboarding[open]')));
  check('the app is usable', await page.isVisible('#model-chip'));

  // Once more, because "gone" has to keep meaning gone.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);
  check('and still gone on the visit after that', !(await page.$('#onboarding[open]')));

  // But it is still reachable on purpose — dismissed is not deleted.
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="behaviour"]');
  await page.waitForTimeout(300);
  await page.click('#open-onboarding');
  await page.waitForTimeout(600);
  check('and can still be opened deliberately', !!(await page.$('#onboarding[open]')));
  await page.click('#onb-skip');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

/**
 * A run of steps, drawn the way somebody reads it.
 *
 * Exercised in a real browser because that is the only honest way to check DOM
 * that is built by hand: the module is imported into the live page and driven
 * directly, so what is asserted is what would actually be on screen.
 *
 * Every check here is a mistake that is easy to make and invisible in review —
 * a run that never collapses keeps a spinner forever; a run that swallows the
 * prose between two activities claims a structure the turn does not have.
 */
section('a run of browser steps reads as one piece of work');
{
  const run = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.body.append(turn.node);

    const step = (name, input, result) => turn.startTool({ id: name, name, input }).complete(result);

    step('browser_open', { url: 'https://vercel.com/dashboard' }, { content: 'ok', ms: 900 });
    step('browser_click', { ref: 7, description: 'Deploy' }, { content: 'ok', ms: 120 });
    step('browser_wait', { seconds: 3 }, { content: 'ok', ms: 3000 });

    const card = turn.node.querySelector('.steps');
    const first = card.querySelector('.step');

    const snapshot = {
      grouped: turn.node.querySelectorAll('.steps').length,
      steps: card.querySelectorAll('.step').length,
      title: card.querySelector('.steps__title').textContent,
      tally: card.querySelector('.steps__tally').textContent,
      firstVerb: first.querySelector('.step__verb').textContent,
      firstDetail: first.querySelector('.step__detail').textContent,
      openWhileWorking: card.open,
      // A raw tool name anywhere in the summary means a verb is missing.
      noRawNames: !/browser_/.test(card.querySelector('summary').textContent),
    };

    // Prose is the boundary between two activities. Steps after it belong to a
    // new run, and the old one is finished.
    turn.appendText('Deployed it.');
    step('browser_look', {}, { content: 'ok', ms: 40 });

    snapshot.afterProse = turn.node.querySelectorAll('.steps').length;
    snapshot.firstCollapsed = !card.open;
    snapshot.firstSpinnerGone = !card.querySelector('.spinner');

    // A tool from outside the family also ends the run — `read_file` between two
    // browser actions really is a change of activity.
    step('read_file', { path: 'a.txt' }, { content: 'ok', ms: 10 });
    snapshot.afterOutsider = turn.node.querySelectorAll('.steps').length;
    snapshot.plainToolStillACard = turn.node.querySelectorAll('.tool').length;

    turn.finish();
    snapshot.allCollapsed = [...turn.node.querySelectorAll('.steps')].every((n) => !n.open);
    snapshot.noSpinnersLeft = turn.node.querySelectorAll('.steps .spinner').length === 0;

    turn.node.remove();
    return snapshot;
  });

  check('three browser calls make one card', run.grouped === 1, `${run.grouped}`);
  check('holding all three steps', run.steps === 3, `${run.steps}`);
  check('labelled as a run', /browser|trình duyệt/i.test(run.title), run.title);
  check('with a count', /3/.test(run.tally), run.tally);
  check('and no raw tool names in it', run.noRawNames);
  check('the first step reads as a sentence', !!run.firstVerb && !/_/.test(run.firstVerb), run.firstVerb);
  check('naming what it acted on', run.firstDetail === 'vercel.com/dashboard', run.firstDetail);
  check('the run is open while it works', run.openWhileWorking === true);

  check('prose starts a new run', run.afterProse === 2, `${run.afterProse}`);
  check('and collapses the finished one', run.firstCollapsed === true);
  check('taking its spinner with it', run.firstSpinnerGone === true);

  check('a tool from outside the family ends the run too', run.afterOutsider === 2, `${run.afterOutsider}`);
  check('and is still drawn as its own card', run.plainToolStillACard === 1, `${run.plainToolStillACard}`);

  check('finishing the turn closes everything', run.allCollapsed === true);
  check('and leaves nothing spinning', run.noSpinnersLeft === true);
}

await browser.close();
server.close();
removeTemp(process.env.DATA_DIR);

realLog(
  failures
    ? `\n\x1b[31m${failures} interface check(s) failed.\x1b[0m\n`
    : '\n\x1b[32mAll interface checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
