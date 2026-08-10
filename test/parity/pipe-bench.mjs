#!/usr/bin/env node
/*
 * pipe-bench.mjs - T21 pipe-lane warm benchmark (vs one-shot job-file).
 * ============================================================================
 * Sponsor mandate ("ship performance"): the pipe lane (persistent worker +
 * named-pipe IPC) is the v1 primary cli transport; the job-file one-shot path
 * becomes the degradation lane. This benchmark measures the real difference:
 *
 *   pipe    : driver-cli pipe lane (eshttp-ipc.dll bridge -> eshttp-cli.exe
 *             --worker over \\\\.\pipe\EshttpBridge). meta.path = "cli".
 *   oneshot : job-file scan-claim degradation (File.execute spawn + WinHTTP
 *             cold start). meta.path = "cli-oneshot".
 *
 * Methodology (adobe-illustrator-scripting SKILL.md §9): warmups >= 5,
 * measured N >= 5 (default 10), report median + p95 + sd, environment line.
 * Measures END-TO-END wrapper request() time. Drives the REAL harness
 * (test/load-core.mjs) with the fake bridge/CLI responders (no network):
 *   - oneshot lane: bridge OFF + cli ON + forceTransport("cli") ->
 *                   meta.path "cli-oneshot" (job-file degradation)
 *   - pipe lane   : bridge ON (fake eshttp-ipc.dll) + cli ON +
 *                   forceTransport("cli") -> meta.path "cli"
 * The pipe cold sample (first request, ensureWorker spawn included) is the
 * spawn-amortization evidence: warm median vs cold-with-spawn.
 *
 * Usage: node test/parity/pipe-bench.mjs [--iter N] [--warm N]
 * Writes baseline.json (committed as the release record).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
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
    t.push((hrtime() - s) / 1e6); // ms
  }
  const med = median(t);
  const sd = Math.sqrt(t.reduce((a, v) => a + (v - med) ** 2, 0) / (t.length - 1));
  console.log(`${label}: median=${med.toFixed(3)}ms p95=${pct(t, 95).toFixed(3)}ms sd=${sd.toFixed(3)}ms n=${t.length}`);
  return { median: med, p95: pct(t, 95), sd: sd, n: t.length };
}

const env = `node ${process.version} ${process.platform} ${process.arch}`;
console.log(`=== eshttp cli transport benchmark (T21) - iter=${iter} warm=${warm} ===`);
console.log('env: ' + env);

const results = { env, iter, warm, timestamp: new Date().toISOString() };

// ---- oneshot lane FIRST (bridge OFF + cli forced -> job-file degrade) ----
controls.setExternalObjectAvailable(false);   // no native DLL lane
controls.setBridgeAvailable(false);           // no bridge -> pipe dead -> oneshot
controls.setCliAvailable(true);               // fake CLI shim + File stubs
controls.setSocketAvailable(true);
eshttp.resetTransport();
eshttp.forceTransport("cli");
const probeOne = eshttp.request({ url: 'http://127.0.0.1:1/bench' });
const onePath = probeOne && probeOne.meta ? probeOne.meta.path : '(none)';
console.log('oneshot lane meta.path: ' + onePath);
if (onePath !== 'cli-oneshot') {
  console.log('WARNING: oneshot lane not active (meta.path=' + onePath + ')');
}
const oneshot = bench('oneshot (job-file)', () => {
  eshttp.request({ url: 'http://127.0.0.1:1/bench' });
});
results.oneshot = { ...oneshot, metaPath: onePath };

// ---- pipe lane (bridge ON -> primary cli = pipe) ----
controls.setBridgeAvailable(true);            // fake eshttp-ipc.dll bridge
if (controls.clearWorkerPid) { controls.clearWorkerPid(); }
eshttp.resetTransport();
eshttp.forceTransport("cli");
const probePipe = eshttp.request({ url: 'http://127.0.0.1:1/bench' });
const pipePath = probePipe && probePipe.meta ? probePipe.meta.path : '(none)';
console.log('pipe lane meta.path: ' + pipePath);
if (pipePath !== 'cli') {
  console.log('WARNING: pipe lane not active (meta.path=' + pipePath + '); the driver may have degraded.');
}
// cold sample (ensureWorker spawn included) - spawn-amortization evidence
let coldMs = null;
{
  eshttp.resetTransport();
  eshttp.forceTransport("cli");
  const s = hrtime();
  eshttp.request({ url: 'http://127.0.0.1:1/bench' });
  coldMs = (hrtime() - s) / 1e6;
  console.log(`pipe cold (ensureWorker spawn included): ${coldMs.toFixed(3)}ms`);
}
const pipe = bench('pipe (warm, named-pipe)', () => {
  eshttp.request({ url: 'http://127.0.0.1:1/bench' });
});
results.pipe = { ...pipe, coldWithSpawnMs: coldMs, metaPath: pipePath };

// ---- summary + baseline.json ----
if (pipe.median > 0 && oneshot.median > 0) {
  console.log(`---`);
  console.log(`pipe/oneshot ratio: ${(pipe.median / oneshot.median).toFixed(2)}x ` +
    `(pipe ${pipe.median.toFixed(3)}ms vs oneshot ${oneshot.median.toFixed(3)}ms)`);
  results.ratioPipeVsOneshot = pipe.median / oneshot.median;
  results.amortization = {
    spawnAmortized: coldMs > 0 ? (coldMs / pipe.median).toFixed(1) + 'x cold-vs-warm' : null,
    note: 'cold sample includes ensureWorker spawn; warm median is steady-state'
  };
}
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'baseline.json');
writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
console.log('baseline written: ' + outPath);
