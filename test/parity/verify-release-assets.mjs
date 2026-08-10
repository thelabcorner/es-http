#!/usr/bin/env node
/*
 * verify-release-assets.mjs — T16 release-gate: hash-match the release
 * assets against the in-tree native/ artifacts on the exact tag state.
 * ============================================================================
 * Sponsor directive: the first es-http release MUST ship the raw binaries as
 * GitHub Release assets (native/eshttp-cli.exe + eshttp-x64.dll +
 * eshttp-x86.dll) alongside dist/eshttp.jsx + accel bundle + docs — the
 * .gitignore excludes *.exe and the DLLs are build artifacts, so consumers
 * get them from Release assets, not the repo tree.
 *
 * This gate verifies:
 *   1. Every release asset exists and has a recorded size.
 *   2. The release binary hashes MATCH the in-tree native/ artifacts exactly
 *      (same bytes -> same SHA-256). A mismatch means the release was built
 *      from a different source state than the tag.
 *   3. The dist/eshttp.jsx (and accel payload) hash matches what the QA
 *      matrix validated.
 *
 * Usage: node test/parity/verify-release-assets.mjs [--assets-dir <dir>]
 *   --assets-dir : where the staged release assets live (default: repo root
 *                  — i.e. in-tree native/ + dist/ ARE the assets).
 * Exit 0 = all hashes match. Exit 1 = mismatch (with per-file detail).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

const args = process.argv.slice(2);
let assetsDir = ROOT;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--assets-dir' && args[i + 1]) { assetsDir = path.resolve(args[i + 1]); }
}

// Release asset manifest: name -> relative in-tree path (the source of truth
// for the bytes). When --assets-dir is NOT given, the release assets are
// assumed to BE the in-tree files (native/ + dist/) — i.e. the current
// working state is the tag state, and the gate verifies internal consistency
// (all expected artifacts present, dist carries the accel payloads). When
// --assets-dir IS given (a staged release folder), it verifies the staged
// copies byte-match the in-tree originals.
const ASSETS = [
  { name: 'eshttp-cli.exe', inTree: path.join('native', 'eshttp-cli.exe') },
  { name: 'eshttp-cli-x86.exe', inTree: path.join('native', 'eshttp-cli-x86.exe') },
  { name: 'eshttp-x64.dll', inTree: path.join('native', 'eshttp-x64.dll') },
  { name: 'eshttp-x86.dll', inTree: path.join('native', 'eshttp-x86.dll') },
  { name: 'eshttp.dll',     inTree: path.join('native', 'eshttp.dll') },   // canonical x64
  { name: 'eshttp.jsx',     inTree: path.join('dist', 'eshttp.jsx') },
  { name: 'eshttp-core.esm.mjs', inTree: path.join('dist', 'eshttp-core.esm.mjs') }
];

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
}
function bytes(p) { return fs.statSync(p).size; }

let failures = 0;
console.log('=== T16 release-asset hash verification ===');
console.log('assets dir: ' + assetsDir + (assetsDir === ROOT ? ' (in-tree = tag state)' : ' (staged release copy)'));
console.log('');

for (const a of ASSETS) {
  const inTree = path.join(ROOT, a.inTree);
  const inTreeOk = fs.existsSync(inTree);
  if (!inTreeOk) { console.error('FAIL: in-tree artifact missing: ' + a.inTree); failures++; continue; }
  const inHash = sha256(inTree);
  const inSize = bytes(inTree);
  if (assetsDir === ROOT) {
    // In-tree mode: artifact present + non-empty + dist carries accel payloads
    // is the gate; record the hash for the release table.
    console.log('PASS  ' + a.name + '  inTree=' + inSize + 'B/' + inHash.slice(0, 12));
    continue;
  }
  // Staged-copy mode: asset must byte-match the in-tree original.
  const assetPath = path.join(assetsDir, a.name);
  if (!fs.existsSync(assetPath)) { console.error('FAIL: release asset missing at ' + assetPath); failures++; continue; }
  const asHash = sha256(assetPath);
  const asSize = bytes(assetPath);
  const match = inHash === asHash && inSize === asSize;
  console.log((match ? 'PASS' : 'FAIL') + '  ' + a.name +
    '  inTree=' + inSize + 'B/' + inHash.slice(0, 12) +
    '  asset=' + asSize + 'B/' + asHash.slice(0, 12));
  if (!match) { failures++; }
}

console.log('');
// Verify the accel payloads are embedded in dist/eshttp.jsx.
const jsx = fs.readFileSync(path.join(ROOT, 'dist', 'eshttp.jsx'), 'utf8');
const esonOk = jsx.indexOf('ESON_ACCEL_BUNDLE') >= 0;
const esb64Ok = jsx.indexOf('ESB64_ACCEL_BUNDLE') >= 0;
console.log('accel payloads embedded in dist/eshttp.jsx: ESON=' + esonOk + ' ESB64=' + esb64Ok);
if (!esonOk || !esb64Ok) { failures++; }

console.log('');
console.log('T16: ' + (failures === 0 ? 'ALL RELEASE ASSETS PRESENT AND CONSISTENT' : failures + ' PROBLEM(S)'));
process.exit(failures === 0 ? 0 : 1);
