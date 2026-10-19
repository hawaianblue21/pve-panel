import bcrypt from 'bcryptjs';
import { db, audit } from '../db.js';
import { pve, clusterGuests, locateGuest, locateTemplate, invalidateGuestCache, guestPath } from '../pve.js';
import { startCustomerDeletion, deletionPlan, destroyServer, isProtected } from '../cleanup.js';
import { tailscaleOverview } from '../tailscale.js';
import { SCHEMES, currentScheme, setScheme, personalAllowed, setAllowPersonal } from '../appearance.js';
import { updatesEnabled, linuxUpdatesEnabled, setUpdatesEnabled } from '../winupdate.js';
import * as sso from '../sso.js';
import { branding, saveBranding, saveAsset, removeAsset } from '../branding.js';
import { activity, ACTOR_KEYS, CATEGORY_KEYS } from '../activity.js';
import * as totp from '../totp.js';
import { deleteAllPasskeys } from '../passkeys.js';
import {
  expirySettings, saveExpirySettings, applyCustomerRule, setServerExpiry, extendServer, expiryInfo, runExpiry,
} from '../expiry.js';
import { versionInfo, updateStatus } from '../version.js';
import {
  emailSettings, emailConfigured, saveEmailSettings, deleteEmailSettings, sendMail, testMessage,
} from '../mail.js';
import { sendInvitation, unusablePassword, inviteState } from '../invite.js';
import { usageOf } from '../provision.js';
import { networkOf, allNetworks } from '../network.js';
import { adminOverview, removeDevice, syncGateway } from '../vpn.js';
import { config } from '../config.js';
import {
  enforceRoutePermission, requirePermission, roleOf, permissionsOf, roleByKey, roleById, assertOwnerRemains,
} from '../rbac.js';
import adminInfraRoutes from './admin-infra.js';
import adminSupportRoutes from './admin-support.js';
import adminBillingRoutes from './admin-billing.js';
import adminVolumeRoutes from './admin-volumes.js';
import adminIpamRoutes from './admin-ipam.js';
import adminHostRoutes from './admin-hosts.js';
import { adminTokenRoutes } from './tokens.js';
import adminJobRoutes from './admin-jobs.js';
import adminClusterRoutes from './admin-clusters.js';
import adminPlanRoutes from './admin-plans.js';

const PASSWORD = { type: 'string', minLength: 12, maxLength: 200 };

function badRequest(reply, error) {
  return reply.code(400).send({ error });
}

export default async function adminRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  // Role-based access: every route needs the permission rbac.js maps it to.
  app.addHook('preHandler', enforceRoutePermission);

  // Who am I in the administration: role and permissions (drives which tabs show)
  app.get('/api/admin/me', async (req) => {
    const role = roleOf(req.account);
    return {
      id: req.account.id, email: req.account.email,
      role: { id: role.id, key: role.key, name: role.name },
      permissions: [...permissionsOf(req.account)],
    };
  });

  await app.register(adminInfraRoutes);
  await app.register(adminSupportRoutes);
  await app.register(adminBillingRoutes);
  await app.register(adminVolumeRoutes);
  await app.register(adminIpamRoutes);
  await app.register(adminHostRoutes);
  await app.register(adminTokenRoutes);
  await app.register(adminJobRoutes);
  await app.register(adminClusterRoutes);
  await app.register(adminPlanRoutes);

  // ---- Users ------------------------------------------------------------

  app.get('/api/admin/users', async () => {
    const users = db.prepare(`
      SELECT u.id, u.email, u.is_admin AS isAdmin, u.created_at AS createdAt,
             u.can_create AS canCreate, u.max_servers AS maxServers, u.max_cores AS maxCores,
             u.max_memory_mb AS maxMemoryMb, u.max_disk_gb AS maxDiskGb,
             u.deleting, u.deletion_error AS deletionError,
             u.totp_enabled AS totpEnabled, u.totp_required AS totpRequired,
             u.oidc_issuer AS ssoIssuer,
             (u.oidc_subject IS NOT NULL OR EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)) AS ssoLinked,
             (SELECT group_concat(i.provider, ',') FROM user_identities i WHERE i.user_id = u.id) AS ssoProviders,
             (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeyCount,
             u.expiry_mode AS expiryMode, u.expiry_days AS expiryDays, u.expiry_date AS expiryDate,
             u.expiry_self_extend AS expirySelfExtend,
             u.password_set, u.invite_token_hash, u.invite_expires, u.invited_at,
             u.admin_role_id AS adminRoleId, u.resource_pool_id AS resourcePoolId,
             COUNT(v.vmid) AS servers
      FROM users u LEFT JOIN vms v ON v.user_id = u.id
      GROUP BY u.id ORDER BY u.email
    `).all();
    return Promise.all(users.map(async (u) => ({
      ...u,
      isAdmin: !!u.isAdmin,
      adminRole: u.isAdmin ? (roleById(u.adminRoleId) ?? roleByKey('owner')).key : null,
      adminRoleId: undefined,
      canCreate: !!u.canCreate,
      deleting: !!u.deleting,
      totpEnabled: !!u.totpEnabled,
      totpRequired: !!u.totpRequired,
      ssoLinked: !!u.ssoLinked,
      invite: inviteState(u),
      password_set: undefined, invite_token_hash: undefined, invite_expires: undefined, invited_at: undefined,
      usage: u.canCreate ? await usageOf(u.id).catch(() => null) : null,
      network: networkOf(u.id),
    })));
  });

  app.post('/api/admin/users', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: PASSWORD,
          isAdmin: { type: 'boolean' },
          adminRole: { type: 'string', maxLength: 31 },
          requireTotp: { type: 'boolean' },
          invite: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password, isAdmin = false, requireTotp = false, invite = false } = req.body;
    // Only owners (rbac.write) make administrators. New administrators get the
    // least powerful built-in role unless another one is chosen.
    let role = null;
    if (isAdmin) {
      requirePermission(req.account, 'rbac.write');
      role = roleByKey(req.body.adminRole ?? 'operator');
      if (!role) return badRequest(reply, 'Unknown administrator role');
    }
    const clean = email.trim();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean)) {
      return reply.code(409).send({ error: 'A user with this email already exists' });
    }
    if (invite && !emailConfigured()) {
      return badRequest(reply, 'Email is not configured yet (Settings tab), so no invitation can be sent');
    }
    if (!invite && !password) return badRequest(reply, 'Set a password, or send an invitation email instead');

    // Invited users choose their own password through the link.
    const hash = invite ? unusablePassword() : await bcrypt.hash(password, 12);
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (email, password_hash, is_admin, totp_required, password_set, admin_role_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(clean, hash, isAdmin ? 1 : 0, requireTotp ? 1 : 0, invite ? 0 : 1, role?.id ?? null);
    const id = Number(lastInsertRowid);
    audit(req, null, 'admin_user_create', { email: clean, isAdmin, role: role?.key, requireTotp, invite });

    let inviteError = null;
    if (invite) {
      try { await sendInvitation(req, id); } catch (err) { inviteError = err.message; }
    }
    // The account exists either way; a failed invitation can be resent from the list.
    return reply.code(201).send({ id, email: clean, isAdmin, invited: invite && !inviteError, inviteError });
  });

  app.post('/api/admin/users/:id/invite', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    if (!emailConfigured()) return badRequest(reply, 'Email is not configured yet (Settings tab)');
    await sendInvitation(req, Number(req.params.id));
    return { sent: true };
  });

  // ---- Settings: email ----------------------------------------------------------
  app.get('/api/admin/settings/email', async () => emailSettings());

  app.put('/api/admin/settings/email', {
    schema: {
      body: {
        type: 'object',
        required: ['host', 'port', 'security', 'fromAddress', 'panelUrl'],
        additionalProperties: false,
        properties: {
          host: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          security: { type: 'string', enum: ['tls', 'starttls', 'none'] },
          username: { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 500 },
          fromName: { type: 'string', maxLength: 80 },
          fromAddress: { type: 'string', format: 'email', maxLength: 254 },
          panelUrl: { type: 'string', maxLength: 300, pattern: '^https?://[^\\s/]+' },
        },
      },
    },
  }, async (req) => {
    saveEmailSettings(req.body);
    audit(req, null, 'admin_email_settings', { host: req.body.host, port: req.body.port, security: req.body.security });
    return emailSettings();
  });

  app.delete('/api/admin/settings/email', async (req, reply) => {
    deleteEmailSettings();
    audit(req, null, 'admin_email_settings_removed');
    return reply.code(204).send();
  });

  app.post('/api/admin/settings/email/test', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['to'], properties: { to: { type: 'string', format: 'email', maxLength: 254 } } } },
  }, async (req) => {
    await sendMail({ to: req.body.to, ...testMessage(req.body.to) });
    audit(req, null, 'admin_email_test', { to: req.body.to });
    return { sent: true };
  });

  // Reset password and/or change admin rights
  app.patch('/api/admin/users/:id', {
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        properties: {
          password: PASSWORD,
          isAdmin: { type: 'boolean' },
          canCreate: { type: 'boolean' },
          maxServers: { type: 'integer', minimum: 0, maximum: 1000 },
          maxCores: { type: 'integer', minimum: 0, maximum: 10000 },
          maxMemoryMb: { type: 'integer', minimum: 0, maximum: 100 * 1024 * 1024 },
          maxDiskGb: { type: 'integer', minimum: 0, maximum: 1000 * 1024 },
          totpRequired: { type: 'boolean' },
          resetTotp: { type: 'boolean', const: true },
          unlinkSso: { type: 'boolean', const: true },
          removePasskeys: { type: 'boolean', const: true },
          expiryMode: { type: ['string', 'null'], enum: ['after_creation', 'fixed_date', null] },
          expiryDays: { type: 'integer', minimum: 1, maximum: 3650 },
          expiryDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          expirySelfExtend: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const { password, isAdmin } = req.body;
    if (isAdmin === false && id === req.account.id) {
      return badRequest(reply, "You can't remove your own admin rights");
    }
    if (typeof isAdmin === 'boolean' && isAdmin !== !!user.is_admin) {
      requirePermission(req.account, 'rbac.write');
      if (!isAdmin) assertOwnerRemains(id, { removingAdmin: true });
    }
    // Changing another administrator (password, 2FA, sign-in methods) is an RBAC matter too
    if (user.is_admin && id !== req.account.id) requirePermission(req.account, 'rbac.write');
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      db.prepare(`UPDATE users SET password_hash = ?, password_set = 1, invite_token_hash = NULL, invite_expires = NULL
                  WHERE id = ?`).run(hash, id);
      audit(req, null, 'admin_password_reset', { email: user.email });
    }
    if (typeof isAdmin === 'boolean') {
      // Granted here: the least powerful built-in role (change it in Access)
      db.prepare('UPDATE users SET is_admin = ?, admin_role_id = ? WHERE id = ?')
        .run(isAdmin ? 1 : 0, isAdmin ? roleByKey('operator').id : null, id);
      audit(req, null, isAdmin ? 'admin_grant' : 'admin_revoke', { email: user.email });
    }
    if (typeof req.body.totpRequired === 'boolean') {
      db.prepare('UPDATE users SET totp_required = ? WHERE id = ?').run(req.body.totpRequired ? 1 : 0, id);
      audit(req, null, req.body.totpRequired ? 'admin_twofa_require' : 'admin_twofa_unrequire', { email: user.email });
    }
    if ('expiryMode' in req.body || 'expirySelfExtend' in req.body) {
      const mode = 'expiryMode' in req.body ? req.body.expiryMode : user.expiry_mode;
      if (mode === 'after_creation' && !(req.body.expiryDays ?? user.expiry_days)) return badRequest(reply, 'Set the number of days');
      if (mode === 'fixed_date' && !(req.body.expiryDate ?? user.expiry_date)) return badRequest(reply, 'Set the end date');
      db.prepare(`UPDATE users SET expiry_mode = ?, expiry_days = ?, expiry_date = ?, expiry_self_extend = ? WHERE id = ?`).run(
        mode ?? null,
        mode === 'after_creation' ? (req.body.expiryDays ?? user.expiry_days) : null,
        mode === 'fixed_date' ? (req.body.expiryDate ?? user.expiry_date) : null,
        (req.body.expirySelfExtend ?? !!user.expiry_self_extend) ? 1 : 0,
        id,
      );
      applyCustomerRule(id);
      audit(req, null, 'admin_expiry_rule', { email: user.email, mode: mode ?? 'none', days: req.body.expiryDays, date: req.body.expiryDate });
    }
    if (req.body.removePasskeys) {
      const n = deleteAllPasskeys(id);   // lost device: the user signs in another way and adds new ones
      audit(req, null, 'admin_passkeys_removed', { email: user.email, count: n });
    }
    if (req.body.unlinkSso) {
      // Generic OIDC: the next sign-on links again by verified email (or is refused).
      // Google/Microsoft/GitHub: the user links the provider again under Account.
      db.prepare('UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE id = ?').run(id);
      const n = db.prepare('DELETE FROM user_identities WHERE user_id = ?').run(id).changes;
      audit(req, null, 'admin_sso_unlink', { email: user.email, providers: n });
    }
    if (req.body.resetTotp) {
      // Lost phone and recovery codes: 2FA is removed; if required, the user
      // sets it up again at the next sign-in.
      totp.reset(id);
      audit(req, null, 'admin_twofa_reset', { email: user.email });
    }

    const limitFields = {
      canCreate: 'can_create', maxServers: 'max_servers', maxCores: 'max_cores',
      maxMemoryMb: 'max_memory_mb', maxDiskGb: 'max_disk_gb',
    };
    const changed = Object.keys(limitFields).filter((k) => k in req.body);
    if (changed.length) {
      const sets = changed.map((k) => `${limitFields[k]} = ?`).join(', ');
      const values = changed.map((k) => (typeof req.body[k] === 'boolean' ? (req.body[k] ? 1 : 0) : req.body[k]));
      db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
      audit(req, null, 'admin_limits', { email: user.email, ...Object.fromEntries(changed.map((k) => [k, req.body[k]])) });
    }
    return { id, email: user.email };
  });

  // What deleting a customer would remove (shown in the confirmation dialog)
  app.get('/api/admin/users/:id/deletion-plan', async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return reply.code(404).send({ error: 'User not found' });
    return deletionPlan(id);
  });

  // Deletes the customer completely in the background: servers, VPN devices,
  // private network, account. ?keepAssigned=true only unassigns servers an
  // admin assigned (servers the customer created are always deleted).
  app.delete('/api/admin/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.account.id) return badRequest(reply, "You can't delete your own account");
    const target = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id);
    if (target?.is_admin) {
      requirePermission(req.account, 'rbac.write');
      assertOwnerRemains(id, { removingAdmin: true });
    }
    startCustomerDeletion(req, id, {
      keepAssigned: req.query.keepAssigned === 'true',
      keepNetwork: req.query.keepNetwork === 'true',
    });
    return reply.code(202).send({ started: true });
  });

  // ---- Server assignments ---------------------------------------------

  // Every guest in the cluster, with its current owner (if any)
  app.get('/api/admin/vms', async () => {
    const owners = new Map(
      db.prepare(`SELECT v.*, u.email FROM vms v JOIN users u ON u.id = v.user_id`)
        .all().map((r) => [r.vmid, r])
    );
    const expSettings = expirySettings();
    const guests = await clusterGuests(true);
    const list = [...guests.values()]
      .filter((g) => !g.template)
      .map((g) => {
        const o = owners.get(Number(g.vmid));
        return {
          vmid: Number(g.vmid), name: g.name ?? '', node: g.node, type: g.type, status: g.status,
          userId: o?.user_id ?? null, owner: o?.email ?? null, label: o?.label ?? null,
          state: o?.state ?? null, createdByCustomer: !!o?.created_by_customer,
          expiry: o ? expiryInfo(o, expSettings) : null, expiryManual: !!o?.expiry_manual,
        };
      });
    // Assignments whose guest no longer exists in the cluster (deleted in PVE)
    for (const [vmid, o] of owners) {
      if (!guests.has(vmid)) {
        list.push({ vmid, name: '', node: null, type: null, status: 'missing',
          userId: o.user_id, owner: o.email, label: o.label,
          state: o.state, createdByCustomer: !!o.created_by_customer,
          expiry: expiryInfo(o, expSettings), expiryManual: !!o.expiry_manual });
      }
    }
    return list.sort((a, b) => a.vmid - b.vmid);
  });

  app.put('/api/admin/vms/:vmid', {
    schema: {
      body: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: 'integer' }, label: { type: 'string', maxLength: 80 } },
      },
    },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.body.userId);
    if (!user) return badRequest(reply, 'That customer no longer exists');
    const guest = await locateGuest(vmid);
    const label = req.body.label?.trim() || null;
    const previous = db.prepare('SELECT user_id FROM vms WHERE vmid = ?').get(vmid);
    db.prepare(`
      INSERT INTO vms (vmid, user_id, type, label) VALUES (?, ?, ?, ?)
      ON CONFLICT(vmid) DO UPDATE SET user_id = excluded.user_id, type = excluded.type, label = excluded.label
    `).run(vmid, user.id, guest.type, label);
    invalidateGuestCache();
    const renamedOnly = previous?.user_id === user.id;
    if (!renamedOnly) {
      db.prepare(`UPDATE vms SET expires_at = NULL, expiry_set_at = NULL, expiry_manual = 0, expired_at = NULL,
                  expiry_notified = NULL, self_extended = 0 WHERE vmid = ?`).run(vmid);
      applyCustomerRule(user.id);       // e.g. the customer's fixed end date
    }
    audit(req, vmid, renamedOnly ? 'admin_vm_rename' : 'admin_vm_assign', { email: user.email, label });
    return { vmid, userId: user.id, owner: user.email, label, type: guest.type };
  });

  // ---- Expiry ------------------------------------------------------------------
  // Set a date (ISO or YYYY-MM-DD), extend by days, or remove (expiresAt: null).
  app.put('/api/admin/vms/:vmid/expiry', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expiresAt: { type: ['string', 'null'], maxLength: 40 },
          extendDays: { type: 'integer', minimum: 1, maximum: 3650 },
        },
      },
    },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
    if (!row) return reply.code(404).send({ error: 'Only servers assigned to a customer can expire' });
    if (req.body.extendDays) {
      const at = extendServer(vmid, req.body.extendDays);
      audit(req, vmid, 'server_expiry_extended', { by: 'admin', days: req.body.extendDays, expiresAt: at });
    } else if ('expiresAt' in req.body) {
      const value = req.body.expiresAt
        ? (/^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt) ? new Date(`${req.body.expiresAt}T23:59:59`).toISOString() : req.body.expiresAt)
        : null;
      if (value && Date.parse(value) <= Date.now()) return badRequest(reply, 'Choose a date in the future');
      setServerExpiry(vmid, value);
      audit(req, vmid, value ? 'server_expiry_set' : 'server_expiry_removed', { expiresAt: value });
    } else {
      return badRequest(reply, 'Nothing to change');
    }
    const updated = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
    return { vmid, expiry: expiryInfo(updated), expiryManual: !!updated.expiry_manual };
  });

  // ---- Settings: appearance (color scheme for everyone) -----------------------
  app.get('/api/admin/settings/appearance', async () => ({ scheme: currentScheme(), schemes: SCHEMES, allowPersonal: personalAllowed() }));

  app.put('/api/admin/settings/appearance', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { scheme: { type: 'string', maxLength: 30 }, allowPersonal: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    if (req.body.scheme !== undefined) setScheme(req.body.scheme);
    if (req.body.allowPersonal !== undefined) setAllowPersonal(req.body.allowPersonal);
    audit(req, null, 'admin_appearance', req.body);
    return { scheme: currentScheme(), schemes: SCHEMES, allowPersonal: personalAllowed() };
  });

  // ---- Settings: branding (white-label) -------------------------------------------
  app.get('/api/admin/settings/branding', async () => branding());
  app.put('/api/admin/settings/branding', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { name: { type: 'string', maxLength: 60 }, supportUrl: { type: 'string', maxLength: 300 } },
      },
    },
  }, async (req) => {
    const saved = saveBranding(req.body);
    audit(req, null, 'admin_branding', req.body);
    return saved;
  });
  app.put('/api/admin/settings/branding/:asset', {
    bodyLimit: 800 * 1024,   // base64 of a 512 KB logo
    schema: {
      body: {
        type: 'object', required: ['type', 'data'], additionalProperties: false,
        properties: { type: { type: 'string', maxLength: 40 }, data: { type: 'string', maxLength: 760_000 } },
      },
    },
  }, async (req) => {
    const saved = saveAsset(req.params.asset, req.body);
    audit(req, null, 'admin_branding_image', { image: req.params.asset, type: req.body.type });
    return saved;
  });
  app.delete('/api/admin/settings/branding/:asset', async (req) => {
    const saved = removeAsset(req.params.asset);
    audit(req, null, 'admin_branding_image_removed', { image: req.params.asset });
    return saved;
  });

  // ---- Settings: single sign-on with Google, Microsoft, GitHub ---------------------
  app.get('/api/admin/settings/sso', async () => sso.publicSettings());
  app.put('/api/admin/settings/sso/:provider', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          clientId: { type: 'string', maxLength: 200 },
          clientSecret: { type: 'string', maxLength: 500 },
          portals: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['customer', 'admin'] } },
          allowSignup: { type: 'boolean' },
          allowedDomains: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 100 } },
          tenant: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (req) => {
    const saved = sso.saveProvider(req.params.provider, req.body);
    const { clientSecret, ...rest } = req.body;
    audit(req, null, 'admin_sso_provider', { provider: req.params.provider, ...rest, secretChanged: !!clientSecret });
    return saved;
  });

  // ---- Settings: Windows updates through the panel -----------------------------
  // (Linux package updates share this setting: { enabled: Windows, linux: Linux })
  app.get('/api/admin/settings/winupdates', async () => ({ enabled: updatesEnabled(), linux: linuxUpdatesEnabled() }));
  app.put('/api/admin/settings/winupdates', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { enabled: { type: 'boolean' }, linux: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    setUpdatesEnabled(req.body.enabled, req.body.linux);
    audit(req, null, 'admin_winupdates', req.body);
    return { enabled: updatesEnabled(), linux: linuxUpdatesEnabled() };
  });

  app.get('/api/admin/settings/expiry', async () => expirySettings());

  app.put('/api/admin/settings/expiry', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reminderDays: { type: 'array', maxItems: 5, items: { type: 'integer', minimum: 1, maximum: 365 } },
          graceDays: { type: 'integer', minimum: 0, maximum: 365 },
          selfExtendDays: { type: 'integer', minimum: 1, maximum: 365 },
          pauseDeletions: { type: 'boolean' },
          adminSummary: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const saved = saveExpirySettings(req.body);
    audit(req, null, 'admin_expiry_settings', req.body);
    return saved;
  });

  // Run the expiry check now (it also runs every few minutes by itself)
  app.post('/api/admin/expiry/run', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const summary = await runExpiry({ log: req.log });
    audit(req, null, 'admin_expiry_run', { stopped: summary.stopped?.length ?? 0, deleted: summary.deleted?.length ?? 0 });
    return summary;
  });

  // ---- Acting on customer servers ------------------------------------------
  // Only servers assigned to a customer; the VPN gateway and templates never.
  async function customerServer(req) {
    const vmid = Number(req.params.vmid);
    const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
    if (!row) {
      const err = new Error('Only servers assigned to a customer can be managed here');
      err.statusCode = 404;
      throw err;
    }
    const guest = await locateGuest(vmid);
    if (isProtected(vmid, guest)) {
      const err = new Error('This server is protected');
      err.statusCode = 403;
      throw err;
    }
    return { row, guest };
  }

  app.post('/api/admin/vms/:vmid/power/:action', async (req, reply) => {
    const { row, guest } = await customerServer(req);
    const { action } = req.params;
    if (!['start', 'shutdown', 'reboot', 'stop'].includes(action)) {
      return reply.code(400).send({ error: `Unsupported action "${action}"` });
    }
    if (row.state !== 'ready') return reply.code(409).send({ error: 'Wait until the current operation has finished' });
    const upid = await pve.post(`${guestPath(guest)}/status/${action}`);
    invalidateGuestCache();
    audit(req, guest.vmid, `admin_power_${action}`);
    return { task: typeof upid === 'string' && upid.startsWith('UPID:') ? upid : null };
  });

  // Stops (if needed) and destroys the server with its disks, in the background.
  app.delete('/api/admin/vms/:vmid/server', async (req, reply) => {
    const { row, guest } = await customerServer(req);
    if (row.state === 'creating' || row.state === 'deleting') {
      return reply.code(409).send({ error: 'Wait until the current operation has finished' });
    }
    const actor = { account: { id: req.account.id }, ip: req.ip };
    destroyServer(actor, guest.vmid).catch((err) => {
      db.prepare("UPDATE vms SET state = 'failed', error = ? WHERE vmid = ?")
        .run(`Deleting failed: ${err.message}`.slice(0, 500), guest.vmid);
    });
    return reply.code(202).send({ started: true });
  });

  // Progress of any task (admins see all)
  app.get('/api/admin/tasks/:upid', async (req, reply) => {
    const upid = req.params.upid;
    if (!/^UPID:[^:]+:/.test(upid)) return reply.code(400).send({ error: 'Not a task id' });
    const node = upid.split(':')[1];
    const s = await pve.get(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
    return { done: s.status === 'stopped', ok: s.status === 'stopped' ? s.exitstatus === 'OK' : null, message: s.exitstatus ?? null };
  });

  app.delete('/api/admin/vms/:vmid', async (req, reply) => {
    const vmid = Number(req.params.vmid);
    db.prepare('DELETE FROM vms WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'admin_vm_unassign');
    return reply.code(204).send();
  });

  // ---- Templates for self-service creation --------------------------------

  app.get('/api/admin/templates', async () => {
    const rows = new Map(db.prepare('SELECT * FROM templates').all().map((t) => [t.vmid, t]));
    const guests = await clusterGuests(true);
    const templates = [...guests.values()].filter((g) => g.template && g.type === 'qemu');

    // Storages that can hold VM disks, per node, for the target-storage field
    const nodes = [...new Set(templates.map((t) => t.node))];
    const storages = {};
    await Promise.all(nodes.map(async (node) => {
      try {
        const list = await pve.get(`/nodes/${encodeURIComponent(node)}/storage`, { content: 'images', enabled: 1 });
        storages[node] = list.map((st) => st.storage).sort();
      } catch {
        storages[node] = [];
      }
    }));

    const list = templates.map((g) => {
      const row = rows.get(Number(g.vmid));
      return {
        vmid: Number(g.vmid), name: g.name ?? '', node: g.node,
        offered: !!row, label: row?.label ?? '', storage: row?.storage ?? '',
        ciUser: row?.ci_user ?? '', ipconfig: row?.ipconfig ?? 'ip=dhcp',
        setup: row?.setup ?? (/^win/.test(g.name ?? '') ? 'windows' : 'cloudinit'),
      };
    }).sort((a, b) => a.vmid - b.vmid);
    return { templates: list, storages };
  });

  app.put('/api/admin/templates/:vmid', {
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 80 },
          storage: { type: 'string', maxLength: 100 },
          ciUser: { type: 'string', maxLength: 32 },
          ipconfig: { type: 'string', maxLength: 200 },
          setup: { type: 'string', enum: ['cloudinit', 'windows'] },
        },
      },
    },
  }, async (req) => {
    const vmid = Number(req.params.vmid);
    await locateTemplate(vmid);
    const { label, storage, ciUser, ipconfig, setup = 'cloudinit' } = req.body;
    db.prepare(`
      INSERT INTO templates (vmid, label, storage, ci_user, ipconfig, setup) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(vmid) DO UPDATE SET label = excluded.label, storage = excluded.storage,
        ci_user = excluded.ci_user, ipconfig = excluded.ipconfig, setup = excluded.setup
    `).run(vmid, label.trim(), storage?.trim() || null, ciUser?.trim() || null,
      ipconfig?.trim() || 'ip=dhcp', setup);
    audit(req, vmid, 'admin_template_offer', { label });
    return { vmid };
  });

  app.delete('/api/admin/templates/:vmid', async (req, reply) => {
    const vmid = Number(req.params.vmid);
    db.prepare('DELETE FROM templates WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'admin_template_withdraw');
    return reply.code(204).send();
  });

  // ---- VPN ------------------------------------------------------------------
  app.get('/api/admin/vpn', async () => ({
    ...(await adminOverview()),
    tailscale: { enabled: config.tailscale.enabled, servers: tailscaleOverview() },
  }));

  app.delete('/api/admin/vpn/devices/:id', async (req, reply) => {
    await removeDevice(req, Number(req.params.id), { asAdmin: true });
    return reply.code(204).send();
  });

  app.post('/api/admin/vpn/sync', async () => {
    await syncGateway();
    return { ok: true };
  });

  // ---- Version / updates ------------------------------------------------------
  app.get('/api/admin/about', async (req) => ({
    ...versionInfo,
    uptimeSeconds: Math.round(process.uptime()),
    update: await updateStatus({ force: req.query.refresh === '1' }),
  }));

  // ---- Networks -------------------------------------------------------------
  app.get('/api/admin/networks', async () => allNetworks());

  // ---- Activity ---------------------------------------------------------

  // Filtered and paged: ?actor=customer|admin|system|anonymous &category=create|change|delete|power|security
  //   &userId= &vmid= &q= &before=<id of the last event shown> &limit=
  app.get('/api/admin/activity', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          actor: { type: 'string', enum: ACTOR_KEYS }, category: { type: 'string', enum: CATEGORY_KEYS },
          userId: { type: 'integer', minimum: 1 }, vmid: { type: 'integer', minimum: 1 }, q: { type: 'string', maxLength: 100 },
          before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (req) => activity(req.query));

  app.get('/api/admin/audit', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    return db.prepare(`
      SELECT a.id, a.vmid, a.action, a.detail, a.ip, a.created_at AS createdAt, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?
    `).all(limit);
  });
}
