// ESHTTP URL parsing (ported from src/eshttp.jsxinc L875–989; api-spec §2/§8).
//
// Pure, Illustrator-agnostic. Only http/https schemes per the contract; a
// non-parseable or non-http(s) URL returns { valid: false } (the caller
// converts to a "bad-url" error Result — never a throw).
import { ParsedUrl } from './types';
import { toLower } from './utils';

/**
 * Parse an absolute http(s) URL into a ParsedUrl record.
 *   scheme://[userinfo@]host[:port][/path][?query][#hash]
 * Supports IPv6 hosts in brackets ([::1]:8080). Unsupported schemes and
 * malformed authority return { valid: false } (never throws).
 */
export function parseUrl(url: any): ParsedUrl {
  var u = String(url);
  var res: ParsedUrl = {
    scheme: "",
    host: "",
    port: 0,
    path: "/",
    query: "",
    hash: "",
    userinfo: "",
    valid: false,
    http: false,
    https: false
  };
  var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(u);
  if (!m) { return res; }
  var scheme = m[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") { return res; } // bad-url upstream
  res.scheme = scheme;
  res.http = (scheme === "http");
  res.https = (scheme === "https");

  var authority = m[2];
  var at = authority.lastIndexOf("@");
  if (at >= 0) {
    res.userinfo = authority.substring(0, at);
    authority = authority.substring(at + 1);
  }
  // IPv6 in brackets: [::1]:8080
  if (authority.charAt(0) === "[") {
    var close = authority.indexOf("]");
    if (close < 0) { return res; }
    res.host = authority.substring(1, close);
    var rest = authority.substring(close + 1);
    if (rest.charAt(0) === ":") {
      res.port = parseInt(rest.substring(1), 10) || 0;
    }
  } else {
    var colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      res.host = authority.substring(0, colon);
      res.port = parseInt(authority.substring(colon + 1), 10) || 0;
    } else {
      res.host = authority;
    }
  }
  if (!res.host) { return res; }
  if (!res.port) { res.port = res.https ? 443 : 80; }

  var pathAndQuery = m[3];
  var q = m[4] || "";
  var h = m[5] || "";
  if (q.length > 0) { q = q.substring(1); }   // strip leading '?'
  if (h.length > 0) { h = h.substring(1); }   // strip leading '#'
  res.path = (pathAndQuery && pathAndQuery.length > 0) ? pathAndQuery : "/";
  res.query = q;
  res.hash = h;
  res.valid = true;
  return res;
}

/**
 * Rebuild a full URL string from a parsed URL (normalized, query merged).
 * Defensive: never throws on a non-parsed object (helpers surface).
 */
export function urlString(u: any): string {
  if (u === null || u === undefined || typeof u !== "object" || typeof u.scheme !== "string") {
    return "";
  }
  var s = u.scheme + "://";
  if (u.userinfo) { s += u.userinfo + "@"; }
  if (u.host.indexOf(":") >= 0 && u.host.charAt(0) !== "[") {
    s += "[" + u.host + "]";
  } else {
    s += u.host;
  }
  if (u.port && u.port !== (u.https ? 443 : 80)) {
    s += ":" + u.port;
  }
  s += u.path || "/";
  if (u.query) { s += "?" + u.query; }
  if (u.hash) { s += "#" + u.hash; }
  return s;
}

/**
 * Resolve a (possibly relative) Location header against a base URL.
 * Absolute locations pass through; root-relative ("/x") and path-relative
 * ("z") resolve against the base's origin + directory.
 */
export function resolveUrl(baseUrl: any, location: any): string {
  location = String(location);
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(location)) {
    return location; // already absolute
  }
  var base = parseUrl(baseUrl);
  if (!base.valid) { return location; }
  var origin = base.scheme + "://" + base.host +
               (base.port && base.port !== (base.https ? 443 : 80) ? ":" + base.port : "");
  if (location.charAt(0) === "/") {
    return origin + location;
  }
  // Relative: strip the last path segment of the base.
  var basePath = base.path || "/";
  var slash = basePath.lastIndexOf("/");
  var dir = slash >= 0 ? basePath.substring(0, slash + 1) : "/";
  return origin + dir + location;
}

/**
 * Same-host comparison (host case-insensitive + port equal). Used by the
 * socket redirector for the cross-host Authorization drop (api-spec §8, G1).
 */
export function sameHost(a: any, b: any): boolean {
  var pa = parseUrl(a);
  var pb = parseUrl(b);
  if (!pa.valid || !pb.valid) { return false; }
  return toLower(pa.host) === toLower(pb.host) && pa.port === pb.port;
}
