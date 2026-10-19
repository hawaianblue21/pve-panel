import { icon } from '/shared/icons.js';
import { renderSecurity } from '/shared/twofa.js';
import { renderPasskeys } from '/shared/passkeys.js';
import { renderIdentities } from '/shared/identities.js';
import { renderTokens } from '/shared/tokens.js';
import { renderAppearance } from '/shared/appearance.js';
import { applyScheme } from '/shared/icons.js';
import { createInfra } from '/infra.js';
import { createDesk } from '/desk.js';
import { createBilling } from '/billing.js';
import { createVolumes } from '/volumes.js';
import { createIpam } from '/ipam.js';
import { createHosts } from '/hosts.js';
import { createJobs } from '/jobs.js';
import { createPlans } from '/plans.js';

// Administration area: assign servers, manage customers, read the activity log.
// Receives the shared helpers from app.js so it behaves like the rest of the panel.

const ACTION_LABELS = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  power_start: 'Started server',
  power_shutdown: 'Shut down server',
  power_reboot: 'Restarted server',
  power_stop: 'Force stopped server',
  snapshot_create: 'Took snapshot',
  snapshot_rollback: 'Rolled back snapshot',
  snapshot_delete: 'Deleted snapshot',
  console_open: 'Opened console',
  admin_user_create: 'Added user',
  admin_user_delete: 'Deleted user',
  admin_password_reset: 'Reset password',
  admin_grant: 'Granted admin rights',
  admin_revoke: 'Removed admin rights',
  admin_vm_assign: 'Assigned server',
  admin_vm_unassign: 'Unassigned server',
  admin_vm_rename: 'Renamed server',
  admin_login: 'Signed in to administration',
  admin_login_failed: 'Failed administration sign-in',
  admin_limits: 'Changed limits',
  admin_template_offer: 'Offered template',
  admin_template_withdraw: 'Withdrew template',
  server_create_started: 'Started creating server',
  server_created: 'Created server',
  server_create_failed: 'Server creation failed',
  server_delete_started: 'Started deleting server',
  server_deleted: 'Deleted server',
  vpn_device_add: 'Added VPN device',
  admin_power_start: 'Started server (admin)',
  admin_power_shutdown: 'Shut down server (admin)',
  admin_power_reboot: 'Restarted server (admin)',
  admin_power_stop: 'Force stopped server (admin)',
  admin_server_deleted: 'Deleted server (admin)',
  admin_user_delete_started: 'Started deleting customer',
  admin_user_delete_failed: 'Deleting customer failed',
  admin_invite_sent: 'Sent invitation',
  server_resized: 'Changed server size',
  server_reinstall_started: 'Started reinstalling server',
  server_expired: 'Server expired and was stopped',
  server_expired_deleted: 'Expired server deleted',
  server_expiry_extended: 'Extended server expiry',
  server_expiry_set: 'Set server expiry',
  server_expiry_removed: 'Removed server expiry',
  admin_expiry_rule: 'Changed customer expiry rule',
  admin_expiry_settings: 'Changed expiry settings',
  admin_expiry_run: 'Ran expiry check',
  admin_appearance: 'Changed the color scheme',
  admin_winupdates: 'Changed Windows update setting',
  winupdate_started: 'Started Windows updates',
  winupdate_finished: 'Windows updates finished',
  winupdate_failed: 'Windows updates failed',
  linuxupdate_started: 'Started Linux updates',
  linuxupdate_finished: 'Linux updates finished',
  linuxupdate_failed: 'Linux updates failed',
  server_reinstalled: 'Reinstalled server',
  server_reinstall_failed: 'Reinstalling server failed',
  invite_accepted: 'Accepted invitation, password set',
  admin_email_settings: 'Changed email settings',
  admin_email_settings_removed: 'Removed email settings',
  admin_email_test: 'Sent test email',
  twofa_enabled: 'Turned on two-factor authentication',
  twofa_disabled: 'Turned off two-factor authentication',
  twofa_recovery_codes: 'Created new recovery codes',
  admin_twofa_require: 'Required two-factor authentication',
  admin_twofa_unrequire: 'Made two-factor authentication optional',
  admin_twofa_reset: 'Reset two-factor authentication',
  passkey_added: 'Added a passkey',
  passkey_removed: 'Removed a passkey',
  admin_passkeys_removed: 'Removed passkeys of a user',
  cli_twofa_reset: 'Reset two-factor authentication (command line)',
  sso_login_failed: 'Failed single sign-on',
  admin_sso_login_failed: 'Failed single sign-on (administration)',
  sso_account_linked: 'Linked account to single sign-on',
  sso_identity_linked: 'Linked a sign-in provider',
  ticket_created: 'Opened a support ticket',
  ticket_replied: 'Replied to a ticket',
  ticket_closed: 'Closed a ticket',
  ticket_message_from_zammad: 'Ticket message from Zammad',
  admin_ticket_reply: 'Answered a ticket',
  admin_ticket_note: 'Added an internal note to a ticket',
  admin_ticket_update: 'Changed a ticket',
  admin_kb_create: 'Created a knowledge-base article',
  admin_kb_update: 'Changed a knowledge-base article',
  admin_kb_delete: 'Deleted a knowledge-base article',
  admin_kb_draft_from_ticket: 'Drafted an article from a ticket',
  admin_zammad_settings: 'Changed the Zammad connection',
  admin_ai_settings: 'Changed the AI assistant settings',
  ai_conversation_started: 'Started a conversation with the assistant',
  ai_handover: 'Assistant conversation became a ticket',
  ai_error: 'AI assistant error',
  zammad_webhook_refused: 'Refused a Zammad webhook call',
  sso_identity_unlinked: 'Unlinked a sign-in provider',
  admin_sso_provider: 'Changed single sign-on provider',
  sso_account_created: 'Account created by single sign-on',
  admin_sso_unlink: 'Unlinked account from single sign-on',
  tailscale_connect_started: 'Started connecting to Tailscale',
  tailscale_connected: 'Connected to Tailscale',
  tailscale_connect_failed: 'Tailscale connection failed',
  tailscale_disconnected: 'Disconnected from Tailscale',
  vpn_device_remove: 'Removed VPN device',
  admin_vpn_device_remove: 'Removed VPN device',
  admin_role_create: 'Created an administrator role',
  admin_role_update: 'Changed an administrator role',
  admin_role_delete: 'Deleted an administrator role',
  admin_role_assign: 'Changed the role of an administrator',
  admin_datacenter_create: 'Added a datacenter',
  admin_datacenter_update: 'Changed a datacenter',
  admin_datacenter_delete: 'Deleted a datacenter',
  admin_pool_create: 'Created a resource pool',
  admin_pool_update: 'Changed a resource pool',
  admin_pool_delete: 'Deleted a resource pool',
  admin_pool_member_add: 'Added a customer to a resource pool',
  admin_pool_member_remove: 'Removed a customer from a resource pool',
  admin_s3_settings: 'Changed object storage settings',
  s3_bucket_create: 'Created a bucket',
  s3_bucket_delete: 'Deleted a bucket',
  s3_key_issued: 'Issued an object storage access key',
  admin_gpu_profile_create: 'Added a GPU profile',
  admin_gpu_profile_update: 'Changed a GPU profile',
  admin_gpu_profile_delete: 'Deleted a GPU profile',
  admin_gpu_attach: 'Attached a GPU',
  admin_gpu_detach: 'Detached a GPU',
  volume_created: 'Created a volume',
  volume_attached: 'Attached a volume',
  volume_detached: 'Detached a volume',
  volume_resized: 'Enlarged a volume',
  volume_deleted: 'Deleted a volume',
  ip_assigned: 'Added a public IP address',
  ip_released: 'Released a public IP address',
  ip_ptr_set: 'Set reverse DNS',
  ipv6_on: 'Switched IPv6 on',
  ipv6_off: 'Switched IPv6 off',
  admin_ip_pool_create: 'Added a public IP pool',
  admin_node_maintenance_on: 'Put a node into maintenance',
  admin_node_maintenance_off: 'Ended maintenance on a node',
  admin_rollout_created: 'Started an update rollout',
  admin_cluster_added: 'Connected a Proxmox cluster',
  admin_cluster_updated: 'Changed a Proxmox cluster',
  admin_cluster_removed: 'Removed a Proxmox cluster',
  admin_rollout_pause: 'Paused an update rollout',
  admin_rollout_resume: 'Resumed an update rollout',
  admin_rollout_cancel: 'Cancelled an update rollout',
  admin_rollout_done: 'Update rollout finished',
  api_token_created: 'Created an API token',
  api_token_revoked: 'Revoked an API token',
  admin_plan_create: 'Added a plan',
  admin_plan_update: 'Changed a plan',
  admin_plan_delete: 'Deleted a plan',
  admin_plan_settings: 'Changed plan settings',
  server_plan_changed: 'Moved a server to a larger plan',
  invoice_created: 'Invoice created',
  invoice_paid: 'Invoice paid',
  invoice_refunded: 'Invoice refunded to the wallet',
  invoice_transfer_reported: 'Reported a bank transfer',
  payment_checkout: 'Opened a payment page',
  payment_checkout_failed: 'Payment page could not be opened',
  payment_webhook_refused: 'Refused a payment notification',
  payment_amount_mismatch: 'Payment amount too low',
  payment_duplicate_to_wallet: 'Second payment kept as balance',
  auto_renew_changed: 'Changed auto-renew',
  admin_invoice_void: 'Cancelled an invoice',
  admin_wallet_adjust: 'Adjusted a wallet',
  admin_server_price: 'Set a server price',
  admin_billing_settings: 'Changed billing settings',
};

export function generatePassword(length = 16) {
  // No look-alike characters (0/O, 1/l/I), so it can be read out or typed by hand.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function createAdmin({ root, api, toast, fail, confirmAction, promptText, esc, getMe, onAbout }) {
  const st = {
    tab: 'overview', users: [], vms: [], audit: [], filter: '', newUser: null,
    templates: [], storages: {}, vpn: null, perms: null,
  };
  // Access control, resource pools, object storage and GPUs (own module)
  const infra = createInfra({ root, api, toast, fail, confirmAction, esc });
  // Ticket desk and knowledge base (own module)
  const desk = createDesk({ root, api, toast, fail, confirmAction, esc, getMe });
  // Invoices, payments and wallets (own module)
  const billing = createBilling({ root, api, toast, fail, confirmAction, esc });
  // Block storage tiers and volumes (own module)
  const volumes = createVolumes({ root, api, toast, fail, esc });
  // Public IPv4 pools and addresses (own module)
  const ipam = createIpam({ root, api, toast, fail, confirmAction, promptText, esc });
  // Background jobs, update fleet and rollouts (own module)
  const jobs = createJobs({ root, api, toast, fail, confirmAction, esc });
  // Overview dashboard and Proxmox nodes (own module)
  const hosts = createHosts({
    root, api, toast, fail, confirmAction, promptText, esc,
    labels: { has: (tab) => allowedTab(tab), action: (a) => ACTION_LABELS[a] ?? a },
    openTab: (tab) => { st.tab = tab; render(); load(); },
  });
  // Plans: sizes with a price (own module)
  const plans = createPlans({ root, api, toast, fail, confirmAction, esc });
  // Which permission a tab needs (the server checks every request as well)
  const TAB_PERMISSION = {
    servers: 'servers.read', users: 'customers.read', templates: 'servers.read', vpn: 'network.read',
    activity: 'audit.read', settings: 'settings.read', account: null, about: null,
  };
  const allowedTab = (id) => (infra.handles(id) ? infra.tabs().some(([t]) => t === id)
    : desk.handles(id) ? desk.tabs().some(([t]) => t === id)
    : billing.handles(id) ? billing.tabs().some(([t]) => t === id)
    : volumes.handles(id) ? volumes.tabs().some(([t]) => t === id)
    : ipam.handles(id) ? ipam.tabs().some(([t]) => t === id)
    : hosts.handles(id) ? hosts.tabs().some(([t]) => t === id)
    : jobs.handles(id) ? jobs.tabs().some(([t]) => t === id)
    : plans.handles(id) ? plans.tabs().some(([t]) => t === id)
    : !TAB_PERMISSION[id] || !st.perms || st.perms.has(TAB_PERMISSION[id]));
  const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;

  const utc = (s) => new Date(`${s.replace(' ', 'T')}Z`);

  // ---- loading ----------------------------------------------------------
  async function load({ quiet = false } = {}) {
    const body = root.querySelector('#admin-body');
    if (!quiet) body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (infra.handles(st.tab)) {
        await infra.load(st.tab);
      } else if (desk.handles(st.tab)) {
        await desk.load(st.tab);
      } else if (billing.handles(st.tab)) {
        await billing.load(st.tab);
      } else if (volumes.handles(st.tab)) {
        await volumes.load(st.tab);
      } else if (ipam.handles(st.tab)) {
        await ipam.load(st.tab);
      } else if (hosts.handles(st.tab)) {
        await hosts.load(st.tab);
      } else if (jobs.handles(st.tab)) {
        await jobs.load(st.tab);
      } else if (plans.handles(st.tab)) {
        await plans.load(st.tab);
      } else if (st.tab === 'servers') {
        [st.vms, st.users] = await Promise.all([api('/api/admin/vms'), api('/api/admin/users')]);
      } else if (st.tab === 'users') {
        [st.users, st.email] = await Promise.all([api('/api/admin/users'), api('/api/admin/settings/email')]);
        if (!quiet) setTimeout(watchDeletions);
      } else if (st.tab === 'settings') {
        [st.email, st.expiry, st.appearance, st.winupdates, st.sso, st.branding, st.zammad, st.ai, st.billing] = await Promise.all([
          api('/api/admin/settings/email'), api('/api/admin/settings/expiry'), api('/api/admin/settings/appearance'),
          api('/api/admin/settings/winupdates'), api('/api/admin/settings/sso'), api('/api/admin/settings/branding'),
          api('/api/admin/settings/zammad').catch(() => null), api('/api/admin/settings/ai').catch(() => null),
          api('/api/admin/settings/billing').catch(() => null),
        ]);
      } else if (st.tab === 'about') {
        st.about = await api(`/api/admin/about${st.refreshAbout ? '?refresh=1' : ''}`);
        st.refreshAbout = false;
        onAbout?.(st.about);
      } else if (st.tab === 'account') {
        // rendered by the shared security panel
      } else if (st.tab === 'vpn') {
        st.vpn = await api('/api/admin/vpn');
      } else if (st.tab === 'templates') {
        ({ templates: st.templates, storages: st.storages } = await api('/api/admin/templates'));
      } else {
        await loadActivity();
      }
      renderTab();
    } catch (err) {
      body.innerHTML = '';
      fail(err);
    }
  }

  // ---- shell ------------------------------------------------------------
  function render() {
    const tabs = [...hosts.tabs().filter(([id]) => id === 'overview'), ['servers', 'Servers'], ['users', 'Customers'], ...desk.tabs(), ...billing.tabs(), ...plans.tabs(), ['templates', 'Templates'], ...jobs.tabs(), ['vpn', 'VPN'],
      ...infra.tabs(), ...hosts.tabs().filter(([id]) => id === 'hosts'), ...volumes.tabs(), ...ipam.tabs(), ['activity', 'Activity'], ['account', 'Your account'], ['settings', 'Settings'], ['about', 'About']]
      .filter(([id]) => allowedTab(id));
    root.innerHTML = `
      <div class="admin-inner">
        <h1>Administration</h1>
        <div class="tabs" role="tablist">
          ${tabs.map(([id, label]) =>
            `<button class="tab" role="tab" data-admin-tab="${id}" aria-selected="${st.tab === id}">${label}</button>`).join('')}
        </div>
        <section id="admin-body"></section>
      </div>`;
    // many tabs: keep the open one in view
    root.querySelector('.tab[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderTab() {
    if (infra.handles(st.tab)) infra.render(st.tab);
    if (desk.handles(st.tab)) desk.render(st.tab);
    if (billing.handles(st.tab)) billing.render(st.tab);
    if (volumes.handles(st.tab)) volumes.render(st.tab);
    if (ipam.handles(st.tab)) ipam.render(st.tab);
    if (hosts.handles(st.tab)) hosts.render(st.tab);
    if (jobs.handles(st.tab)) jobs.render(st.tab);
    if (plans.handles(st.tab)) plans.render(st.tab);
    if (st.tab === 'servers') renderServers();
    if (st.tab === 'users') renderUsers();
    if (st.tab === 'templates') renderTemplates();
    if (st.tab === 'vpn') renderVpn();
    if (st.tab === 'activity') renderActivity();
    if (st.tab === 'account') {
      const body = root.querySelector('#admin-body');
      body.innerHTML = '<div id="admin-2fa"></div><div id="admin-passkeys" class="account-section"></div><div id="admin-identities" class="account-section"></div><div id="admin-appearance" class="account-section"></div><div id="admin-tokens" class="account-section"></div>';
      renderSecurity(body.querySelector('#admin-2fa'), { email: getMe().email });
      renderPasskeys(body.querySelector('#admin-passkeys'));
      renderIdentities(body.querySelector('#admin-identities'));
      renderAppearance(body.querySelector('#admin-appearance'));
      renderTokens(body.querySelector('#admin-tokens'), { portal: 'admin', owner: !st.perms || st.perms.has('rbac.write') });
    }
    if (st.tab === 'about') renderAbout();
    if (st.tab === 'settings') renderSettings();
    if (st.tab !== 'settings' && st.schemePreview) { st.schemePreview = null; applyScheme(st.appearance?.scheme); }
  }

  // ---- servers ----------------------------------------------------------
  function renderServers() {
    root.querySelector('#admin-body').innerHTML = `
      <div class="section-head">
        <p class="muted" style="margin:0" id="vm-summary"></p>
        <input type="search" id="vm-filter" class="filter" placeholder="Filter by ID, name or customer"
               value="${esc(st.filter)}" aria-label="Filter servers">
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>ID</th><th>Name in Proxmox</th><th>Node</th><th>Customer</th><th>Name shown to customer</th><th><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody id="vm-rows"></tbody>
        </table>
      </div>
      <p class="muted small">Changes save immediately. Customers see a server as soon as it's assigned to them.</p>`;
    renderServerRows();
  }

  /** Power and delete buttons, only for servers assigned to a customer. */
  function serverActions(v) {
    if (!v.userId || v.status === 'missing') return '';
    const idle = v.state === 'ready' || v.state === 'failed';
    const on = v.status === 'running';
    const b = (action, ic, label, enabled, cls = '') =>
      `<button class="icon-btn act ${cls}" data-server-action="${action}" title="${label}" aria-label="${label} ${esc(v.name)}" ${enabled ? '' : 'disabled'}>${icon(ic, { size: 17 })}</button>`;
    return `<span class="act-group">
      ${b('start', 'play', 'Start', idle && !on && v.state === 'ready')}
      ${b('shutdown', 'power', 'Shut down', idle && on && v.state === 'ready')}
      ${b('reboot', 'restart', 'Restart', idle && on && v.state === 'ready')}
      ${b('stop', 'stop', 'Force stop', idle && on && v.state === 'ready')}
      ${b('expiry', 'clock', 'Expiry', true)}
      ${b('delete', 'trash', 'Delete server', idle, 'danger')}
    </span>`;
  }

  // Reload the current tab quietly every 3 s until done() says so (max 3 min).
  let watchTimer = null;
  function watch(done) {
    clearInterval(watchTimer);
    const until = Date.now() + 180_000;
    watchTimer = setInterval(async () => {
      if (Date.now() > until) return clearInterval(watchTimer);
      await load({ quiet: true });
      if (done()) clearInterval(watchTimer);
    }, 3000);
  }

  async function waitForTask(upid) {
    for (let i = 0; i < 60 && upid; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api(`/api/admin/tasks/${encodeURIComponent(upid)}`);
      if (s.done) return s;
    }
    return null;
  }

  const POWER_TEXT = {
    start: ['Starting', 'started'], shutdown: ['Shutting down', 'shut down'],
    reboot: ['Restarting', 'restarted'], stop: ['Stopping', 'stopped'],
  };

  async function serverAction(vm, action) {
    if (action === 'expiry') { editServerExpiry(vm); return; }
    if (action === 'delete') {
      const answer = await promptText(`Type ${vm.vmid} to delete “${vm.name}” of ${vm.owner}`, {
        hint: 'The server is stopped if needed and deleted with its disks and snapshots. The customer loses it immediately.',
        okLabel: 'Delete server', pattern: String(vm.vmid), danger: true,
      });
      if (answer !== String(vm.vmid)) return;
      try {
        await api(`/api/admin/vms/${vm.vmid}/server`, { method: 'DELETE' });
        toast(`Deleting ${vm.name}`);
        await load({ quiet: true });
        watch(() => !st.vms.some((x) => x.vmid === vm.vmid && x.state === 'deleting'));
      } catch (err) { fail(err); }
      return;
    }
    if (action !== 'start') {
      const q = { shutdown: `Shut down ${vm.name}?`, reboot: `Restart ${vm.name}?`,
        stop: `Force stop ${vm.name}? This cuts power immediately; unsaved data in the server may be lost.` }[action];
      const okLabel = { shutdown: 'Shut down', reboot: 'Restart', stop: 'Force stop' }[action];
      if (!(await confirmAction(`${q} The customer ${vm.owner} is affected.`, okLabel))) return;
    }
    try {
      const { task } = await api(`/api/admin/vms/${vm.vmid}/power/${action}`, { method: 'POST' });
      toast(`${POWER_TEXT[action][0]} ${vm.name}…`);
      const result = await waitForTask(task);
      if (result && !result.ok) toast(`${vm.name}: ${result.message}`, 'error');
      else if (result) toast(`${vm.name} ${POWER_TEXT[action][1]}`);
      await load({ quiet: true });
    } catch (err) { fail(err); }
  }

  function renderServerRows() {
    const assigned = st.vms.filter((v) => v.userId).length;
    root.querySelector('#vm-summary').textContent =
      `${st.vms.length} servers in the cluster, ${assigned} assigned to customers.`;

    const q = st.filter.trim().toLowerCase();
    const rows = st.vms.filter((v) => !q
      || String(v.vmid).includes(q)
      || v.name.toLowerCase().includes(q)
      || (v.owner ?? '').toLowerCase().includes(q)
      || (v.label ?? '').toLowerCase().includes(q));

    const options = (selected) => `
      <option value="">Not assigned</option>
      ${st.users.map((u) =>
        `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.email)}</option>`).join('')}`;

    root.querySelector('#vm-rows').innerHTML = rows.length ? rows.map((v) => `
      <tr data-vmid="${v.vmid}">
        <td class="mono">${v.vmid}</td>
        <td>
          <span class="led ${v.status === 'running' ? 'running' : ''}" title="${esc(v.status)}"></span>
          ${esc(v.name) || '<span class="muted">–</span>'}
          ${v.type === 'lxc' ? '<span class="tag">container</span>' : ''}
          ${v.status === 'missing' ? '<span class="tag warn">deleted in Proxmox</span>' : ''}
          ${v.state === 'creating' ? '<span class="tag">being created</span>' : ''}
          ${v.state === 'deleting' ? '<span class="tag">being deleted</span>' : ''}
          ${v.state === 'failed' ? '<span class="tag warn">setup failed</span>' : ''}
          ${v.createdByCustomer ? '<span class="tag">created by customer</span>' : ''}
          ${expiryTag(v)}
        </td>
        <td class="muted">${esc(v.node ?? '–')}</td>
        <td>
          <select data-owner aria-label="Customer for server ${v.vmid}" ${v.status === 'missing' && !v.userId ? 'disabled' : ''}>
            ${options(v.userId)}
          </select>
        </td>
        <td>
          <input data-label value="${esc(v.label ?? '')}" placeholder="${esc(v.name || `Server ${v.vmid}`)}"
                 maxlength="80" aria-label="Name shown to customer for server ${v.vmid}" ${v.userId ? '' : 'disabled'}>
        </td>
        <td class="actions">${serverActions(v)}</td>
      </tr>`).join('')
      : `<tr><td colspan="6" class="muted">No servers match “${esc(st.filter)}”.</td></tr>`;
  }

  async function saveAssignment(row) {
    const vmid = Number(row.dataset.vmid);
    const vm = st.vms.find((v) => v.vmid === vmid);
    const select = row.querySelector('[data-owner]');
    const input = row.querySelector('[data-label]');
    const userId = select.value ? Number(select.value) : null;
    const label = input.value.trim();

    select.disabled = input.disabled = true;
    try {
      if (!userId) {
        await api(`/api/admin/vms/${vmid}`, { method: 'DELETE' });
        Object.assign(vm, { userId: null, owner: null, label: null });
        toast(`Server ${vmid} unassigned`);
        if (vm.status === 'missing') st.vms = st.vms.filter((v) => v !== vm);
      } else {
        const res = await api(`/api/admin/vms/${vmid}`, {
          method: 'PUT',
          body: label ? { userId, label } : { userId },
        });
        const ownerChanged = vm.userId !== userId;
        Object.assign(vm, { userId, owner: res.owner, label: res.label });
        toast(ownerChanged ? `Server ${vmid} assigned to ${res.owner}` : 'Name saved');
      }
    } catch (err) {
      fail(err);
    }
    renderServerRows();
  }

  // ---- customers --------------------------------------------------------
  function renderUsers() {
    const me = getMe();
    const note = st.newUser?.inviteError ? `
      <div class="notice warn" role="status">
        <p>Added <strong>${esc(st.newUser.email)}</strong>, but the invitation couldn't be sent:
          ${esc(st.newUser.inviteError)}</p>
        <p class="small">Fix the email settings, then use <strong>Resend invitation</strong> in the list below.</p>
        <div class="row"><button class="btn ghost" data-dismiss-note>Dismiss</button></div>
      </div>` : st.newUser?.invited ? `
      <div class="notice" role="status">
        <p>Added <strong>${esc(st.newUser.email)}</strong> and sent the invitation. The link is valid for 3 days.</p>
        <div class="row"><button class="btn ghost" data-dismiss-note>Dismiss</button></div>
      </div>` : st.newUser ? `
      <div class="notice" role="status">
        <p>Added <strong>${esc(st.newUser.email)}</strong>.
        ${st.newUser.password ? `Their password is <span class="mono selectable">${esc(st.newUser.password)}</span>. Copy it now and send it securely; it won't be shown again.` : ''}</p>
        <div class="row">
          ${st.newUser.password ? '<button class="btn" data-copy-password>Copy password</button>' : ''}
          <button class="btn ghost" data-dismiss-note>Dismiss</button>
        </div>
      </div>` : '';

    root.querySelector('#admin-body').innerHTML = `
      <h2 class="h2">Add a customer</h2>
      <form id="user-form" class="user-form" autocomplete="off">
        <label>Email <input name="email" type="email" required maxlength="254"></label>
        <label id="pw-field">Password
          <span class="with-button">
            <input name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password">
            <button type="button" class="btn" data-generate>Generate</button>
          </span>
        </label>
        <button class="btn primary">Add customer</button>
        ${st.perms?.has('rbac.write') ? `<label class="check">
          <input type="checkbox" name="isAdmin">
          <span>Administrator <span class="muted">Can open this area. Starts with the Operator role; change it in the Access tab.</span></span>
        </label>` : ''}
        <label class="check">
          <input type="checkbox" name="invite" ${st.email?.configured ? '' : 'disabled'}>
          <span>Send an invitation email
            <span class="muted">${st.email?.configured
              ? 'The user gets an email with the panel address and a personal link to set their own password (valid 3 days). No password needed here.'
              : 'Set up email in the Settings tab to invite users by email.'}</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" name="requireTotp">
          <span>Require two-factor authentication <span class="muted">The user sets up an authenticator app at the first sign-in, before they can do anything else.</span></span>
        </label>
      </form>
      ${note}

      <h2 class="h2">Customers</h2>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Email</th><th>Role</th><th>2FA</th><th>Servers</th><th>Can create servers</th><th>Network</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            ${st.users.map((u) => {
              const self = u.id === me.id;
              return `
              <tr data-user="${u.id}">
                <td>${esc(u.email)}${self ? ' <span class="muted">(you)</span>' : ''}${u.ssoLinked ? ` <span class="tag" title="Linked to single sign-on${u.ssoProviders ? `: ${esc(u.ssoProviders)}` : ''}">SSO</span>` : ''}${u.passkeyCount ? ` <span class="tag" title="${u.passkeyCount} passkey${u.passkeyCount > 1 ? 's' : ''}">Passkey</span>` : ''}${u.expiryMode ? ` <span class="tag" title="${esc(expiryRuleText(u))}">${icon('clock', { size: 12 })} Expiry</span>` : ''}${
                  u.invite?.status === 'pending' ? ` <span class="tag" title="Link valid until ${esc(new Date(u.invite.expires).toLocaleString())}">Invitation pending</span>`
                  : u.invite?.status === 'expired' ? ' <span class="tag warn">Invitation expired</span>'
                  : u.invite?.status === 'sent' ? ' <span class="tag">Invited</span>' : ''}</td>
                <td>${u.isAdmin ? 'Administrator' : 'Customer'}</td>
                <td>${u.totpEnabled
                  ? `<span class="pill pill-running">On</span>${u.totpRequired ? ' <span class="muted small">required</span>' : ''}`
                  : u.totpRequired ? '<span class="pill pill-busy" title="Set up at the next sign-in">Required</span>'
                  : '<span class="pill">Off</span>'}</td>
                <td>${u.servers ? `<button class="linklike" data-show-servers="${esc(u.email)}">${u.servers}</button>` : '0'}</td>
                <td>${u.canCreate
                  ? `Yes <span class="muted small">(up to ${u.maxServers} servers, ${u.maxCores} cores, ${gb(u.maxMemoryMb)}, ${u.maxDiskGb} GB disk)</span>`
                  : '<span class="muted">No</span>'}</td>
                <td>${u.network
                  ? `<span class="mono">${esc(u.network.subnet)}</span> <span class="muted small">${esc(u.network.vnet)}</span>`
                  : '<span class="muted">–</span>'}</td>
                <td class="muted">${utc(u.createdAt).toLocaleDateString()}</td>
                <td class="actions">${u.deleting ? (u.deletionError ? `
                  <span class="pill pill-failed" title="${esc(u.deletionError)}">Deletion failed</span>
                  <button class="btn danger" data-delete-user>Retry</button>` : `
                  <span class="pill pill-busy">Deleting…</span>`) : `
                  ${u.invite && st.email?.configured ? '<button class="btn" data-resend-invite>Resend invitation</button>' : ''}
                  <button class="btn" data-limits>Limits</button>
                  <button class="btn" data-twofa>Sign-in</button>
                  <button class="btn" data-reset>Reset password</button>
                  ${self ? '' : `<button class="btn" data-toggle-admin>${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>`}
                  ${self ? '' : '<button class="btn danger" data-delete-user>Delete</button>'}`}
                </td>
              </tr>
              ${u.deleting && u.deletionError ? `<tr class="row-warn"><td colspan="8" class="small">Deleting ${esc(u.email)} stopped: ${esc(u.deletionError)}</td></tr>` : ''}`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function watchDeletions() {
    if (st.users.some((u) => u.deleting && !u.deletionError)) {
      watch(() => st.tab !== 'users' || !st.users.some((u) => u.deleting && !u.deletionError));
    }
  }

  /** Confirmation dialog listing everything that will be deleted. */
  async function deleteCustomer(user) {
    let plan;
    try {
      plan = await api(`/api/admin/users/${user.id}/deletion-plan`);
      if (!st.vms.length) st.vms = await api('/api/admin/vms').catch(() => []);
    } catch (err) { return fail(err); }
    const dialog = document.getElementById('delete-user');
    const form = document.getElementById('delete-user-form');
    const created = plan.servers.filter((x) => x.createdByCustomer);
    const assigned = plan.servers.filter((x) => !x.createdByCustomer);
    const names = new Map(st.vms.map((v) => [v.vmid, v.name]));
    const item = (x) => `<li><span class="mono">${x.vmid}</span> ${esc(x.label || names.get(x.vmid) || '')}</li>`;

    document.getElementById('du-title').textContent = `Delete ${user.email}?`;
    document.getElementById('du-plan').innerHTML = `
      <p>This deletes the account and everything that belongs to it. It can't be undone.</p>
      <ul class="plan-list">
        ${created.length ? `<li><strong>${created.length} server${created.length > 1 ? 's' : ''} the customer created</strong> are stopped and deleted with their disks and snapshots:<ul>${created.map(item).join('')}</ul></li>` : ''}
        ${assigned.length ? `<li><strong>${assigned.length} server${assigned.length > 1 ? 's' : ''} you assigned</strong>:<ul>${assigned.map(item).join('')}</ul></li>` : ''}
        ${plan.vpnDevices ? `<li><strong>${plan.vpnDevices} VPN device${plan.vpnDevices > 1 ? 's' : ''}</strong> lose access.</li>` : ''}
        ${plan.network ? `<li><strong>The private network</strong> <span class="mono">${esc(plan.network.vnet)}</span> (<span class="mono">${esc(plan.network.subnet)}</span>) is removed from Proxmox${plan.othersInNetwork.length ? ', unless you keep it (see below)' : ''}.</li>` : ''}
        ${!plan.servers.length && !plan.vpnDevices && !plan.network ? '<li>No servers, VPN devices or network.</li>' : ''}
      </ul>`;
    const others = plan.othersInNetwork ?? [];
    if (others.length) {
      document.getElementById('du-plan').insertAdjacentHTML('beforeend', `
        <div class="notice warn">
          <p><strong>${others.length === 1 ? 'This server is' : 'These servers are'} still in the customer's network
            but no longer theirs:</strong></p>
          <ul class="plan-list">${others.map((g) => `<li><span class="mono">${g.vmid}</span> ${esc(g.name)}
            <span class="muted">${g.owner ? `assigned to ${esc(g.owner)}` : 'not assigned'}</span></li>`).join('')}</ul>
          <p class="small">They are not deleted. Proxmox can't remove a network that is in use, so either keep the
            network, or first move ${others.length === 1 ? 'it' : 'them'} to another network (Hardware, Network Device).</p>
        </div>`);
    }
    const keepNetWrap = document.getElementById('du-keepnet-wrap');
    keepNetWrap.hidden = !others.length;
    form.keepNetwork.checked = others.length > 0;

    const keepWrap = document.getElementById('du-keep-wrap');
    keepWrap.hidden = !assigned.length;
    form.keepAssigned.checked = false;
    form.confirm.value = '';
    const ok = document.getElementById('du-ok');
    ok.disabled = true;
    const matches = () => form.confirm.value.trim().toLowerCase() === user.email.toLowerCase();
    form.confirm.oninput = () => { ok.disabled = !matches(); };
    form.confirm.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (matches()) dialog.close('ok'); }
    };
    dialog.returnValue = '';
    dialog.showModal();
    form.confirm.focus();

    const confirmed = await new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' && matches()), { once: true });
    });
    if (!confirmed) return;
    try {
      const q = new URLSearchParams();
      if (form.keepAssigned.checked) q.set('keepAssigned', 'true');
      if (form.keepNetwork.checked && !keepNetWrap.hidden) q.set('keepNetwork', 'true');
      const qs = q.toString();
      await api(`/api/admin/users/${user.id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
      toast(`Deleting ${user.email}`);
      st.users = await api('/api/admin/users');
      renderUsers();
      watchDeletions();
    } catch (err) { fail(err); }
  }

  /** Require / not require 2FA for a user, or reset it (lost phone). */
  async function editTwoFactor(user) {
    const dialog = document.getElementById('twofa-admin');
    const form = document.getElementById('twofa-admin-form');
    document.getElementById('ta-title').textContent = `Sign-in for ${user.email}`;
    document.getElementById('ta-state').innerHTML = user.totpEnabled
      ? '<span class="pill pill-running">On</span> The user has set it up.'
      : user.totpRequired
        ? '<span class="pill pill-busy">Required</span> The user sets it up at the next sign-in.'
        : '<span class="pill">Off</span> The user signs in with password only.';
    form.required.checked = user.totpRequired;
    document.getElementById('ta-reset-box').hidden = !user.totpEnabled;
    const pkBox = document.getElementById('ta-passkey-box');
    pkBox.hidden = !user.passkeyCount;
    document.getElementById('ta-passkey-count').textContent = `${user.passkeyCount} passkey${user.passkeyCount === 1 ? '' : 's'}`;
    document.getElementById('ta-remove-passkeys').onclick = async () => {
      if (!(await confirmAction(`Remove all passkeys of ${user.email}? They then sign in with password or single sign-on and can add new passkeys.`, 'Remove'))) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { removePasskeys: true } });
        toast(`Passkeys removed for ${user.email}`);
        dialog.close('reset');
      } catch (err) { fail(err); }
    };
    const ssoBox = document.getElementById('ta-sso-box');
    ssoBox.hidden = !user.ssoLinked;
    document.getElementById('ta-sso-issuer').textContent = user.ssoIssuer ?? '';
    document.getElementById('ta-unlink').onclick = async () => {
      if (!(await confirmAction(`Unlink ${user.email} from single sign-on? The next single sign-on links the account again by verified email, or is refused.`, 'Unlink'))) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { unlinkSso: true } });
        toast(`${user.email} unlinked from single sign-on`);
        dialog.close('reset');
      } catch (err) { fail(err); }
    };
    document.getElementById('ta-reset').onclick = async () => {
      if (!(await confirmAction(`Reset two-factor authentication for ${user.email}? Their authenticator app and recovery codes stop working.`, 'Reset'))) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { resetTotp: true } });
        toast(`Two-factor authentication reset for ${user.email}`);
        dialog.close('reset');
      } catch (err) { fail(err); }
    };
    dialog.returnValue = '';
    dialog.showModal();
    const result = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (result === 'ok' && form.required.checked !== user.totpRequired) {
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { totpRequired: form.required.checked } });
        toast(form.required.checked ? `Two-factor authentication is now required for ${user.email}` : `Two-factor authentication is optional for ${user.email}`);
      } catch (err) { fail(err); }
    }
    if (result === 'ok' || result === 'reset') {
      st.users = await api('/api/admin/users');
      renderUsers();
    }
  }

  async function createUser(form) {
    const email = form.email.value.trim();
    const invite = form.invite.checked;
    const password = invite ? undefined : form.password.value;
    const isAdmin = !!form.isAdmin?.checked;
    const requireTotp = form.requireTotp.checked;
    const generated = !invite && form.dataset.generated === password;
    const button = form.querySelector('.btn.primary');
    button.disabled = true;
    try {
      const r = await api('/api/admin/users', { method: 'POST', body: { email, password, isAdmin, requireTotp, invite } });
      st.newUser = { email, password: generated ? password : null, invited: r.invited, inviteError: r.inviteError };
      st.users = await api('/api/admin/users');
      renderUsers();
    } catch (err) {
      fail(err);
      button.disabled = false;
    }
  }

  // ---- limits -----------------------------------------------------------
  function editLimits(user) {
    const dialog = document.getElementById('limits');
    const form = document.getElementById('limits-form');
    document.getElementById('limits-title').textContent = `Limits and expiry for ${user.email}`;
    form.expiryMode.value = user.expiryMode ?? '';
    form.expiryDays.value = user.expiryDays ?? 14;
    form.expiryDate.value = user.expiryDate ?? '';
    form.expirySelfExtend.checked = !!user.expirySelfExtend;
    const showRule = () => {
      document.getElementById('lim-exp-days').hidden = form.expiryMode.value !== 'after_creation';
      document.getElementById('lim-exp-date').hidden = form.expiryMode.value !== 'fixed_date';
      document.getElementById('lim-exp-extend').hidden = !form.expiryMode.value;
    };
    form.expiryMode.onchange = showRule;
    showRule();
    // Sensible starting values the first time self-service is switched on
    const fresh = !user.canCreate && !user.maxServers && !user.maxCores;
    form.canCreate.checked = user.canCreate;
    form.maxServers.value = fresh ? 2 : user.maxServers;
    form.maxCores.value = fresh ? 4 : user.maxCores;
    form.maxMemoryGb.value = fresh ? 8 : +(user.maxMemoryMb / 1024).toFixed(1);
    form.maxDiskGb.value = fresh ? 100 : user.maxDiskGb;
    const u = user.usage;
    document.getElementById('limits-usage').textContent = u
      ? `In use now: ${u.servers} servers, ${u.cores} cores, ${gb(u.memoryMb)} memory, ${u.diskGb} GB disk.`
      : `${user.servers} server${user.servers === 1 ? '' : 's'} assigned.`;
    dialog.returnValue = '';
    dialog.showModal();

    return new Promise((resolve) => {
      dialog.addEventListener('close', async () => {
        if (dialog.returnValue !== 'ok') return resolve(false);
        try {
          await api(`/api/admin/users/${user.id}`, {
            method: 'PATCH',
            body: {
              canCreate: form.canCreate.checked,
              maxServers: Number(form.maxServers.value),
              maxCores: Number(form.maxCores.value),
              maxMemoryMb: Math.round(Number(form.maxMemoryGb.value) * 1024),
              maxDiskGb: Number(form.maxDiskGb.value),
              expiryMode: form.expiryMode.value || null,
              ...(form.expiryMode.value === 'after_creation' ? { expiryDays: Number(form.expiryDays.value) } : {}),
              ...(form.expiryMode.value === 'fixed_date' ? { expiryDate: form.expiryDate.value } : {}),
              expirySelfExtend: form.expirySelfExtend.checked,
            },
          });
          toast(`Limits and expiry saved for ${user.email}`);
          resolve(true);
        } catch (err) {
          fail(err);
          resolve(false);
        }
      }, { once: true });
    });
  }

  // ---- templates --------------------------------------------------------
  function renderTemplates() {
    const body = root.querySelector('#admin-body');
    if (!st.templates.length) {
      body.innerHTML = `
        <div class="empty">
          <h2>No templates in the cluster</h2>
          <p class="muted">Customers create servers by cloning a Proxmox template. Prepare a VM with cloud-init,
          convert it to a template in Proxmox and add it to the panel's pool; it then appears here.</p>
        </div>`;
      return;
    }
    const canEdit = !st.perms || st.perms.has('templates.write');
    body.innerHTML = `
      <p class="muted" style="margin-top:0">Customers who may create servers can choose from the templates offered here.
        Linux templates are set up with cloud-init, Windows templates through the QEMU guest agent.</p>
      ${canEdit ? '' : '<p class="notice"><span>Read-only: only owners (or a role with “Offer, set up and withdraw OS templates”) can change templates.</span></p>'}
      <fieldset class="plain-fieldset" ${canEdit ? '' : 'disabled'}>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>ID</th><th>Template in Proxmox</th><th>Offered</th><th>Name shown to customers</th>
            <th>Setup</th><th>Target storage</th><th>User</th><th>Network (cloud-init)</th><th><span class="sr-only">Save</span></th>
          </tr></thead>
          <tbody>
            ${st.templates.map((t) => `
              <tr data-template="${t.vmid}">
                <td class="mono">${t.vmid}</td>
                <td>${esc(t.name)} <span class="muted small">${esc(t.node)}</span></td>
                <td><input type="checkbox" data-f="offered" ${t.offered ? 'checked' : ''} aria-label="Offer template ${t.vmid}"></td>
                <td><input data-f="label" value="${esc(t.label)}" placeholder="e.g. Debian 12" maxlength="80"></td>
                <td>
                  <select data-f="setup" aria-label="Setup method for template ${t.vmid}">
                    <option value="cloudinit" ${t.setup !== 'windows' ? 'selected' : ''}>Cloud-init (Linux)</option>
                    <option value="windows" ${t.setup === 'windows' ? 'selected' : ''}>Guest agent (Windows)</option>
                  </select>
                </td>
                <td>
                  <select data-f="storage">
                    <option value="">Same as template</option>
                    ${(st.storages[t.node] ?? []).map((name) =>
                      `<option ${name === t.storage ? 'selected' : ''}>${esc(name)}</option>`).join('')}
                  </select>
                </td>
                <td><input data-f="ciUser" value="${esc(t.ciUser)}" placeholder="${t.setup === 'windows' ? 'Administrator' : 'from template'}" maxlength="32" class="narrow"></td>
                <td><input data-f="ipconfig" value="${esc(t.ipconfig)}" maxlength="200" class="mono narrow"></td>
                <td><button class="btn" data-save-template>Save</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        <strong>Cloud-init:</strong> the customer chooses the user name (User is only the suggestion); Network is the
        <span class="mono">ipconfig0</span> value, e.g. <span class="mono">ip=dhcp</span>.
        <strong>Guest agent (Windows):</strong> the template must be sysprep'd with the QEMU guest agent installed and enabled;
        the panel sets the password of User (default Administrator) and the computer name.</p>
      </fieldset>`;
  }

  async function saveTemplate(row) {
    const vmid = Number(row.dataset.template);
    const field = (f) => row.querySelector(`[data-f="${f}"]`);
    const offered = field('offered').checked;
    const label = field('label').value.trim();
    try {
      if (!offered) {
        await api(`/api/admin/templates/${vmid}`, { method: 'DELETE' });
        toast(`Template ${vmid} is not offered`);
      } else {
        if (!label) {
          field('label').focus();
          return toast('Give the template a name customers will recognise', 'error');
        }
        await api(`/api/admin/templates/${vmid}`, {
          method: 'PUT',
          body: {
            label,
            storage: field('storage').value,
            ciUser: field('ciUser').value.trim(),
            ipconfig: field('ipconfig').value.trim(),
            setup: field('setup').value,
          },
        });
        toast(`${label} is offered to customers`);
      }
      const t = st.templates.find((x) => x.vmid === vmid);
      Object.assign(t, { offered, label });
    } catch (err) { fail(err); }
  }

  // ---- VPN --------------------------------------------------------------
  function tailscaleSection() {
    const ts = st.vpn.tailscale;
    if (!ts?.enabled) return '';
    const stateWord = { connected: 'Connected', installing: 'Connecting…', disconnecting: 'Disconnecting…', failed: 'Failed' };
    const pill = { connected: 'pill-running', installing: 'pill-busy', disconnecting: 'pill-busy', failed: 'pill-failed' };
    return `
      <h2 class="h2">Tailscale</h2>
      <p class="muted" style="margin-top:-4px">Servers customers connected to their own tailnet. The panel doesn't
        see or manage the customers' Tailscale accounts.</p>
      ${ts.servers.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Customer</th><th>Server</th><th>Mode</th><th>Tailscale address</th><th>State</th></tr></thead>
            <tbody>
              ${ts.servers.map((x) => `
                <tr>
                  <td>${esc(x.email)}</td>
                  <td><span class="mono">${x.vmid}</span> ${esc(x.label ?? x.hostname ?? '')}</td>
                  <td>${x.mode === 'gateway' ? 'Gateway to private network' : 'Just this server'}</td>
                  <td class="mono">${esc(x.ip ?? '–')}</td>
                  <td><span class="pill ${pill[x.state] ?? ''}" title="${esc(x.error ?? '')}">${stateWord[x.state] ?? esc(x.state)}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted">No server is connected to Tailscale yet.</p>'}`;
  }

  function renderVpn() {
    const { status, devices } = st.vpn;
    const body = root.querySelector('#admin-body');
    if (!status.enabled) {
      body.innerHTML = `
        <div class="empty">
          <h2>WireGuard VPN is switched off</h2>
          <p class="muted">Set up the WireGuard gateway VM and set <span class="mono">VPN_ENABLED=true</span>,
            <span class="mono">VPN_GATEWAY_VMID</span> and <span class="mono">VPN_ENDPOINT</span> in the panel's
            <span class="mono">.env</span>. The documentation (Networking → WireGuard VPN) has the steps.</p>
        </div>
        ${tailscaleSection()}`;
      return;
    }
    const since = (ts) => (ts == null ? 'unknown' : !ts ? 'Never'
      : Date.now() / 1000 - ts < 180 ? 'Connected now' : new Date(ts * 1000).toLocaleString());
    body.innerHTML = `
      <dl class="specs cols-3">
        <div><dt>Gateway</dt><dd>${status.reachable
          ? '<span class="led running"></span> Running' : '<span class="led failed"></span> Not reachable'}
          <span class="muted small">VM ${status.gatewayVmid}</span></dd></div>
        <div><dt>Endpoint for customers</dt><dd class="mono">${esc(status.endpoint)}</dd></div>
        <div><dt>Devices</dt><dd>${devices.length}</dd></div>
        <div class="wide"><dt>${status.reachable ? 'Gateway public key' : 'Problem'}</dt>
          <dd class="${status.reachable ? 'mono' : ''}">${esc(status.reachable ? status.publicKey : status.error)}</dd></div>
      </dl>
      <div class="section-head">
        <h2 class="h2" style="margin:0">Devices</h2>
        <button class="btn" data-vpn-sync>Re-apply configuration</button>
      </div>
      ${devices.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Customer</th><th>Device</th><th>VPN address</th><th>Last connected</th><th>Added</th><th><span class="sr-only">Remove</span></th></tr></thead>
            <tbody>
              ${devices.map((d) => `
                <tr>
                  <td>${esc(d.email ?? '–')}</td>
                  <td>${esc(d.name)}</td>
                  <td class="mono">${esc(d.address)}</td>
                  <td>${esc(since(d.lastHandshake))}</td>
                  <td class="muted">${utc(d.createdAt).toLocaleDateString()}</td>
                  <td class="actions"><button class="btn danger" data-vpn-remove="${d.id}" data-name="${esc(d.name)}">Remove</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted">No VPN devices yet. Customers add them under “VPN access”.</p>'}
      ${tailscaleSection()}`;
  }

  // ---- expiry ---------------------------------------------------------------
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  function expiryTag(v) {
    const e = v.expiry;
    if (!e) return '';
    if (e.expired) {
      return e.deleteAt
        ? `<span class="tag warn" title="Expired ${esc(day(e.expiredAt))}">Expired · deleted ${esc(day(e.deleteAt))}</span>`
        : `<span class="tag warn" title="Assigned by you: not deleted automatically">Expired · your decision</span>`;
    }
    return `<span class="tag" title="${v.expiryManual ? 'Set for this server' : "From the customer's rule"}">Expires ${esc(day(e.expiresAt))}</span>`;
  }

  /** Set, extend or remove a server's expiry. */
  async function editServerExpiry(vm) {
    const dialog = document.getElementById('expiry-dialog');
    const form = document.getElementById('expiry-form');
    document.getElementById('ex-title').textContent = `Expiry of ${vm.label || vm.name} (${vm.vmid})`;
    const e = vm.expiry;
    document.getElementById('ex-state').textContent = !e ? 'This server does not expire.'
      : e.expired ? `Expired on ${day(e.expiredAt)}${e.deleteAt ? `; deleted on ${day(e.deleteAt)} unless extended` : '; assigned by you, so it is not deleted automatically'}.`
        : `Expires on ${day(e.expiresAt)}.`;
    form.date.value = e && !e.expired ? e.expiresAt.slice(0, 10) : '';
    form.date.min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    document.getElementById('ex-remove').hidden = !e;
    form.date.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); dialog.close('ok'); } };
    dialog.returnValue = '';
    dialog.showModal();
    const result = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    let body = null;
    if (result === 'ok') body = form.date.value ? { expiresAt: form.date.value } : null;
    if (result === 'plus7') body = { extendDays: 7 };
    if (result === 'plus30') body = { extendDays: 30 };
    if (result === 'remove') body = { expiresAt: null };
    if (!body) return;
    try {
      const r = await api(`/api/admin/vms/${vm.vmid}/expiry`, { method: 'PUT', body });
      toast(r.expiry ? `${vm.label || vm.name} now expires on ${day(r.expiry.expiresAt)}` : `${vm.label || vm.name} no longer expires`);
      load({ quiet: true });
    } catch (err) { fail(err); }
  }

  function expiryRuleText(u) {
    if (u.expiryMode === 'after_creation') return `Servers expire ${u.expiryDays} days after creation`;
    if (u.expiryMode === 'fixed_date') return `Servers expire on ${day(`${u.expiryDate}T12:00:00`)}`;
    return '';
  }

  // ---- settings: email ----------------------------------------------------
  /** Settings card: the AI assistant for customers (Claude or an OpenAI-compatible API). */
  function aiCard() {
    const a = st.ai;
    if (!a) return '';
    return `
      <section class="security-card settings-card">
        <div class="settings-head">
          <h2 class="twofa-title">AI assistant <span class="pill ${a.enabled ? 'pill-running' : ''}">${a.enabled ? 'On' : 'Off'}</span></h2>
          <p class="muted">A chat for customers that answers from the knowledge base and their own servers and tickets. It only reads;
            it can propose a ticket, which the customer confirms. Questions and answers are sent to the provider you choose here.</p>
        </div>
        <form id="ai-form" class="email-form" novalidate>
          <div class="grid-3">
            <label>Provider <select name="provider">
              <option value="anthropic" ${a.provider === 'anthropic' ? 'selected' : ''}>Claude (Anthropic API)</option>
              <option value="openai" ${a.provider === 'openai' ? 'selected' : ''}>OpenAI-compatible (OpenAI, vLLM, Ollama…)</option></select></label>
            <label>Model <input name="model" value="${esc(a.model)}" spellcheck="false" placeholder="claude-sonnet-5-5"></label>
            <label>API key <input name="apiKey" type="password" autocomplete="new-password" placeholder="${a.hasKey ? 'Stored; leave empty to keep it' : (a.provider === 'openai' ? 'Optional for local models' : 'sk-ant-…')}"></label>
          </div>
          <label>API address <input name="baseUrl" value="${esc(a.baseUrl)}" spellcheck="false"
              placeholder="${a.provider === 'openai' ? 'https://api.openai.com/v1 or http://ollama.internal:11434/v1' : 'empty = https://api.anthropic.com'}">
            <span class="hint">OpenAI-compatible: the address up to <span class="mono">/v1</span>. A model in your own network may use http.</span></label>
          <div class="grid-3">
            <label>Questions per customer per day <input name="dailyLimit" type="number" min="1" max="1000" value="${esc(a.dailyLimit)}"></label>
            <label>Longest answer (tokens) <input name="maxTokens" type="number" min="256" max="4096" value="${esc(a.maxTokens)}"></label>
            <label class="check" style="align-self:end"><input type="checkbox" name="handover" ${a.handover ? 'checked' : ''}><span>May propose tickets</span></label>
          </div>
          <label>Extra instructions <textarea name="instructions" rows="3" maxlength="4000" placeholder="e.g. Our support hours are 08:00–20:00 WIB. Answer in Indonesian unless the customer writes in English.">${esc(a.instructions)}</textarea></label>
          <div class="row">
            <label class="inline-check"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''}> Switched on for customers</label>
            <button class="btn primary">Save</button>
            <button type="button" class="btn" data-ai-test>Test</button>
          </div>
        </form>
      </section>`;
  }

  /** Settings card: optional two-way sync of support tickets with Zammad. */
  function zammadCard() {
    const z = st.zammad;
    if (!z) return '';
    const pending = z.pending.tickets + z.pending.messages;
    return `
      <section class="security-card settings-card">
        <div class="settings-head">
          <h2 class="twofa-title">Helpdesk: Zammad <span class="pill ${z.enabled ? 'pill-running' : ''}">${z.enabled ? 'Connected' : 'Off'}</span></h2>
          <p class="muted">Optional. Tickets always work in the panel; with Zammad, new tickets and messages are also created there,
            and what agents write in Zammad (or customers by email, WhatsApp or phone) comes back to the panel.</p>
        </div>
        <form id="zammad-form" class="email-form" novalidate>
          <div class="grid-2">
            <label>Zammad address <input name="url" value="${esc(z.url)}" placeholder="https://helpdesk.example.com" spellcheck="false"></label>
            <label>API token <input name="token" type="password" autocomplete="new-password" placeholder="${z.hasToken ? 'Stored; leave empty to keep it' : 'Profile → Token Access (agent with ticket.agent)'}"></label>
          </div>
          <div class="grid-3">
            ${['L1', 'L2', 'L3'].map((q) => `<label>Group for ${q} <input name="group${q}" value="${esc(z.groups[q] ?? '')}" placeholder="Users"></label>`).join('')}
          </div>
          <div class="row">
            <label class="inline-check"><input type="checkbox" name="enabled" ${z.enabled ? 'checked' : ''}> Sync with Zammad</label>
            <button class="btn primary">Save</button>
            <button type="button" class="btn" data-zammad-test>Test connection</button>
            ${pending ? `<button type="button" class="btn" data-zammad-retry>Send ${pending} waiting item${pending === 1 ? '' : 's'} now</button>` : ''}
          </div>
        </form>
        <div class="zammad-hook">
          <h3 class="h3">Back to the panel (webhook in Zammad)</h3>
          <p class="muted small">In Zammad: <em>Settings → Manage → Webhook</em> → new webhook with this endpoint and HMAC SHA1 signature token.
            Then <em>Manage → Trigger</em>: condition “Action is updated” (and “created”), action “Webhook” → this webhook.</p>
          ${z.webhookUrl ? `<p class="small">Endpoint: <span class="mono">${esc(z.webhookUrl)}</span></p>` : '<p class="small warn-text">Set PANEL_PUBLIC_URL first: Zammad needs the panel’s public address.</p>'}
          ${z.webhookSecret ? `<p class="small">Signature token: <span class="mono">${esc(z.webhookSecret)}</span>
            <button type="button" class="link-btn" data-zammad-secret>New token</button></p>` : '<p class="muted small">The signature token is made when you save.</p>'}
        </div>
      </section>`;
  }

  /** Settings card: sign-in with Google, Microsoft and GitHub. */
  function ssoCard() {
    const s = st.sso;
    if (!s) return '';
    const noUrl = !s.publicUrls.customer && !s.publicUrls.admin;
    return `
      <section class="security-card settings-card">
        <div class="settings-head">
          <h2 class="twofa-title">Single sign-on</h2>
          <p class="muted">Let people sign in with Google, Microsoft (work or school accounts, Microsoft 365) or GitHub.
            Create an app at the provider, enter the redirect address shown below there, and paste the client ID and secret here.
            Existing accounts are never linked by email alone: users link a provider themselves under Account.</p>
          ${noUrl ? '<p class="small warn-text">Set PANEL_PUBLIC_URL (and ADMIN_PUBLIC_URL for the admin portal) in the environment first: the providers need the callback address.</p>' : ''}
        </div>
        ${s.providers.map((p) => `
          <form class="email-form sso-form" data-sso="${esc(p.id)}" novalidate>
            <h3 class="h3">${esc(p.name)} <span class="pill ${p.enabled ? 'pill-running' : ''}">${p.enabled ? 'On' : 'Off'}</span>
              ${p.linkedAccounts ? `<span class="muted small">${p.linkedAccounts} linked account${p.linkedAccounts === 1 ? '' : 's'}</span>` : ''}</h3>
            <p class="muted small">${esc(p.hint)}</p>
            <div class="grid-2">
              <label>Client ID <input name="clientId" value="${esc(p.clientId)}" autocomplete="off" spellcheck="false"></label>
              <label>Client secret
                <input name="clientSecret" type="password" autocomplete="new-password" placeholder="${p.hasSecret ? 'Stored; leave empty to keep it' : ''}"></label>
            </div>
            ${p.id === 'microsoft' ? `
              <label>Tenant <input name="tenant" value="${esc(p.tenant)}" spellcheck="false">
                <span class="hint"><span class="mono">organizations</span>: any work or school account;
                  your tenant ID or domain: only your organisation (its email addresses are trusted for new sign-ups).</span></label>` : ''}
            <label>Allowed email domains (optional)
              <input name="allowedDomains" value="${esc(p.allowedDomains.join(', '))}" placeholder="example.com, example.org" spellcheck="false"></label>
            <fieldset class="inline-fieldset"><legend class="small">Show on</legend>
              <label class="inline-check"><input type="checkbox" name="portalCustomer" ${p.portals.includes('customer') ? 'checked' : ''}> Customer portal</label>
              <label class="inline-check"><input type="checkbox" name="portalAdmin" ${p.portals.includes('admin') ? 'checked' : ''}> Admin portal</label>
            </fieldset>
            <label class="check"><input type="checkbox" name="allowSignup" ${p.allowSignup ? 'checked' : ''}>
              <span>New customers can create an account with it <span class="muted">(verified email only; without this, only existing users who linked it can sign in)</span></span></label>
            ${Object.entries(p.redirectUris).map(([portal, uri]) => `
              <p class="small">Redirect address (${esc(portal)}): <span class="mono">${esc(uri)}</span></p>`).join('')}
            <div class="row">
              <label class="inline-check"><input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''}> Switched on</label>
              <button class="btn primary">Save ${esc(p.name)}</button>
            </div>
          </form>`).join('')}
      </section>`;
  }

  function renderSettings() {
    const e = st.email;
    const me = getMe();
    const ap = st.appearance;
    const br = st.branding;
    root.querySelector('#admin-body').innerHTML = `
      <div class="settings">
        ${br ? `
        <section class="security-card settings-card">
          <div class="settings-head">
            <h2 class="twofa-title">Branding</h2>
            <p class="muted">Your product name, logo and support link on both portals, the sign-in pages and in emails.</p>
          </div>
          <form id="branding-form" class="email-form" novalidate>
            <div class="grid-2">
              <label>Product name <input name="name" maxlength="40" value="${esc(br.customName)}" placeholder="${esc(br.defaultName)}">
                <span class="hint">Empty: ${esc(br.defaultName)} (PANEL_NAME).</span></label>
              <label>Support link <input name="supportUrl" value="${esc(br.supportUrl)}" placeholder="https://support.example.com or mailto:help@example.com" spellcheck="false">
                <span class="hint">Shown under the sign-in form.</span></label>
            </div>
            <div class="row"><button class="btn primary">Save</button></div>
          </form>
          ${[['logo', 'Logo', 'SVG, PNG or WebP, up to 512 KB; shown about 30 px high in the sidebar and on the sign-in page.'],
             ['favicon', 'Browser tab icon', 'Square PNG, SVG or WebP, up to 128 KB.']].map(([kind, label, hint]) => `
            <div class="branding-asset">
              <h3 class="h3">${label}</h3>
              <div class="branding-preview">${br[kind] ? `<img src="${esc(br[kind])}" alt="Current ${label.toLowerCase()}">` : '<span class="muted small">Built-in</span>'}</div>
              <p class="muted small">${hint}</p>
              <div class="row">
                <label class="btn">Upload…<input type="file" accept="image/svg+xml,image/png,image/webp" data-brand-upload="${kind}" class="sr-only"></label>
                ${br[kind] ? `<button type="button" class="btn ghost" data-brand-remove="${kind}">Use the built-in one</button>` : ''}
              </div>
            </div>`).join('')}
        </section>` : ''}

        <section class="security-card settings-card">
          <div class="settings-head">
            <h2 class="twofa-title">Appearance</h2>
            <p class="muted">The color scheme for everyone: this admin interface, the customer portal, the sign-in pages
              and emails. Each scheme has a light and a dark variant; the panel follows each device's light/dark setting.</p>
          </div>
          <div class="scheme-grid" role="radiogroup" aria-label="Color scheme">
            ${ap.schemes.map((sc) => `
              <button type="button" class="scheme-tile" role="radio" data-scheme-pick="${esc(sc.id)}"
                      aria-checked="${sc.id === ap.scheme}">
                <span class="scheme-preview" aria-hidden="true">
                  <span class="sp-side" style="background:${esc(sc.side)}"><i></i><i></i><i></i></span>
                  <span class="sp-main"><span class="sp-line"></span><span class="sp-line short"></span>
                    <span class="sp-btn" style="background:${esc(sc.accent)}"></span></span>
                </span>
                <span class="scheme-name">${esc(sc.name)}${sc.id === ap.scheme ? ' <span class="pill pill-running">Active</span>' : ''}</span>
                <span class="muted small">${esc(sc.description)}</span>
              </button>`).join('')}
          </div>
          <div class="row">
            <button type="button" class="btn primary" data-scheme-save disabled>Save for everyone</button>
            <button type="button" class="btn ghost" data-scheme-cancel hidden>Cancel preview</button>
            <span class="muted small" id="scheme-note"></span>
          </div>
          <label class="check"><input type="checkbox" data-allow-personal ${ap.allowPersonal ? 'checked' : ''}>
            <span>Users may choose their own scheme and light/dark mode <span class="muted">(Account → Appearance; only for themselves)</span></span></label>
        </section>

        <section class="security-card settings-card">
          <div class="settings-head">
            <h2 class="twofa-title">Email <span class="pill ${e.configured ? 'pill-running' : ''}">${e.configured ? 'Configured' : 'Not set up'}</span></h2>
            <p class="muted">Used to send invitations to new users. Settings are stored in the panel's database; the
              password is kept encrypted and never shown again.</p>
          </div>
          <form id="email-form" class="email-form" novalidate>
            <div class="grid-3">
              <label>SMTP server <input name="host" required value="${esc(e.host)}" placeholder="smtp.example.com" autocomplete="off"></label>
              <label>Encryption
                <select name="security">
                  <option value="starttls" ${e.security === 'starttls' ? 'selected' : ''}>STARTTLS (587)</option>
                  <option value="tls" ${e.security === 'tls' ? 'selected' : ''}>TLS (465)</option>
                  <option value="none" ${e.security === 'none' ? 'selected' : ''}>None (internal relay only)</option>
                </select>
              </label>
              <label>Port <input name="port" type="number" min="1" max="65535" required value="${esc(e.port)}"></label>
            </div>
            <div class="grid-2">
              <label>Username <input name="username" value="${esc(e.username)}" autocomplete="off" placeholder="often the sender address"></label>
              <label>Password
                <input name="password" type="password" autocomplete="new-password" placeholder="${e.hasPassword ? 'Stored; leave empty to keep it' : ''}">
                ${e.hasPassword ? '<span class="hint"><label class="inline-check"><input type="checkbox" name="clearPassword"> Remove the stored password</label></span>' : ''}
              </label>
            </div>
            <div class="grid-2">
              <label>Sender name <input name="fromName" value="${esc(e.fromName)}" maxlength="80"></label>
              <label>Sender address <input name="fromAddress" type="email" required value="${esc(e.fromAddress)}" placeholder="panel@example.com"></label>
            </div>
            <label>Panel address for links
              <input name="panelUrl" type="url" required value="${esc(e.panelUrl)}" placeholder="https://panel.example.com">
              <span class="hint">The customer panel's address as users open it; invitation links point there.</span>
            </label>
            <p id="email-warning" class="form-error" role="alert"></p>
            <div class="row">
              <button class="btn primary">Save</button>
              ${e.configured ? '<button type="button" class="btn danger" data-email-remove>Remove email settings</button>' : ''}
              ${e.updatedAt ? `<span class="muted small">Last changed ${esc(new Date(`${e.updatedAt.replace(' ', 'T')}Z`).toLocaleString())}</span>` : ''}
            </div>
          </form>
        </section>

        ${ssoCard()}

        ${zammadCard()}

        ${aiCard()}

        ${billing.settingsCard(st.billing)}

        <section class="security-card settings-card">
          <div class="settings-head">
            <h2 class="twofa-title">Operating system updates</h2>
            <p class="muted">Customers can install updates on their virtual machines from the server page (Updates tab),
              through the QEMU guest agent: security or all updates, optionally with a snapshot first and automatic restarts.
              Windows feature upgrades, previews and Linux release upgrades are never installed; on Linux, held packages
              and changed configuration files are left alone.</p>
          </div>
          <label class="check"><input type="checkbox" data-winupdates="windows" ${st.winupdates?.enabled ? 'checked' : ''}>
            <span>Allow customers to install Windows updates</span></label>
          <label class="check"><input type="checkbox" data-winupdates="linux" ${st.winupdates?.linux ? 'checked' : ''}>
            <span>Allow customers to install Linux package updates <span class="muted">(apt or dnf)</span></span></label>
        </section>

        <section class="security-card settings-card">
          <div class="settings-head">
            <h2 class="twofa-title">Server expiry</h2>
            <p class="muted">For customers or servers you give an expiry date (customer: <em>Limits</em>; server: the
              clock button in <em>Servers</em>). Reminders by email, stopped at expiry, deleted after the grace period —
              only servers the customer created; servers you assigned are only stopped.</p>
            ${e.configured ? '' : '<p class="small warn-text">Email is not set up: customers get no reminders, and nothing is deleted automatically (servers are only stopped).</p>'}
          </div>
          <form id="expiry-settings" class="email-form" novalidate>
            <div class="grid-3">
              <label>Reminders (days before)
                <input name="reminderDays" value="${esc((st.expiry.reminderDays ?? []).join(', '))}" placeholder="7, 1" pattern="[0-9 ,]*">
              </label>
              <label>Grace period (days)
                <input name="graceDays" type="number" min="0" max="365" value="${esc(st.expiry.graceDays)}" required>
                <span class="hint">Stopped but kept, then deleted.</span>
              </label>
              <label>Self-extension (days)
                <input name="selfExtendDays" type="number" min="1" max="365" value="${esc(st.expiry.selfExtendDays)}" required>
                <span class="hint">For customers allowed to extend once.</span>
              </label>
            </div>
            <label class="check"><input type="checkbox" name="pauseDeletions" ${st.expiry.pauseDeletions ? 'checked' : ''}>
              <span>Pause deletions <span class="muted">Expired servers are only stopped, never deleted, until you switch this off.</span></span></label>
            <label class="check"><input type="checkbox" name="adminSummary" ${st.expiry.adminSummary ? 'checked' : ''}>
              <span>Daily summary to administrators <span class="muted">Only on days when something happened or expires soon.</span></span></label>
            <div class="row">
              <button class="btn primary">Save</button>
              <button type="button" class="btn" data-expiry-run>Check now</button>
              <span class="muted small" id="expiry-result"></span>
            </div>
          </form>
        </section>

        <section class="security-card settings-card" ${e.configured ? '' : 'hidden'}>
          <div class="settings-head">
            <h2 class="twofa-title">Send a test email</h2>
            <p class="muted">Checks the settings end to end: connection, encryption, sign-in and delivery.</p>
          </div>
          <form id="email-test" class="vpn-form" novalidate>
            <label>Send to <input name="to" type="email" required value="${esc(me.email)}"></label>
            <button class="btn">Send test email</button>
          </form>
        </section>
      </div>`;
    warnPlain();
  }

  // Plain SMTP with a password sends that password unencrypted
  function warnPlain() {
    const f = root.querySelector('#email-form');
    if (!f) return;
    root.querySelector('#email-warning').textContent = f.security.value === 'none' && f.username.value
      ? 'Without encryption the SMTP password travels unencrypted. Use this only for a mail relay inside your own network.'
      : '';
  }

  root.addEventListener('input', (ev) => { if (ev.target.closest('#email-form')) warnPlain(); });
  root.addEventListener('change', (ev) => {
    const f = ev.target.closest('#email-form');
    if (!f || ev.target.name !== 'security') return;
    // suggest the usual port when it's still one of the defaults
    const usual = { starttls: 587, tls: 465, none: 25 };
    if ([587, 465, 25].includes(Number(f.port.value))) f.port.value = usual[f.security.value];
    warnPlain();
  });

  // Updates: server checkboxes (the shared click handler only looks at buttons)
  root.addEventListener('click', (e) => {
    if (jobs.handles(st.tab) && e.target.matches?.('input[data-pick], input[data-pick-all]')) jobs.onClick(e, st.tab);
  });

  // Public IPs: open a pool (click or Enter on its row)
  root.addEventListener('click', (e) => {
    if (ipam.handles(st.tab) && e.target.closest('tr[data-ipam-pool]') && !e.target.closest('a, button')) ipam.onClick(e, st.tab);
  });
  root.addEventListener('keydown', (e) => {
    if (ipam.handles(st.tab) && e.key === 'Enter' && e.target.closest?.('tr[data-ipam-pool]')) { e.preventDefault(); ipam.onClick(e, st.tab); }
  });

  // Billing: open an invoice (click or Enter on its row)
  root.addEventListener('click', (e) => {
    if (billing.handles(st.tab) && e.target.closest('tr[data-billing-invoice]') && !e.target.closest('a, button')) billing.onClick(e, st.tab);
  });
  root.addEventListener('keydown', (e) => {
    if (billing.handles(st.tab) && e.key === 'Enter' && e.target.closest?.('tr[data-billing-invoice]')) { e.preventDefault(); billing.onClick(e, st.tab); }
  });

  // Activity: open an event's details (click or Enter)
  root.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-activity]');
    if (row && !e.target.closest('a, button')) toggleActivity(row);
  });
  root.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('tr[data-activity]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleActivity(row); }
  });

  root.addEventListener('submit', async (ev) => {
    if (ev.target.id === 'activity-filter') {
      ev.preventDefault();
      const el = ev.target.elements;
      st.activityFilter = { actor: el.actor.value, category: el.category.value, q: el.q.value.trim() };
      load();
      return;
    }
    if (ev.target.id === 'billing-settings-form') {
      ev.preventDefault();
      try { st.billing = await billing.saveSettings(ev.target); renderSettings(); } catch (err) { fail(err); }
      return;
    }
    if (ev.target.id === 'ai-form') {
      ev.preventDefault();
      const el = ev.target.elements;
      const body = {
        provider: el.provider.value, model: el.model.value.trim(), baseUrl: el.baseUrl.value.trim(),
        dailyLimit: Number(el.dailyLimit.value), maxTokens: Number(el.maxTokens.value),
        handover: el.handover.checked, instructions: el.instructions.value, enabled: el.enabled.checked,
      };
      if (el.apiKey.value) body.apiKey = el.apiKey.value;
      try {
        st.ai = await api('/api/admin/settings/ai', { method: 'PUT', body });
        toast(st.ai.enabled ? 'AI assistant is on' : 'AI assistant settings saved');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (ev.target.id === 'zammad-form') {
      ev.preventDefault();
      const el = ev.target.elements;
      const body = {
        url: el.url.value.trim(), enabled: el.enabled.checked,
        groups: { L1: el.groupL1.value.trim(), L2: el.groupL2.value.trim(), L3: el.groupL3.value.trim() },
      };
      if (el.token.value) body.token = el.token.value;
      try {
        st.zammad = await api('/api/admin/settings/zammad', { method: 'PUT', body });
        toast(st.zammad.enabled ? 'Zammad connected' : 'Zammad settings saved');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (ev.target.id === 'branding-form') {
      ev.preventDefault();
      const el = ev.target.elements;
      try {
        st.branding = await api('/api/admin/settings/branding', { method: 'PUT', body: { name: el.name.value, supportUrl: el.supportUrl.value } });
        toast('Branding saved. Reload the page to see the new name everywhere.');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (ev.target.matches?.('form[data-sso]')) {
      ev.preventDefault();
      const f = ev.target;
      const el = f.elements;
      const body = {
        enabled: el.enabled.checked,
        clientId: el.clientId.value.trim(),
        portals: [el.portalCustomer.checked && 'customer', el.portalAdmin.checked && 'admin'].filter(Boolean),
        allowSignup: el.allowSignup.checked,
        allowedDomains: el.allowedDomains.value.split(/[\s,]+/).filter(Boolean),
      };
      if (el.clientSecret.value) body.clientSecret = el.clientSecret.value;
      if (el.tenant) body.tenant = el.tenant.value.trim();
      try {
        const saved = await api(`/api/admin/settings/sso/${encodeURIComponent(f.dataset.sso)}`, { method: 'PUT', body });
        st.sso.providers = st.sso.providers.map((p) => (p.id === saved.id ? saved : p));
        toast(`${saved.name} sign-in saved${saved.enabled ? ' and switched on' : ''}`);
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (ev.target.id === 'email-form') {
      ev.preventDefault();
      const f = ev.target;
      if (!f.reportValidity()) return;
      const body = {
        host: f.host.value.trim(),
        port: Number(f.port.value),
        security: f.security.value,
        username: f.username.value.trim(),
        fromName: f.fromName.value.trim(),
        fromAddress: f.fromAddress.value.trim(),
        panelUrl: f.panelUrl.value.trim(),
      };
      if (f.clearPassword?.checked) body.password = '';
      else if (f.password.value) body.password = f.password.value;
      try {
        st.email = await api('/api/admin/settings/email', { method: 'PUT', body });
        toast('Email settings saved');
        renderSettings();
      } catch (err) { fail(err); }
    }
    if (ev.target.id === 'expiry-settings') {
      ev.preventDefault();
      const f = ev.target;
      if (!f.reportValidity()) return;
      try {
        st.expiry = await api('/api/admin/settings/expiry', {
          method: 'PUT',
          body: {
            reminderDays: f.reminderDays.value.split(/[ ,]+/).filter(Boolean).map(Number),
            graceDays: Number(f.graceDays.value),
            selfExtendDays: Number(f.selfExtendDays.value),
            pauseDeletions: f.pauseDeletions.checked,
            adminSummary: f.adminSummary.checked,
          },
        });
        toast('Expiry settings saved');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (ev.target.id === 'email-test') {
      ev.preventDefault();
      const f = ev.target;
      if (!f.reportValidity()) return;
      const b = f.querySelector('button');
      b.disabled = true;
      b.textContent = 'Sending…';
      try {
        await api('/api/admin/settings/email/test', { method: 'POST', body: { to: f.to.value.trim() } });
        toast(`Test email sent to ${f.to.value.trim()}`);
      } catch (err) { fail(err); }
      b.disabled = false;
      b.textContent = 'Send test email';
    }
  });

  // ---- about --------------------------------------------------------------
  function renderAbout() {
    const a = st.about;
    const u = a.update ?? {};
    const date = (d) => (d ? new Date(d).toLocaleString() : '–');
    const uptime = (sec) => {
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
    };
    const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

    const status = !u.checked
      ? `<div class="notice about-notice"><p><strong>Couldn't check for updates.</strong> ${esc(u.reason ?? '')}</p></div>`
      : u.updateAvailable
        ? `<div class="notice warn about-notice">
             <p><strong>Version ${esc(u.latest.version)} is available</strong>${u.latest.publishedAt ? `, released ${esc(new Date(u.latest.publishedAt).toLocaleDateString())}` : ''}.
               ${ext(u.latest.url, "See what's new")}.</p>
           </div>`
        : u.latest
          ? `<div class="notice about-notice ok"><p><strong>You're running the latest release.</strong></p></div>`
          : `<div class="notice about-notice"><p>${esc(u.reason ?? 'No releases published yet.')}</p></div>`;

    root.querySelector('#admin-body').innerHTML = `
      <div class="about">
        <div class="about-head">
          <span class="about-version">v${esc(a.version)}</span>
          <span class="pill ${a.isRelease ? 'pill-running' : 'pill-busy'}">${a.isRelease ? 'Release' : 'Development build'}</span>
        </div>
        ${status}
        <dl class="specs cols-3">
          <div><dt>Version</dt><dd class="mono">${a.releaseUrl && a.isRelease ? ext(a.releaseUrl, esc(a.version)) : esc(a.version)}</dd></div>
          <div><dt>Commit</dt><dd class="mono">${a.commit ? (a.commitUrl ? ext(a.commitUrl, esc(a.commit.slice(0, 7))) : esc(a.commit.slice(0, 7))) : '–'}</dd></div>
          <div><dt>Built</dt><dd>${esc(date(a.buildDate))}</dd></div>
          <div><dt>Running since</dt><dd>${esc(date(a.startedAt))} <span class="muted small">(${esc(uptime(a.uptimeSeconds))})</span></dd></div>
          <div><dt>Node.js</dt><dd class="mono">${esc(a.node)}</dd></div>
          <div><dt>Source</dt><dd>${a.repoUrl ? ext(a.repoUrl, esc(a.repoUrl.replace(/^https:\/\//, ''))) : '–'}</dd></div>
        </dl>
        <div class="row">
          <button class="btn" data-check-updates>Check for updates now</button>
          ${u.checkedAt ? `<span class="muted small">Last checked ${esc(date(u.checkedAt))}</span>` : ''}
        </div>

        <h2 class="h2">How to update</h2>
        <ol class="about-steps">
          <li><strong>Portainer:</strong> Stacks, your stack, <em>Update the stack</em> with
            <em>Re-pull image and redeploy</em> switched on.</li>
          <li><strong>UGREEN Docker app:</strong> Project, your project, redeploy it (it pulls the image again).</li>
          <li><strong>Command line:</strong> <span class="mono">docker compose pull && docker compose up -d</span></li>
        </ol>
        <p class="muted small">If you pinned a release in <span class="mono">PANEL_IMAGE</span>, change the version
          there first. Your data stays in the volume; database changes are applied automatically at start.</p>
      </div>`;
  }

  // ---- activity ---------------------------------------------------------
  // ---- activity ----------------------------------------------------------
  const ACTORS = [['', 'Everyone'], ['customer', 'Customers'], ['admin', 'Administrators'], ['system', 'Panel (automatic)'], ['anonymous', 'Unknown sign-ins']];
  const CATEGORIES = [['', 'Any action'], ['create', 'Created / started'], ['change', 'Changed'], ['delete', 'Deleted / removed'], ['power', 'Power / expiry'], ['security', 'Sign-in & security']];
  const ACTOR_TAG = { customer: 'Customer', admin: 'Admin', system: 'Panel', anonymous: 'Unknown' };

  async function loadActivity({ more = false } = {}) {
    const f = st.activityFilter ??= { actor: '', category: '', q: '' };
    const params = new URLSearchParams({ limit: '100' });
    for (const k of ['actor', 'category', 'q']) if (f[k]) params.set(k, f[k]);
    if (more && st.activityNext) params.set('before', String(st.activityNext));
    const r = await api(`/api/admin/activity?${params}`);
    st.audit = more ? [...st.audit, ...r.events] : r.events;
    st.activityNext = r.nextBefore;
  }

  function activityDetail(a) {
    let d = null;
    try { d = a.detail ? JSON.parse(a.detail) : null; } catch { return ''; }
    if (!d) return '';
    let short = '';
    if (d.email && (a.action.startsWith('admin_') || a.action.endsWith('login_failed'))) short = d.email;
    if (d.hostname) short = d.hostname;
    if (d.label && a.action.startsWith('admin_template')) short = d.label;
    if (d.error) short = d.error;
    if (d.reason && a.action.includes('sso')) short = d.reason;
    if (d.provider && a.action.includes('sso')) short = [d.provider, d.reason].filter(Boolean).join(': ');
    if (d.passkey) short = d.reason ? `passkey: ${d.reason}` : 'with a passkey';
    return short;
  }

  function renderActivity() {
    const f = st.activityFilter ??= { actor: '', category: '', q: '' };
    root.querySelector('#admin-body').innerHTML = `
      <form id="activity-filter" class="activity-filter" role="search">
        <label class="grow"><span class="sr-only">Search</span>
          <input type="search" name="q" value="${esc(f.q)}" placeholder="Search customer email, server ID, IP, action…"></label>
        <label><span class="sr-only">Who</span><select name="actor">${ACTORS.map(([k, l]) => `<option value="${k}" ${f.actor === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label><span class="sr-only">Action</span><select name="category">${CATEGORIES.map(([k, l]) => `<option value="${k}" ${f.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn">Filter</button>
        <button type="button" class="btn ghost" data-refresh-audit>Refresh</button>
      </form>
      <p class="muted small">${st.audit.length} event${st.audit.length === 1 ? '' : 's'}${st.activityNext ? ' shown, more available' : ''}, newest first. Click an event for its details.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Time</th><th>Who</th><th>What</th><th>Server</th><th>IP address</th></tr></thead>
          <tbody>
            ${st.audit.length ? st.audit.map((a, i) => {
              const detail = activityDetail(a);
              return `
              <tr class="${a.action.endsWith('_failed') ? 'row-warn' : ''} activity-row" data-activity="${i}" tabindex="0" aria-expanded="false">
                <td class="nowrap">${utc(a.createdAt).toLocaleString()}</td>
                <td><span class="tag">${ACTOR_TAG[a.actor] ?? ''}</span> ${esc(a.email ?? '–')}</td>
                <td>${esc(ACTION_LABELS[a.action] ?? a.action)}${detail ? ` <span class="muted">${esc(detail)}</span>` : ''}</td>
                <td class="mono">${a.vmid ?? ''}</td>
                <td class="mono muted">${esc(a.ip ?? '')}</td>
              </tr>`;
            }).join('') : '<tr><td colspan="5" class="muted">No events match.</td></tr>'}
          </tbody>
        </table>
      </div>
      ${st.activityNext ? '<div class="row"><button class="btn" data-more-activity>Load more</button></div>' : ''}`;
  }

  /** Shows the full record of an event under its row. */
  function toggleActivity(row) {
    const next = row.nextElementSibling;
    if (next?.classList.contains('activity-more')) { next.remove(); row.setAttribute('aria-expanded', 'false'); return; }
    const a = st.audit[Number(row.dataset.activity)];
    let pretty = a.detail ?? '';
    try { pretty = JSON.stringify(JSON.parse(a.detail), null, 2); } catch { /* as stored */ }
    if (pretty === 'null') pretty = '';
    row.insertAdjacentHTML('afterend', `
      <tr class="activity-more"><td colspan="5">
        <dl class="activity-dl">
          <dt>Event</dt><dd class="mono">#${a.id} · ${esc(a.action)} · ${esc(a.category)}</dd>
          <dt>Account</dt><dd>${esc(a.email ?? '–')}${a.userId ? ` <span class="muted">(ID ${a.userId})</span>` : ''}</dd>
          <dt>Time (UTC)</dt><dd class="mono">${esc(a.createdAt)}</dd>
          ${pretty ? `<dt>Details</dt><dd><pre class="activity-json">${esc(pretty)}</pre></dd>` : ''}
        </dl>
      </td></tr>`);
    row.setAttribute('aria-expanded', 'true');
  }

  // ---- events (bound once) ----------------------------------------------
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (infra.handles(st.tab) && !t.dataset.adminTab && await infra.onClick(e, st.tab)) return;
    if (desk.handles(st.tab) && !t.dataset.adminTab && await desk.onClick(e, st.tab)) return;
    if (billing.handles(st.tab) && !t.dataset.adminTab && await billing.onClick(e, st.tab)) return;
    if (volumes.handles(st.tab) && !t.dataset.adminTab && await volumes.onClick(e, st.tab)) return;
    if (ipam.handles(st.tab) && !t.dataset.adminTab && await ipam.onClick(e, st.tab)) return;
    if (hosts.handles(st.tab) && !t.dataset.adminTab && await hosts.onClick(e, st.tab)) return;
    if (jobs.handles(st.tab) && !t.dataset.adminTab && await jobs.onClick(e, st.tab)) return;
    if (plans.handles(st.tab) && !t.dataset.adminTab && await plans.onClick(e, st.tab)) return;

    if (t.hasAttribute('data-ai-test')) {
      t.disabled = true;
      try {
        const r = await api('/api/admin/settings/ai/test', { method: 'POST' });
        toast(`The model answered: “${r.answer}”`);
      } catch (err) { fail(err); }
      t.disabled = false;
      return;
    }
    if (t.hasAttribute('data-zammad-test')) {
      t.disabled = true;
      try {
        const r = await api('/api/admin/settings/zammad/test', { method: 'POST' });
        toast(`Zammad answers (signed in as ${r.user ?? 'the token user'})${r.missing.length ? `. Groups not found: ${r.missing.join(', ')}` : ''}`, r.missing.length ? 'warn' : 'info');
      } catch (err) { fail(err); }
      t.disabled = false;
      return;
    }
    if (t.hasAttribute('data-zammad-retry')) {
      try {
        const r = await api('/api/admin/settings/zammad/retry', { method: 'POST' });
        toast(`Sent ${r.tickets} ticket${r.tickets === 1 ? '' : 's'} and ${r.messages} message${r.messages === 1 ? '' : 's'}`);
        st.zammad = await api('/api/admin/settings/zammad');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (t.hasAttribute('data-zammad-secret')) {
      if (!(await confirmAction('Make a new signature token? Zammad keeps sending with the old one until you paste the new token into its webhook.', 'New token'))) return;
      try { st.zammad = await api('/api/admin/settings/zammad', { method: 'PUT', body: { newSecret: true } }); renderSettings(); } catch (err) { fail(err); }
      return;
    }
    if (t.dataset.brandRemove) {
      try {
        st.branding = await api(`/api/admin/settings/branding/${t.dataset.brandRemove}`, { method: 'DELETE' });
        toast('Using the built-in image again');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }

    if (t.dataset.adminTab) {
      st.tab = t.dataset.adminTab;
      st.newUser = null;
      render();
      load();
      return;
    }

    if (t.hasAttribute('data-resend-invite')) {
      const u = st.users.find((x) => x.id === Number(t.closest('[data-user]').dataset.user));
      t.disabled = true;
      try {
        await api(`/api/admin/users/${u.id}/invite`, { method: 'POST' });
        toast(`Invitation sent to ${u.email}. Earlier links no longer work.`);
        st.users = await api('/api/admin/users');
        renderUsers();
      } catch (err) { fail(err); t.disabled = false; }
      return;
    }

    if (t.hasAttribute('data-generate')) {
      const form = t.closest('form');
      const pw = generatePassword();
      form.password.value = pw;
      form.password.type = 'text';
      form.dataset.generated = pw;
      return;
    }

    if (t.hasAttribute('data-copy-password')) {
      await navigator.clipboard?.writeText(st.newUser.password)
        .then(() => toast('Password copied'))
        .catch(() => toast('Copy failed. Select the password and copy it manually.', 'error'));
      return;
    }

    if (t.hasAttribute('data-dismiss-note')) {
      st.newUser = null;
      renderUsers();
      return;
    }

    if (t.dataset.showServers) {
      st.tab = 'servers';
      st.filter = t.dataset.showServers;
      render();
      load();
      return;
    }

    if (t.hasAttribute('data-refresh-audit')) {
      load();
      return;
    }
    if (t.hasAttribute('data-more-activity')) {
      t.disabled = true;
      try { await loadActivity({ more: true }); renderActivity(); } catch (err) { fail(err); t.disabled = false; }
      return;
    }

    if (t.dataset.schemePick) {
      // live preview on this page; Save applies it for everyone
      st.schemePreview = t.dataset.schemePick;
      document.documentElement.dataset.scheme = st.schemePreview;
      root.querySelectorAll('[data-scheme-pick]').forEach((b) => b.setAttribute('aria-checked', String(b === t)));
      const changed = st.schemePreview !== st.appearance.scheme;
      root.querySelector('[data-scheme-save]').disabled = !changed;
      root.querySelector('[data-scheme-cancel]').hidden = !changed;
      root.querySelector('#scheme-note').textContent = changed ? 'Preview on this page only. Save to apply it everywhere.' : '';
      return;
    }
    if (t.hasAttribute('data-scheme-cancel')) {
      st.schemePreview = null;
      applyScheme(st.appearance.scheme);
      renderSettings();
      return;
    }
    if (t.hasAttribute('data-scheme-save')) {
      try {
        st.appearance = await api('/api/admin/settings/appearance', { method: 'PUT', body: { scheme: st.schemePreview } });
        applyScheme(st.appearance.scheme);
        st.schemePreview = null;
        const name = st.appearance.schemes.find((x) => x.id === st.appearance.scheme)?.name;
        toast(`Color scheme “${name}” is now used everywhere. Open pages pick it up when they reload.`);
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }

    if (t.hasAttribute('data-expiry-run')) {
      t.disabled = true;
      try {
        const r = await api('/api/admin/expiry/run', { method: 'POST' });
        const parts = [['stopped', r.stopped], ['deleted', r.deleted], ['reminded', r.reminded], ['waiting for your decision', r.awaitingAdmin],
          ['deletion paused', r.paused], ['not deleted (no email)', r.blocked]].filter(([, l]) => l?.length).map(([k, l]) => `${l.length} ${k}`);
        root.querySelector('#expiry-result').textContent = parts.length ? `Done: ${parts.join(', ')}.` : 'Done: nothing to do.';
        if (r.errors?.length) toast(r.errors.join(' '), 'error');
      } catch (err) { fail(err); }
      t.disabled = false;
      return;
    }

    if (t.hasAttribute('data-email-remove')) {
      if (!(await confirmAction('Remove the email settings? Invitations can no longer be sent until email is set up again.', 'Remove'))) return;
      try {
        await api('/api/admin/settings/email', { method: 'DELETE' });
        st.email = await api('/api/admin/settings/email');
        toast('Email settings removed');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }

    if (t.hasAttribute('data-check-updates')) {
      st.refreshAbout = true;
      t.disabled = true;
      t.textContent = 'Checking…';
      load({ quiet: true });
      return;
    }

    if (t.hasAttribute('data-vpn-sync')) {
      try {
        await api('/api/admin/vpn/sync', { method: 'POST' });
        toast('VPN configuration re-applied on the gateway');
      } catch (err) { fail(err); }
      load();
      return;
    }

    if (t.dataset.vpnRemove) {
      if (!(await confirmAction(`Remove VPN device “${t.dataset.name}”? It can no longer connect.`, 'Remove'))) return;
      try {
        await api(`/api/admin/vpn/devices/${t.dataset.vpnRemove}`, { method: 'DELETE' });
        toast(`${t.dataset.name} removed`);
      } catch (err) { fail(err); }
      load();
      return;
    }

    if (t.dataset.serverAction) {
      const vm = st.vms.find((x) => x.vmid === Number(t.closest('tr').dataset.vmid));
      if (vm) serverAction(vm, t.dataset.serverAction);
      return;
    }

    if (t.hasAttribute('data-save-template')) {
      saveTemplate(t.closest('tr'));
      return;
    }

    const userRow = t.closest('[data-user]');
    if (!userRow) return;
    const user = st.users.find((u) => u.id === Number(userRow.dataset.user));

    if (t.hasAttribute('data-twofa')) {
      editTwoFactor(user);
      return;
    }

    if (t.hasAttribute('data-limits')) {
      if (await editLimits(user)) {
        st.users = await api('/api/admin/users');
        renderUsers();
      }
      return;
    }

    if (t.hasAttribute('data-reset')) {
      const password = await promptText(`New password for ${user.email}`, {
        value: generatePassword(),
        hint: 'At least 12 characters. A random password is filled in; copy it before saving.',
        okLabel: 'Reset password',
        minLength: 12,
      });
      if (!password) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { password } });
        toast(`Password reset for ${user.email}`);
      } catch (err) { fail(err); }
    }

    if (t.hasAttribute('data-toggle-admin')) {
      const makeAdmin = !user.isAdmin;
      const ok = await confirmAction(
        makeAdmin
          ? `Make ${user.email} an administrator? They will be able to see and manage all customers and servers.`
          : `Remove administrator rights from ${user.email}?`,
        makeAdmin ? 'Make admin' : 'Remove admin'
      );
      if (!ok) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { isAdmin: makeAdmin } });
        user.isAdmin = makeAdmin;
        toast(makeAdmin ? `${user.email} is now an administrator` : `${user.email} is now a customer`);
        renderUsers();
      } catch (err) { fail(err); }
    }

    if (t.hasAttribute('data-delete-user')) {
      deleteCustomer(user);
    }
  });

  root.addEventListener('change', async (e) => {
    if (e.target.matches?.('[data-brand-upload]')) {
      const input = e.target;
      const file = input.files?.[0];
      if (!file) return;
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      }).catch(() => null);
      if (data === null) return fail(new Error('The file could not be read'));
      try {
        st.branding = await api(`/api/admin/settings/branding/${input.dataset.brandUpload}`, { method: 'PUT', body: { type: file.type, data } });
        toast('Image saved');
        renderSettings();
      } catch (err) { fail(err); }
      return;
    }
    if (e.target.matches?.('[data-allow-personal]')) {
      const box = e.target;
      try {
        st.appearance = await api('/api/admin/settings/appearance', { method: 'PUT', body: { allowPersonal: box.checked } });
        toast(box.checked ? 'Users can choose their own appearance' : 'Everyone sees the panel scheme');
      } catch (err) { fail(err); box.checked = !box.checked; }
      return;
    }
    if (e.target.matches?.('[data-winupdates]')) {
      const box = e.target;
      try {
        const linux = box.dataset.winupdates === 'linux';
        st.winupdates = await api('/api/admin/settings/winupdates', { method: 'PUT', body: linux ? { linux: box.checked } : { enabled: box.checked } });
        const what = linux ? 'Linux package updates' : 'Windows updates';
        toast(box.checked ? `Customers can install ${what}` : `${what} through the panel are switched off`);
      } catch (err) { fail(err); box.checked = !box.checked; }
      return;
    }
    if (e.target.name === 'invite' && e.target.closest('#user-form')) {
      const form = e.target.closest('#user-form');
      const on = e.target.checked;
      form.querySelector('#pw-field').hidden = on;
      form.password.required = !on;
      form.password.disabled = on;
      return;
    }
    const row = e.target.closest('tr[data-vmid]');
    if (row && (e.target.matches('[data-owner]') || e.target.matches('[data-label]'))) saveAssignment(row);
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-label]')) e.target.blur(); // blur fires "change"
  });

  root.addEventListener('input', (e) => {
    if (e.target.id === 'vm-filter') {
      st.filter = e.target.value;
      renderServerRows();
    }
  });

  root.addEventListener('change', (e) => {
    if (infra.handles(st.tab)) infra.onChange(e, st.tab);
    if (desk.handles(st.tab)) desk.onChange(e, st.tab);
    if (plans.handles(st.tab)) plans.onChange(e, st.tab);
    if (jobs.handles(st.tab)) jobs.onChange(e, st.tab);
  });

  root.addEventListener('submit', (e) => {
    if (infra.handles(st.tab)) {
      e.preventDefault();
      infra.onSubmit(e, st.tab);
      return;
    }
    if (desk.handles(st.tab)) {
      e.preventDefault();
      desk.onSubmit(e, st.tab);
      return;
    }
    if (billing.handles(st.tab)) {
      e.preventDefault();
      billing.onSubmit(e, st.tab);
      return;
    }
    if (volumes.handles(st.tab)) {
      e.preventDefault();
      volumes.onSubmit(e, st.tab);
      return;
    }
    if (ipam.handles(st.tab)) {
      e.preventDefault();
      ipam.onSubmit(e, st.tab);
      return;
    }
    if (jobs.handles(st.tab)) {
      e.preventDefault();
      jobs.onSubmit(e, st.tab);
      return;
    }
    if (hosts.handles(st.tab)) {
      e.preventDefault();
      hosts.onSubmit(e, st.tab);
      return;
    }
    if (plans.handles(st.tab)) {
      e.preventDefault();
      plans.onSubmit(e, st.tab);
      return;
    }
    if (e.target.id !== 'user-form') return;
    e.preventDefault();
    createUser(e.target);
  });

  /** Role and permissions decide which tabs show; the first allowed tab opens. */
  async function loadPermissions() {
    try {
      const me = await api('/api/admin/me');
      st.perms = new Set(me.permissions);
      infra.setPermissions(me.permissions);
      desk.setPermissions(me.permissions);
      billing.setPermissions(me.permissions);
      volumes.setPermissions(me.permissions);
      ipam.setPermissions(me.permissions);
      hosts.setPermissions(me.permissions);
      jobs.setPermissions(me.permissions);
      plans.setPermissions(me.permissions);
    } catch (err) {
      fail(err);
    }
    // Back from linking a sign-in provider: open the account page with the result
    const q = new URLSearchParams(location.search);
    if (q.has('sso_linked') || (q.has('sso_error') && location.hash === '#account')) st.tab = 'account';
    if (!allowedTab(st.tab)) st.tab = ['overview', 'servers', 'users', 'resources', 'gpu', 'storage', 'account'].find(allowedTab);
  }

  return {
    async open() {
      await loadPermissions();
      render();
      load();
    },
    openTab(tab) {
      st.tab = tab;
      render();
      load();
    },
  };
}
