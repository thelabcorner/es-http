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
//   5. opt-in cli staging (eshttp-cli.exe -> %LOCALAPPDATA%\eshttp) +
//      opt-in include-compat copy (dist/eshttp.jsx -> src/eshttp.jsxinc).
//      Ordinary build/verify never mutates the per-user runtime installation.
//   6. ESTC static check on the shipped artifacts that the workspace audit
//      tracks (dist/eshttp.jsx, dist/eshttp-native-accel.jsx).
//
// FLAGS:
//   --include-compat   ALSO copy dist/eshttp.jsx -> src/eshttp.jsxinc so
//                      `#include "eshttp.jsxinc"` keeps working unchanged.
//   --stage-cli        Explicitly stage native/eshttp-cli.exe into the per-user
//                      runtime root. Never implied by ordinary build/verify.
//   --accel-debug      Embed the PLAIN accel bundles (ESON.accel.jsx /
//                      ESB64.accel.jsx, unminified) instead of the .min
//                      flavors (default) in the ESM lane payloads.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as espackBuildManifest, makeManifest } from '../espack/espack-build.mjs';
import { libraryFromFile } from '../espack/espack-libraries.mjs';
import { merge as espackMerge } from '../espack/espack-merge.mjs';

var ROOT = dirname(fileURLToPath(import.meta.url));
var DIST = join(ROOT, 'dist');
var ESHTTP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
var ENTRY = join(ROOT, 'src', 'esm-entry.ts');
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

function emptyJsStringLiteral(text, varName) {
  var marker = 'var ' + varName;
  var at = text.indexOf(marker);
  if (at < 0) { return text; }
  var start = text.indexOf('"', at);
  if (start < 0) { return text; }
  var i = start + 1;
  for (; i < text.length; i++) {
    var c = text.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '"') { break; }
  }
  if (i >= text.length) { throw new Error('[eshttp-build] unterminated payload literal for ' + varName); }
  return text.substring(0, start) + '""' + text.substring(i + 1);
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

// ESPACK manifest-v2 library closure for the shipped x64/x86 distributions.
function buildLibrary(id, version, globalName, path, contract, requires, provenance) {
  return libraryFromFile({ id: id, version: version, global: globalName, path: path,
    contract: contract, requires: requires || [], provenance: provenance });
}

function buildManifestV2Accel(arch, cliExe, ipcDll, banner) {
  var espackBuildPath = join(ROOT, '..', 'espack', 'espack-build.mjs');
  var esonFacade = join(ROOT, '..', 'eson', 'dist', 'ESON.facade.jsx');
  var esonManifestPath = join(ROOT, '..', 'eson', 'dist', 'ESON.manifest.json');
  var esonPackage = JSON.parse(readFileSync(join(ROOT, '..', 'eson', 'package.json'), 'utf8'));
  var esb64Facade = join(ROOT, '..', 'esb64', 'dist', 'ESB64.facade.jsx');
  var esb64Package = JSON.parse(readFileSync(join(ROOT, '..', 'esb64', 'package.json'), 'utf8'));
  var facade = join(DIST, 'eshttp.jsx');
  var outName = 'eshttp.accel-' + arch + '.jsx';
  var manifestPath = join(DIST, 'eshttp.accel-' + arch + '.manifest.json');
  var manifestName = '.eshttp-' + arch + '.manifest.json';
  var scratchBundle = join(DIST, '.eshttp-' + arch + '-scratch.jsx');
  var missing = [];
  if (esb64Package.version !== '1.3.0' || esonPackage.version !== '1.3.0' || ESHTTP_VERSION !== '1.2.0') {
    throw new Error('[eshttp-build] expected ESB64 1.3.0 -> ESON 1.3.0 -> ESHTTP 1.2.0; found ' +
      esb64Package.version + ' -> ' + esonPackage.version + ' -> ' + ESHTTP_VERSION);
  }
  if (!existsSync(espackBuildPath)) { missing.push('espack-build.mjs (sibling espack repo)'); }
  if (!existsSync(esonFacade)) { missing.push('eson/dist/ESON.facade.jsx'); }
  if (!existsSync(esonManifestPath)) { missing.push('eson/dist/ESON.manifest.json'); }
  if (!existsSync(esb64Facade)) { missing.push('esb64/dist/ESB64.facade.jsx'); }
  if (!existsSync(cliExe)) { missing.push(cliExe); }
  if (!existsSync(ipcDll)) { missing.push(ipcDll); }
  if (!existsSync(facade)) { missing.push('dist/eshttp.jsx'); }
  if (missing.length > 0) {
    console.log('[eshttp-build] merged ' + outName + ' skipped - missing: ' + missing.join(', '));
    return;
  }

  var esonManifest = JSON.parse(readFileSync(esonManifestPath, 'utf8'));
  function dependencyProvenance(id) {
    var libs = Array.isArray(esonManifest.libraries) ? esonManifest.libraries : [];
    for (var i = 0; i < libs.length; i++) {
      if (libs[i].id === id) {
        var provenance = libs[i].provenance || {};
        if (!/^[0-9a-f]{40}$/i.test(String(provenance.commit || ''))) {
          throw new Error('[eshttp-build] dependency ' + id + ' manifest is missing exact Git commit provenance');
        }
        return provenance;
      }
    }
    throw new Error('[eshttp-build] dependency ' + id + ' missing from ESON manifest closure');
  }
  var eshttpCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(eshttpCommit)) {
    throw new Error('[eshttp-build] could not resolve exact ESHTTP Git commit provenance');
  }

  var esb64 = buildLibrary('esb64', esb64Package.version, 'ESB64', esb64Facade,
    [{ name: 'atob', type: 'function' }, { name: 'btoa', type: 'function' },
      { name: 'utf8Decode', type: 'function' }, { name: 'utf8Encode', type: 'function' }], [],
    dependencyProvenance('esb64'));
  var eson = buildLibrary('eson', esonPackage.version, 'ESON', esonFacade,
    [{ name: 'parse', type: 'function' }, { name: 'stringify', type: 'function' }],
    [{ id: 'esb64', range: '^' + esb64Package.version }],
    dependencyProvenance('eson'));
  // The stand-alone facade carries fallback sibling bundles as string literals
  // for non-composed use. Strip only those data literals from the composed
  // library; v2 dependencies provide the actual ESON/ESB64 facades.
  var composedFacade = join(DIST, '.eshttp-v2-facade.jsx');
  var composedFacadeText = emptyJsStringLiteral(emptyJsStringLiteral(readFileSync(facade, 'utf8'),
    'ESON_ACCEL_BUNDLE'), 'ESB64_ACCEL_BUNDLE');
  writeFileSync(composedFacade, composedFacadeText, 'utf8');
  var eshttp = buildLibrary('eshttp', ESHTTP_VERSION, 'eshttp', composedFacade,
    [{ name: 'request', type: 'function' }, { name: 'get', type: 'function' },
      { name: 'json', type: 'function' }, { name: 'configure', type: 'function' }],
    [{ id: 'eson', range: '^' + esonPackage.version }],
    { package: 'eshttp', repository: 'https://github.com/thelabcorner/es-http.git',
      commit: eshttpCommit, artifact: 'dist/.eshttp-v2-facade.jsx' });

  // ESPACK's native build helper determines kind=file/dll and binds exact binary
  // bytes. The temporary manifest only contributes payload and shared accel data.
  var payloadManifest = join(DIST, manifestName);
  espackBuildManifest({ embeds: [cliExe, ipcDll], out: scratchBundle, name: 'eshttp',
    accel: ESB64_NATIVE_DLL, accelVersion: ESB64_ACCEL_VERSION, manifestOut: payloadManifest, quiet: true });
  var payloads = JSON.parse(readFileSync(payloadManifest, 'utf8')).payloads;
  var pinnedAccel = accelFromCurrentDll();
  if (!accelMatches(esonManifest.accel, pinnedAccel)) {
    throw new Error('[eshttp-build] ESON manifest accelerator differs from the pinned ESB64Native build');
  }
  // ESON's native JSON DLL remains a typed ESPACK payload capability; the
  // library artifact itself is composed separately through its v2 identity.
  payloads = esonManifest.payloads.concat(payloads);
  var sourceManifest = {
    format: 'espack-manifest', version: 2, bundleName: 'eshttp', cacheDir: '', chunkSize: 24576,
    accel: accelFromCurrentDll(), payloads: payloads,
    composer: { name: 'espack', version: '0.5.0' }, libraries: [esb64, eson, eshttp],
    entries: [{ id: 'eshttp', range: '=' + ESHTTP_VERSION }],
    capabilities: [
        { id: 'eshttp.cli.file', provider: 'eshttp', mode: 'required', payloads: [arch === 'x86' ? 'eshttp-cli-x86' : 'eshttp-cli'], accel: null },
      { id: 'eshttp.ipc.native', provider: 'eshttp', mode: 'required', payloads: ['eshttp-ipc-' + arch], accel: null },
      { id: 'eshttp.esb64-native', provider: 'esb64', mode: 'optional', payloads: [], accel: 'ESB64Native' },
      { id: 'eshttp.eson-native', provider: 'eson', mode: 'optional', payloads: ['ESONJson'], accel: null }
    ]
  };
  // makeManifest supplies manifest-v2 payload/accelerator hashes and validates
  // the complete dependency/capability metadata before merge consumes it.
  var v2 = makeManifest(sourceManifest);
  var inputManifest = join(DIST, '.eshttp-' + arch + '-v2-input.json');
  writeFileSync(inputManifest, JSON.stringify(v2, null, 2) + '\n');
  var built = espackMerge({ manifests: [inputManifest], entries: [{ id: 'eshttp', range: '=' + ESHTTP_VERSION }],
    out: join(DIST, outName), manifestOut: manifestPath, name: 'eshttp', deferB64: true });
  var stagedCalls = [{ idx: arch === 'x86' ? 'eshttp-cli-x86' : 'eshttp-cli', target: 'eshttp-cli.exe' },
    { idx: 'eshttp-ipc-' + arch, target: 'eshttp-ipc.dll' }];
  var accelOut = banner + built.text + '\n' + accelAdapterMerged(stagedCalls);
  writeFileSync(join(DIST, outName), accelOut);
  console.log('[eshttp-build] wrote ' + join(DIST, outName) + ' (manifest v2, ' + accelOut.length + ' bytes)');
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
if (process.argv.indexOf('--stage-cli') >= 0) {
  stageCliExe();
} else {
  console.log('[eshttp-build] cli staging skipped (pass --stage-cli for explicit per-user deployment)');
}

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
buildManifestV2Accel('x64', join(ROOT, 'native', 'eshttp-cli.exe'), join(ROOT, 'native', 'eshttp-ipc-x64.dll'),
  '// eshttp.accel-x64.jsx - ESPACK 0.5 manifest-v2 composition: ESB64 1.3.0 -> ESON 1.3.0 -> ESHTTP ' + ESHTTP_VERSION + '.\n');

buildManifestV2Accel('x86', join(ROOT, 'native', 'eshttp-cli-x86.exe'), join(ROOT, 'native', 'eshttp-ipc-x86.dll'),
  '// eshttp.accel-x86.jsx - ESPACK 0.5 manifest-v2 composition: ESB64 1.3.0 -> ESON 1.3.0 -> ESHTTP ' + ESHTTP_VERSION + '.\n');

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
