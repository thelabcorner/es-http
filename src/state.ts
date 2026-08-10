// ESHTTP module state + host-global access (ported from src/eshttp.jsxinc
// L30–63 module state + L1302–1323 session-global access).
//
// Single home for every piece of cross-module mutable state so the port keeps
// the jsxinc's single-closure semantics. Because TS treats imported bindings
// as read-only, REASSIGNMENTS go through the setter functions below; readers
// import the exported vars directly (their mutations are property writes or
// setter-mediated).
//
// __noNetwork is NOT a var here: the jsxinc exposes it as a plain mutable
// prop on the eshttp facade object, and internal code reads the SAME object
// (`eshttp.__noNetwork`). The port mirrors that exactly — the facade object
// built in index.ts carries a plain `__noNetwork` prop, and `noNetwork()`
// reads it through the cached `_facade` reference. Tests assign
// `eshttp.__noNetwork = true`; internal probes see it.
//
// Host-global access is typeof-guarded at CALL time only (never at
// module-eval), per the build contract.
import { Defaults, NativeCache } from './types';

/** Internal defaults. eshttp.DEFAULTS is a replacement-safe snapshot of
 *  these; per-call opts always win. */
export var _defaults: Defaults = {
  timeout: 30000,
  redirect: "follow",          // "follow" | "manual"
  maxRedirects: 5,
  verifyTls: true,
  userAgent: "eshttp/1.0.0",
  decompress: true,
  maxBodyBytes: 52428800,      // 50 MiB
  transport: "auto"            // "auto" | "native" | "socket"
};

/**
 * Resolve the DEFAULT User-Agent for a request when the caller supplies no
 * explicit UA header and no opts.userAgent. Sponsor-requested content:
 *   "Adobe Illustrator v{ai_version} - es-http v{eshttp_version}" (+ OS)
 * rendered in the TYPICAL fleshed-out User-Agent format (RFC 7231):
 *   product/version (comment)     e.g. curl/8.4.0, Wget/1.21.3 (linux-gnu)
 * so the shipped default is:
 *   "eshttp/1.0.0 (Adobe Illustrator 30.6; Windows NT 10.0; Win64; x64)"
 * - Leading product token stays `eshttp/1.0.0` — identical to the pre-change
 *   default, so servers matching on that token keep working.
 * - The comment carries the host app (name + version, spaces preserved —
 *   product tokens cannot contain spaces; comments can) then the platform:
 *   Windows -> "Windows NT 10.0; Win64; x64" style tokens are not queryable
 *   from ES3 ($.os returns only "Windows"/"Macintosh"), so we emit the
 *   classic platform tokens and the PROCESSOR_ARCHITECTURE env var when
 *   readable, else just "Windows" / "Macintosh".
 * - CR/LF and parens are stripped from every interpolated value (header +
 *   comment injection guards; the socket path emits this verbatim).
 * When the host has no name/version (harness `app = { name: "QA Headless" }`,
 * some COM contexts), falls back to the static default "eshttp/1.0.0"
 * (api-spec §6.2 row 3).
 */
export function defaultUserAgent(): string {
  var fallback = _defaults.userAgent || "eshttp/1.0.0";
  try {
    if (typeof app === "undefined" || !app) { return fallback; }
    var name = app.name ? String(app.name) : "";
    var ver = app.version ? String(app.version) : "";
    // The dynamic form requires BOTH a product name and a version — a bare
    // name would yield an empty-version comment, so fall back instead.
    if (!name || !ver) { return fallback; }
    var comment = name + " " + ver;
    var platform = platformToken();
    if (platform) { comment += "; " + platform; }
    return "eshttp/" + _VERSION + " (" + comment + ")";
  } catch (e) {
    return fallback;
  }
}

/**
 * Platform comment token for the User-Agent: "Windows", "Macintosh", or a
 * richer "Windows NT 10.0; Win64; x64"-style token when the environment
 * exposes architecture (PROCESSOR_ARCHITECTURE via $.getenv — present in
 * COM/host envs; missing in the vm harness). Same $.os classification as
 * transportInfo. Never throws; returns "" when unknown.
 */
function platformToken(): string {
  try {
    if (typeof $ === "undefined" || !$.os) { return ""; }
    var os = String($.os);
    var plat = "";
    if (/windows/i.test(os)) {
      plat = "Windows";
      // Flesh out with the classic NT + arch tokens when readable.
      var arch = "";
      try {
        if (typeof $.getenv === "function" && $.getenv("PROCESSOR_ARCHITECTURE")) {
          arch = String($.getenv("PROCESSOR_ARCHITECTURE"));
        }
      } catch (e1) { arch = ""; }
      if (/AMD64|x64/i.test(arch)) { plat = "Windows NT 10.0; Win64; x64"; }
      else if (/x86|IA32/i.test(arch)) { plat = "Windows NT 10.0; Win32; x86"; }
      else { plat = "Windows"; }
    } else if (/mac/i.test(os)) {
      plat = "Macintosh";
    } else {
      plat = os;
    }
    return plat.replace(/[\r\n()]/g, "").trim();
  } catch (e) {
    return "";
  }
}

/** Library version string (single source; also exposed as eshttp.version). */
export var _VERSION: string = "1.0.0";

/** Transport selector state. */
export var _forcedTransport: string | null = null;     // null | "auto" | "native" | "socket"
export var _currentTransport: string = "none";  // last resolved active transport
export var _detectedTransport: string | null = null;   // cached result of probing

/** Native (eshttp.dll) probe cache, kept on the session global so it
 *  survives script runs inside #targetengine "session". */
export var _nativeCacheKey: string = "__eshttp_native_v1";
export var _nativeCache: NativeCache | null = null;    // { accel, version, available, dead }

/** Envelope ABI marker expected from eshttp.dll (native-abi v1). */
export var _ABI: string = "http-v1";

/** The assembled facade object (set once by index.ts). Carries the plain
 *  mutable `__noNetwork` prop; `noNetwork()` reads it. */
var _facade: any = null;

export function setFacade(f: any): void {
  _facade = f;
}

/** Test hook: when true, request() short-circuits to a NO_TRANSPORT-style
 *  error result without touching Socket / ExternalObject. Reads the facade's
 *  plain `__noNetwork` prop so test assignment `eshttp.__noNetwork = true`
 *  is visible to every internal probe. */
export function noNetwork(): boolean {
  return !!(_facade && _facade.__noNetwork);
}

export function setForcedTransport(v: string | null): void { _forcedTransport = v; }
export function setCurrentTransport(v: string): void { _currentTransport = v; }
export function setDetectedTransport(v: string | null): void { _detectedTransport = v; }
export function setNativeCache(v: NativeCache | null): void { _nativeCache = v; }

/**
 * Resolve the session-global object (jsxinc `_sessionGlobal`).
 * Returns `$.global` in ExtendScript hosts, `global` in Node (ESM core),
 * else undefined. typeof-guarded at call time.
 */
export function sessionGlobal(): any {
  if (typeof $ !== "undefined" && $.global) { return $.global; }
  if (typeof global !== "undefined" && global) { return global; }
  return undefined;
}
