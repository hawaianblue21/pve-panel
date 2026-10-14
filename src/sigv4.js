// AWS Signature Version 4, as used by the S3 and IAM APIs of SeaweedFS.
// Small and dependency-free; checked against AWS's published test vectors.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html

import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding as AWS wants it (encodeURIComponent leaves !'()* alone).
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** "/my bucket/a+b" -> "/my%20bucket/a%2Bb" (slashes kept). */
export const encodePath = (path) => path.split('/').map(encode).join('/');

export function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

const amzDate = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * Returns the headers to send (including Authorization) for a request.
 *   url        full URL (its path must already be encoded, e.g. with encodePath)
 *   headers    extra headers to sign (lower-case names)
 *   body       string or Buffer ('' for none)
 *   contentSha256    add x-amz-content-sha256 (S3 needs it, IAM doesn't)
 */
export function sign({
  method, url, region, service, accessKey, secretKey, headers = {}, body = '',
  now = new Date(), contentSha256 = service === 's3',
}) {
  const u = new URL(url);
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const payloadHash = sha256(body ?? '');
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), host: u.host, 'x-amz-date': date };
  if (contentSha256) all['x-amz-content-sha256'] = payloadHash;

  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, u.pathname || '/', canonicalQuery(u.searchParams), canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  delete all.host; // fetch sets it
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
