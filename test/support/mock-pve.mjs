// Simulated Proxmox VE API for tests: VMs, templates, clones, tasks, SDN,
// firewall, snapshots, guest agent (incl. Windows setup and Tailscale), the
// WireGuard gateway VM and a VNC endpoint. Every call to startMockPve() has its
// own fresh state and listens on a free port.
//
// Test controls (plain HTTP GET on the mock, under /api2/json):
//   /__flaky/<vmid>/<n>          next n guest-exec-status answers time out
//   /__lose/<vmid>/<n>[/<text>]  lose n finished exec results ("PID lld does not exist")
//   /__tsapprove/<vmid>          approve the Tailscale subnet route
//   /__tsowner/<vmid>            Tailscale logout refused (Windows profile owner)
//   /__recovery/<vmid>           a Recovery partition blocks extending C:
//   /__lu/<vmid>/<scenario>      Linux updates: normal | uptodate | kernel | nopm | lowdisk | error | dnf
//   /__failclone/<n>             the next n clones end with an error
//   /__node/<vmid>/<node>        move a VM to another node (block storage tests)
//   /__nodestate/<node>/<online|offline>   a node goes away or comes back
//   /cluster/resources?type=node|storage|vm, /cluster/status, /nodes/<node>/status
//   /__sdn, /__vms, /__gw        inspect state
import http from 'node:http';
import { WebSocketServer } from 'ws';

const debug = process.env.MOCK_PVE_DEBUG === '1';
// Debug output: values from requests are flattened to one line, so they can't fake log lines.
const oneLine = (v) => {
  const text = typeof v === 'string' ? v : v instanceof Error ? (v.stack || v.message) : JSON.stringify(v) ?? String(v);
  return String(text).replace(/[\r\n\u2028\u2029]+/g, ' ');
};
const log = (...a) => { if (debug) console.log('[mock-pve]', ...a.map(oneLine)); };

/**
 * second: a second, separate cluster for multi-cluster tests (node pve3, VM 201,
 * template 9200, and VM 102 again so the panel sees a VMID collision).
 */
export async function startMockPve({ port = 0, second = false } = {}) {
  const vms = new Map([
    [101, { vmid:101, node:'pve1', type:'qemu', name:'web01', status:'stopped', maxcpu:2, maxmem:4*2**30, maxdisk:20*2**30, cfg:{cores:2,memory:4096,ostype:'l26',scsi0:'VMStorage:vm-101-disk-0,size=20G'} }],
    [102, { vmid:102, node:'pve1', type:'qemu', name:'other-customer', status:'running', maxcpu:2, maxmem:2*2**30, maxdisk:10*2**30, cfg:{cores:2,memory:2048} }],
    [9000,{ vmid:9000,node:'pve1', type:'qemu', name:'debian12-cloud', status:'stopped', template:1, maxcpu:1, maxmem:2**30, maxdisk:3*2**30, cfg:{cores:1,memory:1024,ostype:'l26',agent:'1',boot:'order=scsi0',scsi0:'VMStorage:base-9000-disk-0,size=3G',ide2:'VMStorage:vm-9000-cloudinit,media=cdrom',ciuser:'debian'} }],
    [9100,{ vmid:9100,node:'pve1', type:'qemu', name:'win2022-sysprep', status:'stopped', template:1, maxcpu:2, maxmem:4*2**30, maxdisk:40*2**30, cfg:{cores:2,memory:4096,ostype:'win11',agent:'1',boot:'order=scsi0',scsi0:'VMStorage:base-9100-disk-0,size=40G',net0:'e1000=BC:24:11:00:00:01,bridge=vmbr0'} }],
    [9101,{ vmid:9101,node:'pve1', type:'qemu', name:'win2022-bad-unattend', status:'stopped', template:1, maxcpu:2, maxmem:4*2**30, maxdisk:40*2**30, cfg:{cores:2,memory:4096,ostype:'win11',agent:'1',scsi0:'VMStorage:base-9101-disk-0,size=40G',net0:'e1000=BC:24:11:00:00:02,bridge=vmbr0'} }],
    [9102,{ vmid:9102,node:'pve1', type:'qemu', name:'win2022-locked-down', status:'stopped', template:1, maxcpu:2, maxmem:4*2**30, maxdisk:40*2**30, cfg:{cores:2,memory:4096,ostype:'win11',agent:'1',scsi0:'VMStorage:base-9102-disk-0,size=40G',net0:'virtio=BC:24:11:00:00:03,bridge=vmbr0'} }],
    [150, { vmid:150, node:'pve1', type:'qemu', name:'vpn-gw', status:'running', maxcpu:1, maxmem:2**29, maxdisk:8*2**30, cfg:{cores:1,memory:512,agent:'1'} }],
    [9001,{ vmid:9001,node:'pve1', type:'qemu', name:'ubuntu2404-cloud', status:'stopped', template:1, maxcpu:1, maxmem:2**30, maxdisk:4*2**30, cfg:{cores:1,memory:1024,ostype:'l26',scsi0:'VMStorage:base-9001-disk-0,size=3584M'} }],
  ]);
  if (second) {
    vms.clear();
    vms.set(201, { vmid:201, node:'pve3', type:'qemu', name:'remote-web', status:'stopped', maxcpu:2, maxmem:2*2**30, maxdisk:10*2**30, cfg:{cores:2,memory:2048,ostype:'l26',scsi0:'Ceph:vm-201-disk-0,size=10G'} });
    vms.set(102, { vmid:102, node:'pve3', type:'qemu', name:'clash', status:'stopped', maxcpu:1, maxmem:2**30, maxdisk:5*2**30, cfg:{cores:1,memory:1024} });
    vms.set(9200, { vmid:9200, node:'pve3', type:'qemu', name:'debian12-remote', status:'stopped', template:1, maxcpu:1, maxmem:2**30, maxdisk:3*2**30,
      cfg:{cores:1,memory:1024,ostype:'l26',agent:'1',boot:'order=scsi0',scsi0:'Ceph:base-9200-disk-0,size=3G',ide2:'Ceph:vm-9200-cloudinit,media=cdrom',ciuser:'debian'} });
  }
  // Proxmox nodes of the simulated cluster (pve2 has no guests unless a test moves one there)
  const hosts = second ? new Map([
    ['pve3', { node: 'pve3', status: 'online', cpu: 0.12, maxcpu: 48, mem: 40 * 2 ** 30, maxmem: 192 * 2 ** 30, uptime: 86_400,
      storages: [{ storage: 'Ceph', disk: 1 * 2 ** 40, maxdisk: 10 * 2 ** 40, shared: 1 }] }],
  ]) : new Map([
    ['pve1', { node: 'pve1', status: 'online', cpu: 0.18, maxcpu: 64, mem: 96 * 2 ** 30, maxmem: 256 * 2 ** 30, uptime: 3_542_400,
      storages: [{ storage: 'VMStorage', disk: 2.1 * 2 ** 40, maxdisk: 7.6 * 2 ** 40 }, { storage: 'local-lvm', disk: 40 * 2 ** 30, maxdisk: 400 * 2 ** 30 }] }],
    ['pve2', { node: 'pve2', status: 'online', cpu: 0.71, maxcpu: 32, mem: 230 * 2 ** 30, maxmem: 256 * 2 ** 30, uptime: 1_036_800,
      storages: [{ storage: 'VMStorage', disk: 6.9 * 2 ** 40, maxdisk: 7.6 * 2 ** 40 }] }],
  ]);
  const tasks = new Map(); let seq = 0;
  const sdn = { zones: [], vnets: [], subnets: new Map(), pending: 0 };
  const started = new Map([[150, 0]]); const gwFiles = new Map(); const GW_PUB = 'Qm9ndXNHYXRld2F5UHVibGljS2V5MTIzNDU2Nzg5MDA='; const execs = new Map(); let pidSeq = 100;
  let failClones = 0;
  const task = (kind, vmid, ms=1500, then=()=>{}, exit=undefined) => { const upid=`UPID:${[...hosts.keys()][0]}:${(++seq).toString(16)}:0:${Date.now()}:${kind}:${vmid}:panel@pve!panel:`; tasks.set(upid, {done:Date.now()+ms, then, fired:true, exit}); setTimeout(then, ms); return upid; };
  const send = (res, data, code=200, msg) => { res.writeHead(code, msg || '', {'content-type':'application/json'}); res.end(JSON.stringify({data, message: msg})); };
  const body = (req) => new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(Object.fromEntries(new URLSearchParams(b)))); });
  const destroyed = []; // DELETE calls, for assertions
  const clones = [];    // clone requests (with target node / storage), for assertions
  const gpuMappings = [
    { id: 'rtx4090', description: 'GeForce RTX 4090', mdev: 0, map: [
      'node=pve1,path=0000:01:00.0,id=10de:2684,iommugroup=14', 'node=pve1,path=0000:02:00.0,id=10de:2684,iommugroup=15'] },
    { id: 'a16', description: 'NVIDIA A16 (vGPU)', mdev: 1, map: ['node=pve1,path=0000:41:00.0,id=10de:25b6,iommugroup=30'] },
  ];
  const pciDevices = [
    { id: '0000:01:00.0', class: '0x030000', vendor: '0x10de', vendor_name: 'NVIDIA Corporation', device_name: 'AD102 [GeForce RTX 4090]', iommugroup: 14, mdev: false },
    { id: '0000:02:00.0', class: '0x030000', vendor: '0x10de', vendor_name: 'NVIDIA Corporation', device_name: 'AD102 [GeForce RTX 4090]', iommugroup: 15, mdev: false },
    { id: '0000:41:00.0', class: '0x030200', vendor: '0x10de', vendor_name: 'NVIDIA Corporation', device_name: 'GA107GL [A16]', iommugroup: 30, mdev: true },
    { id: '0000:00:1f.3', class: '0x040300', vendor: '0x8086', vendor_name: 'Intel Corporation', device_name: 'Audio', iommugroup: 9, mdev: false },
  ];

  const tsApproved = new Set();

  const newMac = () => 'BC:24:11:' + Array.from({ length: 3 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const withMac = (net) => (!net || /^\w+=[0-9A-Fa-f:]{17}/.test(net) ? net : net.replace(/^(\w+)/, `$1=${newMac()}`));
  // Extra disks (block storage volumes): allocate "STORAGE:SIZE", detach to unusedN,
  // reattach an unused volume, destroy unusedN; sizes are remembered per volume.
  const DISK = /^(scsi|virtio|sata|ide)\d+$/;
  const volSizes = new Map();
  const counters = new Map();
  const diskSeq = { next: (id) => { const n = (counters.get(id) ?? 0) + 1; counters.set(id, n); return n; } };
  const volidOf = (v) => String(v).split(',')[0];
  const sizeOf = (v) => /size=([^,]+)/.exec(String(v))?.[1];
  function diskDelete(vm, k) {
    const v = vm.cfg[k];
    if (v === undefined) return;
    delete vm.cfg[k];
    if (/^unused\d+$/.test(k)) { volSizes.delete(volidOf(v)); vm.owned?.delete(volidOf(v)); return; }       // destroyed
    if (DISK.test(k) && !/media=cdrom|cloudinit/.test(v)) {
      let i = 0; while (vm.cfg[`unused${i}`]) i += 1;
      if (sizeOf(v)) volSizes.set(volidOf(v), sizeOf(v));
      vm.cfg[`unused${i}`] = volidOf(v);
    }
  }
  function diskAssign(vm, b) {
    for (const [k, v] of Object.entries(b)) {
      if (!DISK.test(k) || typeof v !== 'string') continue;
      const alloc = /^([\w.-]+):(\d+)(,.*)?$/.exec(v);
      if (alloc) { b[k] = `${alloc[1]}:vm-${vm.vmid}-disk-${diskSeq.next(vm.vmid) + 10},size=${alloc[2]}G${alloc[3] ?? ''}`; (vm.owned ??= new Map()).set(volidOf(b[k]), sizeOf(b[k])); continue; }
      const unused = Object.keys(vm.cfg).find((x) => /^unused\d+$/.test(x) && vm.cfg[x] === volidOf(v));
      if (unused) { delete vm.cfg[unused]; b[k] = sizeOf(v) ? v : `${v},size=${volSizes.get(volidOf(v)) ?? '1G'}`; }
    }
  }
  const flaky = new Map();
  const lose = new Map(); const loseOnly = new Map();   // vmid -> number of finished results to 'lose' like a real agent
  function tailscaleExec(vm, vmid, script, stdin) {
    // returns { out, code, err } or null if the script isn't a Tailscale command
    if (script.includes('install.sh') || script.includes('tailscale-setup-latest')) { log('TS install', vmid); return { out: 'installed\n', code: 0, err: '' }; }
    if (/cat > \/run\/ts-authkey-/.test(script)) { vm.tsKey = stdin; return { out: '', code: 0, err: '' }; }
    if (script.includes('tailscale up') || script.includes(' up --unattended')) {
      const key = script.includes('--unattended') ? stdin : vm.tsKey;
      const onCmdLine = key && script.includes(key);
      log('TS up', vmid, 'key on command line:', onCmdLine ? 'YES!' : 'no', '| key file present:', !!key);
      if (!key || key.startsWith('tskey-auth-bad')) return { out: '', code: 1, err: 'backend error: invalid key: API key does not exist\n' };
      const host = /--hostname=([a-z0-9-]+)/.exec(script)?.[1];
      const routes = /--advertise-routes=(\S+)/.exec(script)?.[1] ?? null;
      vm.ts = { ip: `100.101.102.${vmid % 250}`, host, routes };
      vm.tsKey = undefined;
      return { out: script.includes('--unattended') ? 'connected\n' : '', code: 0, err: '' };
    }
    if (script.includes('status --json')) {
      if (!vm.ts) return { out: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), code: 0, err: '' };
      return { out: JSON.stringify({ BackendState: 'Running', Self: { Online: true, HostName: vm.ts.host,
        DNSName: `${vm.ts.host}.tail1234.ts.net.`, TailscaleIPs: [vm.ts.ip, 'fd7a:115c:a1e0::1'],
        PrimaryRoutes: vm.ts.routes && tsApproved.has(vmid) ? [vm.ts.routes] : undefined } }), code: 0, err: '' };
    }
    if (script.includes('logout')) {
      const hasFallback = script.includes('Stop-Service') || script.includes('systemctl stop tailscaled');
      if (vm.tsForeign) {
        if (!hasFallback) return { out: '', code: 1, err: '500 Internal Server Error: the target profile does not belong to the user\n' };
        log('TS logout refused, local state wiped', vmid); vm.ts = undefined; vm.tsForeign = false;
        return { out: 'forgotten: 500 Internal Server Error: the target profile does not belong to the user\n', code: 0, err: '' };
      }
      log('TS logout', vmid); vm.ts = undefined;
      return { out: hasFallback ? 'logged-out\n' : '', code: 0, err: '' };
    }
    return null;
  }

  // ---- Simulated Windows Update (PVE Panel's update task) ----------------------------
  // vm.wuScenario: 'normal' (round 1: 3 updates + restart, round 2: 1 update, then
  // up to date), 'uptodate', 'error' (update server unreachable), 'lowdisk', 'disabled'
  const WU_ROUNDS = [
    [{ kb: 'KB5044284', title: '2026-10 Cumulative Update for Microsoft server operating system (KB5044284)', reboot: true },
     { kb: 'KB5044029', title: '2026-10 Cumulative Update for .NET Framework (KB5044029)', reboot: false },
     { kb: 'KB2267602', title: 'Security Intelligence Update for Microsoft Defender Antivirus (KB2267602)', reboot: false }],
    [{ kb: 'KB5044099', title: '2026-10 Servicing Stack Update (KB5044099)', reboot: false }],
  ];
  // Seconds since the guest was (re)started; 600 for guests the tests didn't start
  const uptimeOf = (vmid) => (started.has(vmid) ? Math.max(1, Math.floor((Date.now() - started.get(vmid)) / 1000)) : 600);

  // Linux package updates (src/guest/linux-update.sh), simulated per VM: vm.lu
  const LU_PACKAGES = [
    { kb: 'openssl', title: '3.0.13-0ubuntu3.3 → 3.0.13-0ubuntu3.4', security: true },
    { kb: 'libssl3t64', title: '3.0.13-0ubuntu3.3 → 3.0.13-0ubuntu3.4', security: true },
    { kb: 'linux-image-6.8.0-48-generic', title: '6.8.0-48.48', security: true, kernel: true },
    { kb: 'nginx', title: '1.24.0-2ubuntu7 → 1.24.0-2ubuntu7.1', security: false },
  ];
  const LU_STEP = 300;
  function luStatus(vm) {
    const l = vm.lu; const t = Date.now() - l.at;
    const base = { runId: l.runId, total: 0, current: 0, installed: [], failed: [], rebootRequired: false, manager: l.pm, error: null };
    if (t < LU_STEP) return JSON.stringify({ ...base, state: 'searching', message: 'Refreshing the package lists' });
    if (l.scenario === 'error') return JSON.stringify({ ...base, state: 'failed', message: 'Package update failed', error: 'apt-get update failed: Temporary failure resolving archive.ubuntu.com' });
    const list = l.scenario === 'uptodate' ? [] : LU_PACKAGES.filter((x) => l.scope === 'all' || x.security)
      .filter((x) => l.scenario === 'kernel' || !x.kernel);
    if (!list.length) return JSON.stringify({ ...base, state: 'done', message: 'The server is up to date' });
    const n = Math.min(list.length, Math.floor((t - LU_STEP) / LU_STEP));
    const items = list.map(({ kb, title }) => ({ kb, title }));
    if (n < list.length) return JSON.stringify({ ...base, state: 'installing', total: list.length, current: n, message: `Installing ${n} of ${list.length} packages`, installed: items });
    const reboot = list.some((x) => x.kernel);
    if (reboot && l.auto && !l.rebooted) { l.rebooted = true; started.set(vm.vmid, Date.now() + 1000); }
    return JSON.stringify({ ...base, state: 'done', total: list.length, current: list.length, installed: items, rebootRequired: reboot,
      message: reboot ? (l.auto ? 'Updates installed. Restarting in 1 minute to load the new kernel' : 'Updates installed. Restart the server to finish (new kernel or system libraries)') : 'Updates installed' });
  }

  const WU_STEP = 300;
  function wuStatus(vm, vmid) {
    const w = vm.wu; const now = Date.now();
    const rounds = w.scenario === 'uptodate' ? [] : WU_ROUNDS;
    for (let guard = 0; guard < 50; guard += 1) {
      const t = now - w.stageAt;
      if (w.stage === 'searching') {
        if (t < WU_STEP) break;
        if (w.scenario === 'error') { w.state = 'failed'; w.error = 'Exception from HRESULT: 0x8024402C (0x8024402C)'; w.stage = 'final'; break; }
        const list = rounds[w.round - 1] ?? [];
        if (!list.length) { w.state = 'done'; w.message = 'Windows is up to date'; w.stage = 'final'; break; }
        w.list = list; w.stage = 'downloading'; w.stageAt += WU_STEP; continue;
      }
      if (w.stage === 'downloading' || w.stage === 'installing') {
        const span = w.list.length * WU_STEP;
        w.current = Math.min(w.list.length, Math.floor(t / WU_STEP) + 1);
        if (t < span) break;
        if (w.stage === 'downloading') { w.stage = 'installing'; w.stageAt += span; continue; }
        w.installed.push(...w.list.map(({ kb, title }) => ({ kb, title, code: 2, hresult: '0x00000000' })));
        const reboot = w.list.some((u) => u.reboot);
        w.round += 1; w.stageAt += span;
        if (reboot && w.config.autoRestart) { w.stage = 'restarting'; started.set(vmid, now); log('WU restart', vmid); continue; }
        if (reboot) { w.stage = 'restart-required'; break; }
        w.stage = 'searching'; continue;
      }
      if (w.stage === 'restarting') { if (t < 1500) break; w.stage = 'searching'; w.stageAt += 1500; continue; }
      break; // restart-required (waits for a power restart) or final
    }
    const state = w.stage === 'final' ? w.state : w.stage;
    const msg = { searching: `Searching for updates (round ${w.round})`, downloading: `Downloading ${w.current} of ${w.list?.length}`,
      installing: `Installing ${w.current} of ${w.list?.length}`, restarting: 'Restarting to finish the updates',
      'restart-required': 'Restart the server to finish the updates' }[state] ?? w.message ?? '';
    // PowerShell 5.1 writes a BOM: the panel must cope with it
    return '\uFEFF' + JSON.stringify({ runId: w.config.runId, state, round: w.round, total: w.list?.length ?? 0, current: w.current ?? 0,
      installed: w.installed, failed: [], message: msg, error: w.error ?? null, updatedAt: new Date().toISOString() });
  }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace('/api2/json','');
    if (req.headers.authorization !== 'PVEAPIToken=panel@pve!panel=x') return send(res, null, 401);
    { const ns = p.match(/^\/__nodestate\/([\w-]+)\/(online|offline)$/); if (ns) { hosts.get(ns[1]).status = ns[2]; return send(res, null); } }
    if (p === '/cluster/resources') {
      const type = u.searchParams.get('type');
      const guests = [...vms.values()].map(({cfg, ...v}) => ({...v, id:`qemu/${v.vmid}`, cpu:0.05, mem:v.maxmem/4, uptime: v.status==='running' ? uptimeOf(v.vmid) : 0}));
      const nodeRows = [...hosts.values()].map((h) => ({ id: `node/${h.node}`, type: 'node', node: h.node, status: h.status,
        ...(h.status === 'online' ? { cpu: h.cpu, maxcpu: h.maxcpu, mem: h.mem, maxmem: h.maxmem, disk: 9 * 2 ** 30, maxdisk: 100 * 2 ** 30, uptime: h.uptime } : {}) }));
      const storageRows = [...hosts.values()].flatMap((h) => h.storages.map((st) => ({ id: `storage/${h.node}/${st.storage}`, type: 'storage', node: h.node, storage: st.storage,
        status: h.status === 'online' ? 'available' : 'unknown', disk: st.disk, maxdisk: st.maxdisk, shared: st.shared ?? 0, content: 'images,rootdir' })));
      if (type === 'node') return send(res, nodeRows);
      if (type === 'storage') return send(res, storageRows);
      if (type === 'vm') return send(res, guests);
      return send(res, [...guests, ...nodeRows, ...storageRows]);
    }
    if (p === '/cluster/status') return send(res, [{ type: 'cluster', id: 'cluster', name: 'mock-cluster', quorate: [...hosts.values()].filter((h) => h.status === 'online').length * 2 > hosts.size ? 1 : 0, nodes: hosts.size, version: 7 },
      ...[...hosts.values()].map((h, i) => ({ type: 'node', id: `node/${h.node}`, name: h.node, nodeid: i + 1, online: h.status === 'online' ? 1 : 0, ip: `10.0.0.${11 + i}`, local: i === 0 ? 1 : 0 }))]);
    { const nm = p.match(/^\/nodes\/([\w-]+)\/status$/); if (nm && hosts.has(nm[1])) { const h = hosts.get(nm[1]);
      if (h.status !== 'online') return send(res, null, 595, `no route to host ${h.node}`);
      return send(res, { pveversion: 'pve-manager/9.0.10/abcdef0123456789', kversion: 'Linux 6.14.8-2-pve #1 SMP PREEMPT_DYNAMIC PMX 6.14.8-2', uptime: h.uptime,
        cpu: h.cpu, loadavg: ['0.42', '0.51', '0.60'], cpuinfo: { cpus: h.maxcpu, model: 'AMD EPYC 9354 32-Core Processor', sockets: 1 },
        memory: { used: h.mem, total: h.maxmem, free: h.maxmem - h.mem }, rootfs: { used: 9 * 2 ** 30, total: 100 * 2 ** 30 } }); } }
    if (p === '/__gw') return send(res, Object.fromEntries(gwFiles));
    { const nm = p.match(/^\/__node\/(\d+)\/([\w-]+)$/); if (nm) { vms.get(Number(nm[1])).node = nm[2]; return send(res, null); } }
    if (p === '/__sdn') return send(res, { ...sdn, subnets: Object.fromEntries(sdn.subnets) });
    if (p.startsWith('/__tsowner/')) { vms.get(Number(p.split('/')[2])).tsForeign = true; return send(res, 'ok'); }
    if (p.startsWith('/__lose/')) { const [, , v, n, only] = p.split('/'); lose.set(Number(v), Number(n)); loseOnly.set(Number(v), only ? decodeURIComponent(only) : null); return send(res, 'ok'); }
    if (p.startsWith('/__lu/')) { const [, , v, scen] = p.split('/'); vms.get(Number(v)).luScenario = scen; return send(res, 'ok'); }
    if (p.startsWith('/__wu/')) { const [, , v, scen] = p.split('/'); vms.get(Number(v)).wuScenario = scen; return send(res, 'ok'); }
  if (p.startsWith('/__recovery/')) { vms.get(Number(p.split('/')[2])).recoveryAfterC = true; return send(res, 'ok'); }
    if (p.startsWith('/__flaky/')) { const [, , v, n] = p.split('/'); flaky.set(Number(v), Number(n)); return send(res, 'ok'); }
    if (p.startsWith('/__tsapprove/')) { tsApproved.add(Number(p.split('/')[2])); return send(res, 'approved'); }
    if (p.startsWith('/__failclone/')) { failClones = Number(p.split('/')[2]); return send(res, 'ok'); }
    if (p === '/__vms') return send(res, [...vms.keys()]);
    if (p.startsWith('/__clearfw/')) { const v = vms.get(Number(p.split('/')[2])); v.fwRules = (v.fwRules ?? []).filter(r => r.type !== 'out'); return send(res, 'cleared'); }
    if (p === '/nodes') return send(res, [...hosts.values()].map((h) => ({ node: h.node, status: h.status })));
    if (p === '/version') return send(res, { version: '9.0.10', release: '9.0', repoid: 'abcdef01' });
    if (p === '/cluster/nextid') { const want = u.searchParams.get('vmid'); if (want) return vms.has(Number(want)) ? send(res,null,400,`VM ${want} already exists`) : send(res, want); let id=100; while (vms.has(id)) id++; return send(res, String(id)); }
    if (/^\/nodes\/[^/]+\/storage$/.test(p)) return send(res, [{storage:'VMStorage'},{storage:'local-lvm'}]);
    if (p === '/cluster/sdn/zones' && req.method==='GET') return send(res, sdn.zones);
    if (p === '/cluster/sdn/zones' && req.method==='POST') { const b = await body(req); log('SDN ZONE', JSON.stringify(b)); sdn.zones.push({zone:b.zone,type:b.type}); sdn.pending++; return send(res,null); }
    if (p === '/cluster/sdn/vnets' && req.method==='GET') return send(res, sdn.vnets);
    if (p === '/cluster/sdn/vnets' && req.method==='POST') { const b = await body(req); log('SDN VNET', JSON.stringify(b)); sdn.vnets.push({vnet:b.vnet,zone:b.zone,alias:b.alias}); sdn.subnets.set(b.vnet, []); sdn.pending++; return send(res,null); }
    const sn = p.match(/^\/cluster\/sdn\/vnets\/([^/]+)\/subnets$/);
    if (sn && req.method==='GET') return send(res, sdn.subnets.get(sn[1]) ?? []);
    if (sn && req.method==='POST') { const b = await body(req); log('SDN SUBNET', sn[1], JSON.stringify(b)); sdn.subnets.get(sn[1]).push({cidr:b.subnet, subnet:`panel-${b.subnet.replace('/','-')}`}); sdn.pending++; return send(res,null); }
    const vn = p.match(/^\/cluster\/sdn\/vnets\/([^/]+)$/);
    if (vn && req.method==='PUT') { const b = await body(req); const v = sdn.vnets.find(x=>x.vnet===vn[1]); if (!v) return send(res,null,404); v.alias = b.alias; log('SDN VNET ALIAS', vn[1], JSON.stringify(b.alias)); sdn.pending++; return send(res,null); }
    if (vn && req.method==='DELETE') { if ((sdn.subnets.get(vn[1]) ?? []).length) return send(res,null,500,'cannot delete vnet with subnets'); const inUse=[...vms.values()].some(x=>(x.cfg.net0??'').includes('bridge='+vn[1]+',')||(x.cfg.net0??'').endsWith('bridge='+vn[1])); if (inUse) return send(res,null,500,`vnet ${vn[1]} is used by a guest`); sdn.vnets=sdn.vnets.filter(x=>x.vnet!==vn[1]); log('SDN VNET DELETE', vn[1]); sdn.pending++; return send(res,null); }
    const snd = p.match(/^\/cluster\/sdn\/vnets\/([^/]+)\/subnets\/(.+)$/);
    if (snd && req.method==='DELETE') { const id = decodeURIComponent(snd[2]); sdn.subnets.set(snd[1], (sdn.subnets.get(snd[1]) ?? []).filter(x=>x.subnet!==id)); log('SDN SUBNET DELETE', snd[1], id); sdn.pending++; return send(res,null); }
    if (p === '/cluster/sdn' && req.method==='PUT') { log('SDN APPLY pending', sdn.pending); sdn.pending=0; return send(res, task('reloadnetworkall', 0, 800)); }
    const t = p.match(/\/tasks\/(.+)\/status$/);
    if (t) { const x = tasks.get(decodeURIComponent(t[1])); if (!x) return send(res,null,404);
      if (Date.now() > x.done) { if (!x.fired) { x.fired=true; x.then(); } return send(res,{status:'stopped',exitstatus:x.exit||'OK'}); } return send(res,{status:'running'}); }
    // GPUs: PCI resource mappings, the node's PCI devices and mediated device types
    if (p === '/cluster/mapping/pci') return send(res, gpuMappings);
    if (/^\/nodes\/[^/]+\/hardware\/pci$/.test(p)) return send(res, pciDevices);
    const md = p.match(/^\/nodes\/[^/]+\/hardware\/pci\/([^/]+)\/mdev$/);
    if (md) {
      const dev = decodeURIComponent(md[1]);
      if (!pciDevices.some((d) => d.id === dev && d.mdev)) return send(res, null, 500, `device ${dev} does not support mediated devices`);
      const used = [...vms.values()].filter((v) => Object.entries(v.cfg).some(([k, val]) => /^hostpci\d+$/.test(k) && String(val).includes('mdev=nvidia-660'))).length;
      return send(res, [
        { type: 'nvidia-660', name: 'NVIDIA A16-4Q', description: 'num_heads=4, frl_config=60, framebuffer=4096M', available: Math.max(0, 4 - used) },
        { type: 'nvidia-661', name: 'NVIDIA A16-8Q', description: 'num_heads=4, frl_config=60, framebuffer=8192M', available: 2 },
      ]);
    }
    const m = p.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)(\/.*)?$/);
    if (!m) return send(res, null, 501);
    const vmid = Number(m[2]); const rest = m[3] || ''; const vm = vms.get(vmid);
    if (!vm) return send(res, null, 500, `Configuration file 'nodes/pve1/qemu-server/${vmid}.conf' does not exist`);
    if (rest === '' && req.method === 'DELETE') { destroyed.push(`DELETE ${vmid} ${u.search}`); log('DESTROY', vmid, u.search);
      if (vm.status !== 'stopped') return send(res, null, 500, 'VM is running'); return send(res, task('qmdestroy', vmid, 1000, () => vms.delete(vmid))); }
    if (rest === '/clone' && req.method === 'POST') { const b = await body(req); log('CLONE', vmid, JSON.stringify(b));
      const id = Number(b.newid); if (vms.has(id)) return send(res,null,500,`VM ${id} already exists`);
      clones.push({ from: vmid, ...b });
      vms.set(id, { origin: vmid, vmid:id, node:b.target || vm.node, type:'qemu', name:b.name, status:'stopped', lock:'clone', maxcpu:vm.maxcpu, maxmem:vm.maxmem, maxdisk:vm.maxdisk, cfg:{...vm.cfg, scsi0: vm.cfg.scsi0.replace(`base-${vmid}`, `vm-${id}`), net0: vm.cfg.net0 ? vm.cfg.net0.replace(/=[0-9A-Fa-f:]{17}/, '').replace(/^(\w+)/, `$1=${newMac()}`) : `virtio=${newMac()},bridge=vmbr0`} });
      if (vms.get(id).cfg.net0 && !/=/.test(vms.get(id).cfg.net0.split(',')[0])) vms.get(id).cfg.net0 = withMac(vms.get(id).cfg.net0);
      if (failClones > 0) { failClones -= 1; return send(res, task('qmclone', vmid, 800, () => { vms.delete(id); }, 'clone failed: storage full')); }
      return send(res, task('qmclone', vmid, 2500, () => { delete vms.get(id).lock; })); }
    if (rest === '/config' && req.method === 'GET') return send(res, vm.cfg);
    if (rest === '/config' && req.method === 'PUT') { const b = await body(req); for (const k of Object.keys(b)) if (/^net\d+$/.test(k)) b[k] = withMac(b[k]); log('CONFIG', vmid, JSON.stringify(b));
      if (b.delete) { for (const k of b.delete.split(',').map((x) => x.trim())) diskDelete(vm, k); delete b.delete; }
      diskAssign(vm, b);
      const hot = vm.status === 'running';
      for (const k of ['cores', 'memory', 'sockets']) if (b[k] !== undefined && hot && String(vm.cfg[k] ?? '') !== String(b[k])) (vm.pending ??= {})[k] = b[k];
      Object.assign(vm.cfg, b);
      if (!hot) { if (b.cores) vm.maxcpu = Number(b.cores); if (b.memory) vm.maxmem = Number(b.memory)*2**20; }
      return send(res, null); }
    if (rest === '/pending' && req.method === 'GET') {
      return send(res, Object.keys(vm.cfg).map((k) => ({ key: k, value: vm.pending?.[k] !== undefined ? undefined : vm.cfg[k], ...(vm.pending?.[k] !== undefined ? { value: String(k === 'cores' ? vm.maxcpu : Math.round(vm.maxmem / 2**20)), pending: vm.pending[k] } : {}) })));
    }
    if (rest === '/config' && req.method === 'POST') { const b = await body(req); log('CONFIG (async)', vmid, JSON.stringify(b));
      if (b.delete) { for (const k of b.delete.split(',').map((x) => x.trim())) diskDelete(vm, k); delete b.delete; }
      diskAssign(vm, b); Object.assign(vm.cfg, b); return send(res, task('qmconfig', vmid, 300)); }
    if (rest === '/move_disk' && req.method === 'POST') { const b = await body(req); log('MOVE_DISK', vmid, JSON.stringify(b));
      const target = vms.get(Number(b['target-vmid']));
      if (!target) return send(res, null, 500, 'target VM does not exist');
      if (target.node !== vm.node) return send(res, null, 500, 'reassigning disks is only possible on the same node');
      const value = vm.cfg[b.disk]; if (!value) return send(res, null, 500, `disk '${b.disk}' does not exist`);
      if (target.cfg[b['target-disk']]) return send(res, null, 500, `target disk '${b['target-disk']}' is in use`);
      delete vm.cfg[b.disk];
      const n = diskSeq.next(target.vmid);
      const moved = volidOf(value).replace(/vm-\d+-disk-\d+/, `vm-${target.vmid}-disk-${n + 10}`);
      const size = sizeOf(value) ?? volSizes.get(volidOf(value));
      volSizes.delete(volidOf(value));
      vm.owned?.delete(volidOf(value)); (target.owned ??= new Map()).set(moved, size);
      if (/^unused\d+$/.test(b['target-disk'])) { volSizes.set(moved, size); target.cfg[b['target-disk']] = moved; }
      else target.cfg[b['target-disk']] = `${moved},size=${size}`;
      return send(res, task('qmmove', vmid, 300)); }
    if (rest === '/rescan' && req.method === 'POST') {
      // unreferenced disks of this VM become unusedN (as after a rollback)
      const refd = new Set(Object.entries(vm.cfg).filter(([k]) => /^(scsi|virtio|sata|ide|unused)\d+$/.test(k)).map(([, x]) => volidOf(x)));
      for (const [vol, size] of vm.owned ?? []) {
        if (refd.has(vol)) continue;
        let i = 0; while (vm.cfg[`unused${i}`]) i += 1;
        vm.cfg[`unused${i}`] = vol; volSizes.set(vol, size);
      }
      return send(res, task('qmrescan', vmid, 200)); }
    if (rest === '/resize' && req.method === 'PUT') { const b = await body(req); log('RESIZE', vmid, JSON.stringify(b));
      vm.cfg[b.disk] = vm.cfg[b.disk].replace(/size=[^,]+/, `size=${b.size}`); if (b.disk === 'scsi0') vm.maxdisk = parseInt(b.size)*2**30; /* maxdisk: the boot disk only, as in Proxmox */ return send(res, task('resize', vmid, 500)); }
    const pw = rest.match(/^\/status\/(start|stop|shutdown|reboot)$/);
    if (pw) { const a = pw[1]; log('POWER', vmid, a); return send(res, task(`qm${a}`, vmid, 800, () => {
      vm.status = (a==='start'||a==='reboot')?'running':'stopped'; if (a==='start'||a==='reboot') started.set(vmid, Date.now());
      if ((a==='start'||a==='reboot') && vm.wu?.stage === 'restart-required') { vm.wu.stage = 'restarting'; vm.wu.stageAt = Date.now(); }
      if (vm.pending) { vm.maxcpu = Number(vm.cfg.cores); vm.maxmem = Number(vm.cfg.memory)*2**20; delete vm.pending; log('PENDING applied', vmid); } })); }
    if (rest === '/status/current') return send(res, { status: vm.status, cpus: vm.maxcpu, uptime: 600, mem: vm.maxmem/4, maxmem: vm.maxmem, agent: 0 });
    if (rest.startsWith('/firewall')) { const b = req.method==='GET'||req.method==='DELETE' ? Object.fromEntries(u.searchParams) : await body(req);
      vm.fwRules ??= []; vm.ipsets ??= {};
      { const sm = rest.match(/^\/firewall\/ipset(?:\/([\w-]+))?$/);
        if (sm) {
          if (req.method !== 'GET') log('FW', vmid, req.method, rest, JSON.stringify(b));
          if (!sm[1] && req.method === 'POST') { vm.ipsets[b.name] = []; return send(res, null); }
          if (!sm[1]) return send(res, Object.keys(vm.ipsets).map((name) => ({ name })));
          if (req.method === 'DELETE') { delete vm.ipsets[sm[1]]; return send(res, null); }
          if (req.method === 'POST') { if (!vm.ipsets[sm[1]]) return send(res, null, 500, 'no such IPSet'); vm.ipsets[sm[1]].push({ cidr: b.cidr }); return send(res, null); }
          return send(res, vm.ipsets[sm[1]] ?? []);
        } }
      if (rest === '/firewall/rules' && req.method === 'POST') vm.fwRules.splice(Number(b.pos ?? vm.fwRules.length), 0, b);
      if (rest === '/firewall/rules' && req.method === 'GET') return send(res, vm.fwRules.map((r, i) => ({ ...r, pos: i })));
      if (req.method !== 'GET') log('FW', vmid, req.method, rest, JSON.stringify(b)); return send(res, req.method==='GET' ? [] : null); }
    if (rest === '/agent/ping') { if (vm.status==='running' && Date.now()-(started.get(vmid) ?? 0) > 2000) return send(res,{}); return send(res,null,500,'QEMU guest agent is not running'); }
    if (rest === '/agent/set-user-password') { await body(req); log('AGENT set-user-password (reports OK, changes nothing)', vmid); return send(res,{}); }
    if (rest === '/agent/exec') { const b = new URLSearchParams(await new Promise(r=>{let x='';req.on('data',c=>x+=c);req.on('end',()=>r(x));})); const cmd = b.getAll('command'); const stdin = b.get('input-data');
      log('AGENT EXEC', vmid, JSON.stringify(cmd)); const pid = ++pidSeq; const script = cmd.join(' ');
      const encIdx = cmd.indexOf('-EncodedCommand'); const decoded = encIdx >= 0 ? Buffer.from(cmd[encIdx+1], 'base64').toString('utf16le') : '';
      if (decoded) log('AGENT SCRIPT', vmid, decoded.includes('Set-NetIPInterface') ? '[reset network to DHCP]' : decoded.includes('Get-NetIPAddress') ? '[list IPv4]' : decoded.slice(0,60));
      if (cmd[0] === '/bin/bash' && /PVEPANEL-LU-/.test(cmd[2] ?? '')) {
        const scen = vm.luScenario ?? 'normal'; const args = cmd.slice(4); let out = '', code = 0, err = '';
        const pm = scen === 'nopm' ? 'none' : scen === 'dnf' ? 'dnf' : 'apt';
        if (/PVEPANEL-LU-PRECHECK/.test(cmd[2])) {
          out = JSON.stringify({ pm, freeMb: scen === 'lowdisk' ? 600 : 20480, running: false, os: pm === 'dnf' ? 'Rocky Linux 9.4' : 'Ubuntu 24.04.1 LTS' }) + '\n';
        } else if (/PVEPANEL-LU-SETUP/.test(cmd[2])) {
          if (!/apt-get/.test(stdin ?? '') || !/dnf/.test(stdin ?? '') || cmd[3] !== 'pvepanel') { code = 1; err = 'bad script'; }
          else {
            vm.lu = { runId: args[0], scope: args[1], auto: args[2] === '1', scenario: scen, pm, at: Date.now() };
            log('LU started', vmid, JSON.stringify(vm.lu)); out = 'started\n';
          }
        } else if (/PVEPANEL-LU-CHECK/.test(cmd[2])) {
          out = JSON.stringify(pm === 'none' ? { pm } : { pm, pending: vm.luPending ?? 7, security: 2, rebootRequired: false }) + '\n';
        } else if (/PVEPANEL-LU-STATUS/.test(cmd[2])) {
          out = vm.lu ? luStatus(vm) + '\n' : '{}\n';
        } else { code = 1; err = 'unknown command'; }
        const pid = ++pidSeq; execs.set(String(pid), { out, at: Date.now(), code, err }); return send(res, { pid });
      }
      if (cmd[0] === '/bin/bash' && vmid !== 150) {
        const t = tailscaleExec(vm, vmid, cmd[2], stdin) ?? { out: '', code: 1, err: 'unknown command' };
        const pid = ++pidSeq; execs.set(String(pid), { out: t.out, at: Date.now(), code: t.code, err: t.err, script: cmd[2] }); return send(res, { pid });
      }
      if (decoded && /PVEPANEL-WU-/.test(decoded)) {
        let out = '';
        const scen = vm.wuScenario ?? 'normal';
        if (/PVEPANEL-WU-PRECHECK/.test(decoded)) {
          out = JSON.stringify({ freeGb: scen === 'lowdisk' ? 4.2 : 38.5, wuStartMode: scen === 'disabled' ? 'Disabled' : 'Manual', running: false });
        } else if (/PVEPANEL-WU-SETUP/.test(decoded)) {
          const input = JSON.parse(stdin);
          if (!/Microsoft\.Update\.Session/.test(input.script)) { const pid = ++pidSeq; execs.set(String(pid), { out: '', at: Date.now(), code: 1, err: 'bad script' }); return send(res, { pid }); }
          vm.wuConfig = input.config;
          vm.wu = { config: input.config, scenario: scen, stage: 'searching', stageAt: Date.now(), round: 1, installed: [] };
          log('WU started', vmid, JSON.stringify(input.config));
          out = 'started\n';
        } else if (/PVEPANEL-WU-CHECK/.test(decoded)) {
          if (!/Microsoft\.Update\.Session/.test(decoded)) { const pid = ++pidSeq; execs.set(String(pid), { out: '', at: Date.now(), code: 1, err: 'bad script' }); return send(res, { pid }); }
          out = JSON.stringify({ pending: 5, security: 3, rebootRequired: true });
        } else if (/PVEPANEL-WU-STATUS/.test(decoded)) {
          out = vm.wu ? wuStatus(vm, vmid) : '{}';
        } else if (/PVEPANEL-WU-CLEANUP/.test(decoded)) {
          vm.wuCleaned = true; out = 'ok\n';
        }
        const pid = ++pidSeq; execs.set(String(pid), { out, at: Date.now(), code: 0, err: '' }); return send(res, { pid });
      }
      if (decoded && /Resize-Partition/.test(decoded)) {
        const blocked = vm.recoveryAfterC; const pid = ++pidSeq;
        execs.set(String(pid), { out: blocked ? 'blocked\n' : 'extended\n', at: Date.now(), code: 0, err: '' }); log('EXTEND C:', vmid, blocked ? 'blocked' : 'ok'); return send(res, { pid });
      }
      if (decoded && /tailscale/i.test(decoded)) {
        const t = tailscaleExec(vm, vmid, decoded, stdin) ?? { out: '', code: 1, err: 'unknown command' };
        const pid = ++pidSeq; execs.set(String(pid), { out: t.out, at: Date.now(), code: t.code, err: t.err, script: decoded }); return send(res, { pid });
      }
      if (cmd[0] === '/bin/bash') {
        const sc = cmd[2]; let o = '', c = 0;
        if (sc === 'wg show wg0 public-key') o = GW_PUB + '\n';
        else if (/cat > (\S+)\.new/.test(sc)) { const f = /cat > (\S+)\.new/.exec(sc)[1]; gwFiles.set(f, stdin ?? ''); log('GW write', f, (stdin ?? '').length, 'bytes'); }
        else if (sc.includes('wg syncconf')) { const peers = (gwFiles.get('/etc/wireguard/panel-peers.conf') ?? '').match(/\[Peer\]/g)?.length ?? 0; log('GW apply: peers =', peers); o = 'applied\n'; }
        else if (sc === 'wg show wg0 latest-handshakes') { const keys = [...(gwFiles.get('/etc/wireguard/panel-peers.conf') ?? '').matchAll(/PublicKey = (\S+)/g)].map(m=>m[1]); o = keys.map((k,i)=> `${k}\t${i===0 ? Math.floor(Date.now()/1000)-30 : 0}`).join('\n') + '\n'; }
        else { c = 1; }
        const pid = ++pidSeq; execs.set(String(pid), { out: o, at: Date.now(), code: c, err: c ? 'unknown command' : '' }); return send(res, { pid });
      }
      vm.winpw ??= 'Template-Temp-Pass-2026!';
      let code = 0, err = '';
      let out = ''; if (decoded.includes('ValidateCredentials')) { out = stdin === vm.winpw ? 'valid\r\n' : 'invalid\r\n'; log('AGENT check password', vmid, '->', out.trim(), '(on command line:', JSON.stringify(cmd).includes(stdin ?? '#none#') ? 'YES!' : 'no', ')'); }
      else if (decoded.includes('Set-LocalUser')) { if (vm.origin === 9102) { code = 1; err = 'Access is denied.\r\n'; } else { vm.winpw = stdin; out = 'set\r\n'; } log('AGENT Set-LocalUser', vmid, code ? 'FAILED' : 'ok'); }
      else if (decoded.includes('Set-NetIPInterface')) { vm.dhcp = true; out = 'done\r\n'; }
      else if (decoded.includes('Get-NetIPAddress')) { const n = /bridge=cu0*(\d+)/.exec(vm.cfg.net0 ?? '')?.[1]; out = vm.dhcp && n ? `10.100.${n}.150\r\n` : '192.168.1.50\r\n'; }
      else if (script.includes('ImageState')) out = vm.origin === 9101 ? 'IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE\r\n' : (Date.now()-(started.get(vmid) ?? 0) > 6000 ? 'IMAGE_STATE_COMPLETE\r\n' : 'IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE\r\n');
      else if (script.includes('COMPUTERNAME')) out = 'WIN-8K2J4H1\r\n';
      execs.set(String(pid), { out, at: Date.now(), code: typeof code === 'number' ? code : 0, err: typeof err === 'string' ? err : '' }); return send(res, { pid }); }
    if (rest === '/agent/exec-status') {
      const pid = u.searchParams.get('pid'); const e = execs.get(String(pid));
      if (!e) return send(res, null, 500, 'Agent error: PID lld does not exist');
      // the process finished, but its one-and-only "exited" answer is lost in transit
      const want = loseOnly.get(vmid);
      if ((lose.get(vmid) ?? 0) > 0 && Date.now() - e.at > 500 && (!want || (e.script ?? '').includes(want))) { lose.set(vmid, lose.get(vmid) - 1); execs.delete(String(pid)); log('AGENT lost result of pid', pid, 'on', vmid);
        return send(res, null, 500, `VM ${vmid} qga command 'guest-exec-status' failed - got timeout`); }
    }
    if (rest === '/agent/exec-status' && (flaky.get(vmid) ?? 0) > 0) { flaky.set(vmid, flaky.get(vmid) - 1); return send(res, null, 500, `VM ${vmid} qga command 'guest-exec-status' failed - got timeout`); }
    if (rest === '/agent/exec-status') { const e = execs.get(String(u.searchParams.get('pid'))); return send(res, Date.now()-e.at > 500 ? { exited: 1, exitcode: e.code, 'out-data': e.out, 'err-data': e.err } : { exited: 0 }); }
    if (rest === '/rrddata') return send(res, Array.from({length:5},(_,i)=>({time:i,cpu:0.1*i,mem:1e9,maxmem:4e9,netin:100,netout:50})));
    if (rest === '/snapshot' && req.method === 'POST') { const b = await body(req); const v = vms.get(vmid);
      if ((v.snaps ?? []).some((x) => x.name === b.snapname)) return send(res, null, 500, `snapshot name '${b.snapname}' already used`);
      const cfgAt = JSON.parse(JSON.stringify(v.cfg));     // the configuration of this moment
      return send(res, task('qmsnapshot', vmid, 800, () => { (v.snaps ??= []).push({ name: b.snapname, description: b.description ?? '', snaptime: Math.floor(Date.now() / 1000), vmstate: b.vmstate ? 1 : 0, cfg: cfgAt }); })); }
    { const sm = rest.match(/^\/snapshot\/([\w-]+)(\/rollback)?$/);
      if (sm) { const v = vms.get(vmid); const snap = (v.snaps ?? []).find((x) => x.name === sm[1]);
        if (!snap) return send(res, null, 500, `snapshot '${sm[1]}' does not exist`);
        if (sm[2] && req.method === 'POST') { log('ROLLBACK', vmid, sm[1]); return send(res, task('qmrollback', vmid, 500, () => { v.cfg = JSON.parse(JSON.stringify(snap.cfg)); })); }
        if (!sm[2] && req.method === 'DELETE') { log('DELSNAPSHOT', vmid, sm[1]); return send(res, task('qmdelsnapshot', vmid, 300, () => { v.snaps = v.snaps.filter((x) => x !== snap); })); }
      } }
    if (rest === '/snapshot') return send(res, [...(vms.get(vmid)?.snaps ?? []).map(({ cfg, ...x }) => x), { name: 'current' }]);
    if (rest === '/vncproxy') return send(res, {port:5900, ticket:'PVEVNC:abc'});
    send(res, null, 501);
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => { wss.handleUpgrade(req, sock, head, (ws) => ws.send('RFB 003.008\n')); });


  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  const actualPort = srv.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    vms, sdn, gwFiles, destroyed, clones,
    /** GET a control endpoint, e.g. control('/__lose/104/1') */
    control: (p) => fetch(`http://127.0.0.1:${actualPort}/api2/json${p}`, {
      headers: { authorization: 'PVEAPIToken=panel@pve!panel=x' },
    }).then((r) => r.json()).then((j) => j.data),
    close: () => new Promise((resolve) => { wss.close(); srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
}
