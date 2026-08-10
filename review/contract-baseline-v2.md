# Contract Baseline v2 — Re-verification (t0)

Status: **DONE** · Reviewer: architect · Date: 2026-08-09
Supersedes: `contract-baseline.md` (v1). Blackboard key: `contracts/baseline-v2`.

Contracts under review: **http-api-v1** (`docs/api-spec.md`) and **native-abi-v1**
(`docs/native-abi.md`). Both **UNCHANGED this pass — no version bump.**

Tree state at verification: `src/eshttp.jsxinc` 1982 lines, `native/espack.c` 2000
lines, `native/` contains only `espack.c` + `espack.h`.

## Verdict summary

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | ABI marker `"http-v1"` | **PASS** | espack.h:52 == jsxinc:58 == native-abi.md:216 |
| 2 | 14-code error taxonomy | **PASS** | jsxinc:816-831 == api-spec.md:307-320 |
| 3 | Envelope schema §4 | **PASS** | jsxinc:1005-1039; OBS-1 now closed |
| 4 | 11 optsJson keys + 5-arg shape | **PASS** | jsxinc:931-943,949 == espack.h:71-90 |

**Overall: 4/4 PASS. Contracts internally consistent. t1–t4 UNBLOCKED.**
**Integration gate: still FAIL — 3 t1 blockers confirmed still open (§5).**

---

## 1. ABI marker `"http-v1"` — PASS

| Source | Location |
|--------|----------|
| `docs/native-abi.md` | :216 (envelope schema), :274, :402 (mismatch rule), :413, :437 |
| `native/espack.h` | :52 `#define ESPACK_ENVELOPE_ABI "http-v1"` |
| `src/eshttp.jsxinc` | :58 `var _ABI = "http-v1";` |
| `native/espack.c` | :28 header contract note ("every envelope carries abi") |

Emission verified: `meta.abi` at jsxinc:1032, `transportInfo().abi` (README.md:196,
:334). Mismatch → DLL dead → degrade to socket (native-abi.md:402, README.md:352).
Downstream agreement: test/tests/10-headless.js:195, 20-native-abi.js:20/48/50/62/84,
test/README.md:63, test/harness.js:134,156, api-spec.md:125,358.

## 2. Error taxonomy — PASS

14 codes in `_ERRORS` (jsxinc:816-831) match the api-spec.md:307-320 table 1:1 on
**code**, **category**, and **retryable**.

Categories: `usage | transport | tls | timeout | abort | protocol | internal` —
identical enum restated at native-abi.md:339.
`retryable: true` is exactly `{dns, connect, network, timeout}` in all sources.

`native-abi.md`:322-336 lists **13** DLL codes — `invalid-json` correctly absent
(JS-side only, per api-spec.md:319 "only when `opts.json === true`"). Mapping rule
api-spec.md:322-325: DLL code → 1:1, unknown → `internal`.
`eshttp.error` constants derived from the same table (jsxinc:832-836), so the public
constants cannot drift from the taxonomy.

## 3. Envelope schema — PASS (OBS-1 closed)

`_nativeEnvelopeToResult` (jsxinc:1005-1039) vs native-abi §4:

| §4 field | Consumed | Line |
|----------|----------|------|
| `abi` | verified upstream; mismatch → dead DLL | 1032 (emit) |
| `ok` | ignored — recomputed from status (correct per §4.3) | 1016 |
| `status` | yes (0 when non-number) | 1007 |
| `statusText` | yes | 1018 |
| `headers` | yes, passthrough | 1008, 1019 |
| `body` / `bodyEncoding` | yes — base64 → decoded body, bodyText keeps base64 | 1009-1013, 1021 |
| `meta.finalUrl` | yes → `meta.url` | 1025 |
| `meta.redirects` / `timeMs` / `bytes` | yes, with fallbacks | 1026-1028 |
| `meta.tlsVersion` / `httpVersion` | yes | 1030-1031 |
| `meta.nativeVersion` | yes | 1033 |
| `meta.encodingWasApplied` | **yes (new)** | 1035 |
| `meta.backend` | **yes (new)** | 1036 |

`result.ok` is recomputed from `status` (1016), so a non-conforming envelope `ok`
flag cannot corrupt the Result. `meta.path = "native"` (1024),
`meta.timeoutEnforced = true` (1029).

**OBS-1 (from v1) is CLOSED.** `meta.encodingWasApplied` and `meta.backend` are now
exposed additively (both default `null` when absent), so qa can observe decompress
behavior through the public API. Additive only — no contract bump required.

**OBS-2 still open (owner: qa).** `result.headers` is a raw passthrough that trusts
the DLL to lowercase keys and join repeated headers (native-abi §4.2). Needs a
mock-server test on the native path.

## 4. Request ABI — PASS

All **11** optsJson keys sent by `_nativeRequest` (jsxinc:931-943):
`timeoutMs, redirect, maxRedirects, verifyTls, userAgent, username, password,
proxy, decompress, maxBodyBytes, bodyIsBase64` — identical set in
`native/espack.h`:71-83 and native-abi §3.3. Always fully populated;
`username`/`password`/`proxy` may be JSON `null` (valid).

Call shape (jsxinc:949):
`accel.espack_request(ctx.method, ctx.url, headersJson, body, optsJson)`
== `espack.h`:85-90 `espack_request(method, url, headersJson, body, optsJson)`.
**5 args, exact order.** ✓

`body` = raw base64 when `bodyIsBase64`, else `_utf8Encode(ctx.body || "")`
(jsxinc:946), per §3.2.

---

## 5. Open t1 blockers — ALL 3 STILL OPEN

| ID | Item | State | Evidence |
|----|------|-------|----------|
| R-G5-E1 | DLL must not substitute a default UA on the wire | **OPEN** | `native/espack.c`:1525-1526 |
| N15 | `native/BUILD.md` | **OPEN — file absent** | `native/` holds only espack.c, espack.h |
| N16 | `native/selftest.c` | **OPEN — file absent** | hooks at espack.c:1977-1989 undriven |

### R-G5-E1 detail

```c
1525:  LPCWSTR ua_w = opts.user_agent ? utf8_to_w(opts.user_agent) : L"eshttp/1.0.0";
1526:  HINTERNET hSession = WinHttpOpen(ua_w ? ua_w : L"eshttp/1.0.0", access_type, ...);
1527:  if (ua_w && ua_w != (LPCWSTR)L"eshttp/1.0.0") { free((void*)ua_w); }
```

`WinHttpOpen`'s agent is **session-wide** — WinHTTP appends it to every request on
that session. When `opts.user_agent` is NULL (caller suppressed the UA, or a
`User-Agent` already won in `headersJson` so the wrapper sent `userAgent: null`), a
`User-Agent: eshttp/1.0.0` still reaches the wire. Violates native-abi.md:137-138
(“must not substitute a default of its own”), native-abi.md:141-149 (which calls out
this exact `WinHttpOpen` trap), and api-spec §6.2 row 4.

The request-header builder is already correct — espack.c:1230
`if (!have_ua && opts->user_agent)`. Only the session agent leaks. espack.c:53
already documents the intended behavior, so this is an implementation slip, not a
design disagreement.

Recommended fix (also removes a latent pointer hazard at 1527, which compares
against a string-literal address and is not reliably true):

```c
LPCWSTR ua_w = opts.user_agent ? utf8_to_w(opts.user_agent) : NULL;
HINTERNET hSession = WinHttpOpen(ua_w, access_type, proxy_name, proxy_bypass, 0);
if (ua_w) { free((void*)ua_w); }
```

`WinHttpOpen(NULL, ...)` is valid and sends no agent (native-abi.md:146-147).
OOM edge: if `opts.user_agent` is non-NULL but `utf8_to_w()` returns NULL, do **not**
fall back to the default — fail with `last_error_set` + NULL return (preferred), or
proceed with no UA; document whichever is chosen.
`espack_available()`'s probe at espack.c:1965 may keep the literal (opens a session,
sends no request) — acceptable.

**Proof must be a wire capture in `selftest.c` (N16); an envelope assertion cannot
show what WinHTTP appended.**

## 6. New nit — R6 (non-blocking, wording only)

`native/espack.h`:75 documents `userAgent  string  default "eshttp/1.0.0"`, which
contradicts native-abi.md:134-138 and :164-167 (`null` or `""` → send **no**
User-Agent; the DLL never substitutes a default). This is the same incorrect mental
model that produced R-G5-E1, so it should be corrected in the same pass.

Comment-only edit, no ABI change, **no contract bump**. Owner: native-dev (file
owner); docs verifies. Suggested wording:
`userAgent  string|null  null or "" => send NO User-Agent; the DLL never
substitutes a default (see native-abi.md §3.1)`.

## 7. Acceptance criteria to flip the gate to PASS

1. R-G5-E1 fix landed + wire capture proving zero UA bytes when suppressed.
2. `native/BUILD.md` present — MSVC x86 + x64, `/MT` rationale, dual-bitness staging,
   `lib:espack` resolution order (native-abi §7), macOS socket-only note,
   ESPACK_STATIC selftest build+run command. Fixes 3 broken README links
   (README.md:92, 499, 535).
3. `native/selftest.c` present, compiles green under `ESPACK_STATIC`, drives the
   hooks at espack.c:1977-1989.
4. qa suite green; README links resolve.
5. native-dev posts `native/status` to the blackboard.

N15/N16 acceptance is **compilable source + documented commands**, not a shipped
binary (no C compiler on the build machine — ruling #3).

## 8. Standing policy

`http-api-v1` and `native-abi-v1` are **FROZEN** for v1.0.0. Contract wording changes
require a coordinated decision, never a silent edit
(`review/integration-checklist.md` gate policy). t5 will be a **delta re-check** of
§5 + §7 only, not a full re-read — precise `file:line` evidence in status keys gets
peers through the gate fast.
