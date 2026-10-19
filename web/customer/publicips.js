// Customer portal: public IPv4 addresses of a server (Overview tab), the optional IPv6 /64
// of each, and reverse DNS for both.
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
          netmask <span class="mono">${esc(a.netmask)}</span>, gateway <span class="mono">${esc(a.gateway)}</span>${a.dns.length ? `, DNS <span class="mono">${esc(a.dns.join(', '))}</span>` : ''}${a.ipv6?.on ? `;
          IPv6 <span class="mono">${esc(a.ipv6.address)}/64</span>, gateway <span class="mono">${esc(a.ipv6.gateway)}</span>` : ''}.</p>
        <p class="small muted">Linux with netplan (check the card name with <span class="mono">ip -br link</span>):</p>
        <pre class="snippet">network:
  version: 2
  ethernets:
    ${iface}:
      match: { macaddress: "${esc((a.mac ?? '').toLowerCase())}" }
      addresses: [${esc(a.address)}/${a.prefix}${a.ipv6?.on ? `, "${esc(a.ipv6.address)}/64"` : ''}]
      routes:
        - { to: default, via: ${esc(a.gateway)} }${a.ipv6?.on ? `
        - { to: "::/0", via: "${esc(a.ipv6.gateway)}", on-link: true }` : ''}
# save as /etc/netplan/60-public.yaml, then: sudo netplan apply</pre>
        <p class="small muted">Windows: <em>Network Connections</em> → the new adapter → IPv4${a.ipv6?.on ? ' and IPv6' : ''} → the values above.</p>
      </details>`;
  }

  /** The IPv6 line under an address: its /64 when on, or the switch to turn it on. */
  function v6Row(a, r) {
    const v = a.ipv6;
    if (!v?.available || (!v.on && !r.ipv6Enabled)) return '';
    return `
      <tr class="ip-v6-row" data-ip="${a.id}">
        <td>${v.on ? `<span class="tag">IPv6</span> <span class="mono">${esc(v.address)}/64</span>
          <br><span class="small muted">Your /64: <span class="mono">${esc(v.prefix)}</span></span>`
          : `<span class="tag">IPv6</span> <span class="muted small">Off. A /64 for this address${v.monthly ? `, ${rp(v.monthly)} / month` : ', no extra charge'}.</span>`}</td>
        <td class="mono">${v.on ? esc(v.gateway) : ''}</td>
        <td>${v.on ? `${v.ptr ? `<span class="mono">${esc(v.ptr)}</span> · ` : '<span class="muted">Not set</span> · '}<button class="link-btn" data-ip-ptr6>${v.ptr ? 'Change' : 'Set reverse DNS'}</button>` : ''}</td>
        <td><div class="row end">${v.on ? '<button class="btn" data-ip-v6-off>Switch IPv6 off</button>' : '<button class="btn" data-ip-v6-on>Switch IPv6 on</button>'}</div></td>
      </tr>`;
  }

  function draw(el, vm, r) {
    if (!r?.enabled) { el.innerHTML = ''; return; }
    const running = vm.status === 'running';
    el.innerHTML = `
      <section class="public-ips" aria-labelledby="pip-title">
        <div class="section-head">
          <h2 id="pip-title">${r.ipv6Enabled || r.addresses.some((a) => a.ipv6?.on) ? 'Public IP addresses' : 'Public IPv4'}</h2>
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
              ${v6Row(a, r)}
              ${a.apply === 'manual' ? `<tr class="ip-help-row"><td colspan="4">${manualHelp(a)}</td></tr>` : ''}`).join('')}
            </tbody></table></div>
          <p class="small muted">Only these addresses can be used on their network cards (the firewall drops anything else).
            The public card becomes the server's default route${r.addresses.some((a) => a.ipv6?.on) ? ' (IPv6 too)' : ''}.</p>`
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
      } else if (t.hasAttribute('data-ip-v6-on') || t.hasAttribute('data-ip-v6-off')) {
        const on = t.hasAttribute('data-ip-v6-on');
        const v = addr.ipv6;
        const msg = on ? `Switch IPv6 on for ${addr.address}? The server gets ${v.address}/64 (the whole ${v.prefix} is yours) on the same network card.${v.monthly ? ` It costs ${rp(v.monthly)} per month (before tax), billed with the server.` : ''}`
          : `Switch IPv6 off for ${addr.address}? The server loses ${v.prefix} and its reverse DNS.`;
        if (!(await confirmAction(msg, on ? 'Switch on' : 'Switch off'))) return true;
        t.disabled = true;
        const x = await api(`/api/ips/${addr.id}/ipv6`, { method: 'PUT', body: { enabled: on } });
        toast(on ? (x.apply === 'restart' ? `IPv6 ${x.address} added; active after a restart from this panel` : x.apply === 'manual' ? `IPv6 ${x.address} added; set it up inside the server` : `IPv6 ${x.address} is active`)
          : (x.apply === 'restart' ? 'IPv6 switched off; gone from the server after a restart' : 'IPv6 switched off'));
      } else if (t.hasAttribute('data-ip-ptr6')) {
        const h = await promptText(`Reverse DNS for ${addr.ipv6.address}`, { value: addr.ipv6.ptr ?? '', hint: 'A full host name, e.g. mail.example.com. Make its AAAA record point to this address first. Empty removes it.', okLabel: 'Save' });
        if (h === null) return true;
        const x = await api(`/api/ips/${addr.id}/ptr`, { method: 'PUT', body: { hostname: h, family: 6 } });
        toast(x.ptr ? (x.published ? `Reverse DNS set to ${x.ptr}` : `Saved; your provider publishes it (${x.ptr})`) : 'Reverse DNS removed');
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
