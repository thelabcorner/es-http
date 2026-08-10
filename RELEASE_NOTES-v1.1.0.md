# es-http v1.1.0 — 2026-08-10

**SemVer: minor** — merged 1+n accel composition + facade-based codec
consumption; the public API (`http-api-v1`) and all `meta.path` values are
unchanged, so no call-site migration is required. (Minor because the
distribution artifacts are re-composed and the codec resolution gains a
facade path — existing callers observe identical behavior.)

Gate: 204 Node assertions (ESM lane) / 204 Node assertions (IIFE lane, the
shipping `dist/eshttp.jsx`) / 753/0 JSON differential vs ESON (D1–D7
documented divergences as contracted) / 103,711/0 base64-UTF-8 differential
vs ESB64 / 736/0 never-throw audit / 0/0 dist output audit / 166/0 native
selftest / release-assets verify / **live merged-accel spot-check PASS**
(Wikipedia W SVG fetched through the real worker over the named pipe —
OK|cli|200|2440, facades present, codec lane verified
`base64Encode("f") === "Zg=="` never-throws, zero errors, Illustrator
30.6.0; transcript in `deliverable/T29`). All green on this commit.

### Added

- **Merged 1+n accel composition (espack merge spec)** — the per-bitness
  accels (`dist/eshttp.accel-x64.jsx` 926,878 B, `dist/eshttp.accel-x86.jsx`
  872,807 B) are now merged bundles: ONE loader object (no nested `var
  ESPAK`), ONE shared ESB64Native accelerator deduped across the merged
  ESON/ESB64/eshttp manifests, and flat payloads (ESONJson + worker +
  bridge for the bundle's bitness only). Facades (ESON/ESB64) are appended
  before the library evals. See README "Merge-spec composition".
- **Facade-based codec consumption (T28)** — the codec adapters resolve
  `sessionGlobal().ESON` / `.ESB64` first (typeof-guarded, cached once,
  stale/hostile-global defense), falling back to the embedded-string
  lazy-eval in the plain build. Frozen codec contract preserved: never-throw
  parse, cycle→null stringify, 7-bit-clean, lenient base64, the 18-helper
  test-hook surface, and the D1–D7 parity manifest.

### Changed

- The v1.0.1 direct-composition accels are **superseded by the merged
  composition** (same filenames, new contents — one loader, deduped shared
  accelerator, name-based extraction because merged indexes are not stable).
  Plain `dist/eshttp.jsx` behavior is identical (the embedded strings remain
  as the fallback path).
- Artifact sizes: accel-x64 693 → 927 KB, accel-x86 639 → 873 KB (facades +
  merged loader), `dist/eshttp.jsx` 339 KB, ESM core 330 KB.

### Fixed

- Nothing behavior-changing in the library this release (the v1.0.1 fixes —
  the accel regex terminator trap and the five V8-invisible ES3 catches —
  carry forward; see v1.0.1 release notes).

### Performance

- Unchanged measured figures: pipe (warm) median 0.064 ms vs one-shot 2.819
  ms (~44x, T21, dual-source); pipe vs native-DLL at wrapper parity
  (0.071–0.078 vs 0.084–0.141 ms, ~1x, T25). Real-DLL vs real-pipe live
  comparison remains unverified-live (no firewall window per sponsor).

### Security

- Unchanged from v1.0.1: host-owned strings on the native boundary, cli
  job-file hardening, pipe lane as local kernel IPC, no firewall rule ever
  modified. The merged loader is a single flat object — no nested-loader
  eval surface.

### Compatibility

- Unchanged from v1.0.1: Windows x64/x86 (pipe + native), macOS socket-only
  cleartext; Illustrator 30.6.0 live-verified. The merged accels eval in a
  vm sandbox (23/23 checks) and live (accel-x64 OK).

---

*Release body drafted per the es-family release-notes spec
(`agent-skills/readme-spec/references/release-notes.md`): every line carries
a number, a test name, or a README section link; measured numbers only, no
fabricated claims; no emoji, no images.*
