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
const jsonStringify = eshttp.helpers.jsonStringify;

const testObjects = [
  { a: 1, b: 'hello' },
  { arr: [1,2,3,4,5], obj: { x: 10, y: 20 } },
  { data: 'x'.repeat(1000) },
  { nested: { deep: { deeper: { value: 42 } } } },
  [1,2,3,4,5,6,7,8,9,10],
  { unicode: '日本語テスト\u00e9' }
];

function bench(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    for (const obj of testObjects) {
      fn(obj);
    }
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

const iterations = 10000;
const time = bench(jsonStringify, iterations);
console.log('_jsonEncode:', time.toFixed(2), 'ms for', iterations * testObjects.length, 'calls');
console.log('Per call:', (time / (iterations * testObjects.length) * 1000).toFixed(3), 'μs');