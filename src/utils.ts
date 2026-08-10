// ESHTTP small ES3-safe utilities (ported verbatim from src/eshttp.jsxinc
// L68–98; the OLD baseline lives at eshttp/review/architect-draft-eshttp.jsxinc
// and the pre-rewrite src/eshttp.jsxinc). Pure, Illustrator-agnostic, no host
// globals — safe to import from Node tests.

/** typeof v === "function" */
export function isFn(v: any): boolean {
  return typeof v === "function";
}

/** typeof v === "string" */
export function isStr(v: any): boolean {
  return typeof v === "string";
}

/** typeof v === "number" && !isNaN(v) */
export function isNum(v: any): boolean {
  return typeof v === "number" && !isNaN(v);
}

/** Cross-realm array check via Object.prototype.toString (ES3-safe). */
export function isArr(v: any): boolean {
  return Object.prototype.toString.call(v) === "[object Array]";
}

/** v !== null && typeof v === "object" && !isArr(v) */
export function isObj(v: any): boolean {
  return v !== null && typeof v === "object" && !isArr(v);
}

/** Own-property check guarded against null/undefined. */
export function has(o: any, k: any): boolean {
  return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
}

/** String trim (no String.prototype.trim reliance — ES3). */
export function trim(s: any): string {
  s = String(s);
  return s.replace(/^\s+|\s+$/g, "");
}

/** String.toLowerCase */
export function toLower(s: any): string {
  return String(s).toLowerCase();
}

/** Wall-clock now in ms. */
export function now(): number {
  return new Date().getTime();
}

/** Own-loop indexOf (no Array.prototype.indexOf reliance). */
export function arrIndexOf(arr: any[], x: any): number {
  var i: number;
  for (i = 0; i < arr.length; i++) { if (arr[i] === x) { return i; } }
  return -1;
}

/** Best-effort message from an arbitrary thrown value (never throws). */
export function errStr(e: any): string {
  try {
    if (e && e.message) { return String(e.message); }
    return String(e);
  } catch (x) {
    return "unknown error";
  }
}
