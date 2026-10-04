import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApp,
  diffOutputs,
  MAX_DICT_BASE64_BYTES,
  MAX_DELTA_BASE64_BYTES,
  MAX_DIFF_RANGES,
  DIFF_HEX_PREVIEW_BYTES,
} from '../src/server.js';
import { WindowEncoder, assemble } from './helpers/encoder.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const te = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

// 16-byte dictionary; the delta copies it wholesale, so the final output
// equals the dictionary bytes and every dictionary edit maps to a known
// output offset.
const dictionary = te.encode('ABCDEFGHIJKLMNOP');

function buildCopyDelta() {
  const w = new WindowEncoder('SOURCE', 0, dictionary.length);
  w.copy(0, 16);
  return assemble(w.build());
}

// Two windows: window 2 sources window 1 output, so a dictionary edit shows
// up twice in the final output (offsets are final-output offsets).
function buildTwoWindowDelta() {
  const w1 = new WindowEncoder('SOURCE', 0, 8);
  w1.copy(0, 8);
  const w2 = new WindowEncoder('TARGET', 0, 8);
  w2.copy(0, 8);
  return assemble(w1.build(), w2.build());
}

const copyDeltaB64 = b64(buildCopyDelta());
const twoWindowDeltaB64 = b64(buildTwoWindowDelta());
const dictionaryB64 = b64(dictionary);

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(path, bodyObj) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
}

const compare = (bodyObj) => post('/api/compare', bodyObj);

describe('POST /api/compare', () => {
  test('identical dictionaries decode to identical outputs with no diff ranges', async () => {
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
      candidateDictionaryBase64: dictionaryB64,
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);

    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, true);
    assert.equal(data.baseline.length, 16);
    assert.equal(data.candidate.length, 16);
    assert.equal(data.baseline.sha256, sha256(dictionary));
    assert.equal(data.candidate.sha256, sha256(dictionary));

    assert.equal(data.identical, true);
    assert.equal(data.diff.identical, true);
    assert.equal(data.diff.firstOffset, null);
    assert.equal(data.diff.rangeCount, 0);
    assert.equal(data.diff.differingBytes, 0);
    assert.deepEqual(data.diff.ranges, []);
    assert.equal(data.diff.rangesTruncated, false);
  });

  test('contiguous edits produce one range with both hex digests and first offset', async () => {
    const candidate = te.encode('ABCXYFGHIJKLMNOP'); // offsets 3,4 edited
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
      candidateDictionaryBase64: b64(candidate),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();

    assert.equal(data.identical, false);
    assert.equal(data.diff.identical, false);
    assert.equal(data.diff.firstOffset, 3);
    assert.equal(data.diff.rangeCount, 1);
    assert.equal(data.diff.differingBytes, 2);
    assert.equal(data.diff.ranges.length, 1);

    const [range] = data.diff.ranges;
    assert.equal(range.start, 3);
    assert.equal(range.end, 5);
    assert.equal(range.firstOffset, 3);
    assert.deepEqual(range.baseline, { bytes: 2, hex: '4445', truncated: false });
    assert.deepEqual(range.candidate, { bytes: 2, hex: '5859', truncated: false });

    // Candidate sha256 reflects the candidate output, not the baseline one.
    assert.equal(data.candidate.sha256, sha256(candidate));
    assert.notEqual(data.candidate.sha256, data.baseline.sha256);
  });

  test('scattered edits produce multiple ordered ranges', async () => {
    const candidate = te.encode('ABCXEFGYIJKLMNOP'); // offsets 3 and 7 edited
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
      candidateDictionaryBase64: b64(candidate),
    });
    const data = await resp.json();
    assert.equal(data.diff.rangeCount, 2);
    assert.deepEqual(
      data.diff.ranges.map((r) => [r.start, r.end, r.firstOffset]),
      [
        [3, 4, 3],
        [7, 8, 7],
      ],
    );
    assert.deepEqual(data.diff.ranges[0].baseline.hex, '44');
    assert.deepEqual(data.diff.ranges[1].candidate.hex, '59');
  });

  test('diff offsets are final-output offsets across windows', async () => {
    const dict8 = dictionary.subarray(0, 8);
    const candidate = te.encode('ABXDEFGH'); // offset 2 edited
    const resp = await compare({
      deltaBase64: twoWindowDeltaB64,
      dictionaryBase64: b64(dict8),
      candidateDictionaryBase64: b64(candidate),
    });
    const data = await resp.json();
    assert.equal(data.baseline.length, 16);
    assert.equal(data.candidate.length, 16);
    // The edit appears in window 1 output (offset 2) and, via the TARGET
    // source segment, again in window 2 output (offset 10).
    assert.deepEqual(
      data.diff.ranges.map((r) => [r.start, r.end]),
      [
        [2, 3],
        [10, 11],
      ],
    );
    assert.equal(data.diff.firstOffset, 2);
  });

  test('candidate with invalid Base64 reports a structured candidate-side error only', async () => {
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
      candidateDictionaryBase64: 'not-base64!!',
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);

    // Baseline conclusion stays visible.
    assert.equal(data.baseline.ok, true);
    assert.equal(data.baseline.length, 16);
    assert.equal(data.baseline.sha256, sha256(dictionary));

    // Candidate side carries the existing structured error shape.
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'BAD_BASE64');
    assert.equal(typeof data.candidate.error.message, 'string');
    assert.equal(data.candidate.error.offset, null);

    // No partial candidate output becomes a "difference".
    assert.equal(data.identical, null);
    assert.equal(data.diff, null);
    assert.ok(!('output' in data.baseline));
    assert.ok(!('output' in data.candidate));
  });

  test('oversized candidate dictionary is a candidate-side PAYLOAD_TOO_LARGE', async () => {
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
      candidateDictionaryBase64: 'A'.repeat(MAX_DICT_BASE64_BYTES + 4),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(data.diff, null);
  });

  test('candidate that breaks stream decoding keeps its code and raw offset', async () => {
    // The delta needs SOURCE [0, 16); an 8-byte candidate dictionary fails.
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
      candidateDictionaryBase64: b64(dictionary.subarray(0, 8)),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'SOURCE_RANGE');
    assert.equal(typeof data.candidate.error.offset, 'number');
    assert.equal(data.diff, null);
    assert.equal(data.identical, null);
  });

  test('a failing baseline does not hide a successful candidate', async () => {
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: b64(dictionary.subarray(0, 8)),
      candidateDictionaryBase64: dictionaryB64,
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.baseline.ok, false);
    assert.equal(data.baseline.error.code, 'SOURCE_RANGE');
    assert.equal(typeof data.baseline.error.offset, 'number');
    assert.equal(data.candidate.ok, true);
    assert.equal(data.candidate.length, 16);
    assert.equal(data.diff, null);
  });

  test('missing candidate dictionary field is treated as an empty dictionary', async () => {
    const resp = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: dictionaryB64,
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, false);
    assert.equal(data.candidate.error.code, 'SOURCE_RANGE');
  });

  test('request-level failures keep the /api/decode error semantics', async () => {
    // Missing delta field.
    const r1 = await compare({ dictionaryBase64: dictionaryB64 });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.code, 'BAD_REQUEST');

    // Invalid delta Base64.
    const r2 = await compare({ deltaBase64: '%%%', dictionaryBase64: dictionaryB64 });
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).error.code, 'BAD_BASE64');

    // Oversized delta payload.
    const r3 = await compare({
      deltaBase64: 'A'.repeat(MAX_DELTA_BASE64_BYTES + 4),
      dictionaryBase64: dictionaryB64,
    });
    assert.equal(r3.status, 413);
    assert.equal((await r3.json()).error.code, 'PAYLOAD_TOO_LARGE');

    // Oversized baseline dictionary is request-level (as in /api/decode).
    const r4 = await compare({
      deltaBase64: copyDeltaB64,
      dictionaryBase64: 'A'.repeat(MAX_DICT_BASE64_BYTES + 4),
    });
    assert.equal(r4.status, 413);
    assert.equal((await r4.json()).error.code, 'PAYLOAD_TOO_LARGE');

    // Invalid baseline dictionary Base64 is request-level too.
    const r5 = await compare({ deltaBase64: copyDeltaB64, dictionaryBase64: '%%%' });
    assert.equal(r5.status, 400);
    assert.equal((await r5.json()).error.code, 'BAD_BASE64');
  });

  test('malformed JSON body is rejected with BAD_JSON', async () => {
    const resp = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error.code, 'BAD_JSON');
  });

  test('golden fixture sample matches the recorded compare expectations', async () => {
    const sample = JSON.parse(readFileSync(join(root, 'fixtures', 'samples.json'), 'utf8'));
    const resp = await compare({
      deltaBase64: sample.valid.deltaBase64,
      dictionaryBase64: sample.dictionaryBase64,
      candidateDictionaryBase64: sample.compare.candidateDictionaryBase64,
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.baseline.ok, true);
    assert.equal(data.candidate.ok, true);
    assert.equal(data.baseline.sha256, sample.valid.expectedSha256);
    assert.equal(data.candidate.sha256, sample.compare.expectedCandidateSha256);

    const expected = sample.compare.expectedDiff;
    assert.equal(data.identical, expected.identical);
    assert.equal(data.diff.firstOffset, expected.firstOffset);
    assert.equal(data.diff.rangeCount, expected.rangeCount);
    assert.deepEqual(
      data.diff.ranges.map((r) => [r.start, r.end, r.baseline.hex, r.candidate.hex]),
      expected.ranges.map((r) => [r.start, r.end, r.baselineHex, r.candidateHex]),
    );
  });
});

describe('diffOutputs', () => {
  test('equal outputs are identical with no ranges', () => {
    const d = diffOutputs(te.encode('abc'), te.encode('abc'));
    assert.equal(d.identical, true);
    assert.equal(d.firstOffset, null);
    assert.deepEqual(d.ranges, []);
  });

  test('a longer side contributes a tail range with empty hex for the short side', () => {
    const d = diffOutputs(Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([1, 2]));
    assert.equal(d.identical, false);
    assert.equal(d.rangeCount, 1);
    const [range] = d.ranges;
    assert.deepEqual([range.start, range.end, range.firstOffset], [2, 4, 2]);
    assert.deepEqual(range.baseline, { bytes: 2, hex: '0304', truncated: false });
    assert.deepEqual(range.candidate, { bytes: 0, hex: '', truncated: false });
  });

  test('a trailing difference merges with the length tail into one range', () => {
    const d = diffOutputs(Uint8Array.from([1, 9, 3]), Uint8Array.from([1, 8]));
    assert.equal(d.rangeCount, 1);
    const [range] = d.ranges;
    assert.deepEqual([range.start, range.end], [1, 3]);
    assert.equal(range.baseline.hex, '0903');
    assert.equal(range.candidate.hex, '08');
  });

  test('long ranges carry a truncated hex preview plus the full byte count', () => {
    const a = new Uint8Array(DIFF_HEX_PREVIEW_BYTES + 10).fill(0xaa);
    const b = new Uint8Array(DIFF_HEX_PREVIEW_BYTES + 10).fill(0xbb);
    const d = diffOutputs(a, b);
    assert.equal(d.rangeCount, 1);
    const [range] = d.ranges;
    assert.equal(range.baseline.bytes, DIFF_HEX_PREVIEW_BYTES + 10);
    assert.equal(range.baseline.hex.length, DIFF_HEX_PREVIEW_BYTES * 2);
    assert.equal(range.baseline.truncated, true);
    assert.equal(range.candidate.truncated, true);
  });

  test('range listing is capped while the totals stay exact', () => {
    // 300 alternating single-byte differences -> 300 ranges.
    const a = new Uint8Array(600);
    const b = new Uint8Array(600);
    for (let i = 0; i < 600; i += 2) b[i] = 1;
    const d = diffOutputs(a, b);
    assert.equal(d.rangeCount, 300);
    assert.equal(d.differingBytes, 300);
    assert.equal(d.rangesTruncated, true);
    assert.equal(d.ranges.length, MAX_DIFF_RANGES);
    assert.equal(d.firstOffset, 0);
    // Ranges remain ordered by output offset.
    for (let i = 1; i < d.ranges.length; i++) {
      assert.ok(d.ranges[i].start > d.ranges[i - 1].start);
    }
  });
});

describe('regression: existing surfaces unchanged', () => {
  test('GET / serves the page with the candidate dictionary input', async () => {
    const resp = await fetch(`${base}/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /id="cand"/);
    assert.match(body, /id="compareBtn"/);
    assert.match(body, /\/api\/compare/);
    // Existing affordances are still there.
    assert.match(body, /id="dict"/);
    assert.match(body, /清空输入与结论/);
  });

  test('POST /api/decode response shape is untouched', async () => {
    const sample = JSON.parse(readFileSync(join(root, 'fixtures', 'samples.json'), 'utf8'));
    const resp = await post('/api/decode', {
      deltaBase64: sample.valid.deltaBase64,
      dictionaryBase64: sample.dictionaryBase64,
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.deepEqual(
      Object.keys(data).sort(),
      ['length', 'limits', 'ok', 'sha256', 'windows'],
    );
    assert.deepEqual(Object.keys(data.limits).sort(), ['maxOutputBytes', 'maxWindows']);
  });

  test('POST /api/reset still acknowledges', async () => {
    const resp = await fetch(`${base}/api/reset`, { method: 'POST' });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  });
});
