# es-http v1.0.0 — 2026-08-10

**SemVer: 1.0.0 (first release)** — this is the initial tagged release of
`es-http`; the repository has never shipped a release before, so there is no
bump-type comparison against a prior version. The story of what changed
*from the pre-rewrite hand-written `eshttp.jsxinc` draft* is context
(architecture + quality), not a breaking-change migration — no caller code
existed against a previous release.

Gate: 204 Node assertions (ESM lane) / 204 Node assertions (IIFE lane, the
shipping `dist/eshttp.jsx`) / 753/0 JSON differential vs ESON (D1–D7
documented divergences as contracted) / 103,711/0 base64-UTF-8 differential
vs ESB64 / 736/0 never-throw audit / 0/0 dist output audit / 166/0 native
selftest (statically-linked engine) / ES3 scanner clean (only the ratified
bannerless `#target` rule) / live gate PASS on Illustrator 30.6.0
(Wikipedia's W SVG fetched through the host firewall, status 200, 2440 B,
placed into a document as paths, pageDelta 1). All green on this commit.

### Added

- **Three-transport architecture with automatic degradation** — `native`
  (eshttp.dll, WinHTTP: HTTPS/TLS 1.2+, real timeouts, redirects, proxy,
  gzip) → `cli` (separate-process firewall-escape) → `socket` (pure ES3) →
  `none`, selected lazily and cached. One identical API
  (`request/get/post/put/del/json`) on every path — see README
  "Why es-http?" and `docs/architecture.md`.
- **Firewall-escape cli transport** — a per-app outbound firewall rule
  matching `Illustrator.exe` blocks the host process's network (WinHTTP
  12029); es-http never modifies firewall rules. The cli lane runs the same
  v2 engine in a separate process image (job-file one-shot, verified live:
  ~400 ms done-poll, 200, 2440 B through the firewall) with the named-pipe
  persistent-worker lane as the v1 primary — see README "The firewall-escape
  transport (cli)" and `docs/cli-transport.md`.
- **ESON + ESB64 DLL-accelerated codecs (vendored)** — `eshttp.json` (RFC
  8259 strict parse, never-throws face) and base64/UTF-8 delegate to the
  embedded sibling accel bundles (native when loadable, internal ES3 lane
  otherwise). Parity pinned by the differential suites — see README
  "Vendored codecs".
- **Native ABI v2** — canonical Adobe ExternalObject direct-interface
  (`ESInitialize`/`ESGetVersion`/`ESFreeMem`/`ESTerminate` + 4 business
  methods), host-owned `kTypeString` strings freed via `ESFreeMem`; the old
  caller-frees `eshttp_free` was a double-free design flaw and is removed —
  see `docs/native-abi.md`.
- **Host-derived default User-Agent (errata, additive)** —
  `"eshttp/1.0.0 (Adobe <app> <version>; <platform>)"` when the host exposes
  name+version, static `"eshttp/1.0.0"` otherwise; leading token preserved
  (wire-compatible); explicit-header-wins and `""`-suppresses precedence
  absolute — see README "User-Agent precedence" and `docs/api-spec.md` §6.2.
- **TypeScript source + esbuild pipeline** — the 2496-line hand-written
  `eshttp.jsxinc` is replaced by 18 var-only strict-TS modules bundled to a
  bannerless ES3 IIFE (`dist/eshttp.jsx`) + ESM core — see README
  "Repository layout" and `eshttp-build.mjs`.
- **Single-file accel bundle** — `dist/eshttp.accel.jsx` (934,619 B) packs
  the binaries and stages them byte-exact to `%LOCALAPPDATA%\eshttp` on
  first eval — see README "Which build should I use?".

### Fixed

- **Live-only unwrap-footer P0 (V8-invisible).** The built IIFE passed every
  Node gate but failed to load in real Illustrator: esbuild's export
  namespace emits an unquoted `default:` key (ES3 parse error) and
  ExtendScript's `Object.defineProperty` eagerly evaluates getters, so the
  `eshttp = eshttp.default || eshttp` footer ran before the default binding
  existed. Root cause: Node V8 is strictly more permissive than the ES3
  parser at the esbuild-IIFE seam. Fix: ES3-safe unwrap footer + a
  strict-engine sandbox (`test/tests/50-artifact-contract.js`) reproducing
  the ES3 parser and eager-getter semantics in CI. Covered by the artifact
  contract regression gate — see README "Engine quirks".
- **`!(compound)` operator precedence mis-compilation.** An unparenthesized
  compound range check mis-parses in the ES3 parser (and esbuild strips the
  "redundant" parens, triggering it). Fix: every compound range check
  isolated into its own local variable; bundled output audited — see README
  "Engine quirks".
- **Live-only ES3 parser blockers (found by the live gate).** An OBS-1
  nested-ternary construct and five trailing-slash regex literals pass Node
  V8 and fail only in the real engine. Fixed in the wrapper; the same
  strict-engine mechanism catches the class — see README "Engine quirks".
- **WinHTTP 12029 "failures" were environmental, not code.** The native
  transport was verified working (200, 2440 B) the moment the host firewall
  rules were lifted in a controlled experiment (immediately re-enabled); the
  fix is the cli firewall-escape transport, not a code change to the DLL
  lane — see README "The firewall-escape transport (cli)".

### Performance

- **Cli one-shot lane (measured):** complete HTTPS fetch of a 2440-byte SVG
  through the firewall — done-poll ~400 ms (WinHTTP connect/TLS + process
  spawn + job-file round trip), Illustrator 30.6.0 — see
  `test/QA-VALIDATION.md`.
- **Cli pipe lane (v1 primary, measured):** wrapper-transport overhead vs
  one-shot — pipe (warm, named-pipe) **median 0.064 ms / p95 0.157 ms /
  sd 0.039 ms (n=10)** vs oneshot (job-file) **median 2.819 ms / p95 3.413
  ms / sd 0.350 ms (n=10)**, ~44x pipe/oneshot (same-run pair,
  `test/parity/pipe-bench.mjs`, node v22.23.2 win32 x64, fake responders, no
  network); pipe cold-with-spawn (ensureWorker included) 0.260 ms warming to
  0.064 ms — the persistent worker amortizes spawn + WinHTTP cold-start to
  zero. Live release-accel spot-check: Wikipedia W SVG fetched through the
  real worker over the named pipe, 200/2440 B, zero errors (`meta.path:
  "cli"`, Illustrator 30.6.0).
- **Codec lanes (vendored):** native ESB64 encode/decode ≈ 2.5–3.2 ms for
  360 KB vs a pure-JSX `charCodeAt` loop that wedges the engine past
  ~128 KB (sibling repos' measured numbers; the ES3 fallback keeps the
  chunked-flush pattern) — see README "Performance".

### Security

- Host-owned string lifetime enforced on the native boundary (no
  caller-frees export; the double-free hazard is removed by design).
- cli job-file parser hardened: line/file caps, CR/LF + `\r` handling,
  `done`-path traversal rejection, stale-job sweep at startup — see
  `docs/cli-transport.md`.
- The pipe lane is local kernel IPC (`\\.\pipe\EshttpBridge`), not network
  traffic — no firewall rule is ever modified and the per-app egress rule
  never sees it.

### Compatibility

- First release: Windows x64/x86 (native + cli transports) and macOS
  (socket only, cleartext `http://`; `https://`  `"unsupported"`).
  Illustrator 30.6.0 live-verified; other hosts expected but not yet
  live-verified (host-neutral ES3 code).

### License

- GPL-3.0-or-later (relicensed from MIT for the v1.0.0 release, matching the
  es-family license and the embedded ESON/ESB64 GPL bundles) — see
  [LICENSE](LICENSE).

---

*Release body drafted per the es-family release-notes spec
(`agent-skills/readme-spec/references/release-notes.md`): every line carries
a number, a test name, or a README section link; no emoji, no images, no
unbacked superlatives. Gate numbers from `test/QA-VALIDATION.md`,
`deliverable/T11`, and `native/selftest-run-v2.txt` (166/0). Pipe-lane perf
row intentionally held until the T21 measurement lands.*
