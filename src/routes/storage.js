// Customer object storage (SeaweedFS S3): own buckets and access key, when the
// customer's resource pool includes object storage.

import { poolOfUser } from '../pools.js';
import {
  s3Enabled, s3Settings, listBucketsWithUsage, createBucket, deleteBucket, issueAccessKey, accountOf, setBucketReadOnly,
} from '../seaweedfs.js';

function allowed(req) {
  const pool = poolOfUser(req.account.id);
  // Object storage is opt-in: the pool must allow at least one bucket
  return s3Enabled() && pool && pool.maxS3Buckets > 0 ? pool : null;
}

function requireAllowed(req) {
  const pool = allowed(req);
  if (!pool) {
    const err = new Error('Object storage is not enabled for your account');
    err.statusCode = 403;
    throw err;
  }
  return pool;
}

export default async function storageRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/storage', async (req) => {
    const pool = allowed(req);
    if (!pool) return { enabled: false };
    const s = s3Settings();
    const account = accountOf(req.account.id);
    return {
      enabled: true,
      endpoint: s.publicEndpoint || s.endpoint,
      region: s.region,
      accessKeyId: account?.accessKeyId ?? null,
      limits: { buckets: pool.maxS3Buckets, gb: pool.maxS3Gb },
      buckets: (await listBucketsWithUsage({ userId: req.account.id }))
        .map(({ name, quotaGb, readOnly, createdAt, usage }) => ({ name, quotaGb, readOnly, createdAt, usage })),
    };
  });

  app.post('/api/storage/buckets', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 42 }, quotaGb: { type: 'integer', minimum: 0, maximum: 1_000_000 } },
      },
    },
  }, async (req, reply) => {
    requireAllowed(req);
    const b = await createBucket(req, req.account.id, req.body.name, req.body.quotaGb ?? 0);
    return reply.code(201).send({ name: b.name, quotaGb: b.quotaGb });
  });

  app.patch('/api/storage/buckets/:name', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['readOnly'], additionalProperties: false, properties: { readOnly: { type: 'boolean' } } } },
  }, async (req) => {
    requireAllowed(req);
    return setBucketReadOnly(req, req.params.name, req.body.readOnly, { userId: req.account.id });
  });

  app.delete('/api/storage/buckets/:name', async (req, reply) => {
    requireAllowed(req);
    await deleteBucket(req, req.params.name, { userId: req.account.id });
    return reply.code(204).send();
  });

  // A new key replaces the old one; the secret is in this answer only.
  app.post('/api/storage/keys', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    requireAllowed(req);
    reply.header('Cache-Control', 'no-store');
    return issueAccessKey(req, req.account.id);
  });
}
