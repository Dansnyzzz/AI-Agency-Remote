---
name: accessibility-checklist
description: Use when building or changing any UI in public/ — covers keyboard access, screen readers, contrast, touch targets, i18n, and the states that are easy to forget.
---

# Accessibility and interface checklist

CLAUDE.md §8 requires this and §5 makes it a gate. It is short because the
failures are few and repetitive.

## Keyboard and focus

- [ ] Every interactive element is reachable by <kbd>Tab</kbd> in a sensible order
- [ ] Focus is **visible** — do not remove the outline without replacing it
- [ ] <kbd>Esc</kbd> closes any dialog, menu or overlay
- [ ] Focus moves into a dialog when it opens and returns when it closes
- [ ] Nothing is reachable only by hover — that excludes touch and keyboard alike
- [ ] A `div` with a click handler is not a button. Use `<button>`.

## Screen readers

- [ ] Every input has a `<label>` tied to it (`for`/`id`), not just a placeholder
- [ ] Buttons carrying only an icon have an accessible name
- [ ] Meaningful images have `alt`; decorative ones have `alt=""`
- [ ] Semantic elements — `button`, `nav`, `main`, `h1`–`h3` in order
- [ ] Content that streams in or updates asynchronously is announced, not silent

## Visual

- [ ] Contrast is sufficient — **check both themes**
- [ ] Colour is never the only signal; pair it with text or shape
- [ ] Layout survives 200% zoom
- [ ] Touch targets are thumb-sized. This app is driven from phones.

## i18n — a bug even when the product ships in one language

- [ ] No hard-coded user-facing string. Everything goes through
      `public/js/i18n.js`.
- [ ] Added to **both** `public/js/locales/en.js` and `locales/vi.js`
- [ ] Layout survives the longer string — Vietnamese runs longer than English
- [ ] `npm run test:i18n` passes

## The states people forget

Empty, loading, partial, error, offline, and **waiting for approval**. In this
app none of these are edge cases: the worker being offline is ordinary, and the
approval prompt is the most important interaction in the product. It must state
concretely what will happen and be impossible to hit by accident on a phone.

## Verify

`npm run test:i18n` is fast. `npm run test:ui` drives a real browser but **skips
itself when there is none** — confirm it actually ran before reporting it green.
