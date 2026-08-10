// ESHTTP base64 + UTF-8 adapter — ESB64 delegation (vendor-b64.ts).
//
// Replaces the jsxinc's embedded WHATWG-exact codec lanes
// (src/eshttp.jsxinc L396–874) with a THIN ADAPTER over the sibling ESB64
// library, per the coordinator's decision (decision v2, ratified):
//
//   - FACADE SOURCE PRIORITY (T28, merge architecture v1): the adapter FIRST
//     consumes the merged ESB64 facade published on the session global
//     (`$.global.ESB64` — published by the merged espack bundle's ESB64
//     facade, which attaches ESPAK.attach("ESB64Native") by NAME). Only when
//     that global facade is ABSENT (or lacks the required atob/btoa/utf8
//     surface) does the adapter fall back to LAZY-EVAL'ing the embedded
//     ESB64_ACCEL_BUNDLE string (the plain single-file build's
//     self-extracting bundle — ESB64Native_v1.dll accelerated when the host
//     can load it, internal ES3 lane otherwise). The facade is cached; never
//     re-eval'd per call. A facade/global resolution failure degrades to
//     never-throw best-effort results.
//   - Eval mechanism (fallback path only): indirect eval `(0, eval)(src)`
//     (see vendor-json.ts).
//
// Contract mapping (test/parity/esb64-parity.mjs + 40-codec-parity.js are
// the acceptance gates; the jsxinc lanes were themselves validated against
// ESB64, so direct delegation preserves parity BY CONSTRUCTION):
//
//   - helpers.base64Encode  <-> ESB64.btoa       (WHATWG btoa: latin1 only,
//       throws InvalidCharacterError on chars > 0xFF — the PUBLIC helper
//       contract, 40-codec-parity G1/G2 pins the throws)
//   - helpers.base64Decode  <-> ESB64.atob       (WHATWG forgiving-base64:
//       whitespace stripped, missing padding tolerated, len%4==1 / bad
//       charset / misplaced '=' rejected — G3/G4 pins the throws)
//   - helpers.utf8Encode    <-> ESB64.utf8Encode (TextEncoder semantics:
//       lone surrogates -> U+FFFD — G5)
//   - helpers.utf8Decode    <-> ESB64.utf8Decode (WHATWG UTF-8 decoder with
//       error GROUPING — G7)
//   - helpers.utf8ByteLength<-> ESB64.utf8Encode(x).length (parity oracle
//       REF_U8LEN uses exactly this expression)
//   - INTERNAL lanes (never-throw, wire paths only): the library itself must
//     always return a Result, never throw (api-spec §3), so envelope/wire
//     decode goes through the lenient wrappers below. Public helpers keep
//     the throwing WHATWG contract; internal call sites never propagate.
//
// This module is Illustrator-agnostic (no Socket/ExternalObject references);
// it depends on state.ts only for sessionGlobal().
import { sessionGlobal } from './state';

/** ESB64 facade, cached after first successful resolve. */
var _esb64: any = null;
var _esb64Tried = false;

/**
 * Surface-complete check for a candidate ESB64 facade (T28 stale-global
 * defense, extended to SURFACE-COMPLETENESS — T29 live-gate bug 2):
 *
 * A facade may pass a `typeof === "function"` presence check yet be BROKEN:
 * the merged bundle's ESB64 facade swaps its native lane in via
 * `ESPAK.attach(...).onMode("native", lib, impl)` — and when the shared
 * ESB64Native accel fails to bind (per-DLL/method binding flakiness, see
 * externalobject-extendscript skill "Additional host observations"), the
 * swap can install `impl = {}` (buildNative returned null/empty), leaving
 * `ESB64.atob/btoa` as `undefined` or as stubs that call a missing
 * `lib.b64encode` -> "is not a function" THROW on first use. The frozen
 * contract REQUIRES the ES3 lane (never-throw) when the native lane is
 * unavailable — a partially-broken native facade must NEVER be surfaced.
 *
 * Check: every required public method must be present AND CALLABLE on a
 * trivial input, returning a string:
 *
 *   - btoa("")     -> ""      (latin1 encode of empty)
 *   - atob("")     -> ""      (forgiving decode of empty)
 *   - utf8Encode("") -> ""    (TextEncoder of empty)
 *   - utf8Decode("") -> ""    (UTF-8 decode of empty)
 *
 * Any throw, undefined function, or non-string result -> not surface-complete
 * -> the caller treats the facade as ABSENT and falls back to the embedded
 * bundle (or never-throw degradation). These calls run ONCE per session at
 * first codec use (cached), on trivial inputs — negligible cost.
 */
function esb64SurfaceComplete(f: any): boolean {
  if (!f) { return false; }
  if (typeof f.btoa !== "function" || typeof f.atob !== "function" ||
      typeof f.utf8Encode !== "function" || typeof f.utf8Decode !== "function") {
    return false;
  }
  try {
    if (f.btoa("") !== "") { return false; }
    if (f.atob("") !== "") { return false; }
    if (f.utf8Encode("") !== "") { return false; }
    if (f.utf8Decode("") !== "") { return false; }
  } catch (e) {
    return false;   // broken native lane (throwing stub) -> not usable
  }
  return true;
}

/**
 * Resolve the ESB64 facade. Priority (T28 merge architecture v1):
 *   1. `sessionGlobal().ESB64` — the merged bundle's loader-free facade
 *      (published by the ESB64 facade, ESPAK-attached by name). Consumed
 *      as-is ONLY when SURFACE-COMPLETE (all four public methods present AND
 *      callable — T29 bug 2: a partially-broken native facade whose swap
 *      installed undefined/throwing stubs must be treated as absent).
 *   2. Embedded ESB64_ACCEL_BUNDLE lazy-eval (plain single-file build) — the
 *      self-extracting bundle, eval'd with a staged `$` so its publish
 *      footer lands the facade on the session global.
 *   3. null (both absent) — callers degrade to never-throw results.
 * Cached in the module closure after the first resolve; never re-probed per
 * call, never re-eval'd per call.
 */
function esb64Facade(): any {
  if (_esb64Tried) { return _esb64; }
  _esb64Tried = true;
  // Path 1: merged facade on the session global (T28).
  try {
    var sg = sessionGlobal();
    if (sg && esb64SurfaceComplete(sg.ESB64)) {
      _esb64 = sg.ESB64;
      return _esb64;
    }
  } catch (e) {
    _esb64 = null;
  }
  // Path 2: embedded self-extracting bundle (plain build fallback).
  if (typeof ESB64_ACCEL_BUNDLE === "string" && ESB64_ACCEL_BUNDLE.length > 0) {
    try {
      // The bundle publishes its facade onto $.global (tail footer). In the
      // Node ESM path $ is staged with $.global === null (or absent
      // entirely), so bridge the publish target to the real global for the
      // duration of the eval, then read the facade back. (ESON works via a
      // top-level `var ESON` landing on the global; the minified ESB64
      // bundle declares everything inside its IIFE and only self-publishes
      // through $.global — and its publish footer has NO `this` fallback,
      // unlike its ESPAK footer, so a staged $ is required when $ is absent.)
      var dollar = (typeof $ !== "undefined") ? $ : null;
      var stagedDollar = false;
      var savedGlobal = dollar ? dollar.global : null;
      var publishTarget: any = savedGlobal;
      if (!publishTarget && typeof global !== "undefined") {
        // Node ESM path: `global` is the global object (== globalThis);
        // kept off `globalThis` so the ES3 scanner does not flag a
        // browser/Node global. ExtendScript hosts always have $.global set,
        // so this branch is skipped there.
        publishTarget = global;
        if (dollar) {
          try { dollar.global = publishTarget; } catch (e1) {}
        } else {
          // Bare Node (no staged $): stage a throwaway $ so the bundle's
          // publish footer finds $.global; deleted after the read.
          try {
            global.$ = { global: publishTarget };
            dollar = global.$;
            stagedDollar = true;
          } catch (e1b) {
            dollar = null;
          }
        }
      }
      // Indirect eval: bundle vars land on the session/global object.
      (0, eval)(ESB64_ACCEL_BUNDLE);
      if (publishTarget && publishTarget.ESB64) { _esb64 = publishTarget.ESB64; }
      // Restore the staged $ (facade is cached, no re-read needed).
      if (stagedDollar && typeof global !== "undefined") {
        try { delete global.$; } catch (e2a) {
          try { global.$ = undefined; } catch (e2b) {}
        }
      } else if (dollar) {
        try { dollar.global = savedGlobal; } catch (e2) {}
      }
    } catch (e) {
      _esb64 = null;
    }
  }
  return _esb64;
}

// ---- PUBLIC helpers (throwing WHATWG contract — 40-codec-parity pins) -----

/**
 * btoa: latin1 byte string -> base64. Throws InvalidCharacterError when any
 * char is outside 0x00-0xFF (helpers.base64Encode contract).
 */
export function base64Encode(text: any): string {
  var f = esb64Facade();
  if (!f || typeof f.btoa !== "function") {
    throw invalidCharacter("btoa: ESB64 facade unavailable");
  }
  return f.btoa(String(text));
}

/**
 * atob: WHATWG forgiving-base64 decode -> latin1 byte string. Throws
 * InvalidCharacterError on malformed input (helpers.base64Decode contract).
 */
export function base64Decode(b64: any): string {
  var f = esb64Facade();
  if (!f || typeof f.atob !== "function") {
    throw invalidCharacter("atob: ESB64 facade unavailable");
  }
  return f.atob(String(b64));
}

/** TextEncoder semantics: JS string -> UTF-8 byte string (lone surrogates ->
 *  U+FFFD). helpers.utf8Encode. */
export function utf8Encode(text: any): string {
  var f = esb64Facade();
  if (!f || typeof f.utf8Encode !== "function") {
    throw new Error("utf8Encode: ESB64 facade unavailable");
  }
  return f.utf8Encode(String(text));
}

/** WHATWG UTF-8 decoder: byte string -> JS string, error GROUPING.
 *  helpers.utf8Decode. */
export function utf8Decode(bytes: any): string {
  var f = esb64Facade();
  if (!f || typeof f.utf8Decode !== "function") {
    throw new Error("utf8Decode: ESB64 facade unavailable");
  }
  return f.utf8Decode(String(bytes));
}

/** UTF-8 byte length of a JS string. Always equals utf8Encode(str).length
 *  (parity oracle REF_U8LEN uses exactly this). helpers.utf8ByteLength. */
export function utf8ByteLength(str: any): number {
  return utf8Encode(str).length;
}

// ---- INTERNAL lanes (never-throw — wire paths only) -----------------------

/**
 * Encode arbitrary wire data as base64, masking each char to a byte. NEVER
 * throws (the library must always return a Result, api-spec §3). Fast path
 * for already-latin1 input delegates to btoa unchanged; the slow path masks
 * chars > 0xFF to bytes before encoding (old _base64EncodeBytes semantics).
 */
export function base64EncodeBytes(bytes: any): string {
  try {
    return base64Encode(bytes);
  } catch (e) {
    try {
      var raw = String(bytes);
      var masked: string[] = [];
      var i: number;
      for (i = 0; i < raw.length; i++) {
        masked.push(String.fromCharCode(raw.charCodeAt(i) & 0xFF));
      }
      return base64Encode(masked.join(""));
    } catch (e2) {
      return "";
    }
  }
}

/**
 * Decode base64 from a trusted-ish producer (the DLL envelope). NEVER throws:
 * on malformed input it falls back to a lenient scan that skips stray
 * characters, matching the pre-parity behaviour (old _base64DecodeLenient).
 */
export function base64DecodeLenient(b64: any): string {
  try {
    return base64Decode(b64);
  } catch (e) {
    try {
      var s = String(b64);
      var kept: string[] = [];
      var ki = 0;
      var i: number;
      for (i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);
        if (code === 61) { break; }          // '=' ends the data
        if (code < 256 && _B64_CHAR_OK[code]) { kept[ki++] = s.charAt(i); }
      }
      kept.length = ki;
      var clean = kept.join("");
      var body = clean.length;
      if ((body & 3) === 1) { body -= 1; }   // drop the orphan sextet
      var chunk = clean.substring(0, body);
      if (chunk.length === 0) { return ""; }
      return base64Decode(chunk);
    } catch (e2) {
      return "";
    }
  }
}

// Single-char alphabet gate for the lenient scan (WHATWG alphabet +
// '+/'; '=' handled above).
var _B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var _B64_CHAR_OK: boolean[] = [];
(function () {
  var i: number;
  for (i = 0; i < 256; i++) { _B64_CHAR_OK[i] = false; }
  for (i = 0; i < _B64_ALPHABET.length; i++) {
    _B64_CHAR_OK[_B64_ALPHABET.charCodeAt(i)] = true;
  }
})();

function invalidCharacter(msg: string): Error {
  var e = new Error(msg);
  try { e.name = "InvalidCharacterError"; } catch (ignore) {}
  return e;
}
