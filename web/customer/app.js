import {
  $, esc, api, toast, fail, confirmAction, promptText, generatePassword,
  bytes, pct, duration, SignedOut, setUnauthorizedHandler,
} from '/shared/ui.js';
import { icon, osIcon, brandMark, applyBrand, applyPersonal } from '/shared/icons.js';
import { netMap } from '/netmap.js';
import { signInSecondStep, renderSecurity } from '/shared/twofa.js';
import { prepareSignIn, resumeSso } from '/shared/signin.js';
import { renderPasskeys } from '/shared/passkeys.js';
import { renderIdentities } from '/shared/identities.js';
import { renderAppearance, loadPersonalAppearance } from '/shared/appearance.js';
import { createSupport } from '/support.js';
import { createAssistant } from '/assistant.js';
import { createBilling } from '/billing.js';
import { createStorage } from '/storage.js';
import { createPublicIps } from '/publicips.js';
import { renderTokens } from '/shared/tokens.js';
import { planFieldset, updatePlanChoice, planBody, openUpgrade } from '/plans.js';

const brandReady = applyBrand();
document.querySelectorAll('[data-brand-mark]').forEach((el) => { el.innerHTML = brandMark(30); });

setUnauthorizedHandler(() => showLogin());

const OS_NAMES = {
  l26: 'Linux', l24: 'Linux 2.4', win11: 'Windows 11 / 2022+', win10: 'Windows 10 / 2016–2019',
  win8: 'Windows 8 / 2012', win7: 'Windows 7 / 2008 R2', other: 'Other',
  debian: 'Debian', ubuntu: 'Ubuntu', centos: 'CentOS', alpine: 'Alpine', fedora: 'Fedora',
  archlinux: 'Arch Linux', rocky: 'Rocky Linux', almalinux: 'AlmaLinux', opensuse: 'openSUSE',
};

// ---------- state ----------------------------------------------------------
const state = {
  me: null,
  account: { canCreate: false },
  templates: null,       // loaded when the create form opens
  view: 'overview',      // 'overview' | 'server' | 'create' | 'vpn'
  vpnSummary: null,      // devices for the network map
  mapAnimated: false,    // the map draws itself in once per session
  vms: [],
  selected: null,        // vmid
  detail: null,
  tab: 'overview',
  timeframe: 'hour',
  busy: new Set(),       // vmids with a running task
};

// ---------- sign-in --------------------------------------------------------
function resetLogin() {
  const box = $('#login-2fa');
  box.hidden = true;
  box.innerHTML = '';
  $('#login-form').hidden = false;
  $('#login-form [name=email]').focus();
}

const signInReady = prepareSignIn($('#login-form'), {
  onSignedIn: (me) => { resetLogin(); startApp(me); },
});

async function showLogin() {
  clearInterval(state.poll);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  resetLogin();
  await signInReady;
  resumeSso({
    form: $('#login-form'),
    box: $('#login-2fa'),
    errorEl: $('#login-error'),
    onSignedIn: (me) => { resetLogin(); startApp(me); },
    onRestart: resetLogin,
  });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#login-error');
  err.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const email = form.email.value;
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: form.password.value },
    });
    form.reset();
    if (r.twoFactor) {
      // Password was right; now the code (or the forced 2FA setup)
      form.hidden = true;
      const box = $('#login-2fa');
      box.hidden = false;
      signInSecondStep(box, {
        stage: r.twoFactor,
        email,
        onSignedIn: (me) => { resetLogin(); startApp(me); },
        onRestart: resetLogin,
      });
    } else {
      startApp(r);
    }
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  applyPersonal(null);
  state.selected = null;
  state.view = 'overview';
  state.mapAnimated = false;
  history.replaceState(null, '', location.pathname); // next sign-in starts on the overview
  showLogin();
});

// ---------- server list ----------------------------------------------------
async function loadList() {
  state.vms = await api('/api/vms');
  renderList();
}

const STATE_TEXT = { creating: 'Setting up…', deleting: 'Deleting…', failed: 'Setup failed' };

/** 'running' | 'stopped' | 'busy' | 'failed' — drives colours everywhere. */
function statusOf(vm) {
  if (vm.state === 'failed') return 'failed';
  if (vm.state !== 'ready' || state.busy.has(vm.vmid)) return 'busy';
  return vm.status === 'running' ? 'running' : 'stopped';
}
const statusWord = (vm) => STATE_TEXT[vm.state]
  ?? (state.busy.has(vm.vmid) ? 'Working…' : vm.status === 'running' ? 'Running' : 'Stopped');

// Support tickets and the help center (own module)
const support = createSupport({
  state,
  renderList: () => renderList(),
  setView(view, hash) {
    state.view = view;
    state.selected = null;
    history.replaceState(null, '', hash);
    renderList();
  },
});
// AI assistant (own module; shown when the provider has set it up)
const assistant = createAssistant({
  state,
  renderList: () => renderList(),
  setView(view, hash) {
    state.view = view;
    state.selected = null;
    history.replaceState(null, '', hash);
    renderList();
  },
  openTicket: (number) => support.openSupport(String(number)),
});
// Billing (own module; shown when the provider bills through the panel)
const billing = createBilling({
  state,
  renderList: () => renderList(),
  setView(view, hash) {
    state.view = view;
    state.selected = null;
    history.replaceState(null, '', hash);
    renderList();
  },
});
// Block volumes and object storage (own module; shown when offered)
const storage = createStorage({
  state,
  renderList: () => renderList(),
  setView(view, hash) {
    state.view = view;
    state.selected = null;
    history.replaceState(null, '', hash);
    renderList();
  },
});
window.addEventListener('hashchange', () => {
  if (state.me && !assistant.route(location.hash) && !billing.route(location.hash) && !storage.route(location.hash)) support.route(location.hash);
});

function renderList() {
  const supportViews = ['support', 'support-new', 'ticket'];
  $('#rack-actions').innerHTML = [
    `<button class="nav-item" id="nav-overview" aria-current="${state.view === 'overview'}">${icon('overview')}<span>Overview</span></button>`,
    state.account.canCreate
      ? `<button class="nav-item" id="new-server" aria-current="${state.view === 'create'}">${icon('plus')}<span>New server</span></button>` : '',
    state.account.vpn?.enabled
      ? `<button class="nav-item" id="vpn-access" aria-current="${state.view === 'vpn'}">${icon('shield')}<span>VPN access</span></button>` : '',
    state.assistantEnabled
      ? `<button class="nav-item" id="nav-assistant" aria-current="${state.view === 'assistant'}">${icon('spark')}<span>AI assistant</span></button>` : '',
    state.storageEnabled
      ? `<button class="nav-item" id="nav-storage" aria-current="${state.view === 'storage'}">${icon('disk')}<span>Storage</span></button>` : '',
    state.billingEnabled
      ? `<button class="nav-item" id="nav-billing" aria-current="${['billing', 'invoice'].includes(state.view)}">${icon('wallet')}<span>Billing</span></button>` : '',
    `<button class="nav-item" id="nav-support" aria-current="${supportViews.includes(state.view)}">${icon('chat')}<span>Support</span>${state.supportWaiting ? `<span class="nav-badge" title="Tickets waiting for your reply">${state.supportWaiting}</span>` : ''}</button>`,
    `<button class="nav-item" id="nav-help" aria-current="${['help', 'article'].includes(state.view)}">${icon('book')}<span>Help center</span></button>`,
  ].join('');

  $('#vm-count').textContent = state.vms.length ? String(state.vms.length) : '';
  $('#vm-list').innerHTML = state.vms.length ? state.vms.map((vm) => `
      <li>
        <button class="unit" data-vmid="${vm.vmid}" aria-current="${state.view === 'server' && vm.vmid === state.selected}">
          <span class="unit-glyph status-${statusOf(vm)}">${osIcon(vm.os, 18)}<i class="led"></i></span>
          <span class="unit-text">
            <span class="unit-name">${esc(vm.name)}</span>
            <span class="unit-meta">${esc(statusWord(vm))}</span>
          </span>
        </button>
      </li>`).join('')
    : '<li class="side-empty">No servers yet</li>';
}

$('#vm-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.unit');
  if (btn) select(Number(btn.dataset.vmid));
});

// ---------- overview ---------------------------------------------------------
async function openHome() {
  state.view = 'overview';
  state.selected = null;
  history.replaceState(null, '', location.pathname);
  renderList();
  renderHome();
  if (state.account.vpn?.enabled) {
    try {
      state.vpnSummary = await api('/api/vpn');
      if (state.view === 'overview') renderMap(false);
    } catch { /* the map simply shows no device count */ }
  }
}

function renderMap(animate) {
  const holder = $('#netmap-holder');
  if (!holder) return;
  holder.innerHTML = netMap({
    vms: state.vms,
    network: state.account.network,
    vpn: state.account.vpn?.enabled ? { enabled: true, devices: state.vpnSummary?.devices ?? [] } : null,
    busy: state.busy,
    animate,
  });
  // On narrow screens the map scrolls sideways; start centred on the hub.
  const card = holder.parentElement;
  if (card.scrollWidth > card.clientWidth) card.scrollLeft = (card.scrollWidth - card.clientWidth) / 2;
}

function serverRow(vm) {
  const st = statusOf(vm);
  const memShare = vm.maxmem ? vm.mem / vm.maxmem : 0;
  const ready = vm.state === 'ready' && vm.status === 'running';
  const facts = [
    vm.os === 'windows' ? 'Windows' : vm.os === 'linux' ? 'Linux' : null,
    vm.cores ? `${vm.cores} ${vm.cores === 1 ? 'core' : 'cores'}` : null,
    vm.maxmem ? `${bytes(vm.maxmem)} memory` : null,
    vm.maxdisk ? `${bytes(vm.maxdisk)} disk` : null,
  ].filter(Boolean).join(', ');
  return `
    <li>
      <button class="server-row" data-vmid="${vm.vmid}">
        <span class="os-tile os-${vm.os ?? 'other'}">${osIcon(vm.os, 22)}</span>
        <span class="row-main">
          <span class="row-name">${esc(vm.name)}</span>
          <span class="row-facts">${esc(facts || (vm.type === 'lxc' ? 'Container' : 'Virtual machine'))} ${expiryBadge(vm.expiry)}</span>
        </span>
        <span class="pill pill-${st}">${esc(statusWord(vm))}</span>
        <span class="row-load" ${ready ? '' : 'hidden'}>
          <span class="load"><span class="load-label">CPU</span><span class="meter"><i style="width:${Math.min(100, (vm.cpu ?? 0) * 100)}%"></i></span><span class="load-val">${pct(vm.cpu)}</span></span>
          <span class="load"><span class="load-label">Memory</span><span class="meter"><i style="width:${Math.min(100, memShare * 100)}%"></i></span><span class="load-val">${pct(memShare)}</span></span>
        </span>
      </button>
    </li>`;
}

function renderHome() {
  const running = state.vms.filter((v) => v.state === 'ready' && v.status === 'running').length;
  const n = state.vms.length;
  const lede = n
    ? `${n} server${n === 1 ? '' : 's'}, ${running} running.`
    : state.account.canCreate
      ? 'You have no servers yet. Create your first one; it is ready to use in a few minutes.'
      : 'You have no servers yet. When your provider adds one to your account, it appears here.';

  $('#detail').innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Overview</h1>
          <p class="lede">${lede}</p>
        </div>
        ${state.account.canCreate ? `<button class="btn primary" data-open-create>${icon('plus')}<span>New server</span></button>` : ''}
      </header>
      <section class="map-card" aria-label="Network map">
        <div id="netmap-holder"></div>
        ${state.account.network ? `<p class="map-note">Servers in your private network reach the internet and each other.
          Other customers and internal networks are blocked.</p>` : ''}
      </section>
      ${n ? `
        <section class="server-list">
          <h2 class="h2">Servers</h2>
          <ul class="rows">${state.vms.map(serverRow).join('')}</ul>
        </section>` : ''}
    </div>`;

  const animate = !state.mapAnimated;
  state.mapAnimated = true;
  renderMap(animate);
}

async function select(vmid) {
  if (!state.vms.some((v) => v.vmid === vmid)) return openHome();
  state.view = 'server';
  state.selected = vmid;
  state.tab = 'overview';
  renderList();
  history.replaceState(null, '', `#${vmid}`);
  await loadDetail();
}

// ---------- detail ---------------------------------------------------------
async function loadDetail() {
  if (!state.selected || state.view !== 'server') return;
  const listed = state.vms.find((v) => v.vmid === state.selected);
  if (listed && listed.state !== 'ready') {
    renderPending(listed);
    return;
  }
  try {
    state.detail = await api(`/api/vms/${state.selected}`);
    renderDetail();
  } catch (err) { fail(err); }
}

const crumbs = () => `
  <nav class="crumbs" aria-label="Breadcrumb">
    <button class="link-btn" data-open="overview">${icon('back', { size: 16 })}<span>Overview</span></button>
  </nav>`;

function renderPending(vm) {
  const st = statusOf(vm);
  const body = {
    creating: `
      ${vm.progress ? `<p class="progress-step"><span class="spinner" aria-hidden="true"></span>${esc(vm.progress)}…</p>` : ''}
      <p>Your server is being set up. Linux servers are usually ready in a few minutes; Windows
        servers take 10 to 20 minutes because Windows finishes its own setup first. This page updates by itself.</p>
      <p class="muted">When it's ready you can sign in with the user and password or SSH key you chose.</p>`,
    deleting: '<p class="progress-step"><span class="spinner" aria-hidden="true"></span>Deleting the server and its disks…</p>',
    failed: `
      <p>Setting up this server didn't work.</p>
      ${vm.error ? `<p class="error-box">${esc(vm.error)}</p>` : ''}
      <p class="muted">${vm.reinstallable && state.account.canCreate
        ? 'Reinstall it to try again, remove it, or contact support if it keeps happening.'
        : 'Remove it and try again, or contact support if it keeps happening.'}</p>
      <div class="row">
        ${vm.reinstallable && state.account.canCreate ? `<button class="btn" data-reinstall>${icon('restart')}<span>Reinstall</span></button>` : ''}
        ${vm.deletable ? `<button class="btn danger" data-delete-server>${icon('trash')}<span>Remove server</span></button>` : ''}
      </div>`,
  }[vm.state];
  $('#detail').innerHTML = `
    <div class="page">
      ${crumbs()}
      <header class="server-head">
        <span class="os-tile os-${vm.os ?? 'other'} big">${osIcon(vm.os, 28)}</span>
        <div class="server-title">
          <h1>${esc(vm.name)}</h1>
          <p class="state-line"><span class="pill pill-${st}">${esc(STATE_TEXT[vm.state])}</span></p>
        </div>
      </header>
      <div class="pending">${body}</div>
    </div>`;
}

function renderDetail() {
  const vm = state.detail;
  const busy = state.busy.has(vm.vmid);
  const running = vm.status === 'running';
  const st = busy ? 'busy' : running ? 'running' : 'stopped';
  const statusText = busy ? 'Working…' : running ? `Running for ${duration(vm.uptime)}` : 'Stopped';
  const facts = [
    OS_NAMES[vm.os] ?? null,
    vm.cores ? `${vm.cores} ${vm.cores === 1 ? 'core' : 'cores'}` : null,
    vm.memoryMb ? `${bytes(vm.memoryMb * 1024 * 1024)} memory` : null,
  ].filter(Boolean).join(', ');
  const tabs = [['overview', 'Overview', 'chart'], ['snapshots', 'Snapshots', 'camera'], ['console', 'Console', 'terminal']];
  if (state.account.tailscale) tabs.push(['remote', 'Remote access', 'link']);
  // through the QEMU guest agent: virtual machines only, not containers
  if (vm.type !== 'lxc' && (vm.osFamily === 'windows' || vm.osFamily === 'linux')) tabs.push(['updates', 'Updates', 'download']);

  $('#detail').innerHTML = `
    <div class="page">
      ${crumbs()}
      <header class="server-head">
        <span class="os-tile os-${vm.osFamily ?? 'other'} big">${osIcon(vm.osFamily, 28)}</span>
        <div class="server-title">
          <h1>${esc(vm.name)}</h1>
          <p class="state-line"><span class="pill pill-${st}">${statusText}</span><span class="muted">${esc(facts)}</span></p>
        </div>
        <div class="power" role="group" aria-label="Power">
          <button class="btn primary" data-power="start" ${running || busy || vm.expiry?.expired ? 'disabled' : ''}>${icon('play')}<span>Start</span></button>
          <button class="btn" data-power="shutdown" ${!running || busy ? 'disabled' : ''}>${icon('power')}<span>Shut down</span></button>
          <button class="btn" data-power="reboot" ${!running || busy ? 'disabled' : ''}>${icon('restart')}<span>Restart</span></button>
          <button class="btn danger" data-power="stop" ${!running || busy ? 'disabled' : ''}>${icon('stop')}<span>Force stop</span></button>
        </div>
      </header>
      ${expiryBanner(vm)}
      <p class="server-help"><button type="button" class="link-btn" data-help-server>${icon('chat', { size: 15 })}<span>Problem with this server? Ask support</span></button></p>

      <div class="tabs" role="tablist">
        ${tabs.map(([id, label, ic]) => `
          <button class="tab" role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${icon(ic, { size: 16 })}<span>${label}</span></button>`).join('')}
      </div>
      <section id="tab-body"></section>
    </div>`;

  renderTab();
}

function renderTab() {
  const body = $('#tab-body');
  if (state.tab === 'overview') renderOverview(body);
  if (state.tab === 'snapshots') renderSnapshots(body);
  if (state.tab === 'console') renderConsole(body);
  if (state.tab === 'remote') renderRemote(body);
  if (state.tab === 'updates') renderUpdates(body);
}

function renderOverview(body) {
  const vm = state.detail;
  const ips = vm.ips?.length ? vm.ips.map((ip) => `<div class="mono">${esc(ip)}</div>`).join('')
    : vm.type === 'qemu' ? '<span class="muted">Install the QEMU guest agent to show addresses</span>'
    : '<span class="muted">–</span>';

  body.innerHTML = `
    <dl class="specs">
      <div><dt>Server ID</dt><dd class="mono">${vm.vmid}</dd></div>
      <div><dt>Operating system</dt><dd>${esc(OS_NAMES[vm.os] ?? vm.os ?? '–')}</dd></div>
      <div><dt>CPU cores</dt><dd>${vm.cores ?? '–'}</dd></div>
      <div><dt>Memory</dt><dd>${vm.memoryMb ? bytes(vm.memoryMb * 1024 * 1024) : bytes(vm.maxmem)}</dd></div>
      <div><dt>Disk</dt><dd>${bytes(vm.maxdisk)}</dd></div>
      <div class="wide"><dt>IP addresses</dt><dd>${ips}</dd></div>
    </dl>
    <div id="public-ips"></div>
    ${vm.pendingSize ? `
      <div class="notice warn size-pending">
        <p><strong>Size change waiting for a restart:</strong> ${esc(vm.pendingSize.cores)} ${vm.pendingSize.cores === 1 ? 'core' : 'cores'},
          ${esc(bytes(vm.pendingSize.memoryMb * 1024 * 1024))} memory. It takes effect when the server is restarted from this
          panel; a restart inside the server isn't enough.</p>
        <button class="btn" data-power="reboot">${icon('restart')}<span>Restart now</span></button>
      </div>` : ''}
    ${vm.resizable && state.account.canCreate ? `
      <div class="row size-row"><button class="btn" data-resize>${icon('server')}<span>Change size…</span></button></div>` : ''}
    ${vm.plan ? `
      <div class="row size-row"><span class="muted">Plan <strong>${esc(vm.plan.name)}</strong></span>
        ${vm.upgradable && state.account.canCreate ? `<button class="btn" data-upgrade>${icon('server')}<span>Change plan…</span></button>` : ''}</div>` : ''}

    <div class="section-head">
      <h2>Usage</h2>
      <div class="segmented" role="group" aria-label="Time range">
        ${[['hour', '1 hour'], ['day', '1 day'], ['week', '1 week'], ['month', '1 month']].map(([tf, label]) =>
          `<button data-tf="${tf}" aria-pressed="${state.timeframe === tf}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="charts" id="charts"><p class="muted">Loading graphs…</p></div>
    ${vm.reinstallable && state.account.canCreate ? `
      <div class="danger-zone">
        <div>
          <h2>Reinstall</h2>
          <p class="muted">Start fresh with a new copy of an image. Everything on the server is erased, snapshots too;
            name, size and network address stay.</p>
        </div>
        <button class="btn danger" data-reinstall>${icon('restart')}<span>Reinstall…</span></button>
      </div>` : ''}
    ${vm.deletable ? `
      <div class="danger-zone">
        <div>
          <h2>Delete server</h2>
          <p class="muted">Permanently deletes the server, its disks and snapshots. ${vm.status === 'running'
            ? 'Shut it down first.' : 'This cannot be undone.'}</p>
        </div>
        <button class="btn danger" data-delete-server ${vm.status === 'running' ? 'disabled' : ''}>${icon('trash')}<span>Delete server</span></button>
      </div>` : ''}`;

  publicIps.render($('#public-ips'), vm);
  loadCharts();
}

async function loadCharts() {
  const vmid = state.selected;
  try {
    const points = await api(`/api/vms/${vmid}/rrd?timeframe=${state.timeframe}`);
    if (vmid !== state.selected || state.tab !== 'overview') return;
    const el = $('#charts');
    if (!el) return;

    const last = [...points].reverse().find((p) => p.cpu != null) ?? {};
    const maxmem = last.maxmem || state.detail.maxmem || 1;

    el.innerHTML = `
      ${chart('CPU', pct(last.cpu), [points.map((p) => p.cpu)], 1)}
      ${chart('Memory', `${bytes(last.mem)} of ${bytes(maxmem)}`, [points.map((p) => p.mem)], maxmem)}
      ${chart('Network', `${bytes(last.netin)}/s in`, [points.map((p) => p.netin), points.map((p) => p.netout)], null,
        ['Incoming', 'Outgoing'])}`;
  } catch (err) { fail(err); }
}

/** Minimal dependency-free SVG area/line chart. */
function chart(title, current, series, fixedMax, legend) {
  const W = 300, H = 90;
  const all = series.flat().filter((v) => v != null);
  const max = fixedMax ?? Math.max(1, ...all) * 1.1;
  const colors = ['var(--chart-a)', 'var(--chart-b)'];

  const paths = series.map((values, i) => {
    const n = values.length;
    if (n < 2) return '';
    let d = '';
    values.forEach((v, j) => {
      if (v == null) return;
      const x = (j / (n - 1)) * W;
      const y = H - Math.min(1, v / max) * (H - 4) - 2;
      d += `${d ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    if (!d) return '';
    const area = i === 0 ? `<path d="${d}L${W},${H}L0,${H}Z" fill="${colors[i]}" opacity="0.12"/>` : '';
    return `${area}<path d="${d}" fill="none" stroke="${colors[i]}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
  }).join('');

  return `
    <figure class="chart" style="margin:0">
      <h3>${esc(title)} <span>${esc(current)}</span></h3>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)} over time">${paths}</svg>
      ${legend ? `<div class="legend">${legend.map((l, i) => `<span><i style="background:${colors[i]}"></i>${esc(l)}</span>`).join('')}</div>` : ''}
    </figure>`;
}

async function renderSnapshots(body) {
  body.innerHTML = '<p class="muted">Loading snapshots…</p>';
  const vmid = state.selected;
  let snaps;
  let sched = null;
  try {
    [snaps, sched] = await Promise.all([api(`/api/vms/${vmid}/snapshots`), api(`/api/vms/${vmid}/snapshot-schedule`).catch(() => null)]);
  } catch (err) { return fail(err); }
  if (vmid !== state.selected || state.tab !== 'snapshots') return;

  const busy = state.busy.has(vmid);
  const canRam = state.detail.type === 'qemu';
  const running = state.detail.status === 'running';
  body.innerHTML = `
    <div class="section-head"><h2>Snapshots</h2></div>
    ${snaps.length ? `
      <ul class="snap-list">
        ${snaps.map((s) => `
          <li>
            <div class="grow">
              <div class="mono">${esc(s.name)}${s.auto ? ' <span class="tag">automatic</span>' : ''}</div>
              <div class="muted">${s.time ? new Date(s.time * 1000).toLocaleString() : ''}${s.includesRam ? ' – includes RAM' : ''}${s.description ? ` – ${esc(s.description)}` : ''}</div>
            </div>
            <button class="btn" data-rollback="${esc(s.name)}" ${busy ? 'disabled' : ''}>Roll back</button>
            <button class="btn danger" data-delsnap="${esc(s.name)}" ${busy ? 'disabled' : ''}>Delete</button>
          </li>`).join('')}
      </ul>` : '<p class="muted">No snapshots yet. Take one before risky changes so you can return to this point.</p>'}

    <form id="snap-form" class="snap-form">
      <label>Name <input name="name" required pattern="[A-Za-z][A-Za-z0-9_\\-]{1,39}" placeholder="before-upgrade"></label>
      <label>Note <input name="description" maxlength="200" placeholder="Optional"></label>
      <button class="btn primary" ${busy ? 'disabled' : ''}>Take snapshot</button>
      ${canRam ? `
        <label class="check">
          <input type="checkbox" name="includeRam" ${running ? 'checked' : ''} ${running ? '' : 'disabled'}>
          <span>Include RAM
            <span class="muted">${running
              ? 'Saves the running state so a rollback resumes exactly where it was. Uses extra disk space equal to the memory in use.'
              : 'Only available while the server is running.'}</span>
          </span>
        </label>` : ''}
    </form>
    <p class="muted small" style="max-width:70ch">A snapshot covers the system disk and the volumes attached to this server (not detached ones).
      Rolling back also restores which volumes and public addresses the server had; the panel follows.</p>
    ${sched ? scheduleCard(sched) : ''}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function scheduleCard({ schedule: s, maxSnapshots, timeZone }) {
  const f = s?.frequency ?? 'off';
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${(s?.hour ?? 2) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  return `
    <section class="security-card settings-card" style="margin-top:20px" aria-labelledby="auto-snap">
      <h2 class="twofa-title" id="auto-snap">Automatic snapshots</h2>
      <p class="muted">The panel takes a snapshot on schedule and keeps the newest ones; older automatic snapshots are removed,
        your own are never touched. Your plan allows ${maxSnapshots} snapshots in total.</p>
      ${s?.lastRunAt ? `<p class="small">${s.lastStatus === 'ok' ? 'Last run' : '<strong class="warn-text">Last run failed</strong>'} ${esc(new Date(s.lastRunAt).toLocaleString())}${s.lastError ? `: ${esc(s.lastError)}` : ''}</p>` : ''}
      <form id="snap-schedule-form" class="email-form">
        <div class="grid-3">
          <label>Schedule <select name="frequency">
            <option value="off" ${f === 'off' ? 'selected' : ''}>Off</option><option value="daily" ${f === 'daily' ? 'selected' : ''}>Every day</option>
            <option value="weekly" ${f === 'weekly' ? 'selected' : ''}>Every week</option></select></label>
          <label ${f === 'weekly' ? '' : 'hidden'} data-weekday>Day <select name="weekday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${(s?.weekday ?? 0) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label>At <select name="hour">${hours}</select><span class="hint">${esc(timeZone)}</span></label>
          <label>Keep <select name="keep">${Array.from({ length: maxSnapshots }, (_, i) => `<option value="${i + 1}" ${(s?.keep ?? Math.min(2, maxSnapshots)) === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
        </div>
        <div class="row"><button class="btn primary">Save</button>
          ${s?.nextRunAt ? `<span class="small muted">Next: ${esc(new Date(s.nextRunAt).toLocaleString())}</span>` : ''}</div>
      </form>
    </section>`;
}

function renderConsole(body) {
  const running = state.detail.status === 'running';
  body.innerHTML = `
    <div class="section-head"><h2>Console</h2></div>
    <p class="muted" style="max-width:60ch">The console shows your server's screen as if a monitor were attached. Use it when you can't reach the server over SSH or remote desktop.</p>
    <button class="btn primary" id="open-console" ${running ? '' : 'disabled'}>${icon('terminal')}<span>Open console</span></button>
    ${running ? '' : '<p class="muted">Start the server to open its console.</p>'}`;
}

// ---------- remote access (Tailscale) ---------------------------------------
async function renderRemote(body) {
  const vmid = state.selected;
  if (!body.querySelector('.ts')) body.innerHTML = '<p class="muted">Checking Tailscale…</p>';
  let ts;
  try { ts = await api(`/api/vms/${vmid}/tailscale`); } catch (err) { body.innerHTML = ''; return fail(err); }
  if (vmid !== state.selected || state.tab !== 'remote' || state.view !== 'server') return;
  const vm = state.detail;

  if (ts.state === 'installing' || ts.state === 'disconnecting') {
    body.innerHTML = `
      <div class="ts">
        <p class="progress-step"><span class="spinner" aria-hidden="true"></span>${esc(ts.progress ?? 'Working')}…</p>
        <p class="muted">${ts.state === 'installing'
          ? 'Tailscale is being installed and connected inside the server. This usually takes one to five minutes.'
          : 'The server is leaving your tailnet.'}</p>
      </div>`;
    clearTimeout(state.tsTimer);
    state.tsTimer = setTimeout(() => { if (state.tab === 'remote') renderRemote($('#tab-body')); }, 4000);
    return;
  }

  if (ts.state === 'connected') {
    const live = ts.live;
    const online = live?.online && live?.backend === 'Running';
    body.innerHTML = `
      <div class="ts">
        <dl class="specs cols-3">
          <div><dt>Tailscale</dt><dd><span class="pill ${online ? 'pill-running' : ''}">${live
            ? (online ? 'Connected' : esc(live.backend === 'NeedsLogin' ? 'Signed out' : 'Offline'))
            : (vm.status === 'running' ? 'Status unknown' : 'Server stopped')}</span></dd></div>
          <div><dt>Tailscale address</dt><dd class="mono">${esc(live?.ip ?? ts.ip ?? '–')}</dd></div>
          <div><dt>Name in your tailnet</dt><dd class="mono">${esc(live?.name ?? ts.hostname ?? '–')}</dd></div>
          <div class="wide"><dt>Mode</dt><dd>${ts.mode === 'gateway'
            ? `Gateway to your private network <span class="mono">${esc(ts.subnet ?? '')}</span>`
            : 'Just this server'}</dd></div>
        </dl>
        ${ts.mode === 'gateway' && ts.routeApproved === false ? `
          <div class="notice warn">
            <p><strong>One step left:</strong> approve the route <span class="mono">${esc(ts.subnet)}</span> in your
              Tailscale admin console. Open <em>Machines</em>, choose <span class="mono">${esc(ts.hostname)}</span>,
              then <em>Edit route settings</em> and turn the route on.</p>
          </div>` : ''}
        <p class="muted ts-howto">${ts.mode === 'gateway'
          ? 'With Tailscale running on your device, all your servers in the private network are reachable at their private addresses.'
          : 'With Tailscale running on your device, reach this server by its Tailscale address or name, for example with Remote Desktop or SSH.'}</p>
        <div class="row">
          <button class="btn danger" data-ts-disconnect ${vm.status === 'running' ? '' : 'disabled'}>${icon('logout')}<span>Disconnect from Tailscale</span></button>
        </div>
      </div>`;
    return;
  }

  // none or failed: the connect form
  const blocked = !ts.running ? 'Start the server to connect it to Tailscale.'
    : !ts.agentConfigured ? 'The QEMU guest agent must be installed in the server and enabled in its options. Ask your provider if you are unsure.'
    : '';
  const defaultName = (vm.name || `server-${vm.vmid}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  body.innerHTML = `
    <div class="ts">
      <h2 class="h2">Connect with Tailscale</h2>
      <p class="muted ts-lede">Use your own Tailscale account to reach ${esc(vm.name)} from your laptop or phone.
        This works in addition to the VPN of your provider.</p>
      ${ts.state === 'failed' && ts.error ? `<p class="error-box">${esc(ts.error)}</p>` : ''}
      ${blocked ? `<div class="notice warn"><p>${esc(blocked)}</p></div>` : ''}
      <form id="ts-form" class="ts-form" novalidate>
        <div class="choices" role="radiogroup" aria-label="What to connect">
          <label class="choice">
            <input type="radio" name="mode" value="server" checked>
            <span><strong>Just this server</strong>
            <span class="muted">Reach this server by its Tailscale name or address.</span></span>
          </label>
          <label class="choice">
            <input type="radio" name="mode" value="gateway" ${ts.gatewayPossible ? '' : 'disabled'}>
            <span><strong>Gateway to my private network</strong>
            <span class="muted">${ts.gatewayPossible
              ? `Reach all your servers in ${esc(ts.subnet)} through this server.`
              : 'Needs a Linux server in your private network.'}</span></span>
          </label>
        </div>
        <label>Auth key
          <input name="authKey" type="password" required autocomplete="off" spellcheck="false" placeholder="tskey-auth-…">
          <span class="hint">Create one in your Tailscale admin console under Settings, Keys. Don't use an
            ephemeral key: the server would disappear from your tailnet whenever it's offline.</span>
        </label>
        <label>Name in your tailnet
          <input name="hostname" required maxlength="63" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" value="${esc(defaultName)}">
        </label>
        <p id="ts-error" class="form-error" role="alert"></p>
        <div class="row">
          <button class="btn primary" ${blocked ? 'disabled' : ''}>${icon('link')}<span>Connect to Tailscale</span></button>
        </div>
      </form>
    </div>`;
}

$('#detail').addEventListener('submit', async (e) => {
  if (e.target.id !== 'ts-form') return;
  e.preventDefault();
  const form = e.target;
  const err = $('#ts-error');
  err.textContent = '';
  if (!form.reportValidity()) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api(`/api/vms/${state.selected}/tailscale`, {
      method: 'POST',
      body: {
        authKey: form.authKey.value.trim(),
        mode: form.querySelector('[name=mode]:checked').value,
        hostname: form.hostname.value.trim(),
      },
    });
    form.authKey.value = '';
    toast('Connecting to Tailscale');
    renderRemote($('#tab-body'));
  } catch (ex) {
    err.textContent = ex.message;
    button.disabled = false;
  }
});

// Public IPv4 addresses on the Overview tab (own module)
const publicIps = createPublicIps({
  getVm: () => (state.view === 'server' ? state.detail : null),
  refresh: () => { if (state.view === 'server' && state.tab === 'overview') renderTab(); },
});
$('#detail').addEventListener('click', (e) => {
  if (state.view === 'server' && state.tab === 'overview' && e.target.closest('#public-ips')) publicIps.onClick(e);
});

$('#detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-help-server]') && state.view === 'server') {
    support.openNew({ vmid: state.selected, category: 'server' });
  }
});

$('#detail').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-ts-disconnect]');
  if (!t) return;
  if (!(await confirmAction('Disconnect this server from your tailnet? Devices can then no longer reach it through Tailscale.', 'Disconnect'))) return;
  try {
    const r = await api(`/api/vms/${state.selected}/tailscale`, { method: 'DELETE' });
    if (r.removedFromTailnet) {
      toast('Disconnected from Tailscale');
    } else if (r.removedFromTailnet === null) {
      toast(`Disconnected. If “${r.hostname}” still appears under Machines in your Tailscale admin console, remove it there.`, 'warn');
    } else {
      // Only the server side could be reset; the device is still listed in the tailnet.
      toast(`Disconnected. Also remove “${r.hostname}” under Machines in your Tailscale admin console; it stays listed there as offline.`, 'warn');
    }
    renderRemote($('#tab-body'));
  } catch (err) { fail(err); }
});

// ---------- actions --------------------------------------------------------
const POWER_CONFIRM = {
  reboot: ['Restart this server? Running programs will be closed.', 'Restart'],
  shutdown: ['Shut down this server?', 'Shut down'],
  stop: ['Force stop cuts power immediately, like pulling the plug. Unsaved data may be lost.', 'Force stop'],
};
const DONE_TEXT = {
  power_start: 'Server started', power_shutdown: 'Server shut down', power_reboot: 'Server restarted',
  power_stop: 'Server stopped', snapshot_create: 'Snapshot taken', snapshot_rollback: 'Rolled back to snapshot',
  snapshot_delete: 'Snapshot deleted',
};

async function runTask(vmid, request) {
  state.busy.add(vmid);
  renderList();
  if (vmid === state.selected) renderDetail();
  try {
    const { task } = await request();
    while (task) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api(`/api/tasks/${encodeURIComponent(task)}`);
      if (s.done) {
        if (s.ok) toast(DONE_TEXT[s.action] ?? 'Done');
        else toast(`Task failed: ${s.message}`, 'error');
        break;
      }
    }
  } catch (err) {
    fail(err);
  } finally {
    state.busy.delete(vmid);
    await loadList().catch(() => {});
    if (vmid === state.selected) await loadDetail();
  }
}

$('#detail').addEventListener('click', async (e) => {
  const vmid = state.selected;
  const t = e.target.closest('button');
  if (!t) return;

  if (t.dataset.power) {
    const action = t.dataset.power;
    if (POWER_CONFIRM[action] && !(await confirmAction(...POWER_CONFIRM[action]))) return;
    runTask(vmid, () => api(`/api/vms/${vmid}/power/${action}`, { method: 'POST' }));
  }

  if (t.dataset.tab) {
    state.tab = t.dataset.tab;
    renderDetail();
  }

  if (t.dataset.tf) {
    state.timeframe = t.dataset.tf;
    renderTab();
  }

  if (t.dataset.rollback) {
    const name = t.dataset.rollback;
    if (!(await confirmAction(`Roll back to "${name}"? Everything changed since that snapshot will be lost.`, 'Roll back'))) return;
    runTask(vmid, () => api(`/api/vms/${vmid}/snapshots/${encodeURIComponent(name)}/rollback`, { method: 'POST' }))
      .then(() => { if (state.tab === 'snapshots') renderTab(); });
  }

  if (t.dataset.delsnap) {
    const name = t.dataset.delsnap;
    if (!(await confirmAction(`Delete snapshot "${name}"? This can't be undone.`, 'Delete'))) return;
    runTask(vmid, () => api(`/api/vms/${vmid}/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' }))
      .then(() => { if (state.tab === 'snapshots') renderTab(); });
  }

  if (t.id === 'open-console') {
    window.open(`/console.html?vmid=${vmid}`, `console-${vmid}`, 'width=1100,height=760');
  }
});

$('#detail').addEventListener('change', (e) => {
  if (e.target.name === 'frequency' && e.target.closest('#snap-schedule-form')) {
    e.target.form.querySelector('[data-weekday]').hidden = e.target.value !== 'weekly';
  }
});
$('#detail').addEventListener('submit', async (e) => {
  if (e.target.id !== 'snap-schedule-form') return;
  e.preventDefault();
  const el = e.target.elements;
  try {
    const r = await api(`/api/vms/${state.selected}/snapshot-schedule`, { method: 'PUT', body: {
      frequency: el.frequency.value, hour: Number(el.hour.value), keep: Number(el.keep.value),
      ...(el.frequency.value === 'weekly' ? { weekday: Number(el.weekday.value) } : {}),
    } });
    toast(r.schedule ? `Automatic snapshots on; next ${new Date(r.schedule.nextRunAt).toLocaleString()}` : 'Automatic snapshots off');
    if (state.tab === 'snapshots') renderTab();
  } catch (err) { fail(err); }
});

$('#detail').addEventListener('submit', (e) => {
  if (e.target.id !== 'snap-form') return;
  e.preventDefault();
  const vmid = state.selected;
  const f = e.target;
  const body = {
    name: f.querySelector('[name=name]').value.trim(),
    description: f.querySelector('[name=description]').value.trim(),
    includeRam: !!f.querySelector('[name=includeRam]:checked'),
  };
  runTask(vmid, () => api(`/api/vms/${vmid}/snapshots`, { method: 'POST', body }))
    .then(() => { if (state.tab === 'snapshots') renderTab(); });
});

// ---------- create a server --------------------------------------------------
const MEMORY_STEPS_MB = [512, 1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072];

function remaining() {
  const { limits, usage } = state.account;
  return {
    servers: limits.servers - usage.servers,
    cores: limits.cores - usage.cores,
    memoryMb: limits.memoryMb - usage.memoryMb,
    diskGb: limits.diskGb - usage.diskGb,
  };
}

async function openCreate() {
  state.view = 'create';
  history.replaceState(null, '', '#new');
  renderList();
  $('#detail').innerHTML = '<div class="detail-inner"><p class="muted">Loading…</p></div>';
  try {
    const [account, templates, plans] = await Promise.all([api('/api/account'), api('/api/templates'), api('/api/plans').catch(() => null)]);
    state.account = account;
    state.templates = templates;
    state.plans = plans?.plans?.length ? plans : null;
    if (state.view === 'create') renderCreate();
  } catch (err) { fail(err); }
}

function renderCreate() {
  const left = remaining();
  const { limits } = state.account;
  const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;
  const minDisk = Math.min(...state.templates.map((t) => t.minDiskGb));

  const blockers = [];
  if (left.servers < 1) blockers.push(`you already have ${limits.servers} of ${limits.servers} servers`);
  if (left.cores < 1) blockers.push('all CPU cores in your plan are in use');
  if (left.memoryMb < 512) blockers.push('less than 0.5 GB memory is left in your plan');
  if (state.templates.length && left.diskGb < minDisk) blockers.push(`less disk space is left (${left.diskGb} GB) than the smallest image needs`);

  const head = `
    <div class="detail-head"><div><h1>New server</h1>
      <p class="muted plan-line">Left in your plan: ${Math.max(0, left.servers)} of ${limits.servers} servers,
        ${Math.max(0, left.cores)} CPU cores, ${gb(Math.max(0, left.memoryMb))} memory, ${Math.max(0, left.diskGb)} GB disk.</p>
      ${state.account.networksEnabled ? `<p class="muted plan-line">${state.account.network
        ? `New servers join your private network <span class="mono">${esc(state.account.network.subnet)}</span> with internet access.`
        : 'Your servers get their own private network with internet access. It is set up with your first server.'}</p>` : ''}
    </div></div>`;

  if (!state.templates.length || blockers.length) {
    $('#detail').innerHTML = `
      <div class="detail-inner">${head}
        <div class="pending">
          <p>${state.templates.length
            ? `You can't create another server right now: ${esc(blockers.join('; '))}.`
            : 'No images are available to create servers from yet.'}</p>
          <p class="muted">${state.templates.length
            ? 'Delete a server you no longer need, or contact support to upgrade your plan.'
            : 'Contact support.'}</p>
        </div>
      </div>`;
    return;
  }

  const first = state.templates.find((t) => t.minDiskGb <= left.diskGb) ?? state.templates[0];
  const memOptions = MEMORY_STEPS_MB.filter((m) => m <= left.memoryMb);
  const defaultMem = memOptions.includes(2048) ? 2048 : memOptions[memOptions.length - 1];

  const sizeFields = `
          <div class="grid-3">
            <label>CPU cores
              <input name="cores" type="number" min="1" max="${left.cores}" value="${Math.min(2, left.cores)}" required>
            </label>
            <label>Memory
              <select name="memoryMb">
                ${memOptions.map((m) => `<option value="${m}" ${m === defaultMem ? 'selected' : ''}>${gb(m)}</option>`).join('')}
              </select>
            </label>
            <label>Disk (GB)
              <input name="diskGb" type="number" min="${first.minDiskGb}" max="${left.diskGb}"
                     value="${Math.min(Math.max(first.minDiskGb, 20), left.diskGb)}" required>
            </label>
          </div>`;

  $('#detail').innerHTML = `
    <div class="detail-inner">${head}
      <form id="create-form" class="create-form" novalidate>
        <fieldset>
          <legend>Image</legend>
          <div class="choices">
            ${state.templates.map((t) => `
              <label class="choice">
                <input type="radio" name="templateId" value="${t.id}" ${t === first ? 'checked' : ''}
                       ${t.minDiskGb > left.diskGb ? 'disabled' : ''}>
                <span><strong>${esc(t.name)}</strong>
                <span class="muted">Needs at least ${t.minDiskGb} GB disk</span></span>
              </label>`).join('')}
          </div>
        </fieldset>

        ${state.plans ? planFieldset(state.plans, left, sizeFields) : `<fieldset><legend>Size</legend>${sizeFields}</fieldset>`}

        <fieldset>
          <legend>Name and sign-in</legend>
          <div class="grid-2">
            <label>Hostname
              <input name="hostname" required maxlength="63" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?"
                     placeholder="web01" autocomplete="off">
              <span class="hint" id="hostname-hint">Lowercase letters, numbers and hyphens.</span>
            </label>
            <label data-os="linux">Username
              <input name="username" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*"
                     value="${esc(first.setup === 'windows' ? 'admin' : (first.defaultUser || 'admin'))}" autocomplete="off">
            </label>
            <div data-os="windows" class="fixed-user">
              <span class="label">User</span>
              <span class="mono" id="windows-user"></span>
            </div>
          </div>
          <label>Password
            <span class="with-button">
              <input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password">
              <button type="button" class="btn" data-generate>Generate</button>
            </span>
            <span class="hint" data-os="linux">At least 12 characters. Leave empty if you only want to sign in with an SSH key.</span>
            <span class="hint" data-os="windows">At least 12 characters with three of: lowercase, uppercase, numbers, symbols.</span>
          </label>
          <label data-os="linux">SSH public keys
            <textarea name="sshKeys" rows="3" spellcheck="false" placeholder="ssh-ed25519 AAAA… you@laptop"></textarea>
            <span class="hint">Optional. One key per line.</span>
          </label>
        </fieldset>

        <p id="create-error" class="form-error" role="alert"></p>
        <div class="row">
          <button class="btn primary" id="create-submit">Create server</button>
          <button type="button" class="btn ghost" data-cancel-create>Cancel</button>
        </div>
      </form>
    </div>`;
  applyTemplateMode($('#create-form'), first);
  if (state.plans) updatePlanChoice($('#create-form'), state.plans);
}

/** Shows the fields that apply to the chosen image (cloud-init vs Windows). */
function applyTemplateMode(form, tpl) {
  const windows = tpl.setup === 'windows';
  form.querySelectorAll('[data-os]').forEach((el) => {
    const hide = el.dataset.os !== (windows ? 'windows' : 'linux');
    el.hidden = hide;
    // Disabled fields are skipped by browser validation. Without this, a hidden
    // field with an invalid value blocks the form without any visible message.
    el.querySelectorAll('input, textarea, select').forEach((f) => { f.disabled = hide; });
  });
  form.username.required = !windows;
  form.password.required = windows;
  if (form.hostname) {
    form.hostname.maxLength = windows ? 15 : 63;
    $('#hostname-hint').textContent = windows
      ? 'Lowercase letters, numbers and hyphens, at most 15 characters.'
      : 'Lowercase letters, numbers and hyphens.';
  }
  form.querySelector('#windows-user').textContent = windows ? tpl.defaultUser : '';
}

function onTemplateChange(form) {
  const tpl = state.templates.find((t) => t.id === Number(form.templateId.value));
  if (!tpl) return;
  const disk = form.diskGb;
  if (disk) {
    disk.min = tpl.minDiskGb;
    if (Number(disk.value) < tpl.minDiskGb) disk.value = tpl.minDiskGb;
  }
  if (!form.username.dataset.edited && tpl.setup !== 'windows') form.username.value = tpl.defaultUser || 'admin';
  applyTemplateMode(form, tpl);
}

// ---------- Operating system updates (Windows and Linux) ---------------------
const UPDATE_STEPS = {
  starting: 'Starting…', searching: 'Searching for updates…', downloading: 'Downloading updates…',
  installing: 'Installing updates…', restarting: 'Restarting to finish the updates…',
  'restart-required': 'Restart required', done: 'Finished', failed: 'Failed',
};
const ACTIVE_UPDATE = ['starting', 'searching', 'downloading', 'installing', 'restarting', 'restart-required'];

// Text that differs between Windows and Linux servers
const UPDATE_TEXT = {
  windows: {
    title: 'Windows updates', what: 'Windows',
    lede: 'Install the latest updates from Microsoft. Feature upgrades to a new Windows version and preview updates are never installed.',
    security: ['Security and critical updates', 'Recommended. Includes the monthly cumulative update and Defender updates.'],
    all: ['All quality updates', 'Also optional updates such as .NET improvements.'],
    restart: ['Restart automatically when needed', 'Otherwise the panel asks you to restart, and continues afterwards.'],
    upToDate: 'Windows was already up to date.', failed: 'Windows Update failed.', unit: 'update',
  },
  linux: {
    title: 'Linux updates', what: 'Linux',
    lede: "Install package updates from your distribution's repositories (apt or dnf). Release upgrades, removing packages and held packages are never touched; your changed configuration files are kept.",
    security: ['Security updates only', 'Recommended for servers in production.'],
    all: ['All package updates', 'Every package that has a newer version.'],
    restart: ['Restart automatically if a new kernel was installed', 'Otherwise the panel shows that a restart is needed.'],
    upToDate: 'The server was already up to date.', failed: 'The package update failed.', unit: 'package',
  },
};

function updateList(items) {
  if (!items?.length) return '';
  return `<ul class="update-list">${items.map((u) => `<li><span class="mono">${esc(u.kb || '')}</span> ${esc(u.title)}</li>`).join('')}</ul>`;
}

async function renderUpdates(body) {
  const vmid = state.selected;
  if (!body.querySelector('.updates')) body.innerHTML = '<p class="muted">Checking…</p>';
  let info;
  try { info = await api(`/api/vms/${vmid}/updates`); } catch (err) { body.innerHTML = ''; return fail(err); }
  if (vmid !== state.selected || state.tab !== 'updates' || state.view !== 'server') return;
  const vm = state.detail;
  const r = info.run;
  clearTimeout(state.updTimer);

  const T = UPDATE_TEXT[info.os] ?? UPDATE_TEXT.windows;
  if (!info.available) {
    body.innerHTML = `<div class="updates"><p class="muted">${info.os
      ? `Installing ${T.what} updates through the panel is switched off by your provider.`
      : 'Updates through the panel are available for Windows and Linux servers.'}</p></div>`;
    return;
  }

  if (r && ACTIVE_UPDATE.includes(r.state)) {
    const pct = r.total ? Math.round((r.current / r.total) * 100) : 0;
    const counting = ['downloading', 'installing'].includes(r.state) && r.total;
    body.innerHTML = `
      <div class="updates">
        <p class="progress-step">${r.state === 'restart-required' ? icon('restart') : '<span class="spinner" aria-hidden="true"></span>'}
          ${esc(UPDATE_STEPS[r.state])}${r.round > 1 && ['searching', 'downloading', 'installing'].includes(r.state) ? ` <span class="muted">(round ${esc(r.round)})</span>` : ''}</p>
        ${counting ? `<div class="bar update-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
          <p class="muted small">${esc(r.message ?? '')}</p>` : r.message && r.state !== 'restart-required' ? `<p class="muted small">${esc(r.message)}</p>` : ''}
        ${r.state === 'restart-required' ? `
          <div class="notice warn update-restart">
            <p>${info.os === 'linux' ? 'A restart is needed to finish.' : 'Windows needs a restart to finish installing. The panel continues automatically after the restart.'}</p>
            <button class="btn" data-power="reboot">${icon('restart')}<span>Restart now</span></button>
          </div>` : `<p class="muted small">This can take 30 minutes or more. You can leave this page; the updates continue${r.autoRestart ? ', and the server restarts by itself when needed' : ''}.</p>`}
        ${r.installed?.length ? `<details class="update-details"><summary>Installed so far (${r.installed.length})</summary>${updateList(r.installed)}</details>` : ''}
      </div>`;
    state.updTimer = setTimeout(() => { if (state.tab === 'updates') renderUpdates($('#tab-body')); }, 4000);
    return;
  }

  const last = r ? `
    <div class="notice ${r.state === 'failed' ? 'warn' : ''} update-last">
      <p><strong>Last run ${esc(new Date(`${(r.finishedAt || r.startedAt).replace(' ', 'T')}Z`).toLocaleString())}:</strong>
        ${r.state === 'failed' ? esc(r.error || T.failed)
          : r.installed.length ? `${r.installed.length} ${T.unit}${r.installed.length === 1 ? '' : 's'} ${info.os === 'linux' ? 'updated' : 'installed'}.` : T.upToDate}
        ${r.failed?.length ? ` ${r.failed.length} could not be installed.` : ''}
        ${r.snapshot ? ` Snapshot before updating: <span class="mono">${esc(r.snapshot)}</span>.` : ''}</p>
      ${r.installed.length || r.failed?.length ? `<details class="update-details"><summary>Details</summary>${updateList(r.installed)}${r.failed?.length ? `<p class="small warn-text">Not installed:</p>${updateList(r.failed)}` : ''}</details>` : ''}
    </div>` : '';
  const running = vm.status === 'running';
  const reboot = info.rebootPending ? `
    <div class="notice warn update-restart">
      <p>Updates were installed that need a restart (new kernel or system libraries). The server keeps running on the old versions until you restart it.</p>
      <button class="btn" data-power="reboot">${icon('restart')}<span>Restart now</span></button>
    </div>` : '';
  body.innerHTML = `
    <div class="updates">
      <h2 class="h2">${T.title}</h2>
      <p class="muted updates-lede">${esc(T.lede)}</p>
      ${reboot}
      ${last}
      ${running ? '' : '<div class="notice warn"><p>Start the server to install updates.</p></div>'}
      <form id="update-form" class="update-form">
        <div class="choices" role="radiogroup" aria-label="Which updates">
          <label class="choice"><input type="radio" name="scope" value="security" checked>
            <span><strong>${T.security[0]}</strong><span class="muted">${T.security[1]}</span></span></label>
          <label class="choice"><input type="radio" name="scope" value="all">
            <span><strong>${T.all[0]}</strong><span class="muted">${T.all[1]}</span></span></label>
        </div>
        <label class="check"><input type="checkbox" name="snapshot" checked>
          <span>Take a snapshot first <span class="muted">If an update causes problems, roll back to it under Snapshots.</span></span></label>
        <label class="check"><input type="checkbox" name="autoRestart" ${info.os === 'linux' ? '' : 'checked'}>
          <span>${T.restart[0]} <span class="muted">${T.restart[1]}</span></span></label>
        <div class="row">
          <button class="btn primary" ${running ? '' : 'disabled'}>${icon('download')}<span>Install updates</span></button>
        </div>
      </form>
    </div>`;
}

$('#detail').addEventListener('submit', async (e) => {
  if (e.target.id !== 'update-form') return;
  e.preventDefault();
  const f = e.target;
  const b = f.querySelector('.btn.primary');
  b.disabled = true;
  try {
    await api(`/api/vms/${state.selected}/updates`, {
      method: 'POST',
      body: { scope: f.scope.value, snapshot: f.snapshot.checked, autoRestart: f.autoRestart.checked },
    });
    toast(state.detail?.osFamily === 'linux' ? 'Installing package updates' : 'Installing Windows updates');
    renderUpdates($('#tab-body'));
  } catch (err) { fail(err); b.disabled = false; }
});

// ---------- expiry -----------------------------------------------------------
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

/** Short badge for lists: "Expires in 5 days" / "Expired". */
function expiryBadge(e) {
  if (!e) return '';
  if (e.expired) return '<span class="tag warn">Expired</span>';
  const d = daysLeft(e.expiresAt);
  return d <= 14 ? `<span class="tag ${d <= 3 ? 'warn' : ''}">Expires in ${d} day${d === 1 ? '' : 's'}</span>` : '';
}

/** Banner on the server page. */
function expiryBanner(vm) {
  const e = vm.expiry;
  if (!e) return '';
  const extend = [
    state.billingEnabled ? `<button class="btn primary" data-renew-server>${icon('wallet')}<span>Renew</span></button>` : '',
    e.canExtend ? `<button class="btn" data-extend>${icon('clock')}<span>Extend by ${e.extendDays} days</span></button>` : '',
  ].join(' ');
  if (e.expired) {
    return `
      <div class="notice warn expiry-banner">
        <p><strong>This server expired on ${esc(fmtDay(e.expiredAt))} and was stopped.</strong>
          ${e.deleteAt ? `It will be deleted with all its data on <strong>${esc(fmtDay(e.deleteAt))}</strong>.` : 'Its data is kept until your provider decides.'}
          ${e.canExtend || state.billingEnabled ? '' : 'Contact your provider if you still need it.'}</p>
        ${extend}
      </div>`;
  }
  const d = daysLeft(e.expiresAt);
  return `
    <div class="notice ${d <= 7 ? 'warn' : ''} expiry-banner">
      <p>${icon('clock', { size: 16 })} This server expires on <strong>${esc(fmtDay(e.expiresAt))}</strong>
        (in ${d} day${d === 1 ? '' : 's'}). It is then stopped${e.canExtend || state.billingEnabled ? '' : '; contact your provider to extend it'}.</p>
      ${extend}
    </div>`;
}

async function extendExpiry() {
  const vm = state.detail;
  if (!vm?.expiry) return;
  if (!(await confirmAction(`Extend ${vm.name} by ${vm.expiry.extendDays} days? You can do this once; after that, contact your provider.`, 'Extend'))) return;
  try {
    const r = await api(`/api/vms/${vm.vmid}/extend`, { method: 'POST' });
    toast(`${vm.name} now expires on ${fmtDay(r.expiresAt)}`);
    await loadList();
    select(vm.vmid);
  } catch (err) { fail(err); }
}

// ---------- resize -----------------------------------------------------------
async function openResize() {
  const vm = state.detail;
  if (!vm) return;
  state.view = 'resize';
  $('#detail').innerHTML = '<div class="detail-inner"><p class="muted">Loading…</p></div>';
  try {
    state.account = await api('/api/account'); // fresh plan usage
    if (state.view === 'resize') renderResize(vm);
  } catch (err) { fail(err); }
}

function renderResize(vm) {
  const { limits, usage } = state.account;
  const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;
  const windows = vm.osFamily === 'windows';
  // This server's configured size (a pending change counts; usage includes it)
  const cur = {
    cores: vm.pendingSize?.cores ?? vm.cores,
    memoryMb: vm.pendingSize?.memoryMb ?? vm.memoryMb,
    diskGb: vm.diskGb,
  };
  const max = {
    cores: limits.cores - usage.cores + cur.cores,
    memoryMb: limits.memoryMb - usage.memoryMb + cur.memoryMb,
    diskGb: limits.diskGb - usage.diskGb + cur.diskGb,
  };
  const minMem = windows ? 2048 : 512;
  const steps = [...new Set([...MEMORY_STEPS_MB, cur.memoryMb])].sort((a, b) => a - b)
    .filter((m) => m >= Math.min(minMem, cur.memoryMb) && m <= Math.max(max.memoryMb, cur.memoryMb));
  const running = vm.status === 'running';

  $('#detail').innerHTML = `
    <div class="detail-inner">
      <button class="link-btn" data-back-to-server>${icon('back', { size: 16 })}<span>${esc(vm.name)}</span></button>
      <div class="detail-head"><div><h1>Change size of ${esc(vm.name)}</h1>
        <p class="muted plan-line">Now: ${cur.cores} ${cur.cores === 1 ? 'core' : 'cores'}, ${gb(cur.memoryMb)} memory, ${cur.diskGb} GB disk.
          Your plan allows this server up to ${max.cores} cores, ${gb(max.memoryMb)} memory and ${max.diskGb} GB disk.</p>
      </div></div>
      <form id="resize-form" class="create-form" novalidate>
        <fieldset>
          <legend>New size</legend>
          <div class="grid-3">
            <label>CPU cores
              <input name="cores" type="number" min="1" max="${Math.max(max.cores, cur.cores)}" value="${cur.cores}" required>
            </label>
            <label>Memory
              <select name="memoryMb">
                ${steps.map((m) => `<option value="${m}" ${m === cur.memoryMb ? 'selected' : ''}>${gb(m)}${m === cur.memoryMb ? ' (now)' : ''}</option>`).join('')}
              </select>
              ${windows ? '<span class="hint">Windows needs at least 2 GB.</span>' : ''}
            </label>
            <label>Disk (GB)
              <input name="diskGb" type="number" min="${cur.diskGb}" max="${Math.max(max.diskGb, cur.diskGb)}" value="${cur.diskGb}" required>
              <span class="hint">Can only grow; this can't be undone.</span>
            </label>
          </div>
          ${running ? `
            <label class="check">
              <input type="checkbox" name="restart" checked>
              <span>Restart the server now
                <span class="muted">New CPU and memory settings take effect only when the panel restarts the server.
                  Without this, they wait for the next restart. A larger disk works right away.</span>
              </span>
            </label>` : '<p class="muted small">The server is stopped; the new size applies when you start it.</p>'}
          ${windows ? '<p class="muted small">For Windows, the panel also extends drive C: into the new disk space while the server is running.</p>'
            : '<p class="muted small">Linux cloud images use new disk space automatically after the next restart.</p>'}
        </fieldset>
        <p id="resize-error" class="form-error" role="alert"></p>
        <div class="row">
          <button class="btn primary" id="resize-submit">Apply</button>
          <button type="button" class="btn ghost" data-back-to-server>Cancel</button>
        </div>
      </form>
    </div>`;
  state.resizeFrom = cur;
}

async function submitResize(form) {
  const err = $('#resize-error');
  err.textContent = '';
  if (!form.reportValidity()) return;
  const cur = state.resizeFrom;
  const body = {};
  const cores = Number(form.cores.value);
  const memoryMb = Number(form.memoryMb.value);
  const diskGb = Number(form.diskGb.value);
  if (cores !== cur.cores) body.cores = cores;
  if (memoryMb !== cur.memoryMb) body.memoryMb = memoryMb;
  if (diskGb !== cur.diskGb) body.diskGb = diskGb;
  if (!Object.keys(body).length) { err.textContent = 'Nothing changed.'; return; }
  if (body.diskGb && !(await confirmAction(`Grow the disk to ${diskGb} GB? Disks can't be made smaller again.`, 'Grow disk'))) return;
  body.restart = !!form.restart?.checked;
  const button = $('#resize-submit');
  button.disabled = true;
  try {
    const vmid = state.detail.vmid;
    const r = await api(`/api/vms/${vmid}/resize`, { method: 'POST', body });
    const notes = [r.restartTask ? 'Restarting to apply the new size.' : r.pendingRestart ? 'CPU and memory take effect at the next restart from the panel.' : 'Size changed.'];
    let kind;
    if (r.windowsDisk === 'extended') notes.push('Drive C: was extended.');
    if (r.windowsDisk === 'blocked') { notes.push("Windows can't extend drive C: because another partition (usually Recovery) sits behind it. Extend it in Disk Management after moving that partition."); kind = 'warn'; }
    if (r.windowsDisk === 'not-running' || r.windowsDisk === 'failed') { notes.push('Extend drive C: in Windows Disk Management to use the new space.'); kind = 'warn'; }
    toast(notes.join(' '), kind);
    await loadList();
    select(vmid);
  } catch (ex) {
    err.textContent = ex.message;
    button.disabled = false;
  }
}

// ---------- reinstall --------------------------------------------------------
async function openReinstall() {
  const listed = state.vms.find((v) => v.vmid === state.selected);
  const vm = state.detail?.vmid === state.selected ? { ...listed, ...state.detail } : listed;
  if (!vm) return;
  state.detail = vm;
  state.view = 'reinstall';
  $('#detail').innerHTML = '<div class="detail-inner"><p class="muted">Loading…</p></div>';
  try {
    state.templates = await api('/api/templates');
    if (state.view === 'reinstall') renderReinstall(vm);
  } catch (err) { fail(err); }
}

function renderReinstall(vm) {
  const name = vm.name;
  const fits = (t) => !vm.diskGb || t.minDiskGb <= vm.diskGb;
  const current = state.templates.find((t) => t.id === vm.templateId && fits(t));
  const first = current ?? state.templates.find(fits);
  const head = `
    <button class="link-btn" data-back-to-server>${icon('back', { size: 16 })}<span>${esc(name)}</span></button>
    <div class="detail-head"><div><h1>Reinstall ${esc(name)}</h1></div></div>`;

  if (!first) {
    $('#detail').innerHTML = `<div class="detail-inner">${head}
      <div class="pending"><p>No image fits this server's disk (${esc(vm.diskGb)} GB).</p>
      <p class="muted">Contact support.</p></div></div>`;
    return;
  }

  $('#detail').innerHTML = `
    <div class="detail-inner">${head}
      <div class="notice warn reinstall-notice">
        <p><strong>Everything on ${esc(name)} will be erased</strong>, including all snapshots${state.account.tailscale ? ' and any Tailscale connection' : ''}.
          The server keeps its name, ID${vm.cores ? `, size (${esc(vm.cores)} ${vm.cores === 1 ? 'core' : 'cores'}, ${esc(bytes(vm.maxmem))} memory,
          ${esc(vm.diskGb)} GB disk)` : ', size'} and usually its network address. It is stopped for the reinstall.</p>
      </div>
      <form id="reinstall-form" class="create-form" novalidate>
        <fieldset>
          <legend>Image</legend>
          <div class="choices">
            ${state.templates.map((t) => `
              <label class="choice">
                <input type="radio" name="templateId" value="${t.id}" ${t === first ? 'checked' : ''} ${fits(t) ? '' : 'disabled'}>
                <span><strong>${esc(t.name)}</strong>
                <span class="muted">${t.id === vm.templateId ? 'Current image' : fits(t) ? `Needs at least ${t.minDiskGb} GB disk` : `Needs ${t.minDiskGb} GB, more than this server has`}</span></span>
              </label>`).join('')}
          </div>
        </fieldset>

        <fieldset>
          <legend>New sign-in</legend>
          <div class="grid-2">
            <label data-os="linux">Username
              <input name="username" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*"
                     value="${esc(first.setup === 'windows' ? 'admin' : (first.defaultUser || 'admin'))}" autocomplete="off">
            </label>
            <div data-os="windows" class="fixed-user">
              <span class="label">User</span>
              <span class="mono" id="windows-user"></span>
            </div>
          </div>
          <label>Password
            <span class="with-button">
              <input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password">
              <button type="button" class="btn" data-generate>Generate</button>
            </span>
            <span class="hint" data-os="linux">At least 12 characters. Leave empty if you only want to sign in with an SSH key.</span>
            <span class="hint" data-os="windows">At least 12 characters with three of: lowercase, uppercase, numbers, symbols.</span>
          </label>
          <label data-os="linux">SSH public keys
            <textarea name="sshKeys" rows="3" spellcheck="false" placeholder="ssh-ed25519 AAAA… you@laptop"></textarea>
            <span class="hint">Optional. One key per line.</span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Confirm</legend>
          <label><span>Type <span class="mono">${esc(name)}</span> to confirm</span>
            <input name="confirm" required autocomplete="off" spellcheck="false">
          </label>
        </fieldset>

        <p id="reinstall-error" class="form-error" role="alert"></p>
        <div class="row">
          <button class="btn danger" id="reinstall-submit" disabled>Erase and reinstall</button>
          <button type="button" class="btn ghost" data-back-to-server>Cancel</button>
        </div>
      </form>
    </div>`;
  const form = $('#reinstall-form');
  applyTemplateMode(form, first);
  form.confirm.addEventListener('input', () => {
    $('#reinstall-submit').disabled = form.confirm.value.trim() !== name;
  });
}

async function submitReinstall(form) {
  const err = $('#reinstall-error');
  err.textContent = '';
  if (form.confirm.value.trim() !== state.detail?.name) return;
  if (!form.reportValidity()) return;
  const tpl = state.templates.find((t) => t.id === Number(form.templateId.value));
  const windows = tpl?.setup === 'windows';
  const body = { templateId: tpl.id };
  if (form.password.value) body.password = form.password.value;
  if (!windows) {
    body.username = form.username.value.trim();
    if (form.sshKeys.value.trim()) body.sshKeys = form.sshKeys.value.trim();
  }
  const button = $('#reinstall-submit');
  button.disabled = true;
  try {
    const vmid = state.detail.vmid;
    await api(`/api/vms/${vmid}/reinstall`, { method: 'POST', body });
    toast(`Reinstalling ${state.detail.name}`);
    await loadList();
    select(vmid);
  } catch (ex) {
    err.textContent = ex.message;
    button.disabled = false;
  }
}

async function submitCreate(form) {
  const err = $('#create-error');
  err.textContent = '';
  if (!form.reportValidity()) {
    // Safety net: never fail silently, even if the browser can't point at the field.
    const bad = [...form.querySelectorAll('input, select, textarea')].find((f) => !f.disabled && !f.checkValidity());
    const label = bad?.closest('label')?.firstChild?.textContent?.trim() || bad?.name || 'a field';
    err.textContent = `Check ${label}: ${bad?.validationMessage || 'the value is not valid'}`;
    return;
  }
  const tpl = state.templates.find((t) => t.id === Number(form.templateId.value));
  const windows = tpl?.setup === 'windows';
  const password = form.password.value;
  const sshKeys = windows ? '' : form.sshKeys.value.trim();
  if (!password && !sshKeys) {
    err.textContent = windows
      ? 'Set a password for the Administrator account.'
      : 'Set a password or add an SSH key so you can sign in to the server.';
    return;
  }
  const plan = state.plans ? planBody(form, state.plans) : {};
  const body = {
    templateId: Number(form.templateId.value),
    hostname: form.hostname.value.trim(),
    ...(windows ? {} : { username: form.username.value.trim() }),
    ...(plan.planId ? plan : { cores: Number(form.cores.value), memoryMb: Number(form.memoryMb.value), diskGb: Number(form.diskGb.value) }),
    ...(password ? { password } : {}),
    ...(sshKeys ? { sshKeys } : {}),
  };
  const button = $('#create-submit');
  button.disabled = true;
  try {
    const { vmid } = await api('/api/vms', { method: 'POST', body });
    toast(`Setting up ${body.hostname}`);
    state.account = await api('/api/account');
    await loadList();
    await select(vmid);
  } catch (ex) {
    err.textContent = ex.message;
    button.disabled = false;
  }
}

async function deleteServer(vm) {
  const answer = await promptText(`Type ${vm.vmid} to delete “${vm.name}”`, {
    hint: 'The server, its disks and all snapshots are deleted permanently.',
    okLabel: 'Delete server',
    pattern: String(vm.vmid),
    danger: true,
  });
  if (answer !== String(vm.vmid)) return;
  try {
    const { removed } = await api(`/api/vms/${vm.vmid}`, { method: 'DELETE' });
    toast(removed ? `${vm.name} removed` : `Deleting ${vm.name}`);
    state.account = await api('/api/account');
    await loadList();
    if (removed) {
      await openHome();
    } else {
      await loadDetail();
    }
  } catch (err) { fail(err); }
}

// Map nodes, server rows and "back" links: open a server or a view.
function openTarget(el) {
  if (el.dataset.vmid) return select(Number(el.dataset.vmid));
  if (el.dataset.open === 'overview') return openHome();
  if (el.dataset.open === 'vpn') return openVpn();
}
$('#detail').addEventListener('click', (e) => {
  const el = e.target.closest('[data-vmid], [data-open]');
  if (el && $('#detail').contains(el)) openTarget(el);
});
$('#detail').addEventListener('keydown', (e) => {
  // SVG map nodes aren't buttons; give them button keys.
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('.map-node[data-vmid], .map-node[data-open]');
  if (!el) return;
  e.preventDefault();
  openTarget(el);
});

$('#sidebar-toggle').addEventListener('click', () => {
  const open = $('#app-view').classList.toggle('nav-open');
  $('#sidebar-toggle').setAttribute('aria-expanded', String(open));
});
// Close the mobile menu after choosing something in it.
$('.sidebar').addEventListener('click', (e) => {
  if (e.target.closest('.nav-item, .unit')) {
    $('#app-view').classList.remove('nav-open');
    $('#sidebar-toggle').setAttribute('aria-expanded', 'false');
  }
});

$('#rack-actions').addEventListener('click', (e) => {
  if (e.target.closest('#nav-overview')) openHome();
  if (e.target.closest('#new-server')) openCreate();
  if (e.target.closest('#vpn-access')) openVpn();
  if (e.target.closest('#nav-support')) support.openSupport();
  if (e.target.closest('#nav-assistant')) assistant.open();
  if (e.target.closest('#nav-billing')) billing.open();
  if (e.target.closest('#nav-storage')) storage.open();
  if (e.target.closest('#nav-help')) support.openHelp();
});

// ---------- VPN access -------------------------------------------------------
function ago(unixSeconds) {
  if (unixSeconds == null) return 'unknown';
  if (!unixSeconds) return 'Never';
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 180) return 'Connected now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

async function openVpn() {
  state.view = 'vpn';
  state.newDevice = null;
  history.replaceState(null, '', '#vpn');
  renderList();
  $('#detail').innerHTML = '<div class="detail-inner"><p class="muted">Loading…</p></div>';
  await loadVpn();
}

async function loadVpn() {
  try {
    state.vpn = await api('/api/vpn');
    if (state.view === 'vpn') renderVpn();
  } catch (err) { fail(err); }
}

function renderVpn() {
  const v = state.vpn;
  const nd = state.newDevice;
  const full = v.devices.length >= v.maxDevices;

  const newDevice = nd ? `
    <section class="new-device" aria-labelledby="nd-title">
      <h2 id="nd-title">“${esc(nd.device.name)}” is ready to connect</h2>
      <p><strong>This is the only time the key for this device is shown.</strong>
        Download the file or scan the code now. If you lose it, remove the device and add it again.</p>
      <div class="nd-grid">
        <div class="qr" aria-label="QR code with the VPN configuration">${nd.qrSvg}</div>
        <div>
          <ol class="steps">
            <li>Install the WireGuard app on the device (wireguard.com/install).</li>
            <li><strong>Phone:</strong> tap “+”, then “Scan from QR code”.<br>
                <strong>Computer:</strong> “Import tunnel(s) from file” and choose the downloaded file.</li>
            <li>Activate the tunnel. Your servers are now reachable at their private addresses (${esc(v.network)}).</li>
          </ol>
          <div class="row">
            <button class="btn primary" data-download-conf>Download configuration</button>
            <button class="btn ghost" data-dismiss-device>Done</button>
          </div>
        </div>
      </div>
      <details><summary>Show configuration as text</summary><pre class="conf">${esc(nd.config)}</pre></details>
    </section>` : '';

  $('#detail').innerHTML = `
    <div class="detail-inner">
      <div class="detail-head"><div>
        <h1>VPN access</h1>
        <p class="muted plan-line">Connect your computer or phone securely to your private network
          <span class="mono">${esc(v.network)}</span>, for example to use Remote Desktop or SSH on your servers.
          Only traffic to your servers goes through the VPN.</p>
      </div></div>

      ${newDevice}

      <h2 class="h2">Your devices</h2>
      ${v.devices.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Device</th><th>VPN address</th><th>Last connected</th><th><span class="sr-only">Remove</span></th></tr></thead>
            <tbody>
              ${v.devices.map((d) => `
                <tr>
                  <td>${esc(d.name)}</td>
                  <td class="mono">${esc(d.address)}</td>
                  <td>${d.lastHandshake && Date.now() / 1000 - d.lastHandshake < 180
                    ? '<span class="led running"></span> ' : ''}${esc(ago(d.lastHandshake))}</td>
                  <td class="actions"><button class="btn danger" data-remove-device="${d.id}" data-name="${esc(d.name)}">Remove</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted">No devices yet. Add your laptop or phone below.</p>'}

      <h2 class="h2">Add a device</h2>
      ${full ? `<p class="muted">You have ${v.maxDevices} of ${v.maxDevices} devices. Remove one to add another.</p>` : `
        <form id="vpn-form" class="vpn-form" novalidate>
          <label>Device name
            <input name="name" required maxlength="40" pattern="[\\w .()\\-]+" placeholder="e.g. Office laptop" autocomplete="off">
          </label>
          <button class="btn primary">Add device</button>
        </form>
        <p id="vpn-error" class="form-error" role="alert"></p>`}
    </div>`;
}

$('#detail').addEventListener('submit', async (e) => {
  if (e.target.id !== 'vpn-form') return;
  e.preventDefault();
  const form = e.target;
  const err = $('#vpn-error');
  err.textContent = '';
  if (!form.reportValidity()) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    state.newDevice = await api('/api/vpn/devices', { method: 'POST', body: { name: form.name.value.trim() } });
    toast(`${state.newDevice.device.name} added`);
    state.vpn = await api('/api/vpn');
    renderVpn();
  } catch (ex) {
    err.textContent = ex.message;
    button.disabled = false;
  }
});

$('#detail').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t || state.view !== 'vpn') return;

  if (t.hasAttribute('data-download-conf')) {
    const nd = state.newDevice;
    const file = `${nd.device.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'vpn'}.conf`;
    const url = URL.createObjectURL(new Blob([nd.config], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: file });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (t.hasAttribute('data-dismiss-device')) {
    state.newDevice = null; // drop the private key from memory
    renderVpn();
  }

  if (t.dataset.removeDevice) {
    if (!(await confirmAction(`Remove “${t.dataset.name}”? It can no longer connect to your network.`, 'Remove'))) return;
    try {
      await api(`/api/vpn/devices/${t.dataset.removeDevice}`, { method: 'DELETE' });
      toast(`${t.dataset.name} removed`);
      state.vpn = await api('/api/vpn');
      renderVpn();
    } catch (err) { fail(err); }
  }
});

$('#detail').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-open-create')) openCreate();
  if (t.hasAttribute('data-cancel-create')) openHome();
  if (t.hasAttribute('data-generate')) {
    const input = t.closest('form').password;
    input.value = generatePassword();
    input.type = 'text';
  }
  if (t.hasAttribute('data-extend')) { extendExpiry(); return; }
  if (t.hasAttribute('data-renew-server') && state.detail) { billing.open({ focus: state.detail.vmid }); return; }
  if (t.hasAttribute('data-reinstall')) openReinstall();
  if (t.hasAttribute('data-resize')) openResize();
  if (t.hasAttribute('data-upgrade') && state.detail) {
    const vmid = state.detail.vmid;
    state.view = 'upgrade';
    openUpgrade(state.detail, { back: async () => { await loadList(); select(vmid); } }).catch(fail);
  }
  if (t.dataset.planMonths) {
    const form = t.closest('#create-form');
    form.dataset.months = t.dataset.planMonths;
    updatePlanChoice(form, state.plans);
  }
  if (t.hasAttribute('data-back-to-server') && state.detail) select(state.detail.vmid);
  if (t.hasAttribute('data-delete-server')) {
    const vm = state.vms.find((v) => v.vmid === state.selected);
    if (vm) deleteServer(state.detail?.vmid === vm.vmid ? { ...vm, ...state.detail, name: vm.name } : vm);
  }
});

$('#detail').addEventListener('change', (e) => {
  const reinstall = e.target.closest('#reinstall-form');
  if (reinstall && e.target.name === 'templateId') {
    const tpl = state.templates.find((t) => t.id === Number(e.target.value));
    if (tpl && !reinstall.username.dataset.edited && tpl.setup !== 'windows') reinstall.username.value = tpl.defaultUser || 'admin';
    if (tpl) applyTemplateMode(reinstall, tpl);
    return;
  }
  const form = e.target.closest('#create-form');
  if (!form) return;
  if (e.target.name === 'templateId') onTemplateChange(form);
  if (e.target.name === 'planId') updatePlanChoice(form, state.plans);
});
$('#detail').addEventListener('input', (e) => {
  if (e.target.name === 'username') e.target.dataset.edited = '1';
});
$('#detail').addEventListener('submit', (e) => {
  if (e.target.id === 'reinstall-form') {
    e.preventDefault();
    submitReinstall(e.target);
    return;
  }
  if (e.target.id === 'resize-form') {
    e.preventDefault();
    submitResize(e.target);
    return;
  }
  if (e.target.id !== 'create-form') return;
  e.preventDefault();
  submitCreate(e.target);
});

// ---------- account ----------------------------------------------------------
function openAccount() {
  state.view = 'account';
  state.selected = null;
  history.replaceState(null, '', '#account');
  renderList();
  $('#detail').innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Account</h1>
          <p class="lede">Signed in as ${esc(state.me.email)}.</p>
        </div>
      </header>
      <div id="security"></div>
      <div id="passkeys" class="account-section"></div>
      <div id="identities" class="account-section"></div>
      <div id="appearance" class="account-section"></div>
      <div id="api-tokens" class="account-section"></div>
      ${state.account.panelVersion ? `
        <section class="security-card about-panel">
          <div>
            <h2 class="twofa-title">About this panel</h2>
            <p class="muted">You're using version <span class="mono">${esc(state.account.panelVersion)}</span>.</p>
          </div>
        </section>` : ''}
    </div>`;
  renderSecurity($('#security'), { email: state.me.email });
  renderPasskeys($('#passkeys'));
  renderIdentities($('#identities'));
  renderAppearance($('#appearance'));
  renderTokens($('#api-tokens'), { portal: 'customer' });
}
$('#nav-account').addEventListener('click', openAccount);

// ---------- boot -----------------------------------------------------------
async function startApp(me) {
  await brandReady; // product name and own OS icons before the first render
  state.me = me;
  loadPersonalAppearance();
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#account-email').textContent = me.email;

  state.account = await api('/api/account').catch(() => ({ canCreate: false }));
  const pv = $('#panel-version');
  pv.hidden = !state.account.panelVersion;
  pv.textContent = state.account.panelVersion ? `Version ${state.account.panelVersion}` : '';
  await loadList().catch(fail);

  if (location.hash === '#new' && state.account.canCreate) {
    await openCreate();
  } else if (location.hash === '#account') {
    openAccount();
  } else if (location.hash === '#vpn' && state.account.vpn?.enabled) {
    await openVpn();
  } else if (assistant.route(location.hash) || billing.route(location.hash) || storage.route(location.hash) || support.route(location.hash)) {
    // support ticket or help-center article (e.g. a link from an email)
  } else {
    const fromHash = Number(location.hash.slice(1));
    if (state.vms.some((v) => v.vmid === fromHash)) await select(fromHash);
    else await openHome();
  }
  support.refreshBadge();
  assistant.loadStatus().then(() => renderList());
  billing.loadStatus().then(() => renderList());
  storage.loadStatus().then(() => renderList());

  // Every 10 s normally, every 5 s while a server is being created or deleted.
  clearInterval(state.poll);
  let tick = 0;
  state.poll = setInterval(async () => {
    if (document.hidden) return;
    tick += 1;
    const pending = state.vms.some((v) => v.state === 'creating' || v.state === 'deleting');
    if (!pending && tick % 2) return;

    const before = new Map(state.vms.map((v) => [v.vmid, `${v.state}/${v.status}/${v.progress}`]));
    await loadList().catch(() => {});
    if (pending) state.account = await api('/api/account').catch(() => state.account);

    if (state.view === 'overview') {
      // Redraw only when something visible changed (keeps keyboard focus otherwise).
      const after = state.vms.map((v) => `${v.vmid}/${v.state}/${v.status}/${v.progress}`).join();
      if (after !== [...before].map(([id, v]) => `${id}/${v}`).join()) renderHome();
      return;
    }
    if (state.view !== 'server' || !state.selected) return;

    const now = state.vms.find((v) => v.vmid === state.selected);
    if (!now) {
      // e.g. finished deleting
      openHome();
      return;
    }
    const changed = before.get(now.vmid) !== `${now.state}/${now.status}/${now.progress}`;
    if (changed && !state.busy.has(now.vmid) && (now.state !== 'ready' || state.tab === 'overview')) loadDetail();
  }, 5_000);
}

// ---------- invitation link (#invite=<token>) --------------------------------
// The token is after "#", so it never reaches the server's logs; it's sent in
// the request body and removed from the address bar right away.
async function showInvitation(token) {
  history.replaceState(null, '', location.pathname);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form').hidden = true;
  const box = $('#login-2fa');
  box.hidden = false;
  box.innerHTML = '<p class="muted">Checking your invitation…</p>';

  let check;
  try { check = await api('/api/invite/check', { method: 'POST', body: { token } }); } catch { check = { valid: false }; }
  if (!check.valid) {
    box.innerHTML = `
      <div class="twofa">
        <h2 class="twofa-title">${check.reason === 'expired' ? 'This invitation has expired' : 'This link is not valid'}</h2>
        <p class="muted">${check.reason === 'expired'
          ? 'Invitation links work for 3 days. Ask your provider to send a new one.'
          : 'It may have been used already or replaced by a newer invitation. Ask your provider for a new one, or sign in if you have already set your password.'}</p>
        <button class="btn primary wide" data-to-signin>Go to sign-in</button>
      </div>`;
    box.querySelector('[data-to-signin]').onclick = () => showLogin();
    return;
  }

  box.innerHTML = `
    <form class="twofa" id="invite-form" novalidate>
      <h2 class="twofa-title">Set your password</h2>
      <p class="muted">Welcome! Choose a password for <strong>${esc(check.email)}</strong>. You'll use it with this email to sign in.</p>
      <input type="email" name="username" value="${esc(check.email)}" autocomplete="username" hidden>
      <label>New password
        <input name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password">
        <span class="hint">At least 12 characters. A passphrase of several words works well.</span>
      </label>
      <label>Repeat the password
        <input name="password2" type="password" required minlength="12" maxlength="200" autocomplete="new-password">
      </label>
      ${check.requireTotp ? '<p class="muted small">At your first sign-in you\'ll also set up two-factor authentication with an authenticator app.</p>' : ''}
      <p class="form-error" role="alert"></p>
      <button class="btn primary wide">Set password</button>
    </form>`;
  const form = box.querySelector('#invite-form');
  form.password.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    err.textContent = '';
    if (!form.reportValidity()) return;
    if (form.password.value !== form.password2.value) {
      err.textContent = "The two passwords don't match.";
      return;
    }
    const b = form.querySelector('.btn.primary');
    b.disabled = true;
    try {
      const r = await api('/api/invite/accept', { method: 'POST', body: { token, password: form.password.value } });
      showLogin();
      $('#login-form [name=email]').value = r.email;
      $('#login-form [name=password]').focus();
      $('#login-error').textContent = '';
      toast('Your password is set. Sign in now.');
    } catch (ex) {
      err.textContent = ex.message;
      b.disabled = false;
    }
  };
}

const inviteToken = /^#invite=([A-Za-z0-9_-]{40,60})$/.exec(location.hash)?.[1];
if (inviteToken) {
  showInvitation(inviteToken);
} else {
  api('/api/auth/me').then(startApp).catch((err) => {
    if (!(err instanceof SignedOut)) showLogin();
  });
}
