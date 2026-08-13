import { escapeHtml } from './markdown.js';

/**
 * The small menu a ⋮ button opens.
 *
 * One at a time, positioned against whatever was pressed, and closed by the
 * next click anywhere else or by Escape. It lives directly under `<body>` and
 * is `position: fixed`, because the thing it hangs off is usually inside a
 * scrolling panel with `overflow: hidden` — a menu absolutely positioned in
 * there gets clipped by its own card, which is exactly the sort of bug that
 * only appears on the last row.
 *
 * Items are `{ label, icon, danger, run }`. A `null` item draws a divider,
 * which is how "Delete" gets separated from the things that are not permanent.
 */

let host = null;
let closer = null;

/** Shut whatever is open. Safe to call when nothing is. */
export function closeMenu() {
  if (!host) return;
  host.remove();
  host = null;
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
  const was = closer;
  closer = null;
  was?.();
}

function onDocClick(event) {
  if (!host?.contains(event.target)) closeMenu();
}

function onKey(event) {
  if (event.key !== 'Escape') return;
  // Stopped here so Escape closes the menu without also closing the dialog or
  // the page behind it — one press, one thing.
  event.stopPropagation();
  closeMenu();
}

/**
 * @param anchor   the element the menu should appear beneath
 * @param items    `{ label, icon, danger, run }` entries, `null` for a divider
 * @param onClose  called whenever the menu goes away, however it went
 */
export function openMenu(anchor, items, onClose = null) {
  const reopening = host?.dataset.owner === anchorKey(anchor);
  closeMenu();
  // A second press on the same button means "put it away", not "open it again".
  if (reopening) return;

  host = document.createElement('div');
  host.className = 'cardmenu';
  host.dataset.owner = anchorKey(anchor);
  host.setAttribute('role', 'menu');
  host.innerHTML = items
    .map((item, i) =>
      item === null
        ? '<hr />'
        : `<button type="button" role="menuitem" data-pick="${i}" data-label="${escapeHtml(item.label)}"${
            item.danger ? ' class="is-danger"' : ''
          }>${
            item.icon ? `<span class="menu__icon" aria-hidden="true">${item.icon}</span>` : ''
          }${escapeHtml(item.label)}</button>`,
    )
    .join('');

  for (const button of host.querySelectorAll('[data-pick]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const item = items[Number(button.dataset.pick)];
      closeMenu();
      item.run();
    });
  }

  document.body.appendChild(host);
  closer = onClose;
  place(anchor);

  // Registered in the capture phase and on a later frame: the click that opened
  // the menu is still travelling, and would otherwise close it immediately.
  requestAnimationFrame(() => {
    if (!host) return;
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  });

  host.querySelector('[data-pick]')?.focus();
}

/** Enough to tell one anchor from another between two clicks. */
function anchorKey(anchor) {
  return anchor.dataset.menuKey || (anchor.dataset.menuKey = `m${Math.random().toString(36).slice(2)}`);
}

/** Below the button and right-aligned to it, unless that would leave the window. */
function place(anchor) {
  const at = anchor.getBoundingClientRect();
  const box = host.getBoundingClientRect();
  const pad = 8;

  let left = at.right - box.width;
  left = Math.min(Math.max(pad, left), window.innerWidth - box.width - pad);

  let top = at.bottom + 6;
  if (top + box.height > window.innerHeight - pad) top = Math.max(pad, at.top - box.height - 6);

  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}
