/**
 * The browser sandbox — a real browser the assistant drives, and the user
 * watches live.
 *
 * Two decisions worth knowing about:
 *
 * **It steers by element reference, not pixels.** Every action is preceded by a
 * numbered snapshot of what is on screen, and the model clicks "7", not a
 * coordinate. Text models are poor at reading pixel positions out of a
 * screenshot and good at picking from a list, so this is far more reliable —
 * and it degrades gracefully when a page shifts under it.
 *
 * **The screenshot is for the human, not the model.** The model reads the
 * snapshot; the frames exist so the user can see exactly what is happening and
 * step in. What they watch really is the same page the assistant is acting on.
 */

const VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT = 45_000;

import { claim, publishFrame, release, watcherPreference } from './screen.js';

let browser = null;
let context = null;
let page = null;
let screencast = null;

export const browserIsOpen = () => !!page && !page.isClosed();

async function launch() {
  const { chromium } = await import('playwright-core');

  // Use a browser the user already has rather than downloading 400MB. Chrome
  // first, then Edge, then whatever Playwright bundled if someone installed it.
  const attempts = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    {},
  ];

  /**
   * Headed by default, and unmuted.
   *
   * Headless Chrome has no audio device at all — a video "playing" in it is a
   * silent series of frames, which is exactly the complaint. Sound needs a real
   * window, so that is the default now. Be clear about where the sound comes
   * out: the speakers of the machine running the worker, not the browser tab
   * you are watching from. Streaming audio to a remote viewer would need a
   * WebRTC pipeline that does not exist here.
   */
  const headless = /^(1|true|yes)$/i.test(process.env.BROWSER_HEADLESS ?? 'false');
  const args = [
    '--disable-blink-features=AutomationControlled',
    // Without this a clicked video sits on its first frame: Chrome's autoplay
    // policy does not count an automation click as a user gesture.
    '--autoplay-policy=no-user-gesture-required',
    // A window nobody is looking at gets its timers throttled and its frames
    // stopped, which is exactly wrong here — nobody is looking at it *on the
    // desktop*, but someone is watching every frame through the panel.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  // Muting a headless browser changes nothing, so this only really applies to
  // a headed one — where someone might genuinely not want the noise.
  if (headless || /^(1|true|yes)$/i.test(process.env.BROWSER_MUTE ?? '')) args.push('--mute-audio');

  /**
   * Parked off the edge of the desktop, not hidden.
   *
   * The window has to exist for there to be an audio device and a compositor,
   * but having it sit on top of everything is its own problem: it clutters the
   * screen, and — the actual failure people hit — it is easy to close by hand,
   * after which every tool call reports "no page is open".
   *
   * So it is a real window at coordinates no monitor covers. Sound still plays,
   * frames still arrive, and nothing is in the way. Nothing raises it either —
   * see `focusPage`, which used to and was the reason the sandbox appeared to
   * pop up over people's work. Set BROWSER_SHOW=true when you want to watch it
   * directly on the machine.
   */
  if (!headless && !/^(1|true|yes)$/i.test(process.env.BROWSER_SHOW ?? '')) {
    args.push(`--window-position=${-VIEWPORT.width - 400},0`, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`);
  }

  let lastError;
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, headless, args });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not start a browser. Install Google Chrome or Microsoft Edge. (${lastError?.message?.split('\n')[0]})`,
  );
}

/**
 * The context outlives any one tab.
 *
 * Keeping it separate from `page` is what makes tabs possible at all: a second
 * tab is another page in the same context, sharing cookies and session. It also
 * fixes the thing that made this feel broken — asking for a news site while
 * music was playing used to navigate the only tab there was, killing the audio.
 */
async function ensureContext() {
  if (context && browser?.isConnected()) return context;

  if (!browser || !browser.isConnected()) browser = await launch();
  context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // A page opened by the site itself — target="_blank", window.open — is a tab
  // the user would see appear, so treat it as one and follow it.
  context.on('page', (opened) => {
    opened.setDefaultTimeout(20_000);
  });
  return context;
}

/**
 * Make this tab the one being acted on and mirrored.
 *
 * **Nothing is brought to the front, and that is the fix.**
 *
 * This used to call `page.bringToFront()` on every tab switch, on the belief —
 * stated in a comment here for a long time — that "Chrome only screencasts the
 * tab it considers active". That belief is wrong, and it was the entire cause of
 * the sandbox popping up over whatever the user was doing: bringing a tab forward
 * activates the window it lives in, and on Windows an activated window takes the
 * keyboard with it. Every lookup the assistant did stole the cursor mid-sentence.
 *
 * Measured rather than assumed. With a screencast running on a *background* tab,
 * against a Chrome window that is not the foreground window:
 *
 *     active tab      rAF advanced 272 frames · screencast 270 frames
 *     background tab  rAF advanced 268 frames · screencast 266 frames
 *
 * Identical, and `document.hidden` reads `false` throughout — starting a
 * screencast on a target is itself what keeps that target rendering, so the
 * activation bought nothing and cost the user their focus. Animation, video and
 * audio all continue.
 *
 * So the window is never raised. It stays parked off the edge of the desktop
 * where `launch` puts it, sound still comes out of the machine's speakers, and
 * the frames still arrive.
 */
async function focusPage(next) {
  if (page === next) return page;
  page = next;
  page.setDefaultTimeout(20_000);
  await startScreencast();
  return page;
}

/** Every open tab, in the order Chrome has them. */
function tabs() {
  if (!context || !browser?.isConnected()) return [];
  return context.pages().filter((p) => !p.isClosed());
}

/**
 * The open tabs, for the panel's tab strip.
 *
 * Titles are not read here: `page.title()` is a round trip into the page and
 * this is called on every frame. The URL's host is enough to tell one tab from
 * another at a glance, and the active tab's real title is already in the bar
 * above. Anything more would cost a promise per tab per repaint.
 */
function tabSummary() {
  return tabs().map((p, i) => {
    let host = '';
    try {
      host = new URL(p.url()).host.replace(/^www\./, '');
    } catch {
      host = 'new tab';
    }
    return { index: i + 1, host, active: p === page };
  });
}

export async function closeBrowser() {
  await stopScreencast();
  release('browser');
  try {
    await context?.close();
  } catch {
    /* already gone */
  }
  context = null;
  page = null;
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  browser = null;
}

// ── frames ────────────────────────────────────────────────────────────

/**
 * Chrome's own screencast, rather than a screenshot on a timer.
 *
 * The difference is not small: a screenshot loop caps out around 2 frames a
 * second and spends most of its time rasterising pages that have not changed,
 * while the screencast is driven by the compositor — it fires when the page
 * actually repaints, at up to 40 frames a second, and costs nothing at all
 * while the page sits still. A playing video looks like a playing video.
 */
/**
 * Send the newest frame, and only the newest.
 *
 * This is what makes the mirror feel live rather than merely fast. Chrome
 * screencasts on every repaint and the ack goes back immediately, so frames
 * keep arriving whether or not the previous one has finished its trip to the
 * server — and each one is an HTTP round trip carrying ~90KB. Awaiting them in
 * order builds a queue, and a queue of frames is not a slow video: it is a
 * *delayed* one, drifting further behind the real page with every repaint,
 * which is exactly what "it lags" means.
 *
 * So there is no queue. One request is in flight at a time; anything that
 * arrives while it is out replaces whatever was waiting. Frames get dropped
 * under load, which is the correct thing to drop — nobody wants to watch the
 * page as it was four seconds ago.
 */
let inFlight = false;
let queued = null;

async function publishLatest(payload) {
  queued = payload;
  if (inFlight) return;

  inFlight = true;
  try {
    while (queued) {
      const next = queued;
      queued = null;
      await publishFrame(next);
      applyPreference();
    }
  } finally {
    inFlight = false;
  }
}

/** How many pixels to capture, and how hard to compress them. */
function castOptions(hd) {
  const scale = hd ? Number(process.env.SCREEN_HD_SCALE) || 2 : 1;
  return {
    format: 'jpeg',
    // Full screen on a 2K monitor is a 1280-wide frame stretched to twice its
    // size, which is the blur. Asked for at the real size, it is not.
    quality: hd ? Number(process.env.SCREEN_HD_QUALITY) || 72 : Number(process.env.SCREEN_QUALITY) || 58,
    maxWidth: Math.round(VIEWPORT.width * scale),
    maxHeight: Math.round(VIEWPORT.height * scale),
    // Every frame by default. The screencast already fires only on repaint, so
    // skipping frames on top of that means a page that paints once — which is
    // most pages — streams nothing at all.
    everyNthFrame: Math.max(1, Number(process.env.SCREEN_EVERY_NTH) || 1),
  };
}

/** Whether the stream currently running is the high-resolution one. */
let castingHd = false;

/**
 * Follow the panel between its two sizes.
 *
 * Restarting a screencast is cheap and changing its parameters is not possible
 * any other way, so this happens on the frame *after* somebody presses expand —
 * one frame of the old size, then the new one.
 */
function applyPreference() {
  const wanted = !!watcherPreference().hd;
  if (wanted === castingHd || !screencast) return;
  castingHd = wanted;
  screencast.send('Page.startScreencast', castOptions(wanted)).catch(() => {});
}

async function startScreencast() {
  await stopScreencast();
  await claim('browser', stopScreencast);

  const cdp = await page.context().newCDPSession(page);
  // Without Page.enable the screencast starts but delivers exactly one frame.
  await cdp.send('Page.enable');

  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    // Acknowledge first and unconditionally: Chrome stops sending until the
    // previous frame is acked, so a slow sink would otherwise end the stream.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    publishLatest({
      frame: data,
      source: 'browser',
      url: page?.url() ?? '',
      title: lastTitle,
      tabs: tabSummary(),
      width: metadata?.deviceWidth || VIEWPORT.width,
      height: metadata?.deviceHeight || VIEWPORT.height,
    });
  });

  castingHd = !!watcherPreference().hd;
  await cdp.send('Page.startScreencast', castOptions(castingHd));

  screencast = cdp;
}

/**
 * Publish one frame directly.
 *
 * Insurance for the still-page case: the screencast is driven by repaints, and
 * a page that has finished loading produces none. Without this the user would
 * watch an action complete and see nothing change, because nothing did.
 */
async function pushStill() {
  if (!browserIsOpen()) return;
  try {
    const shot = await page.screenshot({ type: 'jpeg', quality: Number(process.env.SCREEN_QUALITY) || 55 });
    await publishFrame({
      frame: shot.toString('base64'),
      source: 'browser',
      url: page.url(),
      title: lastTitle,
      tabs: tabSummary(),
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
  } catch {
    /* a frame is never worth failing the action that produced it */
  }
}

async function stopScreencast() {
  if (!screencast) return;
  const cdp = screencast;
  screencast = null;
  try {
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
  } catch {
    /* the page is already gone, which is the same outcome */
  }
}

// Reading the title inside the frame handler would mean a round trip into the
// page for every frame; it changes far more slowly than the pixels do.
let lastTitle = '';

// ── looking at the page ───────────────────────────────────────────────

/**
 * Tag every interactive element in the viewport with a number and report it.
 * Runs in the page, so it sees what a person would see.
 */
const SNAPSHOT = (offset = 0) => {
  const SELECTOR =
    'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="textbox"],[role="checkbox"],[role="menuitem"],[contenteditable="true"],[onclick]';

  /**
   * Wipe the previous numbering before laying down a new one.
   *
   * Only what is in the viewport gets numbered, so a page that has scrolled
   * leaves its old tags behind on elements above the fold. Two elements then
   * answer to `[3]`, `locator(...).first()` picks whichever comes first in the
   * document — the stale one — and the click lands on something the model was
   * never looking at. Not a near miss: a different, real, clickable control.
   */
  for (const stale of document.querySelectorAll('[data-air-ref]')) {
    stale.removeAttribute('data-air-ref');
  }

  const elements = [];
  let index = offset;

  for (const el of document.querySelectorAll(SELECTOR)) {
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    if (box.bottom < 0 || box.top > innerHeight) continue;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;

    index += 1;
    el.setAttribute('data-air-ref', String(index));

    /**
     * What the control is, and separately what is in it.
     *
     * These used to be one string with the placeholder ahead of the value — so
     * a field with a placeholder reported its placeholder forever, whatever you
     * typed. Filling a form then became guesswork: the model could not read
     * back its own work, could not tell an empty field from a full one, and
     * would retype into fields that were already correct.
     */
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.innerText) ||
      el.getAttribute('name') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);

    let value = '';
    if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked';
    else if (tag === 'select') value = el.options?.[el.selectedIndex]?.text || '';
    else if (tag === 'input' || tag === 'textarea') value = el.value || '';
    else if (el.isContentEditable) value = el.innerText || '';

    elements.push({
      ref: index,
      tag,
      type,
      label,
      value: String(value).replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    next: index,
    text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim(),
  };
};

/** How much of a page the model is shown before it has to scroll or narrow. */
const MAX_ELEMENTS = 140;
const MAX_TEXT = 5_000;

/**
 * Every frame that is actually on screen, the main one first.
 *
 * A hidden iframe's contents still measure normally inside their own document,
 * so without checking the frame element itself the listing fills up with
 * controls nobody can see — Lightning keeps a good number of those around.
 */
async function visibleFrames() {
  const out = [page.mainFrame()];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    try {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (box && box.width > 4 && box.height > 4) out.push(frame);
    } catch {
      // Detached between listing the frames and asking about one. Skip it:
      // anything it held is gone from the page too.
    }
  }
  return out;
}

/**
 * Read the page, including everything inside its frames.
 *
 * This was the single worst bug in the sandbox. `document.querySelectorAll` in
 * the top document does not cross an iframe boundary, and neither does
 * `page.locator` — so on any application that puts its real interface in a
 * frame, the assistant was shown the navigation chrome and nothing else. It
 * could not see the form it was asked to fill in, could not click a control
 * inside it, and had no way to tell that anything was missing. Salesforce
 * Lightning does exactly this with record modals and Visualforce pages, which
 * is why it kept failing there and nowhere obvious.
 *
 * Numbering runs across the frames as one sequence, so `[7]` means one thing on
 * the page rather than one thing per document.
 */
async function snapshotAll() {
  const frames = await visibleFrames();
  const elements = [];
  const texts = [];
  let offset = 0;
  let url = page.url();
  let title = '';

  for (const frame of frames) {
    let snap;
    try {
      snap = await frame.evaluate(SNAPSHOT, offset);
    } catch {
      continue; // navigated away mid-read; the next look will catch it
    }
    if (frame === page.mainFrame()) {
      url = snap.url;
      title = snap.title;
      if (snap.text) texts.push(snap.text);
    } else if (snap.text) {
      // Named, because a model that cannot tell chrome from content will try to
      // "go back" to text that is sitting inside the panel in front of it.
      texts.push(`--- inside frame: ${snap.title || snap.url} ---\n${snap.text}`);
    }
    elements.push(...snap.elements);
    offset = snap.next;
  }

  const text = texts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    url,
    title,
    frames: frames.length,
    elements: elements.slice(0, MAX_ELEMENTS),
    hidden: Math.max(0, elements.length - MAX_ELEMENTS),
    text: text.slice(0, MAX_TEXT),
    clipped: text.length > MAX_TEXT,
  };
}

function describe(snapshot, note) {
  const lines = [];
  if (note) lines.push(note, '');
  lines.push(`Page: ${snapshot.title || '(untitled)'}`, `URL: ${snapshot.url}`);
  if (snapshot.frames > 1) {
    lines.push(`This page has ${snapshot.frames - 1} embedded frame(s); their contents are listed below too.`);
  }
  lines.push('');

  if (snapshot.elements.length) {
    lines.push('Things you can act on (use the number as `ref`, and `= …` is what is in it now):');
    for (const e of snapshot.elements) {
      const kind = e.type ? `${e.tag}/${e.type}` : e.tag;
      const filled = e.value ? `  = ${JSON.stringify(e.value)}` : '';
      lines.push(`  [${e.ref}] ${kind}  ${e.label || '(no label)'}${filled}`);
    }
    // Silently cutting the list is how a model concludes a control does not
    // exist and starts inventing a way around it.
    if (snapshot.hidden) {
      lines.push(
        `  … and ${snapshot.hidden} more not listed. Scroll to bring the part you want into view, then look again.`,
      );
    }
    lines.push('');
  } else {
    lines.push('No interactive elements are visible. Try scrolling.', '');
  }

  lines.push('Visible text:', snapshot.text || '(none)');
  if (snapshot.clipped) lines.push('', '[text truncated — scroll for the rest]');
  return lines.join('\n');
}

/** Snapshot, capture a frame, and describe the result to the model. */
async function report(note) {
  // A moment for the page to settle after an action before we look at it.
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(350);

  const snapshot = await snapshotAll();
  lastTitle = snapshot.title || '';
  await pushStill();
  return describe(snapshot, note);
}

/**
 * Resolve a ref to exactly one element, or say why not.
 *
 * Searched frame by frame, because the numbers are laid down frame by frame and
 * `page.locator` cannot see into one. A ref matching two elements should never
 * happen now that each snapshot clears its own document first, but "should
 * never happen" is how the last version of this bug was described too — and the
 * failure mode is pressing the wrong button on somebody else's screen. Refusing
 * is cheap; guessing is not.
 */
async function elementFor(ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('`ref` must be one of the numbers from the latest page listing.');
  }

  for (const frame of await visibleFrames()) {
    const target = frame.locator(`[data-air-ref="${n}"]`);
    const count = await target.count().catch(() => 0);
    if (count === 1) return target.first();
    if (count > 1) {
      throw new Error(
        `[${ref}] matches ${count} elements, which means the listing is stale. Call browser_look again.`,
      );
    }
  }

  throw new Error(
    `There is no element [${ref}] on the page now. Call browser_look again — the page may have changed.`,
  );
}

// ── the tools ─────────────────────────────────────────────────────────

async function browserOpen({ url, replace_tab: replaceTab, new_tab: newTab }) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('Give a full http(s) URL, for example https://www.youtube.com.');
  }

  const ctx = await ensureContext();
  // A new tab unless told otherwise. Reusing the one tab is how a video the
  // user was listening to got closed to make room for a news site, and how a
  // half-filled form vanished to look something up — and the model had to
  // remember to prevent it every time. `new_tab` is still honoured so an older
  // habit does not become an error.
  const reuse = replaceTab === true || newTab === false;
  if (!reuse || !browserIsOpen()) await focusPage(await ctx.newPage());

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const count = tabs().length;
  return report(`Opened ${target}${count > 1 ? ` in a new tab (${count} open)` : ''}.`);
}

async function browserTabs() {
  const open = tabs();
  if (!open.length) return 'No tabs are open.';

  const titles = await Promise.all(
    open.map(async (p, i) => {
      const title = await p.title().catch(() => '');
      return `  [${i + 1}]${p === page ? ' ←' : '  '} ${title || '(untitled)'}\n       ${p.url()}`;
    }),
  );
  return ['Open tabs (← is the one you are acting on):', '', ...titles].join('\n');
}

async function browserSwitch({ tab }) {
  const open = tabs();
  const index = Number(tab);
  if (!Number.isInteger(index) || index < 1 || index > open.length) {
    throw new Error(`There is no tab ${tab}. Call browser_tabs to see what is open.`);
  }
  await focusPage(open[index - 1]);
  return report(`Switched to tab ${index}.`);
}

async function browserCloseTab({ tab }) {
  const open = tabs();
  const index = tab == null ? open.indexOf(page) + 1 : Number(tab);
  if (!Number.isInteger(index) || index < 1 || index > open.length) {
    throw new Error(`There is no tab ${tab}. Call browser_tabs to see what is open.`);
  }

  const closing = open[index - 1];
  await closing.close().catch(() => {});
  const left = tabs();
  if (!left.length) {
    page = null;
    return 'Closed the last tab. The sandbox has nothing open now.';
  }
  if (closing === page) await focusPage(left[0]);
  return report(`Closed tab ${index}. ${left.length} still open.`);
}

async function browserLook() {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  return report('Current page:');
}

async function browserClick({ ref, description }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(ref);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 15_000 });
  return report(`Clicked [${ref}]${description ? ` (${description})` : ''}.`);
}

async function browserType({ ref, text, submit = false }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(ref);
  await target.click({ timeout: 15_000 }).catch(() => {});
  await target.fill(String(text ?? ''), { timeout: 15_000 });
  if (submit) await page.keyboard.press('Enter');
  return report(`Typed into [${ref}]${submit ? ' and pressed Enter' : ''}.`);
}

async function browserPress({ key }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  await page.keyboard.press(String(key || 'Enter'));
  return report(`Pressed ${key}.`);
}

/**
 * Back and forward, for the model.
 *
 * The panel has had these for the person watching; the model had to re-open a
 * remembered URL, which is not the same act — it discards the scroll position and
 * cannot reach a page that was arrived at by clicking.
 *
 * `goBack` resolves to null when there is nothing in the history, which is worth
 * saying rather than reporting a move that did not happen.
 */
async function browserBack() {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const response = await page
    .goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    .catch(() => null);
  if (!response) return report('There was nothing to go back to; the page has not moved.');
  return report('Went back.');
}

async function browserForward() {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const response = await page
    .goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    .catch(() => null);
  if (!response) return report('There was nothing to go forward to; the page has not moved.');
  return report('Went forward.');
}

/**
 * Set a native dropdown.
 *
 * Clicking a `<select>` does not open anything a subsequent click can reach — the
 * option list is drawn by the operating system, not by the page — so without this
 * a form with a dropdown in it could not be completed at all.
 *
 * Matched on the visible label first, because that is what the listing shows and
 * therefore what the model has to work from, then on the underlying value.
 */
async function browserSelect({ ref, value }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(ref);
  const wanted = String(value ?? '');

  await target.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await target.selectOption({ label: wanted }, { timeout: 10_000 });
  } catch {
    try {
      await target.selectOption({ value: wanted }, { timeout: 10_000 });
    } catch {
      // Say what the choices actually are. "Timed out" tells the model nothing it
      // can act on, and guessing a second time is what it would do instead.
      const options = await target
        .evaluate((el) => [...(el.options || [])].map((o) => o.text.trim()).filter(Boolean))
        .catch(() => []);
      throw new Error(
        options.length
          ? `[${ref}] has no option "${wanted}". The choices are: ${options.join(' · ')}.`
          : `[${ref}] is not a dropdown, so there is nothing to select. Use browser_click or browser_type.`,
      );
    }
  }
  return report(`Chose "${wanted}" in [${ref}].`);
}

/** Hover, for menus that only exist while the pointer is on them. */
async function browserHover({ ref }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(ref);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.hover({ timeout: 10_000 });
  return report(`Hovering over [${ref}]. Anything that only appears on hover is in the listing below.`);
}

async function browserScroll({ direction = 'down', amount = 1 }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const steps = Math.min(Math.max(Number(amount) || 1, 1), 10);
  const delta = (direction === 'up' ? -1 : 1) * VIEWPORT.height * 0.85 * steps;
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(400);
  return report(`Scrolled ${direction}.`);
}

async function browserWait({ seconds = 3 }) {
  if (!browserIsOpen()) throw new Error('No page is open. Use browser_open first.');
  const s = Math.min(Math.max(Number(seconds) || 3, 1), 30);
  // Nothing to pump here any more — the screencast pushes frames on its own
  // clock, so a video plays at video speed while this simply waits.
  await page.waitForTimeout(s * 1000);
  return report(`Waited ${s} seconds while the user watched.`);
}

/**
 * Say what actually happened.
 *
 * This used to report "Closed the browser" unconditionally, including when
 * there was no sandbox at all — which is exactly how someone ends up staring at
 * a page in their own Chrome that they were told had been closed. The sandbox
 * and the user's browser are different programs, and only one of them is ours
 * to shut.
 */
async function browserClose() {
  if (!browserIsOpen()) {
    return (
      'There was no sandbox open, so nothing was closed.\n\n' +
      'If the user is looking at a page you opened with `open_url`, that is their own browser — ' +
      'you cannot close it from here. Either ask them to close the tab, or use the desktop tools ' +
      'to close that window for them if they would rather you did it.'
    );
  }
  await closeBrowser();
  return 'Closed the sandbox browser. The screen panel will stop updating.';
}

/**
 * Let the person watching reach into the page.
 *
 * Dispatched through CDP rather than Playwright's helpers because these are raw
 * coordinates from a click on an image, not a located element — and because the
 * events have to be indistinguishable from a real mouse to the page.
 *
 * Coordinates arrive normalised (0–1) so the panel does not need to know the
 * viewport, and a phone showing a scaled-down mirror still lands in the right
 * place.
 */
export async function userInput({ type, x, y, toX, toY, button = 'left', key, text, deltaY }) {
  if (!browserIsOpen()) throw new Error('Nothing is open in the sandbox.');
  const cdp = await page.context().newCDPSession(page);
  try {
    const toPixels = (value, extent) => Math.round(Math.min(Math.max(Number(value) || 0, 0), 1) * extent);
    const px = toPixels(x, VIEWPORT.width);
    const py = toPixels(y, VIEWPORT.height);

    /**
     * A press, a path, and a release — as one call.
     *
     * Not three. A chart is panned by holding the button down and moving, and a
     * page only believes that if it sees the moves *between* the two ends: send
     * press and release alone and TradingView reads a click on empty canvas and
     * does nothing. Sending each mousemove as its own request would be a round
     * trip per pixel over a link that may be a phone on mobile data, and the
     * gesture would arrive as a stutter of unrelated jumps.
     *
     * So the browser sends where the drag started and where it ended, and the
     * path is drawn here, next to the page, where the steps cost nothing.
     */
    if (type === 'drag') {
      const tx = toPixels(toX, VIEWPORT.width);
      const ty = toPixels(toY, VIEWPORT.height);

      // `buttons: 1` on every event of the gesture. Without the bitmask a page
      // that listens for pointer events sees moves with no button held and
      // treats the whole thing as hovering.
      const held = { button: 'left', buttons: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, clickCount: 1, ...held });

      // Enough steps that momentum-based interfaces read it as a movement, and
      // few enough that the whole gesture is over in well under a second.
      const steps = 24;
      for (let i = 1; i <= steps; i += 1) {
        // Ease out, so the path ends the way a hand does rather than stopping
        // dead at full speed — kinetic scrolling reads the last few moves.
        const t = 1 - (1 - i / steps) ** 2;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(px + (tx - px) * t),
          y: Math.round(py + (ty - py) * t),
          ...held,
        });
        await new Promise((r) => setTimeout(r, 8));
      }

      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: tx,
        y: ty,
        clickCount: 1,
        button: 'left',
        buttons: 0,
      });
      await pushStill();
      return 'dragged';
    }

    if (type === 'click') {
      for (const eventType of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: eventType,
          x: px,
          y: py,
          button,
          clickCount: 1,
        });
      }
      return 'clicked';
    }
    if (type === 'move') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      return 'moved';
    }
    if (type === 'scroll') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: px,
        y: py,
        deltaX: 0,
        deltaY: Number(deltaY) || 0,
      });
      return 'scrolled';
    }
    if (type === 'text') {
      await page.keyboard.insertText(String(text ?? ''));
      return 'typed';
    }
    if (type === 'key') {
      await page.keyboard.press(String(key || 'Enter'));
      return 'pressed';
    }
    // Navigation, so the panel is a browser window rather than a picture of
    // one. Watching an assistant take a wrong turn and being unable to press
    // Back is a strange kind of helplessness.
    if (type === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await pushStill();
      return 'back';
    }
    if (type === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await pushStill();
      return 'forward';
    }
    if (type === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await pushStill();
      return 'reloaded';
    }
    // Switching tabs from the strip. The assistant reads whichever tab is
    // focused on its next look, so this moves it too — which is the point:
    // "look at this one instead" is a thing you should be able to say by
    // pressing a tab rather than by typing a sentence.
    if (type === 'tab') {
      const open = tabs();
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1 || index > open.length) {
        throw new Error(`There is no tab ${key}.`);
      }
      await focusPage(open[index - 1]);
      await pushStill();
      return `tab ${index}`;
    }
    throw new Error(`Unknown input "${type}".`);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * A real PDF, printed by the browser that is already here.
 *
 * The app has always told people to open a document in the viewer and use their
 * browser's Print → Save as PDF, on the grounds that generating one server-side
 * would need a PDF engine and would get the fonts wrong. That reasoning was
 * sound; the conclusion was not, because there is a browser on this machine
 * already and it is the same browser the advice was pointing at.
 *
 * Verified rather than assumed: `page.pdf()` is documented as headless-only and
 * is not. Printed from a headed Chrome on this machine it produces a 35KB A4
 * document with Vietnamese diacritics intact, which is the whole reason to print
 * through a browser rather than compose one by hand.
 *
 * Rendered in its own tab in the sandbox, so the person watching sees the page
 * being printed rather than a file appearing from nowhere. The tab is closed
 * afterwards whatever happens — a print job must not leave litter behind.
 */
export async function renderPdf({ html, url, landscape = false }) {
  const ctx = await ensureContext();
  const sheet = await ctx.newPage();

  try {
    if (url) {
      await sheet.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    } else {
      await sheet.setContent(String(html ?? ''), { waitUntil: 'load', timeout: NAV_TIMEOUT });
    }
    // Web pages are written for screens and often hide print styling; asking for
    // the screen rendering is what makes the output look like the page.
    await sheet.emulateMedia({ media: 'screen' });
    return await sheet.pdf({
      format: 'A4',
      landscape: !!landscape,
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await sheet.close().catch(() => {});
    // Printing must not steal the tab the assistant was working in.
    const left = tabs();
    if (page?.isClosed?.() && left.length) await focusPage(left[0]);
  }
}

/**
 * Resize, crop, rotate and re-encode a picture — in the browser that is here.
 *
 * The alternative was `sharp`, which means a native module with prebuilt binaries
 * per platform and per Node version: a real dependency, in a project that has nine
 * and uses `playwright-core` rather than `playwright` precisely to avoid that kind
 * of weight. A canvas does all of this and is already installed.
 *
 * Two things worth knowing about the implementation. The work happens inside the
 * page rather than here, because that is where the decoder and the encoder live.
 * And the source arrives as a data URI rather than a file:// URL — a page loaded
 * from `about:blank` cannot read the local disk, and giving it that ability to save
 * one base64 round trip would be a poor trade.
 */
export async function renderImage({ data, mime, width, height, crop, rotate = 0, flip, format = 'png', quality = 0.9 }) {
  const ctx = await ensureContext();
  const sheet = await ctx.newPage();

  try {
    const result = await sheet.evaluate(
      async (job) => {
        const image = new Image();
        image.src = `data:${job.mime};base64,${job.data}`;
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('The bytes are not an image this browser can decode.'));
        });

        // Crop first: everything after it is measured against the piece that was
        // kept, which is what somebody asking to "crop then resize" means.
        const sx = Math.max(0, Math.min(job.crop?.x ?? 0, image.naturalWidth - 1));
        const sy = Math.max(0, Math.min(job.crop?.y ?? 0, image.naturalHeight - 1));
        const sw = Math.max(1, Math.min(job.crop?.width ?? image.naturalWidth - sx, image.naturalWidth - sx));
        const sh = Math.max(1, Math.min(job.crop?.height ?? image.naturalHeight - sy, image.naturalHeight - sy));

        /**
         * A missing dimension keeps the aspect ratio.
         *
         * Asking for `width: 800` and getting an 800×(original height) image is a
         * squashed picture, and it is never what anybody meant.
         */
        let tw = job.width || 0;
        let th = job.height || 0;
        if (tw && !th) th = Math.round((sh * tw) / sw);
        else if (th && !tw) tw = Math.round((sw * th) / sh);
        else if (!tw && !th) {
          tw = sw;
          th = sh;
        }

        // A quarter turn swaps the canvas's dimensions; a half turn does not.
        const turn = ((Math.round(job.rotate / 90) * 90) % 360 + 360) % 360;
        const swap = turn === 90 || turn === 270;
        const canvas = document.createElement('canvas');
        canvas.width = swap ? th : tw;
        canvas.height = swap ? tw : th;

        const paint = canvas.getContext('2d');
        // JPEG has no alpha, so a transparent PNG converted to one would come out
        // with black where it was see-through unless something is put behind it.
        if (job.format === 'jpeg') {
          paint.fillStyle = '#ffffff';
          paint.fillRect(0, 0, canvas.width, canvas.height);
        }
        paint.imageSmoothingQuality = 'high';

        paint.translate(canvas.width / 2, canvas.height / 2);
        if (turn) paint.rotate((turn * Math.PI) / 180);
        if (job.flip === 'horizontal') paint.scale(-1, 1);
        else if (job.flip === 'vertical') paint.scale(1, -1);
        paint.drawImage(image, sx, sy, sw, sh, -tw / 2, -th / 2, tw, th);

        const type = `image/${job.format}`;
        const url = canvas.toDataURL(type, job.quality);
        return {
          data: url.split(',')[1],
          // What actually came out, which is not always what was asked for: a
          // browser that cannot encode webp silently hands back a PNG.
          mime: url.slice(5, url.indexOf(';')),
          width: canvas.width,
          height: canvas.height,
          from: { width: image.naturalWidth, height: image.naturalHeight },
        };
      },
      { data, mime, width, height, crop, rotate, flip, format, quality },
    );

    return { ...result, buffer: Buffer.from(result.data, 'base64') };
  } finally {
    await sheet.close().catch(() => {});
    const left = tabs();
    if (page?.isClosed?.() && left.length) await focusPage(left[0]);
  }
}

export const BROWSER_IMPLEMENTATIONS = {
  browser_open: browserOpen,
  browser_tabs: browserTabs,
  browser_switch: browserSwitch,
  browser_close_tab: browserCloseTab,
  browser_look: browserLook,
  browser_click: browserClick,
  browser_type: browserType,
  browser_press: browserPress,
  browser_back: browserBack,
  browser_forward: browserForward,
  browser_select: browserSelect,
  browser_hover: browserHover,
  browser_scroll: browserScroll,
  browser_wait: browserWait,
  browser_close: browserClose,
};
