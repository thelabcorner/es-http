# es-http v1.0.1 — 2026-08-10

**SemVer: minor** — packaging restructure + transport-default change; the
public API (`http-api-v1`) and all `meta.path` values are unchanged, so no
call-site migration is required. (A minor bump because the default transport
tier changes behavior for existing callers — auto-selection now prefers the
cli pipe lane — while every API surface stays identical.)

Gate: 204 Node assertions (ESM lane) / 204 Node assertions (IIFE lane, the
shipping `dist/eshttp.jsx`) / 753/0 JSON differential vs ESON (D1–D7
documented divergences as contracted) / 103,711/0 base64-UTF-8 differential
vs ESB64 / 736/0 never-throw audit / 0/0 dist output audit / 166/0 native
selftest / release-assets verify EXIT 0 / live release-accel spot-check PASS
(Wikipedia W SVG 200/2440 B through the real worker over the named pipe,
`meta.path: "cli"`, zero errors, Illustrator 30.6.0). All green on this
commit.

### Added

- **Per-bitness pipe accels** — `dist/eshttp.accel-x64.jsx` (cli x64 + ipc
  x64) and `dist/eshttp.accel-x86.jsx` (cli x86 + ipc x86): each bundle
  carries only the worker + bridge for one bitness — no dead payloads, and
  the one-file accel is smaller than the v1.0.0 four-payload bundle. See
  README "Which build should I use?".
- **Separate native build** — `dist/eshttp-native-accel.jsx` (or plain
  `eshttp-x64.dll` / `eshttp-x86.dll` release assets): the in-process
  WinHTTP lane ships standalone, opt-in, and is no longer packed inside the
  default pipe accel.
- **Pipe-vs-native-DLL head-to-head measurement** — README Performance:
  pipe median 0.071–0.078 ms vs native-DLL 0.084–0.141 ms (ratio 0.55–0.87x,
  N=10 warm 5, 3 runs, same harness, fake responders). Framing is honest
  parity, not a speed claim: at the wrapper level the pipe lane is at parity
  with, or marginally cheaper than, the in-process ExternalObject boundary;
  both are sub-0.15 ms, so real-world comparisons are network-dominated.

### Changed

- **Default transport is now the cli pipe lane.** Tier order
  `cli(pipe) → cli-oneshot → native(opt-in) → socket → none` (was
  `native → cli → socket → none`). The cli pipe lane escapes per-app
  firewall rules by construction and needs no DLL staging; the native
  in-process accelerator is reached via `forceTransport("native")` or by
  staging the separate native build. API and `meta.path` values unchanged.
- **Measurement honesty:** the v1.0.0 release notes' "design target ~15–20
  ms spawn amortized to ~0" language is replaced by the measured numbers
  (pipe warm median 0.064 ms vs one-shot 2.819 ms, ~44x; cold-with-spawn
  0.260 ms). No unmeasured claim appears anywhere.

### Fixed

- **Accel adapter regex terminator trap (live-only, V8-invisible).** The
  adapter's regex `/[\\/]+$/` — an unescaped `/` inside a character class is
  the ES3 regex-literal terminator (skill L451–453) — parsed under Node V8
  but threw "Expected: )" in the real ExtendScript parser. Fixed with a
  `charCodeAt` trim; the release accel now evals live (verified in the live
  spot-check). Counted among the V8-invisible live-only catches (plan §14
  lesson 7).

### Performance

- Pipe (warm, named-pipe): median 0.064 ms / p95 0.157 ms / sd 0.039 ms
  (n=10) vs one-shot (job-file): median 2.819 ms / p95 3.413 ms / sd 0.350
  ms (n=10) — ~44x (dual-source, build-engineer + qa-validator, to the
  decimal; `test/parity/pipe-bench.mjs`, fake responders, no network, node
  v22.23.2 win32 x64). Cold-with-spawn 0.260 ms warming to 0.064 ms
  (spawn-amortization evidence).
- Pipe vs native-DLL (driver-level): ~1x parity (see Added).

### Security

- Unchanged from v1.0.0: host-owned strings on the native boundary, cli
  job-file hardening, pipe lane as local kernel IPC (never network
  traffic), no firewall rule ever modified.

### Compatibility

- Unchanged from v1.0.0: Windows x64/x86 (pipe + native), macOS socket-only
  cleartext; Illustrator 30.6.0 live-verified. The pipe lane requires
  `File.execute`-capable hosts (all Adobe ExtendScript hosts).

---

*Release body drafted per the es-family release-notes spec
(`agent-skills/readme-spec/references/release-notes.md`): every line carries
a number, a test name, or a README section link; measured numbers only
(T21 + T25), no fabricated claims; no emoji, no images. The real-DLL vs
real-pipe live comparison remains unverified-live (no firewall window per
sponsor) and is stated as such, not fabricated.*
