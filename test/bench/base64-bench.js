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

const testStrings = [
  'hello world',
  'a'.repeat(100),
  'a'.repeat(1000),
  'a'.repeat(10000),
  'hello\x00world\xfftest',
  'a'.repeat(50000)
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

const iterations = 5000;
const time = bench(base64Encode, iterations);
console.log('_base64Encode:', time.toFixed(2), 'ms for', iterations * testStrings.length, 'calls');
console.log('Per call:', (time / (iterations * testStrings.length) * 1000).toFixed(3), 'μs');