#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComToolRunner } from '../../../extendscript-toolchain/src/comtool-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const BUNDLE = join(ROOT, 'dist', 'eshttp.accel-x64.jsx');
if (!existsSync(BUNDLE)) throw new Error('manifest-v2 x64 bundle missing: ' + BUNDLE);

const probeDir = mkdtempSync(join(HERE, '.eshttp-v2-live-'));
const probe = join(probeDir, 'probe.jsx');
const bundlePath = BUNDLE.replace(/\\/g, '/').replace(/"/g, '\\"');

writeFileSync(probe, [
  '#target illustrator',
  '(function () {',
  '  $.global["eshttp"] = null;',
  '  $.global["ESON"] = null;',
  '  $.global["ESB64"] = null;',
  '  $.global["ESPAK"] = null;',
  '  $.global["__ESPAK_LIBRARIES__"] = null;',
  '  var out = { ok: false, checks: [] };',
  '  function check(name, value) { out.checks[out.checks.length] = { name: name, ok: value === true }; if (value !== true) throw new Error(name); }',
  '  try {',
  '    $.evalFile(File("' + bundlePath + '"));',
  '    var P = $.global["ESPAK"];',
  '    var B = $.global["ESB64"];',
  '    var J = $.global["ESON"];',
  '    var H = $.global["eshttp"];',
  '    check("root globals", !!P && !!B && !!J && !!H);',
  '    check("single control plane", P.version === "0.5.0" && P.config && P.config.bundleName === "eshttp");',
  '    var libs = typeof P.libraryList === "function" ? P.libraryList() : [];',
  '    check("dependency-first closure", libs.length === 3 && libs[0].id === "esb64" && libs[1].id === "eson" && libs[2].id === "eshttp");',
  '    check("ESB64 activated", typeof B.atob === "function" && typeof B.btoa === "function");',
  '    check("ESON activated", typeof J.parse === "function" && typeof J.stringify === "function" && J.parse("{\\\"a\\\":1}").a === 1);',
  '    check("ESON borrowed native", J.espack && J.espack.ok === true && J.espack.caps && J.espack.caps.owned === false);',
  '    check("ESHTTP activated", typeof H.configure === "function" && typeof H.get === "function" && typeof H.json === "function" && typeof H.request === "function");',
  '    check("payload closure", P.config.payloads.length === 3);',
  '    var B0 = B, J0 = J, H0 = H;',
  '    $.evalFile(File("' + bundlePath + '"));',
  '    var libs2 = $.global.ESPAK.libraryList();',
  '    check("cross-evaluation dedup", $.global.ESB64 === B0 && $.global.ESON === J0 && $.global.eshttp === H0 && libs2.length === 3);',
  '    out.ok = true;',
  '  } catch (error) { out.error = String(error); }',
  '  return out.toSource();',
  '}());'
].join('\n'), 'utf8');

const COM = createComToolRunner();
try {
  const result = await COM.run(['eval', '--file', probe, '--launch'], { timeoutMs: 240000 });
  if (!result.ok) throw new Error(JSON.stringify(result.error || result));
  const text = String(result.result);
  assert.match(text, /ok:true/);
  assert.doesNotMatch(text, /ok:false/);
  console.log('[manifest-v2-live] PASS x64 root-only ESB64 -> ESON -> ESHTTP activation + borrowed ESON + cross-evaluation dedup');
} finally {
  await COM.close().catch(() => {});
  rmSync(probeDir, { recursive: true, force: true });
}
