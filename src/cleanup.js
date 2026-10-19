// Destroying servers and deleting customers completely (admin actions).

import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests, guestPath, waitTask, invalidateGuestCache, guestMayBeHidden, HiddenGuestError } from './pve.js';
import { removeNetwork, guestsUsingVnet } from './network.js';
import { syncGateway } from './vpn.js';
import { removeCustomer as removeS3Customer } from './seaweedfs.js';

export class CleanupError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
    this.expose = true;
  }
}

/** Servers the panel must never destroy, whoever asks. */
export function isProtected(vmid, guest) {
  return vmid === config.vpn.gatewayVmid || !!guest?.template;
}

/**
 * Stops a server if needed, destroys it with its disks and snapshots, and
 * removes it from the panel. Resolves when Proxmox has finished.
 */
export async function destroyServer(actor, vmid) {
  const guest = (await clusterGuests(true)).get(vmid);
  if (isProtected(vmid, guest)) throw new CleanupError(403, `Server ${vmid} is protected and can't be deleted here`);
  if (!guest && guestMayBeHidden()) throw new HiddenGuestError();

  if (guest) {
    const path = guestPath(guest);
    db.prepare("UPDATE vms SET state = 'deleting' WHERE vmid = ?").run(vmid);
    if (guest.status !== 'stopped') {
      await waitTask(guest.node, await pve.post(`${path}/status/stop`));
    }
    await waitTask(guest.node, await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 }));
  }
  db.prepare('DELETE FROM vms WHERE vmid = ?').run(vmid);
  db.prepare('DELETE FROM tasks WHERE vmid = ?').run(vmid);
  invalidateGuestCache();
  audit(actor, vmid, 'admin_server_deleted', { name: guest?.name ?? null });
}

/** What deleting this customer would remove (for the confirmation dialog). */
export async function deletionPlan(userId) {
  const servers = db.prepare('SELECT vmid, label, created_by_customer FROM vms WHERE user_id = ? ORDER BY vmid').all(userId);
  const network = db.prepare('SELECT vnet, idx FROM networks WHERE user_id = ?').get(userId);
  const devices = db.prepare('SELECT COUNT(*) AS n FROM vpn_devices WHERE user_id = ?').get(userId).n;
  // Servers in the customer's network that aren't theirs any more (e.g. reassigned
  // to an admin). They survive the deletion and keep the network in use.
  let othersInNetwork = [];
  if (network && config.network.enabled) {
    const own = new Set(servers.map((x) => x.vmid));
    const owners = new Map(db.prepare(`
      SELECT v.vmid, u.email FROM vms v JOIN users u ON u.id = v.user_id`).all().map((r) => [r.vmid, r.email]));
    othersInNetwork = (await guestsUsingVnet(network.vnet).catch(() => []))
      .filter((g) => !own.has(g.vmid))
      .map((g) => ({ ...g, owner: owners.get(g.vmid) ?? null }));
  }
  return {
    servers: servers.map((s) => ({ vmid: s.vmid, label: s.label, createdByCustomer: !!s.created_by_customer })),
    network: network ? { vnet: network.vnet, subnet: `${config.network.prefix}.${network.idx}.0/24` } : null,
    othersInNetwork,
    vpnDevices: devices,
  };
}

/**
 * Deletes a customer completely, in the background:
 *   1. their servers (stopped and destroyed in Proxmox; with keepAssigned,
 *      servers an admin assigned are only unassigned)
 *   2. their VPN devices (gateway re-synced)
 *   3. their VNet + subnet (SDN applied)
 *   4. the account itself
 * On failure the account stays, marked with the reason, and can be retried;
 * every step is safe to run again.
 */
export function startCustomerDeletion(req, userId, { keepAssigned = false, keepNetwork = false } = {}) {
  const user = db.prepare('SELECT id, email, deleting, deletion_error FROM users WHERE id = ?').get(userId);
  if (!user) throw new CleanupError(404, 'User not found');
  if (user.deleting && !user.deletion_error) throw new CleanupError(409, 'This customer is already being deleted');

  db.prepare('UPDATE users SET deleting = 1, deletion_error = NULL WHERE id = ?').run(userId);
  audit(req, null, 'admin_user_delete_started', { email: user.email, keepAssigned, keepNetwork });
  const actor = { account: { id: req.account.id }, ip: req.ip };

  (async () => {
    try {
      const servers = db.prepare('SELECT vmid, created_by_customer FROM vms WHERE user_id = ?').all(userId);
      for (const s of servers) {
        if (keepAssigned && !s.created_by_customer) {
          db.prepare('DELETE FROM vms WHERE vmid = ?').run(s.vmid);
          audit(actor, s.vmid, 'admin_vm_unassign');
        } else {
          await destroyServer(actor, s.vmid);
        }
      }

      const hadDevices = db.prepare('DELETE FROM vpn_devices WHERE user_id = ?').run(userId).changes > 0;
      if (hadDevices && config.vpn.enabled) await syncGateway();

      if (config.network.enabled && !keepNetwork) await removeNetwork(userId);
      // With keepNetwork the VNet stays in Proxmox; its row stays too (without an
      // owner) so its address range isn't handed to another customer.

      // Object storage: access key, policy and IAM user go; buckets stay (no owner)
      await removeS3Customer(userId);

      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      audit(actor, null, 'admin_user_delete', { email: user.email });
    } catch (err) {
      db.prepare('UPDATE users SET deletion_error = ? WHERE id = ?').run(String(err.message).slice(0, 500), userId);
      audit(actor, null, 'admin_user_delete_failed', { email: user.email, error: err.message });
    }
  })();
}
