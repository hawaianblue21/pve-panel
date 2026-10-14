// Customer portal: public IPv4 addresses of a server (Overview tab), with reverse DNS.
import { api, esc, toast, fail, confirmAction, promptText } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const rp = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;

/** ctx: { getVm(): the server shown, refresh(): redraw the overview } */
export function createPublicIps(ctx) {
  const cache = new Map();            // vmid → last answer

  /** Fills the placeholder #public-ips of the overview; draws from cache first, then refreshes. */
  function render(el, vm) {
    if (!el) return;
    if (cache.has(vm.vmid)) draw(el, vm, cache.get(vm.vmid));
    api(`/api/vms/${vm.vmid}/ips`).then((r) => {
      cache.set(vm.vmid, r);
      const now = document.getElementById('public-ips');
      if (now && ctx.getVm()?.vmid === vm.vmid) draw(now, vm, r);
    }).catch(() => {});
  }

  function manualHelp(a) {
    const iface = 'ens19';          // the second virtio NIC on most Linux images
    return `
      <details class="ip-manual"><summary>Set it up inside the server</summary>
        <p class="small muted">This server has no cloud-init, so configure the new network card yourself
          (MAC <span class="mono">${esc(a.mac ?? '')}</span>): address <span class="mono">${esc(a.address)}</span>,
          netmask <span class="mono">${esc(a.netmask)}</span>, gateway <span class="mono">${esc(a.gateway)}</span>${a.dns.length ? `, DNS <span class="mono">${esc(a.dns.join(', '))}</span>` : ''}.</p>
        <p class="small muted">Linux with netplan (check the card name with <span class="mono">ip -br link</span>):</p>
        <pre class="snippet">network:
  version: 2
  ethernets:
    ${iface}:
      match: { macaddress: "${esc((a.mac ?? '').toLowerCase())}" }
      addresses: [${esc(a.address)}/${a.prefix}]
      routes: [{ to: default, via: ${esc(a.gateway)} }]
# save as /etc/netplan/60-public.yaml, then: sudo netplan apply</pre>
        <p class="small muted">Windows: <em>Network Connections</em> → the new adapter → IPv4 → the values above.</p>
      </details>`;
  }

  function draw(el, vm, r) {
    if (!r?.enabled) { el.innerHTML = ''; return; }
    const running = vm.status === 'running';
    el.innerHTML = `
      <section class="public-ips" aria-labelledby="pip-title">
        <div class="section-head">
          <h2 id="pip-title">Public IPv4</h2>
          ${r.canAssign ? `<button class="btn" data-ip-add>${icon('plus')}<span>Add public address${r.priceMonthly ? ` · ${rp(r.priceMonthly)} / month` : ''}</span></button>`
            : `<span class="small muted">${r.addresses.length >= r.maxPerServer ? `At most ${r.maxPerServer} per server` : 'No address free right now; please contact support'}</span>`}
        </div>
        ${r.addresses.length ? `
          <div class="table-wrap"><table class="table ip-table">
            <thead><tr><th>Address</th><th>Gateway</th><th>Reverse DNS</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${r.addresses.map((a) => `
              <tr data-ip="${a.id}">
                <td><span class="mono">${esc(a.address)}/${a.prefix}</span>
                  ${a.apply === 'restart' ? `<br><span class="tag warn">Active after a restart</span> <span class="small muted">${running ? 'Restart the server from this panel.' : 'Start the server from this panel.'}</span>` : ''}
                  ${a.apply === 'manual' ? '<br><span class="tag warn">Set up inside the server</span>' : ''}</td>
                <td class="mono">${esc(a.gateway)}</td>
                <td>${a.ptr ? `<span class="mono">${esc(a.ptr)}</span> · ` : '<span class="muted">Not set</span> · '}<button class="link-btn" data-ip-ptr>${a.ptr ? 'Change' : 'Set reverse DNS'}</button></td>
                <td><div class="row end"><button class="btn danger" data-ip-release>Release</button></div></td>
              </tr>
              ${a.apply === 'manual' ? `<tr class="ip-help-row"><td colspan="4">${manualHelp(a)}</td></tr>` : ''}`).join('')}
            </tbody></table></div>
          <p class="small muted">Only these addresses can be used on their network cards (the firewall drops anything else).
            The public card becomes the server's default route.</p>`
        : '<p class="muted small">No public address. The server reaches the internet through your private network.</p>'}
      </section>`;
  }

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return false;
    const vm = ctx.getVm();
    const r = vm && cache.get(vm.vmid);
    const addr = t.closest('[data-ip]') && r?.addresses.find((a) => a.id === Number(t.closest('[data-ip]').dataset.ip));
    try {
      if (t.hasAttribute('data-ip-add')) {
        if (!(await confirmAction(`Add a public IPv4 address to ${vm.name}?${r.priceMonthly ? ` It costs ${rp(r.priceMonthly)} per month (before tax), billed with the server.` : ''}`, 'Add address'))) return true;
        t.disabled = true;
        const a = await api(`/api/vms/${vm.vmid}/ips`, { method: 'POST' });
        toast(a.apply === 'restart' ? `${a.address} added; active after a restart from this panel` : a.apply === 'manual' ? `${a.address} added; set it up inside the server` : `${a.address} is active`);
      } else if (t.hasAttribute('data-ip-release')) {
        if (!(await confirmAction(`Release ${addr.address}? The server loses this address; it can't be reserved back.`, 'Release'))) return true;
        await api(`/api/ips/${addr.id}`, { method: 'DELETE' });
        toast(`${addr.address} released`);
      } else if (t.hasAttribute('data-ip-ptr')) {
        const h = await promptText(`Reverse DNS for ${addr.address}`, { value: addr.ptr ?? '', hint: 'A full host name, e.g. mail.example.com. Make its A record point to this address first. Empty removes it.', okLabel: 'Save' });
        if (h === null) return true;
        const x = await api(`/api/ips/${addr.id}/ptr`, { method: 'PUT', body: { hostname: h } });
        toast(x.ptr ? (x.published ? `Reverse DNS set to ${x.ptr}` : `Saved; your provider publishes it (${x.ptr})`) : 'Reverse DNS removed');
      } else {
        return false;
      }
      cache.set(vm.vmid, await api(`/api/vms/${vm.vmid}/ips`));
      ctx.refresh();
    } catch (err) { fail(err); t.disabled = false; }
    return true;
  }

  return { render, onClick };
}
