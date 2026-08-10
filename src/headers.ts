// ESHTTP header normalization (ported from src/eshttp.jsxinc L1051–1146;
// api-spec §6.2).
//
// Pure, Illustrator-agnostic. Request headers: { Name: string|array } ->
// ordered pair list, original key case preserved on the wire, CR/LF in a
// name/value rejected ("invalid-header" — never sanitize). Response headers:
// lowercased keys, repeated joined ", " (Cookie-family "; ").
import { isArr, isObj, has, trim, toLower } from './utils';
import { HeaderPair } from './types';

/**
 * Validate + normalize a request headers object into an ordered
 * [name, value] pair list. Throws an Error carrying `e.eshttp =
 * { code: "invalid-header", category: "usage" }` on CR/LF or ':' in a name,
 * or on a non-object headers argument.
 */
export function normalizeRequestHeaders(headers: any): HeaderPair[] {
  var pairs: HeaderPair[] = [];
  if (headers === null || headers === undefined) { return pairs; }
  if (!isObj(headers)) {
    var e: any = new Error("headers must be an object");
    e.eshttp = { code: "invalid-header", category: "usage" };
    throw e;
  }
  var name: string;
  for (name in headers) {
    if (!has(headers, name)) { continue; }
    if (name === "") { continue; }
    var v = headers[name];
    if (isArr(v)) {
      var i: number;
      for (i = 0; i < v.length; i++) {
        pairs.push([name, String(v[i])]);
      }
    } else {
      pairs.push([name, String(v === null || v === undefined ? "" : v)]);
    }
  }
  // CR/LF guard on every name/value (never sanitize — reject).
  var p: number;
  for (p = 0; p < pairs.length; p++) {
    var nm = pairs[p][0];
    var vl = pairs[p][1];
    if (/[\r\n]/.test(nm) || /[\r\n]/.test(vl) || nm.indexOf(":") >= 0) {
      var e2: any = new Error("invalid header (CR/LF or ':' in name)");
      e2.eshttp = { code: "invalid-header", category: "usage" };
      throw e2;
    }
  }
  return pairs;
}

/** Parsed response header block: { map (lowercased keys), list (wire order) }. */
export interface ResponseHeaders {
  map: { [name: string]: string };
  list: HeaderPair[];
}

/**
 * Parse a raw response header block -> { map, list }. Repeated headers join
 * with ", " (Cookie / Set-Cookie with "; " — api-spec §3/§6.2).
 */
export function parseResponseHeaders(headText: any): ResponseHeaders {
  var map: { [name: string]: string } = {};
  var list: HeaderPair[] = [];
  var lines = String(headText).split(/\r?\n/);
  var i: number;
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) { continue; }
    var colon = line.indexOf(":");
    if (colon <= 0) { continue; }
    var name = trim(line.substring(0, colon));
    var value = trim(line.substring(colon + 1));
    if (!name) { continue; }
    var lower = toLower(name);
    if (has(map, lower)) {
      map[lower] += (lower === "cookie" || lower === "set-cookie" ? "; " : ", ") + value;
    } else {
      map[lower] = value;
    }
    list.push([name, value]);
  }
  return { map: map, list: list };
}

/** Serialize request header pairs for the wire (socket path). */
export function serializeHeaders(pairs: HeaderPair[]): string {
  var out: string[] = [];
  var i: number;
  for (i = 0; i < pairs.length; i++) {
    out.push(pairs[i][0] + ": " + pairs[i][1]);
  }
  return out.join("\r\n");
}

/** Convert a pair list -> native headersJson object {name: string|array}. */
export function headersToJsonObject(pairs: HeaderPair[]): any {
  var obj: any = {};
  var i: number;
  for (i = 0; i < pairs.length; i++) {
    var name = pairs[i][0];
    var value = pairs[i][1];
    if (has(obj, name)) {
      if (isArr(obj[name])) {
        obj[name].push(value);
      } else {
        obj[name] = [obj[name], value];
      }
    } else {
      obj[name] = value;
    }
  }
  return obj;
}
