# eshttp v1 — Integration Checklist & Acceptance Criteria

Status: **PUBLISHED (t-spec) + RULINGS (t-ruling)** · Owner: architect (t-integrate) · Date: 2026-08-09
Baseline: `review/contract-baseline.md` (verified against live files, 2026-08-09)
Blackboard: `contracts/baseline` (verified), `contracts/rulings` (t-ruling, 2026-08-09),
            `contracts/final-verdict` (pending t-integrate)

This checklist is the gate that t1–t4 must satisfy and the basis of the
final integration verdict (t-integrate). Items marked **[GATE]** are
re-verified by the architect in `review/final-report.md` before the v1
verdict is issued.

## Contract rulings (t-ruling — architect, 2026-08-09)

Published to blackboard `contracts/rulings`. Both rulings are ADDITIVE /
confirmatory — **no contract bump** (http-api-v1 / native-abi-v1 unchanged).
Reference for C5/D1/Q7/N4.

- **R-OBS1 — RULED YES:** expose `meta.encodingWasApplied` + `meta.backend`
  additively in `result.meta` for v1. Native path forwards from envelope
  (boolean / `"winhttp"|"wininet"` string); socket path + error results → `null`.
  Consumers must tolerate unknown meta keys (api-spec §3). Already codified in
  api-spec §3 + native-abi §4; jsxinc `_nativeEnvelopeToResult` (1032–1034),
  native error path (1569–1570), socket/error null (1215–1216, 1228, 1654).
  → qa: assert these keys on native responses (t3).
- **R-G5 — RULED: explicit caller `User-Agent` header wins** over
  `opts.userAgent`, case-insensitive, identical both transports. Full 4-row
  table in api-spec §6.2 (incl. `""` header sent verbatim; `""` userAgent +
  no header → no UA sent). Precedence resolved in wrapper BEFORE the transport
  call: native sends `optsJson.userAgent: null` when a header won (jsxinc 934,
  nulled at 1395/1397) — DLL does NO dedup and adds NO default of its own
  (native-abi §3.1); socket writes UA only when no explicit header
  (jsxinc 1096–1102). `configure({userAgent})` only replaces the default.
  → C5 (code review), Q7 (qa test), D1 (docs README).
- **R-G5-E1 (errata, HIGH — t1 gate item)**: espark-dev's `native/espack.c`
  lines 1525–1526 substitute `L"eshttp/1.0.0"` as the `WinHttpOpen()` agent
  whenever `optsJson.userAgent` is null, so WinHTTP injects
  `User-Agent: eshttp/1.0.0` on the wire — violating §6.2 row 4 (suppressed UA
  → NO header) and native-abi §3.1 (no default substitution). Fix: pass NULL
  agent when `opts.user_agent` is null (mechanism per espark-dev, must result
  in zero UA on the wire); verify with wire capture in selftest / qa Q7
  native suppressed-UA case. Blackboard `contracts/rulings` v2.

## Doc clarifications landed (t-ruling follow-up, 2026-08-09 — docs-only, no bump)
From docs F1–F5 (README + audit, blackboard `docs/audit` **v2 = durable record**,
README verified aligned with corrected api-spec §3), architect applied
to owned docs: api-spec §3 meta.encodingWasApplied/backend wording corrected
(native error envelopes carry values; null only socket/no-envelope) + `data`
absent-vs-null clarified (F1/F2); architecture.md §3 layout fixed to actual
test/ tree + LICENSE (F3), §4.1 tier table adds `espack_available()` probe
(F4), §4.1 https message quote corrected (F5). LICENSE created by docs (MIT).
t-integrate: reference `docs/audit` v2 for the docs-side audit record.

---

## t1 — NATIVE (espark-dev): espack.c + BUILD.md + selftest

| # | Acceptance item | Evidence required |
|---|-----------------|-------------------|
| N1 | `native/espack.c` implements exactly the 5 exports of `espack.h` (`espack_request`, `espack_last_error`, `espack_free`, `espack_version`, `espack_available`), `extern "C"`, `__cdecl` | header comment / exported symbol list in BUILD.md |
| N2 | `espack_version()` returns `"1.0.0"` (matches `ESPACK_VERSION`); `espack_available()` = 1 when WinHTTP backend initializes | selftest assertion |
| N3 | **Every** envelope carries `"abi":"http-v1"` (success AND error envelopes) — `ESPACK_ENVELOPE_ABI` emitted in all paths | selftest checks error-shaped envelope too |
| N4 | Envelope schema matches native-abi §4: `ok/status/statusText/headers/body/bodyEncoding/error/meta`; `meta` includes `path, method, finalUrl, redirects, timeMs, bytes, httpVersion, tlsVersion, encodingWasApplied, nativeVersion, winhttpError, backend` | selftest envelope assertions |
| N5 | `error != null` ⟺ no HTTP response (§4.3); 4xx/5xx → `ok:true`, `error:null`, real status | selftest |
| N6 | Error codes emitted are a subset of native-abi §5 table; unknown → not emitted (JS maps to `internal`) | selftest |
| N7 | NULL return ONLY on OOM/uninitialized backend; then `espack_last_error()` set (§4.4) | selftest / code review |
| N8 | `Host`/`Content-Length` caller-supplied values ignored; computed by DLL (§3.1) | selftest |
| N9 | Redirects handled in-DLL: 301/302/303→GET+drop body, 307/308 preserve; `Authorization` dropped on cross-host; `maxRedirects` cap; relative `Location` resolved; `meta.redirects` counted (§10 notes) | selftest / code review |
| N10 | `bodyIsBase64` decoded before send; `Content-Length` on decoded length (§3.2) | selftest |
| N11 | Text/binary sniffing + NUL guard per §4.1; UTF-8 everywhere, no ANSI codepage (§6) | selftest |
| N12 | `decompress` → `WINHTTP_OPTION_DECOMPRESSION` when settable; silent identity fallback + `encodingWasApplied:false`; NO manual gzip inflate (§10 ruling #2) | code review |
| N13 | Proxy semantics per §10 ruling #4: null→DEFAULT_PROXY, "direct"→NO_PROXY, "host:port"/"http://host:port"→NAMED_PROXY | code review / selftest |
| N14 | URL userinfo stripped before appearing in messages/meta — credentials never leak (§10 ruling #4) | code review |
| N15 | `native/BUILD.md` present: MSVC x86+x64 build commands, `/MT` static CRT, install/placement instructions (`lib:espack` resolution, native-abi §7), no fake DLL (build machine has no compiler — deliver compilable source + harness) | file exists + compiles |
| N16 | Selftest harness compiles and runs green (statically linked via `ESPACK_STATIC`) | harness output |

## t2 — CORE (core-dev): src/eshttp.jsxinc G1–G5

| # | Acceptance item | Evidence required |
|---|-----------------|-------------------|
| C1 | **[GATE] G1 fixed (P1 security)**: socket-path redirector drops `Authorization`/`username`/`password` on cross-host redirect. Current bug: line 1550 compares new URL to itself. Fix must compare original URL (`ctx.parsed`) vs `next.url` — and the filter must still run when only an explicit `Authorization` header is set (no username) | code review + qa test (t3 C7) |
| C2 | **[GATE] G2 fixed (P2)**: `opts.json === true` consumed — on 2xx, parse `result.body` → `result.data`; on parse failure → `result.error.code = "invalid-json"` (protocol, no), `result.status` kept, `result.data = null` (api-spec §11). `invalid-json` reachable | code review + qa test |
| C3 | **[GATE] G3 fixed (P2)**: `eshttp.request(null)` / `request()` / `request(42)` returns an `invalid-args` Result — **never throws** (api-spec §2/§3 guarantee). Guard non-object `opts` in `_buildContext` | code review + qa test |
| C4 | **[GATE] G4 fixed (P3)**: remove stray trailing comment in `_probeNative` (lines 898–899); behavior (absent DLL → re-probe allowed) unchanged | code review |
| C5 | **[GATE] G5 fixed (P3)**: User-Agent precedence rule implemented — explicit caller `User-Agent` header wins over `opts.userAgent` default (rule per architect ruling; docs documents it in README) | code review + qa test |
| C6 | Never-throws regression: `request` returns error Results for all validation failures, no uncaught TypeError path remains | code review + qa test |
| C7 | ES3 constraints intact after fixes: no `let/const/arrow/class`, no `Array.prototype.map/filter/forEach/indexOf` reliance, single self-contained file (§12) | code review |
| C8 | `eshttp._selftest()` (pure helpers, 30+ checks) still passes after edits | harness output |

## t3 — QA (qa): test/ suite

| # | Acceptance item | Evidence required |
|---|-----------------|-------------------|
| Q1 | `test/` suite exists: headless ES3 harness (ESTK/plain-ExtendScript runnable, no Adobe host required) + mock-server/ (local cleartext HTTP, Node `http`) | files present |
| Q2 | Harness runs `eshttp._selftest()` green | harness output |
| Q3 | `result.meta.abi === "http-v1"` on every native response; tampered envelope `abi` → DLL marked dead + degrade to socket (native-abi §7.1) | test |
| Q4 | **[GATE] G1 test**: cross-host redirect on socket path must NOT forward `Authorization` (same-host redirect may keep it) | test |
| Q5 | Non-ASCII round-trip test (UTF-8 end-to-end, native-abi §6) | test |
| Q6 | Header-lowercasing + repeated-header `", "` join (+ `Set-Cookie` `"; "`) on native path (baseline OBS-2) | test |
| Q7 | **[GATE] G2/G3/G5 tests**: `json:true` parse ok + `invalid-json` on bad body; `request(null)` returns invalid-args Result (no throw); User-Agent precedence (explicit header wins) | tests |
| Q8 | Socket path contract tests: HTTP/1.1, Host, Content-Length, Connection: close, chunked, read-to-EOF, 3xx manual/follow, too-many-redirects | tests |
| Q9 | Error taxonomy spot-checks: categories + retryable flags match api-spec §7 on both paths; socket producible set = `invalid-args bad-url invalid-header unsupported network timeout too-many-redirects body-too-large internal` | tests |
| Q10 | Transport tier tests: auto→native→socket→none ordering; forceTransport/resetTransport/transportInfo (7 keys) | tests |
| Q11 | Never-throw sweep: battery of malformed inputs (null opts, bad types, bad headers with CR/LF, bad url schemes) all return Results | tests |
| Q12 | Results documented with pass/fail per file; a single runnable command produces the report | README in test/ or harness output |

## t4 — DOCS (docs): README + doc audit + G5 rule

| # | Acceptance item | Evidence required |
|---|-----------------|-------------------|
| D1 | README documents the User-Agent precedence rule (explicit header wins over `opts.userAgent` default) — the G5 rule | README section |
| D2 | README: install/placement of `espack.dll` (both bitness), `new ExternalObject("lib:espack")` usage, macOS = socket-only v1 note | README section |
| D3 | README: `verifyTls:false` documented loudly (security note, api-spec §8 / native-abi §10 ruling #5) | README section |
| D4 | README: no-manual-gzip note (decompress fallback, native-abi §10 ruling #2) | README section |
| D5 | Doc audit: api-spec.md / architecture.md / native-abi.md internally consistent with implementation after G1–G5 fixes (e.g. §11 json convenience now implemented, §8 redirect rules match C1) | diff / audit notes |
| D6 | No contract wording changes that imply a version bump without architect sign-off (http-api-v1 / native-abi-v1 unchanged) | audit notes |
| D7 | README marks project status v1 (or per coordinator guidance) | README |

---

## Final review gate (t-integrate — architect)

Run **after** espark-dev, core-dev, qa, docs all report DONE.

1. Re-run the 4 baseline consistency checks against the FINAL files:
   - (1) ABI marker `http-v1` consistent across native-abi.md / espack.h / jsxinc
   - (2) Error taxonomy: 14 codes + categories + retryable match across
     api-spec §7 / native-abi §5 / jsxinc `_ERRORS`
   - (3) Envelope schema: every §4 field consumed by `_nativeEnvelopeToResult` +
     error path
   - (4) Request ABI: `_nativeRequest` sends all 11 optsJson keys; call shape
     matches espack.h
2. Verify G1–G5 fixes present and correct (checklist C1–C5 + qa tests Q4/Q7).
3. Verify t1–t4 deliverables exist: `native/espack.c`, `native/BUILD.md`,
   `test/` suite, README updated.
4. Produce `review/final-report.md`: per-item verdict table + overall
   PASS/FAIL + remaining-risk list.
5. Update blackboard `contracts/final-verdict`.
6. Broadcast final handoff to all members.

**Gate policy:** a [GATE] item failing → overall verdict FAIL (or
PASS-with-conditions if the risk is documented and non-blocking and agreed
with coordinator). Contract text (http-api-v1 / native-abi-v1) is
architect-owned; any required change is a coordinated contract bump, never a
silent edit.
