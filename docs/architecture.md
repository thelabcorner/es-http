# eshttp — Architecture

Status: **v1 (draft-for-review)** · Owner: architect (t-spec) · Updated: 2026-08-09

## 1. Mission

`eshttp` is a pure-ES3 (ExtendScript ES3) HTTP client for Adobe hosts
(Illustrator, InDesign, Photoshop, InCopy, Premiere, After Effects, Bridge,
InDesign Server). It behaves like axios/curl:

- `GET / POST / PUT / DELETE` (and any other method string), with headers,
  query params, JSON or raw bodies, redirect following, and timeouts.
- Returns a structured result object, never throws (unless explicitly asked).
- Runs identically whether or not a native accelerator is installed.

It ships in two layers that expose **one identical API**:

1. **Native fast path** — `eshttp.dll`, a small C DLL loaded via
   `new ExternalObject("lib:eshttp")`, using **WinHTTP** (TLS, redirects,
   timeouts, proxy, compression). Used when present and healthy.
2. **Pure-ES3 fallback** — the ExtendScript `Socket` object: cleartext
   HTTP/1.1 only, no TLS. Used when the DLL is missing or unloadable.
3. **Graceful error** — when neither transport is possible, every call
   returns a structured error result (`error.code === "unsupported"`), it
   never throws and never silently hangs.

The two transports must be indistinguishable from the caller's point of view
except via `result.meta.path` and documented capability limits
(HTTPS availability, timeout enforcement).

## 2. Non-goals

- No async/Promise surface in v1. ExtendScript is single-threaded; calls
  block. (See §7 for the async note.)
- No cookie jar, no session state, no streaming responses in v1.
  A "max body bytes" cap protects memory instead.
- No multipart/form-data file uploads in v1 (binary request bodies are
  supported via base64, see `native-abi.md`).
- No proxy auto-detection config surface in v1 (opts.proxy passthrough only).
- No macOS native accelerator in v1 (WinHTTP is Windows). On macOS the
  Socket fallback (cleartext HTTP) still works; HTTPS returns a documented
  "unsupported" error. Future: a macOS .framework accelerator with the same
  ABI.

## 3. Project layout (canonical)

```
eshttp/
  docs/
    architecture.md     <- this file
    api-spec.md         <- PUBLIC API contract (contracts/http-api-v1)
    native-abi.md       <- eshttp.dll ABI contract (contracts/native-abi-v2)
    cli-transport.md    <- eshttp-cli.exe job-file IPC contract (cli-transport-v1)
  src/
    *.ts                <- TypeScript modules (18 files): drivers native/cli/socket,
                           adapters (vendor-json/vendor-b64), core, index (facade)
  native/
    eshttp.c            <- DLL + CLI shared engine (v2 direct-interface)
    eshttp.h            <- ABI header mirroring docs/native-abi.md
    eshttp-cli.c        <- separate-process transport (job-file IPC)
    BUILD.md            <- MSVC build + install instructions
  test/
    harness.js          <- headless ES3 test runner (qa)
    load-core.mjs       <- shared 3-source loader (esm/iife/jsxinc) + stubs
    mock-server.js      <- local cleartext test server (Node `http`)
    tcp-client.js       <- raw-TCP test helper (socket path)
    tests/*.js          <- ES3 test suite files (incl. 35-cli-transport)
  README.md
  LICENSE               <- MIT
```

`eshttp/` lives at the repository root next to the swarm tooling:
`<repo>/eshttp/`.

## 4. Design overview

```
            ┌─────────────────────────────────────────────┐
            │  eshttp.*  (single namespace on $.global)   │
            │  request/get/post/put/del · json · config   │
            └──────────────────────┬──────────────────────┘
                                   │ validate & normalize (URL, headers, opts)
                                   ▼
            ┌──── transport selector (auto / native / cli / socket) ────┐
            │   picked once at first call, cached; meta.path reported    │
            └───────┬──────────────────────┬─────────────────┬───────────┘
                    ▼                      ▼                 ▼
        ┌───────────────────┐   ┌────────────────────┐   ┌──────────────────┐
        │ NATIVE:           │   │ CLI: eshttp-cli.exe│   │ SOCKET: ES3      │
        │ ExternalObject    │   │ File.execute() +   │   │ Socket — cleartext│
        │ "lib:eshttp"      │   │ job-file IPC       │   │ HTTP/1.1         │
        │ HTTPS/TLS ✓       │   │ HTTPS/TLS ✓ (same  │   │ HTTPS ✗          │
        │ redirects ✓       │   │ engine, own process│   │ redirects: JS-   │
        │ timeouts ✓ proxy ✓│   │ = firewall-escape) │   │ manual; ~timeout │
        └─────────┬─────────┘   └─────────┬──────────┘   └────────┬─────────┘
                  └───────────┬──────────┴───────────┬─────────────┘
                              ▼
                result envelope → eshttp Result object
```

### 4.1 Transport selection rules (Tier order)

| Priority | Transport        | Selection test (tried in order)                       |
|----------|------------------|-------------------------------------------------------|
| 1        | native (eshttp)  | `typeof ExternalObject !== "undefined"` AND `new ExternalObject("lib:eshttp")` succeeds AND `eshttp_version(0)` returns a parseable version AND `eshttp_available(0)` returns 1. If the DLL loads but the envelope ABI mismatches (`abi !== "http-v1"`), mark dead and fall through. |
| 2        | cli (eshttp-cli) | `findCliExe()` resolves `eshttp-cli.exe` (runtime root `%LOCALAPPDATA%\eshttp\` → script sibling → `%TEMP%\opencode\`) AND `File.execute()` is available. Separate-process transport — **the https-capable fallback when native is dead or blocked by per-app firewall rules** (no firewall rule is ever modified; the child process image is not blocked). GET/HEAD-only in v1 CLI (body key pending hardening). Contract: `docs/cli-transport.md`. |
| 3        | socket (ES3)     | `typeof Socket !== "undefined"` (all Adobe hosts ship it). Cleartext `http://` only. |
| 4        | none             | Every call → `error.code = "unsupported"`, `error.category = "usage"`. |

Rules:

- Selection is lazy (first `eshttp.request()`), cached in a closure var,
  and re-tried on `eshttp.resetTransport()` / `eshttp.forceTransport("auto")`.
- `eshttp.forceTransport("native" | "socket" | "auto")` exists **for tests
  and diagnostics**. `"native"` while the DLL is missing does *not* crash:
  the call degrades to the socket path or returns "unsupported" (never throws).
- The native path handles **all** URLs including `https://`. The socket path
  rejects `https://` with `error.code = "unsupported"`,
  `error.category = "usage"` (message: "https requires the native eshttp.dll
  driver (Socket is cleartext only)").
  (Category per api-spec §7 — "unsupported" is always `usage`, never `tls`.)
- Non-`http(s)` schemes (`ftp://`, `wss://`, ...) are rejected at pre-call
  validation on both paths in v1 → `error.code = "bad-url"` (api-spec §2).
  They never reach a transport driver.

### 4.2 Internal module boundaries (core-dev)

Everything lives in one self-contained `eshttp.jsxinc` (no `#include` chains;
ExtendScript include resolution is fragile across hosts — the skill says keep
it one file).

| Module (internal) | Responsibility |
|-------------------|----------------|
| `_eshttp.json`    | ES3 JSON encode/decode (eson-style, no `JSON` global). Exposed publicly as `eshttp.json.parse/stringify`. |
| `_eshttp.url`     | URL parse (scheme/host/port/path/query), query-string builder/merger, percent-encoding helpers. |
| `_eshttp.headers` | Header object → case-normalized maps, join repeated values, CR/LF injection guard, `Content-Length` computation, and **User-Agent precedence** (an explicit caller header wins over `opts.userAgent`; resolved here, before either driver runs, so exactly one UA reaches the wire on both paths — api-spec §6.2). |
| `_eshttp.base64`  | base64 encode/decode (binary-safe strings) for binary request/response bodies over the ABI. |
| `_eshttp.result`  | Result envelope builder, error mapping (taxonomy in api-spec.md §7). |
| `_eshttp.transport` | Tier selector + per-transport drivers (`_nativeDriver`, `_socketDriver`) with identical internal interface `execute(req, cb-free sync return) -> rawEnvelope`. |
| `_eshttp.redirect`| JS-side redirect follow for the socket path (301/302/303 → GET; 307/308 preserve method+body; cap via opts.maxRedirects). |
| `_eshttp.core`    | `eshttp.request()` orchestration: validate → select → execute → map → return. |

Native driver contract (the seam core-dev codes against) is exactly the
ABI in `docs/native-abi.md`. Socket driver contract is in `api-spec.md` §10.

## 5. Namespace & global hygiene

- The **only** global is `eshttp` on `$.global` (i.e. `this` at script top
  level). All internals are closure-scoped inside an IIFE; nothing else
  leaks. No `$`-prefixed globals, no extension of built-in prototypes.
- `#targetengine "session"` is recommended by users so the loaded
  `ExternalObject` and the transport selector persist across runs; eshttp
  works without it (just re-probes, one extra `ExternalObject` ctor).
- `eshttp` exposes: `version`, `transport` (getter of active transport),
  `transportInfo()`, `request`, `get`, `post`, `put`, `del`, `json`,
  `configure`, `forceTransport`, `resetTransport`, `error` (taxonomy consts),
  `DEFAULTS`.

## 6. Host detection

`eshttp` detects the host once at first call and exposes it in
`eshttp.transportInfo().host`.

| Host | Detection |
|------|-----------|
| Illustrator | `typeof app !== "undefined" && app.name === "Adobe Illustrator"` (or `app instanceof Illustrator.Application`) |
| InDesign / Server | `app.name === "Adobe InDesign"` / `"Adobe InDesign Server"` |
| Photoshop | `app.name === "Adobe Photoshop"` |
| InCopy / Premiere / After Effects / Bridge | `app.name` string prefix match (e.g. `"Adobe Premiere"`, `"Adobe After Effects"`, `"Adobe Bridge"`) |
| Any | `app.name` contains `"Adobe"` → generic Adobe host |

- `#targetillustrator` / `#targetindesign` are compile-time pragmas, not
  runtime testable; runtime detection always goes through `app.name`
  (guarded: `typeof app !== "undefined"`).
- Platform: `$.os` — `"Windows"` prefix = Windows (native available);
  `"Macintosh"` prefix = macOS (native v1 not available; socket fallback).
- Script path helpers: `Folder.script` / `File($.fileName)` for DLL-adjacent
  install probing (native-abi.md §7) and for temp files (`Folder.temp`) when
  writing large bodies.

## 7. Concurrency & blocking model

- **v1 is strictly synchronous** — every `eshttp.request()` blocks the host
  UI thread until the response, error, or timeout. This matches the
  ExtendScript reality (no worker threads, no callbacks from C into JS).
- The DLL performs its work **on the calling thread** (no worker thread that
  outlives the call). Timeouts are enforced inside WinHTTP via
  `WINHTTP_OPTION_*_TIMEOUT` — not by abandoning a hung read.
- Async surface is explicitly out of scope for v1; if a future v2 adds
  async, it will be opt-in (`opts.async` with a `ScriptUI`-friendly callback)
  and the ABI will grow a `eshttp_request_async` pair — the current sync
  exports stay stable.

## 8. Security notes

- **Header injection:** headers and URL are validated; CR/LF anywhere in a
  header name/value or in the request line → `error.code = "invalid-header"`
  (usage category). Never interpolate unvalidated user input into headers.
- **TLS:** native path verifies certificates by default
  (`opts.verifyTls = true`). `verifyTls:false` is exposed for legacy/self-
  signed servers and must be documented loudly; the socket path is cleartext
  by nature — no TLS ever, so credentials over `http://` are a caller's risk.
- **Credentials:** `opts.username/password` → `Authorization: Basic` sent by
  the DLL; equivalent on the socket path requires the caller to set the
  header explicitly (documented limitation).
- **Memory:** all strings crossing the ABI are UTF-8; response bodies are
  capped by `opts.maxBodyBytes` (default 50 MiB) to protect the host.
- **Redirects:** `follow` mode never forwards `Authorization` to a different
  host (security default); users needing cross-host auth set the header per
  hop. Enforced by the DLL on the native path, by the JS redirector on the
  socket path.

## 9. Error flow (summary)

Full taxonomy: api-spec.md §7. Shape:

- Response received → `result.error === null`, `result.ok` = (2xx).
- No response (network/TLS/timeout/abort/usage) → `result.error` = object
  `{code, category, message, retryable, detail}`; `result.status === 0`,
  `result.ok === false`.
- Never throws except for programming errors (missing/invalid args where no
  meaningful result can be built — and even then, pre-validate first).

## 10. Performance expectations

- Native path: WinHTTP round-trip ≈ host-native cost; JSON envelope
  parse/serialize is the dominant JS cost. Avoid `bodyText` on multi-MB
  binary bodies.
- Socket path: fine for dev/test and small payloads; blocking reads, no
  reliable read timeout on many hosts (meta.timeoutEnforced=false), no TLS.

## 11. Testing hooks (for qa)

- `eshttp.forceTransport("native"|"socket"|"auto")` — force a driver.
- `eshttp.resetTransport()` — drop cached selector + cached ExternalObject.
- `eshttp.transportInfo()` — `{host, platform, transport,
  externalObjectAvailable, socketAvailable, nativeVersion, abi}` (all 7 keys,
  api-spec §9).
- `result.meta.encodingWasApplied` / `result.meta.backend` — native-only
  passthroughs that let qa observe whether gzip decompression was actually
  applied (vs. silently degraded to identity) and which backend the DLL used.
- `eshttp.DEFAULTS` — inspect/reset defaults (mutate with `eshttp.configure`).
- A local cleartext `test/mock-server.js` (plain Node `http` server script)
  lets the socket path and the native path (against `http://` URLs) be tested
  end-to-end in CI without Adobe host; a smoke runner for real hosts is
  included under `test/` (`harness.js` + `tests/*.js`).

## 12. Versioning & stability policy

- Public API contract version: `http-api-v1` (blackboard `contracts/http-api-v1`).
- Native ABI contract version: `native-abi-v2` (blackboard `contracts/native-abi-v2`);
  the envelope `"abi"` marker stays `"http-v1"` (JSON schema unchanged — the ABI
  contract version lives in the contract name, not the envelope).
- CLI transport contract version: `cli-transport-v1` (blackboard `contracts/cli-transport-v1`,
  docs/cli-transport.md).
- ABI/API breaking changes bump the contract name (`http-api-v2`, ...);
  eshttp.version and eshttp ABI `"abi"` marker must match the contract the
  wrapper expects. The wrapper refuses a DLL whose envelope reports a
  different `abi` and degrades to the next tier (cli → socket).
