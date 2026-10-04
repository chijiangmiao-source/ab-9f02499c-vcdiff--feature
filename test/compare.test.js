import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffOutputs, MAX_DIFF_HEX_BYTES } from '../src/compare.js';
import { createApp } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const te = new TextEncoder();
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const b64 = (u8) => Buffer.from(u8).toString('base64');

// ---------------------------------------------------------------------------
// diffOutputs (pure byte comparison)
// ---------------------------------------------------------------------------

describe('diffOutputs', () => {
  test('identical outputs report no ranges', () => {
    const a = te.encode('hello world');
    const r = diffOutputs(a, a);
    assert.equal(r.identical, true);
    assert.deepEqual(r.ranges, []);
  });

  test('two empty outputs are identical', () => {
    const r = diffOutputs(new Uint8Array(0), new Uint8Array(0));
    assert.equal(r.identical, true);
    assert.deepEqual(r.ranges, []);
  });

  test('a single contiguous run becomes one range with firstOffset and hex', () => {
    const a = te.encode('abcdefgh');
    const b = te.encode('abcXYfgh');
    const r = diffOutputs(a, b);
    assert.equal(r.identical, false);
    assert.equal(r.ranges.length, 1);
    const [range] = r.ranges;
    assert.equal(range.start, 3);
    assert.equal(range.end, 5);
    assert.equal(range.firstOffset, 3);
    assert.equal(range.baselineHex, '6465'); // "de"
    assert.equal(range.candidateHex, '5859'); // "XY"
    assert.equal(range.baselineHexTruncated, false);
    assert.equal(range.candidateHexTruncated, false);
  });

  test('equal bytes split the differences into separate ranges', () => {
    const a = te.encode('AxBxC');
    const b = te.encode('AyByC');
    const r = diffOutputs(a, b);
    assert.deepEqual(r.ranges.map((d) => [d.start, d.end]), [[1, 2], [3, 4]]);
    assert.deepEqual(r.ranges.map((d) => d.firstOffset), [1, 3]);
  });

  test('a longer baseline puts the tail in a range with empty candidate hex', () => {
    const r = diffOutputs(te.encode('abcdef'), te.encode('abc'));
    assert.equal(r.identical, false);
    assert.equal(r.ranges.length, 1);
    const [range] = r.ranges;
    assert.deepEqual([range.start, range.end], [3, 6]);
    assert.equal(range.baselineHex, '646566');
    assert.equal(range.candidateHex, '');
  });

  test('a longer candidate mirrors the tail range', () => {
    const r = diffOutputs(te.encode('ab'), te.encode('abXY'));
    assert.equal(r.ranges.length, 1);
    const [range] = r.ranges;
    assert.deepEqual([range.start, range.end], [2, 4]);
    assert.equal(range.baselineHex, '');
    assert.equal(range.candidateHex, '5859');
  });

  test('hex digests are capped and flagged when a range is long', () => {
    const a = new Uint8Array(100).fill(0xaa);
    const b = new Uint8Array(100).fill(0xbb);
    const r = diffOutputs(a, b, { maxHexBytes: 8 });
    assert.equal(r.ranges.length, 1);
    const [range] = r.ranges;
    assert.deepEqual([range.start, range.end], [0, 100]);
    assert.equal(range.baselineHex, 'aa'.repeat(8));
    assert.equal(range.candidateHex, 'bb'.repeat(8));
    assert.equal(range.baselineHexTruncated, true);
    assert.equal(range.candidateHexTruncated, true);
  });

  test('default cap is 64 bytes per side', () => {
    const a = new Uint8Array(MAX_DIFF_HEX_BYTES + 1).fill(1);
    const b = new Uint8Array(MAX_DIFF_HEX_BYTES + 1).fill(2);
    const [range] = diffOutputs(a, b).ranges;
    assert.equal(range.baselineHex.length, MAX_DIFF_HEX_BYTES * 2);
    assert.equal(range.baselineHexTruncated, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/compare
// ---------------------------------------------------------------------------

let server;
let port;
let sample;
let base;

before(async () => {
  sample = JSON.parse(readFileSync(join(root, 'fixtures', 'samples.json'), 'utf8'));
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(path, bodyObj) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
}

const compare = (candidateDictionaryBase64, extra = {}) =>
  post('/api/compare', {
    deltaBase64: sample.valid.deltaBase64,
    dictionaryBase64: sample.dictionaryBase64,
    candidateDictionaryBase64,
    ...extra,
  });

describe('POST /api/compare', () => {
  test('identical candidate dictionary reports identical outputs and no ranges', async () => {
    const resp = await compare(sample.dictionaryBase64);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);

    assert.equal(data.baseline.ok, true);
    assert.equal(data.baseline.length, sample.valid.expectedLength);
    assert.equal(data.baseline.sha256, sample.valid.expectedSha256);
    assert.equal(data.baseline.windows.length, sample.valid.expectedWindowCount);

    assert.equal(data.candidate.ok, true);
    assert.equal(data.candidate.length, sample.valid.expectedLength);
    assert.equal(data.candidate.sha256, sample.valid.expectedSha256);

    assert.equal(data.identical, true);
    assert.deepEqual(data.differences, []);
    assert.deepEqual(data.limits, { maxOutputBytes: 524288, maxWindows: 8 });
  });

  test('a re-exported candidate yields contiguous difference ranges with hex digests', async () => {
    // Same length as the 21-byte baseline dictionary, different content.
    const candidateDict = te.encode('ABCDEFGHIJKLMNOPQRSTU'); // 21 bytes
    const resp = await compare(b64(candidateDict));
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, true);

    // The candidate output is fully determined: window 1 copies dictionary
    // bytes, window 2 copies window 1 output through a TARGET source segment.
    const expectedCandidate = te.encode('ABCDEFGHIJKWORLDLMNO!!!!' + 'KWORLD>>KWORL');
    assert.equal(data.candidate.length, expectedCandidate.length);
    assert.equal(data.candidate.sha256, sha256(expectedCandidate));
    assert.equal(data.baseline.sha256, sample.valid.expectedSha256);

    assert.equal(data.identical, false);
    assert.deepEqual(
      data.differences.map((d) => [d.start, d.end, d.firstOffset]),
      [
        [0, 11, 0], // "0123456789-" vs "ABCDEFGHIJK"
        [16, 20, 16], // "HELL" vs "LMNO"
        [24, 25, 24], // "-" vs "K" (window 2 first copy)
        [32, 33, 32], // "-" vs "K" (window 2 SAME0 copy)
      ],
    );
    assert.deepEqual(
      data.differences.map((d) => [d.baselineHex, d.candidateHex]),
      [
        ['303132333435363738392d', '4142434445464748494a4b'], // "0123456789-" / "ABCDEFGHIJK"
        ['48454c4c', '4c4d4e4f'], // "HELL" / "LMNO"
        ['2d', '4b'],
        ['2d', '4b'],
      ],
    );
    for (const d of data.differences) {
      assert.equal(d.baselineHexTruncated, false);
      assert.equal(d.candidateHexTruncated, false);
    }
  });

  test('candidate dictionary that breaks decoding keeps the baseline conclusion', async () => {
    // 10-byte candidate: the SOURCE segment [0, +20) no longer fits.
    const resp = await compare(b64(te.encode('0123456789')));
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);

    assert.equal(data.baseline.ok, true);
    assert.equal(data.baseline.length, sample.valid.expectedLength);
    assert.equal(data.baseline.sha256, sample.valid.expectedSha256);
    assert.equal(data.baseline.windows.length, 2);

    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'SOURCE_RANGE');
    assert.equal(typeof data.candidate.error.offset, 'number');
    assert.equal(typeof data.candidate.error.message, 'string');

    // No part of the candidate output is treated as a difference result.
    assert.equal(data.identical, null);
    assert.equal(data.differences, null);
    assert.equal('windows' in data.candidate, false);
    assert.equal('length' in data.candidate, false);
  });

  test('malformed candidate Base64 is a candidate-side structured error only', async () => {
    const resp = await compare('not-base64!!');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'BAD_BASE64');
    assert.equal(data.candidate.error.offset, null);
    assert.equal(data.identical, null);
    assert.equal(data.differences, null);
  });

  test('oversized candidate Base64 is a candidate-side PAYLOAD_TOO_LARGE', async () => {
    const resp = await compare('A'.repeat(64 * 1024 + 4));
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(data.identical, null);
    assert.equal(data.differences, null);
  });

  test('a delta that fails under both dictionaries reports both sides, no diff', async () => {
    const resp = await post('/api/compare', {
      deltaBase64: sample.badCopy.deltaBase64,
      dictionaryBase64: sample.dictionaryBase64,
      candidateDictionaryBase64: sample.dictionaryBase64,
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.baseline.ok, false);
    assert.equal(data.baseline.error.code, 'COPY_NOT_GENERATED');
    assert.equal(data.baseline.error.offset, sample.badCopy.expectedOffset);
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'COPY_NOT_GENERATED');
    assert.equal(data.identical, null);
    assert.equal(data.differences, null);
  });

  test('request-level validation matches /api/decode semantics', async () => {
    // Missing delta field.
    const r1 = await post('/api/compare', { dictionaryBase64: '' });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.code, 'BAD_REQUEST');

    // Delta above the pasted-size limit.
    const r2 = await post('/api/compare', { deltaBase64: 'A'.repeat(128 * 1024 + 1) });
    assert.equal(r2.status, 413);
    assert.equal((await r2.json()).error.code, 'PAYLOAD_TOO_LARGE');

    // Malformed delta Base64.
    const r3 = await post('/api/compare', { deltaBase64: '@@@' });
    assert.equal(r3.status, 400);
    assert.equal((await r3.json()).error.code, 'BAD_BASE64');

    // Malformed baseline dictionary Base64.
    const r4 = await post('/api/compare', {
      deltaBase64: sample.valid.deltaBase64,
      dictionaryBase64: '1sPE=',
    });
    assert.equal(r4.status, 400);
    assert.equal((await r4.json()).error.code, 'BAD_BASE64');

    // Oversized baseline dictionary.
    const r5 = await post('/api/compare', {
      deltaBase64: sample.valid.deltaBase64,
      dictionaryBase64: 'A'.repeat(64 * 1024 + 4),
    });
    assert.equal(r5.status, 413);
    assert.equal((await r5.json()).error.code, 'PAYLOAD_TOO_LARGE');

    // Body that is not a JSON object.
    const r6 = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2]',
    });
    assert.equal(r6.status, 400);
    assert.equal((await r6.json()).error.code, 'BAD_REQUEST');
  });

  test('an empty candidate dictionary is a valid comparison side', async () => {
    const resp = await compare('');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.baseline.ok, true);
    // The sample stream needs a 20-byte SOURCE segment: empty candidate fails.
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'SOURCE_RANGE');
    assert.equal(data.differences, null);
  });

  test('the page exposes the candidate dictionary input and compare submit', async () => {
    const resp = await fetch(`${base}/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /id="candDict"/);
    assert.match(body, /id="compareBtn"/);
    assert.match(body, /\/api\/compare/);
    assert.match(body, /候选/);
  });
});
