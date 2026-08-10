# Contract Baseline & Consistency Review (t0)

Status: **DONE** · Reviewer: architect (t-spec) · Date: 2026-08-09
Inputs read in full:
- `eshttp/docs/api-spec.md` (contracts/http-api-v1, binding public API)
- `eshttp/docs/architecture.md` (design; corrected this pass — see §7)
- `eshttp/docs/native-abi.md` (contracts/native-abi-v1, binding DLL ABI)
- `eshttp/native/espack.h` (ABI header mirror)
- `eshttp/src/eshttp.jsxinc` (draft ES3 implementation, 1854 lines)
- `eshttp/review/architect-draft-eshttp.jsxinc` (skimmed — superseded draft of
  the jsxinc, historical reference only; its `_ABI`/taxonomy match the current
  docs, no conflicts)

## Verdict summary

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 1 | ABI marker `"http-v1"` | **PASS** | consistent across native-abi.md, espack.h, jsxinc |
| 2 | Error taxonomy (§7 ↔ native-abi §5 ↔ `_ERRORS`) | **PASS** | 14 codes, categories, retryable all match; 1 doc nit fixed |
| 3 | Envelope schema (§4 ↔ `_nativeEnvelopeToResult`) | **PASS** | all §4 fields consumed correctly; 2 non-blocking observations |
| 4 | Request ABI params (§3.3 ↔ `_nativeRequest`) | **PASS** | 11 optsJson keys identical; arg order matches header |

**Overall: contracts are internally consistent. t1–t4 are UNBLOCKED.** No
contract-level drift blocks native/tests/docs work. 6 implementation gaps
found in the draft jsxinc (core-dev zone, §6) and 3 espark-dev
implementation notes (§8) — none block starting t1–t4.

---

## 1. ABI marker `"http-v1"` — PASS

| Source | Location | Marker |
|--------|----------|--------|
| native-abi.md §4 (envelope schema) | `"abi": "http-v1"` | `http-v1` ✓ |
| espack.h | `#define ESPACK_ENVELOPE_ABI "http-v1"` (line 52) | `http-v1` ✓ |
| eshttp.jsxinc | `var _ABI = "http-v1"` (line 58) | `http-v1` ✓ |

Cross-checks:
- jsxinc ABI enforcement (lines 980–987): envelope with `abi !== _ABI` → DLL
  marked dead, degrade to socket. Matches native-abi.md §7.1 ("treat the DLL
  as incompatible … degrade to socket").
- `meta.abi` on native results (jsxinc lines 1027, 1512) and
  `transportInfo().abi` (line 1676) both emit `_ABI`. Matches api-spec §3/§9.
- Envelope-parse failure / NULL return / thrown ExternalObject call → all
  three collapse to `"internal"` + `cache.dead = true` (lines 945–968),
  matching native-abi §4.4 NULL rules.
- espack.h also defines `ESPACK_ENVELOPE_ABI`; the not-yet-written `espack.c`
  must emit exactly this constant in **every** envelope including error
  envelopes (integration check item for t5).

## 2. Error taxonomy — PASS (1 doc nit fixed)

Code sets:
- api-spec §7 table: 14 codes — `invalid-args bad-url invalid-header
  unsupported dns connect network tls timeout aborted too-many-redirects
  body-too-large invalid-json internal`.
- jsxinc `_ERRORS` (lines 814–829): identical 14 codes.
- native-abi §5: 13 codes (no `invalid-json` — correct: it is JS-side only per
  api-spec §7).

Categories — all three sources agree (`usage|transport|tls|timeout|abort|
protocol|internal`):

| code | category | retryable |
|------|----------|-----------|
| invalid-args | usage | no |
| bad-url | usage | no |
| invalid-header | usage | no |
| unsupported | usage | no |
| dns | transport | **yes** |
| connect | transport | **yes** |
| network | transport | **yes** |
| tls | tls | no |
| timeout | timeout | **yes** |
| aborted | abort | no |
| too-many-redirects | protocol | no |
| body-too-large | protocol | no |
| invalid-json | protocol | no |
| internal | internal | no |

Cross-checks:
- Native mapping (jsxinc `_mapNativeError`, lines 905–911): DLL code → 1:1
  taxonomy; unknown DLL codes → `"internal"` (matches api-spec §7 mapping
  rule); `meta.winhttpError` copied to `detail.winhttp` (lines 990–993).
- `eshttp.error` constants = code strings (lines 830–834).
- Socket path producible set (jsxinc): invalid-args, bad-url, invalid-header,
  unsupported, network, timeout, too-many-redirects, body-too-large,
  internal — exactly the api-spec §7 socket subset. ✓

**Doc nit (fixed this pass, my zone):** architecture.md §4.1 said the
https-on-socket error uses `error.category = "tls"`; api-spec §7 and the
implementation both say `"unsupported"` is always category `"usage"`.
Corrected architecture.md to `usage` and clarified that non-`http(s)` schemes
(`ftp://`, `wss://`) fail pre-call validation with `"bad-url"` (api-spec §2),
not `"unsupported"`. Minor residual nit: api-spec §7's `"unsupported"` row
lists `ftp` as an example — misleading since §2 validation makes `ftp` a
`bad-url` before any driver sees it; acceptable as documentation flavor, not
worth a contract bump.

## 3. Envelope schema — PASS (2 observations)

native-abi §4 envelope fields vs `_nativeEnvelopeToResult` (jsxinc lines
1000–1031) + error path (lines 988–995, 1499–1515):

| Envelope field (§4) | Consumed? | Where |
|---------------------|-----------|-------|
| `abi` | yes — verified, mismatch → dead DLL | line 980 |
| `ok` | ignored (result.ok recomputed from status — correct per §4.3) | — |
| `status` | yes → `result.status` (0 when non-number) | line 1002 |
| `statusText` | yes | line 1013 |
| `headers` | yes (passthrough; lowercasing is DLL duty §4.2) | line 1003 |
| `body` | yes | line 1004 |
| `bodyEncoding` | yes — utf8 vs base64 branch | lines 1006–1008, 1016 |
| `error` | yes — `_mapNativeError` + winhttpError→detail.winhttp | lines 988–995 |
| `meta.path` | implied ("native") | line 1019 |
| `meta.method` | not forwarded (Result meta has no `method` key — OK, §3) | — |
| `meta.finalUrl` | yes → `result.meta.url` | line 1020 |
| `meta.redirects` | yes | line 1021 |
| `meta.timeMs` | yes | line 1022 |
| `meta.bytes` | yes (fallback `_utf8ByteLength(body)`) | line 1023 |
| `meta.httpVersion` | yes | line 1026 |
| `meta.tlsVersion` | yes | line 1025 |
| `meta.encodingWasApplied` | **dropped** (see OBS-1) | — |
| `meta.nativeVersion` | yes → `result.meta.nativeVersion` | line 1028 |
| `meta.winhttpError` | yes → `error.detail.winhttp` | lines 990–993 |
| `meta.backend` | **dropped** (see OBS-1) | — |

body/bodyText (§4.1) — PASS:
- `bodyEncoding "utf8"` → `body = bodyText = env.body`. ✓
- `bodyEncoding "base64"` → `body = _base64Decode(env.body)`, `bodyText =
  env.body` (base64, display-safe). ✓ matches api-spec §3 ("bodyText … base64
  form for binary bodies").

Error-shaped envelope (§4.3) — PASS: `error != null ⟺ no response`;
4xx/5xx → envelope `ok:true`, `error:null`, JS computes `result.ok` from
status. jsxinc recomputes from `status` (line 1011), so even a non-conforming
envelope `ok` flag cannot corrupt the Result.

OBS-1 (non-blocking): `meta.encodingWasApplied` and `meta.backend` are
dropped — api-spec §3's Result `meta` does not define them, so this is not a
violation; but qa cannot observe `encodingWasApplied` through the public API
to test decompress behavior. Consider exposing both (additive) in
`result.meta` for v1 — cheap, useful. Flag to core-dev as optional.
OBS-2 (non-blocking): `result.headers` passthrough trusts the DLL to
lowercase keys and join repeats per §4.2 — must be covered by a qa test
against a mock server (integration item).

## 4. Request ABI params — PASS

native-abi §3.3 optsJson keys vs what `_nativeRequest` actually sends
(jsxinc lines 925–939):

| §3.3 key | sent by `_nativeRequest` | type source |
|----------|--------------------------|-------------|
| `timeoutMs` | `ctx.timeout` | ✓ number |
| `redirect` | `ctx.redirect` ("follow"/"manual") | ✓ |
| `maxRedirects` | `ctx.maxRedirects` | ✓ |
| `verifyTls` | `ctx.verifyTls` | ✓ bool |
| `userAgent` | `ctx.userAgent` | ✓ string |
| `username` | `ctx.username` (null allowed) | ✓ |
| `password` | `ctx.password` (null allowed) | ✓ |
| `proxy` | `ctx.proxy` (null = system proxy) | ✓ |
| `decompress` | `ctx.decompress` | ✓ bool |
| `maxBodyBytes` | `ctx.maxBodyBytes` | ✓ number |
| `bodyIsBase64` | `ctx.bodyIsBase64 === true` | ✓ bool |

- Call shape: `accel.espack_request(ctx.method, ctx.url, headersJson, body,
  optsJson)` — exact 5-arg order of the espack.h / §2 prototype. ✓
- `headersJson` = `_headersToJsonObject(ctx.headers)` — `{name: string |
  string[]}` per §3.1 (repeated pairs collapse to arrays, line 680–696). ✓
- `body` = UTF-8 byte string via `_utf8Encode`, or the raw base64 string when
  `bodyIsBase64` (line 941). ✓ matches §3.2.
- optsJson is always fully populated (all 11 keys) even when
  username/password/proxy are null — JSON `null` values are valid per §3.3. ✓
- espack.h doc comment lists the same 11 keys (lines 71–83). ✓

## 5. Additional cross-checks (all PASS)

- `DEFAULTS` (api-spec §2.1) == jsxinc `_defaults` (8 keys, same values);
  getter returns a fresh copy each access (replacement-safe); `configure`
  shallow-merges and returns previous defaults. ✓
- Public surface (§1): request/get/post/put/del/json/configure/
  forceTransport/resetTransport/transportInfo/transport/DEFAULTS/error all
  present; only global leak is `eshttp` on `$.global` (test hooks are
  properties on `eshttp` itself). ✓
- `transportInfo()` (§9): host/platform/transport/externalObjectAvailable/
  socketAvailable/nativeVersion/abi — all 7 keys present. ✓
- Transport tiers (architecture §4.1): auto → native → socket → none;
  `forceTransport`/`resetTransport` implemented; DLL-mismatch degrade path
  implemented (lines 1482–1498). ✓
- Socket driver (§10): HTTP/1.1 + Host + Connection: close + computed
  Content-Length; header/body read to EOF with Content-Length and chunked
  support; `meta.timeoutEnforced=false`; `s.close()` in `finally`. ✓
- Redirects (§8): socket path JS redirector implements 301/302/303→GET (drop
  Content-Type/Content-Length) and 307/308 preserve; `maxRedirects` cap →
  `too-many-redirects`; `meta.redirects` counted. — **but see G1 (cross-host
  Authorization drop is broken).**
- ES3 constraints (§12): var/function only, own loops, no
  map/filter/forEach/indexOf reliance (own `_arrIndexOf`), embedded JSON
  parser, single self-contained file, IIFE. `Object.defineProperty` used for
  `transport`/`DEFAULTS`/publish — available in ExtendScript; publish has a
  try/catch fallback. ✓

## 6. Implementation gaps found in draft jsxinc (owner: core-dev)

| ID | Sev | Clause | Gap |
|----|-----|--------|-----|
| G1 | **P1** (security) | api-spec §8 | Socket-path redirector cross-host `Authorization` drop is broken: line 1550 `_sameHost(_urlString(p || ctx.parsed), next.url)` — `p` is parsed from the *new* URL (`ctx.url` was already reassigned at line 1537), so it compares the new URL to itself → guard never fires → Authorization/username/password forwarded to a different host on the socket path. Fix: compare original URL (`ctx.parsed`) against `next.url`. |
| G2 | P2 | api-spec §11 | `opts.json` validated & stored (line 1369) but never consumed — no `result.data`, `invalid-json` unreachable. RULED binding for v1.0.0 (see message to docs). |
| G3 | P2 | api-spec §2/§3 | `eshttp.request(null)` / `request()` / `request(42)` throws TypeError inside `_buildContext` (opts.method access) instead of returning an `invalid-args` Result — violates never-throws. Guard non-object `opts`. |
| G4 | P3 | native-abi §7.1 | `_probeNative` line 898–899: trailing/cut comment ("No: cache absence.") — cosmetic only; behavior (absent DLL → not dead → re-probe) is correct. |
| G5 | P3 | native-abi §3.1/§3.3 | User-Agent precedence: wrapper always sends `opts.userAgent` (default "eshttp/1.0.0"); if the caller also sets a `User-Agent` header, both reach the DLL. Need a rule — recommend explicit header wins. Espark + core-dev to confirm; document in README. |

## 7. Doc corrections made this pass (my zone)

- `eshttp/docs/architecture.md` §4.1: https-on-socket error category `"tls"`
  → `"usage"`; `wss://` removed (bad-url pre-call); `ftp://` → `"bad-url"`
  pre-call (was "unsupported"). Aligns architecture.md with binding
  api-spec §7 and the implementation. No contract bump (docs-only wording;
  http-api-v1 / native-abi-v1 unchanged).

## 8. espark-dev implementation notes (for t1)

1. `espack.h` `ESPACK_ENVELOPE_ABI` must be emitted in **every** envelope,
   including error envelopes (§4 + §7.1). NULL return only on OOM/uninit
   (§4.4) — then `espack_last_error()` must be set.
2. `Host`/`Content-Length` supplied by the wrapper in `headersJson` must be
   **ignored** (the wrapper does not filter them on the native path; §3.1
   puts the obligation on the DLL). Same for `User-Agent` duplication rule
   (G5).
3. `optsJson` always arrives fully populated; `username`/`password`/`proxy`
   may be JSON `null` (valid, §3.3). `redirect` is always "follow"/"manual".
4. URL may arrive with `userinfo` (`https://user:pw@host/...`) — strip before
   any message/meta output (per §10 rulings: credentials never leak); decide
   and document whether userinfo maps to preemptive Basic auth.
5. `verifyTls:false` → documented-only per §10 ruling #5.
6. Decompress fallback per §10 ruling #2: on
   `WINHTTP_OPTION_DECOMPRESSION` failure, no Accept-Encoding +
   `meta.encodingWasApplied:false`; no manual gzip inflate in C.
7. Proxy semantics per §10 ruling #4: null → DEFAULT_PROXY, "direct" →
   NO_PROXY, "host:port" / "http://host:port" → NAMED_PROXY.

## 9. qa notes (for t3)

- Add a test that `result.meta.abi === "http-v1"` on every native response
  and that a tampered envelope `abi` degrades to socket (G-exempted).
- Add a test for G1 once fixed: cross-host redirect on socket path must not
  forward Authorization.
- Add non-ASCII round-trip test (native-abi §6: UTF-8 end-to-end).
- Add header-lowercasing + repeat-join test on the native path (OBS-2).
- `eshttp._selftest()` exists (line 1770) with 30+ pure helper checks for the
  headless harness; verify it runs green.

---

*Baseline published to blackboard `contracts/baseline` and broadcast as
handoff; t1 (espark-dev), t2 (core-dev), t3 (qa), t4 (docs) are UNBLOCKED.*
