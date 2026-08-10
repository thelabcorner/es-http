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
const parseUrl = eshttp.helpers.parseUrl;

const urls = [
  'https://user:pw@example.com:8443/a/b?x=1#frag',
  'http://example.com/path',
  'https://api.github.com/users/octocat/repos?page=2&per_page=100',
  'http://localhost:3000/api/v1/users',
  'https://example.com:8443/very/long/path/with/many/segments/and/query?param1=value1&param2=value2&param3=value3#fragment'
];

function bench(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    for (const url of urls) {
      fn(url);
    }
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

const iterations = 10000;
const time = bench(parseUrl, iterations);
console.log('_parseUrl:', time.toFixed(2), 'ms for', iterations * urls.length, 'calls');
console.log('Per call:', (time / (iterations * urls.length) * 1000).toFixed(3), 'μs');