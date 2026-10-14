// AWS Signature V4 (object storage) and GPU config helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../support/unit-env.mjs';

const { sign, canonicalQuery, encodePath } = await import('../../src/sigv4.js');
const { parseMapEntry, hostpciValue, freeSlot } = await import('../../src/gpu.js');
const { bucketPolicy } = await import('../../src/seaweedfs.js');

// From AWS's Signature Version 4 test suite (get-vanilla, get-vanilla-query-order-key-case)
const vector = { region: 'us-east-1', service: 'service', accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z') };

test('matches the AWS test suite signatures', () => {
  const plain = sign({ ...vector, method: 'GET', url: 'https://example.amazonaws.com/' });
  assert.equal(plain.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(plain['x-amz-date'], '20150830T123600Z');
  const query = sign({ ...vector, method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' });
  assert.match(query.authorization, /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
});

test('S3 requests carry and sign the payload hash', () => {
  const h = sign({ ...vector, service: 's3', method: 'PUT', url: 'http://s3.local:8333/bucket', body: '' });
  assert.equal(h['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(h.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
});

test('canonical query and path encoding follow RFC 3986', () => {
  assert.equal(canonicalQuery(new URLSearchParams('b=2&a=1&a=0&c=x y!')), 'a=0&a=1&b=2&c=x%20y%21');
  assert.equal(encodePath('/my bucket/a+b(1)'), '/my%20bucket/a%2Bb%281%29');
});

test('bucket policy allows exactly the given buckets', () => {
  const p = bucketPolicy(['pp7-data']);
  assert.deepEqual(p.Statement[0].Resource, ['arn:aws:s3:::pp7-data', 'arn:aws:s3:::pp7-data/*']);
});

test('GPU: mapping entries, hostpci values and free slots', () => {
  assert.deepEqual(parseMapEntry('node=pve1,path=0000:01:00.0,id=10de:2684,iommugroup=14'),
    { node: 'pve1', path: '0000:01:00.0', id: '10de:2684', iommugroup: '14' });
  assert.equal(hostpciValue({ mapping: 'rtx', mode: 'passthrough' }, { machine: 'pc-q35-8.1' }), 'mapping=rtx,pcie=1');
  assert.equal(hostpciValue({ mapping: 'a16', mode: 'mdev', mdevType: 'nvidia-660' }, {}), 'mapping=a16,mdev=nvidia-660');
  assert.equal(freeSlot({ hostpci0: 'x', hostpci1: 'y' }), 2);
  assert.equal(freeSlot(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`hostpci${i}`, 'x']))), null);
});
