// White-label: product name, logo, favicon and support link for both portals,
// the sign-in pages and emails. Set by the panel owner in Settings → Branding
// (overrides PANEL_NAME). Image files live in the branding folder (BRANDING_DIR,
// default "branding" next to the database), next to the optional own OS icons.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

const KEY = 'branding';
export const brandingDir = path.resolve(config.brand.dir || path.join(path.dirname(path.resolve(config.dbPath)), 'branding'));

// Files the panel serves from the branding folder
export const SERVED_FILE = /^(os-(windows|linux)|logo|favicon)\.(svg|png|webp)$/;
const ASSETS = { logo: { maxBytes: 512 * 1024 }, favicon: { maxBytes: 128 * 1024 } };
const TYPES = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/webp': 'webp' };

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });

function stored() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : {};
}

function store(value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(value));
}

/** URL of an uploaded image (with its change time, so browsers fetch a new one), or null. */
function assetUrl(kind) {
  for (const ext of Object.values(TYPES)) {
    try {
      const st = fs.statSync(path.join(brandingDir, `${kind}.${ext}`));
      return `/branding/${kind}.${ext}?v=${Math.floor(st.mtimeMs)}`;
    } catch { /* not there */ }
  }
  return null;
}

/** Product name: Settings first, then PANEL_NAME, then "PVE Panel". */
export const brandName = () => stored().name || config.brand.name;

export function branding() {
  const s = stored();
  return {
    name: brandName(),
    customName: s.name ?? '',
    defaultName: config.brand.name,
    supportUrl: s.supportUrl ?? '',
    logo: assetUrl('logo'),
    favicon: assetUrl('favicon'),
  };
}

export function saveBranding(input) {
  const next = { ...stored() };
  if (typeof input.name === 'string') {
    const name = input.name.trim();
    if (name.length > 40) throw fail(400, 'The name can be at most 40 characters');
    next.name = name || undefined;
  }
  if (typeof input.supportUrl === 'string') {
    const url = input.supportUrl.trim();
    if (url && !/^(https:\/\/[^\s<>"']+|mailto:[^\s<>"']+@[^\s<>"']+)$/i.test(url)) {
      throw fail(400, 'Support link: an https:// address or mailto:');
    }
    next.supportUrl = url || undefined;
  }
  store(next);
  return branding();
}

// SVGs are served with a script-blocking sandbox policy and shown through <img>
// (where scripts never run); still, refuse anything active in them.
const ACTIVE_SVG = /<script|<foreignObject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object|xlink:href\s*=\s*["']\s*(?!#)|href\s*=\s*["']\s*(?!#|data:image\/)/i;

/** Saves an uploaded logo or favicon (base64 data). */
export function saveAsset(kind, { type, data }) {
  if (!ASSETS[kind]) throw fail(404, 'Unknown image');
  const ext = TYPES[type];
  if (!ext) throw fail(400, 'Use an SVG, PNG or WebP image');
  const buf = Buffer.from(String(data ?? ''), 'base64');
  if (!buf.length) throw fail(400, 'The image is empty');
  if (buf.length > ASSETS[kind].maxBytes) throw fail(413, `The image is too large (at most ${ASSETS[kind].maxBytes / 1024} KB)`);
  const head = buf.subarray(0, 12);
  if (ext === 'png' && !head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw fail(400, 'That is not a PNG file');
  if (ext === 'webp' && !(head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP')) throw fail(400, 'That is not a WebP file');
  if (ext === 'svg') {
    const text = buf.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) throw fail(400, 'That is not an SVG file');
    if (ACTIVE_SVG.test(text)) throw fail(400, 'The SVG contains scripts or links; export it as a plain image');
  }
  fs.mkdirSync(brandingDir, { recursive: true });
  removeAsset(kind);
  fs.writeFileSync(path.join(brandingDir, `${kind}.${ext}`), buf);
  return branding();
}

export function removeAsset(kind) {
  if (!ASSETS[kind]) throw fail(404, 'Unknown image');
  for (const ext of Object.values(TYPES)) fs.rmSync(path.join(brandingDir, `${kind}.${ext}`), { force: true });
  return branding();
}
