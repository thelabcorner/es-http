// ESHTTP request-context building (ported from src/eshttp.jsxinc L1688–1930;
// api-spec §2). Validation happens here — pre-I/O. NEVER throws past the
// guards in index.ts's _request (hostile opts degrade to an internal Result).
import { isObj, isArr, toLower } from './utils';
import { parseUrl, urlString } from './url';
import { mergeQuery } from './querystring';
import { normalizeRequestHeaders } from './headers';
import { jsonEncode } from './vendor-json';
import { _defaults, defaultUserAgent } from './state';
import { RequestContext, Options, HeaderPair } from './types';

/** Error carrying { code } for the caller's catch to map to an error Result. */
function ctxError(code: string, message: string): any {
  var e: any = new Error(message);
  e.eshttp = { code: code };
  return e;
}

/**
 * Build the internal RequestContext from public opts. All validation happens
 * here (pre-I/O). Throws ctxError (with .eshttp.code) on invalid opts;
 * index.ts catches and converts to an error Result (never throws outward).
 */
export function buildContext(opts: Options): RequestContext {
  var ctx: RequestContext = {
    method: "GET",
    url: "",
    parsed: null,
    host: "",
    port: 80,
    https: false,
    requestTarget: "/",
    headers: [],           // [name, value] pairs (wire order, no Host/CL)
    body: "",
    bodyIsBase64: false,
    bodyIsEmpty: true,
    timeout: _defaults.timeout,
    redirect: _defaults.redirect,
    maxRedirects: _defaults.maxRedirects,
    verifyTls: _defaults.verifyTls,
    userAgent: defaultUserAgent(),
    username: null,
    password: null,
    proxy: null,
    decompress: _defaults.decompress,
    maxBodyBytes: _defaults.maxBodyBytes,
    json: false
  };

  // G3: non-object opts (request(null) / request() / request(42)) must never
  // throw — the never-throws guarantee is a hard API contract (api-spec
  // §2/§3). Normalize null/undefined to {} (then fail below on the missing
  // url with an invalid-args Result); reject any other non-object with an
  // invalid-args Result (status 0).
  if (opts === undefined || opts === null) {
    opts = {};
  } else if (!isObj(opts)) {
    throw ctxError("invalid-args", "opts must be an object");
  }

  // method
  if (opts.method !== undefined && opts.method !== null) {
    if (typeof opts.method !== "string") {
      throw ctxError("invalid-args", "method must be a string");
    }
    ctx.method = opts.method.toUpperCase();
  }
  // method — valid HTTP token per api-spec §2 (RFC 7230 tchar:
  // letters/digits/!#$%&'*+-.^_`|~); after case normalization. The backtick
  // in the tchar class is written as \x60 so the built artifact carries no
  // literal backtick (the 50-artifact-contract token audit flags any ` as a
  // template literal; \x60 matches the identical character).
  if (!/^[A-Z0-9!#$%&'*+.^_\x60|~-]+$/.test(ctx.method)) {
    throw ctxError("invalid-args", "invalid method: " + ctx.method);
  }

  // url — required, string, absolute http(s)
  if (opts.url === undefined || opts.url === null || typeof opts.url !== "string") {
    throw ctxError("invalid-args", "url is required and must be a string");
  }
  var parsed = parseUrl(opts.url);
  if (!parsed.valid) {
    throw ctxError("bad-url", "unparseable or unsupported URL: " + opts.url);
  }
  ctx.parsed = parsed;
  ctx.host = parsed.host;
  ctx.port = parsed.port;
  ctx.https = parsed.https;
  ctx.url = urlString(parsed);

  // query merge
  if (opts.query !== undefined && opts.query !== null) {
    if (!isObj(opts.query)) {
      throw ctxError("invalid-args", "query must be an object");
    }
    mergeQuery(parsed, opts.query);
    ctx.url = urlString(parsed);
  }

  // headers
  try {
    ctx.headers = normalizeRequestHeaders(opts.headers);
  } catch (e) {
    var he: any = e;
    if (he && he.eshttp) {
      throw ctxError(he.eshttp.code, he.message);
    }
    throw e;
  }

  // body
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === "string") {
      ctx.body = opts.body;
      ctx.bodyIsEmpty = (ctx.body.length === 0);
    } else if (isObj(opts.body) || isArr(opts.body)) {
      // object -> JSON.stringify + Content-Type: application/json unless the
      // caller already set one.
      ctx.body = jsonEncode(opts.body);
      ctx.bodyIsEmpty = false;
      var hasCT = false;
      var h: number;
      for (h = 0; h < ctx.headers.length; h++) {
        if (toLower(ctx.headers[h][0]) === "content-type") { hasCT = true; break; }
      }
      if (!hasCT) {
        ctx.headers.push(["Content-Type", "application/json"]);
      }
    } else {
      throw ctxError("invalid-args", "body must be a string, object, or array");
    }
  }

  // timeout
  if (opts.timeout !== undefined && opts.timeout !== null) {
    if (typeof opts.timeout !== "number" || isNaN(opts.timeout) || opts.timeout < 0) {
      throw ctxError("invalid-args", "timeout must be a non-negative number (ms)");
    }
    ctx.timeout = opts.timeout;
  }
  // redirect
  if (opts.redirect !== undefined && opts.redirect !== null) {
    if (opts.redirect !== "follow" && opts.redirect !== "manual") {
      throw ctxError("invalid-args", "redirect must be 'follow' or 'manual'");
    }
    ctx.redirect = opts.redirect;
  }
  // maxRedirects
  if (opts.maxRedirects !== undefined && opts.maxRedirects !== null) {
    if (typeof opts.maxRedirects !== "number" || isNaN(opts.maxRedirects) || opts.maxRedirects < 0) {
      throw ctxError("invalid-args", "maxRedirects must be a non-negative integer");
    }
    ctx.maxRedirects = opts.maxRedirects;
  }
  // verifyTls (native only)
  if (opts.verifyTls !== undefined && opts.verifyTls !== null) {
    if (typeof opts.verifyTls !== "boolean") {
      throw ctxError("invalid-args", "verifyTls must be a boolean");
    }
    ctx.verifyTls = opts.verifyTls;
  }
  // username / password
  if (opts.username !== undefined && opts.username !== null) {
    if (typeof opts.username !== "string") { throw ctxError("invalid-args", "username must be a string"); }
    ctx.username = opts.username;
  }
  if (opts.password !== undefined && opts.password !== null) {
    if (typeof opts.password !== "string") { throw ctxError("invalid-args", "password must be a string"); }
    ctx.password = opts.password;
  }
  // userAgent
  if (opts.userAgent !== undefined && opts.userAgent !== null) {
    if (typeof opts.userAgent !== "string") { throw ctxError("invalid-args", "userAgent must be a string"); }
    // header-injection guard: the UA is emitted as a raw header value on the
    // socket path ("User-Agent: <ua>") and forwarded verbatim in optsJson to
    // the DLL, which applies the same rejection. CR/LF would let a caller
    // smuggle arbitrary headers (t3-qa).
    if (/[\r\n]/.test(opts.userAgent)) { throw ctxError("invalid-args", "userAgent must not contain CR/LF"); }
    ctx.userAgent = opts.userAgent;
  }
  // G5: User-Agent precedence — resolved HERE, before any ABI call, so the
  // DLL never sees a duplicate (native-abi §3.1/§3.3; docs rule):
  //   1. Explicit User-Agent header in opts.headers wins (any case).
  //   2. Otherwise opts.userAgent (default "eshttp/1.0.0") is sent.
  //   3. opts.userAgent === "" (and no header) suppresses the header.
  // After this, ctx.userAgent is either the non-empty string to send, or
  // null (UA header already in ctx.headers, or UA suppressed).
  var uaHeaderFound = false;
  var uh: number;
  for (uh = 0; uh < ctx.headers.length; uh++) {
    if (toLower(ctx.headers[uh][0]) === "user-agent") { uaHeaderFound = true; break; }
  }
  if (uaHeaderFound) {
    ctx.userAgent = null; // explicit header wins; do not add default
  } else if (ctx.userAgent === "") {
    ctx.userAgent = null; // explicit empty -> suppress User-Agent
  }
  // proxy (native only)
  if (opts.proxy !== undefined && opts.proxy !== null) {
    if (typeof opts.proxy !== "string") { throw ctxError("invalid-args", "proxy must be a string"); }
    ctx.proxy = opts.proxy;
  }
  // decompress (native only)
  if (opts.decompress !== undefined && opts.decompress !== null) {
    if (typeof opts.decompress !== "boolean") { throw ctxError("invalid-args", "decompress must be a boolean"); }
    ctx.decompress = opts.decompress;
  }
  // maxBodyBytes
  if (opts.maxBodyBytes !== undefined && opts.maxBodyBytes !== null) {
    if (typeof opts.maxBodyBytes !== "number" || isNaN(opts.maxBodyBytes) || opts.maxBodyBytes < 0) {
      throw ctxError("invalid-args", "maxBodyBytes must be a non-negative number");
    }
    ctx.maxBodyBytes = opts.maxBodyBytes;
  }
  // bodyIsBase64
  if (opts.bodyIsBase64 !== undefined && opts.bodyIsBase64 !== null) {
    if (typeof opts.bodyIsBase64 !== "boolean") { throw ctxError("invalid-args", "bodyIsBase64 must be a boolean"); }
    ctx.bodyIsBase64 = opts.bodyIsBase64;
  }
  // json convenience
  if (opts.json !== undefined && opts.json !== null) {
    if (typeof opts.json !== "boolean") { throw ctxError("invalid-args", "json must be a boolean"); }
    ctx.json = opts.json;
  }

  // request target = path + "?" + query
  ctx.requestTarget = parsed.path;
  if (parsed.query) { ctx.requestTarget += "?" + parsed.query; }

  return ctx;
}

/**
 * Read a property that may be a THROWING getter (or live on a poisoned
 * prototype). Callers in the failure path must never be re-poisoned by the
 * very object that already failed, so this swallows and yields fallback.
 */
export function safeGet(obj: any, key: any, fallback: any): any {
  if (obj === null || obj === undefined) { return fallback; }
  try {
    var v = obj[key];
    return (v === undefined) ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** String() on a hostile object can throw via toString/valueOf. Never does. */
export function safeStr(v: any, fallback: any): string {
  try {
    return String(v);
  } catch (e) {
    return fallback === undefined ? "" : fallback;
  }
}

/** Best-effort message from an arbitrary thrown value (may itself be hostile:
 *  a throwing .message getter, a non-Error, null, ...). */
export function errMessage(e: any): string {
  if (e === null || e === undefined) { return "unknown error"; }
  var m = safeGet(e, "message", null);
  if (typeof m === "string" && m.length) { return m; }
  return safeStr(e, "unknown error");
}
