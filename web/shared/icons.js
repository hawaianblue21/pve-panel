// Small hand-drawn icon set (24x24, stroke-based, currentColor) shared by both
// interfaces. Icons are decorative (aria-hidden); buttons carry their own text.

const paths = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.5-2h5L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  chart: '<path d="M4 19h16"/><path d="M6 15l4-5 3.5 3L19 6"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  logout: '<path d="M14 4.5h4.5v15H14"/><path d="M10 8l-4 4 4 4M6 12h9.5"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.8-3.3 3.2-5 6-5s5.2 1.7 6 5"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.8c1.8.6 3 2.2 3.5 4.7"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/>',
  disk: '<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/><path d="M4.5 6.5v11c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-11"/><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="3.5" y="8" width="17" height="11.5" rx="2"/><path d="M16 13.75h1.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
  chat: '<path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5z"/><path d="M8.5 9.5h7M8.5 12.5h4.5"/>',
  book: '<path d="M4.5 5.5c2.5-1 5-1 7.5.5 2.5-1.5 5-1.5 7.5-.5v13c-2.5-1-5-1-7.5.5-2.5-1.5-5-1.5-7.5-.5z"/><path d="M12 6v13"/>',
  spark: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  // OS glyphs: neutral shapes, not vendor logos
  linux: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l2.5 2L7 14M11.5 14.5H16"/>',
  windows: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6 6.8h.01M8.5 6.8h.01"/>',
};

export function icon(name, { size = 18, cls = '' } = {}) {
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.server}</svg>`;
}

// Own icon files from the branding folder, set by applyBrand(): { windows: url, … }
let customOsIcons = {};
export const customOsIcon = (os) => customOsIcons[os] ?? null;

/** OS glyph for a server: 'windows' | 'linux' | anything else = generic server. */
export function osIcon(os, size = 20) {
  const own = customOsIcon(os);
  if (own) return `<img class="os-glyph os-img" src="${own}" width="${size}" height="${size}" alt="">`;
  return icon(os === 'windows' ? 'windows' : os === 'linux' ? 'linux' : 'server', { size, cls: 'os-glyph' });
}

/** Brand mark: a hub with three connected nodes, the product's network motif. */
export function brandMark(size = 28) {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 16L7 8M16 16l10-4M16 16l-3 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
    <circle cx="16" cy="16" r="5" fill="var(--signal)"/>
    <circle cx="7" cy="8" r="3" fill="currentColor"/>
    <circle cx="26" cy="12" r="3" fill="currentColor"/>
    <circle cx="13" cy="27" r="3" fill="currentColor"/>
  </svg>`;
}

// Color scheme: apply the last known one immediately (no flash of the default
// colors), then whatever the server says. The panel's scheme is set by an admin
// for everyone; a signed-in user may choose their own scheme and light/dark mode
// (Account → Appearance), remembered in this browser too.
const SCHEME_KEY = 'pve-panel.scheme';
const PERSONAL_KEY = 'pve-panel.personal';
let personal = null;   // { scheme, mode } of the signed-in user, or null
let panelScheme = null;
const html = document.documentElement;

function setMode(mode) {
  if (mode === 'light' || mode === 'dark') html.dataset.mode = mode;
  else delete html.dataset.mode;
}

/** The panel's scheme (for everyone); a personal choice still wins. */
export function applyScheme(id) {
  if (!id) return;
  panelScheme = id;
  html.dataset.scheme = personal?.scheme || id;
  try { localStorage.setItem(SCHEME_KEY, id); } catch { /* storage unavailable */ }
}

/** The signed-in user's own choice (from /api/account/appearance); null clears it (sign-out). */
export function applyPersonal(a) {
  personal = a && a.allowed ? { scheme: a.scheme ?? null, mode: a.mode ?? 'system' } : null;
  try {
    if (personal) localStorage.setItem(PERSONAL_KEY, JSON.stringify(personal)); else localStorage.removeItem(PERSONAL_KEY);
  } catch { /* storage unavailable */ }
  if (a?.effective) html.dataset.scheme = a.effective;
  else if (!a) {
    let fallback = panelScheme;
    try { fallback ??= localStorage.getItem(SCHEME_KEY); } catch { /* ignore */ }
    if (fallback) html.dataset.scheme = fallback; else delete html.dataset.scheme;
  }
  setMode(personal?.mode);
}

try {
  personal = JSON.parse(localStorage.getItem(PERSONAL_KEY) || 'null');
  const remembered = personal?.scheme || localStorage.getItem(SCHEME_KEY);
  if (remembered) html.dataset.scheme = remembered;
  setMode(personal?.mode);
} catch { /* ignore */ }

let brandInfo = null;
/** What /api/brand said (after applyBrand), e.g. the support link. */
export const brandDetails = () => brandInfo;

/** Fetches the product name and applies it to the page (title + [data-brand]). */
export async function applyBrand(suffix = '') {
  let name = 'PVE Panel';
  try {
    const r = await fetch('/api/brand');
    if (r.ok) {
      const b = await r.json();
      name = b.name || name;
      customOsIcons = b.osIcons ?? {};
      applyScheme(b.scheme);
      brandInfo = b;
      // Own logo (Settings → Branding) instead of the built-in mark
      if (b.logo) {
        document.querySelectorAll('[data-brand-mark]').forEach((el) => {
          el.innerHTML = `<img class="brand-logo" src="${b.logo.replace(/"/g, '')}" alt="">`;
        });
      }
      if (b.favicon) {
        let link = document.querySelector('link[rel="icon"]');
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
        link.href = b.favicon;
      }
      if (b.supportUrl) {
        document.querySelectorAll('[data-support-link]').forEach((a) => { a.href = b.supportUrl; a.hidden = false; });
      }
    }
  } catch { /* keep default */ }
  document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = name; });
  document.title = suffix ? `${suffix} – ${name}` : name;
  return name;
}
