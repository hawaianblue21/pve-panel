// Simulated SeaweedFS S3 gateway + IAM API for tests, on one port.
// Every request must carry a valid AWS Signature V4 made with the admin
// credentials; the signature is checked here with an implementation independent
// of src/sigv4.js. State: buckets (with objects), IAM users, keys and policies.
import http from 'node:http';
import crypto from 'node:crypto';

export const ADMIN_AK = 'seaweed-admin-ak';
export const ADMIN_SK = 'seaweed-admin-secret-key';

const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function verify(req, rawPath, query, body) {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return 'missing or malformed Authorization';
  const [, ak, day, region, service, signed, sig] = m;
  if (ak !== ADMIN_AK) return 'unknown access key';
  const names = signed.split(';');
  const canonHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const q = [...new URLSearchParams(query)].map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
  const payload = h(body);
  if (service === 's3' && req.headers['x-amz-content-sha256'] !== payload) return 'content hash mismatch';
  const creq = [req.method, rawPath, q, canonHeaders, signed, payload].join('\n');
  const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/${region}/${service}/aws4_request`, h(creq)].join('\n');
  const key = mac(mac(mac(mac('AWS4' + ADMIN_SK, day), region), service), 'aws4_request');
  return crypto.createHmac('sha256', key).update(sts).digest('hex') === sig ? null : 'SignatureDoesNotMatch';
}

const xml = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/xml' }); res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`); };
const err = (res, code, c, msg = c) => xml(res, code, `<Error><Code>${c}</Code><Message>${msg}</Message></Error>`);

export async function startMockSeaweed() {
  const buckets = new Map();   // name -> Map(key -> size)
  const users = new Map();     // name -> { keys: Map(akid -> secret), policies: Map(name -> doc) }
  const calls = [];
  let keySeq = 0;

  const srv = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', (c) => { chunks += c; });
    req.on('end', () => {
      const [rawPath, query = ''] = req.url.split('?');
      const problem = verify(req, rawPath, query, chunks);
      if (problem) return err(res, 403, 'SignatureDoesNotMatch', problem);

      // ---- IAM (form POST to /) ----
      if (req.method === 'POST' && rawPath === '/') {
        const f = Object.fromEntries(new URLSearchParams(chunks));
        calls.push(f.Action);
        const u = users.get(f.UserName);
        switch (f.Action) {
          case 'ListUsers':
            return xml(res, 200, `<ListUsersResponse><ListUsersResult><Users>${[...users.keys()].map((n) => `<member><UserName>${n}</UserName></member>`).join('')}</Users></ListUsersResult></ListUsersResponse>`);
          case 'CreateUser':
            if (u) return err(res, 409, 'EntityAlreadyExists');
            users.set(f.UserName, { keys: new Map(), policies: new Map() });
            return xml(res, 200, `<CreateUserResponse><CreateUserResult><User><UserName>${f.UserName}</UserName></User></CreateUserResult></CreateUserResponse>`);
          case 'DeleteUser':
            if (!u) return err(res, 404, 'NoSuchEntity');
            users.delete(f.UserName);
            return xml(res, 200, '<DeleteUserResponse/>');
          case 'CreateAccessKey': {
            if (!u) return err(res, 404, 'NoSuchEntity');
            const id = `AKMOCK${String(++keySeq).padStart(6, '0')}`;
            const secret = crypto.randomBytes(24).toString('base64url');
            u.keys.set(id, secret);
            return xml(res, 200, `<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><UserName>${f.UserName}</UserName><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>${secret}</SecretAccessKey><Status>Active</Status></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`);
          }
          case 'DeleteAccessKey':
            if (!u || !u.keys.delete(f.AccessKeyId)) return err(res, 404, 'NoSuchEntity');
            return xml(res, 200, '<DeleteAccessKeyResponse/>');
          case 'PutUserPolicy':
            if (!u) return err(res, 404, 'NoSuchEntity');
            u.policies.set(f.PolicyName, JSON.parse(f.PolicyDocument));
            return xml(res, 200, '<PutUserPolicyResponse/>');
          case 'DeleteUserPolicy':
            if (!u || !u.policies.delete(f.PolicyName)) return err(res, 404, 'NoSuchEntity');
            return xml(res, 200, '<DeleteUserPolicyResponse/>');
          default:
            return err(res, 400, 'InvalidAction', f.Action);
        }
      }

      // ---- S3 ----
      const name = decodeURIComponent(rawPath.slice(1).split('/')[0] ?? '');
      calls.push(`S3 ${req.method} ${rawPath}`);
      if (req.method === 'GET' && rawPath === '/') {
        return xml(res, 200, `<ListAllMyBucketsResult><Buckets>${[...buckets.keys()].map((b) => `<Bucket><Name>${b}</Name></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`);
      }
      if (req.method === 'PUT') {
        if (buckets.has(name)) return err(res, 409, 'BucketAlreadyOwnedByYou');
        buckets.set(name, new Map());
        res.writeHead(200); return res.end();
      }
      if (req.method === 'DELETE') {
        const b = buckets.get(name);
        if (!b) return err(res, 404, 'NoSuchBucket');
        if (b.size) return err(res, 409, 'BucketNotEmpty');
        buckets.delete(name);
        res.writeHead(204); return res.end();
      }
      if (req.method === 'GET') {
        const b = buckets.get(name);
        if (!b) return err(res, 404, 'NoSuchBucket');
        const items = [...b].map(([k, size]) => `<Contents><Key>${k}</Key><Size>${size}</Size></Contents>`).join('');
        return xml(res, 200, `<ListBucketResult><Name>${name}</Name><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      }
      return err(res, 501, 'NotImplemented');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url, buckets, users, calls,
    putObject: (bucket, key, size) => buckets.get(bucket).set(key, size),
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  };
}
