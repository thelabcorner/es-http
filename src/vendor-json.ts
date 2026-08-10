// ESHTTP JSON adapter — ESON delegation (vendor-json.ts).
//
// Replaces the jsxinc's embedded ESON-parity JSON parser/serializer
// (src/eshttp.jsxinc L100–395) with a THIN ADAPTER over the sibling ESON
// library, per the coordinator's decision (decision v2, ratified):
//
//   - ESON_ACCEL_BUNDLE (injected by eshttp-build.mjs, the self-extracting
//     ESON bundle — DLL-accelerated when the host can load it, internal ES3
//     lane otherwise) is LAZY-EVAL'd on first codec use and the facade is
//     cached. Never re-eval'd per call. A bundle-eval failure can never throw
//     out of json.parse/stringify (degrade to never-throw null / "null").
//   - Eval mechanism: indirect eval `(0, eval)(src)` so the bundle's var
//     declarations land on the session/global object, where `sessionGlobal()`
//     finds them (`$.global` in ExtendScript, `global` in Node). The bundle's
//     own install footer also publishes $.global.ESON.
//
// Frozen-contract wrappers (coordinator-ratified, api-spec citations):
//
//   - D6 (api-spec §5): json.parse NEVER throws; invalid or non-string input
//     -> null. eson.parse THROWS SyntaxError on invalid — wrap in try/catch.
//   - D7 (api-spec §5): optional reviver with json2 walk semantics (passed
//     straight through to eson.parse, which implements the same walk); a
//     throwing reviver is swallowed to null by the never-throw contract.
//   - D1 (api-spec §5 "UTF-8 ABI boundary" + README): stringify output is
//     7-bit clean — every code unit > 0x7E is escaped \uXXXX (per UTF-16
//     unit, so a valid surrogate pair becomes \ud83d\ude00). ESON/json2 leave
//     ordinary non-ASCII raw; the 7-bit post-pass restores the documented
//     eshttp contract. 15-json-strictness.js:118-124 pins this hard.
//   - D2 (api-spec §5 "documented simplification"): cycles serialize the
//     offending branch as null (no throw). json2 throws on cycles — the
//     plainify pre-pass below resolves them to null before delegation.
//   - D3 (parity README / api-spec contract domain): eshttp must NOT invoke
//     value.toJSON() — Date/RegExp/boxed-with-toJSON serialize per their own
//     shape (Date -> {}). json2 calls toJSON BEFORE its replacer, so a
//     replacer alone cannot stop it; plainify clones the value with toJSON
//     dropped (function-valued props omitted) before eson.stringify sees it.
//   - D4: root undefined/function -> the JSON text "null" (never-throw,
//     always-a-string posture). eson/json2 return undefined there.
//   - D5: eshttp.json.stringify is 1-arg; replacer/space args are ignored
//     (the facade's stringify takes a single value).
//   - Depth cap (api-spec §5, ESON MAX_DEPTH parity): branches deeper than
//     512 serialize as null during plainify (never-throw-audit deepNest-5000
//     stays green; matches the old _jsonWrite stack-length guard).
//
// BYTE-IDENTITY contract (coordinator acceptance bar): for all non-hostile
// inputs, plainify + eson.stringify(plain) + 7-bit post-pass is byte-identical
// to the old _jsonWrite output. Getters are read exactly once (plainify reads
// each property once; json2 reads the plain clone). __proto__ own keys are
// written via Object.defineProperty to avoid prototype pollution.
//
// This module is Illustrator-agnostic (no Socket/ExternalObject references);
// it depends on state.ts only for sessionGlobal().
import { sessionGlobal } from './state';

/** ESON facade, cached after first successful eval. */
var _eson: any = null;
var _esonTried = false;

function esonFacade(): any {
  if (_esonTried) { return _eson; }
  _esonTried = true;
  if (typeof ESON_ACCEL_BUNDLE === "string" && ESON_ACCEL_BUNDLE.length > 0) {
    try {
      // Bridge $.global to the real global for the duration of the eval (the
      // ESM path stages $ with global null, or absent entirely; see
      // vendor-b64.ts for the full rationale — ESON also self-publishes
      // $.global.ESON/ESPAK).
      var dollar = (typeof $ !== "undefined") ? $ : null;
      var stagedDollar = false;
      var savedGlobal = dollar ? dollar.global : null;
      var publishTarget: any = savedGlobal;
      if (!publishTarget && typeof global !== "undefined") {
        publishTarget = global;
        if (dollar) {
          try { dollar.global = publishTarget; } catch (e1) {}
        } else {
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
      (0, eval)(ESON_ACCEL_BUNDLE);
      if (publishTarget && publishTarget.ESON) { _eson = publishTarget.ESON; }
      // Restore the staged $ (facade is cached, no re-read needed).
      if (stagedDollar && typeof global !== "undefined") {
        try { delete global.$; } catch (e2a) {
          try { global.$ = undefined; } catch (e2b) {}
        }
      } else if (dollar) {
        try { dollar.global = savedGlobal; } catch (e2) {}
      }
    } catch (e) {
      _eson = null;
    }
  }
  return _eson;
}

// ---- never-throw public parse face (D6) -----------------------------------

/**
 * Parse JSON text. NEVER throws: invalid input or non-string input -> null
 * (api-spec §5). Optional reviver runs with json2 walk semantics (D7); a
 * throwing reviver is swallowed to null.
 */
export function jsonParse(text: any, reviver?: any): any {
  if (typeof text !== "string") { return null; }
  var f = esonFacade();
  if (!f || typeof f.parse !== "function") { return null; }
  try {
    return f.parse(text, reviver);
  } catch (e) {
    return null;
  }
}

/**
 * STRICT internal parse — THROWS on invalid JSON (api-spec: the native
 * envelope path must distinguish "valid null" from "invalid JSON"; see
 * driver-native.ts). eson.parse throwing IS this variant (direct mapping).
 */
export function jsonParseStrict(text: any): any {
  var f = esonFacade();
  if (!f || typeof f.parse !== "function") {
    throw new Error("ESON facade unavailable");
  }
  return f.parse(String(text));
}

// ---- plainify: toJSON-free, cycle-safe, depth-capped clone (D2/D3/D4) -----

var _JSON_MAX_DEPTH = 512; // ESON MAX_DEPTH parity

function _hex4(n: number): string {
  var h = "000" + n.toString(16);
  return h.substring(h.length - 4);
}

/**
 * Clone `value` into a JSON-safe plain structure (no toJSON, no getters, no
 * cycles, no functions/undefined in objects, depth capped at 512):
 *
 *   - null/undefined -> null (D4: root undefined/function -> "null")
 *   - number -> value, or null when !isFinite (NaN/Infinity -> null)
 *   - boolean/string -> as-is
 *   - function -> null
 *   - array -> clone of each element (undefined element -> null)
 *   - plain object -> clone of own enumerable props; undefined/function
 *     values are OMITTED (api-spec §5); function-valued `toJSON` is thereby
 *     dropped, so the clone carries no toJSON hook anywhere (D3)
 *   - host/foreign object (Date, RegExp, ...) -> {} (own-enumerable for-in
 *     yields nothing for these — Date -> {}, matching the old _jsonWrite)
 *   - ancestor revisit (cycle) -> null for the offending branch (D2)
 *   - stack.length >= 512 -> null for the offending branch (depth cap)
 *
 * Getters are read exactly once (each property read once here; json2 then
 * serializes the plain clone). `__proto__` own keys are installed with
 * Object.defineProperty to avoid setting the clone's prototype (the old
 * _jsonWrite never built intermediate objects, so it had no such hazard).
 */
function plainify(value: any, stack: any[]): any {
  if (value === null || value === undefined) { return null; }
  var t = typeof value;
  if (t === "number") {
    if (!isFinite(value)) { return null; }
    return value;
  }
  if (t === "boolean") { return value; }
  if (t === "string") { return value; }
  if (t === "function") { return null; }
  if (t === "object") {
    if (stack.length >= _JSON_MAX_DEPTH) { return null; }
    var s: number;
    for (s = 0; s < stack.length; s++) {
      if (stack[s] === value) { return null; }   // cycle -> null branch
    }
    var isArr = Object.prototype.toString.call(value) === "[object Array]";
    if (isArr) {
      stack.push(value);
      var a: any[] = [];
      var n = value.length;
      var i: number;
      for (i = 0; i < n; i++) {
        a[i] = plainify(value[i], stack);        // undefined element -> null
      }
      stack.pop();
      return a;
    }
    if (value !== null && typeof value === "object") {
      stack.push(value);
      var o: any = {};
      var k: string;
      for (k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) { continue; }
        var v = value[k];
        if (typeof v === "undefined" || typeof v === "function") {
          continue;                              // omitted in objects
        }
        if (k === "__proto__") {
          try {
            Object.defineProperty(o, k, {
              value: plainify(v, stack),
              writable: true,
              enumerable: true,
              configurable: true
            });
          } catch (e) {
            // best-effort: drop the key rather than pollute the prototype
          }
        } else {
          o[k] = plainify(v, stack);
        }
      }
      stack.pop();
      return o;
    }
    return {};   // host/foreign object we cannot introspect safely
  }
  return null;
}

// ---- 7-bit-clean post-pass (D1) -------------------------------------------

/**
 * Escape every code unit > 0x7E to \uXXXX (per UTF-16 unit, so a valid
 * surrogate pair becomes \ud83d\ude00 — identical to the old _jsonQuote).
 * Operates on the stringify OUTPUT only; chars ESON/json2 already escaped
 * (\b \f \n \r \t, \uXXXX for control + formatting ranges) are ASCII in the
 * output and pass through untouched, so byte-identity with _jsonWrite holds.
 */
function escapeNonAscii(s: string): string {
  var out: string[] = [];
  var i: number;
  for (i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code > 0x7E) {
      out.push("\\u" + _hex4(code));
    } else {
      out.push(s.charAt(i));
    }
  }
  return out.join("");
}

// ---- never-throw stringify face (D1/D2/D3/D4/D5) --------------------------

/**
 * Serialize a value to a JSON string. NEVER throws (any failure degrades to
 * the JSON text "null"). 7-bit clean, cycles -> null branches, toJSON never
 * invoked, depth capped at 512, root undefined/function -> "null", extra
 * args (replacer/space) ignored (api-spec §5; D1–D5).
 */
export function jsonStringify(value: any): string {
  try {
    var f = esonFacade();
    if (!f || typeof f.stringify !== "function") { return "null"; }
    var plain = plainify(value, []);
    var s = f.stringify(plain);
    if (s === null || s === undefined) { return "null"; }  // D4
    return escapeNonAscii(String(s));
  } catch (e) {
    return "null";
  }
}

export { _JSON_MAX_DEPTH };

// Internal alias used by wire paths (headersJson/optsJson/object bodies):
// jsxinc's `_jsonEncode` IS the never-throw stringify face.
export { jsonStringify as jsonEncode };
