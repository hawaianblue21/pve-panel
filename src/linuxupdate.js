// Linux package updates for customer servers, through the QEMU guest agent.
//
// The panel copies src/guest/linux-update.sh into the server and starts it
// detached (a transient systemd unit, or setsid without systemd), so the update
// keeps running after the agent call returns. The script refreshes the package
// lists, works out what to install (security only, or everything), installs it
// non-interactively (config files the customer changed are kept), records what
// changed and whether a restart is needed, and writes its progress to a status
// file that the panel reads through the guest agent.
//
//   apt  (Debian, Ubuntu)            security = packages from a *-security archive
//   dnf  (RHEL, Rocky, Alma, Fedora) security = dnf --security (updateinfo)
//
// Never done here: release upgrades (e.g. 24.04 → 26.04), removing packages,
// touching held (apt-mark hold) or version-locked packages.

import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`./guest/${name}`, import.meta.url), 'utf8');

export const LINUX_SCRIPT = read('linux-update.sh');
export const SETUP = read('linux-setup.sh');
export const PRECHECK = read('linux-precheck.sh');
export const STATUS = read('linux-status.sh');
export const CHECK = read('linux-check.sh');

export const MIN_FREE_MB = 1024;

/** Agent command line: bash -c '<script>' pvepanel arg1 arg2 … */
export const sh = (script, ...args) => ['/bin/bash', '-c', script, 'pvepanel', ...args.map(String)];
