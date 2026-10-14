// Color schemes, chosen by an administrator (Settings → Appearance) and applied
// to the admin interface, the customer portal, both sign-in pages and emails.
// Each scheme has a light and a dark variant (the panel follows the device's
// light/dark setting); contrast is at least 4.5:1 for text (WCAG AA).
// The colors themselves live in web/shared/styles.css ([data-scheme="…"]).

import { db } from './db.js';

export const SCHEMES = [
  { id: 'harbor', name: 'Harbor', description: 'Signal blue on slate — the original look', accent: '#3558e6', side: '#172230' },
  { id: 'forest', name: 'Forest', description: 'Calm green on deep pine', accent: '#1d7350', side: '#132a20' },
  { id: 'ember', name: 'Ember', description: 'Warm orange on dark brown', accent: '#b9400f', side: '#2a1c15' },
  { id: 'orchid', name: 'Orchid', description: 'Violet on aubergine', accent: '#7339e0', side: '#221836' },
  { id: 'graphite', name: 'Graphite', description: 'Neutral graphite with teal', accent: '#0d7068', side: '#202427' },
];
export const DEFAULT_SCHEME = 'harbor';
const KEY = 'appearance';

const storedSettings = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : {};
};

export function currentScheme() {
  const id = storedSettings().scheme;
  return SCHEMES.some((s) => s.id === id) ? id : DEFAULT_SCHEME;
}

/** May users pick their own scheme and light/dark mode (Account → Appearance)? On by default. */
export const personalAllowed = () => storedSettings().allowPersonal !== false;

export function setAllowPersonal(allowed) {
  storeSettings({ ...storedSettings(), allowPersonal: !!allowed });
}

function storeSettings(value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(KEY, JSON.stringify(value));
}

// ---- Personal choice (per account) ------------------------------------------------
export const MODES = ['system', 'light', 'dark'];

/** What this account sees: its own choice when allowed, else the panel's scheme and the device's mode. */
export function userAppearance(userId) {
  const u = db.prepare('SELECT ui_scheme, ui_mode FROM users WHERE id = ?').get(userId) ?? {};
  const allowed = personalAllowed();
  const own = allowed && SCHEMES.some((s) => s.id === u.ui_scheme) ? u.ui_scheme : null;
  const mode = allowed && MODES.includes(u.ui_mode) ? u.ui_mode : 'system';
  return { allowed, scheme: own, mode, effective: own ?? currentScheme(), panelScheme: currentScheme(), schemes: SCHEMES };
}

export function setUserAppearance(userId, { scheme, mode }) {
  if (!personalAllowed()) {
    throw Object.assign(new Error('Your provider sets the appearance for everyone'), { statusCode: 403, expose: true });
  }
  if (scheme !== undefined && scheme !== null && !SCHEMES.some((s) => s.id === scheme)) {
    throw Object.assign(new Error('Unknown color scheme'), { statusCode: 400, expose: true });
  }
  if (mode !== undefined && !MODES.includes(mode)) {
    throw Object.assign(new Error('Mode must be system, light or dark'), { statusCode: 400, expose: true });
  }
  if (scheme !== undefined) db.prepare('UPDATE users SET ui_scheme = ? WHERE id = ?').run(scheme, userId);
  if (mode !== undefined) db.prepare('UPDATE users SET ui_mode = ? WHERE id = ?').run(mode === 'system' ? null : mode, userId);
  return userAppearance(userId);
}

export function setScheme(id) {
  if (!SCHEMES.some((s) => s.id === id)) {
    throw Object.assign(new Error('Unknown color scheme'), { statusCode: 400, expose: true });
  }
  storeSettings({ ...storedSettings(), scheme: id });
  return id;
}

/** Colors for emails (light variant). */
export function schemeColors() {
  const s = SCHEMES.find((x) => x.id === currentScheme());
  return { accent: s.accent, side: s.side };
}
