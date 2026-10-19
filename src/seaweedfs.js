// Object storage on SeaweedFS (S3 API + IAM API), configured in the admin
// interface and stored in the settings table; the admin secret key is
// encrypted at rest (secrets.js) and never sent back to the browser.
//
// SeaweedFS side (see docs): run the S3 gateway with an admin identity
// (`weed s3 -filer=... -config=s3.json` or `weed server -s3 -s3.config=...`).
// The IAM API is embedded in the S3 server and on by default (same port, 8333);
// the old standalone `weed iam` (port 8111) also works via "IAM endpoint". The panel
//   - creates one IAM user per customer ("<prefix>u<id>"),
//   - creates buckets named "<prefix><id>-<name>" with the admin identity,
//   - keeps a policy on the customer's IAM user that allows exactly their buckets
//     (read-only buckets: only reading and listing, e.g. to freeze a finished backup),
//   - issues access keys (the secret is shown once and not stored).
// Hard per-bucket quotas are enforced by SeaweedFS itself (`s3.bucket.quota`
// in `weed shell`); the panel records the quota, counts it against the
// customer's resource pool and shows the command to apply it.

import { db, audit } from './db.js';
import { seal, open } from './secrets.js';
import { sign, encodePath } from './sigv4.js';
import { checkPoolCapacity, poolOfUser } from './pools.js';

const KEY = 's3';
const PURPOSE = 's3-admin-secret';

export class S3Error extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
    this.expose = true;
  }
}

// ---- Settings -------------------------------------------------------------------

const read = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : null;
};

const trimUrl = (u) => (u ?? '').trim().replace(/\/+$/, '');

export function s3Settings() {
  const s = read();
  return {
    configured: !!(s?.enabled && s?.endpoint && s?.accessKey && s?.secretKey),
    enabled: !!s?.enabled,
    endpoint: s?.endpoint ?? '',             // S3 gateway, e.g. http://seaweedfs:8333
    iamEndpoint: s?.iamEndpoint ?? '',       // IAM API; defaults to the S3 endpoint (embedded IAM)
    publicEndpoint: s?.publicEndpoint ?? '', // shown to customers, e.g. https://s3.example.com
    region: s?.region ?? 'us-east-1',
    accessKey: s?.accessKey ?? '',
    hasSecretKey: !!s?.secretKey,
    bucketPrefix: s?.bucketPrefix ?? 'pp',
    updatedAt: db.prepare('SELECT updated_at FROM settings WHERE key = ?').get(KEY)?.updated_at ?? null,
  };
}

/** secretKey: undefined = keep, '' = remove, anything else = store (encrypted). */
export function saveS3Settings(input) {
  const current = read() ?? {};
  const next = {
    enabled: !!input.enabled,
    endpoint: trimUrl(input.endpoint),
    iamEndpoint: trimUrl(input.iamEndpoint) || trimUrl(input.endpoint),
    publicEndpoint: trimUrl(input.publicEndpoint) || trimUrl(input.endpoint),
    region: (input.region || 'us-east-1').trim(),
    accessKey: (input.accessKey ?? '').trim(),
    bucketPrefix: (input.bucketPrefix ?? current.bucketPrefix ?? 'pp').trim(),
    secretKey: input.secretKey === undefined ? current.secretKey
      : input.secretKey === '' ? null
      : seal(PURPOSE, input.secretKey),
  };
  if (!/^[a-z][a-z0-9]{0,9}$/.test(next.bucketPrefix)) throw new S3Error(400, 'Bucket prefix: 1-10 lowercase letters or digits, starting with a letter');
  if (current.bucketPrefix && current.bucketPrefix !== next.bucketPrefix && db.prepare('SELECT 1 FROM s3_buckets').get()) {
    throw new S3Error(409, 'The bucket prefix can\'t change while buckets exist');
  }
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(KEY, JSON.stringify(next));
  return s3Settings();
}

function connection() {
  const s = read();
  if (!s?.enabled || !s.endpoint || !s.accessKey || !s.secretKey) {
    throw new S3Error(409, 'Object storage is not set up yet (Object storage tab)');
  }
  let secretKey;
  try { secretKey = open(PURPOSE, s.secretKey); } catch {
    throw new S3Error(409, 'The stored SeaweedFS secret key can\'t be read (JWT_SECRET changed?). Enter it again.');
  }
  return { ...s, secretKey };
}

export const s3Enabled = () => s3Settings().configured;

// ---- HTTP ------------------------------------------------------------------------------

const xmlValue = (xml, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;
const xmlValues = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);

async function call(c, { service, method = 'GET', url, body = '', headers = {} }) {
  const signed = sign({ method, url, region: c.region, service, accessKey: c.accessKey, secretKey: c.secretKey, headers, body });
  let res;
  try {
    res = await fetch(url, { method, headers: signed, body: body || undefined });
  } catch (err) {
    throw new S3Error(502, `SeaweedFS is unreachable (${err.cause?.code || err.message})`);
  }
  const text = await res.text();
  if (!res.ok) {
    const code = xmlValue(text, 'Code');
    const message = xmlValue(text, 'Message');
    const err = new S3Error(res.status === 404 || res.status === 409 ? res.status : 502,
      `SeaweedFS ${service.toUpperCase()}: ${code ?? res.status}${message ? ` (${message})` : ''}`);
    err.awsCode = code;
    throw err;
  }
  return text;
}

const s3 = (c, method, bucketPath = '/', query = '', body = '') =>
  call(c, { service: 's3', method, url: `${c.endpoint}${encodePath(bucketPath)}${query ? `?${query}` : ''}`, body });

function iam(c, action, params = {}) {
  const body = new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString();
  return call(c, {
    service: 'iam', method: 'POST', url: `${c.iamEndpoint || c.endpoint}/`, body,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
}

// ---- Admin operations -------------------------------------------------------------------

export async function testConnection() {
  const c = connection();
  const list = await s3(c, 'GET', '/');
  // The IAM API answers too (a read-only call)
  await iam(c, 'ListUsers');
  return { ok: true, buckets: xmlValues(list, 'Name').length };
}

const NAME = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

export const bucketName = (userId, name, prefix = s3Settings().bucketPrefix) => `${prefix}${userId}-${name}`;
const iamUserName = (userId, prefix = s3Settings().bucketPrefix) => `${prefix}u${userId}`;

async function ensureAccount(c, userId) {
  const row = db.prepare('SELECT * FROM s3_accounts WHERE user_id = ?').get(userId);
  if (row) return row;
  const name = iamUserName(userId, c.bucketPrefix);
  try {
    await iam(c, 'CreateUser', { UserName: name });
  } catch (err) {
    if (err.awsCode !== 'EntityAlreadyExists') throw err;
  }
  db.prepare('INSERT INTO s3_accounts (user_id, iam_user) VALUES (?, ?)').run(userId, name);
  return db.prepare('SELECT * FROM s3_accounts WHERE user_id = ?').get(userId);
}

export const READ_ACTIONS = ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectTagging', 's3:ListBucket', 's3:ListBucketVersions', 's3:GetBucketLocation'];

/**
 * IAM policy that allows a customer exactly their buckets: everything on writable
 * ones, reading and listing on read-only ones. buckets: names, or { name, readOnly }.
 */
export function bucketPolicy(buckets) {
  const list = buckets.map((b) => (typeof b === 'string' ? { name: b, readOnly: false } : b));
  const arns = (bs) => bs.flatMap((b) => [`arn:aws:s3:::${b.name}`, `arn:aws:s3:::${b.name}/*`]);
  const rw = list.filter((b) => !b.readOnly);
  const ro = list.filter((b) => b.readOnly);
  return {
    Version: '2012-10-17',
    Statement: [
      ...(rw.length ? [{ Effect: 'Allow', Action: ['s3:*'], Resource: arns(rw) }] : []),
      ...(ro.length ? [{ Effect: 'Allow', Action: READ_ACTIONS, Resource: arns(ro) }] : []),
    ],
  };
}

async function syncPolicy(c, userId) {
  const account = db.prepare('SELECT * FROM s3_accounts WHERE user_id = ?').get(userId);
  if (!account) return;
  const buckets = db.prepare('SELECT name, read_only FROM s3_buckets WHERE user_id = ? ORDER BY name').all(userId).map((b) => ({ name: b.name, readOnly: !!b.read_only }));
  if (buckets.length) {
    await iam(c, 'PutUserPolicy', {
      UserName: account.iam_user, PolicyName: 'panel-buckets', PolicyDocument: JSON.stringify(bucketPolicy(buckets)),
    });
  } else {
    await iam(c, 'DeleteUserPolicy', { UserName: account.iam_user, PolicyName: 'panel-buckets' }).catch((err) => {
      if (err.awsCode !== 'NoSuchEntity') throw err;
    });
  }
}

/** Creates a bucket for a customer (checked against their resource pool). */
export async function createBucket(req, userId, name, quotaGb = 0) {
  const c = connection();
  if (!NAME.test(name)) throw new S3Error(400, 'Bucket name: 3-42 lowercase letters, digits or dashes, not starting or ending with a dash');
  const user = db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').get(userId);
  if (!user) throw new S3Error(404, 'Customer not found');
  const pool = poolOfUser(userId);
  if (!pool || !(pool.maxS3Buckets > 0)) throw new S3Error(403, 'Object storage is not part of this customer\'s resource pool');
  if (!Number.isInteger(quotaGb) || quotaGb < 0) throw new S3Error(400, 'Quota is a whole number of GB');
  if (pool.maxS3Gb !== null && pool.maxS3Gb !== undefined && quotaGb === 0) {
    throw new S3Error(400, `The pool "${pool.name}" caps object storage, so each bucket needs a quota`);
  }
  const full = bucketName(userId, name, c.bucketPrefix);
  if (full.length > 63) throw new S3Error(400, 'Bucket name is too long');
  if (db.prepare('SELECT 1 FROM s3_buckets WHERE name = ?').get(full)) throw new S3Error(409, 'This bucket already exists');
  await checkPoolCapacity(userId, { s3Buckets: 1, s3Gb: quotaGb });

  await ensureAccount(c, userId);
  try {
    await s3(c, 'PUT', `/${full}`);
  } catch (err) {
    if (err.awsCode !== 'BucketAlreadyOwnedByYou') throw err;
  }
  db.prepare('INSERT INTO s3_buckets (name, user_id, quota_gb) VALUES (?, ?, ?)').run(full, userId, quotaGb);
  await syncPolicy(c, userId);
  audit(req, null, 's3_bucket_create', { bucket: full, owner: user.email, quotaGb });
  return { name: full, quotaGb, quotaCommand: quotaCommand(full, quotaGb) };
}

export async function deleteBucket(req, name, { userId = null } = {}) {
  const c = connection();
  const row = db.prepare('SELECT * FROM s3_buckets WHERE name = ?').get(name);
  if (!row || (userId !== null && row.user_id !== userId)) throw new S3Error(404, 'Bucket not found');
  try {
    await s3(c, 'DELETE', `/${name}`);
  } catch (err) {
    if (err.awsCode === 'BucketNotEmpty') throw new S3Error(409, 'The bucket isn\'t empty. Delete its objects first.');
    if (err.awsCode !== 'NoSuchBucket') throw err;
  }
  db.prepare('DELETE FROM s3_buckets WHERE name = ?').run(name);
  if (row.user_id) await syncPolicy(c, row.user_id);
  audit(req, null, 's3_bucket_delete', { bucket: name });
}

/**
 * Read-only on: the customer's key can only read and list the bucket (nothing can be
 * added, changed or deleted with it); off: full access again. The panel's own
 * identity is not affected.
 */
export async function setBucketReadOnly(req, name, readOnly, { userId = null } = {}) {
  const c = connection();
  const row = db.prepare('SELECT * FROM s3_buckets WHERE name = ?').get(name);
  if (!row || (userId !== null && row.user_id !== userId)) throw new S3Error(404, 'Bucket not found');
  if (!!row.read_only === !!readOnly) return { name, readOnly: !!readOnly };
  db.prepare('UPDATE s3_buckets SET read_only = ? WHERE name = ?').run(readOnly ? 1 : 0, name);
  try {
    if (row.user_id) await syncPolicy(c, row.user_id);
  } catch (err) {
    db.prepare('UPDATE s3_buckets SET read_only = ? WHERE name = ?').run(row.read_only, name);
    throw err;
  }
  audit(req, null, readOnly ? 's3_bucket_read_only' : 's3_bucket_writable', { bucket: name });
  return { name, readOnly: !!readOnly };
}

/** New access key for a customer; the previous key stops working. Secret shown once. */
export async function issueAccessKey(req, userId) {
  const c = connection();
  const pool = poolOfUser(userId);
  if (!pool || !(pool.maxS3Buckets > 0)) throw new S3Error(403, 'Object storage is not part of this customer\'s resource pool');
  const account = await ensureAccount(c, userId);
  if (account.access_key_id) {
    await iam(c, 'DeleteAccessKey', { UserName: account.iam_user, AccessKeyId: account.access_key_id }).catch((err) => {
      if (err.awsCode !== 'NoSuchEntity') throw err;
    });
  }
  const xml = await iam(c, 'CreateAccessKey', { UserName: account.iam_user });
  const accessKeyId = xmlValue(xml, 'AccessKeyId');
  const secretAccessKey = xmlValue(xml, 'SecretAccessKey');
  if (!accessKeyId || !secretAccessKey) throw new S3Error(502, 'SeaweedFS did not return an access key');
  db.prepare('UPDATE s3_accounts SET access_key_id = ? WHERE user_id = ?').run(accessKeyId, userId);
  await syncPolicy(c, userId);
  audit(req, null, 's3_key_issued', { userId, accessKeyId });
  return { accessKeyId, secretAccessKey, endpoint: c.publicEndpoint || c.endpoint, region: c.region };
}

/** Size and object count of a bucket (first 10 000 objects; `truncated` beyond). */
export async function bucketUsage(name) {
  const c = connection();
  let bytes = 0;
  let objects = 0;
  let token = null;
  for (let page = 0; page < 10; page += 1) {
    const q = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
    if (token) q.set('continuation-token', token);
    const xml = await s3(c, 'GET', `/${name}`, q.toString());
    for (const size of xmlValues(xml, 'Size')) bytes += Number(size) || 0;
    objects += xmlValues(xml, 'Key').length;
    token = xmlValue(xml, 'NextContinuationToken');
    if (xmlValue(xml, 'IsTruncated') !== 'true' || !token) return { bytes, objects, truncated: false };
  }
  return { bytes, objects, truncated: true };
}

export function quotaCommand(bucket, quotaGb) {
  // weed shell; `s3.bucket.quota.enforce -apply` (run it on a schedule) then makes
  // buckets over their quota read-only. See the SeaweedFS wiki, S3 Bucket Quota.
  return quotaGb ? `s3.bucket.quota -name ${bucket} -sizeMB ${quotaGb * 1024}` : null;
}

export function listBuckets({ userId = null } = {}) {
  const rows = db.prepare(`
    SELECT b.name, b.user_id AS userId, b.quota_gb AS quotaGb, b.read_only AS readOnly, b.created_at AS createdAt, u.email AS owner
    FROM s3_buckets b LEFT JOIN users u ON u.id = b.user_id
    ${userId !== null ? 'WHERE b.user_id = ?' : ''} ORDER BY b.name
  `).all(...(userId !== null ? [userId] : []));
  return rows.map((r) => ({ ...r, readOnly: !!r.readOnly, quotaCommand: quotaCommand(r.name, r.quotaGb) }));
}

export async function listBucketsWithUsage(opts) {
  return Promise.all(listBuckets(opts).map(async (b) => {
    try { return { ...b, usage: await bucketUsage(b.name) }; } catch (err) { return { ...b, usage: null, usageError: err.message }; }
  }));
}

export function accountOf(userId) {
  const a = db.prepare('SELECT iam_user AS iamUser, access_key_id AS accessKeyId, created_at AS createdAt FROM s3_accounts WHERE user_id = ?').get(userId);
  return a ?? null;
}

/**
 * Customer deleted: their access key, policy and IAM user go; buckets stay
 * (owner removed) so no data is lost without an administrator deciding it.
 */
export async function removeCustomer(userId) {
  const account = db.prepare('SELECT * FROM s3_accounts WHERE user_id = ?').get(userId);
  if (!account || !s3Enabled()) return;
  const c = connection();
  const ignore = (codes) => (err) => { if (!codes.includes(err.awsCode)) throw err; };
  if (account.access_key_id) {
    await iam(c, 'DeleteAccessKey', { UserName: account.iam_user, AccessKeyId: account.access_key_id }).catch(ignore(['NoSuchEntity']));
  }
  await iam(c, 'DeleteUserPolicy', { UserName: account.iam_user, PolicyName: 'panel-buckets' }).catch(ignore(['NoSuchEntity']));
  await iam(c, 'DeleteUser', { UserName: account.iam_user }).catch(ignore(['NoSuchEntity']));
  db.prepare('UPDATE s3_buckets SET user_id = NULL WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM s3_accounts WHERE user_id = ?').run(userId);
}
