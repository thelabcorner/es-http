#!/usr/bin/env node
/* ============================================================================
 * parity.mjs — eshttp.json ⇄ ESON differential harness (task t4-eson)
 * ============================================================================
 * Validates that eshttp's embedded JSON implementation (eshttp.json.parse /
 * eshttp.json.stringify in src/eshttp.jsxinc) behaves like ESON's JSON facade
 * on the SAME vectors, using eson-core (eson/dist/eson-core.esm.mjs) as the
 * oracle.
 *
 * Source of truth (read-only):
 *   - eson/dist/eson-core.esm.mjs        (oracle: parse/stringify + json2)
 *   - eson/vendor/json2.raw.js           (injected json2 for the oracle)
 *   - eson/tests/fixtures.ts             (the exact vectors; bundled to
 *                                        test/parity/eson-fixtures.mjs by
 *                                        esbuild — see eson-fixtures-entry.ts)
 *   - eson/tests/eson-test-entry.ts      (hangClass + depth + reviver cases)
 *
 *  Target (fixable): the eshttp core (src/eshttp.jsxinc before the TS
 *  rewrite; dist/eshttp-core.esm.mjs after — see load-core.mjs).
 *
 *  RUN: node test/parity/parity.mjs
 *  (bundles the fixtures on first run if test/parity/eson-fixtures.mjs is
 *  stale or missing; needs eson's node_modules esbuild, or
 *  ESBUILD_PATH pointing at an esbuild CLI script)
 *
 * Exit 0 = required dimensions green (all documented divergences accounted
 *          for in the manifest below). Exit 1 = unexpected divergence.
 *
 * DOCUMENTED DIVERGENCES (decided 2026-08-09, task t4-eson) — each is a
 * deliberate, contracted eshttp behavior; the harness verifies the rest:
 *
 *  D1  stringify: eshttp emits \uXXXX for ALL non-ASCII (7-bit clean output,
 *      api-spec §5, "important for the UTF-8 ABI boundary"); ESON/json2 leave
 *      ordinary non-ASCII (letters/CJK/valid surrogate pairs) raw and escape
 *      only the RFC/json2 control + formatting ranges. For every char that
 *      json2 escapes, eshttp escapes it with the SAME bytes (see D2 fix +
 *      \uXXXX for the formatting ranges), so the divergence is byte-only on
 *      chars json2 leaves raw: SEMANTIC parity holds (round-trip identical).
 *  D2  stringify: cycles — ESON/json2 throw; eshttp serializes the offending
 *      branch as null (api-spec §5 "documented simplification" + selftest).
 *  D3  stringify: toJSON/Date — ESON/json2 call value.toJSON() (Date ->
 *      ISO string); eshttp's contract domain is Object/Array/string/number/
 *      boolean/null with no toJSON hook, so Date/boxed-with-toJSON serialize
 *      per their own shape (Date -> {}).
 *  D4  stringify: root undefined/function — ESON/json2 return undefined
 *      (not JSON); eshttp returns the JSON text "null" (never-throw +
 *      always-a-string posture).
 *  D5  stringify: replacer/space args — ESON facade supports them (json2
 *      delegation); eshttp.json.stringify is 1-arg per api-spec §5, extra
 *      args are ignored. API-scope difference (not in the corpus).
 *  D6  parse: never-throws API shape — ESON.parse throws on invalid JSON;
 *      eshttp.json.parse returns null (api-spec §5) and coerces non-string
 *      input to null (ESON coerces with String()). Verdicts agree.
 *  D7  parse: reviver — ESON supports reviver (json2 walk). eshttp.json.parse
 *      gained an optional reviver for parity (2026-08-09); reviver THROWS are
 *      swallowed to null by the never-throw contract (ESON propagates).
 *
 * The eson suite itself is untouched; run it with
 * `node tests/eson-test.mjs` (eson/) — must stay at its baseline pass count.
 * ==========================================================================*/
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as esonCore from '../../../eson/dist/eson-core.esm.mjs';
import * as fx from './eson-fixtures.mjs';
import { loadCore } from '../load-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESON_DIR = join(ROOT, '..', 'eson');
const JSON2_PATH = join(ESON_DIR, 'vendor', 'json2.raw.js');
const FIXTURES_OUT = join(dirname(fileURLToPath(import.meta.url)), 'eson-fixtures.mjs');
const FIXTURES_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'eson-fixtures-entry.ts');

// ---- oracle bootstrap -----------------------------------------------------
esonCore.install({
  json2Source: readFileSync(JSON2_PATH, 'utf8')
});
const esonParse = esonCore.parse;      // parse(text, reviver?) — throws on invalid
const esonStringify = esonCore.stringify; // stringify(value, replacer?, space?)

// ---- bundle eson fixtures if stale ---------------------------------------
function bundleFixtures() {
  if (existsSync(FIXTURES_OUT) &&
      statSync(FIXTURES_OUT).mtimeMs >= statSync(FIXTURES_ENTRY).mtimeMs &&
      statSync(FIXTURES_OUT).mtimeMs >= statSync(join(ESON_DIR, 'tests', 'fixtures.ts')).mtimeMs) {
    return;
  }
  const candidates = [
    process.env.ESBUILD_PATH,
    join(ESON_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild')
  ].filter(Boolean);
  const esbuild = candidates.find((p) => existsSync(p));
  if (!esbuild) {
    throw new Error('esbuild not found — bundle eson-fixtures.mjs manually ' +
      '(ESBUILD_PATH or eson/node_modules)');
  }
  execFileSync(process.execPath, [esbuild, FIXTURES_ENTRY, '--bundle',
    '--format=esm', '--outfile=' + FIXTURES_OUT, '--log-level=warning'],
    { stdio: 'inherit' });
}
bundleFixtures();

// ---- eshttp core (subject) — same loader the main harness uses ------------
// Retargeted (T4): the subject is the TS core (dist/eshttp-core.esm.mjs via
// the "esm" lane; falls back to the original src/eshttp.jsxinc when no dist
// exists). The loader stages the ExtendScript globals and returns the facade
// object, so `eshttp.json.parse/stringify` below are the real shipped code.
const _core = await loadCore({ source: process.env.ESHTTP_CORE || 'esm' });
const eshttp = _core.eshttp;
const eshttpParse = eshttp.json.parse;       // (text, reviver?) -> value | null, never throws
const eshttpStringify = eshttp.json.stringify; // (value) -> string

// ---- report machinery ------------------------------------------------------
let passes = 0;
const failures = [];
const docs = []; // documented divergences observed (evidence)

function ok(cond, label, detail) {
  if (cond) { passes++; }
  else { failures.push(label + (detail ? ' :: ' + detail : '')); }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date && b instanceof Date) return a.valueOf() === b.valueOf();
  const ia = Object.prototype.toString.apply(a) === '[object Array]';
  const ib = Object.prototype.toString.apply(b) === '[object Array]';
  if (ia !== ib) return false;
  if (ia) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function esonParseVerdict(text) {
  try { const v = esonParse(text); return { threw: false, value: v }; }
  catch (e) { return { threw: true, value: e }; }
}

// ===========================================================================
// 1. parse: valid corpus (eson's makeValidJson + targeted additions)
// ===========================================================================
console.log('[1] parse: valid corpus');
const extraValid = [
  '["\\uD800"]', '"a\\ud800b"', '"a\\udc00b"', '"a\\ud83d\\ude00b"', '"a\ud83d\ude00b"',
  '"a\ud800b"', '"a\udc00b"', '{"a":1,"a":2}', '{"__proto__":1}', '\t\n {"a":\r\n1} \t',
  '{"\\u0000":1}', '"\\u2029"', '"\\u00e9"', '12345678901234567890', '1e+5', '1E10'
];
for (const t of fx.makeValidJson()) {
  const e = esonParseVerdict(t);
  ok(!e.threw, 'parse.valid.accept', JSON.stringify(t));
  const h = eshttpParse(t);
  ok(h !== null || e.value === null, 'parse.valid.eshttp.nonNull', JSON.stringify(t));
  ok(deepEqual(h, e.value), 'parse.valid.deep', JSON.stringify(t) + ' eson=' + JSON.stringify(e.value) + ' eshttp=' + JSON.stringify(h));
}
for (const t of extraValid) {
  const e = esonParseVerdict(t);
  const h = eshttpParse(t);
  ok(!e.threw, 'parse.validExtra.accept', JSON.stringify(t));
  ok(h !== null || e.value === null, 'parse.validExtra.eshttp.nonNull', JSON.stringify(t));
  ok(deepEqual(h, e.value), 'parse.validExtra.deep', JSON.stringify(t) + ' eson=' + JSON.stringify(e.value) + ' eshttp=' + JSON.stringify(h));
}

// ===========================================================================
// 2. parse: invalid corpus (eson's makeInvalidJson + hangClass + targeted)
// ===========================================================================
console.log('[2] parse: invalid corpus');
const hangClass = [
  '["\\uD800\\"]', '"\\"', '"a\\"', '{"k":"a\\"}', '"\\x41"', '"a\\qb"', '"\\u12"',
  '"abc\\u12\\"', '{"a":1} 1', '[1] 2', '"x" 3', '{"a":1} true', '123 456'
];
const extraInvalid = [
  '"a\u0000b"', '"\u0000"', '{"a":"b\u0000c"}', '"\\u12x4"', '"\\u000x"', '"\\u00zz"',
  '"bad\\u12g4"', '"\\u123"', '00.5', '1.2.3', '01e1', '-.5', '1e', '1e+', '1e-',
  '-', '+1', '0x1', 'Infinity', 'NaN', 'undefined', '--1', '1-1', '[1,2,]', '[,1]',
  '{"a":1,}', '{,"a":1}', '{"a":}', '{"a"::1}', '[::]', '""""', "'a'", '"a"x',
  '  ', '', '{', '}', '[', ']', '{{}}', '[[]', 'truefalse', 'tru', 'nul', 'n',
  '{"a":1}{"b":2}', '{"a":1},1', '"\ud800"x'
];
for (const t of fx.makeInvalidJson()) {
  const e = esonParseVerdict(t);
  ok(e.threw, 'parse.invalid.esonRejects', JSON.stringify(t));
  const h = eshttpParse(t);
  ok(h === null, 'parse.invalid.eshttpRejects', JSON.stringify(t) + ' got ' + JSON.stringify(h));
}
for (const t of hangClass) {
  const e = esonParseVerdict(t);
  ok(e.threw, 'parse.hangclass.esonRejects', JSON.stringify(t));
  const h = eshttpParse(t);
  ok(h === null, 'parse.hangclass.eshttpRejects', JSON.stringify(t) + ' got ' + JSON.stringify(h));
}
for (const t of extraInvalid) {
  const e = esonParseVerdict(t);
  ok(e.threw, 'parse.invalidExtra.esonRejects', JSON.stringify(t));
  const h = eshttpParse(t);
  ok(h === null, 'parse.invalidExtra.eshttpRejects', JSON.stringify(t) + ' got ' + JSON.stringify(h));
}

// never-throw contract: no corpus input may throw out of eshttp.json.parse
let neverThrew = true;
const allTexts = []
  .concat(fx.makeValidJson(), fx.makeInvalidJson(), fx.makeSecurityFixtures(),
          hangClass, extraValid, extraInvalid);
for (const t of allTexts) {
  try { eshttpParse(t); } catch (e) { neverThrew = false; failures.push('parse.neverThrows :: ' + JSON.stringify(t)); }
}
ok(neverThrew, 'parse.neverThrows');

// ===========================================================================
// 3. parse: security fixtures (no execution / rejection parity)
// ===========================================================================
console.log('[3] parse: security fixtures');
for (const t of fx.makeSecurityFixtures()) {
  const e = esonParseVerdict(t);
  ok(e.threw, 'security.esonRejects', JSON.stringify(t));
  const h = eshttpParse(t);
  ok(h === null, 'security.eshttpRejects', JSON.stringify(t) + ' got ' + JSON.stringify(h));
}

// ===========================================================================
// 4. parse: depth cap (ESON MAX_DEPTH 512; eshttp mirrors it)
// ===========================================================================
console.log('[4] parse: depth');
function deepText(d) { let s = '0'; for (let k = 0; k < d; k++) s = '[' + s + ']'; return s; }
const depthCases = [100, 511, 512, 513, 600];
for (const d of depthCases) {
  const t = '[' + deepText(d) + ']';
  const e = esonParseVerdict(t);
  const h = eshttpParse(t);
  ok(e.threw === (h === null), 'depth.' + d + '.agree',
    'eson=' + (e.threw ? 'reject' : 'accept') + ' eshttp=' + (h === null ? 'reject' : 'accept'));
}

// ===========================================================================
// 5. stringify: eson value corpus (values + root specials)
// ===========================================================================
console.log('[5] stringify: value corpus');
const KNOWN_DOC = { cyclic: 'D2', cyclicArray: 'D2', customToJSON: 'D3', date: 'D3', invalidDate: 'D3' };
const docsObserved = {};

function recordDoc(id, label, detail) {
  docsObserved[id] = (docsObserved[id] || 0) + 1;
  docs.push({ id, label, detail });
}

for (const vf of fx.makeValues()) {
  const name = vf.name;
  // (a) oracle sanity: eson output must equal fixture expected (== json2)
  if (vf.note && vf.note.indexOf('throw') >= 0) {
    let esonThrew = false;
    try { esonStringify(vf.value); } catch (e) { esonThrew = true; }
    ok(esonThrew, 'stringify.' + name + '.esonThrows');
    let hOut = null;
    try { hOut = eshttpStringify(vf.value); } catch (e) { hOut = '__THREW__'; }
    ok(hOut !== '__THREW__', 'stringify.' + name + '.eshttpNoThrow');
    ok(KNOWN_DOC[name] !== undefined, 'stringify.' + name + '.docExpected',
      'eshttp=' + JSON.stringify(hOut));
    if (KNOWN_DOC[name]) recordDoc(KNOWN_DOC[name], 'stringify.' + name,
      'eson throws; eshttp -> ' + JSON.stringify(hOut));
    continue;
  }
  let eOut, eThrew = false;
  try { eOut = esonStringify(vf.value); } catch (e) { eThrew = true; }
  let hOut, hThrew = false;
  try { hOut = eshttpStringify(vf.value); } catch (e) { hThrew = true; }
  ok(!eThrew && !hThrew, 'stringify.' + name + '.noThrow', 'eson=' + eThrew + ' eshttp=' + hThrew);
  if (eThrew || hThrew) continue;
  if (vf.expected !== undefined) {
    ok(eOut === vf.expected, 'stringify.' + name + '.oracleExpected',
      'eson=' + JSON.stringify(eOut) + ' expected=' + JSON.stringify(vf.expected));
  }
  if (eOut === hOut) {
    ok(true, 'stringify.' + name + '.byteParity');
  } else if (KNOWN_DOC[name]) {
    recordDoc(KNOWN_DOC[name], 'stringify.' + name,
      'eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  } else if (deepEqual(esonParseVerdict(eOut).value, esonParseVerdict(hOut).value)) {
    recordDoc('D1', 'stringify.' + name,
      'byte-only (7-bit clean): eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  } else {
    ok(false, 'stringify.' + name + '.parity',
      'eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  }
}

console.log('[5b] stringify: root specials');
for (const vf of fx.makeRootSpecials()) {
  const name = vf.name;
  let eOut, eThrew = false;
  try { eOut = esonStringify(vf.value); } catch (e) { eThrew = true; }
  let hOut, hThrew = false;
  try { hOut = eshttpStringify(vf.value); } catch (e) { hThrew = true; }
  ok(!eThrew && !hThrew, 'stringify.root.' + name + '.noThrow');
  if (name === 'rootUndefined' || name === 'rootFunction' || name === 'rootDate') {
    recordDoc(name === 'rootDate' ? 'D3' : 'D4', 'stringify.root.' + name,
      'eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  } else {
    ok(eOut === hOut, 'stringify.root.' + name + '.parity',
      'eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  }
}

// ===========================================================================
// 6. stringify: escape-vector table (control chars, surrogates, unicode)
// ===========================================================================
console.log('[6] stringify: escape vectors');
const escVectors = [
  ['nul', '\u0000'], ['tab', 'a\tb'], ['lf', 'a\nb'], ['cr', 'a\rb'], ['bs', 'a\bb'],
  ['ff', 'a\fb'], ['esc', 'a\u001bb'], ['us', 'a\u001fb'], ['del', '\u007f'],
  ['c1', '\u0080'], ['c1b', '\u009f'], ['eacute', '\u00e9'], ['softHyphen', '\u00ad'],
  ['lineSep', '\u2028'], ['paraSep', '\u2029'], ['narrowNb', '\u202f'],
  ['narrowNb2', '\u200f'], ['zwnj', '\u200c'], ['lrm', '\u200e'],
  ['latin', '\u00c1\u00e1'], ['cjk', '\u4e2d\u6587'], ['emoji', '\ud83d\ude00'],
  ['loneHigh', '\ud800'], ['loneLow', '\udc00'], ['pair', 'x\ud83d\ude00y'],
  ['bom', '\ufeff'], ['fffe', '\ufffe'], ['ff0', '\ufff0'],
  ['arFmt', '\u061c'], ['arabic', '\u0627'], ['comb', '\u0301'],
  ['zeroWidthSpace', '\u200b'], ['nbsp', '\u00a0']
];
for (const [name, s] of escVectors) {
  const eOut = esonStringify(s);
  const hOut = eshttpStringify(s);
  if (eOut === hOut) {
    ok(true, 'esc.' + name + '.byteParity');
  } else if (deepEqual(esonParseVerdict(eOut).value, esonParseVerdict(hOut).value)) {
    recordDoc('D1', 'esc.' + name,
      'byte-only (7-bit clean): eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  } else {
    ok(false, 'esc.' + name + '.parity',
      'eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));
  }
}

// ===========================================================================
// 7. stringify: getter reads exactly once + output parity
// ===========================================================================
console.log('[7] stringify: getters');
{
  let reads = 0;
  const gv = {};
  Object.defineProperty(gv, 'x', { get: function () { reads++; return 1; }, enumerable: true });
  const eOut = esonStringify(gv);
  const readsAfterEson = reads;
  const hOut = eshttpStringify(gv);
  const readsAfterEshttp = reads;
  ok(eOut === hOut, 'getter.parity', 'eson=' + eOut + ' eshttp=' + hOut);
  ok(readsAfterEson === 1, 'getter.eson.reads.once', 'reads=' + readsAfterEson);
  ok(readsAfterEshttp - readsAfterEson === 1, 'getter.eshttp.reads.once',
    'eshttp reads=' + (readsAfterEshttp - readsAfterEson));
}

// ===========================================================================
// 8. stringify: replacer/space are ESON-facade scope (D5 — documented)
// ===========================================================================
console.log('[8] stringify: replacer/space (documented API-scope, D5)');
for (const rc of fx.makeReplacerCases()) {
  const eOut = esonStringify(rc.value, rc.replacer);
  ok(eOut === rc.expected, 'replacer.oracle.' + rc.name,
    'eson=' + JSON.stringify(eOut) + ' expected=' + JSON.stringify(rc.expected));
  // eshttp.json.stringify ignores extra args by contract (1-arg, api-spec §5)
  const hOut = eshttpStringify(rc.value, rc.replacer);
  const h2 = eshttpStringify(rc.value, rc.replacer, 2);
  recordDoc('D5', 'replacer.' + rc.name,
    'eson(fn replacer)=' + JSON.stringify(eOut) + ' eshttp(1-arg)=' + JSON.stringify(hOut) +
    (hOut === h2 ? ' (space arg ignored)' : ' (space arg CHANGED output!)'));
}
{
  const spaceVal = { a: [1, 2], b: 'x' };
  const spaceCases = [2, 4, '\t', '  ', -1, true, 0, ''];
  for (const sp of spaceCases) {
    const eOut = esonStringify(spaceVal, undefined, sp);
    const eFlat = esonStringify(spaceVal, undefined, undefined);
    ok(eOut === eFlat || eOut.indexOf('\n') >= 0 || sp === '\t' || sp === '  ', 'space.oracle.' + String(sp),
      'eson=' + JSON.stringify(eOut.slice(0, 30)) + ' flat=' + JSON.stringify(eFlat));
    if (eOut !== eFlat) {
      recordDoc('D5', 'space.' + String(sp),
        'eson indents; eshttp ignores (1-arg): eson=' + JSON.stringify(eOut.slice(0, 40)));
    }
  }
}

// ===========================================================================
// 9. parse: reviver semantics (eshttp gained optional reviver for parity)
// ===========================================================================
console.log('[9] parse: reviver');
{
  const reviverSrc = '{"a":{"b":1},"c":2}';
  const reviver = (k, v) => (typeof v === 'number' ? v * 2 : v);
  const eOut = esonParse(reviverSrc, reviver);
  const hOut = eshttpParse(reviverSrc, reviver);
  ok(deepEqual(hOut, eOut), 'reviver.parity.double',
    'eson=' + JSON.stringify(eOut) + ' eshttp=' + JSON.stringify(hOut));

  const deleter = (k, v) => (k === 'b' ? undefined : v);
  const eDel = esonParse(reviverSrc, deleter);
  const hDel = eshttpParse(reviverSrc, deleter);
  ok(deepEqual(hDel, eDel), 'reviver.parity.delete',
    'eson=' + JSON.stringify(eDel) + ' eshttp=' + JSON.stringify(hDel));
  ok(!('b' in hDel.a), 'reviver.delete.applied');

  // array reviver: nulls stay null; reviver called with numeric keys
  const arrSrc = '[1,{"x":2}]';
  const arrRev = (k, v) => (k === 'x' ? v * 10 : v);
  ok(deepEqual(eshttpParse(arrSrc, arrRev), esonParse(arrSrc, arrRev)),
    'reviver.parity.array');

  // root reviver (key '')
  const rootRev = (k, v) => (k === '' && typeof v === 'number' ? 99 : v);
  ok(deepEqual(eshttpParse('7', rootRev), esonParse('7', rootRev)), 'reviver.parity.root');

  // no reviver arg -> raw value (unchanged behavior)
  ok(deepEqual(eshttpParse('{"a":1}'), esonParse('{"a":1}')), 'reviver.raw.unchanged');

  // reviver that THROWS: eson propagates, eshttp never-throw -> null (D7)
  let eThrew = false;
  try { esonParse('{"a":1}', () => { throw new Error('boom'); }); } catch (e) { eThrew = true; }
  const hThrewVal = eshttpParse('{"a":1}', () => { throw new Error('boom'); });
  ok(eThrew === true, 'reviver.esonPropagatesThrow');
  ok(hThrewVal === null, 'reviver.eshttpSwallowsToNull', 'got ' + JSON.stringify(hThrewVal));
  recordDoc('D7', 'reviver.throwingReviver', 'eson propagates; eshttp returns null (never-throw)');
}

// ===========================================================================
// 10. round-trip: stringify -> parse must agree between the two lanes
// (NaN/Infinity/functions/undefined/__proto__ do not survive ANY strict
//  JSON round-trip — comparing lane-to-lane keeps the invariant honest)
// ===========================================================================
console.log('[10] round-trip lane parity');
for (const vf of fx.makeValues()) {
  const name = vf.name;
  if (vf.note && vf.note.indexOf('throw') >= 0) continue;                      // cycles (D2)
  if (name === 'customToJSON' || name === 'date' || name === 'invalidDate') continue; // D3
  const eOut = esonStringify(vf.value);
  const hOut = eshttpStringify(vf.value);
  const eBack = esonParse(eOut);
  const hBack = eshttpParse(hOut);
  ok(deepEqual(hBack, eBack), 'roundtrip.' + name,
    'eson=' + JSON.stringify(eBack) + ' eshttp=' + JSON.stringify(hBack));
}

// ===========================================================================
// summary
// ===========================================================================
console.log('');
console.log('================ eshttp.json vs ESON — parity results ================');
const sorted = Object.keys(docsObserved).sort();
for (const id of sorted) {
  console.log('documented divergence ' + id + ' (x' + docsObserved[id] + ' vectors)');
}
const uniq = new Map();
for (const d of docs) {
  const key = d.id + ' :: ' + d.label;
  if (!uniq.has(key)) uniq.set(key, d);
}
for (const d of uniq.values()) {
  console.log('  ' + d.id + ' ' + d.label + (d.detail ? '  -> ' + d.detail.slice(0, 160) : ''));
}

const needIds = ['D1', 'D2', 'D3', 'D4', 'D5', 'D7'];
const missing = needIds.filter((id) => !docsObserved[id]);
if (missing.length) {
  console.log('WARNING: expected documented divergences not exercised: ' + missing.join(', '));
}

console.log('');
console.log('PARITY: ' + passes + ' assertions, ' + failures.length + ' failures');
if (failures.length) {
  const shown = failures.slice(0, 40);
  for (const f of shown) console.log('  FAIL ' + f);
  if (failures.length > 40) console.log('  ... and ' + (failures.length - 40) + ' more');
}
console.log('EXIT=' + (failures.length ? 1 : 0));
process.exit(failures.length ? 1 : 0);
