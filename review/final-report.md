# eshttp v1 — Final Integration Report (t5-integrate, architect)

Status: **ISSUED (t-integrate, final gate)** · Date: 2026-08-09
Gate basis: `review/integration-checklist.md` (t1–t4 acceptance + Final review gate)
Baseline: `review/contract-baseline.md` §1–§4 (re-run against FINAL files)
Team inputs: `core/audit` v2 (t2), `qa/status` v1 (t3), README + docs (t4, in-flight), native tree (t1)

---

## Overall verdict

| | |
|---|---|
| **VERDICT** | **FAIL** — blocked on t1 (native). t2/t3 PASS; t4 PASS-conditional; t1 FAIL on R-G5-E1 + N15 + N16. |
| Flips to | **PASS-with-conditions** the moment espark-dev lands (1) the R-G5-E1 one-line fix in `native/espack.c:1525-1526`, (2) `native/BUILD.md`, (3) `native/selftest.c` + posts `native/status` to blackboard. Coordinator may ratify as PASS-with-conditions per gate policy (risk fully documented below, non-blocking for the wrapper/socket/doc/test deliverables, but it **is** a wire-level contract violation on the native path — architect recommends holding FAIL until landed). |
| Evidence basis | This report cites file:line for every item. QA suite independently re-run by architect: **112 pass / 0 fail / 0 known-issue** (`node test/harness.js --all`, EXIT 0, REPORT.md regenerated). |

**Verdict-first summary:** the ES3 wrapper, socket path, test suite, and docs are release-ready and fully consistent with the contracts. The native accelerator source (`espack.c`) is structurally complete (N1–N14 verifiable by code review) but **three hard t1 acceptance items are unmet in the current tree**: the R-G5-E1 errata fix (HIGH, t1 gate item — wire UA leak), `native/BUILD.md` (N15), and `native/selftest.c` (N16). espark-dev's t1 task is still claimed and the member went idle without posting `native/status`; architect sent an urgent fix spec (msg to espark-dev, queued) but no response or file change was observed before this report was issued.

---

## 1. Baseline consistency checks (re-run against FINAL files)

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | ABI marker `"http-v1"` consistent across native-abi.md / espack.h / jsxinc | **PASS** | native-abi.md §4 `"abi":"http-v1"` (docs/native-abi.md:205, 263, 391); espack.h `#define ESPACK_ENVELOPE_ABI "http-v1"` (native/espack.h:52); jsxinc `var _ABI = "http-v1"` (src/eshttp.jsxinc:58); espack.c emits `ESPACK_ENVELOPE_ABI` in **every** envelope via `env_build` (native/espack.c:1034), success and error paths alike (env_build called at 1377/1394/1411/1428/1479/1505/1930). ABI-mismatch degrade implemented (jsxinc:985-991 → dead DLL → socket), matching native-abi §7.1. |
| 2 | Error taxonomy: 14 codes + categories + retryable match across api-spec §7 / native-abi §5 / jsxinc `_ERRORS` | **PASS** | api-spec §7 rows 299–312: 14 codes (`invalid-args bad-url invalid-header unsupported dns connect network tls timeout aborted too-many-redirects body-too-large invalid-json internal`). jsxinc `_ERRORS` (jsxinc:816–831): identical 14 codes, categories `usage\|transport\|tls\|timeout\|abort\|protocol\|internal`, retryable flags (dns/connect/network/timeout = yes, rest no) — byte-for-byte match with api-spec §7. native-abi §5 (313–325): 13 codes (no `invalid-json` — correct, JS-side only per api-spec §7). DLL mapping `map_winhttp` (espack.c:1106–1127) emits only §5 subset; unknown → `internal` (default branch). |
| 3 | Envelope schema: every §4 field consumed by `_nativeEnvelopeToResult` + error path | **PASS** | `_nativeEnvelopeToResult` (jsxinc:1005–1039): abi (verified at 985 before mapping), status (1007), statusText (1018), headers (1008), body/bodyEncoding (1009–1013, utf8/base64 branch), meta.finalUrl→url (1025), redirects (1026), timeMs (1027), bytes (1028), tlsVersion (1030), httpVersion (1031), nativeVersion (1033), **encodingWasApplied** (1035), **backend** (1036) — OBS-1 resolved per ruling R-OBS1. `ok` recomputed from status (1016), correct per §4.3. Error path (jsxinc:1556–1574) forwards the same meta set on native error results; `winhttpError` → `error.detail.winhttp` (jsxinc:995–998). Socket/no-envelope error paths emit `encodingWasApplied:null, backend:null` (jsxinc:1054-1056, 1215-1218, 1228-1230, 1654-1656) — matches api-spec §3. |
| 4 | Request ABI: 11 optsJson keys + 5-arg call shape match espack.h | **PASS** | `_nativeRequest` sends exactly 11 keys (jsxinc:931–943): timeoutMs, redirect, maxRedirects, verifyTls, userAgent, username, password, proxy, decompress, maxBodyBytes, bodyIsBase64 — identical to native-abi §3.3 (native-abi.md:148–165) and espack.h doc (espack.h:70–83). Call shape `accel.espack_request(ctx.method, ctx.url, headersJson, body, optsJson)` (jsxinc:949) = exact 5-arg order of espack.h prototype (espack.h:85–90). All 11 parsed in C `opts_parse` (espack.c:914–986). NULL username/password/proxy/userAgent legal (JSON null → C NULL, espack.c:932-938, 951-975). |

**Baseline: PASS 4/4 — identical conclusion to contract-baseline.md (no drift).**

---

## 2. G1–G5 fixes + R-G5-E1 errata (checklist C1–C5, R-G5-E1)

| ID | Item | Verdict | Evidence |
|----|------|---------|----------|
| C1 / G1 | **[GATE] P1 cross-host `Authorization` drop on socket redirector** | **PASS** | jsxinc:1608–1631 compares the **original** `ctx.parsed` (captured at 1296, never reassigned) against `next.url` via `_sameHost` (host+port, jsxinc:540–545) — the old self-comparison bug (baseline §6 G1) is gone. Filter also runs when only an explicit `Authorization` header is set (`hasAuth` scan, 1616–1619, no username required) and nulls `username`/`password` so no preemptive Basic resurfaces on later hops. QA wire proof: Q4 4/4 PASS (cross-host no Authorization; user/pw dropped; same-host may keep; non-credential headers survive) — test/REPORT.md (30-socket-wire.js:120–123). |
| C2 / G2 | **[GATE] `opts.json` consumed → `result.data` + `invalid-json`** | **PASS** | `_applyJsonOpt` (jsxinc:1668–1686) runs on both paths (called at 1638). 2xx + json: strict parse → `result.data`; parse failure → `error.code="invalid-json"` (protocol, retryable false), **status kept**, `data=null`; non-2xx / error results untouched (`data` key absent). Literal `"null"` body → `data=null, error=null` (valid parse, selftest jsxinc:1946-1947). QA: Q7 2x2 both paths PASS (REPORT 20-native-abi.js:80-81, 30-socket-wire.js:130-132). |
| C3 / G3 | **[GATE] `request(null)`/`request()`/`request(42)` → invalid-args Result, never throws** | **PASS** | `_buildContext` (jsxinc:1269–1273): null/undefined → `{}` (fails on missing url → invalid-args Result); other non-objects → `_ctxError("invalid-args")` caught at `_request` (jsxinc:1518–1526) → Result. QA: Q7 G3 3/3 PASS (REPORT 10-headless.js:39–41). |
| C4 / G4 | **[GATE] stray trailing comment in `_probeNative` removed** | **PASS** | Grep for the old cut comment: 0 matches. Catch block (jsxinc:899–906) now carries the G4 annotation; behavior unchanged (absent DLL → `dead=false` → re-probe allowed). |
| C5 / G5 | **[GATE] User-Agent precedence: explicit header wins** | **PASS** (wrapper half) | Resolved in `_buildContext` (jsxinc:1392–1400) **before** any ABI call: UA header present (case-insensitive) → `ctx.userAgent=null`; else `userAgent:""` → null; else default/opt string. Native: `userAgent:ctx.userAgent` (jsxinc:936) → `_jsonEncode` emits JSON null → espack.c parses `"userAgent":null` as J_NULL → `o->user_agent` stays NULL (espack.c:932–938) — **NULL survives the ABI**. Socket: UA written only when `!wroteUserAgent && ctx.userAgent` (jsxinc:1102) → exactly one UA on wire. QA: Q7 G5 8 PASS (REPORT 20-native-abi.js:82–86, 30-socket-wire.js:133–137). |
| R-G5-E1 | **HIGH t1 gate item: DLL must NOT substitute a default UA on the wire** | **FAIL — NOT LANDED** | `native/espack.c:1525-1526` still reads `LPCWSTR ua_w = opts.user_agent ? utf8_to_w(opts.user_agent) : L"eshttp/1.0.0"; HINTERNET hSession = WinHttpOpen(ua_w ? ua_w : L"eshttp/1.0.0", ...)`. When `opts.user_agent` is NULL (UA-suppressed or header-won), WinHTTP injects `User-Agent: eshttp/1.0.0` on the wire — violating api-spec §6.2 row 4 (suppressed → **no** header) and native-abi §3.1 (no default substitution). The request-header builder is already correct (espack.c:1230: `if (!have_ua && opts->user_agent)`) — **only the WinHttpOpen agent remains**. espack.c:53 comment already states the intended contract. Fix (one line): `WinHttpOpen(opts.user_agent ? ua_w : NULL, ...)`; keep the `free()` guard (1527). `espack_available()` probe at espack.c:1965 uses the literal but sends no request → acceptable. Wire-side proof must come from espark-dev's selftest.c capture (N16) + qa Q7 native suppressed-UA. Independently flagged by core-dev (`core/audit` v2, BLOCKER) and qa (`qa/status` v1, BLOCKER NOTE). |

**G1–G5 (C1–C5): 5/5 PASS. R-G5-E1: FAIL (not landed).**

---

## 3. t1–t4 deliverable & checklist verdicts

### t1 — NATIVE (espark-dev)

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| N1 | espack.c implements exactly the 5 exports, extern "C", __cdecl | **PASS** | Exports at espack.c:1944–1972 (espack_request, espack_last_error, espack_free, espack_version, espack_available) via ESPACK_API/ESPACK_CALL from espack.h (dllexport/extern/__cdecl); selftest hooks under `ESPACK_SELFTEST` (espack.c:1977–1989). |
| N2 | version "1.0.0"; available=1 when WinHTTP init OK | **PASS** | espack_version() → ESPACK_VERSION ("1.0.0", espack.h:49, espack.c:1962); espack_available() → WinHttpOpen probe (espack.c:1964–1972). |
| N3 | Every envelope carries "abi":"http-v1" (success AND error) | **PASS** | env_build emits ESPACK_ENVELOPE_ABI unconditionally (espack.c:1034); all 7 env_build call sites cover error paths (1377/1394/1411/1428/1479/1505) and success (1930). |
| N4 | Envelope schema matches native-abi §4 (ok/status/statusText/headers/body/bodyEncoding/error/meta incl. all 14 meta keys) | **PASS** | env_build emits every field (espack.c:1032–1097): path, method, finalUrl, redirects, timeMs, bytes, httpVersion, tlsVersion, encodingWasApplied, nativeVersion, winhttpError, backend. |
| N5 | error != null ⟺ no response; 4xx/5xx → ok:true, error:null | **PASS** | `e.ok = got_response`, `e.status = got_response ? status : 0` (espack.c:1905–1906); err_code set only on transport failure (1912–1917); 4xx/5xx flow through with error null (1853–1855 fall-through, 1867 `!err_code && got_response`). |
| N6 | Error codes ⊆ native-abi §5; unknown → internal | **PASS** | map_winhttp (espack.c:1106–1127) emits only §5 codes + default internal; JS-side unknown-code → internal (jsxinc:911–912). |
| N7 | NULL return ONLY on OOM/uninit; espack_last_error() set | **PASS** | NULL returns at espack.c:1508/1535 (uninit backend, last_error_set 1534), 1934 (OOM envelope); request wrapper handles NULL + last_error (jsxinc:962–973). |
| N8 | Host/Content-Length caller values ignored; computed by DLL | **PASS** | espack.c:1449 & 1456 skip `host`/`content-length` in headersJson parsing; WinHTTP computes both. |
| N9 | Redirects in-DLL: 301/302/303→GET+drop body, 307/308 preserve; Authorization dropped cross-host; maxRedirects cap; relative Location resolved; meta.redirects counted | **PASS** | Redirect loop (espack.c:1538–1856): 301/302/303 → GET + drop body (1837–1843), 307/308 preserve (default), Authorization dropped cross-host (1216–1221), maxRedirects → too-many-redirects (1811–1816), relative Location resolved (1818, url_resolve 766+), redirects counted (1846, reported 1921). |
| N10 | bodyIsBase64 decoded before send; Content-Length on decoded length | **PASS** | base64 decode + invalid→invalid-args error envelope (espack.c:1491–1512); CL from body_len passed to WinHttpSendRequest (1632–1634). |
| N11 | Text/binary sniffing + NUL guard (§4.1); UTF-8 everywhere | **PASS** | Content-type sniff list + NUL guard + empty-body→utf8 (espack.c:1866–1901); utf8_fix for text, base64 for binary (1049–1059); UTF-16 conversion for WinHTTP (utf8_to_w / w_to_utf8). |
| N12 | decompress → WINHTTP_OPTION_DECOMPRESSION when settable; silent identity fallback + encodingWasApplied:false; NO manual gzip inflate | **PASS** | espack.c:1612–1618 (option set → encoding_was_applied=1); silent fallback otherwise; no inflate code present. |
| N13 | Proxy semantics: null→DEFAULT, "direct"→NO_PROXY, host:port→NAMED | **PASS** | opts_parse (espack.c:951–975) → proxy_mode 0/1/2; applied at 1519–1523. |
| N14 | URL userinfo stripped; credentials never leak | **PASS** | url_parse strips userinfo (espack.c:676, comment 50–51); never mapped to Basic auth (Basic only from opts.username). |
| N15 | **native/BUILD.md present: MSVC x86+x64, /MT, install/placement, compilable source** | **FAIL — FILE MISSING** | No `native/BUILD.md` in the tree (native/ contains only espack.c + espack.h). README links to it in 3 places (README.md:92, 499, 535) — currently broken links. Build commands are documented only in espack.c header comment (espack.c:9–14). Required file. |
| N16 | **Selftest harness compiles and runs green (ESPACK_STATIC)** | **FAIL — FILE MISSING** | No `native/selftest.c`; `ESPACK_SELFTEST` hooks exist (espack.c:1977–1989) but no harness drives them. No compiler on the build machine (verified: cl/gcc/cc absent) — contract requires a compilable selftest.c + documented commands (N15/N16 evidence = source + harness, not a binary). Wire capture for R-G5-E1 (suppressed-UA → zero UA on wire) belongs here. |

**t1: N1–N14 PASS (code-review level), N15 FAIL, N16 FAIL, R-G5-E1 FAIL.**

### t2 — CORE (core-dev): PASS

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| C1–C5 | [GATE] G1–G5 fixes | **PASS** | see §2 above (5/5). |
| C6 | Never-throws regression | **PASS** | All validation → error Results; Q11 never-throw sweep (31 malformed inputs) PASS (REPORT 10-headless.js:55–56). |
| C7 | ES3 constraints intact | **PASS** | Grep: no let/const/arrow/class/template/destructuring/spread/rest/bind; all `.indexOf()` on strings (own `_arrIndexOf` only array helper, jsxinc:89–92); `.slice` at 740 is ES3-standard; no JSON/Promise/fetch/XHR/Map/Set; single self-contained file; IIFE. Corroborated by core/audit v2. |
| C8 | `eshttp._selftest()` 30+ checks green | **PASS** | 40+ checks in `_selftest` (jsxinc:1874–1960); suite 00-selftest 4/4 PASS in re-run. |

### t3 — QA (qa): PASS

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| Q1 | test/ suite: headless ES3 harness + mock-server | **PASS** | harness.js, mock-server.js, tcp-client.js, tests/00/10/20/30/90, README.md, REPORT.md all present. |
| Q2 | `_selftest()` green | **PASS** | 00-selftest 4/4. |
| Q3 | meta.abi http-v1 on every native response; tampered abi → degrade | **PASS** | 20-native-abi.js Q3 12/12 (abi on 200/404/error; tamper→socket; dead DLL; unparseable→internal; throwing→dead; 5-arg/11-key call shape). |
| Q4 | **[GATE] G1 cross-host Authorization drop test** | **PASS** | 4/4 (30-socket-wire.js:120–123). |
| Q5 | Non-ASCII round-trip (UTF-8 e2e) | **PASS** | 6/6 native+socket (20-native-abi.js:75–77, 30-socket-wire.js:124–126). |
| Q6 | Header lowercasing + repeated join (+Set-Cookie "; ") | **PASS** | 10/10 native + socket (incl. F-QA-1 regression, REPORT 30-socket-wire.js:129). |
| Q7 | **[GATE] G2/G3/G5 tests + R-G5-E1 regression coverage** | **PASS** (wrapper half) | 21/21: json both paths, request(null) never throws, UA precedence 8 cases, **R-G5-E1 suppressed-UA → optsJson.userAgent null at native responder boundary** (new test, 20-native-abi.js). Wire-side (DLL) half explicitly deferred to espark-dev selftest.c — QA cannot exercise the real DLL (fake ExternalObject stub only; no compiler). |
| Q8 | Socket path contract tests | **PASS** | 24/24 (HTTP/1.1, Host, CL, close, chunked, EOF, redirects 3xx/307/308, caps). |
| Q9 | Error taxonomy spot-checks + producible sets | **PASS** | 11/11 both paths. |
| Q10 | Transport tiers + diagnostics (7 keys) | **PASS** | 8/8. |
| Q11 | Never-throw sweep | **PASS** | 2/2 (31 malformed inputs). |
| Q12 | Documented pass/fail per file + single runnable command | **PASS** | REPORT.md generated by `node test/harness.js --all` (also `npm test`); 90-report 8/8. |

### t4 — DOCS (docs): PASS (conditional on N15)

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| D1 | README documents UA precedence (G5 rule) | **PASS** | README §User-Agent precedence (README.md:236–272) — 4-row table identical to api-spec §6.2, incl. `""` suppression. |
| D2 | README: espack.dll install/placement, both bitness, lib:espack, macOS note | **PASS** (conditional) | README.md:67–101 (resolution order, x86/x64 staging, macOS socket-only). **Condition:** links `native/BUILD.md` (92/499/535) which is still MISSING (N15) — D2 goes green only when BUILD.md lands. |
| D3 | README: verifyTls:false documented loudly | **PASS** | README §Security (README.md:396–424), matches api-spec §8 / native-abi §10 ruling #5. |
| D4 | README: no-manual-gzip note | **PASS** | README.md:164 (decompress degrades to identity, no manual inflate) + capability matrix 389. |
| D5 | Docs internally consistent with implementation after G1–G5 | **PASS** | api-spec §3 meta.encodingWasApplied/backend wording corrected (F1/F2 per checklist), §11 json now implemented, §8 redirect rules match C1; architecture.md §3 layout + §4.1 tier table reflect actual tree; verified against implementation this pass. |
| D6 | No contract wording changes implying a bump | **PASS** | http-api-v1 / native-abi-v1 unchanged; all changes docs-only or additive (R-OBS1, R-G5, rulings additive). |
| D7 | README marks v1.0.0 status | **PASS** | README.md:477+ (v1.0.0 status, implemented/shipped-as-source/not-in-v1). |

---

## 4. Remaining-risk list (must close for v1 PASS)

| # | Risk | Severity | Owner | Item | Close condition |
|---|------|----------|-------|------|-----------------|
| R1 | **WinHttpOpen agent substitutes `eshttp/1.0.0` when UA suppressed** → wire gets a UA the caller explicitly suppressed on the native path. Violates api-spec §6.2 row 4 + native-abi §3.1. | **HIGH** (contract violation, native path only) | espark-dev | R-G5-E1 | Land one-line fix at espack.c:1525-1526 (`WinHttpOpen(opts.user_agent ? ua_w : NULL, ...)`); prove zero UA on wire via selftest wire capture; re-run qa Q7 native suppressed-UA. |
| R2 | `native/BUILD.md` missing — MSVC x86+x64 build/install instructions only exist in espack.c header comment; 3 broken README links. | **MED** (hard deliverable N15) | espark-dev | N15 | Create native/BUILD.md (build commands, /MT, dual-bitness layout, lib:espack placement per native-abi §7, no-fake-DLL note). |
| R3 | `native/selftest.c` missing — no compiled harness; C internals (env_build, redirects, base64, proxy, UA wire capture) unverified by execution, only by code review. | **MED** (hard deliverable N16) | espark-dev | N16 | Create native/selftest.c driving the existing ESPACK_SELFTEST hooks (espack.c:1977–1989), statically linked (ESPACK_STATIC), green on a machine with MSVC; document run command in BUILD.md. |
| R4 | t4 (docs) still in flight; `docs/audit` blackboard key not yet posted. README verified aligned this pass; docs/audit v2 reference per checklist. | LOW (process) | docs | D-audit | Post blackboard `docs/audit` (v2 semantics per checklist line 52) confirming D1–D7. |
| R5 | Native path QA uses a fake ExternalObject stub (no real DLL compiled — build machine has no compiler, per ruling #3). Envelope-contract tests are wrapper-side only; real-DLL behavior (incl. R-G5-E1 wire proof, redirect loop, proxy, decompress) unverified end-to-end until a user builds espack.dll. | MED (environmental, documented) | qa + espark-dev | N16 / Q7 | Field-verify against a real build on a machine with MSVC; wire capture in selftest.c; document results. |
| R6 | `espack.h:75` doc comment says `userAgent string default "espack/1.0.0"` — slightly stale vs native-abi §3.3 (`string \| null`, no default substitution). Cosmetic, no behavior. | LOW (doc nit) | architect | — | Next docs pass: align espack.h:75 wording with §3.3 (or accept as mirror-of-default note). |

---

## 5. Gate-policy note & coordination trail

- **Gate policy applied:** R-G5-E1 is a HIGH t1 gate item with a real wire-behavior defect → overall **FAIL**, not PASS-with-conditions, because the defect is functional (not a documentation risk) and the two hard files (N15/N16) are absent. Per checklist policy, coordinator may ratify PASS-with-conditions if it deems R1–R3 non-blocking for v1 delivery intent; architect recommends FAIL until R1–R3 land, then re-verify (delta check only: R-G5-E1 fix, BUILD.md presence, selftest.c run, native/status key).
- **Coordination:** architect messaged espark-dev (urgent, with exact fix spec), docs (D-status + docs/audit request), coordinator (gate-state + PASS-with-conditions question), and broadcast a status poll. core-dev (`core/audit` v2) and qa (`qa/status` v1) independently reached the same R-G5-E1/N15/N16 blocker finding.
- **Blackboard:** `contracts/final-verdict` set by this report (see below); `core/audit` v2, `qa/status` v1 present; `native/status`, `docs/audit`, `contracts/rulings` v2 → pending t1/t4 completion.
- **Deliverables verified present:** native/espack.c (2000 lines), native/espack.h, src/eshttp.jsxinc (1982 lines), test/ suite (harness, mock-server, tcp-client, 5 suites, README, REPORT), README.md, docs/{api-spec,architecture,native-abi}.md, LICENSE, package.json. **Deliverables missing:** native/BUILD.md, native/selftest.c.
- **QA freshness:** architect independently re-ran `node test/harness.js --all` → **112 pass / 0 fail / 0 known-issue**, EXIT 0; test/REPORT.md regenerated at run time (not stale).

*Reported by architect (t-integrate) · 2026-08-09 · verdict-first, file:line evidence throughout.*
