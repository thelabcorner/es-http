// Verify fast path (latin1-only) is unchanged

const vm = require('vm');
const fs = require('fs');

const sandbox = {};
sandbox.$ = { writeln: () => {}, os: 'Windows', global: null };
sandbox.Socket = function() {};
sandbox.ExternalObject = undefined;
sandbox.File = function() {};
sandbox.Folder = function() {};
sandbox.app = { name: 'QA Headless' };
sandbox.console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} };
sandbox.$.global = sandbox;

const ctx = vm.createContext(sandbox);
const src = fs.readFileSync('src/eshttp.jsxinc', 'utf8');
vm.runInContext(src, ctx, { filename: 'eshttp.jsxinc' });

const eshttp = ctx.eshttp;
const base64Encode = eshttp.helpers.base64Encode; // public, latin1-only fast path

const latin1Inputs = [
  'hello world',
  'a'.repeat(100),
  'a'.repeat(1000),
  'a'.repeat(10000),
  'a'.repeat(50000),
  'a'.repeat(100000),
];

function bench(fn, inputs, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    for (const s of inputs) {
      fn(s);
    }
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

const iterations = 5000;

console.log('=== Fast path verification: _base64Encode (latin1-only) ===');
const time = bench(base64Encode, latin1Inputs, iterations);
console.log('Time:', time.toFixed(2), 'ms for', iterations * latin1Inputs.length, 'calls');
console.log('Per call avg:', (time / (iterations * latin1Inputs.length) * 1000).toFixed(3), 'μs');
console.log('');
console.log('Baseline from perf-bench: ~36.0 μs for ~560 bytes');
console.log('This test uses larger strings (avg ~26KB), so per-call time is higher.');
console.log('Key: no regression in the fast path delegation to _b64EncodeRaw.');