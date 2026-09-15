// Its own copy rather than markdown.js's, which imports this module.
const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Mathematics in a reply, drawn as mathematics.
 *
 * Models write TeX — `$\frac{CF_t}{(1+r)^t}$`, `$$\sum PV_t$$` — and without
 * this it reached the reader as backslashes and braces. KaTeX turns it into
 * typeset HTML. It is served from `public/vendor/katex` (the page's CSP allows
 * scripts from its own origin only) and loaded the first time a reply actually
 * contains a formula, so a conversation without any pays nothing for it.
 *
 * `mathHtml` is synchronous because the Markdown renderer is: while KaTeX is
 * still loading, a formula is written as a placeholder holding its source, and
 * the placeholders on the page are typeset the moment it arrives. After that
 * every call renders straight to a string, from a cache — a streaming reply
 * re-renders its Markdown on every token, and re-typesetting the same formula
 * each time would be wasted work.
 *
 * KaTeX runs with `trust: false`, so `\href`, `\url` and friends cannot turn a
 * model's text into a link or a script, and `throwOnError: false`, so a formula
 * it cannot parse shows its source in red rather than breaking the reply.
 */

const BASE = '/vendor/katex';
const cache = new Map();
const CACHE_LIMIT = 500;
let loading = null;

// KaTeX's UMD build sets `window.katex`; nothing declares it for the checker.
const katex = () => (typeof window !== 'undefined' ? /** @type {any} */ (window).katex : undefined);

function render(tex, display) {
  const key = `${display ? 'D' : 'I'}${tex}`;
  let html = cache.get(key);
  if (html == null) {
    html = katex().renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
    });
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, html);
  }
  return display ? `<span class="math math--display">${html}</span>` : `<span class="math">${html}</span>`;
}

/** Typeset every placeholder written before KaTeX had arrived. */
function typesetPending() {
  for (const node of document.querySelectorAll('.math.is-pending')) {
    const tex = node.getAttribute('data-tex') || '';
    node.outerHTML = render(tex, node.classList.contains('math--display'));
  }
}

/** Fetch the stylesheet and the script once; resolve when both can be used. */
export function loadMath() {
  if (katex()) return Promise.resolve(true);
  if (loading) return loading;
  if (typeof document === 'undefined') return Promise.resolve(false);

  loading = new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${BASE}/katex.min.css`;
    document.head.append(css);

    const script = document.createElement('script');
    script.src = `${BASE}/katex.min.js`;
    script.async = true;
    script.onload = () => {
      typesetPending();
      resolve(true);
    };
    // Unreachable is not fatal: the placeholders keep showing the source.
    script.onerror = () => {
      loading = null;
      resolve(false);
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * One formula as HTML.
 *
 * @param {string} tex       the TeX between the delimiters
 * @param {boolean} display  `$$…$$` / `\[…\]` — on its own line, centred
 */
export function mathHtml(tex, display) {
  const source = String(tex).trim();
  if (katex()) return render(source, display);
  loadMath();
  const cls = `math is-pending${display ? ' math--display' : ''}`;
  return `<span class="${cls}" data-tex="${escapeHtml(source)}">${escapeHtml(source)}</span>`;
}
