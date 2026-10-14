// Customer portal: support tickets and the help center (knowledge base).
import { $, api, esc, toast, fail, confirmAction } from '/shared/ui.js';
import { icon } from '/shared/icons.js';
import { markdown } from '/shared/markdown.js';

const CATEGORIES = [
  ['server', 'A server'], ['network', 'Network or VPN'], ['storage', 'Disk, backups or storage'], ['account', 'My account or sign-in'],
  ['security', 'Security (suspicious activity)'], ['billing', 'Billing'], ['other', 'Something else'],
];
const STATUS = { open: ['With support', ''], waiting: ['Your reply needed', 'warn'], resolved: ['Solved', 'ok'], closed: ['Closed', 'ok'] };
const utc = (d) => new Date(`${d.replace(' ', 'T')}Z`);
const when = (d) => utc(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const statusTag = (s) => `<span class="tag ${STATUS[s]?.[1] ?? ''}">${esc(STATUS[s]?.[0] ?? s)}</span>`;

/**
 * ctx: { state, renderList, setView(view, hash) } from app.js.
 */
export function createSupport(ctx) {
  const detail = () => $('#detail');
  let suggestTimer = null;

  async function refreshBadge() {
    try {
      const r = await api('/api/support/tickets');
      ctx.state.supportWaiting = r.waiting;
      ctx.renderList();
    } catch { /* not important */ }
  }

  // ---- Tickets ------------------------------------------------------------------
  async function openSupport(arg = null) {
    if (arg === 'new') return openNew();
    if (arg) return openTicket(Number(arg));
    ctx.setView('support', '#support');
    detail().innerHTML = '<div class="page"><p class="muted">Loading…</p></div>';
    let r;
    try { r = await api('/api/support/tickets'); } catch (err) { return fail(err); }
    ctx.state.supportWaiting = r.waiting;
    ctx.renderList();
    if (ctx.state.view !== 'support') return;
    detail().innerHTML = `
      <div class="page">
        <header class="page-head">
          <div><h1>Support</h1><p class="lede">Questions or problems with your servers? We answer here and by email.</p></div>
          <div class="row"><a class="btn" href="#help">${icon('book')}<span>Help center</span></a>
            <button class="btn primary" data-new-ticket>${icon('plus')}<span>New ticket</span></button></div>
        </header>
        ${r.tickets.length ? `
          <div class="table-wrap"><table class="table ticket-table">
            <thead><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Last update</th></tr></thead>
            <tbody>${r.tickets.map((t) => `
              <tr data-ticket="${t.number}" tabindex="0" class="${t.status === 'waiting' ? 'row-attention' : ''}">
                <td class="mono">#${t.number}</td><td>${esc(t.subject)}</td><td>${statusTag(t.status)}</td>
                <td class="nowrap muted">${esc(when(t.updatedAt))}</td></tr>`).join('')}
            </tbody></table></div>`
          : `<div class="empty"><h2>No tickets yet</h2><p class="muted">Many answers are in the <a href="#help">help center</a>. If not, open a ticket.</p></div>`}
      </div>`;
  }

  function openNew(prefill = {}) {
    ctx.setView('support-new', '#support/new');
    const servers = ctx.state.vms ?? [];
    detail().innerHTML = `
      <div class="page narrow-page">
        <header class="page-head"><div><a href="#support" class="back-link">‹ Support</a><h1>New ticket</h1></div></header>
        <form id="ticket-form" class="email-form" novalidate>
          <label>What is it about?
            <select name="category">${CATEGORIES.map(([v, l]) => `<option value="${v}" ${prefill.category === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Server <span class="muted small">(optional)</span>
            <select name="vmid"><option value="">None</option>${servers.map((v) => `<option value="${v.vmid}" ${prefill.vmid === v.vmid ? 'selected' : ''}>${esc(v.name)} (${v.vmid})</option>`).join('')}</select></label>
          <label>Subject <input name="subject" maxlength="120" required autocomplete="off" placeholder="e.g. Website not reachable after a restart"></label>
          <div id="ticket-suggest" class="suggest" aria-live="polite"></div>
          <label>Describe the problem
            <textarea name="body" rows="7" maxlength="10000" required placeholder="What happened, since when, what you tried. Never send passwords."></textarea></label>
          <label>How urgent?
            <select name="priority">
              <option value="low">Low: a question, no hurry</option>
              <option value="normal" selected>Normal</option>
              <option value="high">High: something important doesn't work</option>
              <option value="urgent">Urgent: production is down</option>
            </select></label>
          <p class="form-error" id="ticket-error" role="alert"></p>
          <div class="row"><button class="btn primary">Send ticket</button><a class="btn ghost" href="#support">Cancel</a></div>
        </form>
      </div>`;
    const f = $('#ticket-form');
    f.elements.subject.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => suggest(f.elements.subject.value), 350);
    });
    f.elements.subject.focus();
  }

  /** Articles that may already answer the question, while the subject is typed. */
  async function suggest(q) {
    const box = $('#ticket-suggest');
    if (!box) return;
    if (q.trim().length < 4) { box.innerHTML = ''; return; }
    try {
      const r = await api(`/api/kb?q=${encodeURIComponent(q)}`);
      box.innerHTML = r.results.length ? `
        <p class="small muted">These articles may already help:</p>
        <ul class="suggest-list">${r.results.slice(0, 3).map((a) => `<li><a href="#help/${esc(a.slug)}" target="_blank">${esc(a.title)}</a></li>`).join('')}</ul>` : '';
    } catch { box.innerHTML = ''; }
  }

  async function submitNew(f) {
    const el = f.elements;
    const err = $('#ticket-error');
    err.textContent = '';
    const body = { subject: el.subject.value.trim(), body: el.body.value.trim(), category: el.category.value, priority: el.priority.value };
    if (el.vmid.value) body.vmid = Number(el.vmid.value);
    if (body.subject.length < 4) { err.textContent = 'Please enter a subject (at least 4 characters).'; return; }
    if (body.body.length < 10) { err.textContent = 'Please describe the problem (at least 10 characters).'; return; }
    f.querySelector('.btn.primary').disabled = true;
    try {
      const t = await api('/api/support/tickets', { method: 'POST', body });
      toast(`Ticket #${t.number} sent. We'll answer here and by email.`);
      openTicket(t.number);
    } catch (e) { err.textContent = e.message; f.querySelector('.btn.primary').disabled = false; }
  }

  async function openTicket(number) {
    ctx.setView('ticket', `#support/${number}`);
    let t;
    try { t = await api(`/api/support/tickets/${number}`); } catch (err) { fail(err); return openSupport(); }
    const vm = (ctx.state.vms ?? []).find((v) => v.vmid === t.vmid);
    detail().innerHTML = `
      <div class="page narrow-page">
        <header class="page-head">
          <div><a href="#support" class="back-link">‹ Support</a>
            <h1>${esc(t.subject)}</h1>
            <p class="lede"><span class="mono">#${t.number}</span> · ${statusTag(t.status)}${vm ? ` · ${esc(vm.name)}` : ''} · opened ${esc(when(t.createdAt))}</p></div>
          ${['open', 'waiting'].includes(t.status) ? '<button class="btn ghost" data-close-ticket>Close ticket</button>' : ''}
        </header>
        <ol class="conversation">
          ${t.messages.map((m) => `
            <li class="msg msg-${m.author}">
              <div class="msg-head"><strong>${esc(m.name)}</strong><span class="muted small">${esc(when(m.createdAt))}</span></div>
              <div class="msg-body md">${markdown(m.body)}</div>
            </li>`).join('')}
        </ol>
        ${t.status === 'closed' ? '<p class="notice"><span>This ticket is closed. For a new question, <a href="#support/new">open a new ticket</a>.</span></p>' : `
          <form id="reply-form" class="email-form" novalidate>
            <label>${t.status === 'waiting' ? 'Your reply' : 'Add a message'}
              <textarea name="body" rows="4" maxlength="10000" required></textarea></label>
            <div class="row"><button class="btn primary">Send</button></div>
          </form>`}
      </div>`;
    if (t.status === 'waiting') refreshBadge();
  }

  async function submitReply(f) {
    const text = f.elements.body.value.trim();
    if (!text) return;
    f.querySelector('.btn.primary').disabled = true;
    try {
      const number = Number(location.hash.split('/')[1]);
      await api(`/api/support/tickets/${number}/messages`, { method: 'POST', body: { body: text } });
      openTicket(number);
      refreshBadge();
    } catch (err) { fail(err); f.querySelector('.btn.primary').disabled = false; }
  }

  // ---- Help center -----------------------------------------------------------------
  async function openHelp(slug = null, q = '') {
    if (slug) return openArticle(slug);
    ctx.setView('help', '#help');
    detail().innerHTML = `
      <div class="page">
        <header class="page-head"><div><h1>Help center</h1><p class="lede">Answers to common questions. Can't find it? <a href="#support/new">Ask support</a>.</p></div></header>
        <form id="help-search" class="help-search" role="search">
          <label class="grow"><span class="sr-only">Search the help center</span>
            <input type="search" name="q" value="${esc(q)}" placeholder="Search, e.g. reset password, VPN, snapshot" autocomplete="off"></label>
          <button class="btn primary">${icon('search')}<span>Search</span></button>
        </form>
        <div id="help-results"><p class="muted">Loading…</p></div>
      </div>`;
    if (q) return runSearch(q);
    try {
      const r = await api('/api/kb');
      $('#help-results').innerHTML = r.categories.length ? `
        <div class="help-grid">${r.categories.map((c) => `
          <section class="security-card help-cat"><h2 class="twofa-title">${esc(c.name)}</h2>
            <ul class="help-list">${c.articles.map((a) => `<li><a href="#help/${esc(a.slug)}">${esc(a.title)}</a></li>`).join('')}</ul>
          </section>`).join('')}</div>`
        : '<p class="muted">No articles yet.</p>';
    } catch (err) { fail(err); }
  }

  async function runSearch(q) {
    const box = $('#help-results');
    try {
      const r = await api(`/api/kb?q=${encodeURIComponent(q)}&log=1`);
      box.innerHTML = r.results.length ? `
        <p class="muted small">${r.results.length} result${r.results.length === 1 ? '' : 's'} for “${esc(q)}”</p>
        <ul class="help-results">${r.results.map((a) => `
          <li><a href="#help/${esc(a.slug)}"><strong>${esc(a.title)}</strong></a><span class="muted small">${esc(a.category)}</span>
            <p class="muted">${esc(a.excerpt)}</p></li>`).join('')}</ul>`
        : `<div class="empty"><h2>Nothing found for “${esc(q)}”</h2>
            <p class="muted">We note searches without an answer and write the missing articles.</p>
            <a class="btn primary" href="#support/new">Ask support</a></div>`;
    } catch (err) { fail(err); }
  }

  async function openArticle(slug) {
    ctx.setView('article', `#help/${slug}`);
    let a;
    try { a = await api(`/api/kb/${encodeURIComponent(slug)}`); } catch (err) { fail(err); return openHelp(); }
    detail().innerHTML = `
      <div class="page narrow-page">
        <header class="page-head"><div><a href="#help" class="back-link">‹ Help center</a>
          <h1>${esc(a.title)}</h1><p class="lede">${esc(a.category)} · updated ${esc(utc(a.updatedAt).toLocaleDateString())}</p></div></header>
        <article class="md kb-article">${markdown(a.body)}</article>
        <section class="kb-feedback" aria-label="Feedback">
          <span>Did this help?</span>
          <button class="btn" data-kb-vote="yes">Yes</button><button class="btn" data-kb-vote="no">No</button>
        </section>
      </div>`;
    detail().dataset.slug = a.slug;
  }

  // ---- Events (detail area) --------------------------------------------------------------
  detail().addEventListener('click', async (e) => {
    if (!['support', 'support-new', 'ticket', 'help', 'article'].includes(ctx.state.view)) return;
    const row = e.target.closest('tr[data-ticket]');
    if (row) return openTicket(Number(row.dataset.ticket));
    if (e.target.closest('[data-new-ticket]')) return openNew();
    if (e.target.closest('[data-close-ticket]')) {
      if (!(await confirmAction('Close this ticket? You can open a new one any time.', 'Close ticket'))) return;
      const number = Number(location.hash.split('/')[1]);
      try { await api(`/api/support/tickets/${number}/close`, { method: 'POST' }); toast('Ticket closed'); openTicket(number); } catch (err) { fail(err); }
      return;
    }
    const vote = e.target.closest('[data-kb-vote]');
    if (vote) {
      const box = vote.closest('.kb-feedback');
      try {
        await api(`/api/kb/${encodeURIComponent(detail().dataset.slug)}/feedback`, { method: 'POST', body: { helpful: vote.dataset.kbVote === 'yes' } });
        box.innerHTML = vote.dataset.kbVote === 'yes' ? '<span>Thanks for your feedback!</span>'
          : '<span>Sorry about that. <a href="#support/new">Ask support</a> and we will help you.</span>';
      } catch (err) { fail(err); }
    }
  });
  detail().addEventListener('keydown', (e) => {
    const row = e.target.closest?.('tr[data-ticket]');
    if (row && e.key === 'Enter') openTicket(Number(row.dataset.ticket));
  });
  detail().addEventListener('submit', (e) => {
    if (e.target.id === 'ticket-form') { e.preventDefault(); submitNew(e.target); }
    if (e.target.id === 'reply-form') { e.preventDefault(); submitReply(e.target); }
    if (e.target.id === 'help-search') {
      e.preventDefault();
      const q = e.target.elements.q.value.trim();
      if (q) runSearch(q);
    }
  });

  /** #support, #support/new, #support/1001, #help, #help/<slug>: true when handled. */
  function route(hash) {
    let m = /^#support(?:\/(new|\d+))?$/.exec(hash);
    if (m) { openSupport(m[1] ?? null); return true; }
    m = /^#help(?:\/([a-z0-9-]+))?$/.exec(hash);
    if (m) { openHelp(m[1] ?? null); return true; }
    return false;
  }

  return { openSupport, openHelp, openNew, route, refreshBadge };
}
