import crypto from 'node:crypto';
import WebSocket from 'ws';
import { db, audit } from '../db.js';
import { pve, locateGuest, guestPath, connectionOf } from '../pve.js';

const ownedByUser = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?');

// One-time console sessions. A session is created by the POST route and
// consumed by the first websocket connection that presents its id.
const sessions = new Map();
const SESSION_TTL_MS = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
}, 10_000).unref();

export default async function consoleRoutes(app) {
  // Step 1: ask Proxmox for a VNC ticket
  app.post('/api/vms/:vmid/console', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) return reply.code(404).send({ error: 'Server not found' });
    if (row.state !== 'ready') return reply.code(409).send({ error: 'This server is not ready yet' });
    const guest = await locateGuest(vmid);
    if (guest.status !== 'running') {
      return reply.code(409).send({ error: 'Start the server to open its console' });
    }

    const vnc = await pve.post(`${guestPath(guest)}/vncproxy`, { websocket: 1 });
    const id = crypto.randomBytes(24).toString('base64url');
    sessions.set(id, {
      userId: req.account.id,
      guest,
      port: vnc.port,
      ticket: vnc.ticket,
      expires: Date.now() + SESSION_TTL_MS,
    });
    audit(req, vmid, 'console_open');

    // noVNC uses the Proxmox ticket as the VNC password.
    return { session: id, password: vnc.ticket, name: guest.name };
  });

  // Step 2: browser websocket <-> Proxmox vncwebsocket
  app.get('/api/console/:session', {
    websocket: true,
    preHandler: app.authenticate,
  }, (client, req) => {
    const s = sessions.get(req.params.session);
    sessions.delete(req.params.session);

    if (!s || s.userId !== req.account.id || s.expires < Date.now()) {
      client.close(4001, 'Console session expired');
      return;
    }

    // the guest's own cluster (address, token, TLS)
    const conn = connectionOf(s.guest.cluster ?? 0);
    const upstreamUrl = new URL(`${conn.url}${'/api2/json'}${guestPath(s.guest)}/vncwebsocket`);
    upstreamUrl.protocol = upstreamUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    upstreamUrl.searchParams.set('port', String(s.port));
    upstreamUrl.searchParams.set('vncticket', s.ticket);

    const upstream = new WebSocket(upstreamUrl, ['binary'], {
      headers: { Authorization: conn.auth },
      ...conn.tls,
    });
    if (conn.pin) {
      // self-signed cluster: the certificate must be the pinned one
      upstream.on('upgrade', (res) => {
        const got = res.socket.getPeerCertificate?.().fingerprint256?.replace(/:/g, '').toLowerCase();
        if (got !== conn.pin) upstream.terminate();
      });
    }

    // Anything the browser sends before Proxmox is ready is queued.
    const queue = [];
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queue.push([data, isBinary]);
    });

    upstream.on('open', () => {
      for (const [data, isBinary] of queue) upstream.send(data, { binary: isBinary });
      queue.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    };
    upstream.on('close', closeBoth);
    upstream.on('error', (err) => {
      req.log.warn({ err, vmid: s.guest.vmid }, 'console upstream error');
      closeBoth();
    });
    client.on('close', closeBoth);
    client.on('error', closeBoth);
  });
}
