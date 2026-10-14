// Starts a complete, isolated test environment:
//   simulated Proxmox (mock-pve.mjs) + optional SMTP capture + the real panel
//   (src/server.js) as a child process, on free ports with a temporary database.
// Each test file gets its own stack, so files can run in parallel.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockPve } from './mock-pve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Polls fn() until it returns a truthy value (or throws after `timeout`). */
export async function waitFor(fn, { timeout = 30_000, interval = 300, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
}

// ---- HTTP session with a cookie jar ---------------------------------------------

export class Session {
  constructor(base) { this.base = base; this.cookies = new Map(); }

  async req(method, p, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const [k, ...v] = pair.split('=');
      const expired = attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim())) || v.join('=') === '';
      if (expired) this.cookies.delete(k.trim()); else this.cookies.set(k.trim(), v.join('='));
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}

// ---- TOTP (independent implementation, RFC 6238) ----------------------------------

export function totp(keyBase32, offsetSteps = 0, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of keyBase32.replace(/\s/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000) + offsetSteps));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// ---- SMTP capture ---------------------------------------------------------------

async function startMailCapture() {
  const { SMTPServer } = await import('smtp-server');
  const { simpleParser } = await import('mailparser');
  const messages = [];
  const server = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) {
      if (auth.username === 'panel' && auth.password === 'mail-secret') return cb(null, { user: 'panel' });
      return cb(new Error('535 Authentication failed'));
    },
    onData(stream, session, cb) {
      simpleParser(stream).then((m) => {
        messages.push({ to: m.to?.text, from: m.from?.text, subject: m.subject, text: m.text, html: m.html });
        cb();
      }).catch(cb);
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.server.address().port, messages, close: () => new Promise((r) => server.close(r)) };
}

// ---- The stack ------------------------------------------------------------------

export async function startStack({ env = {}, mail = false } = {}) {
  const mock = await startMockPve();
  const smtp = mail ? await startMailCapture() : null;
  const [port, adminPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-panel-test-'));

  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? dir,
    DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),   // never read a developer's .env
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-test-secret-test-secret',
    COOKIE_SECURE: 'false',
    DB_PATH: path.join(dir, 'panel.db'),
    PVE_URL: mock.url,
    PVE_TOKEN_ID: 'panel@pve!panel',
    PVE_TOKEN_SECRET: 'x',
    HOST: '127.0.0.1',
    PORT: String(port),
    ADMIN_HOST: '127.0.0.1',
    ADMIN_PORT: String(adminPort),
    CUSTOMER_NETWORKS: 'true',
    VPN_ENABLED: 'true',
    VPN_GATEWAY_VMID: '150',
    VPN_ENDPOINT: 'vpn.example.com:51820',
    TAILSCALE_ENABLED: 'true',
    INITIAL_ADMIN_EMAIL: ADMIN.email,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    UPDATE_CHECK: 'false',
    AGENT_UNRESPONSIVE_SECONDS: '15',
    // {CUSTOMER_URL} / {ADMIN_URL} in values: the addresses this stack listens on
    ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)
      .replaceAll('{CUSTOMER_URL}', `http://127.0.0.1:${port}`).replaceAll('{ADMIN_URL}', `http://127.0.0.1:${adminPort}`)])),
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (d) => output.push(d.toString()));
  child.stderr.on('data', (d) => output.push(d.toString()));
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const customerUrl = `http://127.0.0.1:${port}`;
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  try {
    await waitFor(async () => {
      if (exited !== null) throw new Error(`panel exited with code ${exited}:\n${output.join('').slice(-3000)}`);
      try { return (await fetch(`${customerUrl}/healthz`)).ok && (await fetch(`${adminUrl}/healthz`)).ok; } catch { return false; }
    }, { timeout: 20_000, what: 'the panel to start' });
  } catch (err) {
    child.kill('SIGKILL');
    await mock.close();
    await smtp?.close();
    throw err;
  }

  const stack = {
    mock, smtp, customerUrl, adminUrl, dir,
    logs: () => output.join(''),
    customer: () => new Session(customerUrl),
    admin: () => new Session(adminUrl),

    async adminSession() {
      const s = stack.admin();
      const r = await s.post('/api/auth/login', ADMIN);
      if (r.status !== 200) throw new Error(`admin sign-in failed: ${r.status} ${r.text}`);
      return s;
    },

    /** Creates a customer (optionally with self-service limits) and returns a signed-in session. */
    async customerWith(email, { password = 'another-long-password', limits = null } = {}) {
      const a = await stack.adminSession();
      const r = await a.post('/api/admin/users', { email, password });
      if (r.status !== 201) throw new Error(`creating ${email} failed: ${r.status} ${r.text}`);
      if (limits) {
        await a.patch(`/api/admin/users/${r.json.id}`, {
          canCreate: true, maxServers: 5, maxCores: 16, maxMemoryMb: 32768, maxDiskGb: 400, ...limits,
        });
      }
      const s = stack.customer();
      const l = await s.post('/api/auth/login', { email, password });
      if (l.status !== 200) throw new Error(`sign-in ${email} failed: ${l.status} ${l.text}`);
      s.userId = r.json.id;
      return s;
    },

    /** Offers the mock's templates (Debian 9000, Windows 9100). */
    async offerTemplates() {
      const a = await stack.adminSession();
      await a.put('/api/admin/templates/9000', { label: 'Debian 12' });
      await a.put('/api/admin/templates/9100', { label: 'Windows Server 2022', setup: 'windows' });
    },

    /** Waits until the guest agent in a (mock) VM answers. */
    async agentReady(vmid, timeout = 20_000) {
      return waitFor(async () => (await fetch(`${mock.url}/api2/json/nodes/pve1/qemu/${vmid}/agent/ping`, {
        method: 'POST', headers: { authorization: 'PVEAPIToken=panel@pve!panel=x' },
      })).ok, { timeout, interval: 400, what: `guest agent of ${vmid}` });
    },

    /** Waits until a server of this customer leaves the "creating" state. */
    async serverSettled(session, vmid, timeout = 90_000) {
      return waitFor(async () => {
        const v = (await session.get('/api/vms')).json?.find((x) => x.vmid === vmid);
        return v && v.state !== 'creating' ? v : null;
      }, { timeout, interval: 500, what: `server ${vmid} to finish` });
    },

    async stop() {
      if (exited === null) {
        child.kill('SIGTERM');
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
        if (exited === null) child.kill('SIGKILL');
      }
      await mock.close();
      await smtp?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return stack;
}
