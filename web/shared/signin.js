// Sign-in page extras shared by both portals: the single sign-on button, and
// picking up where single sign-on left off (errors, or the 2FA step).

import { api, esc } from '/shared/ui.js';
import { signInSecondStep } from '/shared/twofa.js';
import { passkeysSupported, signInWithPasskey } from '/shared/passkeys.js';

const SSO_ERRORS = {
  not_found: "There's no account for this sign-in. Ask your provider to add you.",
  not_admin: "This account isn't an administrator.",
  email_unverified: "Your identity provider hasn't confirmed your email address, so it can't be matched to an account.",
  no_email: "The identity provider didn't share an email address. The email scope must be allowed for this app.",
  domain: "Single sign-on isn't allowed for your email domain.",
  linked_other: 'Your account is already linked to a different single sign-on identity. Ask your provider to unlink it.',
  denied: 'Sign-in was cancelled at the identity provider.',
  expired: "The sign-in couldn't be completed in this browser. Please try again. If it keeps happening, "
    + 'your administrator can see the reason in the activity log.',
  unavailable: 'Single sign-on is unavailable right now. Try again later.',
  link_required: 'An account with this email already exists. Sign in with your password or passkey, '
    + 'then link this provider under Account → Sign-in methods.',
  linked_elsewhere: 'This provider account is already linked to another panel account.',
  provider_linked: 'Another account of this provider is already linked. Unlink it first.',
  reauth: 'For your security, sign out and sign in again, then link the provider within 15 minutes.',
  failed: "Single sign-on didn't work. Please try again.",
};

let options = null;

/**
 * Adds the passkey and single sign-on buttons; hides the password fields when
 * passwords are off. onSignedIn(account) is called after a passkey sign-in.
 */
export async function prepareSignIn(form, { onSignedIn } = {}) {
  try { options = await api('/api/auth/options'); } catch { options = { password: true, oidc: { enabled: false } }; }
  if (options.passkeys && passkeysSupported() && onSignedIn && !form.querySelector('.passkey-btn')) {
    const anchor = form.querySelector('label');
    anchor.insertAdjacentHTML('beforebegin', `
      <button type="button" class="btn passkey-btn wide">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.3 0 2.5.3 3.5.9"/><circle cx="17.5" cy="13.5" r="2.5"/><path d="M17.5 16v5l1.5-1.2M17.5 18.6l1.3 1"/></svg>
        <span>Sign in with a passkey</span>
      </button>`);
    const btn = form.querySelector('.passkey-btn');
    btn.onclick = async () => {
      const err = document.getElementById('login-error');
      if (err) err.textContent = '';
      btn.disabled = true;
      try {
        const account = await signInWithPasskey();
        if (account) onSignedIn(account);
      } catch (e) {
        if (err) err.textContent = e.message;
      }
      btn.disabled = false;
    };
  }
  const providers = options.providers ?? [];
  if ((options.oidc.enabled || providers.length) && !form.querySelector('.sso-btn')) {
    const anchor = form.querySelector('label');
    const arrow = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4.5h4.5v15H14"/><path d="M10 8l4 4-4 4M14 12H4.5"/></svg>';
    const only = !options.password && (options.oidc.enabled ? 1 : 0) + providers.length === 1;
    anchor.insertAdjacentHTML('beforebegin', `
      ${options.oidc.enabled ? `<a class="btn sso-btn wide${only ? ' primary' : ''}" href="${esc(options.oidc.startUrl ?? '/api/auth/oidc/start')}">
        ${arrow}<span>${esc(options.oidc.label)}</span></a>` : ''}
      ${providers.map((p) => `<a class="btn sso-btn wide${only ? ' primary' : ''}" data-provider="${esc(p.id)}" href="${esc(p.startUrl)}">
        ${arrow}<span>Continue with ${esc(p.name)}</span></a>`).join('')}
      ${options.password ? '<div class="or-divider" role="separator"><span>or with your password</span></div>' : ''}`);
  } else if (options.password && form.querySelector('.passkey-btn') && !form.querySelector('.or-divider')) {
    form.querySelector('label').insertAdjacentHTML('beforebegin',
      '<div class="or-divider" role="separator"><span>or with your password</span></div>');
  }
  if (!options.password) {
    form.querySelectorAll('label, button[type=submit]').forEach((el) => { el.hidden = true; });
  }
}

let resumed = false;

/**
 * Handles ?sso_error=… and ?sso=2fa after the provider sent the browser back.
 * Returns true when the 2FA step took over the sign-in box.
 */
export async function resumeSso({ form, box, errorEl, onSignedIn, onRestart }) {
  if (resumed) return false;
  resumed = true;
  const params = new URLSearchParams(location.search);
  const error = params.get('sso_error');
  const twofa = params.get('sso') === '2fa';
  if (!error && !twofa) return false;
  history.replaceState(null, '', location.pathname + location.hash);

  if (error) {
    errorEl.textContent = SSO_ERRORS[error] ?? SSO_ERRORS.failed;
    return false;
  }
  try {
    const pending = await api('/api/auth/2fa/pending');
    form.hidden = true;
    box.hidden = false;
    signInSecondStep(box, { stage: pending.stage, email: pending.email, onSignedIn, onRestart });
    return true;
  } catch {
    errorEl.textContent = SSO_ERRORS.expired;
    return false;
  }
}
