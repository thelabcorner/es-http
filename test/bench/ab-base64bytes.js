// A/B benchmark for _base64EncodeBytes slow path (non-latin1 input)
// Reconstructs the original double-pass implementation for "before" measurement

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

// The current optimized _base64EncodeBytes is internal, not exposed.
// We'll test via parseHttpResponse which calls it for bodyBytes.
// But we need to isolate just the base64 encode. Let's extract the internal
// functions by evaluating them in the same context.

// Reconstruct the ORIGINAL _base64EncodeBytes (double-pass) from the pre-edit logic
const originalBase64EncodeBytes = `
var _B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var _B64_A = [];
var _B64_B = [];
var _B64_DEC = [];
(function () {
    var i;
    for (i = 0; i < 64; i++) { _B64_A[i] = _B64_CHARS.charAt(i); }
    for (i = 0; i < 256; i++) { _B64_B[i] = String.fromCharCode(i); _B64_DEC[i] = -1; }
    for (i = 0; i < 64; i++) { _B64_DEC[_B64_CHARS.charCodeAt(i)] = i; }
})();
var _NON_LATIN1_RE = /[^\\x00-\\xff]/;
var _B64_FLUSH = 128;

function _b64EncodeRaw(raw, n) {
    var out = [];
    var buf = [];
    var bi = 0;
    var A = _B64_A;
    var i = 0;
    var b0, b1, b2, t;
    var main = n - 2;
    for (; i < main; i += 3) {
        b0 = raw.charCodeAt(i);
        b1 = raw.charCodeAt(i + 1);
        b2 = raw.charCodeAt(i + 2);
        t = b1 >> 4;
        buf[bi++] = A[b0 >> 2] + A[((b0 & 3) << 4) + t];
        t = b2 >> 6;
        buf[bi] = A[((b1 & 15) << 2) + t] + A[b2 & 63];
        bi++;
        if (bi >= _B64_FLUSH) {
            buf.length = bi;
            out[out.length] = buf.join("");
            buf = [];
            bi = 0;
        }
    }
    var rem = n - i;
    if (rem === 1) {
        b0 = raw.charCodeAt(i);
        buf[bi++] = A[b0 >> 2] + A[(b0 & 3) << 4] + "==";
    } else if (rem === 2) {
        b0 = raw.charCodeAt(i);
        b1 = raw.charCodeAt(i + 1);
        t = b1 >> 4;
        buf[bi++] = A[b0 >> 2] + A[((b0 & 3) << 4) + t] + A[(b1 & 15) << 2] + "=";
    }
    if (bi > 0) {
        buf.length = bi;
        out[out.length] = buf.join("");
    }
    return out.join("");
}

// ORIGINAL double-pass _base64EncodeBytes
function _base64EncodeBytes_ORIGINAL(bytes) {
    var raw = String(bytes);
    var n = raw.length;
    if (n === 0) { return ""; }
    if (!_NON_LATIN1_RE.test(raw)) { return _b64EncodeRaw(raw, n); }
    var masked = [];
    var mi = 0;
    var chunk = [];
    var ci = 0;
    for (var i = 0; i < n; i++) {
        chunk[ci++] = _B64_B[raw.charCodeAt(i) & 0xFF];
        if (ci >= 1024) { chunk.length = ci; masked[mi++] = chunk.join(""); chunk = []; ci = 0; }
    }
    if (ci > 0) { chunk.length = ci; masked[mi++] = chunk.join(""); }
    var flat = masked.join("");
    return _b64EncodeRaw(flat, flat.length);
}

// OPTIMIZED single-pass _base64EncodeBytes (current implementation)
function _base64EncodeBytes_OPTIMIZED(bytes) {
    var raw = String(bytes);
    var n = raw.length;
    if (n === 0) { return ""; }
    if (!_NON_LATIN1_RE.test(raw)) { return _b64EncodeRaw(raw, n); }
    var out = [];
    var buf = [];
    var bi = 0;
    var A = _B64_A;
    var i = 0;
    var b0, b1, b2, t;
    var main = n - 2;
    for (; i < main; i += 3) {
        b0 = raw.charCodeAt(i) & 0xFF;
        b1 = raw.charCodeAt(i + 1) & 0xFF;
        b2 = raw.charCodeAt(i + 2) & 0xFF;
        t = b1 >> 4;
        buf[bi++] = A[b0 >> 2] + A[((b0 & 3) << 4) + t];
        t = b2 >> 6;
        buf[bi] = A[((b1 & 15) << 2) + t] + A[b2 & 63];
        bi++;
        if (bi >= _B64_FLUSH) {
            buf.length = bi;
            out[out.length] = buf.join("");
            buf = [];
            bi = 0;
        }
    }
    var rem = n - i;
    if (rem === 1) {
        b0 = raw.charCodeAt(i) & 0xFF;
        buf[bi++] = A[b0 >> 2] + A[(b0 & 3) << 4] + "==";
    } else if (rem === 2) {
        b0 = raw.charCodeAt(i) & 0xFF;
        b1 = raw.charCodeAt(i + 1) & 0xFF;
        t = b1 >> 4;
        buf[bi++] = A[b0 >> 2] + A[((b0 & 3) << 4) + t] + A[(b1 & 15) << 2] + "=";
    }
    if (bi > 0) {
        buf.length = bi;
        out[out.length] = buf.join("");
    }
    return out.join("");
}
`;

vm.runInContext(originalBase64EncodeBytes, ctx, { filename: 'benchmark-helpers.js' });

const originalFn = ctx._base64EncodeBytes_ORIGINAL;
const optimizedFn = ctx._base64EncodeBytes_OPTIMIZED;

// Test inputs that trigger the slow path (non-latin1)
const testInputs = [
  'hello\u0100world',                    // 11 chars, 1 non-latin1
  'a'.repeat(100) + '\u0100',            // 101 chars
  'a'.repeat(500) + '\u00e9\u0000',      // 502 chars, mixed
  'a'.repeat(1000) + '\u0100',           // 1001 chars
  'a'.repeat(5000) + '\u0100\u0101',     // 5002 chars
  '\u0100\u0101\u0102\u0103\u0104\u0105\u0106\u0107', // 8 chars, all non-latin1
  'binary\x00\x01\x02\x03\xff\xfe\xfd',  // binary-like
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

const iterations = 10000;

console.log('=== A/B Benchmark: _base64EncodeBytes slow path (non-latin1 input) ===');
console.log('Iterations:', iterations, 'x', testInputs.length, 'inputs =', iterations * testInputs.length, 'calls');
console.log('');

const beforeTime = bench(originalFn, testInputs, iterations);
console.log('BEFORE (original double-pass):', beforeTime.toFixed(2), 'ms');
console.log('Per call:', (beforeTime / (iterations * testInputs.length) * 1000).toFixed(3), 'μs');
console.log('');

const afterTime = bench(optimizedFn, testInputs, iterations);
console.log('AFTER (optimized single-pass):', afterTime.toFixed(2), 'ms');
console.log('Per call:', (afterTime / (iterations * testInputs.length) * 1000).toFixed(3), 'μs');
console.log('');

const speedup = ((beforeTime - afterTime) / beforeTime * 100).toFixed(1);
console.log('Speedup:', speedup + '% faster');
console.log('Ratio:', (beforeTime / afterTime).toFixed(2) + 'x');