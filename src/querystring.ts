// ESHTTP query-string building (ported from src/eshttp.jsxinc L989–1051;
// api-spec §6.1).
//
// Pure, Illustrator-agnostic. UTF-8 percent-encoding with a manual ES3-safe
// fallback for encodeURIComponent absence/failure (never throws).
import { isArr, isObj, has } from './utils';
import { utf8Encode } from './vendor-b64';

/**
 * Percent-encode one component (encodeURIComponent semantics, UTF-8).
 * A hostile toString that throws degrades to "" (never-throw contract).
 */
export function encComponent(v: any): string {
  try {
    return encodeURIComponent(String(v));
  } catch (e) {
    // Manual percent-encoding fallback (ES3-safe). The first String(v) may
    // itself have thrown (hostile toString) — the fallback must not re-invoke
    // it unguarded, or the throw escapes and breaks the never-throw contract.
    // Degrade to "" instead.
    var s: string;
    try { s = String(v); } catch (e2) { s = ""; }
    var out: string[] = [];
    var unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
    var i: number;
    for (i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (unreserved.indexOf(c) >= 0) {
        out.push(c);
      } else {
        var bytes = utf8Encode(c);
        var j: number;
        for (j = 0; j < bytes.length; j++) {
          var b = bytes.charCodeAt(j) & 0xFF;
          var h = b.toString(16);
          if (h.length < 2) { h = "0" + h; }
          out.push("%" + h.toUpperCase());
        }
      }
    }
    return out.join("");
  }
}

/**
 * Build a query string from a params object: scalar values become one k=v,
 * array values repeat the key (api-spec §6.1). Returns "" for empty/non-object.
 *   { page: 2, tags: ["a","b"] } -> "page=2&tags=a&tags=b"
 */
export function buildQuery(params: any): string {
  if (!isObj(params)) { return ""; }
  var parts: string[] = [];
  var k: string;
  for (k in params) {
    if (!has(params, k)) { continue; }
    var v = params[k];
    if (isArr(v)) {
      var i: number;
      for (i = 0; i < v.length; i++) {
        parts.push(encComponent(k) + "=" + encComponent(v[i]));
      }
    } else if (v !== null && v !== undefined) {
      parts.push(encComponent(k) + "=" + encComponent(v));
    }
  }
  return parts.join("&");
}

/**
 * Merge opts.query into a parsed URL: existing query preserved, keys appended
 * (duplicate keys allowed, in order — api-spec §6.1). Mutates u in place.
 */
export function mergeQuery(u: any, queryObj: any): void {
  if (!queryObj) { return; }
  var q = buildQuery(queryObj);
  if (!q) { return; }
  u.query = u.query ? (u.query + "&" + q) : q;
}
