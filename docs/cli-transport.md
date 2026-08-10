# eshttp — CLI Transport Contract (`cli-transport-v1`)

Status: **v2 (T22: pipe lane added)** · Owner: recon-architect · Updated: 2026-08-10
Implementer: build-engineer (T17, worker) + native-renamer (T18, bridge) · Wrapper:
core-porter (T9/T19, driver-cli.ts) · Build: build-engineer (T10/T20) · Gate: qa-validator
(T11/T21)

**This file is the single source of truth for the EXE transport boundary** —
both the pipe lane (primary) and the job-file one-shot lane (degradation).
Ground truth: `native/eshttp-ipc.h` (single source, both sides rebuilt from
it), `native/eshttp-cli.c` (worker + one-shot modes, as built),
`test/QA-VALIDATION.md` (live evidence).

**v2 summary (coordinator decision, 2026-08-10):** the cli transport has TWO
lanes. The **pipe lane is primary** (persistent `eshttp-cli.exe --worker`
process + `eshttp-ipc.dll` bridge, named-pipe IPC); the **job-file one-shot
lane** (T12 contract below) is the **degradation** path used when the pipe
lane cannot start. `meta.path` values: `"cli"` (pipe) and `"cli-oneshot"`
(job-file), both additive.

---

## 1. Purpose & architecture

`eshttp-cli.exe` is a **separate-process transport** that exists to reach the
network when the host app's own process image is blocked by a per-app
firewall rule (e.g. Adobe-Block matching `Illustrator.exe`) but child
processes are not. It is a static-link build of the **exact same v2 eshttp.c
engine** (no DLL, no ExternalObject) exposing ONE action: read a job file,
perform the HTTP request, write the `http-v1` response envelope to a done
file.

```
Illustrator (firewalled)                 eshttp-cli.exe (own process image)
┌────────────────────────────┐           ┌──────────────────────────────┐
│ eshttp.request()           │           │ WinHTTP fetch (not blocked)  │
│  -> driver-cli.ts          │  File.    │                              │
│     writes ESHTTP_*.job    │ execute() │ scan+claim newest job        │
│     polls ESHTTP_*.done    │ ────────► │ read job -> eshttp_request() │
│                            │           │ write envelope -> .done      │
│                            │           │ delete job file              │
└────────────────────────────┘           └──────────────────────────────┘
```

Rationale (sponsor direction): **no firewall rules are ever modified**; the
escape is architectural (child process image ≠ blocked app image). This is
the same pattern as ArcFit's one-shot EXE job-file IPC.

### 1.1 Transport tier (binding — coordinator ruling, T9/T19 lock the code)

Tier order: **native (eshttp.dll) → cli → socket (ES3) → none**, where `cli`
has two lanes: **pipe** (`meta.path: "cli"`, primary) and **one-shot**
(`meta.path: "cli-oneshot"`, degradation). `cli` is an **ADDITIVE transport**
— auto-selected when `ExternalObject` is unavailable or firewalled but the
worker/EXE can run. `result.meta.path` gains the additive values `"cli"` and
`"cli-oneshot"` (documented, **not** a contract bump — consumers must
tolerate unknown meta.path values per api-spec §3 forward-compat).
`transportInfo()` reports `transport: "cli"` with the same 7-key shape
(`externalObjectAvailable` stays as-is; no new keys).

> NOTE for qa-validator (T11/T21): the `transportInfo()` 7-key assertion in
> the harness tests is a **doc-side test** — adjust only the expected
> `transport` value (and add `cli` cases), not the key set.

### 1.2 Capability matrix (pipe lane vs one-shot vs native vs socket)

| Capability | native (eshttp.dll) | cli pipe (worker + bridge) | cli oneshot (job-file) | socket (ES3) |
|---|---|---|---|---|
| `http://` | yes | yes | yes | yes |
| `https://` | yes (TLS 1.2+) | yes (same engine, warm session) | yes (same engine, TLS 1.2+) | no → `"unsupported"` |
| Custom methods | yes | yes | yes | yes |
| Request headers | yes | yes | yes | yes |
| Query merge | yes (JS-side) | yes (JS-side) | yes (JS-side) | yes (JS-side) |
| JSON body | yes | yes | yes | yes |
| Binary body (base64) | yes | yes | yes (base64 in job) | no |
| Redirect follow | yes (in DLL) | yes (in worker) | yes (in EXE) | yes (JS, manual) |
| Timeout | yes (WinHTTP) | yes (bounded pipe deadline) | yes (engine + done-poll) | best-effort; `meta.timeoutEnforced=false` |
| Proxy (`opts.proxy`) | yes | yes | yes (default `"direct"`) | no (ignored) |
| gzip/deflate (`decompress`) | yes | yes | yes | no |
| Basic auth | yes | yes | yes | no (header only) |
| Connection reuse | yes (WinHTTP) | **yes (warm pool, zero spawn)** | no (one process per request) | no |
| Firewall-escape | no | **yes (kernel IPC — not network)** | **yes (child image)** | no |
| `meta.encodingWasApplied`/`backend` | yes | `null` | `null` | `null` |

Tier behavior: `cli` is https-capable like `native` (same engine), and is the
only https lane when `native` is dead/firewalled; `socket` remains the pure-ES3
cleartext lane.

### 1.3 Firewall-escape rationale (why this transport exists)

- **Problem:** per-app outbound firewall rules (e.g. `Adobe-Block` matching
  `Illustrator.exe`) block the host process's network even when the app is
  legitimate. WinHTTP inside the DLL lane fails with 12029 (cannot connect).
- **Non-solution:** modifying firewall rules. Sponsor direction: **no firewall
  rule is ever modified** — policies stay untouched, and a "temporary allow"
  would be a support/security smell for a library.
- **Solution (architectural):** run the network call in a **separate process
  image**. The firewall rule matches `Illustrator.exe` (by process image);
  a child process (`eshttp-cli.exe`) is a different image and is not matched.
  Spawning is via `File.execute()` (ExtendScript's built-in), no argv needed
  (scan-mode job claiming).
- **Why it's safe:** the child runs the EXACT same v2 engine and speaks the
  same `http-v1` envelope — behavior is identical to the DLL lane; the only
  difference is the process boundary. There is no privilege change, no rule
  mutation, and the child is one-shot (consumes one job, exits).
- **Live proof:** fetched Wikipedia's W SVG through the fully-enabled firewall
  (200, 2440 B, image/svg+xml, done-poll ~400 ms); see §6 and
  `test/QA-VALIDATION.md`.

### 1.4 Pipe lane — protocol (`eshttp-ipc.h`, single source of truth)

Both sides (worker EXE + bridge DLL) are rebuilt from
`native/eshttp-ipc.h` — do not fork values. Binding constants:

| Constant | Value | Meaning |
|---|---|---|
| `ESHTTP_IPC_PIPE_NAME` | `\\.\pipe\EshttpBridge` | fixed well-known pipe; worker holds the single instance for its whole lifetime (never disappears while alive); default kernel-object DACL restricts to the creator account |
| `ESHTTP_IPC_REQ_MAGIC` / `RESP_MAGIC` | `EshttpIpcReq_1` / `EshttpIpcResp_1` | request/response framing |
| `ESHTTP_IPC_PROTO_MAJOR/MINOR` | 1 / 0 | protocol version; **version gate fails the handshake before any op** |
| `ESHTTP_IPC_DLL_ABI` / `WORKER_ABI` | 1 / 1 | DLL surface + worker behavior contract |
| `ESHTTP_IPC_OP_MAX` | 48 | op names are short ASCII tokens |
| `ESHTTP_IPC_PAYLOAD_MAX` | 4096 | single-line bounded payload |
| `ESHTTP_IPC_REQ_MAX` | 1024 + 4096 | request message cap |
| `ESHTTP_IPC_RESP_MAX` | 16384 | worker response message cap |
| `ESHTTP_IPC_REPORT_MAX` | 8192 | DLL→JSX normalized report cap |
| `ESHTTP_IPC_TIMEOUT_DEFAULT_MS` | 3000 | default hard timeout (min 50, max 120000) |
| `ESHTTP_IPC_WAITNAMED_MS` | 200 | single `WaitNamedPipeA` wait |
| `ESHTTP_IPC_RETRY_SLEEP_MS` | 10 | startup retry pause |
| `ESHTTP_IPC_CONNECT_BUDGET_MS` | 1500 | max wait for the worker to exist |
| `ESHTTP_IPC_IDLE_DEFAULT_MS` | 120000 | worker idle self-exit (override `--idle-ms` or `ESHTTP_WORKER_IDLE_MS`; min 5000) |

**Bridge DLL surface (T18, eshttp-ipc.dll — live-verified, reconciled contract
`contracts/bridge-surface-reconciled`):** a pure
named-pipe client ExternalObject, freestanding (no CRT, no windows.h,
hand-declared imports, KERNEL32.dll only, `HeapAlloc`/`HeapFree` with
`ESFreeMem = HeapFree` exactness, `/GS- /nodefaultlib /entry:DllMain`).
Exports (dumpbin-verified x64 + x86):
`ESInitialize` (signature string `"eshttp_pipe_request_ssd"`),
`ESGetVersion` (= 1), `ESFreeMem`, `ESTerminate`, and the single business
method **`eshttp_pipe_request(op, payload, timeoutMs)`** (`_ssd` = string,
string, signed 32-bit). The driver calls it with the op name, the payload
(empty `payload=` marker + job body, or `jobFile=`/`resultFile=` paths), and
the deadline; it returns a bounded normalized report (`ESHTTP_IPC_REPORT_MAX`
8192, `_BRIDGE_PROTO = "ESHTTP_IPC_1"`). Hard deadlines at every phase,
single-flight CAS, handshake gate before any op, message-mode reads,
never-negative `kESErr*`, bounded `errClass` reports. Binary sizes: x64
15,872 B, x86 11,776 B. Live probe (Illustrator 30.6.0 COM, both spawn
modes): load ok, version 1, no RPC_E_SERVERFAULT; ping/status/version/echo/
request/unknown-op/quit ALL PASS — request returned the http-v1 envelope
through the pipe (full v2 engine), quit exited the worker + pid cleanup.

**Operations** (`op=`): `ping`, `status`, `version`, `echo`, `request`,
`quit` — plus adversarial test ops (`crashAfterAccept`, `hang`, `slow`,
`oversize`, `partial`, `garbage`, `badVersion`) that are recognized **ONLY**
under `--test` / `ESHTTP_IPC_TEST_OPS=1` (production workers answer
unknown-op so arbitrary local callers cannot trigger hang/crash behavior).

**`request` op payload framing** (pin exactly as the worker implements it):
the message is the LF-separated `key=value` job text AFTER the `payload=`
marker line — the request body rides the pipe as the message remainder
(empty `payload=` line followed by the job body lines). For large payloads
the job carries `jobFile=<path>` (worker claims the file) and the response
envelope goes to `resultFile=<path>` instead of the bounded pipe payload.
The response is bounded, line-based `key=value` UTF-8 text (LF-separated):
`success=0|1`, `errClass=<class>`, `winerr=<code>`, `protoMajor/minor`,
`workerAbi`, and `payload=` (the http-v1 envelope) or `resultFile=`.

**Error classes** (`errClass`, DLL-side classification, ASCII): `ok`,
`worker-unavailable`, `pipe-busy`, `connect-denied`, `timeout`,
`worker-crash`, `response-oversize`, `response-invalid`,
`version-mismatch`, `request-oversize`, `request-invalid`, `busy`,
`internal`, plus worker-side `worker-error` (request executed but returned an
error envelope: `success=0` + the http-v1 envelope as payload) and
`unknown-op`.

**Worker lifecycle:** single-instance server; pid file
`%TEMP%\opencode\eshttp-worker.pid`; idle timeout self-exit (120 s default);
one request per accepted connection (message-mode pipe, consumed exactly
once). The bridge (T18) is a **pure pipe client**: connect/write/read/
classify with hard deadlines, never does networking inside the host.

**Selftest:** `eshttp-cli.exe --selftest` runs a loopback client against
`\\.\pipe\EshttpBridgeSelftest` — verified ALL GREEN 10/10 on x64
(212,992 B) and x86 (176,640 B), T17 + T18 worker fixes (marker-job
two-pass claim, error-envelope classification, empty `payload=` marker,
pipe-before-pid startup order).

**Driver behavior (T19, pipe lane — ratified contract, coordinator 2026-08-10):**
`ensureWorker()` is idempotent: pid-file check first (`%TEMP%\opencode\eshttp-worker.pid`
— alive → no spawn); on stale/missing pid it writes a **marker job**
(`ESHTTP_worker_<id>.job`, header `ESHTTP_CLI_1` + `mode=worker`; the driver's
`cliInvocationId()` is `"cli"` + 16 hex chars, so the full name is
`ESHTTP_worker_cli<16hex>.job` — the worker's scan pattern `ESHTTP_worker_*.job`
matches the prefix) BEFORE
`File.execute()` no-argv. The CLI's scan+claim is a **two-pass claim**:
pass 0 claims worker markers only (→ `worker_main()`, marker deleted as
claimed); pass 1 claims request jobs with `ESHTTP_worker_*` **excluded by
filename prefix** — so a marker and a request job never collide, and no
coordination lock is needed between worker spawn and request dispatch
(marker+request coexist → one spawn becomes the worker, the other processes
the request; live-verified, T17). Normal request jobs stay mode-less
(default one-shot). **This preserves the no-argv `File.execute()` spawn
contract** (the firewall-escape premise) — mode is carried in the job IPC the
driver already speaks, not in process arguments (option (b), argv-passing
from inside the host, is rejected: host-version-dependent and live-failed).

Then: pipe request (job body rides the pipe, or file-claim for large
payloads) → bounded deadline; on transport failure: relaunch worker ONCE,
rewrite job, retry once; then degrade to the one-shot job-file lane
(§2–§7); then socket; then none. `meta.path`: `"cli"` (pipe),
`"cli-oneshot"` (one-shot).

**Perf (measured, T21 — `test/parity/pipe-bench.mjs`, fake responders, no
network; env node v22.23.2 win32 x64):** pipe (warm, named-pipe) **median
0.064 ms, p95 0.157 ms, sd 0.039 ms (n=10)** vs oneshot (job-file) **median
2.819 ms, p95 3.413 ms, sd 0.350 ms (n=10)** — ~44x pipe/oneshot (same-run
pair, wrapper-transport overhead). Pipe cold-with-spawn (ensureWorker
included) 0.260 ms, warming to 0.064 ms — the spawn-amortization evidence
(the persistent worker amortizes spawn + WinHTTP cold-start to zero).
Baseline captured at `test/parity/baseline.json`. The release gate adds the
real-pipe warm fetch vs one-shot in the host (200/2440 B live spot-check).

---

## 2. Job-file protocol (`ESHTTP_CLI_1`)

### 2.1 Job file (input)

Text file, **first line** the header token, then `key=value` lines
(`\n`-terminated; `\r` tolerated/trimmed):

```
ESHTTP_CLI_1
method=GET
url=https://en.wikipedia.org/wiki/W
done=C:/Users/x/AppData/Local/Temp/opencode/ESHTTP_123.done
headers={"Accept":"image/svg+xml"}        # optional; default "{}"
opts={"proxy":"direct","timeoutMs":15000} # optional; default per §2.3
```

| Field | Required | Type | Meaning |
|---|---|---|---|
| header `ESHTTP_CLI_1` | yes | token | protocol version gate; lines before it ignored |
| `mode` | no | string | `worker` only on the worker marker-job `ESHTTP_worker_<id>.job` (§1.4); absent = one-shot |
| `method` | no | string | HTTP method; default `"GET"` |
| `url` | **yes** | string | absolute `http(s)://` URL (UTF-8) |
| `done` | **yes** | path | where the envelope is written (UTF-8 path) |
| `headers` | no | JSON object string | request headers; default `{}` |
| `opts` | no | JSON object string | native-abi §3.3 opts; default §2.3 |

- Line length cap: 16 KB (`MAX_LINE`).
- Job file size cap: 1 MiB (read_file guard).
- Values are the SAME JSON strings the native ABI takes — the CLI reuses the
  v2 engine's envelope/opts parsing verbatim.

### 2.2 Done file (output)

The `http-v1` response envelope exactly as `eshttp_request` produces it
(native-abi.md §4 — **schema unchanged**). Written on completion (success
envelope OR error envelope; never partial). The caller polls for the file
(the live microprototype observed ~400 ms done-poll).

On CLI-side failure to even call the engine:
- `eshttp_request` returned non-OK →
  `{"ok":false,"error":"eshttp_request returned non-OK"}`
- no envelope returned →
  `{"ok":false,"error":"eshttp_request returned no envelope"}`
- job missing `url` or `done` → exit 2, **no done file** (caller treats as
  `internal` after its own timeout).

### 2.3 Default opts

When the job has no `opts` line, the CLI uses
`{"proxy":"direct","timeoutMs":15000}`. `proxy:"direct"` (NO_PROXY) is the
safe default for the escape use-case (no system-proxy dependency in the
child process).

### 2.4 Microprototype limitations (T13 hardening scope — NOT the final surface)

As built (eshttp-cli.c), the microprototype is GET-shaped:
- `body` is always `""` (the 4th engine arg) — **no request bodies** in the
  prototype; T13 adds the `body`/`bodyIsBase64` job fields before the final
  gate (T11) needs POST.
- Claim is "scan-newest + delete", not yet atomic-exclusive (see §3).
- The `opts` default hard-coded above is applied before reading the job's
  `opts` line.

---

## 3. Claim modes, atomicity, stale sweep

### 3.1 argv mode

`eshttp-cli.exe <jobfile>` — explicit path (used by Node harness / tests /
direct invocation).

### 3.2 scan mode (the File.execute() path)

`eshttp-cli.exe` with NO argv scans the ArcFit-style work dirs:
`%TEMP%` then `%TEMP%\opencode` (in that order) for `ESHTTP_*.job`, claims the
**newest** by `ftLastWriteTime` (`CompareFileTime`), processes it, deletes it.
Job files are consumed by design — a consumed job disappears, which is also
the caller's completion signal alongside the `.done` file.

### 3.3 Production hardening (T13, binding for the final artifact)

- **Atomic claim:** open the claimed job with an exclusive share mode
  (`CreateFile` `dwShareMode=0`) so two concurrent CLI processes cannot grab
  the same job; treat an exclusive-open failure as "not mine", rescan.
- **Stale sweep:** the wrapper (driver-cli.ts, T9) must sweep stale
  `ESHTTP_*.job`/`*.done` files in the work dir at startup (ArcFit does the
  same), so a crashed CLI (no done file, no delete) cannot wedge later runs.
- **Job validation:** reject jobs whose `url`/`done` contain path traversal
  (`..`, absolute-path tricks) or CR/LF; the engine already rejects bad URLs,
  but the `done` path is CLI-side authority — validate before opening.
- **x86 + x64 builds** staged per T10's artifact contract (mirror the
  eshttp-x86/x64 layout).
- **Exit codes:** 0 = done file written; 1 = engine/envelope failure (done
  file written with error); 2 = no job / malformed job / missing url+done
  (no done file). Caller treats 2 + timeout as `internal`.

---

## 4. Build & artifact

Static-link build (same-TU: `#include "eshttp.c"` with `ESHTTP_STATIC`), MSVC:

```
cl /nologo /TC /MT /O2 /D ESHTTP_STATIC /D WIN32_LEAN_AND_MEAN
   /D _CRT_SECURE_NO_WARNINGS eshttp-cli.c /Fe:eshttp-cli.exe
```

Artifact staging (T10 contract): `eshttp-cli-x64.exe`/`eshttp-cli-x86.exe`
staged to `eshttp-cli.exe` per the runtime layout — the wrapper resolves it
next to `eshttp.dll` (runtime root) and via `Folder.script` fallbacks.
**Requires NO ExternalObject and NO DLL** — this is the transport that works
when the DLL lane is firewalled.

---

## 5. Security notes

- **No firewall rule is ever modified** (sponsor direction). The escape is
  purely the child-process image not matching the per-app rule.
- `done` path is caller-controlled — validate (T13 §3.3); never let a job
  write outside its intended work dir.
- The envelope is the same `http-v1` JSON — credentials never appear in
  messages; URL userinfo stripped by the engine.
- Job files sit in `%TEMP%` — same trust model as ArcFit's job files
  (session-scoped, swept at startup).
- **Untrusted input:** job files are parsed defensively (16 KB lines, 1 MiB
  cap, `\r` trimmed, unknown keys ignored). T13 adds traversal/CRLF
  rejection.

---

## 6. Live evidence (QA-VALIDATION.md §firewall escape, 2026-08-10)

- Spawned from inside firewalled Illustrator 30.6.0 via `File.execute()` (no
  argv), all firewall rules enabled, **none modified**.
- Fetched Wikipedia's W SVG (https) — done-poll ~400 ms, `status 200`,
  `bytes=2440`, `image/svg+xml`. SVG base64-decoded to BINARY and written
  byte-identical to a reference fetch.
- Confirms the v2 engine compiles identically as DLL and EXE; envelope
  schema byte-compatible with the DLL lane.

---

## 7. Versioning

- Pipe protocol: `EshttpIpcReq_1` / `EshttpIpcResp_1` + `ESHTTP_IPC_PROTO_MAJOR`
  1 (eshttp-ipc.h — version gate before any op).
- Job-file protocol marker: `ESHTTP_CLI_1` (bump the token on protocol
  change).
- Envelope marker: `http-v1` (unchanged — native-abi.md §4).
- Transport names: `"cli"` (pipe) and `"cli-oneshot"` (job-file), both
  additive (api-spec §3 `meta.path` + §9 `transportInfo().transport`).
- This contract: `cli-transport-v1` (docs/cli-transport.md) — v2 covers both
  lanes.

---

*Drafted by recon-architect (T12, amended T22) · 2026-08-10 · ground truth
eshttp-ipc.h + eshttp-cli.c + QA-VALIDATION.md. Pipe-lane driver wiring (§1.4
"Driver behavior") + perf rows (§1.4) finalize when T19/T21 land; job-file
one-shot contract (§2–§7) is the degradation lane and stands as written.*
