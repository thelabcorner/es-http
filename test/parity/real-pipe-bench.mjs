// real-pipe-bench.mjs — T21 REAL-pipe warm fetch benchmark.
// Measures the ACTUAL named-pipe worker round-trip: the wrapper's cli pipe
// lane spawns the persistent eshttp-cli.exe --worker (staged by the accel at
// %LOCALAPPDATA%\eshttp), which holds a warm WinHTTP session. Each request
// rides the pipe (eshttp-ipc.dll bridge) with NO spawn — the keep-alive
// connection pool + TLS cache stay warm across requests. The mock server is
// LOCAL (no firewall involvement): this isolates the transport + WinHTTP
// round-trip from external network latency.
import http from 'node:http';
import { loadCore } from '../load-core.mjs';

const ITER = 10, WARM = 5;

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

// local mock server (small SVG body, like the Wikipedia W)
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><path d="M10 10h108v108z"/></svg>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(svg);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('local mock server: 127.0.0.1:' + port + ' (svg ' + svg.length + 'B)');

const { eshttp, controls } = await loadCore({ source: 'esm' });
controls.setExternalObjectAvailable(false);
controls.setBridgeAvailable(true);   // real eshttp-ipc.dll is staged
controls.setCliAvailable(true);
controls.setSocketAvailable(true);
eshttp.resetTransport();
eshttp.forceTransport('cli');

// Warmup: spawn the worker + a few requests
for (let i = 0; i < WARM; i++) {
  const r = eshttp.get('http://127.0.0.1:' + port + '/bench.svg', { timeout: 30000 });
  if (!r || r.meta.path !== 'cli' || r.status !== 200) {
    console.log('WARMUP FAIL: path=' + (r && r.meta.path) + ' status=' + (r && r.status) + ' err=' + (r && r.error ? r.error.code : 'none'));
  }
}
console.log('worker spawned:', controls.bridgeState.workerSpawns, '| alive:', controls.bridgeState.workerAlive);
console.log('transportInfo:', eshttp.transportInfo().transport);

// Measured: warm pipe fetch (persistent worker, keep-alive WinHTTP)
const t = [];
for (let i = 0; i < ITER; i++) {
  const s = hrtime();
  const r = eshttp.get('http://127.0.0.1:' + port + '/bench.svg', { timeout: 30000 });
  t.push((hrtime() - s) / 1e6);
  if (r.meta.path !== 'cli') { console.log('ITER ' + i + ' path=' + r.meta.path + ' (not cli!)'); }
  if (r.status !== 200) { console.log('ITER ' + i + ' status=' + r.status + ' err=' + (r.error ? r.error.code : 'none')); }
}
const med = median(t), sd = Math.sqrt(t.reduce((a, v) => a + (v - med) ** 2, 0) / (t.length - 1));
console.log('=== REAL pipe warm fetch ===');
console.log('median=' + med.toFixed(3) + 'ms p95=' + pct(t, 95).toFixed(3) + 'ms sd=' + sd.toFixed(3) + 'ms n=' + t.length);
console.log('meta.path=cli (pipe lane), worker persistent, keep-alive WinHTTP');
console.log('(vs oneshot job-file transport-overhead baseline 1.746ms)');

server.close();
// quit the worker cleanly
try { controls.bridgeState; } catch (e) {}
try {
  const b = new globalThis.ExternalObject('lib:eshttp-ipc');
  if (b && typeof b.eshttp_pipe_request === 'function') { b.eshttp_pipe_request('quit', '', 3000); }
} catch (e) {}
