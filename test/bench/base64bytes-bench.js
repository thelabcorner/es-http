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

// Access internal _base64EncodeBytes via the parseHttpResponse path
// We'll test by creating a response with non-latin1 body
const parseHttpResponse = eshttp.helpers.parseHttpResponse;

// Test strings with non-latin1 chars (triggers the slow path)
const testBodies = [
  'hello world',  // latin1 only - fast path
  'hello\u0100world',  // non-latin1 - slow path
  'a'.repeat(1000) + '\u0100',  // 1KB + non-latin1
  'a'.repeat(10000) + '\u0100\u0101\u0102',  // 10KB + non-latin1
  'a'.repeat(50000) + '\u0100',  // 50KB + non-latin1
  '\u0100\u0101\u0102\u0103\u0104\u0105\u0106\u0107',  // all non-latin1
];

function bench(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    for (const body of testBodies) {
      // Create a minimal HTTP response with this body
      const raw = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ' + body.length + '\r\n\r\n' + body;
      fn(raw, 1000000);
    }
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

const iterations = 2000;
const time = bench(parseHttpResponse, iterations);
console.log('parseHttpResponse (with bodyBytes):', time.toFixed(2), 'ms for', iterations * testBodies.length, 'calls');
console.log('Per call avg:', (time / (iterations * testBodies.length) * 1000).toFixed(3), 'μs');