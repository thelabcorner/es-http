#!/usr/bin/env node
/*
 * esb64-parity.mjs - differential parity harness: eshttp base64 + UTF-8
 *                    vs ESB64 (the sibling read-only reference repo).
 * ============================================================================
 * eshttp's codec helpers (`eshttp.helpers.base64Encode/base64Decode/
 * utf8Encode/utf8Decode/utf8ByteLength`) must agree with ESB64 lane-for-lane:
 *
 *   eshttp.helpers.base64Encode  <->  ESB64.btoa       (latin1 -> base64)
 *   eshttp.helpers.base64Decode  <->  ESB64.atob       (WHATWG forgiving-base64)
 *   eshttp.helpers.utf8Encode    <->  ESB64.utf8Encode (TextEncoder semantics)
 *   eshttp.helpers.utf8Decode    <->  ESB64.utf8Decode (WHATWG UTF-8 decoder)
 *   eshttp.helpers.utf8ByteLength<->  ESB64.utf8Encode(x).length
 *
 * The library is loaded EXACTLY the way test/harness.js loads it (via the
 * shared test/load-core.mjs — ESM core bundle when built, original jsxinc
 * fallback), so the real shipping code is under test - not a transcription.
 *
 * NOTE (2026-08-10, coordinator decision): the eshttp base64/UTF-8 lanes are
 * thin adapters over the ESB64 library (vendor-b64.ts), so this differential
 * harness validates that the adapter surface (eshttp.helpers.base64Encode/
 * base64Decode/utf8Encode/utf8Decode/utf8ByteLength) still matches ESB64
 * lane-for-lane through the eshttp facade.
 *
 * Corpora: ESB64's own tests/vectors.ts + tests/wpt-b64-corpus.ts (bundled
 * on the fly with the esbuild that ships in esb64/node_modules), plus the
 * ESB64 fuzz generators re-implemented against the same seeded PRNG.
 *
 * RUN
 *   node test/parity/esb64-parity.mjs              # vectors + WPT + fuzz
 *   node test/parity/esb64-parity.mjs 20000 7      # iterations, seed
 *
 * Exit 0 = full parity. Exit 1 = at least one divergence.
 *
 * QA infrastructure only - NOT part of the eshttp library. Never writes to
 * the esb64 repo (read-only source of truth); the bundle it produces lands
 * in eshttp/test/parity/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCore } from '../load-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ESHTTP_ROOT = join(HERE, '..', '..');
const ESB64_ROOT = join(ESHTTP_ROOT, '..', 'esb64');
const CORE = join(ESB64_ROOT, 'dist', 'esb64-core.esm.mjs');
const CORPUS_ENTRY = join(HERE, '.corpus-entry.ts');
const CORPUS_BUNDLE = join(HERE, '.corpus.bundle.mjs');

const iterations = parseInt(process.argv[2] || '5000', 10);
const seed = parseInt(process.argv[3] || '42', 10);

// ---------------------------------------------------------------------------
// 1. Load ESB64 (reference) + the ESB64 test corpora
// ---------------------------------------------------------------------------
if (!fs.existsSync(CORE)) {
  console.error('esb64 core bundle missing: ' + CORE + ' (run `node esb64-build.mjs` in esb64/)');
  process.exit(2);
}
const ESB64 = await import(pathToFileURL(CORE).href);

function findEsbuild() {
  const direct = join(ESB64_ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (fs.existsSync(direct)) return direct;
  return 'npx esbuild';
}

// Re-export esb64's TS corpora as ESM so this harness can consume them without
// copying (and therefore without ever drifting from) the source of truth.
fs.writeFileSync(CORPUS_ENTRY,
  "export { makeB64Vectors, makeAtobVectors, makeUtf8Vectors, makeMixedPayload } from " +
  JSON.stringify(join(ESB64_ROOT, 'tests', 'vectors.ts').replace(/\\/g, '/')) + ";\n" +
  "export { WPT_B64_CORPUS } from " +
  JSON.stringify(join(ESB64_ROOT, 'tests', 'wpt-b64-corpus.ts').replace(/\\/g, '/')) + ";\n",
  'utf8');

execFileSync(process.execPath, [findEsbuild(),
  CORPUS_ENTRY, '--bundle', '--outfile=' + CORPUS_BUNDLE,
  '--format=esm', '--platform=node', '--target=es2019', '--log-level=warning'
], { stdio: 'inherit' });

const CORPUS = await import(pathToFileURL(CORPUS_BUNDLE).href);

// ---------------------------------------------------------------------------
// 2. Load eshttp (subject) via the shared core loader (same as harness.js)
// ---------------------------------------------------------------------------
const _core = await loadCore({ source: process.env.ESHTTP_CORE || 'esm' });
const eshttp = _core.eshttp;
const H = eshttp.helpers;

// ---------------------------------------------------------------------------
// 3. Comparison plumbing
// ---------------------------------------------------------------------------
let checks = 0;
const divergences = [];

// Normalize a lane call to a comparable value: either the result string, or a
// 'THREW:<name>' marker so error TYPES are compared, not just thrown-ness
// (ESB64 throws Error{name:'InvalidCharacterError'}).
function run(fn) {
  try {
    return fn();
  } catch (e) {
    return 'THREW:' + (e && e.name ? e.name : 'unknown');
  }
}

function show(v) {
  const s = typeof v === 'string' ? v : String(v);
  return JSON.stringify(s.length > 90 ? s.slice(0, 90) + '\u2026' : s);
}

function check(lane, name, ours, theirs) {
  checks++;
  if (ours !== theirs) {
    divergences.push({ lane, name, ours: show(ours), theirs: show(theirs) });
  }
}

// A lane pair: run both sides over the same input and compare.
function diff(lane, name, input, oursFn, theirsFn) {
  check(lane, name, run(() => oursFn(input)), run(() => theirsFn(input)));
}

const B64_ENC = (x) => H.base64Encode(x);
const B64_DEC = (x) => H.base64Decode(x);
const U8_ENC = (x) => H.utf8Encode(x);
const U8_DEC = (x) => H.utf8Decode(x);
const U8_LEN = (x) => H.utf8ByteLength(x);

const REF_ENC = (x) => ESB64.btoa(x);
const REF_DEC = (x) => ESB64.atob(x);
const REF_U8ENC = (x) => ESB64.utf8Encode(x);
const REF_U8DEC = (x) => ESB64.utf8Decode(x);
const REF_U8LEN = (x) => ESB64.utf8Encode(x).length;

// ---------------------------------------------------------------------------
// 4. Vector corpora (ESB64's own)
// ---------------------------------------------------------------------------

// --- 4.1 btoa/base64Encode vectors ---
for (const v of CORPUS.makeB64Vectors()) {
  diff('base64Encode', 'vector:' + v.name, v.input, B64_ENC, REF_ENC);
  // and against Node's native btoa (third oracle)
  diff('base64Encode', 'native:' + v.name, v.input, B64_ENC, (x) => btoa(x));
}

// --- 4.2 atob/base64Decode vectors ---
for (const v of CORPUS.makeAtobVectors()) {
  diff('base64Decode', 'vector:' + v.name, v.input, B64_DEC, REF_DEC);
  diff('base64Decode', 'native:' + v.name, v.input, B64_DEC, (x) => atob(x));
}

// --- 4.3 WPT forgiving-base64 corpus ---
for (const [input, expected] of CORPUS.WPT_B64_CORPUS) {
  diff('base64Decode', 'wpt:' + JSON.stringify(input), input, B64_DEC, REF_DEC);
  if (expected !== null) {
    let text = '';
    for (const b of expected) text += String.fromCharCode(b);
    check('base64Decode', 'wpt-expect:' + JSON.stringify(input), run(() => B64_DEC(input)), text);
  }
}

// --- 4.4 UTF-8 vectors ---
for (const v of CORPUS.makeUtf8Vectors()) {
  if (v.input !== undefined) {
    diff('utf8Encode', 'vector:' + v.name, v.input, U8_ENC, REF_U8ENC);
    diff('utf8ByteLength', 'vector:' + v.name, v.input, U8_LEN, REF_U8LEN);
    // Buffer parity for the byte string itself
    check('utf8Encode', 'buffer:' + v.name, run(() => U8_ENC(v.input)),
      Buffer.from(v.input, 'utf8').toString('binary'));
    // full pipeline: encodeUtf8 == btoa(utf8Encode(x))
    check('encodeUtf8', 'pipeline:' + v.name, run(() => B64_ENC(U8_ENC(v.input))),
      run(() => ESB64.encodeUtf8(v.input)));
  }
  if (v.byteB64 !== undefined) {
    const bytes = run(() => REF_DEC(v.byteB64));
    diff('utf8Decode', 'vector:' + v.name, bytes, U8_DEC, REF_U8DEC);
    if (v.expect !== undefined) {
      check('utf8Decode', 'expect:' + v.name, run(() => U8_DEC(bytes)), v.expect);
    }
  }
}

// --- 4.5 mixed payload pipeline ---
{
  const mixed = CORPUS.makeMixedPayload();
  diff('utf8Encode', 'mixed', mixed, U8_ENC, REF_U8ENC);
  diff('utf8ByteLength', 'mixed', mixed, U8_LEN, REF_U8LEN);
  check('roundtrip', 'mixed utf8', run(() => U8_DEC(U8_ENC(mixed))), mixed);
  check('roundtrip', 'mixed b64+utf8', run(() => U8_DEC(B64_DEC(B64_ENC(U8_ENC(mixed))))), mixed);
}

// --- 4.6 targeted edge cases beyond the shared corpora ---
const EDGE_DECODE = [
  '', '=', '==', '===', '====', 'A', 'AB', 'ABC', 'ABCD', 'ABCDE',
  'AB==', 'A===', 'ABC=', 'AB=C', 'A=BC', '=ABC', 'AB=', 'ABC==',
  ' ', '\t', '\n', '\r', '\f', '\v', ' \t\n\r\f', '\u00a0', '\u2003',
  'Zm9v', ' Zm9v ', 'Z m 9 v', 'Zm9v\n', '\nZm9v', 'Zm\t9v',
  'Zm9v=', 'Zm9v==', 'Zm9v===', 'Zg==Zg==', 'Zg==\nZg==',
  'Zm9v!', 'Zm9v-', 'Zm9v_', 'Zm9v.', 'Zm9v*', 'Zm9v+', 'Zm9v/',
  '++++', '////', '+/+/', '/+/+', '\u00e9', '\u0000', '\u007f', '\uffff',
  'ab\u0000cd', 'YWJj\u0000', '__proto__', 'constructor', 'toString',
  '/w==', 'AA==', 'AIAB', '5pel5pys6Kqe', '8J+YgA==',
  // long padding runs
  'a' + '='.repeat(1000), 'ab' + '='.repeat(1000), 'abcd' + '='.repeat(1000),
  // large valid payloads
  'QUJDRA=='.repeat(500), btoa('x'.repeat(10000)), btoa('\u00ff'.repeat(5000))
];
for (const s of EDGE_DECODE) {
  diff('base64Decode', 'edge:' + show(s), s, B64_DEC, REF_DEC);
}

const EDGE_ENCODE = [
  '', 'a', 'ab', 'abc', 'abcd', '\u0000', '\u0000\u0000', '\u0000\u0000\u0000',
  '\u00ff', '\u00ff\u00ff', '\u007f', '\u0080', '\u00e9\u0080',
  '\u0100', '\u0101', '\uffff', '\ud800', '\udc00', '\ud83d\ude00', '\ud800a',
  'x'.repeat(10000), '\u00ff'.repeat(5000),
  123, null, false, undefined, 0, -1, 1.5, NaN
];
for (const s of EDGE_ENCODE) {
  diff('base64Encode', 'edge:' + show(s), s, B64_ENC, REF_ENC);
}

const EDGE_UTF8 = [
  '', 'hello', '\u0000', '\u007f', '\u0080', '\u07ff', '\u0800', '\ud7ff',
  '\ue000', '\ufffd', '\ufeff', '\ufeffabc', '\uffff',
  '\ud83d\ude00', '\ud800\udc00', '\udbff\udfff',
  '\ud800', '\udc00', '\ud800a', 'a\udc00', '\ud800\ud800', '\udc00\udc00',
  '\ud800\ud83d\ude00', 'caf\u00e9', '\u65e5\u672c\u8a9e', '\u03c0',
  '\u0000\u007f\u00ff', 'x'.repeat(5000), '\u65e5'.repeat(3000),
  '\ud83d\ude00'.repeat(2000)
];
for (const s of EDGE_UTF8) {
  diff('utf8Encode', 'edge:' + show(s), s, U8_ENC, REF_U8ENC);
  diff('utf8ByteLength', 'edge:' + show(s), s, U8_LEN, REF_U8LEN);
  check('utf8Encode', 'buffer-edge:' + show(s), run(() => U8_ENC(s)),
    Buffer.from(s, 'utf8').toString('binary'));
}

// Raw byte strings through the decoder (malformed sequences included).
const EDGE_BYTES = [
  '', '\u0000', '\u007f', '\u0080', '\u00bf', '\u00c0', '\u00c1', '\u00c2',
  '\u00c2\u0080', '\u00c2', '\u00df\u00bf', '\u00e0', '\u00e0\u00a0',
  '\u00e0\u00a0\u0080', '\u00e0\u009f\u00bf', '\u00ed\u00a0\u0080',
  '\u00ed\u009f\u00bf', '\u00ee\u0080\u0080', '\u00ef\u00bf\u00bd',
  '\u00ef\u00bb\u00bf', '\u00f0', '\u00f0\u0090', '\u00f0\u0090\u0080',
  '\u00f0\u0090\u0080\u0080', '\u00f0\u008f\u00bf\u00bf',
  '\u00f4\u008f\u00bf\u00bf', '\u00f4\u0090\u0080\u0080', '\u00f5\u0080\u0080\u0080',
  '\u00f8', '\u00fe', '\u00ff', '\u00ff\u00fe', '\u00c0\u0080',
  '\u00e0\u0080\u0080', '\u00f0\u0080\u0080\u0080',
  '\u00c3\u0090/', 'a\u0080b', 'a\u00c2b', '\u00c2a', '\u00e6\u0097\u00a5',
  'hello world', '\u0000\u0001\u0002\u0003'
];
for (const s of EDGE_BYTES) {
  diff('utf8Decode', 'edge:' + show(s), s, U8_DEC, REF_U8DEC);
}

// Every single byte 0x00-0xFF standalone, and every 2-byte prefix pair.
for (let b = 0; b < 256; b++) {
  const s = String.fromCharCode(b);
  diff('utf8Decode', 'byte:' + b, s, U8_DEC, REF_U8DEC);
  diff('base64Encode', 'byte:' + b, s, B64_ENC, REF_ENC);
  diff('base64Decode', 'byte:' + b, s, B64_DEC, REF_DEC);
}
for (let b = 0xc0; b < 0x100; b++) {
  for (let c = 0; c < 0x100; c += 7) {
    const s = String.fromCharCode(b) + String.fromCharCode(c);
    diff('utf8Decode', 'pair:' + b + ',' + c, s, U8_DEC, REF_U8DEC);
  }
}

// ---------------------------------------------------------------------------
// 5. Fuzz (same seeded LCG + generators as esb64/tests/fuzz-entry.ts)
// ---------------------------------------------------------------------------
let state = seed >>> 0;
function rnd() {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 4294967296;
}
function rndInt(max) { return Math.floor(rnd() * max); }

function latin1String(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(rndInt(256));
  return s;
}
function asciiString(len) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \t\n\f\r';
  let s = '';
  for (let i = 0; i < len; i++) s += alpha.charAt(rndInt(alpha.length));
  return s;
}
function unicodeString(len) {
  const ranges = [[0x20, 0x7e], [0x80, 0x7ff], [0x800, 0xd7ff], [0xe000, 0xffff], [0x10000, 0x10ffff]];
  let s = '';
  for (let i = 0; i < len; i++) {
    const r = ranges[rndInt(ranges.length)];
    const cp = r[0] + rndInt(r[1] - r[0] + 1);
    if (cp >= 0x10000) {
      const c = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      s += String.fromCharCode(cp);
    }
  }
  return s;
}
function loneSurrogateString(len) {
  const pieces = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud800a', 'b\udc00', '\ud83d\ude00', '\ud800\ud83d\ude00', 'x'];
  let s = '';
  for (let i = 0; i < len; i++) s += pieces[rndInt(pieces.length)];
  return s;
}
function byteString(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(rndInt(256));
  return s;
}

// F1. base64Encode vs ESB64.btoa + native btoa on random latin1.
for (let i = 0; i < iterations; i++) {
  const s = latin1String(rndInt(300));
  diff('base64Encode', 'fuzz latin1', s, B64_ENC, REF_ENC);
  diff('base64Encode', 'fuzz latin1 native', s, B64_ENC, (x) => btoa(x));
}
// F2. base64Encode on arbitrary unicode (must reject like btoa).
for (let i = 0; i < iterations; i++) {
  const u = unicodeString(rndInt(40));
  diff('base64Encode', 'fuzz unicode', u, B64_ENC, REF_ENC);
}
// F3. base64Decode on random b64-ish ASCII (alphabet + ws + '=').
for (let i = 0; i < iterations; i++) {
  const b = asciiString(rndInt(200));
  diff('base64Decode', 'fuzz ascii', b, B64_DEC, REF_DEC);
  diff('base64Decode', 'fuzz ascii native', b, B64_DEC, (x) => atob(x));
}
// F4. base64Decode on mutated valid base64.
for (let i = 0; i < iterations; i++) {
  const raw = latin1String(rndInt(100));
  const good = btoa(raw);
  const mut = good.split('');
  const nMut = rndInt(4);
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=!';
  for (let m = 0; m < nMut && mut.length > 0; m++) {
    mut[rndInt(mut.length)] = alpha.charAt(rndInt(alpha.length));
  }
  const mutated = mut.join('');
  diff('base64Decode', 'fuzz mutated', mutated, B64_DEC, REF_DEC);
}
// F5. utf8Encode + utf8ByteLength vs ESB64/Buffer on unicode.
for (let i = 0; i < iterations; i++) {
  const us = unicodeString(rndInt(60));
  diff('utf8Encode', 'fuzz unicode', us, U8_ENC, REF_U8ENC);
  diff('utf8ByteLength', 'fuzz unicode', us, U8_LEN, REF_U8LEN);
  check('utf8ByteLength', 'fuzz buffer', run(() => U8_LEN(us)), Buffer.byteLength(us, 'utf8'));
}
// F6. utf8 round trip.
for (let i = 0; i < iterations; i++) {
  const rs = unicodeString(rndInt(60));
  check('roundtrip', 'fuzz utf8', run(() => U8_DEC(U8_ENC(rs))), rs);
}
// F7. utf8Decode vs ESB64 on RANDOM BYTES (malformed sequences dominate -
//     this is the lane where a naive decoder diverges hardest).
for (let i = 0; i < iterations; i++) {
  const bs = byteString(rndInt(80));
  diff('utf8Decode', 'fuzz bytes', bs, U8_DEC, REF_U8DEC);
}
// F8. utf8Decode vs TextDecoder on VALID streams only.
for (let i = 0; i < iterations; i++) {
  const bytes = REF_U8ENC(unicodeString(rndInt(60)));
  check('utf8Decode', 'fuzz TextDecoder', run(() => U8_DEC(bytes)),
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(bytes, 'binary')));
}
// F9. lone surrogates.
for (let i = 0; i < iterations; i++) {
  const ls = loneSurrogateString(rndInt(20) + 1);
  diff('base64Encode', 'fuzz lone-surrogate', ls, B64_ENC, REF_ENC);
  diff('utf8Encode', 'fuzz lone-surrogate', ls, U8_ENC, REF_U8ENC);
  diff('utf8ByteLength', 'fuzz lone-surrogate', ls, U8_LEN, REF_U8LEN);
  check('roundtrip', 'fuzz lone-surrogate', run(() => U8_DEC(U8_ENC(ls))),
    Buffer.from(ls, 'utf8').toString('utf8'));
}
// F10. NUL + C0 controls.
for (let i = 0; i < iterations; i++) {
  let ctrl = '';
  const cn = rndInt(40);
  for (let ci = 0; ci < cn; ci++) ctrl += String.fromCharCode(rndInt(64));
  diff('utf8Encode', 'fuzz control', ctrl, U8_ENC, REF_U8ENC);
  diff('base64Encode', 'fuzz control', ctrl, B64_ENC, REF_ENC);
  check('roundtrip', 'fuzz control', run(() => U8_DEC(U8_ENC(ctrl))), ctrl);
}
// F11. binary round trip through base64 (the wire path: bodyBytes).
for (let i = 0; i < iterations; i++) {
  const raw = latin1String(rndInt(200));
  check('roundtrip', 'fuzz binary b64', run(() => B64_DEC(B64_ENC(raw))), raw);
}

// ---------------------------------------------------------------------------
// 6. Report
// ---------------------------------------------------------------------------
try { fs.rmSync(CORPUS_BUNDLE); } catch (ignore) {}
try { fs.rmSync(CORPUS_ENTRY); } catch (ignore) {}

const byLane = {};
for (const d of divergences) {
  byLane[d.lane] = (byLane[d.lane] || 0) + 1;
}

if (divergences.length > 0) {
  console.error('eshttp<->ESB64 parity: ' + divergences.length + ' divergence(s) of ' + checks + ' checks (seed ' + seed + ')');
  console.error('  by lane: ' + JSON.stringify(byLane));
  const seen = {};
  let shown = 0;
  for (const d of divergences) {
    // one sample per (lane, ours, theirs) shape keeps the report readable
    const key = d.lane + '|' + d.ours + '|' + d.theirs;
    if (seen[key]) continue;
    seen[key] = true;
    if (++shown > 40) break;
    console.error('  DIV [' + d.lane + '] ' + d.name + '\n        eshttp=' + d.ours + '\n        esb64 =' + d.theirs);
  }
  if (divergences.length > shown) console.error('  ... ' + (divergences.length - shown) + ' more');
  process.exit(1);
}
console.log('eshttp<->ESB64 parity: all ' + checks + ' checks passed (seed ' + seed + ', ' + iterations + ' fuzz iterations)');
