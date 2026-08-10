# eshttp — QA test suite

Headless test suite for the eshttp core. **No Adobe host required.**

The library ships as a TypeScript core bundled by `eshttp-build.mjs` into
`dist/eshttp.jsx` (ES3 IIFE for Illustrator) + `dist/eshttp-core.esm.mjs`
(ESM core for Node). ExtendScript cannot be `require()`d, so the harness
loads the core via the shared loader `test/load-core.mjs`:

| source | artifact | how it loads |
|---|---|---|
| `esm` (default when built) | `dist/eshttp-core.esm.mjs` | ESM `import()`; the ExtendScript globals (`$`, `Socket`, `ExternalObject`, `File`, `Folder`, `app`) are staged on `globalThis` (the module references them as free variables, call-time `typeof`-guarded). The facade is the module's **default export** — mirrors the old `sandbox.eshttp` 1:1. |
| `iife` | `dist/eshttp.jsx` | vm sandbox eval — the verification lane for the shipping Illustrator artifact (global `eshttp` + public API contract). |
| `jsxinc` | `src/eshttp.jsxinc` | vm sandbox eval — the ORIGINAL pre-rewrite baseline, kept for parity measurement. |

Selection: `ESHTTP_CORE=esm|iife|jsxinc` env var, `--core <src>` flag, or
auto (`esm` when `dist/eshttp-core.esm.mjs` exists, else `jsxinc`).

## Run it

```
cd eshttp
node test/harness.js --all
```

That single command spawns both mock HTTP servers, runs every suite, prints a
pass/fail matrix, writes [`test/REPORT.md`](./REPORT.md), and exits `0` when all
acceptance items are green (`1` otherwise). Equivalent: `npm test`.

| Command | What it does |
|---|---|
| `node test/harness.js --all` | **Recommended.** Spawns mock servers, runs everything, writes `REPORT.md`. |
| `node test/harness.js` | Headless suites only — no network, no mock servers. |
| `node test/harness.js --net` | Network suites against *externally started* mock servers. |
| `node test/harness.js --all --core jsxinc` | Baseline run against the ORIGINAL `src/eshttp.jsxinc`. |
| `--base <url>` / `--cross <url>` | Override mock server URLs for `--net` (defaults `:18080` / `:18081`). |

To drive `--net` manually:

```
node test/mock-server.js --name cross --port 18081
node test/mock-server.js --name main  --port 18080 --crossPort 18081
node test/harness.js --net
```

> `eshttp/package.json` declares `"type": "commonjs"`. It exists **only** so the
> Node-based harness keeps working inside a workspace whose root `package.json`
> declares `"type": "module"` — without it Node 22 parses `test/*.js` as ESM and
> the suite dies with `ReferenceError: require is not defined`. The library
> itself has no Node dependency.

## Layout

| File | Role |
|---|---|
| `harness.js` | Runner: loads the core via `load-core.mjs` (`esm`/`iife`/`jsxinc`), fake eshttp.dll, test framework, reporting. |
| `load-core.mjs` | **Shared core loader** — source selection, ExtendScript global staging (vm sandbox for `iife`/`jsxinc`, `globalThis` for `esm`), fake `eshttp.dll` stub, Socket/File/Folder stubs. Also used by `parity/*.mjs` and `bench/bench.mjs`. |
| `mock-server.js` | Local cleartext HTTP mock: JSON, redirects (same-host **and cross-host**), 404/500, chunked, UTF-8, duplicate headers, slow/large bodies, plus raw-wire routes that emit exact bytes. Records every request so tests can assert what actually crossed the wire. |
| `tcp-client.js` | Synchronous TCP bridge. The ES3 `Socket` API is blocking and Node's is not, so the `Socket` stub shells out here with `spawnSync` — one real TCP connection per request. |
| `tests/00-selftest.js` | `eshttp._selftest()` — the library's own 40+ pure-helper checks. |
| `tests/10-headless.js` | Contract tests needing no I/O: validation, error taxonomy, transport tiers, never-throw sweep. |
| `tests/15-json-strictness.js` | eshttp.json RFC-8259 strictness + ESON-parity regressions (task t4-eson): leading zeros, bare decimals, malformed `\u`, raw control chars, depth 512, control-char short escapes, reviver. |
| `tests/20-native-abi.js` | Native envelope contract driven through the fake `eshttp.dll`. |
| `tests/30-socket-wire.js` | Socket path over **real TCP** against the mock servers. |
| `tests/50-artifact-contract.js` | Built `dist/eshttp.jsx` output-level audit: global `eshttp` + public API, unwrap footer (no `.default` leak), forbidden tokens == 0, ES3 shim present, no-defineProperty sandbox load. |
| `tests/90-report.js` | Meta-tests: the reporting contract and QA infrastructure itself. |
| `parity/` | **JSON differential harness** vs the ESON core (`parity/parity.mjs`, `parity/README.md`), ESB64 codec differential (`parity/esb64-parity.mjs`), adversarial never-throw audit (`parity/never-throw-audit.mjs`), and output-level token audit (`parity/audit-dist.mjs`). Runs eson's own vectors + json2 corpus through both implementations; exit 0 only when every non-documented divergence is gone. |
| `QA-VALIDATION.md` | QA-authored validation record for the TS-core retarget: parity verdict table, what changed in `test/`, native-lane status, compatibility-scanner output, the live-Illustrator P0 finding + fix, and what was not run. Read this for the acceptance verdict beyond the pass/fail matrix. |
| `REPORT.md` | Generated artifact. Never edit by hand. |

## Acceptance coverage (`review/integration-checklist.md` t3)

| Item | Requirement | Where |
|---|---|---|
| **Q1** | Headless ES3 harness + mock server, no Adobe host | `harness.js`, `mock-server.js`, `10-headless.js` |
| **Q2** | `eshttp._selftest()` runs green | `00-selftest.js` |
| **Q3** | `meta.abi === "http-v1"` on native responses; tampered `abi` marks the DLL dead and degrades to socket | `20-native-abi.js`, `30-socket-wire.js` |
| **Q4** | **[GATE]** G1 — cross-host redirect must NOT forward `Authorization` | `30-socket-wire.js` |
| **Q5** | Non-ASCII UTF-8 round-trip, end to end | `20-native-abi.js`, `30-socket-wire.js` |
| **Q6** | Header lowercasing, repeated-header `", "` join, `Set-Cookie` `"; "` join; OBS-1 `encodingWasApplied`/`backend` | `20-native-abi.js`, `30-socket-wire.js` |
| **Q7** | **[GATE]** G2 `json:true` + `invalid-json`; G3 `request(null)` never throws; G5 User-Agent precedence | all suites |
| **Q8** | Socket contract: HTTP/1.1, `Host`, `Content-Length`, `Connection: close`, chunked, read-to-EOF, 3xx manual/follow, too-many-redirects | `30-socket-wire.js` |
| **Q9** | Error taxonomy: categories + retryable per api-spec §7; socket producible set | `10-headless.js`, `30-socket-wire.js` |
| **Q10** | Transport tiers `auto→native→socket→none`; `forceTransport`/`resetTransport`/`transportInfo` (7 keys) | `10-headless.js`, `30-socket-wire.js` |
| **Q11** | Never-throw sweep across malformed inputs | `10-headless.js` |
| **Q12** | Documented pass/fail report from one command | `90-report.js` → `REPORT.md` |

## How the gate tests actually prove things

**Q4 (credential leak).** Two independent mock servers run on separate ports.
The test sends `Authorization: Bearer SUPER-SECRET-TOKEN` to `main`, which 302s
to `cross`. Both servers log every request, including `rawHeaders` (exact case,
every duplicate). The test asserts the credential reached `main`, and that
`cross` saw **zero** `Authorization` header lines on the wire — not merely that
a JS variable was cleared. Same-host redirects are asserted to *keep* the
credential, so an over-broad fix fails too.

**Q7 (User-Agent precedence).** Asserted against `rawHeaders`, so a duplicate
`User-Agent` is detectable. Covers all four rows of api-spec §6.2: explicit
header wins (case-insensitively), `opts.userAgent` used when no header,
documented default when neither, and `userAgent: ""` sending **no** header.

**Q8 (framing).** `eshttp` always sends `Connection: close`, so Node's own HTTP
writer would collapse every response to read-to-EOF and real chunked framing
could never be observed. The `/raw-*` routes detach the socket and write exact
bytes, letting the suite test genuine `Transfer-Encoding: chunked` (including
chunk extensions and trailers), pure read-to-EOF, `204`, duplicate header lines,
and malformed responses.

## Adding tests

Drop a file in `tests/`. It exports `function (suite, env)`:

```js
module.exports = function (suite, env) {
    suite.test("Q8 my new check", function () {
        env.assertEq(env.eshttp.request({ url: env.base + "/json" }).status, 200, "status");
    });
};
```

- **Prefix the label with the acceptance item** (`Q8 …`) — that is how the
  matrix is built. An unprefixed test still runs but scores no coverage.
- `env` provides: `eshttp`, `base`, `cross`, `net`, `coreSource` (what was
  loaded: `esm`/`iife`/`jsxinc`), `controls`
  (`setNativeResponder`, `setExternalObjectAvailable`, `setSocketAvailable`,
  `nativeState`), assertions (`assert`, `assertEq`, `assertNoThrow`,
  `assertThrows`), and log helpers (`resetServerLogs`, `fetchLogs`,
  `httpGetJson`).
- Guard network tests with `if (!env.net)`. Suites run in filename order with
  transport state reset between them; test functions may be `async`.
- Use `suite.knownIssue(ref, reason, label, fn)` for a confirmed upstream defect:
  it is reported loudly but does not fail the run. Convert it to `suite.test`
  the moment the owner fixes it — a known issue that starts passing should
  become a regression guard.

## Protocol

QA does not edit `src/*.ts`, `eshttp-build.mjs`, or `native/`. Defects are
reported to `core-dev` (core) or `espark-dev` (native) and re-tested after
they land. The built artifacts (`dist/eshttp.jsx`, `dist/eshttp-core.esm.mjs`)
are gitignored — run `npm run build` (or `npm test` with the `pretest` hook)
before the suites. `50-artifact-contract.js` and `parity/audit-dist.mjs` are
the output-level ES3 gates: they fail on forbidden tokens or a broken
`eshttp` global in the BUNDLED artifact, not the TS source.
