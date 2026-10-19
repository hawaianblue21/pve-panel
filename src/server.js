import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';

import { config } from './config.js';
import { db } from './db.js';
import { bootstrapAdmin } from './bootstrap.js';
import { versionInfo, updateStatus } from './version.js';
import { startExpiryScheduler } from './expiry.js';
import { currentScheme } from './appearance.js';
import { branding, brandingDir, SERVED_FILE } from './branding.js';
import { startUpdateTracker } from './winupdate.js';
import authPlugin from './auth.js';
import vmRoutes from './routes/vms.js';
import consoleRoutes from './routes/console.js';
import vpnRoutes from './routes/vpn.js';
import storageRoutes from './routes/storage.js';
import supportRoutes from './routes/support.js';
import assistantRoutes from './routes/assistant.js';
import billingRoutes from './routes/billing.js';
import volumeRoutes from './routes/volumes.js';
import ipRoutes from './routes/ips.js';
import { customerTokenRoutes } from './routes/tokens.js';
import { startAutoRenew, refundFailedOrder } from './billing.js';
import { startRolloutEngine } from './rollouts.js';
import { startSnapshotSchedules } from './snapschedule.js';
import { onCreateFailed } from './provision.js';
import { startZammadRetry } from './zammad.js';
import { syncOnStartup } from './vpn.js';
import { reapplyIsolation, syncVnetAliases } from './network.js';
import adminRoutes from './routes/admin.js';
import { PveError } from './pve.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (dir) => path.join(root, 'web', dir);

function errorHandler(err, req, reply) {
  if (err.validation) {
    return reply.code(400).send({ error: err.message });
  }
  if (err instanceof PveError) {
    req.log.warn({ status: err.statusCode, msg: err.message }, 'proxmox error');
    // Proxmox 4xx (e.g. bad parameter) pass through; auth problems and 5xx are
    // gateway errors. The message is usually useful ("VM 101 not running") and
    // never contains hosts or tokens.
    const code = err.statusCode >= 400 && err.statusCode < 500 && ![401, 403].includes(err.statusCode)
      ? err.statusCode
      : 502;
    return reply.code(code).send({ error: err.message });
  }
  const code = err.statusCode ?? 500;
  if (code >= 500) req.log.error(err);
  // Errors marked "expose" carry a message written for users, even when 5xx.
  return reply.code(code).send({
    error: code >= 500 && !err.expose ? 'Something went wrong on our side' : err.message,
  });
}

function securityHeaders(app) {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (req.url.startsWith('/branding/')) return payload; // keeps its own sandbox policy
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline widths on meters
      'font-src https://fonts.gstatic.com',
      "frame-ancestors 'none'",
    ].join('; '));
    return payload;
  });
}

// Browser side of passkeys (@simplewebauthn/browser, plain ES modules)
const webauthnBrowser = path.join(root, 'node_modules', '@simplewebauthn', 'browser', 'esm');

// ---- Own icon files (branding folder) ----------------------------------------

/** { windows: '/branding/os-windows.svg', … } for the icon files that exist. */
function osIcons() {
  const found = {};
  try {
    for (const f of fs.readdirSync(brandingDir)) {
      const m = /^os-(windows|linux)\.(svg|png|webp)$/.exec(f);
      if (m && !found[m[1]]) found[m[1]] = `/branding/${f}`;
    }
  } catch { /* no branding folder */ }
  return found;
}

// Created up front, so a logo uploaded later (Settings → Branding) is served without a restart.
try { fs.mkdirSync(brandingDir, { recursive: true }); } catch { /* read-only: only existing files */ }

async function brandingFiles(app) {
  await app.register(fastifyStatic, {
    root: brandingDir,
    prefix: '/branding/',
    decorateReply: false,
    allowedPath: (p) => SERVED_FILE.test(p.replace(/^\//, '')),
    setHeaders: (res) => {
      // Files added by the operator: never allow scripts, even in an SVG opened directly.
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });
}

async function buildServer(name, setup) {
  const app = Fastify({
    logger: { base: { server: name } },
    trustProxy: true, // run behind nginx/Caddy terminating TLS
    bodyLimit: 64 * 1024,
  });
  app.setErrorHandler(errorHandler);
  securityHeaders(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // Public: the sign-in page shows the product name before anyone is signed in.
  app.get('/api/brand', async () => {
    const b = branding();
    return { name: b.name, logo: b.logo, favicon: b.favicon, supportUrl: b.supportUrl || null, osIcons: osIcons(), scheme: currentScheme() };
  });
  // Liveness for Docker/monitoring: the process runs and the database answers.
  app.get('/healthz', { logLevel: 'warn' }, async (req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  await setup(app);
  return app;
}

// ---- Customer panel ---------------------------------------------------------
// Contains no admin routes at all.
const customer = await buildServer('customer', async (app) => {
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  await app.register(authPlugin, { scope: 'customer' });
  await app.register(vmRoutes);
  await app.register(consoleRoutes);
  await app.register(vpnRoutes);
  await app.register(storageRoutes);
  await app.register(supportRoutes);
  await app.register(assistantRoutes);
  await app.register(billingRoutes);
  await app.register(volumeRoutes);
  await app.register(ipRoutes);
  await app.register(customerTokenRoutes);

  await app.register(fastifyStatic, { root: web('customer') });
  await app.register(fastifyStatic, { root: web('shared'), prefix: '/shared/', decorateReply: false });
  await app.register(fastifyStatic, { root: webauthnBrowser, prefix: '/vendor/webauthn/', decorateReply: false });
  if (fs.existsSync(brandingDir)) await brandingFiles(app);
  await app.register(fastifyStatic, {
    root: path.join(root, 'node_modules', '@novnc', 'novnc'),
    prefix: '/novnc/',
    decorateReply: false,
    allowedPath: (p) => p.startsWith('/core/') || p.startsWith('/vendor/'),
  });
});

// ---- Admin interface --------------------------------------------------------
const admin = await buildServer('admin', async (app) => {
  await app.register(authPlugin, { scope: 'admin' });
  await app.register(adminRoutes);

  await app.register(fastifyStatic, { root: web('admin') });
  await app.register(fastifyStatic, { root: web('shared'), prefix: '/shared/', decorateReply: false });
  await app.register(fastifyStatic, { root: webauthnBrowser, prefix: '/vendor/webauthn/', decorateReply: false });
  if (fs.existsSync(brandingDir)) await brandingFiles(app);
});

admin.log.info(`pve-panel ${versionInfo.version}${versionInfo.commit ? ` (${versionInfo.commit.slice(0, 7)})` : ''}, Node ${process.version}`);
bootstrapAdmin(admin.log);
startExpiryScheduler(admin.log);
startUpdateTracker(admin.log);
startZammadRetry(admin.log);
startAutoRenew(admin.log);
startRolloutEngine(admin.log);
startSnapshotSchedules(admin.log);
// a new server on a paid plan that could not be set up: money back to the wallet
onCreateFailed(refundFailedOrder);

await customer.listen({ port: config.port, host: config.host });
await admin.listen({ port: config.adminPort, host: config.adminHost });

setTimeout(() => updateStatus().then((u) => {
  if (u.updateAvailable) admin.log.warn(`A newer version is available: ${u.latest.version} (${u.latest.url})`);
}), 15_000).unref();

// Make sure the VPN gateway matches the database (e.g. after it was rebuilt),
// and every customer server carries the current isolation rules.
syncOnStartup(admin.log);
reapplyIsolation(admin.log).catch((err) => admin.log.warn(`Isolation check failed: ${err.message}`));
syncVnetAliases(admin.log).catch((err) => admin.log.warn(`VNet aliases not updated: ${err.message}`));

// Secure cookies are dropped by browsers on plain http (except localhost).
for (const [portal, url] of Object.entries(config.oidc.enabled ? config.oidc.publicUrl : {})) {
  if (url && config.cookieSecure && /^http:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
    admin.log.warn(`The ${portal} public URL ${url} uses plain http while COOKIE_SECURE=true: browsers will drop `
      + 'the sign-in cookies there. Use https, or set COOKIE_SECURE=false only for testing.');
  }
}

// Stop cleanly on docker stop / Ctrl+C: finish open requests, close the database.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    admin.log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    await Promise.allSettled([customer.close(), admin.close()]);
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}

if (process.env.PANEL_IN_CONTAINER === '1') {
  admin.log.info('Running in a container: the admin interface listens on all interfaces inside it. '
    + 'Publish port 3001 only on 127.0.0.1 of the host (see docker-compose.yml).');
} else if (config.adminHost !== '127.0.0.1' && config.adminHost !== '::1' && config.adminHost !== 'localhost') {
  admin.log.warn(`Admin interface is listening on ${config.adminHost}:${config.adminPort}. `
    + 'Make sure a firewall or VPN restricts who can reach it.');
}
