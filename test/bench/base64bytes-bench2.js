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
const base64Encode = eshttp.helpers.base64Encode;

// Test latin1 only (fast path in _base64EncodeBytes)
const latin1Bodies = [
  'hello world',
  'a'.repeat(100),
  'a'.repeat(1000),
  'a'.repeat(10000),
  'a'.repeat(50000),
  'a'.repeat(100000),
];

// Test non-latin1 (slow path in _base64EncodeBytes)
const nonLatin1Bodies = [
  'hello\u0100world',
  'a'.repeat(100) + '\u0100',
  'a'.repeat(1000) + '\u0100',
  'a'.repeat(10000) + '\u0100',
  'a'.repeat(50000) + '\u0100',
  '\u0100\u0101\u0102\u0103\u0104\u0105\u0106\u0107',
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

console.log('=== _base64Encode (public, latin1 only) ===');
const time1 = bench(base64Encode, latin1Bodies, iterations);
console.log('Time:', time1.toFixed(2), 'ms for', iterations * latin1Bodies.length, 'calls');
console.log('Per call avg:', (time1 / (iterations * latin1Bodies.length) * 1000).toFixed(3), 'μs');

console.log('\n=== _base64Encode (public, non-latin1 throws) ===');
try {
  const time2 = bench(base64Encode, nonLatin1Bodies, iterations);
  console.log('Time:', time2.toFixed(2), 'ms for', iterations * nonLatin1Bodies.length, 'calls');
  console.log('Per call avg:', (time2 / (iterations * nonLatin1Bodies.length) * 1000).toFixed(3), 'μs');
} catch (e) {
  console.log('Throws as expected for non-latin1:', e.message);
}

// Test parseHttpResponse which uses _base64EncodeBytes internally
const parseHttpResponse = eshttp.helpers.parseHttpResponse;

console.log('\n=== parseHttpResponse (latin1 body) ===');
const latin1Raw = latin1Bodies.map(body => 
  'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ' + body.length + '\r\n\r\n' + body
);
const time3 = bench(parseHttpResponse, latin1Raw, 2000);
console.log('Time:', time3.toFixed(2), 'ms for', 2000 * latin1Raw.length, 'calls');
console.log('Per call avg:', (time3 / (2000 * latin1Raw.length) * 1000).toFixed(3), 'μs');

console.log('\n=== parseHttpResponse (non-latin1 body - exercises _base64EncodeBytes slow path) ===');
const nonLatin1Raw = nonLatin1Bodies.map(body => 
  'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ' + body.length + '\r\n\r\n' + body
);
const time4 = bench(parseHttpResponse, nonLatin1Raw, 2000);
console.log('Time:', time4.toFixed(2), 'ms for', 2000 * nonLatin1Raw.length, 'calls');
console.log('Per call avg:', (time4 / (2000 * nonLatin1Raw.length) * 1000).toFixed(3), 'μs');