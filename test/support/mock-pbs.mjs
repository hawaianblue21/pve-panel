// Simulated Proxmox Backup Server API for tests: token check, version, datastores
// with usage and GC status, namespaces and the last verify task.
import http from 'node:http';

export const PBS_TOKEN = 'panel@pbs!panel';
export const PBS_SECRET = 'pbs-secret';

export async function startMockPbs() {
  const datastores = new Map([
    ['ds-customer', { total: 96 * 2 ** 40, used: 41.2 * 2 ** 40, avail: 54.8 * 2 ** 40 }],
    ['ds-archive', { total: 240 * 2 ** 40, used: 28 * 2 ** 40, avail: 212 * 2 ** 40 }],
  ]);
  const namespaces = new Set();
  const calls = [];
  const send = (res, data, code = 200, message) => { res.writeHead(code, message || '', { 'content-type': 'application/json' }); res.end(JSON.stringify({ data, message })); };

  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname.replace('/api2/json', '');
      calls.push(`${req.method} ${p}`);
      if (req.headers.authorization !== `PBSAPIToken=${PBS_TOKEN}:${PBS_SECRET}`) return send(res, null, 401, 'authentication failure');
      const b = Object.fromEntries(new URLSearchParams(raw));
      if (p === '/version') return send(res, { version: '4.0.14', release: '4.0', repoid: 'abc' });
      if (p === '/status/datastore-usage') return send(res, [...datastores].map(([store, d]) => ({ store, ...d })));
      const st = p.match(/^\/admin\/datastore\/([\w.-]+)\/(status|namespace)$/);
      if (st) {
        const d = datastores.get(st[1]);
        if (!d) return send(res, null, 404, `no such datastore '${st[1]}'`);
        if (st[2] === 'status') {
          return send(res, { ...d, 'gc-status': { upid: 'UPID:pbs:gc', 'index-data-bytes': 140 * 2 ** 40, 'disk-bytes': 41.2 * 2 ** 40, 'removed-bad': 0, 'last-run-endtime': Math.floor(Date.now() / 1000) - 3600 } });
        }
        if (req.method === 'GET') return send(res, [...namespaces].filter((n) => n.startsWith(`${st[1]}:`)).map((n) => ({ ns: n.split(':')[1] })));
        const full = `${st[1]}:${b.parent ? `${b.parent}/` : ''}${b.name}`;
        if (namespaces.has(full)) return send(res, null, 400, `namespace '${b.name}' already exists`);
        if (b.parent && !namespaces.has(`${st[1]}:${b.parent}`)) return send(res, null, 400, `parent namespace '${b.parent}' does not exist`);
        namespaces.add(full);
        return send(res, null);
      }
      if (p === '/nodes/localhost/tasks') {
        return send(res, [{ upid: 'UPID:pbs:verify', worker_type: 'verificationjob', status: 'OK', starttime: Math.floor(Date.now() / 1000) - 7200, endtime: Math.floor(Date.now() / 1000) - 5400 }]);
      }
      return send(res, null, 501, `not simulated: ${req.method} ${p}`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`, datastores, namespaces, calls,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  };
}
