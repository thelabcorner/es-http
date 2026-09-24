#!/usr/bin/env node
// ESHTTP build — ESTC-canonical ExtendScript emission.
//
//   1. dist/eshttp-core.esm.mjs   - ESM bundle for the Node harness lane
//      (esbuild; carries the embedded ESON/ESB64 accel payload declarations).
//   2. dist/eshttp.jsx            - canonical JSX artifact emitted by the
//      shared ExtendScript Toolchain (extendscript.estc.config.mjs):
//      esbuild ES5 IIFE -> bundle-local esbuild-helper localization ->
//      UglifyJS ExtendScript-safe re-emission -> parser-output repair ->
//      strict ES3 static gate. NO project-local shims: the entry is
//      side-effect only (src/jsx-entry.ts) and the facade path is
//      descriptor-free (guarded instance __defineGetter__ / plain snapshot
//      fallback; plain-assignment publish).
//   3. Payload byte-fidelity verification of the emitted artifact (the
//      embedded ESPACK sibling bundles must round-trip byte-exact through
//      the ESTC normalize pass).
//   4. ESPAK accel bundles (per-bitness pipe accels + opt-in native accels)
//      composed with the CURRENT sibling artifacts pinned:
//        ESB64_RUNTIME_PATH = ../esb64/dist/vendor-esb64-runtime.js
//        accel              = ../esb64/native/bin/ESB64Native.dll @ v2
//      (no stale espack/vendor runtime or accelerator can re-enter).
//   5. cli staging (eshttp-cli.exe -> %LOCALAPPDATA%\eshttp) + opt-in
//      include-compat copy (dist/eshttp.jsx -> src/eshttp.jsxinc).
//   6. ESTC static check on the shipped artifacts that the workspace audit
//      tracks (dist/eshttp.jsx, dist/eshttp-native-accel.jsx).
//
// FLAGS:
//   --include-compat   ALSO copy dist/eshttp.jsx -> src/eshttp.jsxinc so
//                      `#include "eshttp.jsxinc"` keeps working unchanged.
//   --accel-debug      Embed the PLAIN accel bundles (ESON.accel.jsx /
//                      ESB64.accel.jsx, unminified) instead of the .min
//                      flavors (default) in the ESM lane payloads.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));
var DIST = join(ROOT, 'dist');
var ENTRY = join(ROOT, 'src', 'index.ts');
var ESTC = join(ROOT, '..', 'extendscript-toolchain', 'bin', 'estc.mjs');
var ESTC_CONFIG = './extendscript.estc.config.mjs';

// Pinned sibling artifacts (current ESTC-built ESB64 runtime + accelerator).
var ESB64_RUNTIME = join(ROOT, '..', 'esb64', 'dist', 'vendor-esb64-runtime.js');
var ESB64_NATIVE_DLL = join(ROOT, '..', 'esb64', 'native', 'bin', 'ESB64Native.dll');
var ESB64_ACCEL_VERSION = '2';

function findEsbuild() {
  if (process.env.ESBUILD_PATH && existsSync(process.env.ESBUILD_PATH)) return process.env.ESBUILD_PATH;
  var direct = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (existsSync(direct)) return direct;
  var cacheDirs = [
    join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    join(process.env.USERPROFILE || '', 'AppData', 'Local', 'npm-cache', '_npx')
  ];
  for (var i = 0; i < cacheDirs.length; i++) {
    try {
      var entries = readdirSync(cacheDirs[i]);
      for (var j = 0; j < entries.length; j++) {
        var p = join(cacheDirs[i], entries[j], 'node_modules', 'esbuild', 'bin', 'esbuild');
        if (existsSync(p)) return p;
      }
    } catch (ignore) {}
  }
  return 'npx esbuild';
}

function esmBuild(entry, outfile) {
  execFileSync(process.execPath, [
    findEsbuild(), entry, '--bundle', '--outfile=' + outfile,
    '--format=esm', '--platform=node', '--target=es2019',
    '--log-level=warning'
  ], { stdio: 'inherit' });
}

// ---- canonical JSX emission (shared ESTC) ---------------------------------
function estcBuild() {
  execFileSync(process.execPath, [ESTC, 'build', '--config', ESTC_CONFIG], {
    cwd: ROOT,
    stdio: 'inherit'
  });
}

function estcCheck(file) {
  execFileSync(process.execPath, [ESTC, 'check', file, '--no-target'], {
    cwd: ROOT,
    stdio: 'inherit'
  });
}

// ---- sibling accel payloads (ESM lane embedded strings) --------------------
function loadAccelPayloads() {
  var debug = process.argv.indexOf('--accel-debug') >= 0;
  var esonFile = debug ? 'ESON.accel.jsx' : 'ESON.accel.min.jsx';
  var esb64File = debug ? 'ESB64.accel.jsx' : 'ESB64.accel.min.jsx';
  var esonPath = join(ROOT, '..', 'eson', 'dist', esonFile);
  var esb64Path = join(ROOT, '..', 'esb64', 'dist', esb64File);
  var missing = [];
  if (!existsSync(esonPath)) {
    missing.push(esonPath + '  (run `node eson-build.mjs --accel` in ../eson)');
  }
  if (!existsSync(esb64Path)) {
    missing.push(esb64Path + '  (run `node esb64-build.mjs --accel` in ../esb64)');
  }
  if (missing.length > 0) {
    console.error('[eshttp-build] ACCEL PAYLOADS MISSING:\n  ' + missing.join('\n  ') +
      '\nBuild the sibling accel artifacts first (eshttp-build.mjs never auto-runs sibling builds).');
    process.exit(1);
  }
  return {
    eson: readFileSync(esonPath, 'utf8'),
    esb64: readFileSync(esb64Path, 'utf8'),
    esonFile: esonFile,
    esb64File: esb64File,
    flavor: debug ? 'plain' : 'min'
  };
}

// Generates the payload declaration block prepended to the ESM output so the
// src/*.ts adapters can reference the globals in the Node lane.
function embedAccelPayloads(payloads) {
  var header = [
    '// GENERATED by eshttp-build.mjs - embedded ESPACK-accelerated sibling bundles (read-only payloads).',
    '//   ../eson/dist/' + payloads.esonFile,
    '//   ../esb64/dist/' + payloads.esb64File,
    '// Payloads are generated ES3 data, text-concatenated AFTER esbuild runs (never parsed by it).',
    ''
  ].join('\n');
  return header +
    'var ESON_ACCEL_BUNDLE = ' + JSON.stringify(payloads.eson) + ';\n' +
    'var ESB64_ACCEL_BUNDLE = ' + JSON.stringify(payloads.esb64) + ';\n\n';
}

// Locates `var <name>` and returns the raw contents of its double-quoted
// string literal (escape-aware). The ESTC re-emitter normalizes whitespace
// and escapes, so the declaration text is matched by shape, not by bytes.
function extractJsStringLiteral(text, varName) {
  var marker = 'var ' + varName;
  var at = text.indexOf(marker);
  if (at < 0) { throw new Error('[eshttp-build] payload declaration missing: ' + varName); }
  var i = text.indexOf('"', at);
  if (i < 0) { throw new Error('[eshttp-build] payload literal missing for: ' + varName); }
  var out = '';
  i++;
  for (; i < text.length; i++) {
    var c = text.charAt(i);
    if (c === '\\') { out += c + text.charAt(i + 1); i++; continue; }
    if (c === '"') { return out; }
    out += c;
  }
  throw new Error('[eshttp-build] unterminated payload literal for: ' + varName);
}

// Blanks a payload literal in place (keeps line structure) for own-code scans.
function blankJsStringLiteral(text, varName) {
  var marker = 'var ' + varName;
  var at = text.indexOf(marker);
  if (at < 0) { return text; }
  var i = text.indexOf('"', at);
  if (i < 0) { return text; }
  var start = i;
  i++;
  for (; i < text.length; i++) {
    var c = text.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '"') { break; }
  }
  var blank = text.substring(start, i + 1).replace(/[^\n]/g, ' ');
  return text.substring(0, start) + blank + text.substring(i + 1);
}

// Byte-fidelity gate: the ESTC normalize pass must not alter the embedded
// payload string VALUES (the codec adapters eval these strings at runtime).
function verifyPayloadFidelity(file, payloads) {
  var text = readFileSync(file, 'utf8');
  var checks = [
    { name: 'ESON_ACCEL_BUNDLE', src: payloads.eson, srcFile: payloads.esonFile },
    { name: 'ESB64_ACCEL_BUNDLE', src: payloads.esb64, srcFile: payloads.esb64File }
  ];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    var lit = extractJsStringLiteral(text, c.name);
    var value = (new Function('return "' + lit + '";'))();
    if (value !== c.src) {
      console.error('[eshttp-build] PAYLOAD FIDELITY FAIL: ' + c.name + ' in ' + file +
        ' does not round-trip byte-exact from ../' + c.srcFile);
      process.exit(1);
    }
    console.log('[eshttp-build] verify: ' + c.name + ' byte-exact (' + c.src.length + ' bytes)');
  }
}

// ---- ESPAK accel composition (pinned siblings) -----------------------------
function espackEnv() {
  var env = {};
  var k;
  for (k in process.env) { if (Object.prototype.hasOwnProperty.call(process.env, k)) { env[k] = process.env[k]; } }
  env.ESB64_RUNTIME_PATH = ESB64_RUNTIME;
  return env;
}

function requirePinnedSiblings() {
  var missing = [];
  if (!existsSync(ESB64_RUNTIME)) { missing.push(ESB64_RUNTIME + ' (current ESB64 runtime; build esb64 first)'); }
  if (!existsSync(ESB64_NATIVE_DLL)) { missing.push(ESB64_NATIVE_DLL + ' (current ESB64 accelerator; build esb64 native first)'); }
  if (missing.length) {
    console.error('[eshttp-build] PINNED SIBLING ARTIFACTS MISSING:\n  ' + missing.join('\n  '));
    process.exit(1);
  }
}

function accelFromCurrentDll() {
  var b = readFileSync(ESB64_NATIVE_DLL);
  return {
    name: 'ESB64Native',
    version: ESB64_ACCEL_VERSION,
    len: b.length,
    b64: b.toString('base64'),
    fileName: 'ESB64Native_v' + ESB64_ACCEL_VERSION + '.dll'
  };
}

function accelMatches(a, b) {
  return !!a && !!b && a.name === b.name && a.version === b.version &&
    a.len === b.len && a.b64 === b.b64;
}

var ACCEL_ADAPTER_COMMON = [
  '// eshttp accel adapter (espack kind=file/dll payload staging) - ES3, never throws.',
  '(function () {',
  '  if (typeof ESPAK !== "object" || !ESPAK || typeof ESPAK.extract !== "function") return;',
  '  var g = null;',
  '  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }',
  '  var root = "";',
  '  try { var la = $.getenv("LOCALAPPDATA"); if (la) { root = String(la); } } catch (e3) {}',
  '  if (!root) { try { root = String(Folder.temp.fsName); } catch (e4) {} }',
  '  if (!root) { return; }',
  '  // Trailing-slash trim WITHOUT a regex: an unescaped `/` inside a regex',
  '  // character class is treated as the terminator by the ES3 parser',
  '  // (skill L451-453) - the class form /[\\/]+$/ breaks live. charCodeAt scan.',
  '  var stageDir = root;',
  '  while (stageDir.length > 0) {',
  '    var c0 = stageDir.charCodeAt(stageDir.length - 1);',
  '    if (c0 === 92 || c0 === 47) { stageDir = stageDir.substring(0, stageDir.length - 1); }',
  '    else { break; }',
  '  }',
  '  stageDir += "/eshttp";',
  '  try { var dir = new Folder(stageDir); if (!dir.exists) { dir.create(); } } catch (e5) {}',
  '  function stage(payloadIdx, targetName) {',
  '    try {',
  '      var r = ESPAK.extract(payloadIdx);',
  '      if (!r || !r.ok) { return false; }',
  '      var src = ESPAK.payloadPath(payloadIdx);',
  '      var f = new File(src);',
  '      if (!f.exists) { return false; }',
  '      var dest = stageDir + "/" + targetName;',
  '      var d = new File(dest);',
  '      try { if (d.exists) { d.remove(); } } catch (e6) {}',
  '      var ok = false;',
  '      try { ok = f.copy(dest); } catch (e7) { ok = false; }',
  '      if (!ok) {',
  '        try {',
  '          var rf = new File(src); rf.encoding = "BINARY";',
  '          if (rf.open("r")) {',
  '            var data = rf.read();',
  '            rf.close();',
  '            var wf = new File(dest); wf.encoding = "BINARY";',
  '            if (wf.open("w")) { wf.write(data); wf.close(); ok = true; }',
  '          }',
  '        } catch (e8) { ok = false; }',
  '      }',
  '      return ok;',
  '    } catch (e9) { return false; }',
  '  }',
  ''
].join('\n');

function accelAdapter(stageCalls) {
  var lines = [ACCEL_ADAPTER_COMMON];
  for (var i = 0; i < stageCalls.length; i++) {
    lines.push('  stage(' + stageCalls[i].idx + ', "' + stageCalls[i].target + '");');
  }
  lines.push('  try {',
    '    if (typeof ExternalObject !== "undefined" && ExternalObject.searchFolders) {',
    '      ExternalObject.searchFolders = stageDir + ";" + ExternalObject.searchFolders;',
    '    }',
    '  } catch (e10) {}',
    '  if (g) { try { g.ESPAK = ESPAK; } catch (e11) {} }',
    '}());',
    '');
  return lines.join('\n');
}

function buildAccelBundle(name, embeds, stageCalls, banner) {
  var espackBuild = join(ROOT, '..', 'espack', 'espack-build.mjs');
  var facade = join(DIST, 'eshttp.jsx');
  var missing = [];
  if (!existsSync(espackBuild)) { missing.push('espack-build.mjs (sibling espack repo)'); }
  if (!existsSync(facade)) { missing.push('dist/eshttp.jsx (ESTC step must run first)'); }
  for (var e = 0; e < embeds.length; e++) {
    if (!existsSync(embeds[e].path)) { missing.push(embeds[e].path); }
  }
  if (missing.length > 0) {
    console.log('[eshttp-build] ' + name + ' skipped - missing: ' + missing.join(', '));
    return;
  }
  var tmpBundle = join(DIST, '.eshttp-accel-bundle.jsx');
  var args = [espackBuild];
  for (var e2 = 0; e2 < embeds.length; e2++) { args.push('--embed', embeds[e2].path); }
  args.push('--accel', ESB64_NATIVE_DLL, '--accel-version', ESB64_ACCEL_VERSION);
  args.push('--out', tmpBundle, '--name', 'eshttp', '--quiet');
  execFileSync(process.execPath, args, { stdio: 'inherit', env: espackEnv() });
  var bundleText = readFileSync(tmpBundle, 'utf8');
  var facadeText = readFileSync(facade, 'utf8');
  var adapter = accelAdapter(stageCalls);
  var accelOut = banner + bundleText + '\n' + facadeText + '\n' + adapter;
  writeFileSync(join(DIST, name), accelOut);
  console.log('[eshttp-build] wrote ' + join(DIST, name) + ' (' + accelOut.length + ' bytes)');
}

// The ESB64 facade adapter (loader-free): attaches the shared ESB64Native
// accelerator by NAME (merged payload indexes are not stable) to the slim
// ESB64 atob/btoa runtime and keeps the ES3 lane when the resolved payload
// is not the shared accelerator.
var ESB64_FACADE_ADAPTER = [
  '(function () {',
  '  if (typeof ESPAK !== "object" || !ESPAK || typeof ESPAK.attach !== "function") return;',
  '  var origAtob = ESB64.atob;',
  '  var origBtoa = ESB64.btoa;',
  '  var NON_LATIN1_RE = /[^\\x00-\\xff]/;',
  '  var NON_ASCII_RE = /[^\\x01-\\x7f]/;',
  '  function invalidCharacter(msg) {',
  '    var e = new Error(msg);',
  '    try { e.name = "InvalidCharacterError"; } catch (ignore) {}',
  '    return e;',
  '  }',
  '  var accel = ESPAK.attach({',
  '    es3: null,',
  '    buildNative: function (lib) {',
  '      // Merged-bundle guard: ESPAK.attach resolves payload 0 when payloads',
  '      // exist (ESONJson in the merged bundle), NOT the shared ESB64Native',
  '      // accel. Only swap to native when the lib actually exposes the codec',
  '      // methods (b64decode/b64encode); otherwise keep the ES3 lane (which is',
  '      // spec-exact by parity - the native swap is a speed nicety, not a',
  '      // correctness requirement).',
  '      if (!lib || typeof lib.b64decode !== "function" || typeof lib.b64encode !== "function") return null;',
  '      return {',
  '        atob: function (text) {',
  '          var raw = String(text);',
  '          if (NON_ASCII_RE.test(raw)) return origAtob(raw);',
  '          var out;',
  '          try { out = lib.b64decode(raw); }',
  '          catch (e) {',
  '            if (typeof e.number === "number" && e.number === 10001) {',
  '              throw invalidCharacter("atob: the string to be decoded is not correctly encoded");',
  '            }',
  '            throw e;',
  '          }',
  '          if (typeof out !== "string") return origAtob(raw);',
  '          return out;',
  '        },',
  '        btoa: function (text) {',
  '          var raw = String(text);',
  '          if (raw.indexOf("\\0") >= 0 || NON_LATIN1_RE.test(raw)) return origBtoa(raw);',
  '          var out;',
  '          try { out = lib.b64encode(raw); }',
  '          catch (e) {',
  '            if (typeof e.number === "number" && e.number === 10002) {',
  '              throw invalidCharacter("btoa: the string to be encoded contains characters outside of the Latin1 range");',
  '            }',
  '            throw e;',
  '          }',
  '          return out;',
  '        }',
  '      };',
  '    },',
  '    onMode: function (mode, lib, impl) {',
  '      // Guard: never swap to a null/broken impl (e.g. when buildNative',
  '      // returned null because the resolved lib was a payload, not the',
  '      // shared accel). The ES3 lane is spec-exact; the native swap is a',
  '      // speed nicety only and must never break the codec contract.',
  '      if (!impl || typeof impl.atob !== "function" || typeof impl.btoa !== "function") return;',
  '      if (mode === "native") {',
  '        ESB64.atob = impl.atob;',
  '        ESB64.btoa = impl.btoa;',
  '        ESB64.encodeLatin1 = impl.btoa;',
  '        ESB64.decodeLatin1 = impl.atob;',
  '        var g = null;',
  '        try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '        if (g) {',
  '          if (g.atob === origAtob) g.atob = impl.atob;',
  '          if (g.btoa === origBtoa) g.btoa = impl.btoa;',
  '        }',
  '      }',
  '    }',
  '  });',
  '  if (accel && accel.mode) ESB64.acceleration = accel.mode;',
  '  var g = null;',
  '  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '  if (g) { g.ESB64 = ESB64; g.ESPAK = ESPAK; }',
  '}());',
  ''
].join('\n');

// The eshttp staging adapter for the MERGED bundle: extract by NAME (payload
// indexes are not stable after the merge - ESONJson is index 0). NOTE:
// ESPAK.payloadPath(name) is BROKEN (it only accepts an index - the loader's
// d(i) does c[i] with the string -> undefined); use the path the extract
// result itself returns.
var ACCEL_ADAPTER_COMMON_MERGED = ACCEL_ADAPTER_COMMON.replace(
  '  function stage(payloadIdx, targetName) {',
  '  function stage(payloadName, targetName) {'
).replace(
  '      var r = ESPAK.extract(payloadIdx);',
  '      var r = ESPAK.extract(payloadName);'
).replace(
  '      var src = ESPAK.payloadPath(payloadIdx);',
  '      var src = (r && r.path) ? r.path : ESPAK.payloadPath(payloadName);'
);

function accelAdapterMerged(stageCalls) {
  var lines = [ACCEL_ADAPTER_COMMON_MERGED];
  for (var i = 0; i < stageCalls.length; i++) {
    lines.push('  stage("' + stageCalls[i].idx + '", "' + stageCalls[i].target + '");');
  }
  lines.push('  try {',
    '    if (typeof ExternalObject !== "undefined" && ExternalObject.searchFolders) {',
    '      ExternalObject.searchFolders = stageDir + ";" + ExternalObject.searchFolders;',
    '    }',
    '  } catch (e10) {}',
    '  if (g) { try { g.ESPAK = ESPAK; } catch (e11) {} }',
    '}());',
    '');
  return lines.join('\n');
}

// esb64's Lane C manifest (accel-only - the shared ESB64Native accel, no
// payloads). Schema v1 per the merge spec. The accelerator is PINNED to the
// current ../esb64/native/bin/ESB64Native.dll; if a sibling manifest carries
// a different build of the accelerator the build stops (stale espack/vendor
// accelerators must never silently re-enter a composite).
function esb64Manifest() {
  var pinned = accelFromCurrentDll();
  var esonManifestPath = join(ROOT, '..', 'eson', 'dist', 'ESON.manifest.json');
  if (existsSync(esonManifestPath)) {
    var esonAccel = null;
    try { esonAccel = JSON.parse(readFileSync(esonManifestPath, 'utf8')).accel; } catch (e) { esonAccel = null; }
    if (esonAccel && !accelMatches(esonAccel, pinned)) {
      console.error('[eshttp-build] ACCELERATOR DRIFT: ../eson/dist/ESON.manifest.json carries a ' +
        'different ESB64Native build than the pinned ' + ESB64_NATIVE_DLL +
        ' - the sibling eson manifest must pin the canonical accelerator before eshttp composes.');
      process.exit(1);
    }
  }
  return { format: 'espack-manifest', version: 1, bundleName: 'esb64', cacheDir: '', chunkSize: 24576, accel: pinned, payloads: [] };
}

function buildMergedAccel(arch, cliExe, ipcDll, stageCalls, banner) {
  var espackBuild = join(ROOT, '..', 'espack', 'espack-build.mjs');
  var espackMerge = join(ROOT, '..', 'espack', 'espack-merge.mjs');
  var esonManifest = join(ROOT, '..', 'eson', 'dist', 'ESON.manifest.json');
  var esonFacade = join(ROOT, '..', 'eson', 'dist', 'ESON.facade.jsx');
  var esb64Runtime = join(ROOT, '..', 'esb64', 'dist', 'vendor-esb64-runtime.js');
  var facade = join(DIST, 'eshttp.jsx');
  var outName = 'eshttp.accel-' + arch + '.jsx';
  var missing = [];
  if (!existsSync(espackMerge)) { missing.push('espack-merge.mjs (sibling espack repo)'); }
  if (!existsSync(esonManifest)) { missing.push('eson/dist/ESON.manifest.json (run eson-build.mjs --accel)'); }
  if (!existsSync(esonFacade)) { missing.push('eson/dist/ESON.facade.jsx'); }
  if (!existsSync(esb64Runtime)) { missing.push('esb64/dist/vendor-esb64-runtime.js (slim atob/btoa runtime)'); }
  if (!existsSync(cliExe)) { missing.push(cliExe); }
  if (!existsSync(ipcDll)) { missing.push(ipcDll); }
  if (!existsSync(facade)) { missing.push('dist/eshttp.jsx'); }
  if (missing.length > 0) {
    console.log('[eshttp-build] merged ' + outName + ' skipped - missing: ' + missing.join(', '));
    return;
  }

  // 1. The eshttp manifest (cli + ipc per bitness) via espack-build --manifest-out.
  var eshttpManifest = join(DIST, '.eshttp-' + arch + '.manifest.json');
  var scratchBundle = join(DIST, '.eshttp-' + arch + '-scratch.jsx');
  execFileSync(process.execPath, [espackBuild, '--embed', cliExe, '--embed', ipcDll,
    '--accel', ESB64_NATIVE_DLL, '--accel-version', ESB64_ACCEL_VERSION,
    '--out', scratchBundle, '--name', 'eshttp', '--manifest-out', eshttpManifest, '--quiet'],
    { stdio: 'inherit', env: espackEnv() });

  // 2. The esb64 manifest (accel-only, PINNED to the current sibling DLL).
  var esb64ManifestPath = join(DIST, '.esb64.manifest.json');
  writeFileSync(esb64ManifestPath, JSON.stringify(esb64Manifest(), null, 2) + '\n');

  // 3. Merge: ONE loader, ONE shared accel (pinned current build), N payloads flat.
  var mergedLoader = join(DIST, '.eshttp-' + arch + '-merged-loader.jsx');
  execFileSync(process.execPath, [espackMerge, '--merge', esonManifest, esb64ManifestPath,
    eshttpManifest, '--out', mergedLoader, '--name', 'eshttp', '--quiet'],
    { stdio: 'inherit', env: espackEnv() });

  // 4. Compose: merged loader + ESON.facade + slim ESB64 runtime (atob/btoa
  //    only - no utf8/install/benchmark surface) + native adapter + eshttp
  //    library + staging adapter. The slim runtime keeps the composite free
  //    of the full-facade fixture strings while the adapter attaches the
  //    shared ESB64Native accelerator by name.
  var loaderText = readFileSync(mergedLoader, 'utf8');
  var esonFacadeText = readFileSync(esonFacade, 'utf8');
  var esb64FacadeText = readFileSync(esb64Runtime, 'utf8') + '\n' + ESB64_FACADE_ADAPTER;
  var facadeText = readFileSync(facade, 'utf8');
  var adapterText = accelAdapterMerged(stageCalls);
  var accelOut = banner + loaderText + '\n' + esonFacadeText + '\n' + esb64FacadeText + '\n' +
    facadeText + '\n' + adapterText;
  writeFileSync(join(DIST, outName), accelOut);
  console.log('[eshttp-build] wrote ' + join(DIST, outName) + ' (merged, ' + accelOut.length + ' bytes)');
}

// ---- 0. pinned siblings ----------------------------------------------------
requirePinnedSiblings();
mkdirSync(DIST, { recursive: true });
var payloads = loadAccelPayloads();
var payloadDecls = embedAccelPayloads(payloads);

// 1. ESM core bundle (Node harnesses import this) + embedded payloads.
var esmOut = join(DIST, 'eshttp-core.esm.mjs');
esmBuild(ENTRY, esmOut);
var esmFinal = payloadDecls + readFileSync(esmOut, 'utf8');
esmFinal = esmFinal.replace(/"use strict";?/g, '');
writeFileSync(esmOut, esmFinal);

// 2. Canonical JSX artifact through the shared toolchain.
estcBuild();

// 3. Payload byte-fidelity gate on the emitted artifact.
verifyPayloadFidelity(join(DIST, 'eshttp.jsx'), payloads);

console.log('[eshttp-build] wrote ' + join(DIST, 'eshttp.jsx') + ' via ESTC (embedded ' +
  payloads.esonFile + ' ' + payloads.eson.length + ' + ' + payloads.esb64File + ' ' + payloads.esb64.length + ') and ' +
  join(DIST, 'eshttp-core.esm.mjs') + ' (' + esmFinal.length + ' bytes)');

// 4. Include-compat copy (OPT-IN): dist/eshttp.jsx -> src/eshttp.jsxinc.
if (process.argv.indexOf('--include-compat') >= 0) {
  var inc = join(ROOT, 'src', 'eshttp.jsxinc');
  var own = blankJsStringLiteral(blankJsStringLiteral(readFileSync(join(DIST, 'eshttp.jsx'), 'utf8'),
    'ESON_ACCEL_BUNDLE'), 'ESB64_ACCEL_BUNDLE');
  if (/espack|ESPack/i.test(own)) {
    console.error('[eshttp-build] include-compat copy REFUSED: eshttp\'s own code still contains ' +
      'espack* references - no file was written');
    process.exit(1);
  }
  writeFileSync(inc, readFileSync(join(DIST, 'eshttp.jsx'), 'utf8'));
  console.log('[eshttp-build] include-compat: copied dist/eshttp.jsx -> ' + inc);
} else {
  console.log('[eshttp-build] include-compat copy skipped (pass --include-compat to sync src/eshttp.jsxinc)');
}

// 5. Stage eshttp-cli.exe: native/eshttp-cli.exe -> %LOCALAPPDATA%\eshttp\eshttp-cli.exe
//    (driver-cli.ts findCliExe()'s FIRST candidate). Missing -> WARN + skip.
function stageCliExe() {
  var src = join(ROOT, 'native', 'eshttp-cli.exe');
  var root = process.env.LOCALAPPDATA || '';
  if (!root) {
    console.log('[eshttp-build] cli staging skipped (LOCALAPPDATA not set)');
    return;
  }
  var destDir = join(root, 'eshttp');
  var dest = join(destDir, 'eshttp-cli.exe');
  if (!existsSync(src)) {
    console.log('[eshttp-build] cli staging skipped: ' + src + ' missing ' +
      '(build it via the native lane - see native/BUILD.md)');
    return;
  }
  var data = readFileSync(src);
  if (data.length < 2 || data[0] !== 0x4D || data[1] !== 0x5A) {
    console.error('[eshttp-build] cli staging FAILED: ' + src +
      ' is not a PE executable (missing MZ magic) - refusing to stage');
    process.exit(1);
  }
  try {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(dest, data);
  } catch (e) {
    console.error('[eshttp-build] cli staging FAILED: could not write ' + dest + ': ' + e.message);
    process.exit(1);
  }
  console.log('[eshttp-build] staged eshttp-cli.exe (' + data.length +
    ' bytes, PE verified) -> ' + dest);
}
stageCliExe();

// 6. Release accel bundles.
//    Default pipe accels: ONE bitness each, NO native DLL payloads.
buildAccelBundle('eshttp-native-accel.jsx',
  [
    { path: join(ROOT, 'native', 'eshttp-x64.dll') }
  ],
  [
    { idx: 0, target: 'eshttp.dll' }
  ],
  '// eshttp-native-accel.jsx - OPT-IN WinHTTP wrapper DLL accel (x64). Eval AFTER the default pipe accel to enable the in-process native lane (lib:eshttp) on non-firewalled hosts; the pipe lane remains the default transport.\n');

buildAccelBundle('eshttp-native-accel-x86.jsx',
  [
    { path: join(ROOT, 'native', 'eshttp-x86.dll') }
  ],
  [
    { idx: 0, target: 'eshttp.dll' }
  ],
  '// eshttp-native-accel-x86.jsx - OPT-IN WinHTTP wrapper DLL accel (x86, legacy hosts).\n');

// Retire the 4-payload monolith (v1.0.0 accel): remove it if present.
try { rmSync(join(DIST, 'eshttp.accel.jsx'), { force: true }); } catch (rmErr) {}
console.log('[eshttp-build] retired dist/eshttp.accel.jsx (4-payload monolith) - per-bitness accels + native opt-in accels produced instead');

// 7. MERGE-SPEC accel composition (ONE loader, ONE shared accelerator,
//    N payloads FLAT) with the pinned current ESB64 runtime + accelerator.
buildMergedAccel('x64', join(ROOT, 'native', 'eshttp-cli.exe'), join(ROOT, 'native', 'eshttp-ipc-x64.dll'),
  [
    { idx: 'eshttp-cli', target: 'eshttp-cli.exe' },
    { idx: 'eshttp-ipc-x64', target: 'eshttp-ipc.dll' }
  ],
  '// eshttp.accel-x64.jsx - v1.1.0 MERGED accel (espack-merge: eson + esb64 + eshttp manifests -> ONE loader, ONE shared ESB64Native accel, flat payloads ESONJson + eshttp-cli + eshttp-ipc-x64; loader-free facades appended; NO nested ESPAK bundles)\n');

buildMergedAccel('x86', join(ROOT, 'native', 'eshttp-cli-x86.exe'), join(ROOT, 'native', 'eshttp-ipc-x86.dll'),
  [
    { idx: 'eshttp-cli', target: 'eshttp-cli.exe' },
    { idx: 'eshttp-ipc-x86', target: 'eshttp-ipc.dll' }
  ],
  '// eshttp.accel-x86.jsx - v1.1.0 MERGED accel (x86: eshttp-cli + eshttp-ipc-x86 payloads, flat)\n');

// 8. ESTC static gate on every shipped JSX artifact (audited outputs +
//    per-bitness accels).
var shippedArtifacts = [
  'eshttp.jsx',
  'eshttp-native-accel.jsx',
  'eshttp-native-accel-x86.jsx',
  'eshttp.accel-x64.jsx',
  'eshttp.accel-x86.jsx'
];
for (var si = 0; si < shippedArtifacts.length; si++) {
  estcCheck(join(DIST, shippedArtifacts[si]));
}
console.log('[eshttp-build] ESTC static gate PASS: ' + shippedArtifacts.length + ' shipped JSX artifacts');
