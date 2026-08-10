// ESHTTP public facade + request orchestration (ported from
// src/eshttp.jsxinc L1992–2496; http-api-v1, docs/api-spec.md).
//
// This module assembles the full `eshttp` facade OBJECT exactly like the
// jsxinc: plain props for functions (request/get/post/put/del/json/
// configure/forceTransport/resetTransport/transportInfo/helpers/error/
// version), Object.defineProperty GETTERS for `transport` (live) and
// `DEFAULTS` (fresh snapshot per access), and a plain mutable `__noNetwork`
// prop (test hook). The build contract requires ONE default export — the
// facade object — and eshttp-build.mjs appends the idempotent unwrap footer
// that republishes it as the global `eshttp`.
//
// NEVER-throws contract (api-spec §2/§3): _request catches every validation
// throw and every transport failure into an error Result. Only catastrophic
// internal bugs may throw.
import { isObj, has, now, toLower } from './utils';
import { mkError, _errorConsts } from './errors';
import {
  jsonParse, jsonParseStrict, jsonStringify
} from './vendor-json';
import {
  base64Encode, base64Decode, utf8Encode, utf8Decode, utf8ByteLength
} from './vendor-b64';
import { parseUrl, urlString, sameHost, resolveUrl } from './url';
import { buildQuery, encComponent } from './querystring';
import {
  normalizeRequestHeaders, parseResponseHeaders
} from './headers';
import { parseHttpResponse, dechunk } from './http';
import { buildContext, safeGet, safeStr, errMessage } from './context';
import { nativeRequest, nativeEnvelopeToResult, probeNative, nativeCacheGet } from './driver-native';
import { socketRequest, socketErrorResult, socketAvailable } from './driver-socket';
import { cliRequest, cliAvailable, resetCliState } from './driver-cli';
import { resolveTransport } from './transport';
import { redirectResult } from './redirect';
import { Result, Options } from './types';
import {
  _defaults, _ABI, _nativeCacheKey, _currentTransport,
  setForcedTransport, setNativeCache, setDetectedTransport,
  sessionGlobal, noNetwork, setFacade, _VERSION
} from './state';

var eshttp: any = { version: _VERSION };

/* ------------------------------------------------------------------ *
 * Core request orchestration (NEVER throws for I/O / validation)
 * ------------------------------------------------------------------ */
function request(opts: Options): Result {
  var startMs = now();

  // __noNetwork test hook: fail fast, touch nothing.
  if (noNetwork()) {
    return errorResult(
      mkError("unsupported", "network disabled (eshttp.__noNetwork is true)"),
      "none", "", 0, startMs
    );
  }

  var ctx: any;
  try {
    ctx = buildContext(opts);
  } catch (e) {
    // opts is caller-controlled and may be actively hostile (a throwing
    // `url` getter, a poisoned toString, ...), so the failure path must not
    // re-read it naively — safeGet/safeStr cannot throw.
    var badUrl = safeStr(safeGet(opts, "url", ""), "");
    var ctxCode = safeGet(safeGet(e, "eshttp", null), "code", null);
    if (typeof ctxCode === "string" && ctxCode.length) {
      return errorResult(mkError(ctxCode, errMessage(e)), _currentTransport, badUrl, 0, startMs);
    }
    // An unexpected throw from validation (hostile getter/toString on opts,
    // or an internal bug). The never-throws guarantee is a HARD contract
    // (api-spec §2/§3): degrade to an `internal` Result and keep the message
    // for diagnosis rather than propagating.
    return errorResult(
      mkError("internal", "request setup failed: " + errMessage(e)),
      _currentTransport, badUrl, 0, startMs
    );
  }

  var transport = resolveTransport();

  // Fail-safe: no transport at all -> error result, never throw.
  if (transport === "none") {
    return errorResult(
      mkError("unsupported", "no HTTP transport available (eshttp.dll and Socket both unavailable)"),
      "none", ctx.url, 0, startMs
    );
  }

  var raw: Result | null = null;
  if (transport === "native") {
    var nres = nativeRequest(ctx);
    if (nres.dllDead) {
      // DLL broken/incompatible -> mark dead, degrade. T9: try the cli tier
      // FIRST (eshttp-cli.exe is a separate process — firewall-escape and
      // https-capable), then socket (cleartext only) when cli is unavailable.
      if (cliAvailable()) {
        raw = cliRequest(ctx, startMs);
        transport = "cli";
      } else if (ctx.https) {
        return errorResult(
          mkError("unsupported", "eshttp.dll is incompatible and the cli transport is unavailable; https cannot fall back to the cleartext Socket driver"),
          "none", ctx.url, 0, startMs
        );
      } else if (socketAvailable()) {
        raw = socketRequest(ctx, startMs);
        transport = "socket";
      } else {
        return errorResult(nres.error, "none", ctx.url, 0, startMs);
      }
    } else if (nres.error) {
      // Normal transport error from the DLL (timeout, dns, ...).
      var meta = nres.envelope && nres.envelope.meta ? nres.envelope.meta : {};
      return {
        ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
        error: nres.error,
        meta: {
          path: "native", url: meta.finalUrl || ctx.url,
          redirects: typeof meta.redirects === "number" ? meta.redirects : 0,
          timeMs: typeof meta.timeMs === "number" ? meta.timeMs : (now() - startMs),
          bytes: 0, timeoutEnforced: true,
          tlsVersion: meta.tlsVersion !== undefined ? meta.tlsVersion : null,
          httpVersion: meta.httpVersion !== undefined ? meta.httpVersion : null,
          abi: _ABI,
          nativeVersion: meta.nativeVersion || null,
          encodingWasApplied: (typeof meta.encodingWasApplied === "boolean") ? meta.encodingWasApplied : null,
          backend: meta.backend !== undefined && meta.backend !== null ? String(meta.backend) : null
        }
      };
    } else {
      raw = nativeEnvelopeToResult(nres.envelope, ctx, startMs);
    }
  } else if (transport === "cli") {
    // cli transport (eshttp-cli.exe job-file IPC). Redirects are handled by
    // the engine (same eshttp.c as the DLL, opts.redirect honored in-process),
    // so this mirrors the native branch's single-shot shape — no JS redirector.
    var cres = cliRequest(ctx, startMs);
    if (cres.error) {
      // transport error from the cli engine (timeout, dns, ...) — Result is
      // already fully shaped with meta.path='cli'; return as-is.
      return cres;
    }
    raw = cres;
  } else {
    // socket path with JS redirector
    var hops = 0;
    for (;;) {
      raw = socketRequest(ctx, startMs);
      if (raw.error || raw.status < 300 || raw.status >= 400) { break; }
      if (ctx.redirect !== "follow") { break; } // manual: return 3xx as-is
      var location = raw.headers["location"];
      if (!location) { break; }
      if (hops >= ctx.maxRedirects) {
        raw = socketErrorResult(
          mkError("too-many-redirects", "exceeded maxRedirects (" + ctx.maxRedirects + ")"),
          ctx, startMs
        );
        break;
      }
      hops++;
      var next = redirectResult(raw, ctx, location);
      ctx.url = next.url;
      ctx.method = next.method;
      ctx.headers = next.headers;
      ctx.body = next.body;
      ctx.bodyIsBase64 = next.bodyIsBase64;
      var p = parseUrl(ctx.url);
      if (p.valid) {
        ctx.host = p.host;
        ctx.port = p.port;
        ctx.https = p.https;
        ctx.requestTarget = p.path + (p.query ? "?" + p.query : "");
      }
      // G1 (P1 security): Authorization is dropped on cross-host redirect
      // (contract §8). Compare the ORIGINAL request URL (ctx.parsed) against
      // the redirect target: ctx.url was already reassigned to next.url
      // above, so parsing ctx.url here would compare the new URL to itself
      // and the guard would never fire. Also drop when the caller supplied
      // only an explicit Authorization header (no username) — the header
      // filter must run in that case too (C1).
      var hasAuth = false;
      var ai: number;
      for (ai = 0; ai < ctx.headers.length; ai++) {
        if (toLower(ctx.headers[ai][0]) === "authorization") { hasAuth = true; break; }
      }
      if (ctx.parsed &&
          !sameHost(urlString(ctx.parsed), next.url) &&
          (ctx.username || ctx.password || hasAuth)) {
        ctx.username = null;
        ctx.password = null;
        var authFiltered: any[] = [];
        var i: number;
        for (i = 0; i < ctx.headers.length; i++) {
          if (toLower(ctx.headers[i][0]) === "authorization") { continue; }
          authFiltered.push(ctx.headers[i]);
        }
        ctx.headers = authFiltered;
      }
    }
    if (raw.meta) { raw.meta.redirects = hops; }
  }

  // G2: opts.json === true — parse result.body into result.data on 2xx
  // (both paths converge here; identical behavior, api-spec §11).
  return applyJsonOpt(raw, ctx);
}

function errorResult(error: any, path: string, url: string, redirects: number, startMs: number): Result {
  return {
    ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
    error: error,
    meta: {
      path: path || _currentTransport || "none",
      url: url || "",
      redirects: redirects || 0,
      timeMs: now() - startMs,
      bytes: 0,
      timeoutEnforced: false,
      tlsVersion: null,
      httpVersion: null,
      abi: (path === "native") ? _ABI : null,
      nativeVersion: null,
      encodingWasApplied: null, backend: null
    }
  };
}

/* ------------------------------------------------------------------ *
 * opts.json convenience (api-spec §11): on a 2xx response, parse
 * result.body -> result.data; on parse failure result.data = null and
 * result.error = { code:"invalid-json", category:"protocol",
 * retryable:false }, result.status KEPT. Identical on native + socket
 * paths — applied to the final result (after redirects) in request().
 * ------------------------------------------------------------------ */
function applyJsonOpt(result: any, ctx: any): any {
  if (!ctx.json) { return result; }
  if (result.error) { return result; } // no response -> nothing to parse
  if (result.status < 200 || result.status >= 300) { return result; }
  var parsed: any = null;
  var failed = false;
  try {
    parsed = jsonParseStrict(String(result.body));
  } catch (e) {
    failed = true; // strict parse throws only on invalid JSON
  }
  if (failed) {
    result.data = null;
    result.error = mkError("invalid-json", "response claimed JSON but body is not parseable (HTTP " + result.status + ")");
    return result; // status kept (api-spec §11)
  }
  result.data = parsed;
  return result;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */
eshttp.request = function (opts: Options): Result {
  return request(opts);
};

function extend(base: any, extra: any): any {
  var o: any = {};
  var k: string;
  for (k in base) { if (has(base, k)) { o[k] = base[k]; } }
  if (extra) {
    var k2: string;
    for (k2 in extra) {
      // Hostile-opts guard (never-throw contract §2/§3): reading a property
      // may invoke a user getter that throws. The convenience wrappers
      // (get/post/put/del) run extend BEFORE request's try/catch, so an
      // unguarded read here would propagate the throw out of the public API.
      // Skip the key — unknown keys are ignored per §2, and the base
      // (positional url/method/body) survives.
      if (!has(extra, k2)) { continue; }
      try {
        o[k2] = extra[k2];
      } catch (e) {
        // hostile getter: treat the key as absent, never throw.
      }
    }
  }
  return o;
}

eshttp.get = function (url: any, opts: any): Result {
  var o = opts || {};
  o = extend({ url: url, method: "GET" }, o);
  return request(o);
};

eshttp.post = function (url: any, body: any, opts: any): Result {
  var o = opts || {};
  o = extend({ url: url, method: "POST", body: body }, o);
  return request(o);
};

eshttp.put = function (url: any, body: any, opts: any): Result {
  var o = opts || {};
  o = extend({ url: url, method: "PUT", body: body }, o);
  return request(o);
};

eshttp.del = function (url: any, opts: any): Result {
  var o = opts || {};
  o = extend({ url: url, method: "DELETE" }, o);
  return request(o);
};

// eshttp.json — callable parse + .parse/.stringify (contract §5)
function jsonCallable(s: any): any {
  return jsonParse(s);
}
jsonCallable.parse = jsonParse;
jsonCallable.stringify = jsonStringify;
eshttp.json = jsonCallable;

// configure(opts): shallow-merge into defaults; returns previous defaults.
eshttp.configure = function (opts: any): any {
  var prev: any = {};
  var k: string;
  for (k in _defaults) {
    if (has(_defaults, k)) { prev[k] = _defaults[k]; }
  }
  if (isObj(opts)) {
    var k2: string;
    for (k2 in opts) {
      if (has(opts, k2) && has(_defaults, k2)) {
        _defaults[k2] = opts[k2];
      }
    }
  }
  return prev;
};

// forceTransport("auto"|"native"|"cli"|"socket") -> now-active transport name.
eshttp.forceTransport = function (name: string): string {
  if (name === "native" || name === "cli" || name === "socket" || name === "auto") {
    setForcedTransport(name);
  }
  return resolveTransport();
};

// Drop cached transport selector + cached ExternalObject; next call
// re-probes. Fully clears the native cache on EVERY possible session global
// ($.global, `global`/globalThis) so a session-dead DLL never survives the
// reset (T19 cross-suite fix: dead must persist within a suite but be
// cleared by resetTransport — the ESM core's sessionGlobal() may resolve to
// one global while the cache was persisted on another).
eshttp.resetTransport = function (): string {
  setForcedTransport(null);
  setNativeCache(null);
  resetCliState();
  var g = sessionGlobal();
  if (g) {
    try { delete g[_nativeCacheKey]; } catch (e) {
      try { g[_nativeCacheKey] = undefined; } catch (e2) {}
    }
  }
  // Belt-and-braces: clear the cache from the OTHER session-global candidate
  // too (Node `global` vs ExtendScript `$.global`), since sessionGlobal()
  // resolves one but a prior suite may have persisted on the other.
  try {
    if (typeof global !== "undefined" && global && g !== global) {
      try { delete global[_nativeCacheKey]; } catch (e5) {
        try { global[_nativeCacheKey] = undefined; } catch (e6) {}
      }
    }
  } catch (e7) {}
  try {
    if (typeof $ !== "undefined" && $.global && g !== $.global) {
      try { delete $.global[_nativeCacheKey]; } catch (e8) {
        try { $.global[_nativeCacheKey] = undefined; } catch (e9) {}
      }
    }
  } catch (e10) {}
  setDetectedTransport(null);
  return resolveTransport();
};

// Diagnostics (contract §9) — the 7-key surface is FROZEN (api-spec §9);
// the cli tier only changes the `transport` VALUE ("native"|"cli"|"socket"|
// "none"), never the key set.
eshttp.transportInfo = function (): any {
  var t = resolveTransport();
  var cache = nativeCacheGet();
  return {
    host: hostName(),
    platform: platformName(),
    transport: t,
    externalObjectAvailable: (typeof ExternalObject !== "undefined"),
    socketAvailable: socketAvailable(),
    nativeVersion: (t === "native") ? (cache.version || null) : null,
    abi: (t === "native" || t === "cli") ? _ABI : null
  };
};

function hostName(): string {
  try {
    if (typeof app !== "undefined" && app && app.name) { return String(app.name); }
  } catch (e) {}
  return null as any;
}
function platformName(): string {
  try {
    if (typeof $ !== "undefined" && $.os) {
      var os = String($.os);
      if (/windows/i.test(os)) { return "Windows"; }
      if (/mac/i.test(os)) { return "Macintosh"; }
      return os;
    }
  } catch (e) {}
  return null as any;
}

// eshttp.transport — always-current active transport name.
// (Refreshed on every request/resolve; also readable directly.)
try {
  Object.defineProperty(eshttp, "transport", {
    get: function () { return _currentTransport; },
    enumerable: true
  });
} catch (e) {
  eshttp.transport = _currentTransport;
}

// DEFAULTS — replacement-safe snapshot (fresh copy each access).
try {
  Object.defineProperty(eshttp, "DEFAULTS", {
    get: function () {
      var snap: any = {};
      var k: string;
      for (k in _defaults) {
        if (has(_defaults, k)) { snap[k] = _defaults[k]; }
      }
      return snap;
    },
    enumerable: true
  });
} catch (e) {
  var _snapFallback: any = {};
  var _k: string;
  for (_k in _defaults) { if (has(_defaults, _k)) { _snapFallback[_k] = _defaults[_k]; } }
  eshttp.DEFAULTS = _snapFallback;
}

// Test hook: plain mutable prop on the facade. Internal code reads it via
// state.noNetwork() (which reads this same prop through the facade ref).
eshttp.__noNetwork = false;
setFacade(eshttp);

eshttp.error = _errorConsts;

/* ------------------------------------------------------------------ *
 * Test hooks (qa / headless harness; not part of the public contract)
 * ------------------------------------------------------------------ */
eshttp.helpers = {
  jsonParse: jsonParse,
  jsonStringify: jsonStringify,
  base64Encode: base64Encode,
  base64Decode: base64Decode,
  utf8Encode: utf8Encode,
  utf8Decode: utf8Decode,
  utf8ByteLength: utf8ByteLength,
  parseUrl: parseUrl,
  urlString: urlString,
  buildQuery: buildQuery,
  encComponent: encComponent,
  normalizeRequestHeaders: normalizeRequestHeaders,
  parseResponseHeaders: parseResponseHeaders,
  parseHttpResponse: parseHttpResponse,
  dechunk: dechunk,
  resolveUrl: resolveUrl,
  mkError: mkError,
  sameHost: sameHost,
  applyJsonOpt: applyJsonOpt
};

// Pluggable drivers (default built-ins registered below).
eshttp._drivers = {
  "native": nativeRequest,
  "socket": socketRequest
};
eshttp._setDriver = function (name: string, fn: any): any {
  if (name === "native" || name === "socket") {
    eshttp._drivers[name] = fn;
  }
  return eshttp._drivers[name];
};

// Self-test for headless runs: pure helper round-trips + parse checks.
eshttp._selftest = function (): any {
  var tests: any[] = [];
  function check(name: string, cond: any) {
    tests.push({ name: name, ok: !!cond });
  }
  // JSON round-trips
  check("json.parse object", jsonParse('{"a":1,"b":"x\\u00e9"}').a === 1);
  check("json.parse unicode", jsonParse('{"b":"x\\u00e9"}').b === "x\u00e9");
  check("json.parse array", jsonParse('[1,2,3]').length === 3);
  check("json.parse null on invalid", jsonParse("not json") === null);
  check("json.parse non-string -> null", jsonParse(42) === null);
  check("json.stringify roundtrip", jsonParse(jsonStringify({ a: 1, b: [1, "x"] })).a === 1);
  check("json.stringify omits undefined", jsonStringify({ a: undefined, b: 1 }) === '{"b":1}');
  check("json.stringify null in array", jsonStringify([undefined]) === "[null]");
  check("json.stringify \\uXXXX non-ascii", jsonStringify({ s: "\u00e9" }).indexOf("\\u00e9") >= 0);
  // Circular guard: the offending branch serializes as null (documented
  // behavior — "null for the offending branch", no loop), so a self
  // reference yields {"self":null}, not a crash or infinite recursion.
  check("json.stringify circular branch -> null", jsonStringify(circularRef()) === '{"self":null}');
  // URL
  var u = parseUrl("https://user:pw@example.com:8443/a/b?x=1#frag");
  check("url parse scheme", u.scheme === "https");
  check("url parse host", u.host === "example.com");
  check("url parse port", u.port === 8443);
  check("url parse path", u.path === "/a/b");
  check("url parse query", u.query === "x=1");
  check("url parse userinfo", u.userinfo === "user:pw");
  check("url default port", parseUrl("http://example.com").port === 80);
  check("url bad scheme invalid", !parseUrl("ftp://x").valid);
  check("url relative location resolve", resolveUrl("https://a.com/x/y", "/z") === "https://a.com/z");
  check("url relative location 2", resolveUrl("https://a.com/x/y", "z") === "https://a.com/x/z");
  // Query
  check("query build array repeat", buildQuery({ page: 2, tags: ["a", "b"] }) === "page=2&tags=a&tags=b");
  check("query percent-encode", buildQuery({ q: "a b" }) === "q=a%20b");
  // Headers
  var hp = normalizeRequestHeaders({ "X-Token": "abc", "Multi": ["1", "2"] });
  check("headers pair count", hp.length === 3);
  var hh = parseResponseHeaders("Content-Type: text/plain\r\nX-N: 1\r\nX-N: 2\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2");
  check("response headers lowercased", has(hh.map, "content-type"));
  check("response headers repeated join", hh.map["x-n"] === "1, 2");
  check("response headers cookie join", hh.map["set-cookie"] === "a=1; b=2");
  // HTTP parse
  var resp = parseHttpResponse("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello", 100);
  check("http parse status", resp.status === 200);
  check("http parse body", resp.body === "hello");
  var chunked = parseHttpResponse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", 100);
  check("http parse chunked", chunked.body === "hello world");
  var head = parseHttpResponse("HTTP/1.1 204 No Content\r\n\r\n", 100);
  // 204 is 2xx -> ok:true per api-spec §3 (200 <= status < 300); body is
  // empty (no body on 204/304/HEAD).
  check("http parse 204 empty body, ok true", head.body === "" && head.ok === true);
  check("http parse 404 ok false", parseHttpResponse("HTTP/1.1 404 NF\r\n\r\nx", 100).ok === false);
  // Base64
  check("base64 roundtrip", base64Decode(base64Encode("hello")) === "hello");
  check("base64 binary null byte", base64Decode(base64Encode("a\u0000b")) === "a\u0000b");
  // UTF-8
  check("utf8 byte length ascii", utf8ByteLength("hello") === 5);
  check("utf8 byte length e-acute", utf8ByteLength("\u00e9") === 2);
  check("utf8 encode/decode roundtrip", utf8Decode(utf8Encode("\u00e9\u4e2d")) === "\u00e9\u4e2d");
  // Error taxonomy
  check("error consts", eshttp.error["invalid-args"] === "invalid-args" && eshttp.error.timeout === "timeout");
  // G1: same-host comparison helper (socket redirector auth drop)
  check("sameHost cross-host false", !sameHost("https://a.com/x", "https://b.com/x"));
  check("sameHost same-host true", sameHost("https://a.com:8443/x", "https://A.com:8443/y"));
  check("sameHost port differs false", !sameHost("https://a.com:8443/", "https://a.com:443/"));
  // G2: opts.json convenience (api-spec §11) via the shared helper
  var jr = applyJsonOpt({ ok: true, status: 200, body: '{"a":1}', error: null }, { json: true });
  check("json opt 2xx parses into data", jr.data !== null && jr.data.a === 1);
  var jrBad = applyJsonOpt({ ok: true, status: 200, body: "not json", error: null }, { json: true });
  check("json opt invalid -> invalid-json keeps status",
    jrBad.status === 200 && jrBad.data === null && jrBad.error !== null && jrBad.error.code === "invalid-json" &&
    jrBad.error.category === "protocol" && jrBad.error.retryable === false);
  var jrNull = applyJsonOpt({ ok: true, status: 200, body: "null", error: null }, { json: true });
  check("json opt literal null body ok", jrNull.data === null && jrNull.error === null);
  var jr4xx = applyJsonOpt({ ok: false, status: 404, body: "x", error: null }, { json: true });
  check("json opt non-2xx untouched", jr4xx.status === 404 && jr4xx.error === null && !has(jr4xx, "data"));
  var jrOff = applyJsonOpt({ ok: true, status: 200, body: "nope", error: null }, { json: false });
  check("json opt off untouched", jrOff.error === null && !has(jrOff, "data"));
  var jrErr = applyJsonOpt({ ok: false, status: 0, error: { code: "timeout" }, body: "" }, { json: true });
  check("json opt no-response untouched", jrErr.error !== null && !has(jrErr, "data"));

  var pass = true;
  var i: number;
  for (i = 0; i < tests.length; i++) {
    if (!tests[i].ok) { pass = false; }
  }
  return { pass: pass, tests: tests, transport: _currentTransport };
};

function circularRef(): any {
  var a: any = {};
  a.self = a;
  return a;
}

/* ------------------------------------------------------------------ *
 * Publish
 * ------------------------------------------------------------------ */
try {
  Object.defineProperty(sessionGlobal(), "eshttp", {
    value: eshttp,
    writable: true,
    configurable: true,
    enumerable: true
  });
} catch (e) {
  var g = sessionGlobal();
  if (g) { g.eshttp = eshttp; }
}

export default eshttp;

