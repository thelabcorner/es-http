#!/usr/bin/env node
/*
 * dll-vs-pipe-bench.mjs — T25 driver-level head-to-head: native-DLL lane vs
 * pipe lane (wrapper-level transport overhead), apples-to-apples.
 * ============================================================================
 * Sponsor v1.0.1 requirement (no speed claims without measurement): the 44x
 * pipe-vs-oneshot was driver-level. The pipe-vs-native-DLL comparison was
 * UNMEASURED. This bench measures exactly the claim at stake:
 *
 *   native-DLL lane : wrapper -> ExternalObject eshttp_request (in-process,
 *                     fake eshttp.dll responder, instant envelope)
 *   pipe lane       : wrapper -> eshttp-ipc bridge -> named-pipe worker
 *                     (fake bridge + fake worker, instant report)
 *
 * Both lanes run in the SAME Node harness with FAKE responders — this
 * isolates the WRAPPER-LEVEL transport overhead of each boundary, which is
 * the honest, publishable comparison (the real-DLL vs real-pipe live
 * comparison requires a non-firewalled host and is documented as
 * UNVERIFIED-LIVE separately).
 *
 * Methodology (skill §9): warmups >= 5, measured N >= 10, report median/p95/
 * sd + env line. Same harness machinery as the 44x pipe-vs-oneshot bench.
 *
 * Usage: node test/parity/dll-vs-pipe-bench.mjs [--iter N] [--warm N]
 */
import { loadCore } from '../load-core.mjs';

const args = process.argv.slice(2);
let iter = 10, warm = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--iter') { iter = parseInt(args[i + 1], 10) || 10; }
  if (args[i] === '--warm') { warm = parseInt(args[i + 1], 10) || 5; }
}

const { eshttp, controls } = await loadCore({ source: 'esm' });

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function hrtime() { const [s, ns] = process.hrtime(); return s * 1e9 + ns; }
function bench(label, fn) {
  for (let i = 0; i < warm; i++) { fn(); }
  const t = [];
  for (let i = 0; i < iter; i++) {
    const s = hrtime();
    fn();
    t.push((hrtime() - s) / 1e6);
  }
  const med = median(t);
  const sd = Math.sqrt(t.reduce((a, v) => a + (v - med) ** 2, 0) / (t.length - 1));
  console.log(`${label}: median=${med.toFixed(3)}ms p95=${pct(t, 95).toFixed(3)}ms sd=${sd.toFixed(3)}ms n=${t.length}`);
  return med;
}

console.log(`=== eshttp driver-level: native-DLL vs pipe (T25) — iter=${iter} warm=${warm} ===`);
console.log('env: node ' + process.version + ' ' + process.platform + ' ' + process.arch);
console.log('note: BOTH lanes use fake responders (wrapper-level transport overhead);');
console.log('      real-DLL vs real-pipe live is UNVERIFIED-LIVE (needs non-firewalled host).\n');

// ---- native-DLL lane (fake eshttp.dll, instant envelope) ----
controls.setExternalObjectAvailable(true);   // native ctor
controls.setBridgeAvailable(false);
controls.setCliAvailable(true);
controls.setSocketAvailable(true);
eshttp.resetTransport();
eshttp.forceTransport('native');
// ensure the native responder is the default healthy envelope
controls.setNativeResponder(null);
const dllMed = bench('native-DLL lane (ExternalObject in-process)', () => {
  eshttp.request({ url: 'http://127.0.0.1:1/dll' });
});

// ---- pipe lane (fake bridge + fake worker, instant report) ----
controls.setExternalObjectAvailable(false);
controls.setBridgeAvailable(true);           // bridge ctor
controls.setCliAvailable(true);
controls.setSocketAvailable(true);
eshttp.resetTransport();
eshttp.forceTransport('cli');
controls.setBridgeResponder(null);           // default instant envelope
controls.bridgeState.workerSpawns = 0;
controls.clearWorkerPid();
const pipeMed = bench('pipe lane (bridge + named-pipe worker)', () => {
  eshttp.request({ url: 'http://127.0.0.1:1/pipe' });
});

console.log('');
const ratio = pipeMed / dllMed;
console.log(`pipe/native-DLL ratio: ${ratio.toFixed(3)}x (pipe ${pipeMed.toFixed(3)}ms vs DLL ${dllMed.toFixed(3)}ms)`);
console.log('interpretation: <1 = pipe cheaper wrapper overhead; >1 = DLL cheaper wrapper overhead');
