// Single-shot verification entrypoint used by the `verify` Compose service.
// Runs, in order:
//   1. decoding unit tests (node --test)
//   2. build check (node --check on every source file)
//   3. interface/HTTP smoke test against a freshly started real server
// Exits non-zero on the first failed stage.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function run(cmd, args, label) {
  return new Promise((resolve) => {
    console.log(`\n=== [${label}] ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForHealth(baseUrl, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.status === 200) return true;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function smokeTest(baseUrl) {
  console.log(`\n=== [smoke] interface checks on ${baseUrl}`);
  let failures = 0;
  const expect = (cond, what) => {
    console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}`);
    if (!cond) failures += 1;
  };

  const health = await fetch(`${baseUrl}/healthz`).then((r) => r.json());
  expect(health.status === 'ok', 'GET /healthz -> {"status":"ok"}');

  const page = await fetch(`${baseUrl}/`).then((r) => r.text());
  expect(page.includes('增量标定片'), 'GET / serves the workbench page');

  const samples = JSON.parse(readFileSync(join(root, 'fixtures', 'samples.json'), 'utf8'));

  // --- happy path: length + sha256 + per-window source ranges + evidence ---
  const okResp = await fetch(`${baseUrl}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deltaBase64: samples.valid.deltaBase64,
      dictionaryBase64: samples.dictionaryBase64,
    }),
  });
  expect(okResp.status === 200, `valid sample HTTP 200 (got ${okResp.status})`);
  const ok = await okResp.json();
  expect(ok.ok === true, 'valid sample ok=true');
  expect(ok.length === samples.valid.expectedLength, `final length ${ok.length} == ${samples.valid.expectedLength}`);
  expect(ok.sha256 === samples.valid.expectedSha256, `sha256 ${ok.sha256}`);
  expect(ok.windows.length === samples.valid.expectedWindowCount, `window count ${ok.windows.length}`);
  const w2 = ok.windows[1];
  expect(w2.source.kind === 'TARGET' && w2.source.position === 5 && w2.source.length === 11,
    `window 2 source range TARGET [5,+11) (got ${w2.source.kind} [${w2.source.position},+${w2.source.length}))`);
  const copyModes = w2.instructions.filter((i) => i.op === 'COPY').map((i) => i.mode);
  expect(JSON.stringify(copyModes) === JSON.stringify(['SELF', 'NEAR0', 'SAME0']),
    `window 2 copy modes SELF/NEAR0/SAME0 (got ${copyModes})`);
  expect(w2.instructions.every((ins, idx) => ins.seq === idx), 'instructions listed in execution order');

  // --- failure path: first raw offset, no output ---------------------------
  const badResp = await fetch(`${baseUrl}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deltaBase64: samples.badCopy.deltaBase64,
      dictionaryBase64: samples.dictionaryBase64,
    }),
  });
  expect(badResp.status === 400, `bad-copy sample HTTP 400 (got ${badResp.status})`);
  const bad = await badResp.json();
  expect(bad.ok === false && bad.error.code === 'COPY_NOT_GENERATED',
    `bad-copy code COPY_NOT_GENERATED (got ${bad.error?.code})`);
  expect(bad.error.offset === samples.badCopy.expectedOffset,
    `first raw offset ${bad.error.offset} == ${samples.badCopy.expectedOffset}`);
  expect(!('length' in bad) && !('windows' in bad), 'failure response retains no partial output');

  // --- non-minimal integer failure ------------------------------------------
  const nmResp = await fetch(`${baseUrl}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deltaBase64: samples.nonMinimal.deltaBase64,
      dictionaryBase64: samples.dictionaryBase64,
    }),
  });
  const nm = await nmResp.json();
  expect(nmResp.status === 400 && nm.error.code === 'NON_MINIMAL_INTEGER',
    `non-minimal integer rejected at offset ${nm.error?.offset}`);

  // --- malformed base64 ------------------------------------------------------
  const b64Resp = await fetch(`${baseUrl}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deltaBase64: 'not-base64!!' }),
  });
  expect((await b64Resp.json()).error.code === 'BAD_BASE64', 'malformed Base64 rejected');

  // --- reset endpoint --------------------------------------------------------
  const resetResp = await fetch(`${baseUrl}/api/reset`, { method: 'POST' });
  expect(resetResp.status === 200, 'POST /api/reset -> 200');

  // --- dictionary comparison: identical candidate ----------------------------
  const cmpResp = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deltaBase64: samples.valid.deltaBase64,
      dictionaryBase64: samples.dictionaryBase64,
      candidateDictionaryBase64: samples.dictionaryBase64,
    }),
  });
  const cmp = await cmpResp.json();
  expect(cmpResp.status === 200 && cmp.ok === true, 'compare identical candidate HTTP 200 ok=true');
  expect(cmp.baseline?.ok === true && cmp.candidate?.ok === true, 'compare: both sides decoded');
  expect(cmp.baseline?.sha256 === samples.valid.expectedSha256 &&
    cmp.candidate?.sha256 === samples.valid.expectedSha256,
    'compare: both sides reproduce the expected SHA-256');
  expect(cmp.identical === true && Array.isArray(cmp.differences) && cmp.differences.length === 0,
    'compare: identical outputs report no difference ranges');

  // --- dictionary comparison: re-exported candidate differs ------------------
  const reexported = Buffer.from('ABCDEFGHIJKLMNOPQRSTU').toString('base64'); // 21 bytes
  const cmpDiffResp = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deltaBase64: samples.valid.deltaBase64,
      dictionaryBase64: samples.dictionaryBase64,
      candidateDictionaryBase64: reexported,
    }),
  });
  const cmpDiff = await cmpDiffResp.json();
  expect(cmpDiff.identical === false && Array.isArray(cmpDiff.differences),
    'compare: re-exported candidate reports difference ranges');
  expect(cmpDiff.differences?.length === 4 &&
    cmpDiff.differences[0].start === 0 && cmpDiff.differences[0].firstOffset === 0,
    `compare: first range starts at offset 0 (got ${JSON.stringify(cmpDiff.differences?.[0])})`);
  expect(cmpDiff.differences?.every((d) => d.firstOffset === d.start &&
    typeof d.baselineHex === 'string' && typeof d.candidateHex === 'string'),
    'compare: every range carries firstOffset and both hex digests');

  // --- dictionary comparison: failing candidate keeps the baseline -----------
  const cmpBadResp = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deltaBase64: samples.valid.deltaBase64,
      dictionaryBase64: samples.dictionaryBase64,
      candidateDictionaryBase64: Buffer.from('0123456789').toString('base64'), // too short
    }),
  });
  const cmpBad = await cmpBadResp.json();
  expect(cmpBadResp.status === 200 && cmpBad.ok === true, 'compare with failing candidate still HTTP 200');
  expect(cmpBad.baseline?.ok === true && cmpBad.baseline?.sha256 === samples.valid.expectedSha256,
    'compare: baseline conclusion retained when candidate fails');
  expect(cmpBad.candidate?.ok === false && cmpBad.candidate?.error?.code === 'SOURCE_RANGE' &&
    typeof cmpBad.candidate?.error?.offset === 'number',
    `compare: candidate side reports SOURCE_RANGE with offset (got ${cmpBad.candidate?.error?.code})`);
  expect(cmpBad.identical === null && cmpBad.differences === null,
    'compare: failed candidate contributes no difference result');

  return failures === 0;
}

async function main() {
  // In Compose, SMOKE_BASE_URL points at the running "web" service.
  // Standalone: a fresh local server is started on SMOKE_PORT.
  const externalBase = process.env.SMOKE_BASE_URL;
  const port = process.env.SMOKE_PORT ?? '18080';
  const localBase = `http://127.0.0.1:${port}`;

  const testCode = await run(process.execPath, ['--test', 'test/'], 'unit tests');
  if (testCode !== 0) {
    console.error('\nVERIFY FAILED: unit tests');
    process.exit(1);
  }

  const checkCode = await run(process.execPath, ['scripts/check-syntax.js'], 'build check');
  if (checkCode !== 0) {
    console.error('\nVERIFY FAILED: build check');
    process.exit(1);
  }

  let baseUrl = externalBase;
  let server = null;

  if (!baseUrl) {
    console.log(`\n=== [smoke] starting local server on port ${port}`);
    server = spawn(process.execPath, ['src/server.js'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    });
    server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    baseUrl = localBase;
  }

  let ok = false;
  try {
    if (!(await waitForHealth(baseUrl))) {
      console.error(`server at ${baseUrl} did not become healthy in time`);
    } else {
      ok = await smokeTest(baseUrl);
    }
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => server.on('exit', r));
    }
  }

  if (ok) {
    console.log('\nVERIFY PASSED: unit tests + build check + HTTP smoke all green');
    process.exit(0);
  }
  console.error('\nVERIFY FAILED: HTTP smoke');
  process.exit(1);
}

main().catch((err) => {
  console.error('VERIFY ERRORED:', err);
  process.exit(1);
});
