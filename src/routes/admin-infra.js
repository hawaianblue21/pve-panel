// Administration API: access control (RBAC), datacenters, resource allocation
// pools, object storage (SeaweedFS) and GPUs. Registered inside adminRoutes, so
// every route here is behind the admin sign-in and the permission map in rbac.js.

import { db, audit } from '../db.js';
import {
  PERMISSIONS, listRoles, listAdmins, createRole, updateRole, deleteRole, setAdminRole, roleById,
} from '../rbac.js';
import {
  listDatacenters, createDatacenter, updateDatacenter, deleteDatacenter,
  listPools, createPool, updatePool, deletePool, poolUsage, poolMembers, setPoolMember, LIMIT_FIELDS,
} from '../pools.js';
import {
  s3Settings, saveS3Settings, testConnection, listBucketsWithUsage, createBucket, deleteBucket, issueAccessKey, accountOf, setBucketReadOnly,
} from '../seaweedfs.js';
import {
  gpuInventory, createProfile, updateProfile, deleteProfile, attachGpu, detachGpu,
} from '../gpu.js';

const id = { type: 'integer', minimum: 1 };
const limit = { type: ['integer', 'null'], minimum: 0, maximum: 10_000_000 };
const permissionList = { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 40 } };

export default async function adminInfraRoutes(app) {
  // ---- Access (RBAC) ------------------------------------------------------------
  app.get('/api/admin/rbac', async () => ({ permissions: PERMISSIONS, roles: listRoles(), admins: listAdmins() }));

  const roleBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: { type: 'string', maxLength: 31 },
      name: { type: 'string', minLength: 1, maxLength: 60 },
      description: { type: 'string', maxLength: 200 },
      permissions: permissionList,
    },
  };

  app.post('/api/admin/rbac/roles', { schema: { body: { ...roleBody, required: ['key', 'name', 'permissions'] } } }, async (req, reply) => {
    const role = createRole(req.body);
    audit(req, null, 'admin_role_create', { role: role.key, permissions: role.permissions });
    return reply.code(201).send(role);
  });

  app.put('/api/admin/rbac/roles/:id', { schema: { body: roleBody } }, async (req) => {
    const role = updateRole(Number(req.params.id), req.body);
    audit(req, null, 'admin_role_update', { role: role.key, permissions: role.permissions });
    return role;
  });

  app.delete('/api/admin/rbac/roles/:id', async (req, reply) => {
    const role = roleById(Number(req.params.id));
    deleteRole(Number(req.params.id));
    audit(req, null, 'admin_role_delete', { role: role?.key });
    return reply.code(204).send();
  });

  app.put('/api/admin/rbac/admins/:id', {
    schema: { body: { type: 'object', required: ['roleId'], additionalProperties: false, properties: { roleId: id } } },
  }, async (req) => {
    const { user, role } = setAdminRole(Number(req.params.id), req.body.roleId);
    audit(req, null, 'admin_role_assign', { email: user.email, role: role.key });
    return { id: user.id, roleId: role.id, roleKey: role.key };
  });

  // ---- Datacenters ------------------------------------------------------------------
  const dcBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: { type: 'string', maxLength: 31 },
      name: { type: 'string', maxLength: 80 },
      location: { type: 'string', maxLength: 120 },
      nodes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: 63 } },
      storage: { type: 'string', maxLength: 100 },
    },
  };

  app.get('/api/admin/datacenters', async () => listDatacenters().map((d) => ({
    ...d, servers: db.prepare('SELECT COUNT(*) AS n FROM vms WHERE datacenter_id = ?').get(d.id).n,
  })));

  app.post('/api/admin/datacenters', { schema: { body: { ...dcBody, required: ['key', 'name', 'nodes'] } } }, async (req, reply) => {
    const dc = createDatacenter(req.body);
    audit(req, null, 'admin_datacenter_create', { key: dc.key, nodes: dc.nodes });
    return reply.code(201).send(dc);
  });

  app.put('/api/admin/datacenters/:id', { schema: { body: dcBody } }, async (req) => {
    const dc = updateDatacenter(Number(req.params.id), req.body);
    audit(req, null, 'admin_datacenter_update', { key: dc.key, nodes: dc.nodes });
    return dc;
  });

  app.delete('/api/admin/datacenters/:id', async (req, reply) => {
    deleteDatacenter(Number(req.params.id));
    audit(req, null, 'admin_datacenter_delete', { id: Number(req.params.id) });
    return reply.code(204).send();
  });

  // ---- Resource allocation pools -------------------------------------------------------
  const poolBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      description: { type: 'string', maxLength: 300 },
      ...Object.fromEntries(Object.keys(LIMIT_FIELDS).map((k) => [k, limit])),
      datacenters: { type: 'array', maxItems: 100, items: id },
      gpuProfiles: { type: 'array', maxItems: 100, items: id },
    },
  };

  app.get('/api/admin/pools', async () => Promise.all(listPools().map(async (p) => ({
    ...p, members: poolMembers(p.id), usage: await poolUsage(p.id),
  }))));

  app.post('/api/admin/pools', { schema: { body: { ...poolBody, required: ['name'] } } }, async (req, reply) => {
    const pool = createPool(req.body);
    audit(req, null, 'admin_pool_create', { name: pool.name });
    return reply.code(201).send(pool);
  });

  app.put('/api/admin/pools/:id', { schema: { body: poolBody } }, async (req) => {
    const pool = updatePool(Number(req.params.id), req.body);
    audit(req, null, 'admin_pool_update', { name: pool.name, ...req.body });
    return pool;
  });

  app.delete('/api/admin/pools/:id', async (req, reply) => {
    deletePool(Number(req.params.id));
    audit(req, null, 'admin_pool_delete', { id: Number(req.params.id) });
    return reply.code(204).send();
  });

  app.put('/api/admin/pools/:id/members/:userId', async (req) => {
    const user = setPoolMember(Number(req.params.id), Number(req.params.userId), true);
    audit(req, null, 'admin_pool_member_add', { pool: Number(req.params.id), email: user.email });
    return { poolId: Number(req.params.id), userId: user.id };
  });

  app.delete('/api/admin/pools/:id/members/:userId', async (req, reply) => {
    const user = setPoolMember(Number(req.params.id), Number(req.params.userId), false);
    audit(req, null, 'admin_pool_member_remove', { pool: Number(req.params.id), email: user.email });
    return reply.code(204).send();
  });

  // ---- Object storage (SeaweedFS) -------------------------------------------------------
  const url = { type: 'string', maxLength: 300, pattern: '^(https?://[^\\s]+)?$' };

  app.get('/api/admin/storage/s3', async () => s3Settings());

  app.put('/api/admin/storage/s3', {
    schema: {
      body: {
        type: 'object',
        required: ['enabled', 'endpoint', 'accessKey'],
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          endpoint: url, iamEndpoint: url, publicEndpoint: url,
          region: { type: 'string', maxLength: 40, pattern: '^[a-z0-9-]*$' },
          accessKey: { type: 'string', maxLength: 200 },
          secretKey: { type: 'string', maxLength: 300 },
          bucketPrefix: { type: 'string', maxLength: 10 },
        },
      },
    },
  }, async (req) => {
    const saved = saveS3Settings(req.body);
    audit(req, null, 'admin_s3_settings', { endpoint: saved.endpoint, enabled: saved.enabled });
    return saved;
  });

  app.post('/api/admin/storage/s3/test', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async () => testConnection());

  app.get('/api/admin/storage/s3/buckets', async () => {
    const buckets = await listBucketsWithUsage();
    const accounts = db.prepare('SELECT user_id FROM s3_accounts').all()
      .map((a) => ({ userId: a.user_id, ...accountOf(a.user_id) }));
    return { buckets, accounts };
  });

  app.post('/api/admin/storage/s3/buckets', {
    schema: {
      body: {
        type: 'object', required: ['userId', 'name'], additionalProperties: false,
        properties: { userId: id, name: { type: 'string', maxLength: 42 }, quotaGb: { type: 'integer', minimum: 0, maximum: 1_000_000 } },
      },
    },
  }, async (req, reply) => reply.code(201).send(await createBucket(req, req.body.userId, req.body.name, req.body.quotaGb ?? 0)));

  app.patch('/api/admin/storage/s3/buckets/:name', {
    schema: { body: { type: 'object', required: ['readOnly'], additionalProperties: false, properties: { readOnly: { type: 'boolean' } } } },
  }, async (req) => setBucketReadOnly(req, req.params.name, req.body.readOnly));

  app.delete('/api/admin/storage/s3/buckets/:name', async (req, reply) => {
    await deleteBucket(req, req.params.name);
    return reply.code(204).send();
  });

  // New access key for a customer: the secret is in this answer only
  app.post('/api/admin/storage/s3/keys/:userId', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return issueAccessKey(req, Number(req.params.userId));
  });

  // ---- GPUs ------------------------------------------------------------------------------
  const profileBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: { type: 'string', maxLength: 31 },
      name: { type: 'string', maxLength: 80 },
      mode: { type: 'string', enum: ['passthrough', 'mdev'] },
      mapping: { type: 'string', maxLength: 128 },
      mdevType: { type: ['string', 'null'], maxLength: 64 },
      vramGb: { type: ['integer', 'null'], minimum: 0, maximum: 4096 },
      description: { type: 'string', maxLength: 300 },
    },
  };

  app.get('/api/admin/gpu', async () => gpuInventory());

  app.post('/api/admin/gpu/profiles', { schema: { body: { ...profileBody, required: ['key', 'name', 'mode', 'mapping'] } } }, async (req, reply) => {
    const p = await createProfile(req.body);
    audit(req, null, 'admin_gpu_profile_create', { key: p.key, mode: p.mode, mapping: p.mapping });
    return reply.code(201).send(p);
  });

  app.put('/api/admin/gpu/profiles/:id', { schema: { body: profileBody } }, async (req) => {
    const p = await updateProfile(Number(req.params.id), req.body);
    audit(req, null, 'admin_gpu_profile_update', { key: p.key });
    return p;
  });

  app.delete('/api/admin/gpu/profiles/:id', async (req, reply) => {
    deleteProfile(Number(req.params.id));
    audit(req, null, 'admin_gpu_profile_delete', { id: Number(req.params.id) });
    return reply.code(204).send();
  });

  app.post('/api/admin/vms/:vmid/gpu', {
    schema: { body: { type: 'object', required: ['profileId'], additionalProperties: false, properties: { profileId: id } } },
  }, async (req, reply) => reply.code(201).send(await attachGpu(req, Number(req.params.vmid), req.body.profileId)));

  app.delete('/api/admin/vms/:vmid/gpu/:slot', async (req, reply) => {
    await detachGpu(req, Number(req.params.vmid), Number(req.params.slot));
    return reply.code(204).send();
  });
}
