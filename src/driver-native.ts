// ESHTTP native driver — eshttp.dll ExternalObject accelerator (ported from
// src/eshttp.jsxinc L1302–1494; native-abi-v2, contracts/native-abi-v2).
//
// Drives the DLL EXACTLY as the jsxinc did — envelope ABI http-v1, the same
// 5-arg call shape (method, url, headersJson, body, optsJson), the same 11
// optsJson keys, the same NULL-return / ABI-mismatch / throw degradation to
// socket. The ONLY changes are the T5 sponsor-mandated rename (lib:eshttp +
// eshttp_* symbols) and the T6 native-abi-v2 boundary:
//   - eshttp_free is GONE (v1 caller-frees was the double-free flaw). The
//     host frees kTypeString returns via ESFreeMem (= free) automatically.
//   - no-arg methods (eshttp_version / eshttp_available / eshttp_last_error)
//     are declared with _f signatures, so the wrapper MUST pass a dummy 0.
// The C source in native/ is out of scope — do not edit it.
//
// Host globals (ExternalObject, $) are typeof-guarded at CALL time only.
import { has, isObj, errStr, now } from './utils';
import { mkError, _ERRORS } from './errors';
import { jsonEncode, jsonParseStrict } from './vendor-json';
import { utf8Encode, utf8ByteLength, base64DecodeLenient } from './vendor-b64';
import { headersToJsonObject } from './headers';
import { RequestContext, Result, EshttpError, NativeCache } from './types';
import {
  _nativeCacheKey, _nativeCache, setNativeCache, _ABI, sessionGlobal, noNetwork
} from './state';

/**
 * Resolve the session-cached native driver state (survives script runs inside
 * #targetengine "session" via the session global). Creates the cache record
 * on first use and persists it on the session global.
 */
export function nativeCacheGet(): NativeCache {
  var g = sessionGlobal();
  var cur = _nativeCache;
  if (!cur) {
    if (g && has(g, _nativeCacheKey)) {
      cur = g[_nativeCacheKey];
    } else {
      cur = { accel: null, version: null, available: false, dead: false };
      if (g) { g[_nativeCacheKey] = cur; }
    }
    setNativeCache(cur);
  }
  return cur as NativeCache;
}

/**
 * Probe + verify eshttp.dll. Returns the cache record. A missing/broken DLL
 * NEVER throws and is NOT marked dead (dead=false keeps re-probe allowed,
 * e.g. after install); only envelope ABI mismatches and throwing calls mark
 * it dead (incompatible).
 */
export function probeNative(): NativeCache {
  var cache = nativeCacheGet();
  if (cache.accel) { return cache; }
  if (cache.dead) { return cache; }
  if (noNetwork()) { return cache; }
  if (typeof ExternalObject === "undefined") { return cache; }
  try {
    // __cdecl is the ExtendScript default for ExternalObject.
    var accel = new ExternalObject("lib:eshttp");
    if (!accel) { return cache; }
    if (typeof accel.eshttp_version === "function") {
      // native-abi-v2: eshttp_version is declared _f (no-arg methods get a
      // dummy float per the ESInitialize signature contract + ESON
      // precedent) — pass dummy 0.
      var v = String(accel.eshttp_version(0));
      if (/^\d+\.\d+\.\d+$/.test(v)) {
        cache.accel = accel;
        cache.version = v;
        cache.available = true;
        // Optional health probe (recommended by native-abi §2).
        if (typeof accel.eshttp_available === "function") {
          try {
            cache.available = (accel.eshttp_available(0) === 1);
          } catch (e2) { cache.available = true; }
        }
      }
    }
  } catch (e) {
    // G4: DLL absent or failed to load/verify. Not "dead" (that would
    // permanently disable probing) — just unavailable this time: keep
    // dead=false so a later probe can retry (e.g. after install).
    cache.accel = null;
    cache.dead = false;
  }
  return cache;
}

/** Convert a native error envelope to our error object. */
function mapNativeError(envError: any): EshttpError {
  var code = envError && envError.code ? String(envError.code) : "internal";
  if (!has(_ERRORS, code)) { code = "internal"; }
  var err = mkError(code, envError && envError.message ? envError.message : code);
  if (envError && envError.category) { err.category = envError.category; }
  if (envError && typeof envError.retryable === "boolean") { err.retryable = envError.retryable; }
  return err;
}

/**
 * Core native call. Returns an envelope-shaped object:
 *   { envelope } on success (parsed + abi-verified),
 *   { dllDead: true, error } when the DLL is broken/incompatible,
 *   { error } for normal transport errors (timeout, dns, ...).
 */
export function nativeRequest(ctx: RequestContext): any {
  var cache = probeNative();
  if (!cache.accel || !cache.available || cache.dead) {
    return { error: mkError("internal", "eshttp native driver unavailable") };
  }
  var accel = cache.accel;

  var headersJson = jsonEncode(headersToJsonObject(ctx.headers));
  var opts = {
    timeoutMs: ctx.timeout,
    redirect: ctx.redirect,
    maxRedirects: ctx.maxRedirects,
    verifyTls: ctx.verifyTls,
    userAgent: ctx.userAgent,
    username: ctx.username,
    password: ctx.password,
    proxy: ctx.proxy,
    decompress: ctx.decompress,
    maxBodyBytes: ctx.maxBodyBytes,
    bodyIsBase64: ctx.bodyIsBase64 === true
  };
  var optsJson = jsonEncode(opts);

  var body = ctx.bodyIsBase64 ? ctx.body : utf8Encode(ctx.body || "");
  var envStr: any = null;
  try {
    envStr = String(accel.eshttp_request(ctx.method, ctx.url, headersJson, body, optsJson));
  } catch (e) {
    // ExternalObject call itself failed — DLL unusable.
    cache.dead = true;
    return {
      dllDead: true,
      error: mkError("internal", "eshttp_request threw: " + errStr(e))
    };
  }
  // native-abi-v2: NO explicit eshttp_free — the host frees the returned
  // kTypeString via ESFreeMem (= free). Calling a free export here would be
  // a double-free (v1's flaw); eshttp_free no longer exists in the export
  // set.
  if (envStr === "null" || envStr === "" || envStr === "undefined") {
    // eshttp_request returned NULL -> consult eshttp_last_error.
    var lastErr = "";
    if (typeof accel.eshttp_last_error === "function") {
      // native-abi-v2: eshttp_last_error is declared _f — pass dummy 0.
      try { lastErr = String(accel.eshttp_last_error(0)); } catch (e3) {}
    }
    cache.dead = true;
    return {
      dllDead: true,
      error: mkError("internal", "eshttp_request returned NULL" + (lastErr ? ": " + lastErr : ""))
    };
  }

  var parsed: any = null;
  try {
    parsed = jsonParseStrict(envStr);
  } catch (e4) {
    cache.dead = true;
    return {
      dllDead: true,
      error: mkError("internal", "eshttp envelope unparseable: " + errStr(e4))
    };
  }
  if (!isObj(parsed) || parsed.abi !== _ABI) {
    // Envelope ABI mismatch -> DLL incompatible -> mark dead, degrade.
    cache.dead = true;
    return {
      dllDead: true,
      error: mkError("internal", "eshttp envelope ABI mismatch (expected '" + _ABI + "')")
    };
  }
  if (parsed.error) {
    var mapped = mapNativeError(parsed.error);
    if (parsed.meta && parsed.meta.winhttpError !== undefined && parsed.meta.winhttpError !== null) {
      mapped.detail = mapped.detail || {};
      mapped.detail.winhttp = parsed.meta.winhttpError;
    }
    return { error: mapped, envelope: parsed };
  }
  return { envelope: parsed };
}

/**
 * Shared http-v1 envelope -> Result mapping (native-abi §4.1).
 *
 * Used by BOTH the native driver (eshttp.dll) and the cli driver
 * (eshttp-cli.exe) — the CLI writes the IDENTICAL envelope JSON, so the
 * mapping is byte-for-byte the same. `path` overrides meta.path ("native" /
 * "cli"); the envelope's own meta.path (emitted by the C engine as "native")
 * is ignored so each transport reports its true lane (api-spec §3).
 *
 * OBS-1 fields (encodingWasApplied/backend) are NATIVE-ONLY observability
 * (api-spec §3): forwarded on the native lane, NULL on every other lane
 * (cli/socket/no-envelope) — the cli engine's own meta is not contractually
 * exposed there.
 */
export function envelopeToResult(env: any, ctx: RequestContext, startMs: number, path: string): Result {
  var meta = env.meta || {};
  var status = typeof env.status === "number" ? env.status : 0;
  var headers = isObj(env.headers) ? env.headers : {};
  var bodyText = typeof env.body === "string" ? env.body : "";
  var body = bodyText;
  if (env.bodyEncoding === "base64") {
    // body = base64-decoded raw binary string; bodyText = base64 form.
    // Lenient lane: a malformed DLL envelope must degrade, not throw.
    body = base64DecodeLenient(bodyText);
  }
  var obs1 = (path === "native");
  // OBS-1 (additive): native lane forwards; other lanes null. Flattened to
  // helper vars — nested ternaries miscompile in the ES3 parser (skill §11,
  // live-verified 2026-08-10: "Expected: :" parse error on the wrapped chain).
  var ewa: any = null;
  if (obs1 && typeof meta.encodingWasApplied === "boolean") { ewa = meta.encodingWasApplied; }
  var bk: any = null;
  if (obs1 && meta.backend !== undefined && meta.backend !== null) { bk = String(meta.backend); }
  return {
    ok: (status >= 200 && status < 300),
    status: status,
    statusText: typeof env.statusText === "string" ? env.statusText : "",
    headers: headers,            // already lowercased by DLL/CLI
    body: body,
    bodyText: (env.bodyEncoding === "base64") ? bodyText : body,
    error: null,
    meta: {
      path: path,
      url: meta.finalUrl || ctx.url,
      redirects: typeof meta.redirects === "number" ? meta.redirects : 0,
      timeMs: (typeof meta.timeMs === "number" ? meta.timeMs : (now() - startMs)),
      bytes: typeof meta.bytes === "number" ? meta.bytes : utf8ByteLength(body),
      timeoutEnforced: true,
      tlsVersion: meta.tlsVersion !== undefined ? meta.tlsVersion : null,
      httpVersion: meta.httpVersion !== undefined ? meta.httpVersion : null,
      abi: _ABI,
      nativeVersion: meta.nativeVersion || null,
      encodingWasApplied: ewa,
      backend: bk
    }
  };
}

/** Envelope -> Result body mapping (native-abi §4.1) — native path. */
export function nativeEnvelopeToResult(env: any, ctx: RequestContext, startMs: number): Result {
  return envelopeToResult(env, ctx, startMs, "native");
}
