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

// Access the internal _base64EncodeBytes via the helpers - it's not exposed
// But we can test the internal path by calling the function that uses it
// Actually, let's just test _base64Encode with latin1-only strings (what _base64EncodeBytes would get)

const base64Encode = eshttp.helpers.base64Encode;

// Realistic response body sizes
const testStrings = [
  '{"status":"ok","data":[1,2,3,4,5]}',  // ~35 bytes - typical JSON response
  'x'.repeat(100),                        // 100 bytes
  'x'.repeat(1000),                       // 1 KB
  'x'.repeat(10000),                      // 10 KB
  'x'.repeat(50000),                      // 50 KB
  'x'.repeat(100000),                     // 100 KB
];

function bench(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    for (const s of testStrings) {
      fn(s);
    }
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

const iterations = 2000;
const time = bench(base64Encode, iterations);
console.log('_base64Encode (latin1):', time.toFixed(2), 'ms for', iterations * testStrings.length, 'calls');
console.log('Per call avg:', (time / (iterations * testStrings.length) * 1000).toFixed(3), 'μs');

// Also test small strings only (more realistic for headers)
const smallStrings = [
  'hello',
  'hello world',
  'a'.repeat(50),
  'a'.repeat(100),
];
const time2 = bench(base64Encode, 10000);
console.log('\n_base64Encode (small):', time2.toFixed(2), 'ms for', 10000 * smallStrings.length, 'calls');
console.log('Per call avg:', (time2 / (10000 * smallStrings.length) * 1000).toFixed(3), 'μs');