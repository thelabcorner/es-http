#!/usr/bin/env node
// ESHTTP build: bundles the TypeScript core into
//   dist/eshttp.jsx             - bannerless IIFE (COM-eval / $.evalFile safe,
//                                 #include safe), defines var eshttp (the
//                                 facade). NO #target banner: the artifact
//                                 must work via #include and $.evalFile in
//                                 ExtendScript, per the current
//                                 src/eshttp.jsxinc include semantics.
//   dist/eshttp-core.esm.mjs    - ESM bundle of the core for Node harnesses
//                                 (test/ imports this instead of the old
//                                 jsxinc)
//
// EMBEDDED SIBLING PAYLOADS (coordinator decision v2, sponsor-mandated):
//   eshttp uses eson + esb64 via their DLL-ACCELERATED self-extracting
//   bundles, embedded here as runtime string globals (never parsed by
//   esbuild — text-concatenated after bundling):
//     var ESON_ACCEL_BUNDLE  = "..."   <- ../eson/dist/ESON.accel(.min).jsx
//     var ESB64_ACCEL_BUNDLE = "..."   <- ../esb64/dist/ESB64.accel(.min).jsx
//   The src/*.ts adapters (vendor-json.ts / vendor-b64.ts, T2) eval these
//   lazily on first codec use and cache the facade.
//   Missing artifact => BUILD FAILS with instructions to run
//   `node eson-build.mjs --accel` / `node esb64-build.mjs --accel` in the
//   sibling repos (this build never auto-runs sibling builds).
//   The payload strings legitimately contain the ESPACK bundler's own
//   identifiers (ESPAK, ESPAK_LIBS__, espack-build.mjs) — exempt from the
//   espack-reference rule (coordinator decision v2 §3 + T5 exemption); the
//   forbidden-token / espack audits blank the payload regions (they are
//   sibling-QA'd generated artifacts).
//
// FLAGS:
//   --include-compat   ALSO copy dist/eshttp.jsx -> src/eshttp.jsxinc so
//                      `#include "eshttp.jsxinc"` keeps working unchanged
//                      (rewrite-plan §4.2). OPT-IN, default OFF while the T2
//                      port and T5 espack->eshttp rename are in flight; the
//                      copy's espack check scans eshttp's OWN code only
//                      (payload regions exempt). Post-T2+T5 follow-up:
//                      coordinator ratifies flipping the default ON.
//   --accel-debug      Embed the PLAIN accel bundles (ESON.accel.jsx /
//                      ESB64.accel.jsx, unminified) instead of the .min
//                      flavors (default).
//
// The IIFE bundle defines the global `eshttp`. Because live members must
// keep jsxinc-faithful semantics (eshttp.transport and eshttp.DEFAULTS are
// GETTERS returning current state, eshttp.__noNetwork is a mutable property),
// src/index.ts exports ONE default export: the full facade object, built
// with plain properties + Object.defineProperty getters exactly like the old
// jsxinc (NOT named exports — TS named exports cannot express getters). The
// build then unwraps the default onto the global (see footer below), so
// `eshttp.request(...)`, `eshttp.transport`, `eshttp.DEFAULTS` and
// `eshttp.__noNetwork = true` all behave identically to the jsxinc.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));
var DIST = join(ROOT, 'dist');
var ENTRY = join(ROOT, 'src', 'index.ts');

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

function jsxBuild(entry, outfile) {
  execFileSync(process.execPath, [
    findEsbuild(), entry, '--bundle', '--outfile=' + outfile,
    '--format=iife', '--global-name=eshttp', '--platform=neutral', '--target=es5',
    '--log-level=warning'
  ], { stdio: 'inherit' });
}

// ---- sibling accel payloads (coordinator decision v2) ----------------------
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
    console.error('[eshttp-build] ACCEL PAYLOADS MISSING (coordinator decision v2):\n  ' +
      missing.join('\n  ') +
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

// Generates the payload declaration block, prepended to BOTH outputs so the
// src/*.ts adapters can reference the globals in the ES3 engine and in Node.
function embedAccelPayloads(payloads) {
  var header = [
    '// GENERATED by eshttp-build.mjs - embedded ESPACK-accelerated sibling bundles (read-only payloads).',
    '//   ../eson/dist/' + payloads.esonFile,
    '//   ../esb64/dist/' + payloads.esb64File,
    '// These strings legitimately contain the ESPACK bundler\'s own identifiers (ESPAK, ESPAK_LIBS__,',
    '// espack-build.mjs) - exempt from the espack-reference rule (coordinator decision v2 §3, T5).',
    '// Payloads are generated ES3, text-concatenated AFTER esbuild runs (never parsed by it).',
    ''
  ].join('\n');
  return header +
    'var ESON_ACCEL_BUNDLE = ' + JSON.stringify(payloads.eson) + ';\n' +
    'var ESB64_ACCEL_BUNDLE = ' + JSON.stringify(payloads.esb64) + ';\n\n';
}

// Blanks the embedded payload string literals AND the generated embed header
// (exact regions - the build generated them, so their text is known
// byte-for-byte) so audits scan eshttp's OWN code only. The header documents
// the ESPACK bundler (build metadata, exempt like the payloads). Line breaks
// are preserved for stable line numbers.
function blankPayloadRegions(text, payloads) {
  var out = text;

  var hdrStart = out.indexOf('// GENERATED by eshttp-build.mjs');
  var hdrEnd = out.indexOf('var ESON_ACCEL_BUNDLE');
  if (hdrStart >= 0 && hdrEnd > hdrStart) {
    var hdrBlank = out.substring(hdrStart, hdrEnd).replace(/[^\n]/g, ' ');
    out = out.substring(0, hdrStart) + hdrBlank + out.substring(hdrEnd);
  }

  var decls = [
    'var ESON_ACCEL_BUNDLE = ' + JSON.stringify(payloads.eson),
    'var ESB64_ACCEL_BUNDLE = ' + JSON.stringify(payloads.esb64)
  ];
  for (var i = 0; i < decls.length; i++) {
    var idx = out.indexOf(decls[i]);
    if (idx >= 0) {
      var eol = out.indexOf('\n', idx);
      var end = eol >= 0 ? eol : idx + decls[i].length + 1;
      var blank = out.substring(idx, end).replace(/[^\n]/g, ' ');
      out = out.substring(0, idx) + blank + out.substring(end);
    }
  }
  return out;
}

mkdirSync(DIST, { recursive: true });
var payloads = loadAccelPayloads();
var payloadDecls = embedAccelPayloads(payloads);

// 1. ESM core bundle (Node harnesses import this) + embedded payloads.
var esmOut = join(DIST, 'eshttp-core.esm.mjs');
esmBuild(ENTRY, esmOut);
var esmFinal = payloadDecls + readFileSync(esmOut, 'utf8');
esmFinal = esmFinal.replace(/"use strict";?/g, '');
writeFileSync(esmOut, esmFinal);

// 2. JSX bundle with the ES3 shim prepended. ExtendScript (SpiderMonkey 2014)
//    lacks Object.defineProperty and Function.prototype.bind, which esbuild's
//    ES5 export helpers require.
var jsx = join(DIST, 'eshttp.jsx');
jsxBuild(ENTRY, jsx);

var shim = [
  'if (typeof Object.defineProperty !== "function") {',
  '  Object.defineProperty = function (obj, prop, desc) {',
  '    if (desc) {',
  '      if (typeof desc.get === "function") {',
  '        if (typeof obj.__defineGetter__ === "function") { obj.__defineGetter__(prop, desc.get); }',
  '        else { obj[prop] = desc.get(); }',
  '      } else if ("value" in desc) {',
  '        obj[prop] = desc.value;',
  '      }',
  '    }',
  '    return obj;',
  '  };',
  '  Object.getOwnPropertyDescriptor = function (obj, prop) {',
  '    return { value: obj[prop], writable: true, enumerable: true, configurable: true };',
  '  };',
  '  Object.getOwnPropertyNames = function (obj) {',
  '    var a = [], k;',
  '    for (k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { a.push(k); } }',
  '    return a;',
  '  };',
  '}',
  'if (typeof Function.prototype.bind !== "function") {',
  '  Function.prototype.bind = function (thisArg) {',
  '    var fn = this;',
  '    var args = Array.prototype.slice.call(arguments, 1);',
  '    return function () {',
  '      return fn.apply(thisArg, args.concat(Array.prototype.slice.call(arguments)));',
  '    };',
  '  };',
  '}',
  ''
].join('\n');

var finalJsx = payloadDecls + shim + readFileSync(jsx, 'utf8');
finalJsx = finalJsx.replace(/"use strict";?/g, '');

// 2a. ES3 reserved-word keys (LIVE-ENGINE FIX, verified in Illustrator 2026 by
//     qa-validator): esbuild's ES5 __export helper emits an UNQUOTED
//     `default:` object-literal key for a default export, and the ExtendScript
//     ES3 parser rejects reserved words as property names ->
//     `Illegal use of reserved word 'default'`. Quote it. The quote runs on
//     the RAW esbuild output (eshttp's own code only — the payloads are
//     appended later, so their string literals can never be touched).
var rawBundle = readFileSync(jsx, 'utf8');
var quotedBundle = rawBundle.replace(/(^|[^A-Za-z0-9_$"'\u00ff])(default)(\s*:\s*function\s*\()/g,
  function (all, pre, word, post) { return pre + '"default"' + post; });
if (quotedBundle.indexOf('{ default:') >= 0 || quotedBundle.indexOf('default: function') >= 0) {
  console.error('[eshttp-build] VERIFY FAIL: unquoted `default:` key still present after quoting pass');
  process.exit(1);
}

var finalJsx = payloadDecls + shim + quotedBundle;
finalJsx = finalJsx.replace(/"use strict";?/g, '');

// 2b. Unwrap the facade onto the global (jsxinc-compatible publish).
//     LIVE-ENGINE FIX (verified in Illustrator 2026 by qa-validator): the
//     esbuild wrapper's `eshttp.default` GETTER is unusable on ExtendScript —
//     the engine lacks __defineGetter__ and its Object.defineProperty
//     EAGERLY evaluates accessor getters at definition time (before
//     `var index_default = ...` executes), snapshotting `default` as
//     undefined. Source of truth: core-porter's index.ts publishes the facade
//     on $.global via a DATA descriptor (Object.defineProperty value form) —
//     the only publish form that survives the eager-getter quirk (verified
//     live: $.global.eshttp = full facade). The footer reads THAT first and
//     falls back to eshttp.default where accessors work (Node/V8). Guarded:
//     idempotent across repeated evals, inert when no facade is reachable.
var unwrap = [
  '',
  '(function () {',
  '  // Unwrap the facade onto the global (jsxinc-compatible publish).',
  '  var g = null;',
  '  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }',
  '  var d = null;',
  '  if (g && g.eshttp && typeof g.eshttp.request === "function") { d = g.eshttp; }',
  '  else if (eshttp && eshttp.default && typeof eshttp.default.request === "function") { d = eshttp.default; }',
  '  if (d && typeof eshttp.request !== "function") {',
  '    eshttp = d;',
  '    if (g && (!g.eshttp || typeof g.eshttp.request !== "function")) {',
  '      try { g.eshttp = d; } catch (e3) {}',
  '    }',
  '  }',
  '}());',
  ''
].join('\n');
finalJsx = finalJsx + unwrap;
writeFileSync(jsx, finalJsx);

// 3. Verify the ES3 artifact. target=es5 should prevent ES5+ syntax, but the
//    check is cheap and catches bundle regressions. Payload regions are
//    blanked before scanning so the audit covers eshttp's OWN generated code
//    (the payloads are sibling-QA'd; their legit ESPAK identifiers are
//    exempt). Build exits 1 on violation.
var hits = verifyEs3Output(jsx, finalJsx, payloads);
if (hits > 0) {
  console.error('[eshttp-build] ES3 VERIFICATION FAILED: ' + hits +
    ' forbidden token(s) found in ' + jsx + ' (see above)');
  process.exit(1);
}

console.log('[eshttp-build] wrote ' + join(DIST, 'eshttp.jsx') + ' (' + finalJsx.length +
  ' bytes, incl. embedded ' + payloads.esonFile + ' ' + payloads.eson.length +
  ' + ' + payloads.esb64File + ' ' + payloads.esb64.length + ') and ' +
  join(DIST, 'eshttp-core.esm.mjs') + ' (' + esmFinal.length + ' bytes)');

// 4. Include-compat copy (OPT-IN): dist/eshttp.jsx -> src/eshttp.jsxinc.
//    Keeps README/callers/live probes using `#include "eshttp.jsxinc"`
//    unchanged (rewrite-plan §4.2). OFF by default; the espack check scans
//    eshttp's OWN code only (payload regions blanked - embedded ESPAK
//    identifiers are legit per coordinator decision v2 §3).
if (process.argv.indexOf('--include-compat') >= 0) {
  var inc = join(ROOT, 'src', 'eshttp.jsxinc');
  var own = blankPayloadRegions(readFileSync(join(DIST, 'eshttp.jsx'), 'utf8'), payloads);
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

// 5. Stage eshttp-cli.exe (T10/T9 staging contract, build-contract v7):
//    copy native/eshttp-cli.exe -> %LOCALAPPDATA%\eshttp\eshttp-cli.exe
//    (driver-cli.ts findCliExe()'s FIRST candidate; ArcFit-style per-user
//    runtime root - the Scripts folder stays read-only). Job files go to
//    %TEMP%\opencode (the CLI's scan dir; not staged here - it is the C
//    scan path). COPY-with-guard: the exe is BUILT by the native lane
//    (native-renamer/T13); this step only verifies + stages it. Missing ->
//    WARN + skip (dist and the other transports still build; the cli tier is
//    simply unavailable at runtime). Present -> PE-verify (MZ magic) + stage
//    + FAIL on staging errors.
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
      '(build it via the native lane - see native/BUILD.md; native-renamer/T13 owns the compile)');
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

// 6. Release accel bundles (T23, v1.0.1 packaging restructure, per the
//    sponsor architecture decision): PIPE-PRIMARY packaging with NO dead
//    payloads and the native DLL as a separate opt-in build.
//      dist/eshttp.accel-x64.jsx  - cli x64 worker + ipc-x64 bridge ONLY
//      dist/eshttp.accel-x86.jsx  - cli-x86 worker + ipc-x86 bridge ONLY
//      dist/eshttp-native-accel.jsx - eshttp-x64.dll (WinHTTP wrapper) opt-in
//      dist/eshttp-native-accel-x86.jsx - eshttp-x86.dll (legacy hosts)
//    The 4-payload eshttp.accel.jsx is RETIRED (removed). Each pipe accel is
//    espack 1+n (shared ESB64Native accelerator) + the library IIFE + a
//    staging adapter that materializes the payloads to %LOCALAPPDATA%\eshttp
//    (findCliExe's FIRST candidate + the bridge path) with the CORRECT
//    bitness (canonical target names unchanged, so the driver needs zero
//    path changes). The native accel additionally prepends the staged dir to
//    ExternalObject.searchFolders so lib:eshttp resolves the in-process DLL.
//    Skill-cited design: externalobject-extendscript 'Load from JSX'
//    (searchFolders prepend + lib:Name resolution) and 'Additional host
//    observations' (a bitness mismatch fails cleanly - so each accel carries
//    ONE bitness; a host loads only its own). adobe-illustrator-scripting
//    §11 (ES3 output discipline) + §12 (bundle to one .jsx) + §14 (honest
//    packaging - no unmeasured claims).
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
  if (!existsSync(facade)) { missing.push('dist/eshttp.jsx (esbuild step must run first)'); }
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
  args.push('--out', tmpBundle, '--name', 'eshttp', '--quiet');
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  var bundleText = readFileSync(tmpBundle, 'utf8');
  var facadeText = readFileSync(facade, 'utf8');
  var adapter = accelAdapter(stageCalls);
  var accelOut = banner + bundleText + '\n' + facadeText + '\n' + adapter;
  writeFileSync(join(DIST, name), accelOut);
  console.log('[eshttp-build] wrote ' + join(DIST, name) + ' (' + accelOut.length + ' bytes)');
}

// Default pipe accels: ONE bitness each, NO native DLL payloads.
buildAccelBundle('eshttp.accel-x64.jsx',
  [
    { path: join(ROOT, 'native', 'eshttp-cli.exe') },
    { path: join(ROOT, 'native', 'eshttp-ipc-x64.dll') }
  ],
  [
    { idx: 0, target: 'eshttp-cli.exe' },
    { idx: 1, target: 'eshttp-ipc.dll' }
  ],
  '// eshttp.accel-x64.jsx - pipe-primary self-extracting bundle (x64: eshttp-cli.exe worker + eshttp-ipc.dll bridge; NO native DLL - that is the separate opt-in native accel)\n');

buildAccelBundle('eshttp.accel-x86.jsx',
  [
    { path: join(ROOT, 'native', 'eshttp-cli-x86.exe') },
    { path: join(ROOT, 'native', 'eshttp-ipc-x86.dll') }
  ],
  [
    { idx: 0, target: 'eshttp-cli.exe' },
    { idx: 1, target: 'eshttp-ipc.dll' }
  ],
  '// eshttp.accel-x86.jsx - pipe-primary self-extracting bundle (x86: eshttp-cli.exe worker + eshttp-ipc.dll bridge for legacy 32-bit hosts)\n');

// Native opt-in accel: the in-process WinHTTP wrapper DLL lane (separate per
// the sponsor decision - non-firewalled hosts wanting in-process native).
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

function verifyEs3Output(path, text, payloads) {
  var problems = 0;
  var own = blankPayloadRegions(text, payloads);

  // Shim present at the top of the eshttp code (payload decls precede it).
  if (own.indexOf('if (typeof Object.defineProperty !== "function")') < 0) {
    console.error('[eshttp-build] VERIFY FAIL: ES3 shim not found in ' + path);
    problems++;
  } else {
    console.log('[eshttp-build] verify: ES3 shim present in ' + path);
  }

  // No "use strict" directive left in (ES3-parser-hostile).
  if (/"use strict"/.test(own)) {
    console.error('[eshttp-build] VERIFY FAIL: "use strict" directive found in ' + path);
    problems++;
  } else {
    console.log('[eshttp-build] verify: no "use strict" directive in ' + path);
  }

  // Unwrap footer present (jsxinc-compatible publish) reading $.global first
  // (data-descriptor publish = the live-engine-safe source of truth).
  if (own.indexOf('// Unwrap the facade onto the global') < 0) {
    console.error('[eshttp-build] VERIFY FAIL: unwrap footer missing from ' + path);
    problems++;
  } else {
    console.log('[eshttp-build] verify: unwrap footer present in ' + path);
  }

  // No UNQUOTED reserved-word object keys remain (ES3 parser rejects them;
  // esbuild emits `default:` for default exports — live-engine failure). The
  // quoting pass turns them into "default":. Scan eshttp's own code only.
  if (/\bdefault\s*:\s*function\s*\(/.test(own)) {
    console.error('[eshttp-build] VERIFY FAIL: unquoted reserved-word key `default:` found in ' + path);
    problems++;
  } else {
    console.log('[eshttp-build] verify: no unquoted reserved-word keys (default:) in ' + path);
  }

  // Embedded payloads present + byte-exact (size sanity vs source files).
  var esonDecl = 'var ESON_ACCEL_BUNDLE = ' + JSON.stringify(payloads.eson);
  var esb64Decl = 'var ESB64_ACCEL_BUNDLE = ' + JSON.stringify(payloads.esb64);
  if (text.indexOf(esonDecl) < 0) {
    console.error('[eshttp-build] VERIFY FAIL: ESON_ACCEL_BUNDLE payload missing from ' + path);
    problems++;
  } else {
    console.log('[eshttp-build] verify: ESON_ACCEL_BUNDLE embedded (' + payloads.eson.length + ' bytes)');
  }
  if (text.indexOf(esb64Decl) < 0) {
    console.error('[eshttp-build] VERIFY FAIL: ESB64_ACCEL_BUNDLE payload missing from ' + path);
    problems++;
  } else {
    console.log('[eshttp-build] verify: ESB64_ACCEL_BUNDLE embedded (' + payloads.esb64.length + ' bytes)');
  }

  // Forbidden tokens in eshttp's OWN code: word-boundary let/const/class
  // declarations and arrows.
  var tokenRes = [
    { name: 'let', re: /\blet\s+[A-Za-z_$]/g },
    { name: 'const', re: /\bconst\s+[A-Za-z_$]/g },
    { name: 'class', re: /\bclass\s+[A-Za-z_$]/g },
    { name: 'arrow (=>)', re: /=>/g }
  ];
  var lines = own.split('\n');
  for (var t = 0; t < tokenRes.length; t++) {
    var spec = tokenRes[t];
    spec.re.lastIndex = 0;
    var m;
    while ((m = spec.re.exec(own)) !== null) {
      var lineNo = 1, i;
      for (i = 0; i < m.index; i++) { if (own.charAt(i) === '\n') { lineNo++; } }
      var snippet = lines[lineNo - 1] || '';
      if (snippet.length > 120) { snippet = snippet.substring(0, 120) + '...'; }
      console.error('[eshttp-build] VERIFY FAIL: ' + spec.name + ' at line ' + lineNo + ': ' + snippet);
      problems++;
    }
  }
  if (problems === 0) {
    console.log('[eshttp-build] verify: no forbidden tokens (let/const/class/=>) in eshttp own code of ' + path);
  }
  return problems;
}
