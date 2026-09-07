import { t, applyI18n } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * The five-step guide a new account is shown once.
 *
 * Built for somebody who is not a developer, which changes what belongs in it.
 * The steps are not a feature tour — they are the four things that actually stop
 * a new account from working, in the order they stop it:
 *
 *   1. what this is, so the rest has somewhere to land
 *   2. an API key, without which nothing answers at all
 *   3. which model, because the default is a free one and that has consequences
 *   4. one real question, because reading about it teaches nobody
 *   5. the permission modes, because the first approval prompt is otherwise a fright
 *
 * Three rules it follows, each of them a way this kind of thing usually goes wrong:
 *
 *   **Skippable at every step, and skipping means skipped.** Answering "not now"
 *   twice is a dialog that has stopped being help.
 *
 *   **Never over a question.** The new-model announcement is also a modal, and two
 *   stacked modals on a first visit is worse than either alone.
 *
 *   **Step 2 marks itself done.** Somebody who pasted a key during signup should
 *   not be told to go and paste a key.
 */

const TOTAL = 5;

export function createOnboarding({ providers, onOpenKeys, onPickModel, onTryPrompt, onFinish, isFree }) {
  const dialog = document.getElementById('onboarding');
  const stepLabel = document.getElementById('onb-step');
  const body = document.getElementById('onb-body');
  const back = document.getElementById('onb-back');
  const next = document.getElementById('onb-next');
  const skip = document.getElementById('onb-skip');

  let step = 1;

  /** Does this account already have a key anywhere? Step 2 turns on this. */
  const hasKey = () => Object.values(providers() || {}).some((p) => p?.configured);

  const li = (key) => `<li>${escapeHtml(t(key))}</li>`;

  function render() {
    stepLabel.textContent = t('onb.step', { n: step, total: TOTAL });
    back.hidden = step === 1;
    next.textContent = step === TOTAL ? t('onb.5.finish') : t('action.next');

    if (step === 1) {
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.1.title'))}</h3>
        <p>${escapeHtml(t('onb.1.body'))}</p>
        <ul class="onb__list">${li('onb.1.a')}${li('onb.1.b')}${li('onb.1.c')}</ul>
        <p class="hint">${escapeHtml(t('onb.1.note'))}</p>`;
    } else if (step === 2) {
      const ready = hasKey();
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.2.title'))}</h3>
        <p>${escapeHtml(t('onb.2.body'))}</p>
        <p class="onb__tip">${escapeHtml(t('onb.2.recommend'))}</p>
        <p class="onb__state ${ready ? 'is-done' : 'is-todo'}">
          ${escapeHtml(t(ready ? 'onb.2.done' : 'onb.2.pending'))}
        </p>
        ${ready ? '' : `<button class="btn btn--primary" id="onb-keys" type="button">${escapeHtml(t('onb.2.open'))}</button>`}
        <p class="hint">${escapeHtml(t('onb.2.safety'))}</p>`;
      body.querySelector('#onb-keys')?.addEventListener('click', () => {
        // Deliberately leaves the guide open behind the sheet: pasting a key is a
        // detour, and coming back to step 3 is the point.
        onOpenKeys();
      });
    } else if (step === 3) {
      const free = isFree();
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.3.title'))}</h3>
        <p class="onb__state ${free ? 'is-free' : 'is-done'}">${escapeHtml(t(free ? 'onb.3.free' : 'onb.3.paid'))}</p>
        ${free ? `<p class="onb__tip">${escapeHtml(t('onb.3.freeWarn'))}</p>` : ''}
        <button class="btn btn--ghost" id="onb-model" type="button">${escapeHtml(t('onb.3.change'))}</button>
        <p class="hint">${escapeHtml(t('onb.3.note'))}</p>`;
      body.querySelector('#onb-model')?.addEventListener('click', () => onPickModel());
    } else if (step === 4) {
      const tries = ['onb.4.try1', 'onb.4.try2', 'onb.4.try3'];
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.4.title'))}</h3>
        <p>${escapeHtml(t('onb.4.body'))}</p>
        <div class="onb__tries">
          ${tries
            .map((key) => `<button class="onb__try" type="button" data-key="${key}">${escapeHtml(t(key))}</button>`)
            .join('')}
        </div>
        <p class="hint">${escapeHtml(t('onb.4.note'))}</p>`;
      for (const btn of body.querySelectorAll('.onb__try')) {
        btn.addEventListener('click', () => {
          // Closes the guide and hands the sentence to the composer. Pressing a
          // suggestion and then having to close a dialog to see what happened
          // would make the suggestion feel like it had not worked.
          finish();
          onTryPrompt(t(btn.dataset.key));
        });
      }
    } else {
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.5.title'))}</h3>
        <p>${escapeHtml(t('onb.5.body'))}</p>
        <ul class="onb__list">${li('onb.5.guarded')}${li('onb.5.auto')}${li('onb.5.ask')}</ul>
        <p class="onb__tip">${escapeHtml(t('onb.5.honest'))}</p>`;
    }

    applyI18n(dialog);
  }

  function finish() {
    if (dialog.open) dialog.close();
    onFinish();
  }

  back.addEventListener('click', () => {
    step = Math.max(1, step - 1);
    render();
  });
  next.addEventListener('click', () => {
    if (step === TOTAL) return finish();
    step += 1;
    return render();
  });
  skip.addEventListener('click', finish);

  // Escape is an answer here, unlike the model announcement — this is help, not a
  // question, and refusing to close would make it the opposite of help.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finish();
  });

  return {
    open(atStep = 1) {
      step = Math.min(Math.max(1, atStep), TOTAL);
      render();
      dialog.showModal();
    },
    /** Repaint while open, so pasting a key updates step 2 behind the sheet. */
    refresh() {
      if (dialog.open) render();
    },
    isOpen: () => dialog.open,
  };
}
