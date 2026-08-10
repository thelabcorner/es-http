# native/BUILD.md — eshttp.dll + selftest build & run

Build guide for the eshttp native accelerator (`native/eshttp.c` / `eshttp.h`).
Contract: `docs/native-abi.md` (contracts/native-abi-v2, binding). ABI header
`eshttp.h` implements **exactly 8 exports** (see §2 of native-abi.md) — 4
mandatory ES* lifecycle exports + 4 business methods, canonical
ExternalObject DIRECT-INTERFACE shape `long fn(TaggedData*, long,
TaggedData*)` — do not add, remove, or rename them.

Two artifacts come out of this directory:

| Artifact | Build mode | Purpose |
|---|---|---|
| `eshttp2-x64.dll` / `eshttp2-x86.dll` | `ESHTTP_BUILD` | The accelerator loaded via `new ExternalObject("lib:eshttp")` (staged to `eshttp.dll` at install time). Numbered dev name: a DLL loaded in a running Illustrator session is LOCKED (LNK1104 on rebuild) — iterate with eshttp2/3/... and stage to `eshttp.dll` after the host restarts (skill L551-554) |
| `eshttp-selftest.exe` | `ESHTTP_STATIC` + `ESHTTP_SELFTEST` | Standalone harness (no DLL, no network beyond loopback) — exit 0 = ALL GREEN |

`probe.c` and `dll-smoke.c` are throwaway diagnostics — not part of the
deliverables (not shipped, not committed to a release). `probe.exe` exercises
`url_parse`/`url_resolve` via the `eshttp_st_*` hooks; `dll-smoke.exe` loads
the built `eshttp2-x64.dll` at runtime and drives all 8 exports through the
real canonical ABI (TaggedData marshalling).

---

## 1. Toolchain

- **MSVC (C mode, `/TC`)** — Visual Studio 2019 Build Tools 16.11 (14.29.30133)
  is the verified toolset; any VS2019/2022 Build Tools with the C++ workload
  works.
- **Windows SDK 10** — verified against `10.0.19041.0`; `winhttp.h` +
  `winhttp.lib`, `ws2_32.lib` (selftest only) are the only SDK dependencies.
- **Calling convention `__cdecl`** — the ExtendScript ExternalObject default.
  `eshttp.h` decorates exports with `__declspec(dllexport)` (MSVC), so no `.def`
  file is needed.

### 1.1 Environment (when `vcvars64.bat` is broken/missing `vswhere`)

Do not rely on `vcvars*.bat`. Set the include/lib/path directly (PowerShell):

```powershell
$vc  = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133'
$sdk = 'C:\Program Files (x86)\Windows Kits\10'
$k   = '10.0.19041.0'
$env:INCLUDE = "$vc\include;$sdk\Include\$k\ucrt;$sdk\Include\$k\um;$sdk\Include\$k\shared"
$env:LIB     = "$vc\lib\x64;$sdk\Lib\$k\ucrt\x64;$sdk\Lib\$k\um\x64"
$env:PATH    = "$vc\bin\Hostx64\x64;" + $env:PATH
```

Adjust the MSVC/SDK version numbers to what is installed on the target box.
For **x86** builds use `$vc\lib\x86`, `$sdk\Lib\$k\ucrt\x86`,
`$sdk\Lib\$k\um\x86`, and `$vc\bin\Hostx86\x86`.

---

## 2. Build the DLL

### 2.1 x64 (modern host: Illustrator 2021+ is 64-bit)

```bat
cl /nologo /TC /LD /MT /O2 ^
   /D ESHTTP_BUILD /D WIN32_LEAN_AND_MEAN /D _CRT_SECURE_NO_WARNINGS ^
   eshttp.c ^
   /Fe:eshttp2-x64.dll
```

`winhttp.lib` is linked via `#pragma comment(lib, "winhttp.lib")` inside
`eshttp.c` — do **not** pass it on the command line: `/TC` would force the
compiler to read the `.lib` as a C source file (C1083).

### 2.2 x86 (legacy 32-bit CC hosts)

Same command with the x86 environment from §1.1, output `eshttp2-x86.dll`.

Flags explained:

- `/TC` — force C compilation (the file must stay C; `eshttp.c` has no C++).
- `/MT` — statically link the CRT (no `vcruntime`/`msvcp` DLL dependency on the
  host; the DLL is self-contained).
- `/O2` — maximize speed (perf-sensitive request path).
- `/LD` — produce a DLL (implied for the DLL build; the selftest omits it).
- `/D ESHTTP_BUILD` — turns on `__declspec(dllexport)` in `eshttp.h` and the
  `DllMain`.
- `/D WIN32_LEAN_AND_MEAN` — keep `<windows.h>` minimal.
- `/D _CRT_SECURE_NO_WARNINGS` — suppress `strcpy`-family deprecation warnings
  (all uses are length-bounded in this codebase).

Verify the export table (exactly 8, undecorated):

```bat
dumpbin /exports eshttp2-x64.dll
```

Expected (native-abi v2): `ESInitialize`, `ESGetVersion`, `ESFreeMem`,
`ESTerminate`, `eshttp_request`, `eshttp_last_error`, `eshttp_version`,
`eshttp_available`. There is **no `eshttp_free`** — the host frees every
kTypeString return via `ESFreeMem`.

`ESInitialize` signature string (v2, pinned): 
`"eshttp_request_sssss,eshttp_last_error_f,eshttp_version_f,eshttp_available_f"`
— no-arg methods are declared with a dummy `_f` (bare no-arg names are
unreliable per the ExternalObject skill); the JSX wrapper must pass a dummy 0
(`eshttp_version(0)`, `eshttp_available(0)`, `eshttp_last_error(0)`).

---

## 3. Build & run the selftest

Statically links `eshttp.c` into one EXE (no DLL) and drives the exported API
plus the `eshttp_st_*` hooks against a local loopback WinSock server — no real
network access.

```bat
cl /nologo /TC /MT /O2 ^
   /D ESHTTP_STATIC /D ESHTTP_SELFTEST ^
   /D WIN32_LEAN_AND_MEAN /D _CRT_SECURE_NO_WARNINGS ^
   selftest.c ^
   /Fe:eshttp-selftest.exe
eshttp-selftest.exe
```

- Exit code **0** and the last line `ALL GREEN — t1 native gate items satisfied.`
  = pass (expected 166 checks, incl. the v2 ES* lifecycle + ABI-shape tests).
- Exit code **1** = one or more `FAIL` lines — see the section header above the
  FAIL for the subsystem (hooks / envelope / redirect / wire R-G5-E1 / sniff).
- stdout is unbuffered (`setvbuf`), so a crash still shows where it died even
  when output is redirected.
- Runs in seconds with **no network access**: the harness serves
  `127.0.0.1`/`127.0.0.2` loopback itself (redirect hops, wire capture).

Debug build (for crash triage — `/Od /Zi` + PDB):

```bat
cl /nologo /TC /MT /Od /Zi ^
   /D ESHTTP_STATIC /D ESHTTP_SELFTEST ^
   /D WIN32_LEAN_AND_MEAN /D _CRT_SECURE_NO_WARNINGS ^
   selftest.c /Fe:eshttp-selftest-dbg.exe
```

---

## 3a. Build the CLI transport helper (`eshttp-cli.exe`, incl. `--worker`)

One source (`eshttp-cli.c`, links `eshttp.c` statically) builds the one-shot
job-file transport AND the persistent named-pipe worker. Protocol source of
truth: `eshttp-ipc.h` (contracts/cli-transport-v1 §3; both the worker and the
T18 bridge DLL rebuild from it).

x64 (modern host):

```bat
cl /nologo /TC /MT /O2 ^
   /D WIN32_LEAN_AND_MEAN /D _CRT_SECURE_NO_WARNINGS ^
   eshttp-cli.c /Fe:eshttp-cli.exe
```

x86 (legacy 32-bit CC hosts): same command with the x86 environment from §1.1,
output `eshttp-cli-x86.exe`.

Modes (mode dispatch precedes the argv-as-jobfile path):

| Invocation | Mode |
|---|---|
| `eshttp-cli.exe <jobfile>` | One-shot: read the `ESHTTP_CLI_1` job, run, write the envelope to `<done>`, delete the job. |
| `eshttp-cli.exe` (no argv) | Two-pass scan+claim: pass 0 claims a worker spawn MARKER (`ESHTTP_worker_*.job`, header `ESHTTP_CLI_1` + `mode=worker`) and enters `--worker`; pass 1 claims request jobs (`ESHTTP_*.job`, worker markers EXCLUDED by filename prefix so a racing oneshot never consumes a marker). |
| `eshttp-cli.exe --worker` | Persistent: single-instance `\\.\pipe\EshttpBridge` server, warm WinHTTP session, pid file `%TEMP%\opencode\eshttp-worker.pid`, idle self-exit (default 120000 ms; `--idle-ms <n>` or `ESHTTP_WORKER_IDLE_MS`). |
| `eshttp-cli.exe --selftest` | Loopback selftest on `\\.\pipe\EshttpBridgeSelftest` (server thread + client) — ALL GREEN gate (10 groups). |
| `--test` (with any mode) | Enable the adversarial ops (`crashAfterAccept`/`hang`/`oversize`/`partial`/`garbage`/`badVersion`); production workers keep them disabled. |

Worker marker-job spawn convention (coordinator-ruled option (a), locked with T19):

1. `ensureWorker()` writes `ESHTTP_worker_<16hex>.job` to `%TEMP%\opencode`
   (content `ESHTTP_CLI_1\nmode=worker\n`) BEFORE `File.execute()` no-argv.
2. The spawned CLI's pass-0 claim picks it up (same `ESHTTP_*.job` prefix;
   `mode=worker` routes to `worker_main()`; the marker is deleted as claimed).
3. The oneshot pass-1 claim EXCLUDES `ESHTTP_worker_*.job` (filename prefix
   check in `scan_dir`), so a racing oneshot scan can never consume a marker
   and a request job is never delayed by one.
4. Request jobs stay mode-less (default one-shot). The argv dispatch and the
   one-shot request path are unchanged.

Worker start/stop contract (for consumers — the T19 driver + T21 benchmark):

1. **Start**: spawn `eshttp-cli.exe --worker` (File.execute no-argv style, or
   CreateProcess). The worker writes `%TEMP%\opencode\eshttp-worker.pid` and
   owns the pipe name for its lifetime.
2. **Liveness**: `WaitNamedPipe(\\.\pipe\EshttpBridge, budget)` + a `ping`
   request (connect budget 1500 ms).
3. **Request**: one connection per request — connect, write the
   `EshttpIpcReq_1` message (job body after the `payload=` marker line, or
   `jobFile=<path>` for large bodies), read the `EshttpIpcResp_1` response,
   disconnect. The worker disconnects after each request.
4. **Stop**: send `op=quit` on a fresh connection; the worker removes its pid
   file and exits. Fallback: idle timeout self-exit; last resort: kill the
   pid from the pid file (a stale worker must never block a new spawn — the
   T19 driver handles this).

---

## 3b. Build the IPC bridge DLL (`eshttp-ipc.dll`)

A PURE named-pipe client ExternalObject (T18): it never does networking —
it connects to the `--worker` pipe and asks the worker to run HTTP
out-of-process (the firewall-escape lane). ABI: canonical direct-interface
(`long fn(TaggedData*, long, TaggedData*)`), exports exactly 5 =
`ESInitialize`/`ESGetVersion`/`ESFreeMem`/`ESTerminate` + the single business
method `eshttp_pipe_request(op, payload, timeoutMs)` (op covers
ping/status/version/echo/request/quit). Report format and protocol:
`eshttp-ipc.h` (single source of truth).

**FREESTANDING** (skill discipline): no CRT, no `<windows.h>`; Win32 imports
are hand-declared, memory comes from the process heap
(`HeapAlloc`/`HeapFree`), `ESFreeMem` = `HeapFree` (exact allocator match),
every wait carries a hard deadline, and NO negative (fatal) `kESErr*` code
is ever returned — every failure path returns a bounded kTypeString report
with a machine-readable `errClass`.

x64 (modern host):

```bat
cl /nologo /TC /LD /MT /O2 /GS- /nodefaultlib ^
   /D WIN32_LEAN_AND_MEAN /Fe:eshttp-ipc-x64.dll eshttp-ipc.c ^
   /link /entry:DllMain /subsystem:windows /nodefaultlib kernel32.lib
```

x86 (legacy 32-bit CC hosts): same command with the x86 environment from §1.1,
output `eshttp-ipc-x86.dll`.

Build notes:

- `/GS-` + `/nodefaultlib` are REQUIRED: the freestanding build must not pull
  in the CRT (no `__security_cookie`, no `LIBCMT`, no `__allmul`). The only
  import is `KERNEL32.dll` (verify with `dumpbin /imports`).
- `SIZE_T` for `HeapAlloc` must be pointer-sized (`SIZE_T_OWN` typedef in
  eshttp-ipc.c) — a hard-coded 64-bit third arg produces a wrong stdcall
  decoration (`@16` instead of `@12`) on x86 and fails to resolve.
- `memzero` is a `volatile` byte loop — `/O2` would otherwise lower it to a
  `memset` call the freestanding build cannot resolve.
- The request-id mix uses 32-bit arithmetic only (a 64-bit multiply would
  need the CRT's `__allmul` on x86).

Verify (dumpbin, x64 machine):

```bat
dumpbin /exports eshttp-ipc-x64.dll
```

Expected (exactly 5, undecorated): `ESInitialize`, `ESGetVersion`,
`ESFreeMem`, `ESTerminate`, `eshttp_pipe_request`.

```bat
dumpbin /imports eshttp-ipc-x64.dll
```

Expected: only `KERNEL32.dll` (freestanding proof — no CRT).

`ESInitialize` signature string (T18, pinned):
`"eshttp_pipe_request_ssd"` — one method, 3 args (op string, payload string,
timeout declared `_d`; per the skill's signature-cast observation the timeout
arrives as `kTypeInteger`, so the bridge accepts the whole numeric family).

Live ABI probe (requires a running worker — `eshttp-cli.exe --worker` or a
marker-job spawn):

```jsx
var lib = new ExternalObject("lib:eshttp-ipc");
lib.eshttp_pipe_request("ping", "", 3000);      // -> report success=1 pong
lib.eshttp_pipe_request("request", "method=GET\nurl=http://127.0.0.1:1/x\nheaders={}\nopts={}\n", 8000);
lib.eshttp_pipe_request("quit", "", 3000);       // worker exits
```

Verified live (Illustrator 30.6.0, 2026-08-10): load, version=1,
ping/status/version/echo/request/unknown-op/quit all green against both a
`--worker`-spawned and a marker-job-spawned worker; request returned the
http-v1 error envelope through the pipe (full v2 engine exercised).

---

## 4. Install & placement (native-abi.md §7)

`new ExternalObject("lib:eshttp")` resolves the DLL on the host's ExternalObject
search path, in this order (test on each target):

1. The script's own folder — next to the `.jsx`/`.jsxinc` (most reliable for
   script-distributed installs).
2. The host app install folder — e.g.
   `C:\Program Files\Adobe\Adobe Illustrator 2025\Support Files\` (folder
   containing the app executable).
3. The host's `Plug-ins` folder (and `Plug-ins\Required`).
4. Windows system PATH (possible, not recommended).

Distribution rules:

- Provide **both bitness builds** (`eshttp2-x86.dll` / `eshttp2-x64.dll`, staged
  as `eshttp.dll` at install time or shipped side-by-side with a wrapper that
  picks the matching one). Bitness must match the host process. A bitness
  mismatch fails the load gracefully (ExternalObject ctor throws → the eshttp
  wrapper falls back to the socket path).
- macOS v1: no DLL — HTTPS unavailable (socket fallback only). Documented, not
  built here.
- The wrapper load path must be (native-abi v2):
  ```js
  try { accel = new ExternalObject("lib:eshttp"); } catch (e) { accel = null; }
  // verify typeof accel.eshttp_version === "function" before first use;
  // no-arg methods take a dummy 0 (eshttp_version(0), eshttp_available(0),
  // eshttp_last_error(0)); there is NO eshttp_free — the host frees every
  // kTypeString return via ESFreeMem.
  ```
  and treat any envelope with `abi !== "http-v1"` as an incompatible DLL
  (mark dead → degrade to socket).

---

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cl` is not recognized | Toolchain env not set — run §1.1 (or a working `vcvars64.bat`). |
| `cannot open include file: 'winhttp.h'` | SDK include path missing from `INCLUDE` (§1.1). |
| `unresolved external symbol __imp_WinHttp*` | `winhttp.lib` not on the `cl` command line or `LIB` lacks `um\x64`. |
| Selftest crashes at startup (0xC0000005) | Stale EXE vs. source — rebuild. If it persists on current source, build `/Od /Zi` and bisect tests (see §3 debug build). Known fixed causes: `url_parse` scheme test (was full-equality), J_OBJ child-count overrun in `jv_free`/`obj_get`/header loop. |
| `ExternalObject("lib:eshttp")` throws | DLL not on the search path (§4) or bitness mismatch — fall back to socket; do not call `eshttp_request`. |
| WinHTTP TLS failures on old Windows | WinHTTP TLS defaults follow the OS; on legacy targets consider registry/system TLS settings. `verifyTls:false` disables cert validation only. |
| `error.code: unsupported` from `eshttp_available(0)` == 0 | WinHTTP session creation failed (rare on XP-era or locked-down systems) — wrapper must degrade to socket. |
| RPC_E_SERVERFAULT (0x80010105) on any call | Host called a non-canonical export (v1 plain-C shape) — the DLL must expose the canonical direct-interface ABI (v2: ESInitialize + TaggedData shape). Rebuild from `eshttp.c` v2; verify with `dumpbin /exports` (8 exports) + `dll-smoke.exe`. |

---

## 5a. Security audit (v1, native-dev)

Reviewed `eshttp.c` for the attack surface that matters for an
ExtendScript-facing DLL. Findings and disposition (all fixed in-tree):

| # | Finding | Severity | Fix (eshttp.c) |
|---|---|---|---|
| 1 | **Header injection via `optsJson.userAgent`** — the UA is emitted as a header value (`User-Agent: <ua>`); CR/LF in it could inject arbitrary headers on the wire | **HIGH** | Reject CR/LF/NUL in `userAgent` at `opts_parse` → `invalid-args` envelope |
| 2 | **Request-line injection via URL** — CR/LF inside a URL would terminate the request line mid-URL | **HIGH** | `url_parse` rejects any URL containing CR/LF/NUL (line ~701) |
| 3 | **Authorization replay over cleartext** — a `https://host` → `http://host` redirect (same host) would re-send `Authorization` in the clear; the cross-host strip compared host strings only | **HIGH** | `build_request_headers` also strips when the scheme changes (`hop_https != first_https`); covered by 3 new selftest checks |
| 4 | **Header name/value CR/LF** — caller `headersJson` with CR/LF (header smuggling `"a\r\nSet-Cookie: evil=1"`) | **HIGH** | Existing `invalid-header` guard extended to NUL (`has_crlf`) — a NUL would silently truncate the emitted header |
| 5 | **NUL in `username`/`password`** | LOW | Rejected at `opts_parse` (they are base64-encoded, so not an injection vector — defense in depth) |
| 6 | **`WINHTTP_QUERY_RAW_HEADERS_CRLF` size quirk** — the two-step size/copy query can under-report the terminating NUL on some Windows versions, risking an over-read in `w_to_utf8` | MED | Defensive `calloc(hl + sizeof(wchar_t))` zero-padded buffer |
| 7 | **`hdr_push` owned the caller's strings** — stored `jv`-tree pointers then freed them (double-free risk); also leaked a `str_ndup` | MED | `hdr_push` deep-copies (`str_dup`) both name and value |
| 8 | **URL userinfo** (`https://user:pw@host/`) | — (verified safe) | Stripped in `url_parse`; never emitted in `meta.finalUrl`/messages (rebuilt from parsed components); never mapped to Basic auth |
| 9 | **Envelope purity** — non-ASCII/control bytes in any envelope string | — (verified safe) | `w_str` escapes everything < U+0020 and > U+007E as `\uXXXX` (surrogate pairs beyond BMP); envelope is pure ASCII |
| 10 | **`maxBodyBytes` cap** | — (verified safe) | Enforced before each read chunk; `body-too-large` error, no unbounded allocation |

Not addressed (documented): `verifyTls:false` disables cert validation by design
(opt-in); the redirect loop is bounded by `maxRedirects` (default 5, cap 10000).

---

## 6. Verification checklist (t1 gate)

1. `eshttp-selftest.exe` → `ALL GREEN` (exit 0, 166 checks).
2. `dumpbin /exports` → exactly the 8 v2 exports (4 ES* + 4 business; no `eshttp_free`).
3. `dll-smoke.exe` → loads `eshttp2-x64.dll`, exercises all 8 exports through
   the canonical TaggedData ABI, `DLL-SMOKE OK` (exit 0).
4. Probe `probe.exe` (optional dev tool) → `url_parse` accepts http/https
   (incl. userinfo, IPv6, non-default ports) and rejects ftp/malformed.
5. Wire-level R-G5-E1 (covered by the selftest): `userAgent:null` → zero
   `user-agent` bytes; explicit header wins exactly once; no `eshttp/1.0.0`
   leak.
6. Live (Illustrator): `new ExternalObject("lib:eshttp")` → `version == 1`,
   `eshttp_version(0)` == "1.0.0", a real request returns the http-v1
   envelope; no RPC_E_SERVERFAULT.
7. `eshttp-cli.exe --selftest` (x64 + x86) → `ALL GREEN` (10 check groups).
8. Bridge: `dumpbin /exports eshttp-ipc-x64.dll` → exactly 5 exports
   (`ESInitialize`/`ESGetVersion`/`ESFreeMem`/`ESTerminate`/
   `eshttp_pipe_request`); `dumpbin /imports` → only `KERNEL32.dll`.
9. Bridge live (Illustrator + running worker): `eshttp_pipe_request("ping","",3000)`
   → `success=1 message=pong`; `request` op → http-v1 envelope; `quit` → worker
   exits (see §3b).
