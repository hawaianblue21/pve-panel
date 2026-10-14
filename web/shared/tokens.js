// "API tokens" card on the account page of both portals: create a token (shown
// once, with a curl example), see when each was last used, revoke. Owners of the
// admin portal also see every administrator's tokens.
import { api, esc, toast, fail, confirmAction } from '/shared/ui.js';

const SCOPES = {
  power: ['Power', 'Start, shut down, restart, force-stop'],
  servers: ['Servers', 'Create, delete, reinstall, resize, snapshots, updates'],
  storage: ['Storage', 'Volumes and buckets'],
  network: ['Network', 'Public IPs, reverse DNS, VPN devices'],
  billing: ['Billing', 'Invoices, renewals, payments, auto-renew'],
  support: ['Support', 'Open and answer tickets'],
};
const when = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

/**
 * el: container; portal: 'customer' | 'admin'; owner: show all administrators' tokens.
 */
export function renderTokens(el, { portal, owner = false }) {
  if (!el) return;
  const base = portal === 'admin' ? '/api/admin/tokens' : '/api/tokens';
  let data = { tokens: [] };
  let all = null;
  let created = null;        // the new token, shown once

  async function load() {
    try {
      data = await api(base);
      all = owner ? (await api('/api/admin/tokens/all')).tokens : null;
    } catch (err) { fail(err); }
    draw();
  }

  const example = (t) => (portal === 'admin'
    ? `curl -H "Authorization: Bearer ${t}" ${location.origin}/api/admin/vms`
    : `curl -H "Authorization: Bearer ${t}" ${location.origin}/api/vms
curl -X POST -H "Authorization: Bearer ${t}" ${location.origin}/api/vms/<id>/power/reboot`);

  function draw() {
    el.innerHTML = `
      <section class="security-card settings-card tokens-card">
        <div class="settings-head">
          <h2 class="twofa-title">API tokens</h2>
          <p class="muted">For scripts and integrations: send <span class="mono">Authorization: Bearer &lt;token&gt;</span>.
            ${portal === 'admin' ? 'A token can do what your role allows (or only read); it never manages tokens, administrators or roles.'
              : 'A token can always read your servers, storage, billing and tickets, and change only what you allow. It never signs in, changes your account security or opens the console.'}</p>
        </div>
        ${created ? `
          <div class="notice warn secret-box" role="alert">
            <p><strong>Copy the token now. It won't be shown again.</strong></p>
            <p><span class="selectable" id="new-token">${esc(created.token)}</span></p>
            <pre class="snippet">${esc(example(created.token))}</pre>
            <div class="row"><button class="btn" data-token-copy>Copy token</button><button class="btn primary" data-token-done>I've copied it</button></div>
          </div>` : ''}
        ${data.tokens.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Name</th><th>${portal === 'admin' ? 'Access' : 'May change'}</th><th>Valid until</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${data.tokens.map((t) => `
              <tr data-token="${t.id}"><td><strong>${esc(t.name)}</strong><br><span class="mono small muted">${esc(t.prefix)}…</span></td>
                <td class="small">${portal === 'admin' ? (t.readOnly ? 'Read only' : 'As your role') : (t.scopes.map((s) => esc(SCOPES[s]?.[0] ?? s)).join(', ') || 'Read only')}</td>
                <td class="small">${t.expiresAt ? `${t.expired ? '<span class="tag warn">Expired</span> ' : ''}${esc(when(t.expiresAt))}` : 'No end'}</td>
                <td class="small">${esc(when(t.lastUsedAt))}${t.lastUsedIp ? `<br><span class="muted mono">${esc(t.lastUsedIp)}</span>` : ''}</td>
                <td><div class="row end"><button class="btn danger" data-token-revoke>Revoke</button></div></td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted small">No tokens.</p>'}
        <form class="token-form email-form" novalidate>
          <h3 class="h3">New token</h3>
          <div class="grid-2">
            <label>Name <input name="name" maxlength="60" placeholder="${portal === 'admin' ? 'monitoring' : 'deploy script'}" required></label>
            <label>Valid for <select name="days"><option value="7">7 days</option><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="">No end</option></select></label>
          </div>
          ${portal === 'admin'
            ? '<label class="inline-check"><input type="checkbox" name="readOnly" checked> Read only</label>'
            : `<fieldset class="plain-fieldset"><legend class="small muted">May also change (reading is always allowed)</legend>
                <div class="choices">${Object.entries(SCOPES).map(([k, [l, d]]) => `
                  <label class="choice"><input type="checkbox" name="scope" value="${k}"><span><strong>${l}</strong><br><span class="small muted">${d}</span></span></label>`).join('')}</div></fieldset>`}
          <div class="row"><button class="btn primary">Create token</button></div>
        </form>
        ${all ? `
          <h3 class="h3">All administrators' tokens</h3>
          ${all.length ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Administrator</th><th>Name</th><th>Access</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${all.map((t) => `<tr data-any-token="${t.id}"><td>${esc(t.email)}</td><td>${esc(t.name)}</td><td class="small">${t.readOnly ? 'Read only' : 'As the role'}</td>
              <td class="small">${esc(when(t.lastUsedAt))}</td><td><div class="row end"><button class="btn danger" data-token-revoke-any>Revoke</button></div></td></tr>`).join('')}</tbody></table></div>`
            : '<p class="muted small">None.</p>'}` : ''}
      </section>`;
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.hasAttribute('data-token-copy')) {
        await navigator.clipboard?.writeText(created.token).then(() => toast('Token copied'), () => toast('Select the token and copy it'));
      } else if (t.hasAttribute('data-token-done')) {
        created = null; draw();
      } else if (t.hasAttribute('data-token-revoke')) {
        const tok = data.tokens.find((x) => x.id === Number(t.closest('[data-token]').dataset.token));
        if (!(await confirmAction(`Revoke ${tok.name}? Programs using it stop working at once.`, 'Revoke'))) return;
        await api(`${base}/${tok.id}`, { method: 'DELETE' });
        toast('Token revoked'); await load();
      } else if (t.hasAttribute('data-token-revoke-any')) {
        const tok = all.find((x) => x.id === Number(t.closest('[data-any-token]').dataset.anyToken));
        if (!(await confirmAction(`Revoke ${tok.name} of ${tok.email}?`, 'Revoke'))) return;
        await api(`/api/admin/tokens/all/${tok.id}`, { method: 'DELETE' });
        toast('Token revoked'); await load();
      }
    } catch (err) { fail(err); }
  });

  el.addEventListener('submit', async (e) => {
    if (!e.target.classList.contains('token-form')) return;
    e.preventDefault();
    const f = e.target;
    if (!f.reportValidity()) return;
    const body = { name: f.elements.name.value.trim(), days: f.elements.days.value ? Number(f.elements.days.value) : null };
    if (portal === 'admin') body.readOnly = f.elements.readOnly.checked;
    else body.scopes = [...f.querySelectorAll('input[name=scope]:checked')].map((x) => x.value);
    try {
      created = await api(base, { method: 'POST', body });
      toast('Token created');
      await load();
    } catch (err) { fail(err); }
  });

  load();
}
