# eshttp — eshttp.dll Native ABI Contract v2 (`contracts/native-abi-v2`)

Status: **v2 (bump from v1)** · Owner: architect (t-spec/recon-architect) · Updated: 2026-08-10
Implementer: native-dev (t6) · Consumer: core-dev (t7) · Auditor: qa (t-integrate)

**This file is the single source of truth for the C/DLL boundary.**
The implementation `eshttp.c` must match it exactly; the ES3 wrapper in
`src/driver-native.ts` is written against it. Any change to this contract is
a contract bump (`native-abi-v3`) and must be coordinated before landing.

**What changed v1 → v2 (breaking ABI change, coordinated):** the DLL moved from a
bare `__declspec(dllexport)` function library with **caller-owned** buffers
(caller MUST call `eshttp_free()` on every returned envelope) to the **canonical
Adobe ExternalObject direct-interface**: the 4 standard `ES*` exports
(`ESInitialize`/`ESGetVersion`/`ESFreeMem`/`ESTerminate`) + business functions
declared in the `ESInitialize` signature string, returning **host-owned
`kTypeString`** buffers that ExtendScript frees via `ESFreeMem`.
**`eshttp_free` is REMOVED from the export set** — the v1 "caller must free with
`eshttp_free()`" contract was a **double-free design flaw**: the ExternalObject
proxy copies the returned C string to JS at call return, and the host frees the
original `kTypeString` buffer through `ESFreeMem`; a separate `eshttp_free()` call
(which could not even see the original pointer through the string copy) double-
freed or leaked. See §4.4 and §2.

The **response-envelope schema is unchanged** (still `"abi": "http-v1"` in every
envelope — the envelope marker denotes the JSON schema version, which did not
change; the ABI contract version lives in this document's contract name
`native-abi-v2`, NOT in the envelope). `api-spec.md` (`contracts/http-api-v1`) is
**unchanged** — the public API is identical; only the C boundary mechanism
changed.

---

## 1. Overview

`eshttp.dll` is a small C11 DLL that performs blocking HTTP requests via
**WinHTTP** (WinHTTP preferred; WinINet acceptable fallback — pick one and
declare it in `eshttp_version` output / meta). It is loaded from ExtendScript as:

```js
var accel = new ExternalObject("lib:eshttp");
```

The DLL implements the **canonical Adobe ExternalObject direct-interface**
(`ESFunction` prototype — see §2/§2.1): business methods take `TaggedData`
argument vectors and return `TaggedData` results. All business payloads are
UTF-8 JSON strings. **No structs, no callbacks, no handles cross the boundary**
beyond the `TaggedData` envelope itself. Binary payloads cross the boundary
**base64-encoded** (NUL-safe — `kTypeString` is NUL-terminated and cannot carry
embedded NULs).

The direct interface is chosen because the API is small, flat, and synchronous,
returning numbers and carefully controlled strings (externalobject skill §"Choose
the interop model": prefer direct access for exactly this shape).

---

## 2. Export set (complete, no more, no less — v2)

**Exactly 8 exports: the 4 canonical `ES*` + 4 business functions.**
`eshttp_free` is REMOVED (v1 only — see §4.4). All exports are `extern "C"`,
undecorated, `__cdecl` (ExtendScript default).

```c
/* eshttp.h — extern "C", __declspec(dllexport), __cdecl */

/* ---- canonical ExternalObject direct-interface exports ---- */

/* Return the ESInitialize signature metadata string: a single comma-separated
   list of "name_<argcodes>" entries. The host parses this to bind the business
   methods. The returned string is malloc'd — the host frees it via ESFreeMem. */
__declspec(dllexport) const char* ESInitialize(TaggedData *argv, long argc);

/* Return a long version number, exposed as ExternalObject.version (= 1 in v2;
   v1 had no ESGetVersion, so the version property read 0). */
__declspec(dllexport) long ESGetVersion(void);

/* Release memory the host owns (kTypeString buffers returned by business
   methods, and the ESInitialize signature string). MUST match the DLL's
   allocator: in v2, plain free(). Never free a host pointer or a static
   buffer. */
__declspec(dllexport) void ESFreeMem(void *p);

/* Release persistent native state during unload (session cache cleanup).
   No-op-safe when nothing was initialized. */
__declspec(dllexport) void ESTerminate(void);

/* ---- business functions (declared via the ESInitialize signature string) ---- */

/* Perform one HTTP request. BLOCKING. Returns a malloc'd UTF-8 JSON envelope
   string (response envelope, §4) as a kTypeString, or kTypeUndefined on
   catastrophic failure (OOM). Host frees the string via ESFreeMem.
   Caller (JSX) passes the 5 string args in order; see §8 for the call shape. */
__declspec(dllexport) long eshttp_request(TaggedData *argv, long argc, TaggedData *retval);

/* Last error message (UTF-8), malloc'd copy. "" if none. Host frees via
   ESFreeMem. Takes a DUMMY argument (see signature string below); JSX calls
   eshttp_last_error(0). */
__declspec(dllexport) long eshttp_last_error(TaggedData *argv, long argc, TaggedData *retval);

/* Static version string "major.minor.patch" ("1.0.0"), malloc'd copy. Host
   frees via ESFreeMem. Takes a DUMMY argument; JSX calls eshttp_version(0).
   Also a liveness probe: if ExternalObject loads, this always succeeds. */
__declspec(dllexport) long eshttp_version(TaggedData *argv, long argc, TaggedData *retval);

/* 1 if the backend (WinHTTP session) initialized successfully, 0 otherwise.
   Lets the wrapper probe health without a network call. kTypeInteger result.
   Takes a DUMMY argument; JSX calls eshttp_available(0). */
__declspec(dllexport) long eshttp_available(TaggedData *argv, long argc, TaggedData *retval);
```

### 2.0 ESInitialize signature string (FINAL, binding)

```c
"eshttp_request_sssss,eshttp_last_error_f,eshttp_version_f,eshttp_available_f"
```

- `eshttp_request` takes **5 `_s` (string) args**: `(method, url, headersJson,
  body, optsJson)` — same 5-arg order and 11-optsJson-key contract as v1.
- **No-arg methods get a dummy `_f` argument, NOT bare names** (skill §"Define
  ESInitialize signatures correctly" L148–150: bare no-arg names were unreliable
  in the POC; ESON precedent: all no-arg methods are `_f` and its probes call
  them with a dummy `0`). **The JSX wrapper MUST pass the dummy `0`**:
  `accel.eshttp_version(0)`, `accel.eshttp_available(0)`,
  `accel.eshttp_last_error(0)`.
- The signature string itself is malloc'd and host-freed via ESFreeMem.

### 2.1 Calling convention & TaggedData shape

- Every business export is `long fn(TaggedData *argv, long argc, TaggedData
  *retval)` — the canonical `ESFunction` prototype (SoSharedLibDefs.h; verified
  live on Illustrator 30.6.0: effective call order `(argv, argc, result)`).
- `TaggedData` (8-byte pack):

```c
typedef struct TaggedData TaggedData;
struct TaggedData {
    union { long intval; double fltval; char *string; void *hObject; } data;
    long type;   /* kType* tag, see table */
    long filler;
};
```

- Tag values used by this contract (canonical + live-verified):

| Tag | Value | Use here |
|---|---|---|
| `kTypeUndefined` | 0 | catastrophic-failure result (retval preset); also result before write |
| `kTypeBool` | 2 | (not used) |
| `kTypeDouble` | 3 | (not used) |
| `kTypeString` | 4 | request args (`_s`); envelope/version/last_error results; ESInitialize signature string |
| `kTypeInteger` | 123 | `eshttp_available()` result (1/0) |
| `kTypeUInteger` | 124 | (not used) |
| `kTypeScript` | 125 | (not used — never return evaluated scripts) |

- **Return protocol:** business exports return `kESErrOK` (0) on success and
  write the result into `*retval` (`retval->type` + `retval->data`). Bad
  argument list → return `kESErrBadArgumentList` (20, **catchable**).
  **Never return negative error codes** (`kESErrNoMemory`=-28,
  `kESErrException`=-29, `kESErrInternal`=-33 are fatal/uncatchable — a negative
  return from a method is a host-bypass crash). Argument reads validate
  `argv[i].type == kTypeString` per `_s` before casting (ESON string_arg
  pattern); on mismatch, treat as bad-args.
- Zero the result slot before writing it.
- `__cdecl` (the ExtendScript default). Do **not** use `__stdcall` unless a host
  proves it necessary; if that ever happens it is
  `new ExternalObject("lib:eshttp", true)` on the JS side and a new contract
  revision. Keep cdecl.

### 2.2 Name decoration

- `extern "C"` everywhere → undecorated C names: `ESInitialize`, `ESGetVersion`,
  `ESFreeMem`, `ESTerminate`, `eshttp_request`, `eshttp_last_error`,
  `eshttp_version`, `eshttp_available`.
- Export via `__declspec(dllexport)` (MSVC) so no `.def` file is required.
- Build with MSVC `cl /LD`, **C mode** (`/TC`) or C++ with `extern "C"`.
  Native-dev: also export with a `.def` file listing the eight names if using
  mingw, and strip the DLL name to exactly `eshttp.dll` for release.

### 2.3 Threading & blocking

- `eshttp_request` is **synchronous** and runs entirely on the calling
  thread (the ExtendScript main thread). No worker threads that outlive the
  call; no callbacks into the host.
- Timeouts are enforced **inside** WinHTTP
  (`WINHTTP_OPTION_CONNECT_TIMEOUT`, `WINHTTP_OPTION_SEND_TIMEOUT`,
  `WINHTTP_OPTION_RECEIVE_TIMEOUT`, `WINHTTP_OPTION_RESOLVE_TIMEOUT`) from
  `opts.timeoutMs`. Do not abandon a read.
- The DLL must be re-entrant-safe enough for sequential calls (one request
  at a time from ES); a static WinHTTP session handle created lazily on
  first `eshttp_request` (or `eshttp_available`) is fine — **v2 keeps the
  lazy-init** (ESInitialize does NOT touch WinHTTP). Release the session
  cache in `ESTerminate()` (called by the host on unload) — or use
  `WINHTTP_OPTION`-based session lifetime that tolerates the host keeping
  the DLL loaded forever.

---

## 3. Request parameters (input JSON)

### 3.1 `headersJson` — object

```json
{ "Accept": "application/json",
  "X-Token": "abc",
  "Set-Thing": ["a", "b"] }          /* array = repeated header lines */
```

Rules:

- Header names/values must not contain CR/LF. If any do → error envelope
  with `error.code = "invalid-header"` (do **not** sanitize; reject).
- `Host` and `Content-Length` are computed by the DLL; caller-supplied
  values are ignored.
- `User-Agent`: the **wrapper resolves precedence before calling** (api-spec
  §6.2). The DLL therefore receives at most one source of truth and needs
  **no de-duplication logic**:
  - a `User-Agent` key present in `headersJson` → send it verbatim; in this
    case `optsJson.userAgent` is JSON `null`.
  - no `User-Agent` in `headersJson` → send `optsJson.userAgent` when it is a
    non-empty string; send **no** `User-Agent` header when it is `null` or
    `""`.
  - The DLL must **not** substitute a default of its own and must not add
    WinHTTP's built-in agent string when both sources are absent/empty.
  - **Errata R-G5-E1 (binding clarification, no contract change).** The
    no-substitution rule covers the **session agent** as well as the header
    block. `WinHttpOpen(pwszAgentW, ...)` sets a session-wide `User-Agent`
    that WinHTTP adds to every request on that session, so passing
    `L"eshttp/1.0.0"` as a fallback agent when `optsJson.userAgent` is
    `null` puts a `User-Agent` back on the wire even though the header
    builder correctly emitted none. When `optsJson.userAgent` is `null`,
    the DLL must open the session such that **no** `User-Agent` reaches the
    wire (`WinHttpOpen(NULL, ...)` is valid and sends none). Verification is
    a wire capture in the selftest, not an envelope assertion — the envelope
    cannot show what WinHTTP appended.

### 3.2 `body`

- Raw UTF-8 byte string, or `""`. If `opts.bodyIsBase64 === true`, the body
  is base64 and is decoded by the DLL before sending.
- `Content-Length` computed from the (decoded) length.

### 3.3 `optsJson` — object

```json
{ "timeoutMs": 30000,
  "redirect": "follow",              /* "follow" | "manual" */
  "maxRedirects": 5,
  "verifyTls": true,
  "userAgent": "eshttp/1.0.0",       /* string | null — null means a
                                        User-Agent header already won in
                                        headersJson, or the caller suppressed
                                        it; the DLL adds no default (§3.1) */
  "username": null,                  /* -> Authorization: Basic (preemptive) */
  "password": null,
  "proxy": null,                     /* "http://host:port" | "host:port" |
                                        "direct" | null(see §3.3 proxy rules) */
  "decompress": true,                /* Accept-Encoding: gzip + auto-decompress */
  "maxBodyBytes": 52428800,          /* 50 MiB cap on response body */
  "bodyIsBase64": false
}
```

Unknown keys ignored. Invalid types → error envelope
`error.code = "invalid-args"`.

Semantics:

- `timeoutMs`: applied to resolve/connect/send/receive. `0` = no timeout
  (discouraged; allowed).
- `redirect`: `"follow"` → handle 301/302/303 (→ GET, drop body) and
  307/308 (preserve method+body), up to `maxRedirects`; drop `Authorization`
  when the redirect target host differs. `"manual"` → return the 3xx
  response as-is (no follow).
- `verifyTls`: `false` disables certificate validation (documented warning
  only; the DLL may log to stderr — never to the caller).
- `decompress`: `true` sets `WINHTTP_OPTION_DECOMPRESSION` (flag ALL) when
  available; if `WinHttpSetOption` fails (pre-Win10-1903), the DLL silently
  falls back to identity (sends NO `Accept-Encoding`) and reports
  `meta.encodingWasApplied: false`. No manual gzip inflate in C for v1
  (documented in BUILD.md). `encodingWasApplied` = `true` only when the
  DECOMPRESSION option was successfully applied to the request.
- `maxBodyBytes`: if the (decompressed) body exceeds this, abort with
  `error.code = "body-too-large"` and `detail.bytes` = bytes seen so far.
- `proxy`: uses the given proxy for this request. Accepted values (v1, per
  native-dev ruling): `null` (default) → system proxy
  (`WINHTTP_ACCESS_TYPE_DEFAULT_PROXY`); `"direct"` → no proxy
  (`WINHTTP_ACCESS_TYPE_NO_PROXY`); `"host:port"` (scheme-stripped) →
  named proxy (`WINHTTP_ACCESS_TYPE_NAMED_PROXY`, http assumed);
  `"http://host:port"` → named proxy with scheme. Additive key:
  `"direct"` is an escape hatch, not a change to the `null` default.

---

## 4. Response envelope (the return value of `eshttp_request`)

Always valid JSON, UTF-8. **One envelope for both success and failure** —
the `ok` field tells them apart.

```json
{
  "abi": "http-v1",                /* REQUIRED: envelope contract marker.
                                      Wrapper refuses envelopes with a
                                      different abi (DLL mismatch) and
                                      degrades to socket. */
  "ok": true,
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": "application/json", "x-n": "7" },
  "body": "...",                   /* decoded string (§4.1) */
  "bodyEncoding": "utf8",          /* "utf8" | "base64" */
  "error": null,                   /* object|null — see §5 */
  "meta": {
    "path": "native",
    "method": "GET",
    "finalUrl": "https://...",
    "redirects": 0,
    "timeMs": 123,
    "bytes": 456,                  /* decoded body byte length */
    "httpVersion": "1.1",
    "tlsVersion": "1.2",           /* null on plain http */
    "encodingWasApplied": false,
    "nativeVersion": "1.0.0",
    "winhttpError": null,          /* raw WinHTTP/GetLastError code on transport error */
    "backend": "winhttp"           /* ADDITIVE (v1): "winhttp" | "wininet".
                                      Wrapper/core/qa parsers MUST tolerate
                                      unknown meta keys (forward compatible). */
  }
}
```

### 4.1 `body` / `bodyEncoding` rule (binary safety)

- The DLL sniffs the response `Content-Type`. If it is text-ish
  (`text/*`, `application/json`, `application/xml`, `application/javascript`,
  `application/x-www-form-urlencoded`, `application/xhtml+xml`, `application/atom+xml`)
  → decode bytes as UTF-8 (invalid sequences replaced with U+FFFD) and set
  `bodyEncoding: "utf8"`.
- Otherwise (binary: images, octet-stream, pdf, zip, ...) → base64-encode
  the raw bytes and set `bodyEncoding: "base64"`.
- Guard: even with a text Content-Type, if the body contains NUL bytes,
  switch to `"base64"` (NUL cannot round-trip through the JS string from the
  envelope reliably — actually JSON escapes `\u0000` fine, but binary is
  still safer as base64; NUL check is a cheap correctness net).
- Empty body → `"body": ""`, `"bodyEncoding": "utf8"`.

The ES3 wrapper (core-dev) then builds `result.body`:
- `bodyEncoding "utf8"` → `body` as-is; `bodyText` = same.
- `bodyEncoding "base64"` → `body` = base64-decoded raw binary string;
  `bodyText` = the base64 string (display-safe).

### 4.2 `headers` object

- Keys lowercased; repeated headers joined `", "` (`Set-Cookie` → `"; "`).
- May be `{}` on error envelopes.

### 4.3 Error-shaped envelope (transport failure)

```json
{ "abi": "http-v1",
  "ok": false,
  "status": 0,
  "statusText": "",
  "headers": {},
  "body": "",
  "bodyEncoding": "utf8",
  "error": { "code": "timeout", "message": "..." , "category": "timeout",
             "retryable": true },
  "meta": { "path": "native", "method": "GET", "finalUrl": "https://...",
            "redirects": 0, "timeMs": 5000, "bytes": 0,
            "httpVersion": null, "tlsVersion": null,
            "encodingWasApplied": false, "nativeVersion": "1.0.0",
            "winhttpError": 12002 } }
```

HTTP 4xx/5xx responses are **NOT** error envelopes — they are normal
envelopes with `ok:false`-equivalent? No: **4xx/5xx → `ok:false` is NOT
used.** Rule:

- A response was received (any status code) → `"ok": true` in the envelope
  sense, `status` = the real status (200/404/500/...), `error: null`.
  The JS layer computes `result.ok` from status 2xx.
- No response (transport/TLS/timeout) → `"ok": false`, `status: 0`,
  `error: {code, ...}`.

This keeps the envelope simple: **`error != null` ⟺ no HTTP response**.

### 4.4 Allocations & lifetime (v2 — HOST-owned, no eshttp_free)

**The v1 "caller MUST free with `eshttp_free()`" contract is GONE — it was a
double-free design flaw.** Under the canonical ExternalObject direct-interface,
every `kTypeString` the DLL returns is **host-owned**: ExtendScript's proxy
copies the C string to JS at call return AND the host frees the original
buffer through `ESFreeMem`. A separate `eshttp_free()` call would double-free
(or, through the JS string copy, free a pointer that was never the original).
There is no `eshttp_free` export in v2.

Rules (binding):

- **Every `kTypeString` result is a fresh `malloc`'d buffer**: the
  `eshttp_request` envelope, `eshttp_version()`'s copy of the version string,
  `eshttp_last_error()`'s copy of the error message, and the `ESInitialize`
  signature string. **Never return a static buffer** (v1 returned static
  `ESHTTP_VERSION`/last-error — v2 MUST return malloc'd copies, because the
  host will `ESFreeMem` them).
- **`ESFreeMem` = `free`** and must match the DLL's allocator (plain `malloc`;
  v2 drops v1's slot_register/slot_release machinery).
- The wrapper **must NOT call any free** after reading a returned string —
  the host handles it. (`accel.eshttp_free(...)` must not appear anywhere in
  the wrapper or the harness stub; the QA regression gate asserts it is never
  called post-request.)
- **Catastrophic failure:** `eshttp_request` returns `kTypeUndefined` (tag 0)
  in `*retval` only on out-of-memory for the envelope or uninitialized
  backend. In that case the wrapper calls `eshttp_last_error(0)` for a
  message and builds an `"internal"` error (never-throws contract).

---

## 5. Error codes emitted by the DLL

`error.code` values (strings) — the wrapper maps these to the public
taxonomy in `api-spec.md §7` (1:1, same names):

| code | condition |
|------|-----------|
| `"bad-url"` | URL unparseable / unsupported scheme (not http/https) |
| `"invalid-args"` | optsJson/headersJson malformed or wrong types |
| `"invalid-header"` | CR/LF or malformed header name/value |
| `"dns"` | resolution failed (WinHTTP 12007) |
| `"connect"` | connect refused/failed (12029, 12061...) |
| `"network"` | connection reset/lost mid-transfer (12030, 12031...) |
| `"tls"` | TLS handshake / certificate failure (12044, 12175...) |
| `"timeout"` | any WinHTTP timeout fired |
| `"aborted"` | caller-requested abort (v1: not exposed; reserved) |
| `"too-many-redirects"` | maxRedirects exceeded |
| `"body-too-large"` | maxBodyBytes exceeded |
| `"unsupported"` | feature unsupported by backend (e.g. unknown scheme) |
| `"internal"` | anything else (WinHTTP API misuse, unexpected state) |

Each error object includes `message` (human, English), `category`
(`usage|transport|tls|timeout|abort|protocol|internal`), `retryable`
(bool), and the raw code is placed in `meta.winhttpError`. Never include
credentials or full request bodies in `message`.

---

## 6. UTF-8 & Windows encoding notes

- All strings in and out are **UTF-8**. Inside the DLL, convert to UTF-16
  (`MultiByteToWideChar`) for WinHTTP wide APIs and back
  (`WideCharToMultiByte`) for the response. Do **not** use the ANSI codepage
  anywhere.
- Response bodies are bytes → base64 or UTF-8 as per §4.1. HTTP headers come
  back as UTF-8/ASCII; decode as UTF-8 (fallback: Latin-1) into the headers
  JSON.
- The ES proxy converts JS (UCS-2) strings to UTF-8 when calling C
  functions taking `char*`; non-ASCII request data (URLs, headers, bodies)
  must be UTF-8-safe end to end. core-dev must include a non-ASCII
  round-trip test in the suite (qa).

---

## 7. Installation & loading (`new ExternalObject("lib:eshttp")`)

For `lib:eshttp` to resolve, `eshttp.dll` must be findable on the host's
ExternalObject library search path. Documented resolution order (host-
dependent; test on each target):

1. **The script's own folder** — `Folder.script` / next to the `.jsx` file
   (most reliable for script-distributed installs).
2. **The host application's install folder** — e.g.
   `C:\Program Files\Adobe\Adobe Illustrator 2025\Support Files\` (the
   folder containing the app executable).
3. **The host's `Plug-ins` folder** (and `Plug-ins\Required`).
4. Windows system PATH (usually unnecessary; not recommended).

For distribution (docs/README):

- Provide **both x86 and x64 builds** (`eshttp-x86.dll`/`eshttp-x64.dll`
  staged as `eshttp.dll` at install time, or ship side-by-side and let the
  wrapper try the matching one). The bitness must match the host process:
  modern CC apps are 64-bit; older CS apps may be 32-bit. A bitness-mismatch
  load fails gracefully (ExternalObject ctor throws → wrapper falls back to
  socket).
- macOS: `lib:` resolves .framework bundles; **no v2 accelerator** — document
  that HTTPS is unavailable on macOS (socket fallback only).
- The wrapper must handle the load failure path:
  `try { accel = new ExternalObject("lib:eshttp"); } catch (e) { accel = null; }`
  and verify `typeof accel.eshttp_version === "function"` before using it.
- **Dev-iteration naming (T6/T8a):** the v2 DLL is built as `eshttp2.dll`
  (x86+x64) during iteration because the previously-loaded `eshttp.dll` is
  locked by the running host (Windows file lock). The wrapper keeps
  `lib:eshttp` — that is the **public contract specifier**. For the final
  release, `eshttp2.dll` is staged to `eshttp.dll` (root + native/) after a
  user-approved host restart, so `lib:eshttp` resolves the v2 build.

### 7.1 Health check on load (wrapper contract)

```js
var ok = false;
try {
  accel = new ExternalObject("lib:eshttp");
  var v = accel.eshttp_version(0);             // liveness probe — DUMMY 0 arg
  ok = (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v));
} catch (e) { ok = false; accel = null; }
```

If the probe fails, the wrapper **must not** call `eshttp_request` — it
degrades to socket (or "unsupported"). Additionally, if a response envelope
returns `abi !== "http-v1"`, the wrapper must treat the DLL as incompatible:
mark dead, `eshttp.resetTransport()` equivalent, and degrade to socket.
(`ExternalObject.version` should read 1 (ESGetVersion); the wrapper does not
rely on it.)

---

## 8. Example call (for native-dev's self-test and core-dev's adapter)

C side produces, for
`eshttp_request("GET", "https://example.com/", "{}", "", '{"timeoutMs":5000}')`:

```json
{"abi":"http-v1","ok":true,"status":200,"statusText":"OK",
 "headers":{"content-type":"text/html; charset=UTF-8","content-length":"1256"},
 "body":"<!doctype html>...","bodyEncoding":"utf8",
 "error":null,
 "meta":{"path":"native","method":"GET","finalUrl":"https://example.com/",
         "redirects":0,"timeMs":87,"bytes":1256,"httpVersion":"1.1",
         "tlsVersion":"1.2","encodingWasApplied":false,
         "nativeVersion":"1.0.0","winhttpError":null}}
```

JS side (v2 — NO free; dummy `0` on no-arg methods):

```js
var env = accel.eshttp_request("GET", url, headersJson, body, optsJson);
var result = eshttp.json.parse(String(env));   // host owns env; DO NOT free
// map result -> eshttp Result (api-spec §3)
```

---

## 9. Versioning

- `eshttp_version(0)` → `"1.0.0"` (semver-ish, no "v" prefix).
- `ESGetVersion()` → `1` (v2; v1 had no ESGetVersion, so the version property
  read 0). Exposed as `ExternalObject.version`.
- Envelope `"abi": "http-v1"` must match the wrapper's expected contract
  (`eshttp.DEFAULTS`/internal const). The envelope JSON schema is UNCHANGED
  between native-abi v1 and v2 — the ABI contract version lives in this
  document's contract name (`contracts/native-abi-v2`), not in the envelope
  marker. A future envelope-schema change bumps the marker to `http-v2` and
  requires a coordinated bump of both contracts.
- The wrapper exposes `meta.nativeVersion` and `eshttp.transportInfo().nativeVersion`
  so qa can verify DLL provenance in the field.

---

## 10. Ruled decisions (native-dev rulings — resolved, binding)

All questions below were resolved; rulings are binding and now codified in the
relevant sections above.

**v1 rulings (2026-08-09, still binding — unchanged by v2):**

1. **WinHTTP vs WinINet** — RULED: WinHTTP, no objection. Sessions are
   **per-request** (`WinHttpOpen`/`Close` per call) to avoid DllMain/detach
   lifetime hazards in long-lived Adobe hosts; `eshttp_available()` =
   `WinHttpOpen` probe. Declared via additive `meta.backend: "winhttp"`.
2. **`decompress` default true** — RULED: use `WINHTTP_OPTION_DECOMPRESSION`
   (flag ALL) when settable; on failure (pre-Win10-1903) silently fall back
   to identity (no `Accept-Encoding`), `encodingWasApplied=false`. **No**
   manual gzip inflate in C for v1 (documented in BUILD.md).
3. **32-bit + 64-bit dual build** — RULED: one MSVC layout, two `cl`
   invocations (vcvars32/vcvars64) → `eshttp-x86.dll` / `eshttp-x64.dll`,
   both `/MT` static CRT. NOTE: the build machine has no compiler — espark
   delivers complete compilable source + header + selftest harness +
   BUILD.md; the binary is built on the user's machine. No fake DLL.
4. **Proxy default** — RULED: `null` → system proxy
   (`WINHTTP_ACCESS_TYPE_DEFAULT_PROXY`); additive `"direct"` →
   `NO_PROXY`; scheme-stripped `"host:port"` → named proxy.
5. **`verifyTls:false`** — RULED: documented only, no warning channel
   (matches api-spec "native path only").

Additional native-dev implementation notes (binding): redirects handled
MANUALLY in the DLL (`WINHTTP_OPTION_REDIRECT_POLICY_NEVER` + own loop) so
301/302/303→GET+drop-body, 307/308 preserve, `Authorization` dropped on
cross-host, `maxRedirects` default 5, `meta.redirects` counted; relative
`Location` resolved in C; URLs sanitized (userinfo stripped) before
appearing in messages/meta — credentials never leak; caller `Host`/
`Content-Length` ignored, WinHTTP computes; text/binary sniffing + NUL
guard per §4.1.

**v2 rulings (2026-08-10, native-renamer pin + coordinator ratification —
binding, breaking change from v1):**

1. **Canonical ExternalObject direct-interface** — RULED: the DLL implements
   the 4 `ES*` exports + business methods (this is the live-verified same-machine
   reference pattern from ESON's `eson_json.c` on Illustrator 30.6.0). The v1
   bare `__declspec(dllexport)` function-library shape is abandoned.
2. **Host-owned kTypeString / no eshttp_free** — RULED: all returned strings
   are `malloc`'d and host-freed via `ESFreeMem` (= `free`). `eshttp_free` is
   REMOVED; v1's caller-frees contract was a double-free design flaw (the host
   frees the original `kTypeString` through ESFreeMem; a wrapper call could not
   even address the original pointer through the JS string copy). No
   slot_register/slot_release machinery in v2.
3. **`_f` dummy-arg convention** — RULED: no-arg methods are declared with a
   dummy `_f` in the signature string (`eshttp_last_error_f,eshttp_version_f,
   eshttp_available_f`) per the skill's reliability note + ESON precedent; the
   wrapper MUST call them with a dummy `0`.
4. **Lazy WinHTTP init preserved** — RULED: ESInitialize does NOT touch
   WinHTTP; the session cache stays lazy (first request / `eshttp_available`
   probe). `ESTerminate` releases the session cache. `ESGetVersion` = 1.
5. **Return codes** — RULED: business exports return `kESErrOK` (0) on
   success, `kESErrBadArgumentList` (20, catchable) on bad args, **never
   negative** (negative `kESErr*` are fatal/uncatchable host-bypass crashes).
6. **Filename/load** — RULED: dev iteration builds `eshttp2.dll` (x86+x64)
   because the loaded `eshttp.dll` is file-locked by the host; final release
   stages `eshttp2.dll` → `eshttp.dll` after a user-approved restart. The
   wrapper's `lib:eshttp` specifier is the public contract and does not change.
