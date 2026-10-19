// Generates docs/reference/configuration.md from ../example.env, so the
// configuration reference always matches the real settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '..', '..', 'example.env');
const out = path.join(here, '..', 'docs', 'reference', 'configuration.md');

const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);

// Topic of a setting, by its name (independent of the order in example.env)
const TOPICS = [
  ['Proxmox connection', /^PVE_/],
  ['Panel, ports and security', /^(PORT|HOST|ADMIN_PORT|ADMIN_HOST|JWT_SECRET|COOKIE_SECURE|DB_PATH|PANEL_PUBLIC_URL|ADMIN_PUBLIC_URL|INITIAL_ADMIN_)/],
  ['Sign-in: passwords, passkeys and single sign-on', /^(PASSWORD_LOGIN_|OIDC_|PASSKEYS_)/],
  ['Customer networks', /^(CUSTOMER_|SDN_)/],
  ['WireGuard VPN', /^VPN_/],
  ['Tailscale', /^TAILSCALE_/],
  ['Windows and guest agent', /^(WINDOWS_|AGENT_|WINUPDATE_)/],
  ['Limits', /^MAX_/],
  ['Branding and versions', /^(PANEL_NAME|BRANDING_DIR|SHOW_VERSION_TO_CUSTOMERS|UPDATE_CHECK)/],
  ['Server expiry', /^EXPIRY_/],
  ['Docker', /^(PANEL_IMAGE|PANEL_DOMAIN)/],
];
const topicOf = (key) => TOPICS.find(([, re]) => re.test(key))?.[0] ?? 'Other';

const rows = [];
let comment = [];
let blockHelp = '';        // a comment describes the whole block of settings below it
for (const raw of lines) {
  const line = raw.trim();
  if (!line) { comment = []; blockHelp = ''; continue; }
  if (/^#\s*-{2,}/.test(line)) { comment = []; continue; }      // section banner
  if (line.startsWith('#')) {
    const text = line.replace(/^#\s?/, '');
    const opt = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(text);          // commented-out = optional
    if (opt) { rows.push({ key: opt[1], value: opt[2], help: comment.join(' ') || blockHelp, optional: true }); continue; }
    comment.push(text);
    continue;
  }
  const kv = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
  if (kv) {
    const help = comment.join(' ');
    rows.push({ key: kv[1], value: kv[2], help: help || (blockHelp ? '″' : '') });
    if (help) blockHelp = help;
    comment = [];
  }
}
const sections = TOPICS.map(([title]) => title).concat('Other')
  .map((title) => ({ title, rows: rows.filter((r) => topicOf(r.key) === title) }))
  .filter((s) => s.rows.length);

const cell = (t) => String(t).replace(/\|/g, '\\|').trim();
let md = `---
title: Configuration (.env)
sidebar_position: 1
---

All settings of the panel, generated from [\`example.env\`](https://github.com/hawaianblue21/pve-panel/blob/main/example.env).
Copy that file to \`.env\` and adjust it. Email settings are made in the admin interface
(**Settings**), not here.

`;
for (const s of sections) {
  md += `## ${s.title}\n\n| Setting | Example / default | Description |\n|---|---|---|\n`;
  for (const r of s.rows) {
    const help = r.help === '″' ? '<small>see above</small>' : cell(r.help);
    md += `| \`${r.key}\` | ${r.value ? `\`${cell(r.value)}\`` : '–'} | ${help}${r.optional ? ' *(optional)*' : ''} |\n`;
  }
  md += '\n';
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log(`configuration.md: ${sections.reduce((n, s) => n + s.rows.length, 0)} settings in ${sections.length} sections`);
