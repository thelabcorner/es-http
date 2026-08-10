# eshttp — Public API Specification v1 (`contracts/http-api-v1`)

Status: **v1 (draft-for-review)** · Owner: architect (t-spec) · Updated: 2026-08-09
Implementers: core-dev (t-core) · Consumers: qa (t-integrate), docs (t-docs)

This is the **binding public contract**. The implementation must expose
exactly this surface. Behavior is identical on the native and socket paths
except where explicitly noted (§10).

---

## 1. Namespace

One global: `eshttp` on `$.global`. Nothing else leaks.

```js
typeof eshttp            // "object"
eshttp.version           // "1.0.0"
```

Members:

| Member | Kind | Purpose |
|--------|------|---------|
| `request(opts)` | fn | Core request. Returns a Result object. |
| `get(url, opts)` | fn | GET convenience. |
| `post(url, body, opts)` | fn | POST convenience (body auto-JSON if object). |
| `put(url, body, opts)` | fn | PUT convenience (same body rules). |
| `del(url, opts)` | fn | DELETE convenience. |
| `json` | fn+obj | JSON helper: `eshttp.json.parse(str[, reviver])`, `eshttp.json.stringify(v)`, callable `eshttp.json(str)` ≡ parse. |
| `configure(opts)` | fn | Merge into defaults; returns previous defaults. |
| `forceTransport(name)` | fn | `"auto" \| "native" \| "socket"`; for tests/diagnostics. Returns the now-active transport name. |
| `resetTransport()` | fn | Drop cached transport selector + cached ExternalObject; next call re-probes. |
| `transportInfo()` | fn | `{host, platform, transport, nativeVersion, externalObjectAvailable, socketAvailable, abi}` (see §9). |
| `transport` | prop | Currently active transport name (`"native" \| "socket" \| "none"`). |
| `DEFAULTS` | obj | Read-only defaults snapshot (replacement-safe: always returns a fresh copy). |
| `error` | obj | Taxonomy constants (see §7): `eshttp.error.*` code strings. |

---

## 2. `eshttp.request(opts)` — full surface

```js
var result = eshttp.request({
  method:  "GET",          // string, default "GET"; case-insensitive
  url:     "https://api.example.com/v1/items",
  query:   { page: 2, tags: ["a","b"] },  // optional; merged into url query
  headers: { "Accept": "application/json", "X-Token": "abc" }, // object
  body:    null,           // string | Object (auto JSON.stringify) | omitted
  timeout: 30000,          // ms; default 30000
  redirect: "follow",      // "follow" (default) | "manual"
  maxRedirects: 5,         // default 5 (follow only)
  verifyTls: true,         // native path only; default true
  username: null,          // -> Authorization: Basic (native path)
  password: null,
  userAgent: "eshttp/1.0.0",   // default; both paths. An explicit
                               //   User-Agent header wins over this (§6.2);
                               //   "" suppresses the header entirely.
                               //   ERRATUM (additive): when opts.userAgent is
                               //   unset/null AND no User-Agent header AND the
                               //   host exposes a product name + version, the
                               //   sent default is the dynamic form
                               //   "eshttp/1.0.0 (Adobe <host> <version>; <platform>)";
                               //   the static "eshttp/1.0.0" is the fallback
                               //   otherwise (see §6.2 row 3 addendum).
  proxy: null,             // "http://host:port" (native path only)
  decompress: true,        // native path: Accept-Encoding gzip + auto-decompress
  maxBodyBytes: 52428800,  // 50 MiB default cap on response body
  bodyIsBase64: false,     // true if opts.body is base64 (binary body, native path)
  json: false              // true -> parse a 2xx body into result.data (§11)
});
```

Validation (all pre-call, before any I/O):

- `url` required, string, parseable. Absolute URL with scheme
  (`http`, `https`). Anything else → error result (`"invalid-args"` /
  `"bad-url"`), **no throw**.
- `method` must be a valid token (letters/digits/`!#$%&'*+-.^_`|~`), no
  spaces/CR/LF → else `"invalid-args"`.
- `headers` object values must be string or array-of-strings; any CR/LF in a
  name or value → `"invalid-header"` (usage category).
- `body` object → `JSON.stringify` + `Content-Type: application/json` unless
  the caller already set a Content-Type. `body` string → sent raw (caller
  sets Content-Type if needed).
- `query` object → serialized `k=v` pairs (`Array` values repeated as
  multiple `k=v`), merged into the URL (existing query preserved, keys
  appended/overridden), percent-encoded UTF-8.
- Unknown option keys are ignored (forward compatible). Invalid types for
  known keys (e.g. `timeout: "x"`) → `"invalid-args"`.

### 2.1 Defaults (`eshttp.DEFAULTS`)

```js
{ timeout: 30000, redirect: "follow", maxRedirects: 5, verifyTls: true,
  userAgent: "eshttp/1.0.0", decompress: true, maxBodyBytes: 52428800,
  transport: "auto" }
```

`eshttp.configure({ timeout: 15000, userAgent: "my/1.0" })` merges shallowly
over defaults; returns the previous defaults object. Per-call `opts` always
win over configured defaults.

---

## 3. Result object (returned by all entry points)

```js
{
  status:     200,          // int; 0 when no response was received
  statusText: "OK",         // reason phrase; "" when no response
  headers:    { "content-type": "application/json", ... }, // lowercased keys
  body:       "...",        // string: decoded body (binary-safe string for binary)
  bodyText:   "...",        // string: text form — == body for text bodies;
                            //        base64 form for binary bodies
  ok:         true,         // 200 <= status < 300
  data:       null,         // only present when opts.json === true and 2xx (§11):
                            //   parsed value, or null on parse failure. When
                            //   opts.json is not true the key is ABSENT
                            //   (result.data === undefined — not null)
  error:      null,         // object|null — non-null only when NO response
  meta: {
    path:       "native",   // "native" | "socket" | "none"
    url:        "https://...",  // final URL after redirects
    redirects:  0,          // number of followed redirects
    timeMs:     123,        // wall time, best effort
    bytes:      456,        // response body byte length
    timeoutEnforced: true,  // false on socket path when host has no read timeout
    tlsVersion: "1.2",      // native only; null on socket
    httpVersion:"1.1",      // both paths: native from the envelope, socket
                            //   parsed from the HTTP status line (§10)
    abi:        "http-v1",  // envelope/result ABI marker (native path)
    nativeVersion: "1.0.0", // eshttp_version() (native path)
    encodingWasApplied: false, // native only: gzip/deflate actually applied?
                               //   forwarded from every native envelope (success
                               //   AND error); null only on socket / no-envelope
                               //   error results
    backend:    "winhttp"   // native only: "winhttp" | "wininet"; forwarded
                            //   from every native envelope; null only on
                            //   socket / no-envelope error results
  }
}
```

Guarantees:

- `request` **never throws** for I/O/validation failures; it returns a Result
  with a populated `error` and `status === 0`. (Only catastrophic internal
  bugs may throw; they should not be caught and hidden.)
- When a response was received (any status, including 4xx/5xx):
  `error === null`, `ok` reflects 2xx. Callers wanting axios-style throwing
  on 4xx/5xx can check `result.ok`.
- `headers` keys are always lowercased; repeated headers are joined with
  `", "` (per RFC 7230 list rules). Cookie: joined with `"; "`.
- `body` is always a string. For text-ish responses it is the decoded text;
  for binary responses it is the raw binary string (byte-per-char). Use
  `bodyText` when you need a display-safe string.
- `statusText`/`headers` are best-effort on the socket path (parsed from the
  HTTP response line / header block).
- `meta.abi` exists on native responses so qa can verify envelope versioning.
- `meta.path` is `"none"` on the error Result produced when no transport
  could be selected at all (neither `eshttp.dll` nor `Socket` available).
- `meta.encodingWasApplied` and `meta.backend` are passed through from the
  native envelope (`native-abi.md` §4) as observable diagnostics: they let a
  caller (and qa) detect that `decompress: true` silently degraded to
  identity on a pre-Win10-1903 host. The DLL emits both keys in **every**
  envelope — success **and** error-shaped (§4.3) — so they are forwarded on
  **native** results of both kinds (`encodingWasApplied:false`,
  `backend:"winhttp"` on a native timeout, for example). They are `null` only
  on the socket path and on error results that have no native envelope
  (no transport, or DLL failure paths that never produced an envelope).
  Additive keys — consumers must tolerate unknown `meta`
  keys.
- `data` is **absent** (`result.data === undefined`) unless `opts.json === true`
  and the response was 2xx and the body parsed (§11). When `opts.json === true`
  on a 2xx: `data` = the parsed value, or `null` on parse failure (with
  `error.code === "invalid-json"`). Callers using `if (res.data)` are
  unaffected either way.

---

## 4. Convenience functions

```js
// GET
eshttp.get("https://api.example.com/items", { query: { page: 2 } });

// POST — object body is auto-JSON with Content-Type: application/json
eshttp.post("https://api.example.com/items", { name: "x" }, { timeout: 5000 });

// POST — raw string body
eshttp.post("https://api.example.com/x", "hello=1", { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

// PUT
eshttp.put("https://api.example.com/items/1", { name: "y" });

// DELETE (named `del`, ES3-reserved-word-safe)
eshttp.del("https://api.example.com/items/1");

// Shortest form
eshttp.get("https://example.com");          // opts optional
eshttp.post(url, body);                     // opts optional
```

All four return the identical Result object shape (§3) and pass their `opts`
straight through to `request`.

---

## 5. `eshttp.json` — ES3 JSON helper

ExtendScript has **no** `JSON` global. eshttp ships an ES3-clean parser +
serializer (eson-style, embedded — core-dev does not require any other
library).

```js
eshttp.json.parse("{\"a\":1}")        // -> { a: 1 }   (throws on invalid? No:
                                      //   see below)
eshttp.json.stringify({ a: 1 })       // -> "{\"a\":1}"
eshttp.json("{\"a\":1}")              // == eshttp.json.parse(...)
eshttp.json.parse("not json")         // -> null (never throws)
```

Contract:

- `parse(str)` returns `null` on invalid JSON or non-string input. **Never
  throws.** (Parsing happens on request bodies/responses where a throw would
  break the never-throw guarantee; users needing exceptions wrap themselves.)
  Optional second argument `reviver(str, reviver)`: a function applied
  bottom-up after parsing (json2 walk semantics — `this` is the holder, an
  `undefined` return deletes the key, the root call uses key `""`). A
  throwing reviver is swallowed to `null` by the never-throw contract.
- `stringify(v)` returns a JSON string for `Object`/`Array`/`string`/
  `number`/`boolean`/`null`. `undefined`/functions → omitted in objects,
  `null` in arrays. Circular references → `null` for the offending branch
  (documented simplification) — no infinite loop.
- Unicode: `\uXXXX` escapes used for non-ASCII (keeps output 7-bit clean —
  important for the UTF-8 ABI boundary). Control chars use the standard
  short escapes (`\b \f \n \r \t`), everything else `< 0x20` as `\uXXXX`.
- Strictness: the parser is RFC 8259-exact on numbers (`0`/`-0` ok;
  leading zeros, bare `1.`/`.5`/`-.5`, and incomplete exponents rejected),
  rejects malformed `\u` escapes and raw control chars inside strings, and
  caps nesting at depth 512 — matching the ESON core (validated by
  `test/parity/parity.mjs`).

---

## 6. Query params, headers, bodies — normalization rules

### 6.1 `query`
- `{ page: 2, tags: ["a","b"] }` → `page=2&tags=a&tags=b`
- Encoding: UTF-8 percent-encoding (encodeURIComponent-equivalent
  implemented ES3-clean: `encodeURIComponent` exists in ExtendScript and may
  be used, but must be wrapped in try/catch fallback).
- Merging: existing query in `url` is preserved; `query` keys are appended
  (duplicate keys allowed, in order).

### 6.2 `headers`
- Input: `{ "Accept": "application/json" }`. Key case is preserved on the
  wire; the response `headers` map is lowercased.
- Duplicate/CR-LF guards enforced (§2 validation).
- Forbidden override (native path): `Host`, `Content-Length` are managed by
  the DLL; user-set values are ignored for these two (documented). The socket
  path likewise computes `Host`/`Content-Length` and ignores caller values.

#### `User-Agent` precedence (binding)

Exactly **one** `User-Agent` header reaches the wire, and the behavior is
**identical on both transports**:

| `headers` has a `User-Agent`? | `opts.userAgent` | Wire result |
|---|---|---|
| yes (match is case-insensitive) | ignored | the caller's header value, verbatim — including `""` (sent as an empty value) |
| no | non-empty string | that string |
| no | `null` / unset | the default — **ERRATUM (additive, ratified 2026-08-10):** the static `"eshttp/1.0.0"` is the documented fallback; when the host exposes a product name + version, the sent value is the dynamic `"eshttp/1.0.0 (Adobe <host> <version>; <platform>)"` (leading token preserved — wire-compatible; see §6.2 addendum below) |
| no | `""` | **no `User-Agent` header is sent** |

**Addendum (errata, additive — NOT a contract change; `http-api-v1` stays frozen).**
The default User-Agent form is host-derived when available:
`"eshttp/1.0.0 (Adobe Illustrator 30.6; Windows NT 10.0; Win64; x64)"` — format
`eshttp/1.0.0 (Adobe <app.name> <app.version>; <platform>)` where `<platform>` is:
- `"Windows NT 10.0; Win64; x64"` / `"Windows NT 10.0; Win32; x86"` when the OS is
  Windows and `PROCESSOR_ARCHITECTURE` is readable (AMD64/x64 → Win64/x64; x86/IA32 →
  Win32/x86);
- `"Windows"` when Windows but the arch token is unreadable;
- `"Macintosh"` on macOS;
- the raw `$.os` string otherwise.
Rules that stay binding:
- The leading product token is always `eshttp/1.0.0` (identical to the
  documented default) so servers matching on that token keep working.
- CR/LF and parentheses are stripped from name/version/platform
  (header-injection guard; the socket path emits the value verbatim).
- The dynamic form is used ONLY in the "no header + `opts.userAgent` unset"
  case (row 3). **Header-wins (row 1) and `""`-suppresses (row 4) are
  absolute and unaffected** — precedence is resolved in the wrapper before
  any transport call, so the default form never overrides an explicit header
  and never resurrects a suppressed UA.
- When the host has no name or version (harness stubs, some COM contexts),
  the static `"eshttp/1.0.0"` is sent (documented row-3 default).

Rules:

- An explicit header **always** wins; header precedence is absolute.
- Precedence is resolved in the ES3 wrapper **before** the transport call.
  On the native path this means `optsJson.userAgent` is JSON `null` whenever
  a caller header already won **or** the caller suppressed the UA, so
  `eshttp.dll` receives exactly one `User-Agent` (or none) and performs
  **no de-duplication of its own** (`native-abi.md` §3.1/§3.3).
- **Row 4 is a wire guarantee (errata R-G5-E1).** "No `User-Agent` header is
  sent" means the request contains **zero** `User-Agent` bytes on **both**
  transports. No layer may re-introduce one: the socket driver writes no
  header line, and on the native path neither the DLL nor the underlying
  WinHTTP session may inject a default/built-in agent string when
  `optsJson.userAgent` is `null` (`native-abi.md` §3.1). Emitting
  `User-Agent: eshttp/1.0.0` for a suppressed UA violates this contract.
- `configure({ userAgent: ... })` only replaces the default; a per-call
  header still overrides it.

### 6.3 `body`
- Object → stringified JSON, `Content-Type: application/json` default
  (unless caller set one).
- String → raw bytes (UTF-8) on the native path; raw on socket path.
- `bodyIsBase64: true` (native path only) → base64-decoded by the DLL before
  sending; `Content-Length` computed on the decoded size. On the socket path
  `bodyIsBase64` is unsupported → error `"unsupported"` (category usage).

---

## 7. Error taxonomy (`eshttp.error`)

All codes are stable strings; the `error` object always has this shape:

```js
{ code: "timeout",        // taxonomy code
  category: "timeout",    // usage | transport | tls | timeout | abort | protocol | internal
  message: "...",         // human-readable, includes host URL
  retryable: false,       // safe to retry same request?
  detail: { ... } }       // OPTIONAL — omitted unless the transport supplies
                          // extras (e.g. { winhttp: 12002 } on the native
                          // path). Callers must guard with `if (err.detail)`.
```

`eshttp.error` exposes the codes as constants (they equal the strings):

| code | category | meaning | retryable | native↔socket mapping |
|------|----------|---------|-----------|----------------------|
| `"invalid-args"` | usage | Bad option types / missing url | no | pre-call validation |
| `"bad-url"` | usage | URL unparseable / unsupported scheme | no | pre-call / DLL `"bad-url"` |
| `"invalid-header"` | usage | CR/LF or malformed header | no | pre-call / DLL `"invalid-header"` |
| `"unsupported"` | usage | Feature not available on the active transport: `https://` on socket, `bodyIsBase64` on socket, or no transport at all. (Non-`http(s)` schemes such as `ftp://` are rejected earlier by §2 validation as `"bad-url"`, so they never reach a driver.) | no | JS-side |
| `"dns"` | transport | DNS resolution failed | **yes** | DLL `"dns"` |
| `"connect"` | transport | TCP connect failed/refused | **yes** | DLL `"connect"` |
| `"network"` | transport | Connection lost/reset mid-request | **yes** | DLL `"network"` |
| `"tls"` | tls | TLS handshake/cert failure (native only) | no* | DLL `"tls"` (*retryable=false: cert problems rarely fix by retry; caller may set verifyTls:false) |
| `"timeout"` | timeout | Exceeded opts.timeout | **yes** | DLL `"timeout"` |
| `"aborted"` | abort | Caller canceled (v1: only internal) | no | DLL `"aborted"` |
| `"too-many-redirects"` | protocol | maxRedirects exceeded | no | DLL / JS redirector |
| `"body-too-large"` | protocol | Response exceeded maxBodyBytes | no | DLL `"body-too-large"` |
| `"invalid-json"` | protocol | Response claimed JSON but body unparseable — only when `opts.json === true` (§11) | no | JS-side |
| `"internal"` | internal | DLL/JS internal failure | no | DLL `"internal"` |

Mapping rule (native path): the DLL returns its own `error.code`; the
wrapper maps 1:1 to this table, fills `category`/`retryable`, and copies
`detail.winhttp` (the raw `GetLastError`-style code) through. Unknown DLL
codes map to `"internal"`.

On the **socket** path only these are producible: `invalid-args`,
`bad-url`, `invalid-header`, `unsupported`, `network`, `timeout`
(best-effort), `too-many-redirects`, `body-too-large`, `internal`.

---

## 8. Redirects

- `redirect: "follow"` (default): 301/302/303 → `GET` (body dropped,
  Content-Type/Content-Length dropped); 307/308 → method + body preserved.
  `Authorization` is dropped when the redirect target host differs from the
  request host. `meta.redirects` counts hops; exceeding `maxRedirects` →
  `"too-many-redirects"`.
- `redirect: "manual"`: the 3xx response is returned as-is; caller inspects
  `result.headers.location`.
- Native path: DLL performs redirect handling internally per the opts
  (`redirect`, `maxRedirects`), reports `meta.finalUrl` + `meta.redirects`.
  Socket path: JS redirector implements the same rules.

---

## 9. `eshttp.transportInfo()` — diagnostics

```js
{
  host: "Adobe Illustrator",        // app.name, or null outside Adobe host
  platform: "Windows",               // "Windows" | "Macintosh" from $.os
  transport: "native",               // "native" | "socket" | "none"
  externalObjectAvailable: true,
  socketAvailable: true,
  nativeVersion: "1.0.0",            // eshttp_version(), null if absent
  abi: "http-v1"                     // envelope ABI marker, native only
}
```

`eshttp.transport` (property) is the same `transport` value, always current.

---

## 10. Transport capability matrix (contract between drivers)

| Capability | native (eshttp/WinHTTP) | socket (ES3) |
|------------|------------------------|--------------|
| http:// | ✓ | ✓ |
| https:// | ✓ (TLS 1.2+) | ✗ → `"unsupported"` |
| Custom methods | ✓ | ✓ (any token) |
| Request headers | ✓ | ✓ (subset — some hosts restrict e.g. `Content-Length`; wrapper computes and sends `Host` + `Content-Length`) |
| Query merge | ✓ (JS-side before ABI call) | ✓ (JS-side) |
| JSON body | ✓ | ✓ |
| Binary body (base64) | ✓ | ✗ |
| Redirect follow | ✓ (in DLL) | ✓ (JS, manual re-request) |
| Timeout | ✓ (WinHTTP) | ✗ best-effort; `meta.timeoutEnforced=false` when host lacks read timeout |
| TLS verify off | ✓ (`verifyTls:false`) | n/a |
| Proxy | ✓ (`opts.proxy`) | ✗ |
| gzip/deflate auto | ✓ (`decompress`) | ✗ |
| Response header count | ✓ all | limited to what host returns on headers() |
| `meta.httpVersion` | ✓ (envelope) | ✓ (parsed from the status line) |
| `User-Agent` precedence (§6.2) | ✓ identical | ✓ identical |
| `meta.encodingWasApplied` / `meta.backend` | ✓ | `null` |
| `opts.json` → `result.data` (§11) | ✓ identical | ✓ identical |

Socket path contract details (core-dev):
- Raw TCP via `new Socket()`; send an HTTP/1.1 request with `Host`,
  `Connection: close` (simplest, avoids keep-alive state), computed
  `Content-Length`, then `s.writeln("")`.
- Read response head (status line + headers) up to CRLFCRLF; then read body
  until EOF (Connection: close) — `Content-Length` also honored when
  present.
- `s.close()` in `finally`-equivalent (try/finally) — always release.
- `meta.timeoutEnforced`: if the host's Socket exposes a timeout/read
  blocking control, use it; else `false`.

---

## 11. JSON convenience on response

`opts.json === true`: after a successful response (2xx), attempt
`eshttp.json.parse(result.body)`; store the parsed value on
`result.data`. On parse failure → `error.code = "invalid-json"`,
`result.status` kept as the HTTP status, `result.error` populated, and
`result.data = null`. (Mirrors axios `responseType: "json"`.)
Not required for the socket path to differ — identical behavior both paths.

---

## 12. ES3 constraints (binding for core-dev)

The entire implementation is ES3 (ExtendScript). Forbidden:

- No `let`/`const`/arrow functions/classes/template literals/destructuring/
  default params/spread/rest.
- No `JSON`, `Promise`, `fetch`, `XMLHttpRequest`, `Map`/`Set`, typed arrays
  (except where host provides them — do not depend).
- No `Array.prototype.map/filter/forEach/reduce/indexOf` reliance (host-
  dependent). Write own loops.
- No `Object.keys`, `hasOwnProperty` on `Object.prototype` is fine; use
  `for (var k in obj)` with `obj.hasOwnProperty(k)` guards.
- `typeof`, `instanceof`, `String/Number/Boolean`, `RegExp` are fine.
- No `bind`/`call`/`apply` dependence (call/apply OK, bind not guaranteed).
- String `charCodeAt/fromCharCode` fine; `charAt` fine.
- IIFE + `var` only. `"use strict"` may be included at top of the file (hosts
  honor it) but code must not rely on ES5 semantics.
- Single self-contained `eshttp.jsxinc`. No external `#include` chains.
- Test each file by loading in at least Illustrator + InDesign + Photoshop
  runtimes (qa), plus plain-ExtendScript (ESTK) runtime.

Rationale (from the skills): Adobe CS-era hosts run ES3 with host
extensions; ES5+ syntax breaks on older CC/CS hosts and in ESTK. The socket
path exists precisely because TLS needs the native accelerator.
