// Operating system updates for customer servers, through the QEMU guest agent:
// Windows here, Linux (apt / dnf) in linuxupdate.js. Both share the run table,
// the tracker and the API.
//
// Windows:
// The panel writes a PowerShell script into the server and registers it as a
// scheduled task (runs as SYSTEM, also at startup). The script uses Windows'
// own update API (Microsoft.Update.Session): it searches, downloads and installs
// update by update, restarts when needed (or waits for the customer to restart)
// and continues after the restart until nothing is left (max. rounds). It writes
// its progress to a status file that the panel reads through the guest agent.
// Feature upgrades and previews are never installed. WSUS/group policy settings
// of the server are respected (the update source is Windows' own setting).

import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { pve, clusterGuests, guestPath, waitTask } from './pve.js';
import { agentExec } from './agent.js';
import { config } from './config.js';
import * as linux from './linuxupdate.js';

const TASK = 'PVEPanel-WindowsUpdate';
const ACTIVE = ['starting', 'searching', 'downloading', 'installing', 'restarting', 'restart-required'];
const FINAL = ['done', 'failed'];
const MIN_FREE_GB = 10;

export class UpdateError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; this.expose = true; }
}

const ps = (script) => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
];
const parseJson = (text) => {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trim();   // PowerShell 5.1 writes a BOM
  if (!clean) return null;
  try { return JSON.parse(clean); } catch { return null; }
};

// ---- The script that runs inside Windows --------------------------------------------
export const UPDATE_SCRIPT = String.raw`# PVE Panel: Windows updates (runs as SYSTEM via scheduled task ${TASK})
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'PVEPanel'
$cfg = Get-Content (Join-Path $dir 'update-config.json') -Raw | ConvertFrom-Json
$statusFile = Join-Path $dir 'update-status.json'
$status = $null
if (Test-Path $statusFile) { try { $status = Get-Content $statusFile -Raw | ConvertFrom-Json } catch { $status = $null } }
if (-not $status -or $status.runId -ne $cfg.runId) {
  $status = [pscustomobject]@{ runId = $cfg.runId; state = 'searching'; round = 1; total = 0; current = 0
    installed = @(); failed = @(); message = ''; error = $null; updatedAt = '' }
}
if ($status.state -in @('done', 'failed')) { exit 0 }

function Save([string]$state, [string]$message) {
  $status.state = $state; $status.message = $message
  $status.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $status | ConvertTo-Json -Depth 5 | Set-Content -Path $statusFile -Encoding UTF8
}

try {
  while ($true) {
    if ([int]$status.round -gt [int]$cfg.maxRounds) { Save 'done' 'Stopped after the maximum number of rounds'; exit 0 }
    Save 'searching' "Searching for updates (round $($status.round))"
    $session = New-Object -ComObject Microsoft.Update.Session
    $session.ClientApplicationID = 'PVE Panel'
    $searcher = $session.CreateUpdateSearcher()
    $result = $null
    for ($try = 1; $try -le 5 -and -not $result; $try++) {
      # right after a restart the network may not be ready yet
      try { $result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'") }
      catch { if ($try -eq 5) { throw }; Start-Sleep -Seconds 60 }
    }
    $wanted = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $result.Updates) {
      $cats = @($u.Categories | ForEach-Object { $_.Name })
      if ($u.BrowseOnly) { continue }
      if ($u.Title -match 'Preview') { continue }
      if ($cats -contains 'Upgrades' -or $u.Title -match 'Feature update') { continue }
      $important = @($cats | Where-Object { $_ -in @('Security Updates', 'Critical Updates', 'Definition Updates') }).Count -gt 0
      if ($cfg.scope -eq 'security' -and -not $important) { continue }
      if (-not $u.EulaAccepted) { $u.AcceptEula() }
      [void]$wanted.Add($u)
    }
    if ($wanted.Count -eq 0) { Save 'done' 'Windows is up to date'; exit 0 }

    $status.total = $wanted.Count
    $i = 0
    foreach ($u in $wanted) {
      $i++; $status.current = $i
      Save 'downloading' "Downloading $i of $($wanted.Count): $($u.Title)"
      $one = New-Object -ComObject Microsoft.Update.UpdateColl; [void]$one.Add($u)
      $dl = $session.CreateUpdateDownloader(); $dl.Updates = $one; [void]$dl.Download()
    }
    $i = 0; $reboot = $false
    foreach ($u in $wanted) {
      $i++; $status.current = $i
      Save 'installing' "Installing $i of $($wanted.Count): $($u.Title)"
      $kb = @($u.KBArticleIDs) | Select-Object -First 1
      $entry = [pscustomobject]@{ kb = $(if ($kb) { "KB$kb" } else { '' }); title = $u.Title; code = 0; hresult = '' }
      if (-not $u.IsDownloaded) { $entry.hresult = 'not downloaded'; $status.failed = @($status.failed) + $entry; continue }
      $one = New-Object -ComObject Microsoft.Update.UpdateColl; [void]$one.Add($u)
      $inst = $session.CreateUpdateInstaller(); $inst.Updates = $one
      $r = $inst.Install()
      $entry.code = [int]$r.ResultCode; $entry.hresult = ('0x{0:X8}' -f $r.HResult)
      if ($r.ResultCode -in 2, 3) { $status.installed = @($status.installed) + $entry } else { $status.failed = @($status.failed) + $entry }
      if ($r.RebootRequired) { $reboot = $true }
    }
    $status.round = [int]$status.round + 1
    if ($reboot -or (New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired) {
      if ($cfg.autoRestart) { Save 'restarting' 'Restarting to finish the updates'; Restart-Computer -Force; exit 0 }
      Save 'restart-required' 'Restart the server to finish the updates'
      exit 0
    }
  }
} catch {
  $hr = $_.Exception.HResult
  $status.error = $_.Exception.Message + $(if ($hr) { ' (0x{0:X8})' -f $hr } else { '' })
  Save 'failed' 'Windows Update failed'
  exit 1
}
`;

// Copies script + config into the server, registers the task and starts it.
const SETUP = String.raw`# PVEPANEL-WU-SETUP
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$dir = Join-Path $env:ProgramData 'PVEPanel'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
icacls $dir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
Set-Content -Path (Join-Path $dir 'update.ps1') -Value $in.script -Encoding UTF8
Set-Content -Path (Join-Path $dir 'update-config.json') -Value ($in.config | ConvertTo-Json -Compress) -Encoding UTF8
Remove-Item (Join-Path $dir 'update-status.json') -Force -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $dir 'update.ps1') + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT2M'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 6) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName '${TASK}'
'started'
`;

const PRECHECK = String.raw`# PVEPANEL-WU-PRECHECK
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$svc = Get-CimInstance Win32_Service -Filter "Name='wuauserv'"
@{ freeGb = [math]::Round($disk.FreeSpace / 1GB, 1); wuStartMode = $svc.StartMode; running = [bool](Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue | Where-Object State -eq 'Running') } | ConvertTo-Json -Compress
`;

const STATUS = String.raw`# PVEPANEL-WU-STATUS
$f = Join-Path $env:ProgramData 'PVEPanel\update-status.json'
if (Test-Path $f) { Get-Content $f -Raw } else { '{}' }
`;

// Counts what Windows Update would offer (nothing is downloaded or installed).
// 0FA1201D-…: the "Security Updates" classification.
const CHECK = String.raw`# PVEPANEL-WU-CHECK
$ErrorActionPreference = 'Stop'
$r = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
$sec = 0
foreach ($u in $r.Updates) { foreach ($c in $u.Categories) { if ($c.CategoryID -eq '0fa1201d-4330-4fa8-8ae9-b877473b6441') { $sec++; break } } }
$reboot = (New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired
@{ pending = $r.Updates.Count; security = $sec; rebootRequired = [bool]$reboot } | ConvertTo-Json -Compress
`;

const CLEANUP = String.raw`# PVEPANEL-WU-CLEANUP
Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue
'ok'
`;

// ---- Friendly messages for common Windows Update errors ------------------------------
const KNOWN = {
  '0x80070070': 'Not enough disk space on drive C:.',
  '0x80070422': 'The Windows Update service is disabled.',
  '0x8024002E': 'Windows Update is disabled by a policy on this server.',
  '0x8024402C': "Windows Update can't be reached (check DNS or proxy settings).",
  '0x80072EE2': 'The connection to Windows Update timed out.',
  '0x80072EFD': "Windows Update can't be reached (no internet connection).",
  '0x80240438': "Windows Update can't be reached from this server.",
  '0x80240022': 'All updates failed to install.',
  '0x8024001E': 'Windows was shutting down during the update.',
};
export function friendlyError(raw) {
  if (!raw) return null;
  const code = /0x[0-9A-Fa-f]{8}/.exec(raw)?.[0]?.toUpperCase().replace('0X', '0x');
  return code && KNOWN[code] ? `${KNOWN[code]} (${code})` : raw;
}

// ---- Settings ----------------------------------------------------------------------------
const storedSettings = () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'winupdates'").get();
  return row ? JSON.parse(row.value) : {};
};
/** Windows updates through the panel (on unless an administrator switched them off). */
export const updatesEnabled = () => storedSettings().enabled !== false;
/** Linux package updates through the panel (on unless switched off). */
export const linuxUpdatesEnabled = () => storedSettings().linux !== false;

export function setUpdatesEnabled(enabled, linuxEnabled = undefined) {
  const next = { ...storedSettings() };
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (typeof linuxEnabled === 'boolean') next.linux = linuxEnabled;
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('winupdates', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(next));
}
const enabledFor = (os) => (os === 'windows' ? updatesEnabled() : os === 'linux' ? linuxUpdatesEnabled() : false);

// ---- Runs --------------------------------------------------------------------------------
const latestRun = (vmid) => db.prepare('SELECT * FROM winupdates WHERE vmid = ? ORDER BY id DESC LIMIT 1').get(vmid);
export const activeRun = (vmid) => { const r = latestRun(vmid); return r && !FINAL.includes(r.state) ? r : null; };

function publicRun(r) {
  if (!r) return null;
  const s = r.status_json ? JSON.parse(r.status_json) : {};
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    id: r.id, os: r.os ?? 'windows', state: r.state, scope: r.scope, autoRestart: !!r.auto_restart, snapshot: r.snapshot,
    rebootRequired: s.rebootRequired === true, manager: s.manager ?? null,
    startedAt: r.started_at, finishedAt: r.finished_at,
    message: s.message ?? null, round: s.round ?? 1, current: s.current ?? 0, total: s.total ?? 0,
    installed: list(s.installed), failed: list(s.failed),
    error: friendlyError(s.error ?? r.error),
  };
}

async function guestOf(row) {
  const guest = (await clusterGuests(true)).get(row.vmid);
  if (!guest) throw new UpdateError(404, 'Server not found');
  return { guest, path: guestPath(guest) };
}

/** 'windows' | 'linux' | null, from the Proxmox OS type. */
export async function osOfGuest(path) {
  const ostype = (await pve.get(`${path}/config`)).ostype ?? '';
  if (/^w/.test(ostype)) return 'windows';
  if (/^l2/.test(ostype)) return 'linux';
  return null;
}

/** For the server page. */
export async function updateInfo(row) {
  const { guest, path } = await guestOf(row);
  const os = await osOfGuest(path);
  const run = publicRun(latestRun(row.vmid));
  // Linux: a restart the update asked for has happened when the server has been
  // up for less time than since the run finished.
  let rebootPending = false;
  if (run?.os === 'linux' && run.state === 'done' && run.rebootRequired && run.finishedAt) {
    const since = (Date.now() - Date.parse(`${run.finishedAt.replace(' ', 'T')}Z`)) / 1000;
    rebootPending = !(guest.status === 'running' && Number.isFinite(guest.uptime) && guest.uptime < since);
  }
  return {
    available: enabledFor(os), os, windows: os === 'windows', enabled: enabledFor(os) || (os === null && updatesEnabled()),
    run, rebootPending,
  };
}

/** Checks, optional snapshot, then starts the update task inside Windows. */
export async function startUpdates(req, row, { scope = 'security', snapshot = true, autoRestart = true } = {}) {
  if (row.state !== 'ready') throw new UpdateError(409, 'Wait until the current operation on this server has finished');
  if (row.expired_at) throw new UpdateError(403, 'This server has expired. Extend it first.');
  if (activeRun(row.vmid)) throw new UpdateError(409, 'Updates are already being installed on this server');
  const { guest, path } = await guestOf(row);
  const os = await osOfGuest(path);
  if (!os) throw new UpdateError(400, 'Updates through the panel are available for Windows and Linux servers');
  if (!enabledFor(os)) {
    throw new UpdateError(403, `${os === 'windows' ? 'Windows' : 'Linux'} updates through the panel are switched off by your provider`);
  }
  if (guest.status !== 'running') throw new UpdateError(409, 'Start the server first');
  try { await pve.post(`${path}/agent/ping`); } catch {
    throw new UpdateError(409, 'The QEMU guest agent is not running in this server');
  }
  if (os === 'linux') return startLinux(req, row, guest, path, { scope, snapshot, autoRestart });

  const check = parseJson((await agentExec(path, ps(PRECHECK), 60_000)).out) ?? {};
  if (/disabled/i.test(check.wuStartMode ?? '')) throw new UpdateError(409, 'The Windows Update service is disabled on this server. Enable it first.');
  if (typeof check.freeGb === 'number' && check.freeGb < MIN_FREE_GB) {
    throw new UpdateError(409, `Not enough disk space: ${check.freeGb} GB free on C:, at least ${MIN_FREE_GB} GB needed. Free up space or enlarge the disk.`);
  }
  if (check.running) throw new UpdateError(409, 'An update run is still active inside Windows');

  const snapName = snapshot ? await snapshotFirst(guest, path, 'Windows') : null;

  const runId = crypto.randomUUID();
  const cfg = { runId, scope: scope === 'all' ? 'all' : 'security', autoRestart: !!autoRestart, maxRounds: 5 };
  const r = await agentExec(path, ps(SETUP), 120_000, JSON.stringify({ script: UPDATE_SCRIPT, config: cfg }));
  if (!/started/.test(r.out)) throw new UpdateError(502, `The update task could not be started: ${(r.err || r.out || '').trim().split('\n').pop()}`);

  const id = db.prepare(`INSERT INTO winupdates (vmid, user_id, run_id, scope, auto_restart, snapshot, state)
    VALUES (?, ?, ?, ?, ?, ?, 'starting')`).run(row.vmid, row.user_id, runId, cfg.scope, cfg.autoRestart ? 1 : 0, snapName).lastInsertRowid;
  audit(req, row.vmid, 'winupdate_started', { scope: cfg.scope, snapshot: snapName, autoRestart: cfg.autoRestart });
  return publicRun(db.prepare('SELECT * FROM winupdates WHERE id = ?').get(id));
}

/**
 * Pending updates of a running Windows or Linux server, counted inside it without
 * installing anything: { os, pending, security, rebootRequired }. Windows' search can
 * take minutes.
 */
export async function checkPending(row) {
  if (row.state !== 'ready') throw new UpdateError(409, 'The server is busy');
  if (activeRun(row.vmid)) throw new UpdateError(409, 'Updates are being installed right now');
  const { guest, path } = await guestOf(row);
  const os = await osOfGuest(path);
  if (!os) throw new UpdateError(400, 'Only Windows and Linux servers can be checked');
  if (guest.status !== 'running') throw new UpdateError(409, 'The server is not running');
  try { await pve.post(`${path}/agent/ping`); } catch {
    throw new UpdateError(409, 'The QEMU guest agent is not running in this server');
  }
  const r = os === 'linux' ? await agentExec(path, linux.sh(linux.CHECK), 300_000) : await agentExec(path, ps(CHECK), 900_000);
  const j = parseJson(r.out);
  if (j?.pm === 'none') throw new UpdateError(409, 'No supported package manager (apt or dnf) was found');
  if (!j || typeof j.pending !== 'number') throw new UpdateError(502, `The check gave no answer${r.err ? `: ${friendlyError(r.err.trim().split('\n').pop())}` : ''}`);
  return { os, pending: j.pending, security: Number(j.security) || 0, rebootRequired: j.rebootRequired === true };
}

/** Snapshot before updating (rollback if an update breaks something). */
async function snapshotFirst(guest, path, what) {
  const existing = (await pve.get(`${path}/snapshot`)).filter((s) => s.name !== 'current');
  if (existing.length >= config.limits.maxSnapshots) {
    throw new UpdateError(409, `Your plan allows ${config.limits.maxSnapshots} snapshots and all are used. Delete one, or start without a snapshot.`);
  }
  const snapName = `before_updates_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  await waitTask(guest.node, await pve.post(`${path}/snapshot`, { snapname: snapName, description: `Before ${what} updates (PVE Panel)` }));
  return snapName;
}

/** Linux: checks, optional snapshot, then starts the update script detached inside the server. */
async function startLinux(req, row, guest, path, { scope, snapshot, autoRestart }) {
  const check = parseJson((await agentExec(path, linux.sh(linux.PRECHECK), 60_000)).out) ?? {};
  if (check.pm === 'none') throw new UpdateError(409, 'No supported package manager (apt or dnf) was found on this server');
  if (typeof check.freeMb === 'number' && check.freeMb < linux.MIN_FREE_MB) {
    throw new UpdateError(409, `Not enough disk space: ${(check.freeMb / 1024).toFixed(1)} GB free on /, at least ${linux.MIN_FREE_MB / 1024} GB needed. Free up space or enlarge the disk.`);
  }
  if (check.running) throw new UpdateError(409, 'An update run is still active inside the server');

  const snapName = snapshot ? await snapshotFirst(guest, path, 'Linux') : null;
  const runId = crypto.randomUUID();
  const cfg = { scope: scope === 'all' ? 'all' : 'security', autoRestart: !!autoRestart };
  const r = await agentExec(path, linux.sh(linux.SETUP, runId, cfg.scope, cfg.autoRestart ? 1 : 0), 120_000, linux.LINUX_SCRIPT);
  if (!/started/.test(r.out)) throw new UpdateError(502, `The update could not be started: ${(r.err || r.out || '').trim().split('\n').pop()}`);

  const id = db.prepare(`INSERT INTO winupdates (vmid, user_id, run_id, scope, auto_restart, snapshot, state, os)
    VALUES (?, ?, ?, ?, ?, ?, 'starting', 'linux')`).run(row.vmid, row.user_id, runId, cfg.scope, cfg.autoRestart ? 1 : 0, snapName).lastInsertRowid;
  audit(req, row.vmid, 'linuxupdate_started', { scope: cfg.scope, snapshot: snapName, autoRestart: cfg.autoRestart, manager: check.pm });
  return publicRun(db.prepare('SELECT * FROM winupdates WHERE id = ?').get(id));
}

/** Reads the status file inside the server and records it; finishes the run when done. */
export async function refreshRun(run, log) {
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(run.vmid);
  if (!row) return;
  const guest = (await clusterGuests(true)).get(run.vmid);
  if (!guest || guest.status !== 'running') return;          // stopped/restarting: try again later
  let s = null;
  const isLinux = run.os === 'linux';
  const statusCmd = isLinux ? linux.sh(linux.STATUS) : ps(STATUS);
  try { s = parseJson((await agentExec(guestPath(guest), statusCmd, 30_000)).out); } catch { return; } // agent busy/booting
  if (!s || s.runId !== run.run_id) {
    // no news yet; give up after 6 hours without any progress
    if (Date.now() - Date.parse(`${run.started_at.replace(' ', 'T')}Z`) > 6 * 3600_000) {
      db.prepare("UPDATE winupdates SET state = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?")
        .run('No progress was reported for 6 hours', run.id);
    }
    return;
  }
  const state = [...ACTIVE, ...FINAL].includes(s.state) ? s.state : run.state;
  db.prepare('UPDATE winupdates SET state = ?, status_json = ? WHERE id = ?').run(state, JSON.stringify(s), run.id);
  if (FINAL.includes(state) && !run.finished_at) {
    db.prepare("UPDATE winupdates SET finished_at = datetime('now') WHERE id = ?").run(run.id);
    if (!isLinux) await agentExec(guestPath(guest), ps(CLEANUP), 30_000).catch(() => {});
    const installed = Array.isArray(s.installed) ? s.installed.length : s.installed ? 1 : 0;
    const kind = isLinux ? 'linuxupdate' : 'winupdate';
    audit({ account: { id: run.user_id }, ip: kind }, run.vmid, state === 'done' ? `${kind}_finished` : `${kind}_failed`,
      { installed, failed: Array.isArray(s.failed) ? s.failed.length : 0, error: friendlyError(s.error), rebootRequired: s.rebootRequired === true });
    log?.info(`${isLinux ? 'Linux' : 'Windows'} updates on ${run.vmid}: ${state} (${installed} installed)`);
  }
}

export async function refreshForServer(row) {
  const run = activeRun(row.vmid);
  if (run) await refreshRun(run).catch(() => {});
}

/** Keeps track of active runs even when nobody has the page open. */
export function startUpdateTracker(log) {
  const every = Math.max(5, Number(process.env.WINUPDATE_POLL_SECONDS || 60)) * 1000;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const runs = db.prepare(`SELECT * FROM winupdates WHERE state IN (${ACTIVE.map(() => '?').join(',')})`).all(...ACTIVE);
      for (const run of runs) await refreshRun(run, log).catch(() => {});
    } finally { busy = false; }
  }, every).unref();
}
