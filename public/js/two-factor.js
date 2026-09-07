/**
 * Account security — the second factor, and changing your password.
 *
 * Lifted out of `app.js` whole. Both things here are the same job from the
 * user's side (make this account harder to take) and neither is referenced from
 * anywhere else, so `renderTwoFactor` is the only handle the settings sheet
 * needs back.
 *
 * The English that was hardcoded in these lines while it lived in `app.js` is
 * now in the dictionaries with the rest — see `twofa.*`.
 */

import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

const val = (id) => /** @type {HTMLInputElement} */ ($(id)).value;

/**
 * @param {object} deps
 * @param {any} deps.state               the app's shared state object
 * @param {() => void} deps.fillSettings  redraw the sheet once the account changes
 */
export function createTwoFactor({ state, fillSettings }) {
  function renderTwoFactor() {
    const me = state.boot.user;
    const card = $('twofa-card');

    if (me.twoFactor) {
      card.innerHTML = `
      <div class="provider">
        <div class="provider__head">
          <span class="provider__name">${escapeHtml(t('twofa.enabled'))}</span>
          <span class="badge badge--ok">${escapeHtml(
            t('twofa.recoveryLeft', { count: me.recoveryCodesLeft }),
          )}</span>
        </div>
        <div class="hint">${escapeHtml(t('twofa.requiredEveryTime'))}</div>
        <div class="provider__row">
          <input type="password" id="twofa-password" placeholder="${escapeHtml(t('account.yourPassword'))}" aria-label="${escapeHtml(t('account.yourPassword'))}" autocomplete="current-password" />
          <input type="text" id="twofa-off-code" placeholder="${escapeHtml(t('twofa.code'))}" aria-label="${escapeHtml(t('twofa.code'))}" inputmode="numeric" autocomplete="one-time-code" />
          <button class="btn btn--ghost" id="twofa-disable" type="button">${escapeHtml(t('twofa.turnOff'))}</button>
        </div>
      </div>`;
      $('twofa-disable').addEventListener('click', async () => {
        try {
          await api.disableTwoFactor(val('twofa-password'), val('twofa-off-code').trim());
          state.boot = await api.bootstrap();
          fillSettings();
          toast(t('account.totpOff'));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      return;
    }

    card.innerHTML = `
    <div class="provider">
      <div class="provider__head">
        <span class="provider__name">${escapeHtml(t('twofa.notEnabled'))}</span>
        <span class="badge">${escapeHtml(t('twofa.off'))}</span>
      </div>
      <div class="hint">${escapeHtml(t('twofa.why'))}</div>
      <button class="btn btn--primary" id="twofa-start" type="button">${escapeHtml(t('twofa.setUp'))}</button>
    </div>`;

    $('twofa-start').addEventListener('click', async () => {
      try {
        const { secret, uri, qr } = await api.startTwoFactor();
        // Nothing is switched on until a code proves the app was set up, so a
        // half-finished enrolment cannot lock anyone out.
        card.innerHTML = `
        <div class="provider">
          <div class="provider__name">${escapeHtml(t('twofa.scanThis'))}</div>
          <div class="qr">${qr}</div>
          <div class="hint">
            ${escapeHtml(t('twofa.cannotScan'))}<br />
            <span class="secret" style="display:inline-block;margin-top:6px">${escapeHtml(secret)}</span><br />
            ${t('twofa.onAPhone', { link: `<a href="${escapeHtml(uri)}">${escapeHtml(t('twofa.tapHere'))}</a>` })}
          </div>
          <div class="provider__row">
            <input type="text" id="twofa-verify" placeholder="${escapeHtml(t('account.enterCode'))}" aria-label="${escapeHtml(t('account.enterCode'))}" inputmode="numeric" autocomplete="one-time-code" />
            <button class="btn btn--primary" id="twofa-confirm" type="button">${escapeHtml(t('twofa.confirm'))}</button>
          </div>
        </div>`;

        $('twofa-confirm').addEventListener('click', async () => {
          try {
            const { recoveryCodes } = await api.confirmTwoFactor(val('twofa-verify').trim());
            // Shown once — the server keeps only digests.
            card.innerHTML = `
            <div class="provider">
              <div class="provider__head">
                <span class="provider__name">${escapeHtml(t('twofa.isOn'))}</span>
                <span class="badge badge--ok">${escapeHtml(t('twofa.enabledBadge'))}</span>
              </div>
              <div class="hint">
                <strong>${escapeHtml(t('twofa.saveCodes'))}</strong> ${escapeHtml(t('twofa.saveCodesWhy'))}
              </div>
              <div class="codes">${recoveryCodes.map((c) => escapeHtml(c)).join('')}</div>
              <button class="btn btn--ghost" id="twofa-done" type="button">${escapeHtml(t('twofa.saved'))}</button>
            </div>`;
            $('twofa-done').addEventListener('click', async () => {
              state.boot = await api.bootstrap();
              fillSettings();
            });
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  $('save-password').addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement} */ ($('save-password'));
    button.disabled = true;
    try {
      const { signedOutOtherDevices } = await api.changePassword(val('current-password'), val('new-password'));
      /** @type {HTMLInputElement} */ ($('current-password')).value = '';
      /** @type {HTMLInputElement} */ ($('new-password')).value = '';
      toast(signedOutOtherDevices ? t('account.passwordUpdatedAll') : t('account.passwordUpdated'));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  return { renderTwoFactor };
}
