// ESHTTP shared types.
//
// Type-only module (erased at build time) — no runtime code, no host
// dependencies. Mirrors the shapes in docs/api-spec.md (http-api-v1) and
// docs/native-abi.md (native-abi-v1). All interfaces here are contract
// documentation for the port; the runtime keeps the jsxinc's ES3 behavior.

/** Error taxonomy code — one of the 14 stable strings (api-spec §7). */
export type ErrorCode =
  | "invalid-args"
  | "bad-url"
  | "invalid-header"
  | "unsupported"
  | "dns"
  | "connect"
  | "network"
  | "tls"
  | "timeout"
  | "aborted"
  | "too-many-redirects"
  | "body-too-large"
  | "invalid-json"
  | "internal";

/** Error taxonomy entry: category + retryable (api-spec §7). */
export interface ErrorTaxonomyEntry {
  category: string;
  retryable: boolean;
}

/** Public error object shape (api-spec §7) — returned as `result.error`. */
export interface EshttpError {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  /** OPTIONAL — omitted unless the transport supplies extras. */
  detail?: any;
}

/** Result meta block (api-spec §3). */
export interface ResultMeta {
  path: string;            // "native" | "socket" | "none"
  url: string;
  redirects: number;
  timeMs: number;
  bytes: number;
  timeoutEnforced: boolean;
  tlsVersion: any;
  httpVersion: any;
  abi: any;                // "http-v1" on native, null elsewhere
  nativeVersion: any;
  encodingWasApplied: any; // native only; null on socket / no-envelope
  backend: any;            // native only; null on socket / no-envelope
}

/** Result object returned by every public entry point (api-spec §3). */
export interface Result {
  ok: boolean;
  status: number;
  statusText: string;
  headers: any;            // lowercased-key map
  body: string;
  bodyText: string;
  /** Only present when opts.json === true and 2xx (api-spec §11). */
  data?: any;
  error: EshttpError | null;
  meta: ResultMeta;
}

/** Parsed URL shape (helpers.parseUrl / url.ts). */
export interface ParsedUrl {
  scheme: string;
  host: string;
  port: number;
  path: string;
  query: string;
  hash: string;
  userinfo: string;
  valid: boolean;
  http: boolean;
  https: boolean;
}

/** Normalized request header pair (wire order). */
export type HeaderPair = [string, string];

/** Internal request context built by context.ts (pre-I/O). */
export interface RequestContext {
  method: string;
  url: string;
  parsed: ParsedUrl | null;
  host: string;
  port: number;
  https: boolean;
  requestTarget: string;
  headers: HeaderPair[];
  body: string;
  bodyIsBase64: boolean;
  bodyIsEmpty: boolean;
  timeout: number;
  redirect: string;
  maxRedirects: number;
  verifyTls: boolean;
  userAgent: string | null;   // null = UA header already present, or suppressed
  username: string | null;
  password: string | null;
  proxy: string | null;
  decompress: boolean;
  maxBodyBytes: number;
  json: boolean;
}

/** Internal defaults (state.ts) — eshttp.DEFAULTS is a fresh snapshot.
 *  Index signature: configure() merges arbitrary known keys at runtime and
 *  the DEFAULTS getter snapshots by for-in, exactly like the jsxinc. */
export interface Defaults {
  timeout: number;
  redirect: string;
  maxRedirects: number;
  verifyTls: boolean;
  userAgent: string;
  decompress: boolean;
  maxBodyBytes: number;
  transport: string;
  [key: string]: any;
}

/** Public opts accepted by request() (api-spec §2). */
export interface Options {
  method?: any;
  url?: any;
  query?: any;
  headers?: any;
  body?: any;
  timeout?: any;
  redirect?: any;
  maxRedirects?: any;
  verifyTls?: any;
  username?: any;
  password?: any;
  userAgent?: any;
  proxy?: any;
  decompress?: any;
  maxBodyBytes?: any;
  bodyIsBase64?: any;
  json?: any;
}

/** Native envelope shape (native-abi §4) as parsed from the DLL. */
export interface NativeEnvelope {
  abi: string;
  ok: boolean;
  status: number;
  statusText: string;
  headers: any;
  body: string;
  bodyEncoding: string;
  error: any;
  meta: any;
}

/** Session-cached native driver state (state.ts / driver-native.ts). */
export interface NativeCache {
  accel: any;
  version: any;
  available: boolean;
  dead: boolean;
}
