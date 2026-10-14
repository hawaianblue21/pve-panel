// "Sign-in methods" card on the account page: Google, Microsoft and GitHub
// accounts linked to this panel account (set up by the owner in Settings).
import { api, esc, toast, fail, confirmAction } from '/shared/ui.js';

const when = (d) => (d ? new Date(`${d.replace(' ', 'T')}Z`).toLocaleDateString() : 'never');
const NAMES = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub' };
const ERRORS = {
  reauth: 'For your security, sign out and sign in again, then link the provider within 15 minutes.',
  linked_elsewhere: 'That provider account is already linked to another panel account.',
  provider_linked: 'Another account of this provider is already linked. Unlink it first.',
  denied: 'Linking was cancelled at the provider.',
  unavailable: 'This provider is not available right now.',
};

/** Shows the result of a link that just came back from the provider (once). */
function resultFromUrl(container) {
  const params = new URLSearchParams(location.search);
  const linked = params.get('sso_linked');
  const error = params.get('sso_error');
  if (!linked && !error) return;
  history.replaceState(null, '', location.pathname + location.hash);
  if (linked) toast(`${NAMES[linked] ?? 'The provider'} is linked. You can sign in with it now.`);
  if (error) {
    container.dataset.error = ERRORS[error] ?? 'Linking did not work. Please try again.';
  }
}

export async function renderIdentities(container) {
  resultFromUrl(container);
  let data;
  try { data = await api('/api/account/identities'); } catch (err) { container.innerHTML = ''; return fail(err); }
  if (!data.linked.length && !data.available.length) { container.innerHTML = ''; return; }
  const error = container.dataset.error;
  delete container.dataset.error;

  container.innerHTML = `
    <section class="security-card identities-card">
      <div>
        <h2 class="twofa-title">Sign-in methods</h2>
        <p class="muted">Sign in with an account you already have. Keep at least two ways to sign in, so you can still get in if you lose one.</p>
        ${error ? `<p class="small warn-text" role="alert">${esc(error)}</p>` : ''}
        <ul class="passkey-list">
          ${data.linked.map((l) => `
            <li data-identity="${esc(l.provider)}">
              <div>
                <strong>${esc(l.name)}</strong>
                <span class="muted small">${esc(l.email ?? l.account ?? '')} · linked ${esc(when(l.linkedAt))} · last used ${esc(when(l.lastUsedAt))}</span>
              </div>
              <div class="row"><button class="btn danger" data-unlink>Unlink</button></div>
            </li>`).join('')}
          ${data.available.map((p) => `
            <li>
              <div>
                <strong>${esc(p.name)}</strong>
                <span class="muted small">Not linked</span>
              </div>
              <div class="row"><a class="btn" href="${esc(p.startUrl)}?link=1">Link ${esc(p.name)}</a></div>
            </li>`).join('')}
        </ul>
        ${data.available.length && !data.recent ? '<p class="small muted">Linking needs a sign-in from the last 15 minutes; otherwise you are asked to sign in again.</p>' : ''}
      </div>
    </section>`;

  container.querySelectorAll('[data-identity]').forEach((li) => {
    const provider = li.dataset.identity;
    li.querySelector('[data-unlink]').onclick = async () => {
      if (!(await confirmAction(`Unlink ${NAMES[provider] ?? provider}? You can no longer sign in with it.`, 'Unlink'))) return;
      try {
        await api(`/api/account/identities/${encodeURIComponent(provider)}`, { method: 'DELETE' });
        toast(`${NAMES[provider] ?? provider} unlinked`);
        renderIdentities(container);
      } catch (err) { fail(err); }
    };
  });
}
