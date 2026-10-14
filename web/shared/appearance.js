// "Appearance" card on the account page: the user's own color scheme and
// light/dark mode (when the panel owner allows it), applied right away.
import { api, esc, toast, fail } from '/shared/ui.js';
import { applyPersonal } from '/shared/icons.js';

/** Loads and applies the signed-in user's choice (call after sign-in). */
export async function loadPersonalAppearance() {
  try { applyPersonal(await api('/api/account/appearance')); } catch { /* keep the panel's scheme */ }
}

export async function renderAppearance(container) {
  let a;
  try { a = await api('/api/account/appearance'); } catch (err) { container.innerHTML = ''; return fail(err); }
  if (!a.allowed) { container.innerHTML = ''; return; }
  const panel = a.schemes.find((s) => s.id === a.panelScheme);
  const tiles = [{ id: '', name: 'Panel default', description: `Currently ${panel?.name ?? a.panelScheme}`, accent: panel?.accent, side: panel?.side }, ...a.schemes];

  container.innerHTML = `
    <section class="security-card settings-card">
      <div class="settings-head">
        <h2 class="twofa-title">Appearance</h2>
        <p class="muted">Only for your account, on every device you sign in with.</p>
      </div>
      <div class="scheme-grid" role="radiogroup" aria-label="Color scheme">
        ${tiles.map((sc) => `
          <button type="button" class="scheme-tile" role="radio" data-my-scheme="${esc(sc.id)}" aria-checked="${(a.scheme ?? '') === sc.id}">
            <span class="scheme-preview" aria-hidden="true">
              <span class="sp-side" style="background:${esc(sc.side)}"><i></i><i></i><i></i></span>
              <span class="sp-main"><span class="sp-line"></span><span class="sp-line short"></span>
                <span class="sp-btn" style="background:${esc(sc.accent)}"></span></span>
            </span>
            <span class="scheme-name">${esc(sc.name)}</span>
            <span class="muted small">${esc(sc.description)}</span>
          </button>`).join('')}
      </div>
      <div class="segmented" role="radiogroup" aria-label="Light or dark">
        ${[['system', 'Follow device'], ['light', 'Light'], ['dark', 'Dark']].map(([m, label]) => `
          <button type="button" role="radio" data-my-mode="${m}" aria-checked="${a.mode === m}">${label}</button>`).join('')}
      </div>
    </section>`;

  const save = async (body) => {
    try {
      const next = await api('/api/account/appearance', { method: 'PUT', body });
      applyPersonal(next);
      toast('Appearance saved');
      renderAppearance(container);
    } catch (err) { fail(err); }
  };
  container.querySelectorAll('[data-my-scheme]').forEach((b) => {
    b.onclick = () => save({ scheme: b.dataset.myScheme || null });
  });
  container.querySelectorAll('[data-my-mode]').forEach((b) => {
    b.onclick = () => save({ mode: b.dataset.myMode });
  });
}
