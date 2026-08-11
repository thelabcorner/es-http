<div align="center">

# ES-HTTP: HTTP client for Adobe ExtendScript (ES3)

## ExtendScript HTTP = E.S.HTTP

### Drop-in `eshttp.request/get/post/put/del/json` — one identical API over the cli pipe transport (default, firewall-escape), an opt-in native WinHTTP lane, and the ES3 Socket fallback, for Illustrator, InDesign, Photoshop & any ExtendScript host

[![Contract: http-api-v1 exact](https://img.shields.io/badge/contract-http--api--v1%20exact-success)](docs/api-spec.md)
[![Parity: ESON + ESB64](https://img.shields.io/badge/parity-ESON%20%2B%20ESB64%20104k%2B%20checks-purple)](#validation)
[![Live: Wikipedia W fetch](https://img.shields.io/badge/live-Wikipedia%20W%20fetch%20PASS-green)](#validation)
[![Adobe: Creative Suite](https://img.shields.io/badge/Adobe%20-Creative%20Suite-red?logo=adobe&logoColor=white)](https://extendscript.docsforadobe.dev/)
[![Engine](https://img.shields.io/badge/ExtendScript-ES3-green)](#compatibility)
[![Size](https://img.shields.io/badge/runtime-339%20KB-orange)](#which-build-should-i-use)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL%203.0--or--later-blue)](https://www.gnu.org/licenses/gpl-3.0.html)

</div>

---

## Part Of The Same Toolkit

> Production-grade ExtendScript infrastructure for Illustrator-era JavaScript engines.

<table>
<tr>
<td width="50%" valign="top">

### Runtime Primitives

**[ESON](https://github.com/thelabcorner/eson)**  
Strict RFC 8259 JSON for ExtendScript.

**[ESB64](https://github.com/thelabcorner/es-b64)**  
Base64 and UTF-8 utilities.

**[ESARR](https://github.com/thelabcorner/es-arr)**  
ES5+ Array compatibility methods.

**[ESSTR](https://github.com/thelabcorner/es-str)**  
String whitespace and trim methods.

**[ESCHARS](https://github.com/thelabcorner/es-chars)**  
Native bulk byte operations.

</td>
<td width="50%" valign="top">

### Build & Integration Tools

**[ESHTTP](https://github.com/thelabcorner/es-http)**  
HTTP transport for ExtendScript automation.

**[ESPACK](https://github.com/thelabcorner/espack)**  
Self-extracting ExternalObject bundles.

**[ESMIN](https://github.com/thelabcorner/es-min)**  
Minification for shipped JSX bundles.

**ESOBF** <sub>coming soon</sub>  
Obfuscation for hardened JSX distribution.

</td>
</tr>
</table>

Also from the same team: **[ArcFit.dev](https://arcfit.dev)**, deterministic arc warp for Illustrator.

---

## Table of Contents

- [Why es-http?](#why-es-http)
- [Features](#features)
- [Which build should I use?](#which-build-should-i-use)
- [Get the Release](#get-the-release)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API](#api)
- [Alternatives](#alternatives)
- [Validation](#validation)
- [Performance](#performance)
- [Security Model](#security-model)
- [Compatibility](#compatibility)
- [Engine quirks that shaped the design](#engine-quirks-that-shaped-the-design)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Credits](#credits)
- [License](#license)

---

## Why es-http?

ExtendScript ships a raw `Socket` object that is **cleartext TCP only** — no
TLS, no HTTP parsing, no timeouts that can be trusted, and no way to reach
`https://` from a script. Measured on Illustrator 30.6.0 / ExtendScript
4.5.6: `Socket` reads block with no reliable timeout on many hosts
(`meta.timeoutEnforced=false`), and there is no `fetch`, no `XHR`, and no
native `JSON` global to lean on.

**The state of ExtendScript HTTP before es-http.** For years the only real
option was
[buraktamturk/adobe-javascript-http-client](https://github.com/buraktamturk/adobe-javascript-http-client)
— a client built directly on raw `Socket`. Its author documents the
limitations plainly
([issue #1](https://github.com/buraktamturk/buraktamturk-web/issues/1)):
SSL/TLS is not supported ("Adobe's Socket class does not provide SSL
support"), the library is not async, it speaks HTTP/1.0 only (no chunked
responses), and there is no Keep-Alive — every call opens a new TCP
connection. The practical consequence: **HTTPS from ExtendScript was
effectively impossible.** Raw `Socket` shares every one of those limits and
adds no HTTP parsing of its own.

Thanks to **Burak Tamtürk** for showing the way with the first ExtendScript
HTTP client — es-http stands on the shoulders of that earlier work and the
community conversation it started.

es-http exists to close that void. The **native and pipe lanes** bring real
HTTPS (TLS 1.2+ via WinHTTP), HTTP/1.1, keep-alive (a warm pipe worker —
measured 0.064 ms vs 2.819 ms for the one-shot spawn path, ~44x), plus
timeouts, redirects, proxy, and gzip — while the **socket lane** remains the
honest cleartext fallback for hosts with no binaries. For the detailed
comparison, see [Alternatives](#alternatives).

`es-http` fills the gap with one API over three transports that degrade
automatically:

1. **cli (default)** — a separate-process transport that **escapes per-app
   firewall rules** that block `Illustrator.exe` outbound. The primary lane
   is a **named-pipe IPC worker** (`eshttp-cli.exe --worker`, persistent
   process, warm WinHTTP session/connection pool) driven by the pure
   pipe-client `eshttp-ipc.dll`; the degradation lane is a one-shot job-file
   EXE (`meta.path: "cli-oneshot"`). No firewall rule is ever modified, and
   the named pipe is local kernel IPC (not network traffic) — see
   [The firewall-escape transport (cli)](#the-firewall-escape-transport-cli).
   **This is the default transport** in v1.0.1.
2. **native (opt-in)** — `eshttp.dll`, a C11 DLL loaded via
   `new ExternalObject("lib:eshttp")`, backed by WinHTTP: HTTPS/TLS 1.2+,
   real per-phase timeouts, redirects, proxy, gzip. An **in-process
   accelerator** for non-firewalled hosts; ships as a separate standalone
   build (`eshttp-native-accel.jsx` or plain DLL release assets), NOT inside
   the default accel. Opt in with `forceTransport("native")` or by staging
   the native build so auto-selection can reach it.
3. **socket** — the pure-ES3 `Socket` object: cleartext HTTP/1.1, used when
   neither native artifact is present.

If no transport is possible, every call returns a structured
`error.code === "unsupported"` Result. **es-http never throws** for I/O or
validation failures — the contract (`contracts/http-api-v1`) guarantees a
Result object on every path.

---

## Features

- **One API, three transports** — `request/get/post/put/del/json` behave
  identically on native, cli, and socket; the only visible differences are
  `result.meta.path` and the documented capability limits. Tier selection is
  lazy, cached, and re-probed on `resetTransport()`.
- **14-code error taxonomy** — `invalid-args`, `bad-url`, `invalid-header`,
  `unsupported`, `dns`, `connect`, `network`, `tls`, `timeout`, `aborted`,
  `too-many-redirects`, `body-too-large`, `invalid-json`, `internal`, each
  with category + retryable flag (`docs/api-spec.md` §7).
- **Never-throws Result contract** — 736/0 adversarial never-throw audit
  checks (`test/parity/never-throw-audit.mjs`); every malformed input
  returns a Result, including hostile getters on `opts`.
- **User-Agent precedence** — exactly one `User-Agent` reaches the wire on
  every transport: an explicit header always wins; `userAgent: ""`
  suppresses it entirely (binding rule, `docs/api-spec.md` §6.2).
- **ESON + ESB64 DLL-accelerated codecs** — `eshttp.json` (RFC 8259 strict
  parse, never-throws face) and base64/UTF-8 delegate to the vendored
  sibling accel bundles, with internal ES3-lane fallback; parity-pinned at
  753/0 (JSON, D1–D7 contracted) + 103,711/0 (base64/UTF-8) differential
  checks. See [Vendored codecs](#vendored-codecs-json--base64--utf-8).
- **Native ABI v2** — canonical Adobe ExternalObject direct-interface
  (`ESInitialize`/`ESGetVersion`/`ESFreeMem`/`ESTerminate` + 4 business
  methods), host-owned strings freed via `ESFreeMem` (the old
  caller-frees `eshttp_free` was a double-free flaw and is removed;
  `docs/native-abi.md`).
- **Firewall-escape cli transport** — when the host process is blocked by a
  per-app outbound rule, `eshttp-cli.exe` (same v2 engine, own process
  image) fetches through the firewall; verified live: Wikipedia's W SVG,
  status 200, 2440 bytes, fetched with all firewall rules enabled and none
  modified (`docs/cli-transport.md`).
- **Verified end-to-end** — 204/0 tests in both the ESM and IIFE lanes,
  native selftest 166/0, and a live Illustrator 30.6.0 gate that fetched
  the W SVG and placed it into a document as paths (pageDelta 1).

---

## Which build should I use?

**Pick by scenario — the table answers "which one do I eval?" for every
case.** All bundles expose the same full `eshttp.*` API; they differ in
which binaries they stage and which transport becomes default.

**The cli/pipe build is the recommended default** for the widest audience:
one artifact works on both firewalled and non-firewalled hosts, it is the
v1.0.1 default transport, and its architecture is the more robust one —
the worker is a separate process with hard deadlines and process isolation
(a hung request cannot wedge the host UI thread), it escapes per-app
firewall rules by construction (kernel IPC, not network traffic), and it
injects no in-process network code to trip host security/AV heuristics on
hardened hosts. The in-process DLL stays the documented opt-in for the
narrow case that specifically wants it.

| Scenario | Recommended artifact | Why |
|---|---|---|
| **Any host — RECOMMENDED (the common case)** | **`eshttp.accel-x64.jsx` (or `eshttp.accel-x86.jsx` for 32-bit hosts)** | Pipe is the v1.0.1 default; the worker's separate process image escapes per-app firewall rules (works firewalled AND not), has hard deadlines + process isolation, and no in-process network code. Measured at wrapper parity with the DLL (0.071–0.078 vs 0.084–0.141 ms, T25) |
| Firewalled host specifically (Illustrator.exe egress blocked) | `eshttp.accel-x64.jsx` (or x86) | The cli worker's separate process image escapes the per-app firewall rule; the in-process DLL lane cannot work here |
| Non-firewalled host, want the in-process native lane | `eshttp.accel-x64.jsx` + `eshttp-native-accel.jsx` (narrow opt-in) | Pipe-primary default; native via `forceTransport("native")` when the separate DLL is staged — the narrow case that wants in-process WinHTTP |
| Just the library, no binaries (macOS, or script-only) | `dist/eshttp.jsx` (or `#include eshttp.jsxinc`) | Socket lane for cleartext `http://`; `https://` returns `"unsupported"` without binaries |
| Node-side harnesses / tests | `dist/eshttp-core.esm.mjs` | ESM core import |
| Build your own binaries from source | `native/` + `native/BUILD.md` (MSVC, x64+x86) | Full control |

**Rule of thumb:** eval the per-bitness pipe accel matching your host
(`eshttp.accel-x64.jsx` on 64-bit, `eshttp.accel-x86.jsx` on 32-bit) and you
get the recommended default: cli pipe transport — https, firewall-escape,
warm worker, process-isolated. Add `eshttp-native-accel.jsx` only for the
narrow in-process-DLL case. The plain `dist/eshttp.jsx` alone gives you
socket-only.

**Artifact inventory (v1.1.0, per-bitness — no dead payloads):**

| Artifact | Contents | Size |
|---|---|---|
| `dist/eshttp.jsx` | library IIFE only (codec accel payloads embedded) | 339 KB |
| `dist/eshttp.accel-x64.jsx` | merged 1+n bundle: ESONJson + cli x64 worker + ipc-x64 bridge, one shared ESB64Native accel (deduped), ESON/ESB64 facades | 927 KB |
| `dist/eshttp.accel-x86.jsx` | merged 1+n bundle: ESONJson + cli x86 worker + ipc-x86 bridge, one shared ESB64Native accel (deduped), ESON/ESB64 facades | 873 KB |
| `dist/eshttp-native-accel.jsx` | eshttp-x64.dll (in-process WinHTTP lane, opt-in) | 614 KB |
| `dist/eshttp-native-accel-x86.jsx` | eshttp-x86.dll (legacy 32-bit hosts, opt-in) | 576 KB |
| `dist/eshttp-core.esm.mjs` | ESM core (Node harnesses) | 330 KB |

**Merge-spec composition (v1.1.0).** The per-bitness accels are now **merged
1+n bundles** per the espack merge spec: ONE loader object (no nested
`var ESPAK`), ONE shared ESB64Native accelerator (deduped across the
merged ESON/ESB64/eshttp manifests), and flat payloads — ESONJson + the
worker + the bridge for the bundle's bitness only. The ESON and ESB64
facades are appended before the library evals, so the codec adapters consume
them by name (`sessionGlobal().ESON` / `.ESB64`) with the embedded-string
lazy-eval as fallback — identical public behavior, never-throws preserved.
The staging adapter extracts payloads **by name** (merged indexes are not
stable). The v1.0.1 direct-composition accels are superseded by this merge
(same filenames, new contents).

The binaries are release assets, not repo files (`.gitignore` excludes build
artifacts). Each accel is an espack self-extracting bundle: eval once,
and it stages its payloads byte-exact to `%LOCALAPPDATA%\eshttp\` (the
resolution root for the worker and the DLL) — no C toolchain, no manual
staging. The 4-payload `eshttp.accel.jsx` from v1.0.0 is retired.

---

## Get the Release

<div align="center">

**All production bundles ship as GitHub release assets — this repo holds
sources. Grab the runnable builds from the
[Releases page](https://github.com/thelabcorner/es-http/releases).**

</div>

**How it works, in three steps:**

1. Open the [Releases page](https://github.com/thelabcorner/es-http/releases).
2. Pick the **latest stable** tag.
3. Download the asset that matches your use case:

| You are... | Take this release | And this asset |
|---|---|---|
| Writing an Illustrator/InDesign/Photoshop script (any host) | latest stable | `dist/eshttp.jsx` (drop-in; default cli pipe lane works via the accel, socket fallback otherwise) |
| Default https + firewall-escape, x64 host | latest stable | `dist/eshttp.accel-x64.jsx` (eval once; stages worker + bridge) |
| Default https + firewall-escape, x86 host | latest stable | `dist/eshttp.accel-x86.jsx` (eval once; stages worker + bridge) |
| In-process WinHTTP lane (non-firewalled host, opt-in) | latest stable | `dist/eshttp-native-accel.jsx` or `eshttp-x64.dll` / `eshttp-x86.dll` |

No C toolchain is needed to consume any release asset — the DLLs and EXE are
prebuilt (MSVC, `/MT` static CRT). Sources + build instructions are in
`native/BUILD.md`.

---

## Installation

### 1. The script

Copy `dist/eshttp.jsx` into your script folder and include it:

```js
#include "eshttp.jsx"
```

or load it explicitly:

```js
$.evalFile(new File("~/scripts/eshttp.jsx"));   // or your own path
```

After either, one global exists: `eshttp`. (The include-compat copy
`src/eshttp.jsxinc` is generated from `dist/eshttp.jsx` and is byte-identical
to it — `#include "eshttp.jsxinc"` keeps working.)

> **`#targetengine "session"` — recommended.** Put `#targetengine "session"`
> at the top of your script so the loaded `ExternalObject` and the transport
> selector persist between runs. es-http works without it — it just
> re-probes, costing one extra `ExternalObject` constructor per run.

### 2. The cli pipe transport (default, `eshttp-cli.exe --worker` + `eshttp-ipc.dll`)

`es-http` resolves the worker in order: `%LOCALAPPDATA%\eshttp\` → next to
the running script → `%TEMP%\opencode\`. Stage the **per-bitness pipe accel**
(`dist/eshttp.accel-x64.jsx` for 64-bit hosts, `dist/eshttp.accel-x86.jsx`
for 32-bit) — eval once; it extracts the worker + bridge byte-exact to
`%LOCALAPPDATA%\eshttp\`. The cli pipe lane is the **default transport** in
v1.0.1: it works through per-app firewall rules (the named pipe is kernel
IPC, not network traffic) and needs no DLL staging (see
[Firewall escape](#the-firewall-escape-transport-cli)).

### 3. The native accelerator (`eshttp.dll`) — opt-in

The in-process WinHTTP lane is **opt-in** in v1.0.1. For
`new ExternalObject("lib:eshttp")` to succeed, `eshttp.dll` must be findable.
Resolution order (host-dependent — test on each target):

1. **The script's own folder** — next to your `.jsx` file.
2. **The host application's install folder** — e.g.
   `C:\Program Files\Adobe\Adobe Illustrator 2026\Support Files\`.
3. The host's `Plug-ins` folder (and `Plug-ins\Required`).
4. Windows system PATH (usually unnecessary; not recommended).

**Both bitnesses.** Ship `eshttp-x86.dll` and `eshttp-x64.dll` and stage the
matching one as `eshttp.dll` at install time. The DLL bitness must match the
host process: modern CC apps are 64-bit, older CS apps may be 32-bit. A
bitness mismatch makes the load fail cleanly (`ExternalObject` throws) and
es-http falls back to the next tier automatically.

es-http loads the DLL for you on first use via
`new ExternalObject("lib:eshttp")` — guarded in `try/catch`, so a missing,
wrong-bitness, or broken DLL **never throws**: it simply selects the next
transport. You never construct the `ExternalObject` yourself. Because native
is opt-in, auto-selection reaches it only when it is staged; you can also
force it explicitly with `forceTransport("native")`.

**Build instructions** live in [`native/BUILD.md`](native/BUILD.md)
(MSVC `cl /LD`, x86+x64, `/MT` static CRT). The repository ships the complete
C source + header + selftest; the binary is also attached to every
[release](#get-the-release), so building is optional for consumers.

**macOS.** There is **no native accelerator** (WinHTTP is Windows-only).
On macOS the cli pipe lane and Socket fallback still work for cleartext
`http://`; **HTTPS returns a documented `"unsupported"` error** (no
accelerator on macOS in v1).

### Verify the install

```js
$.writeln(eshttp.transportInfo().transport);   // "cli" | "cli-oneshot" | "native" | "socket" | "none"
```

`"cli"` means the pipe worker + bridge are active (the v1.0.1 default);
`"native"` means the opt-in DLL loaded and passed its health probe;
`"socket"` means the ES3 fallback is in use.

---

## Quick Start

```js
// GET — https works on native and cli transports
var res = eshttp.get("https://api.example.com/items", { query: { page: 2 } });
if (res.ok) {
    var items = eshttp.json.parse(res.body);   // ES3 has no JSON global
}

// POST — object body is auto-JSON with Content-Type: application/json
eshttp.post("https://api.example.com/items", { name: "x" }, { timeout: 5000 });

// POST — raw string body (you set Content-Type)
eshttp.post("https://api.example.com/x", "hello=1",
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

// DELETE (named `del` — ES3-reserved-word-safe)
eshttp.del("https://api.example.com/items/1");

// Never throws: check res.ok (2xx) or res.error
var r = eshttp.get("https://api.example.com/nope");
if (r.error) { $.writeln(r.error.code + " — " + r.error.message); }
```

---

## API

### `eshttp.request(opts)` — full surface

| Option | Type / default | Description |
|--------|----------------|-------------|
| `method` | string, `"GET"` | Case-insensitive; any HTTP token. |
| `url` | string, **required** | Absolute `http://` or `https://` URL. Unparseable/unsupported scheme → `"bad-url"` (no throw). |
| `query` | object | Merged into the URL query; `Array` values repeat as `k=v` pairs; UTF-8 percent-encoded. |
| `headers` | object | `{ "Accept": "application/json" }`; values string or array (repeated lines); CR/LF → `"invalid-header"`. |
| `body` | string \| object \| array | Object/array → JSON-stringified with `Content-Type: application/json` (unless set); string → sent raw (UTF-8). |
| `timeout` | number (ms), `30000` | Native/cli: enforced per-phase inside WinHTTP / by the engine + done-poll. Socket: best-effort wall-clock. `0` = no timeout. |
| `redirect` | `"follow"` \| `"manual"`, `"follow"` | Follow 3xx (native/cli: in the engine; socket: JS re-request). |
| `maxRedirects` | number, `5` | Hop cap (follow mode); exceeded → `"too-many-redirects"`. |
| `verifyTls` | boolean, `true` | Native/cli only. `false` disables certificate validation — see [Security](#security-model). |
| `username` / `password` | string | Native/cli → preemptive `Authorization: Basic`. Socket: set the header yourself. |
| `userAgent` | string, dynamic default | Sent on both paths only when you don't set a `User-Agent` header; `""` suppresses. Default is host-derived — see [User-Agent precedence](#user-agent-precedence). |
| `proxy` | string, `null` | Native/cli only. `null` = system proxy; `"direct"` = no proxy; `"host:port"` = named proxy. Ignored on socket. |
| `decompress` | boolean, `true` | Native/cli only. `Accept-Encoding: gzip` + auto-decompress (WinHTTP `WINHTTP_OPTION_DECOMPRESSION`); silently degrades to identity on pre-Win10-1903. |
| `maxBodyBytes` | number, `52428800` (50 MiB) | Response body cap; exceeded → `"body-too-large"`. |
| `bodyIsBase64` | boolean, `false` | Native only in v1 (cli body key pending). |
| `json` | boolean, `false` | Auto-parse a 2xx body into `result.data`; parse failure → `"invalid-json"` (status kept). Identical on both paths. |

Unknown option keys are ignored (forward compatible). Invalid types for
known keys → `"invalid-args"`. All validation happens **before** any I/O.

### Result object

```js
{
  status:     200,          // int; 0 when NO response was received
  statusText: "OK",         // reason phrase; "" when no response
  headers:    { "content-type": "application/json", ... }, // lowercased keys
  body:       "...",        // decoded body (text or raw binary string)
  bodyText:   "...",        // display-safe: == body for text; base64 for binary
  ok:         true,         // 200 <= status < 300
  data:       null,         // parsed JSON when opts.json:true + 2xx
  error:      null,         // non-null ONLY when no response was received
  meta: {
    path:       "native",   // "native" | "cli" | "cli-oneshot" | "socket" | "none"
    url:        "https://...", // final URL after redirects
    redirects:  0,
    timeMs:     123,
    bytes:      456,
    timeoutEnforced: true,  // native/cli: always; socket: false
    tlsVersion: "1.2",      // native/cli only; null on socket
    httpVersion: "1.1",
    abi:        "http-v1",  // envelope marker, native/cli responses
    nativeVersion: "1.0.0", // engine version, native/cli responses
    encodingWasApplied: false, // native only; null on cli/socket
    backend:    "winhttp"   // native only; null on cli/socket
  }
}
```

Guarantees: never throws for I/O or validation failures; response received
(any status) → `error === null`; `ok` reflects 2xx; `headers` keys always
lowercased, repeated headers joined `", "` (`set-cookie` → `"; "`); binary
responses: `body` raw byte string + `bodyText` base64.

### User-Agent precedence

Exactly **one** `User-Agent` header reaches the wire, on **every** transport.
An explicit header always beats `opts.userAgent`. This is the binding rule
(`docs/api-spec.md` §6.2, `contracts/http-api-v1`).

| `headers` has a `User-Agent`? | `opts.userAgent` | What is sent |
|---|---|---|
| **yes** (any case, any value) | ignored | your header value — even `""` |
| no | non-empty string | that string |
| no | `null` / unset | the default — host-derived `"eshttp/1.0.0 (Adobe <app> <version>; <platform>)"` when the host exposes name+version, else static `"eshttp/1.0.0"` (errata, additive) |
| no | `""` | **no `User-Agent` header at all** |

Header matching is case-insensitive. `configure({ userAgent: ... })` only
replaces the default. Suppression means **zero `User-Agent` bytes on the
wire** — a hard guarantee on all three transports.

### `eshttp.json` — ES3 JSON helper (ESON-backed)

ExtendScript has no `JSON` global, so es-http ships one — the vendored ESON
engine (DLL-accelerated when the host can load it, ES3 lane otherwise):

```js
eshttp.json.parse("{\"a\":1}")      // -> { a: 1 }; invalid / non-string -> null (never throws)
eshttp.json.stringify({ a: 1 })     // -> "{\"a\":1}"
eshttp.json("{\"a\":1}")            // == eshttp.json.parse(...)
```

`parse` returns `null` on invalid input (never throws); `stringify` handles
Object/Array/string/number/boolean/null, omits `undefined`/functions in
objects, `null` in arrays, cycles → `null` for the offending branch, and
escapes non-ASCII `\uXXXX` (7-bit clean — UTF-8 ABI safe).

### `configure(opts)` and `DEFAULTS`

```js
eshttp.DEFAULTS   // fresh snapshot each read
var prev = eshttp.configure({ timeout: 15000, userAgent: "my/1.0" }); // shallow merge; returns previous
```

Per-call `opts` always win over configured defaults.

### Diagnostics: `forceTransport`, `resetTransport`, `transportInfo`

```js
eshttp.transportInfo();
// { host, platform, transport: "native"|"cli"|"socket"|"none",
//   externalObjectAvailable, socketAvailable, nativeVersion, abi }

eshttp.transport                    // always-current active transport name
eshttp.forceTransport("cli");       // "auto" | "native" | "cli" | "socket" — tests/diagnostics
eshttp.resetTransport();            // drop cached selector + cached ExternalObject; re-probes
```

Transport selection is lazy (first `request()`), cached, and follows the tier
order: **cli(pipe) → cli-oneshot → native(opt-in) → socket → none** (v1.0.1).
The cli pipe lane is the default: it escapes per-app firewall rules by
construction and needs no DLL staging. The native in-process accelerator is
an **opt-in** lane — it is reached by `forceTransport("native")` or when the
separate native build is staged; without it, selection never tries the DLL
(see [Firewall escape](#the-firewall-escape-transport-cli)).

### Error taxonomy (`eshttp.error`)

Codes are stable strings exposed as constants on `eshttp.error` (e.g.
`eshttp.error.timeout === "timeout"`). Error objects always have the shape
`{ code, category, message, retryable, detail? }` — `category` is one of
`usage | transport | tls | timeout | abort | protocol | internal`.
The full 14-code table is in `docs/api-spec.md` §7.

### Transport capability matrix

| Capability | native (eshttp.dll) — **opt-in** | cli pipe (eshttp-ipc.dll + worker) — **default** | cli oneshot (job-file) | socket (ES3) |
|---|---|---|---|---|
| `http://` | yes | yes | yes | yes |
| `https://` | yes (TLS 1.2+) | yes (same engine, warm session) | yes (same engine) | no → `"unsupported"` |
| Custom methods | yes | yes | yes (v1: GET/HEAD) | yes |
| Redirect follow | yes (in DLL) | yes (in worker) | yes (in EXE) | yes (JS, manual) |
| Timeout | yes (WinHTTP) | yes (bounded pipe deadline, 3000ms default) | yes (engine + done-poll) | best-effort; `meta.timeoutEnforced=false` |
| Proxy (`opts.proxy`) | yes | yes | yes (default `"direct"`) | no (ignored) |
| gzip/deflate (`decompress`) | yes | yes | yes | no |
| Basic auth | yes | yes | yes | no (header only) |
| Connection reuse | yes (WinHTTP) | **yes (warm pool, zero spawn)** | no (one process per request) | no |
| **Firewall-escape** (per-app outbound block) | no | **yes** (kernel IPC — not network traffic) | **yes** (child image) | no |
| `meta.encodingWasApplied` / `backend` | yes | `null` | `null` | `null` |

**Default vs opt-in (v1.0.1):** the **cli pipe lane is the default**
(auto-selection reaches it first whenever the worker is available);
**native is opt-in** — auto reaches it only when the cli lane is
unavailable/dead AND the separate native accel/DLL is staged, or when you
call `forceTransport("native")` explicitly. The oneshot lane is the cli
tier's internal degradation; socket is the no-binaries fallback.

### The firewall-escape transport (`cli`)

A per-app outbound firewall rule (e.g. `Adobe-Block` matching
`Illustrator.exe`) blocks the host process's network — WinHTTP inside the DLL
lane fails with 12029 even for legitimate requests. **es-http never modifies
firewall rules.** Instead, the cli transport runs the network call in a
**separate process image**: `eshttp-cli.exe` is a static-link build of the
exact same v2 engine, spawned from inside the host and driven over IPC. The
firewall rule matches `Illustrator.exe` only — the child process is not
blocked, and **named pipes are local kernel IPC, not network traffic**, so
the per-app rule never sees the pipe lane at all.

Two cli lanes (both firewall-safe):

- **pipe** (`meta.path: "cli"`, primary): `eshttp-ipc.dll` (ExternalObject,
  pure pipe client — never does networking inside Illustrator) connects to a
  persistent `eshttp-cli.exe --worker` process over `\\.\pipe\EshttpBridge`.
  The worker keeps the WinHTTP session + connection pool + TLS cache warm
  across requests (true keep-alive, zero spawn per request), with bounded
  deadlines, versioned handshake, and payload-max 4096 bytes (large bodies
  travel by file path). On transport failure the wrapper relaunches the
  worker once, rewrites the request, retries once, then degrades.
- **oneshot** (`meta.path: "cli-oneshot"`, degradation): the proven job-file
  path — `File.execute()` with `ESHTTP_*.job` → envelope → `.done`, one
  process per request. Used when the pipe lane cannot start.

Degradation ladder (v1.0.1): **cli(pipe) → cli-oneshot → native(opt-in) →
socket → none**.

Verified live (Illustrator 30.6.0, all firewall rules enabled, none
modified, **v1.0.1 artifacts**): the one-shot lane fetched Wikipedia's W SVG
through the firewall (done-poll ~400 ms, status 200, 2440 bytes,
`image/svg+xml`); the release accel's pipe lane fetched the same SVG through
the REAL worker over the named pipe (200/2440 B, zero errors,
`meta.path: "cli"`). The pipe lane is ~44x faster than one-shot on
wrapper-transport overhead (0.064 vs 2.819 ms warm median; see
[Performance](#performance)). The full contract is in
[`docs/cli-transport.md`](docs/cli-transport.md).

> **Live status of the v1.1.0 merged accels: PASS.** The merged 1+n bundles
> (eshttp.accel-x64.jsx / eshttp.accel-x86.jsx) are verified live end-to-end
> (T29 re-gate, Illustrator 30.6.0): worker stages as `eshttp-cli.exe` (pipe
> lane active), the ESB64 facade codec lane runs (surface-complete check;
> `base64Encode("f") === "Zg=="` never throws), and Wikipedia's W SVG fetched
> through the real worker over the named pipe — OK|cli|200|2440, zero
> errors.

**Stale work-dir files.** The cli lane writes `ESHTTP_*.job` / `ESHTTP_*.done`
to `%TEMP%\opencode`. The wrapper sweeps stale files at host startup; between
sessions on a long-lived machine, finished `.done` files may accumulate
(cosmetic — a stale `.done` is deleted before each spawn and a stale `.job`
is claimed by the next scan). Clear the folder manually if it bothers you;
nothing in the release path reads stale files.

### Vendored codecs (JSON / base64 / UTF-8)

`eshttp.json` and the base64/UTF-8 helpers delegate to the **ESON** and
**ESB64** DLL-accelerated self-extracting bundles (embedded in
`dist/eshttp.jsx`). On a host that can load the accel DLL, the codec lanes
run native; on any load/extract failure the bundle falls back to its internal
ES3 lane and exposes the same facade — the never-throws design holds by
construction. Parity is pinned by the differential suites (753/0 JSON with
D1–D7 documented divergences; 103,711/0 base64/UTF-8). See
[Validation](#validation).

---

## Alternatives

The well-known community option for ExtendScript HTTP is
[buraktamturk/adobe-javascript-http-client](https://github.com/buraktamturk/adobe-javascript-http-client)
(68 stars, MIT). It is a capable Socket-based client, and its author
documents its limitations plainly
([issue #1](https://github.com/buraktamturk/buraktamturk-web/issues/1)):
**SSL/TLS is not supported** (Adobe's `Socket` class has no SSL support), the
library is **not async**, it speaks **HTTP/1.0** only (no chunked responses),
and there is **no Keep-Alive** — every call opens a new TCP connection.
Those limits follow from the `Socket` class itself: TLS-through-Socket is not
possible in ExtendScript.

| Alternative | Transport | HTTPS/TLS | HTTP version | Keep-alive | Timeout | Redirects | Proxy | gzip |
|---|---|---|---|---|---|---|---|---|
| **es-http** (native DLL + pipe worker lanes — the default) | WinHTTP (in-process / separate process) | **yes** (TLS 1.2+) | HTTP/1.1 | yes (warm pool) | yes (hard deadlines) | yes | yes | yes |
| **es-http** (socket lane — the no-binaries fallback) | ExtendScript `Socket` | no (`https://` → `"unsupported"`) | HTTP/1.1 | no | best-effort | yes (JS) | no | no |
| buraktamturk/adobe-javascript-http-client | ExtendScript `Socket` | **no** (author-documented) | HTTP/1.0 | no (author-documented) | no | no | no | no |
| Raw ExtendScript `Socket` | `Socket` | no | HTTP/1.1 (hand-rolled) | no | no | manual | no | no |

The comparison is honest: es-http's own socket lane shares the TLS
limitation — that is exactly why the native and pipe lanes are the default,
and why es-http's https-capable lanes (TLS 1.2+, measured at wrapper parity
with each other, 0.071–0.078 ms vs 0.084–0.141 ms) are what make it the
complete solution. Where the community client's documented TLS gap is the
problem, es-http's native/pipe lanes are the answer.

---

## Validation

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | 0 errors |
| Test suite, ESM lane | `node test/harness.js --all` | **204 pass / 0 fail** |
| Test suite, IIFE lane (shipping `dist/eshttp.jsx`) | `node test/harness.js --all` | **204 pass / 0 fail** |
| JSON differential vs ESON | `node test/parity/parity.mjs` | **753 / 0** (D1–D7 documented divergences as contracted) |
| base64/UTF-8 differential vs ESB64 | `node test/parity/esb64-parity.mjs` | **103,711 / 0** |
| Never-throw audit | `node test/parity/never-throw-audit.mjs` | **736 / 0** |
| Dist output audit (forbidden tokens) | `node test/parity/audit-dist.mjs` | **0 tokens / 0 suspects** |
| Native selftest (statically-linked engine) | `eshttp-selftest.exe` | **166 pass / 0 fail** |
| ES3 scanner | skill scanner | PASS (only the ratified bannerless `#target` rule) |
| **Live gate, Illustrator 30.6.0** | live COM probe | **PASS** — Wikipedia W SVG fetched through the firewall (status 200, 2440 B) and placed into a document as paths (pageDelta 1); `transport=native` and `transport=cli` both verified live |

Oracle statement: the JSON and codec lanes are differential-tested against
the ESON and ESB64 engines (their own corpora + WPT vectors + Node natives);
the native C engine is validated by its own 166-check selftest and the live
gate.

---

## Performance

Environment: Illustrator 30.6.0 / ExtendScript 4.5.6, Windows, median of
measurements via `$.hiresTimer` unless noted. Cold-start and round-trip
figures are dominated by the transport boundary:

- **Native DLL lane**: WinHTTP round-trip ≈ host-native cost; the dominant
  JS cost is envelope JSON parse/serialize (ESON, DLL-accelerated when
  loadable).
- **Cli pipe lane (v1.0.1, default)**: a persistent `eshttp-cli.exe --worker`
  process keeps the WinHTTP session + connection pool + TLS cache warm across
  requests (true keep-alive; the per-request spawn cost of the one-shot path
  is amortized to zero). Measured wrapper-transport overhead (T21,
  `test/parity/pipe-bench.mjs`, fake responders, no network): **pipe (warm,
  named-pipe): median 0.064 ms, p95 0.157 ms, sd 0.039 ms (n=10)** vs
  **oneshot (job-file): median 2.819 ms, p95 3.413 ms, sd 0.350 ms (n=10)**
  — ~44x pipe/oneshot (same-run pair); pipe cold-with-spawn (ensureWorker
  included) 0.260 ms, warming to 0.064 ms (spawn-amortization evidence).
  Env: node v22.23.2 win32 x64.
- **Cli pipe vs native-DLL (T25, driver-level head-to-head):** pipe median
  0.071–0.078 ms vs native-DLL 0.084–0.141 ms (ratio 0.55–0.87x, N=10 warm
  5, 3 runs, both fake responders, same harness). **At the wrapper level the
  pipe lane is at parity with, or marginally cheaper than, the in-process
  ExternalObject boundary — both sub-0.15 ms, so real-world comparisons are
  network-dominated, not transport-selected.** The real-DLL vs real-pipe live
  comparison is unverified-live (no firewall window per sponsor; no
  fabricated numbers).
- **Cli oneshot lane (degradation)**: measured live — done-poll ~400 ms for
  a complete HTTPS fetch of a 2440-byte SVG (WinHTTP connect/TLS + process
  spawn + job-file round trip) — see `test/QA-VALIDATION.md`.
- **Codec lanes (vendored ESON/ESB64)**: the accel bundles run the
  byte-heavy lanes (base64/UTF-8, JSON) natively when the host can load
  them; the sibling repos' measured numbers apply (e.g. ESB64 native
  encode/decode ≈ 2.5–3.2 ms for 360 KB vs a pure-JSX charCodeAt loop that
  wedges the engine past ~128 KB — see the ESON/ESB64 repos' own
  Performance sections). The ES3 fallback lanes keep the chunked-flush
  codec pattern (precomputed tables, `_B64_FLUSH=128` chunked join) to
  avoid the engine's superlinear `Array.join` and per-unit `charCodeAt`
  tax.
- **Socket lane**: fine for dev/test and small payloads; blocking reads, no
  reliable read timeout on many hosts (`meta.timeoutEnforced=false`), no
  TLS.

Perf notes: avoid `bodyText` on multi-MB binary bodies (it holds the base64
form in memory); prefer the native/cli lanes for production.

---

## Security Model

- **Header injection:** CR/LF anywhere in a header name/value, `userAgent`,
  `username`, `password`, or the URL → rejected (`"invalid-header"` /
  `"invalid-args"`), never sanitized. The cli job-file parser additionally
  rejects CR/LF and strips `\r` (16 KB line cap, 1 MiB job cap).
- **TLS:** native/cli verify certificates by default (`opts.verifyTls` =
  `true`); `verifyTls: false` disables certificate chain/expiry/hostname
  checks and must be used only against trusted, isolated servers
  (documented loudly in [Installation](#installation)).
- **Credentials:** `Authorization` (and `username`/`password`) are dropped
  automatically on cross-host redirects and on any https→http downgrade, on
  all transports. URL userinfo is stripped before appearing in messages or
  `meta` — credentials never leak into logs or error strings.
- **Firewall escape:** the cli transport runs the network call in a child
  process image. **No firewall rule is ever modified**; the child runs the
  same engine and speaks the same `http-v1` envelope; it is one-shot (claims
  one job, writes the `.done`, deletes the job). Job files live in
  `%TEMP%`/`%TEMP%\opencode` (the job-file work-dir trust model) and are swept
  at startup. The `done` path is validated against traversal; the job parser
  is defensive (line/file caps, unknown keys ignored).
- **Never executes user scripts:** the accel bundles eval only their own
  embedded ES3 source (never user data); the native lane returns JSON
  envelopes only. No `kTypeScript` auto-eval is used.
- **Memory:** all strings crossing the native boundary are UTF-8; response
  bodies are capped by `opts.maxBodyBytes` (50 MiB default). Host-owned
  `kTypeString` buffers are freed by the host via `ESFreeMem` — the wrapper
  never frees, and there is no caller-frees export (native-abi v2 removed
  the double-free hazard).

---

## Compatibility

| Target | Status |
|---|---|
| Adobe Illustrator 30.6.0 | verified live (native, cli, socket; W SVG fetch + place) |
| Adobe InDesign / Server | untested this release; ES3-clean, host-neutral code (transport tier relies on `File.execute` + `ExternalObject` presence) |
| Adobe Photoshop | untested this release; ES3-clean, host-neutral code |
| Other ExtendScript hosts (InCopy, Premiere, AE, Bridge, ESTK) | expected; not yet live-verified |
| Windows x64 / x86 | native + cli transports (MSVC `/MT`, both bitnesses) |
| macOS | socket transport only (cleartext `http://`); `https://` → `"unsupported"` (no v1 accelerator) |
| Node.js ≥ 18 | harnesses + parity tooling (the library itself is ES3) |

---

## Engine quirks that shaped the design

All measured live on Illustrator 30.6.0 / ExtendScript 4.5.6 unless noted.
Each item names what was observed, how it was reproduced, and the design
decision it forced.

- **`!(compound)` operator precedence bug (verified live, 2026-08-08).** An
  unparenthesized `!(c >= 48 && c <= 57 || ...)` mis-parses in the ES3
  parser — `!` binds to the first comparison only when inner parens are
  absent, and esbuild strips the "redundant" parens, triggering it. **Forced
  decision:** every compound range check is isolated into its own local
  variable (`var isDigit = ...; if (!(isDigit || ...))`), and the bundled
  output — not just the TS source — is audited.
- **`const`/`let` cannot survive esbuild `--target=es5`.** "Transforming
  const ... not supported yet" fails the build. **Forced decision:** all
  `src/*.ts` is written `var`-only; the strict TS source is deliberately more
  conservative than typical TS style.
- **No `Array.prototype.indexOf/map/filter/forEach`.** Adobe ships only four
  MDN polyfills (`shims.jsx`: indexOf, isArray, filter, map). String
  `indexOf`/`lastIndexOf` ARE native. **Forced decision:** own `_arrIndexOf`
  loop; no reliance on Array extras anywhere.
- **`charAt()` returns `""` for U+0000** while `charCodeAt()` returns the
  code unit. **Forced decision:** `charCodeAt` only where code-unit semantics
  or NUL detection are required; per-unit loops minimized (the codec lanes
  are vendored to ESB64, whose chunked-flush pattern avoids the engine's
  superlinear `Array.join` past ~few hundred elements and the ~0.95 µs/unit
  `charCodeAt` tax).
- **Mixed `&`/`|` evaluate left-associatively** in this engine (byte-builder
  expressions). **Forced decision:** never mix `&` and `|` in one expression;
  use temps and `+`; never mix `<<` with `|`/`&`.
- **Regex-literal parser treats an unescaped `/` inside a character class as
  the terminator.** **Forced decision:** `\/` stays escaped in the base64
  charset regex; verified at output level.
- **`Object.defineProperty` accessor descriptors may throw** on some hosts.
  **Forced decision:** `transport`/`DEFAULTS` getters and the publish use
  try/catch fallbacks; the build prepends a guarded defineProperty/bind shim.
- **The unwrap-footer P0 (live-only).** The built IIFE passed every Node gate
  but failed to load in real Illustrator: esbuild's export namespace emits an
  unquoted `default:` key (ES3 parse error) and ExtendScript's
  defineProperty eagerly evaluates getters, so the `eshttp = eshttp.default
  || eshttp` footer ran before the default binding existed. **Forced
  decision:** an ES3-safe unwrap footer + a strict-engine sandbox
  (`test/tests/50-artifact-contract.js`) that reproduces the ES3 parser and
  eager-getter semantics in CI. Node-green is necessary but not sufficient
  for this artifact class.
- **Per-app firewall rules block the host process, not its children.**
  WinHTTP 12029 inside the DLL lane was environmental, not a code bug — a
  controlled experiment (rules lifted, immediately re-enabled) proved it.
  **Forced decision:** the `cli` transport (see
  [Firewall escape](#the-firewall-escape-transport-cli)) — a child process
  image is not matched by a rule scoped to `Illustrator.exe`.
- **`app.copy()` is active-doc-relative.** Copying while the TARGET doc is
  active yields delta 0; the correct SVG→paths sequence is copy with the
  source doc active → switch `app.activeDocument` → paste. **Forced
  decision:** documented ordering in the live gate probe
  (`test/live/live-paste-sequence.jsx`); `placedItems.add()` does not accept
  SVG ("format cannot be placed").

---

## Development

```bash
npm install                # esbuild + typescript (devDependencies)
npm run typecheck          # npx tsc --noEmit -p .
npm run build              # dist/eshttp.jsx + dist/eshttp-core.esm.mjs (+ shim, footer, audits)
npm run build -- --accel   # + dist/eshttp.accel.jsx (EXE-staging single-file bundle)
npm test                   # pretest auto-builds, then node test/harness.js --all
npm run test:headless      # node test/harness.js (no mock servers)
npm run test:net           # node test/harness.js --net
npm run test:parity        # node test/parity/parity.mjs
```

Native build (C): see [`native/BUILD.md`](native/BUILD.md) — MSVC
`cl /LD`, x86+x64, `/MT` static CRT; `eshttp-selftest.exe` runs the 166-check
selftest. Live probes live under `test/live/*.jsx` and require an Adobe host.

---

## Repository layout

```
eshttp/
  docs/
    api-spec.md         <- PUBLIC API contract (contracts/http-api-v1)
    native-abi.md       <- eshttp.dll ABI contract (contracts/native-abi-v2)
    cli-transport.md    <- eshttp-cli.exe job-file IPC contract (cli-transport-v1)
    architecture.md     <- design (3 transports, tier order)
  src/
    *.ts                <- 18 TypeScript modules (var-only, strict):
                           drivers native/cli/socket, ESON/ESB64 adapters,
                           core, index (facade, default export)
  native/
    eshttp.c / eshttp.h         <- v2 engine + ABI header
    eshttp-cli.c                <- separate-process transport
    BUILD.md, selftest.c        <- build + 166-check selftest
  test/
    harness.js, load-core.mjs   <- headless ES3 runner + shared loader/stubs
    mock-server.js, tcp-client.js
    tests/*.js                  <- ES3 suites (incl. 35-cli-transport, 50-artifact-contract)
    parity/*.mjs                <- differential + never-throw + audit harnesses
    live/*.jsx                  <- host-only probes
    QA-VALIDATION.md, REPORT.md <- validation records (regenerated by the suite)
  eshttp-build.mjs, tsconfig.json, package.json
  dist/                   <- generated: eshttp.jsx, eshttp-core.esm.mjs, accel bundle
```

---

## Credits

- ExtendScript engine documentation and host behaviors:
  [docsforadobe](https://extendscript.docsforadobe.dev/) and the
  ExtendScript community (Jongware/JTG, Kasyan Servetsky, the ExtendScript
  wiki) - the engine-quirk catalogue this library designs around.
- ESON and ESB64 (thelabcorner) - the vendored JSON and base64/UTF-8 engines
  (DLL-accelerated bundles), whose own corpora and WPT vectors pin the
  differential suites.
- The Adobe ExternalObject direct-interface reference (canonical
  `SoSharedLibDefs.h` samples from the CEP-Resources repo) - the native-abi
  v2 shape.
- [buraktamturk/adobe-javascript-http-client](https://github.com/buraktamturk/adobe-javascript-http-client)
  (Burak Tamtürk) - the pioneer ExtendScript HTTP client, and the
  reference point es-http builds upon; his
  [issue documenting the Socket TLS gap](https://github.com/buraktamturk/buraktamturk-web/issues/1)
  is the community conversation this library answers.

---

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). Copyright (c) 2026 es-http contributors.

---

<p align="center"><small>es-http: one HTTP client, three transports, for Adobe ExtendScript.</small></p>
