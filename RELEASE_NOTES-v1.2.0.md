# ESHTTP v1.2.0 — 2026-09-29

**SemVer: minor** — the public `http-api-v1` surface and transport semantics remain compatible; the shipped accelerated distributions gain canonical ESPACK 0.5 manifest-v2 composition for both Windows bitness targets.

## Changed

- Added per-bitness ESPACK v2 manifests and root bundles for x64 and x86.
- Both roots resolve the dependency-first library closure:
  `esb64@1.3.0 -> eson@1.3.0 -> eshttp@1.2.0`.
- Exact UTF-8 library provenance, payload byte lengths/SHA-256s, activation contracts, and explicit native/file capabilities are recorded in each manifest.
- x64 composition carries `ESONJson`, `eshttp-cli`, and `eshttp-ipc-x64`; x86 carries `ESONJson`, `eshttp-cli-x86`, and `eshttp-ipc-x86`.
- The shared ESB64 native accelerator and ESON native capability remain optional capability layers; ESHTTP's CLI file and IPC payloads are required for their corresponding composed distributions.
- The root bundles use one persistent `$.global.ESPAK` control plane rather than synthetic legacy manifests or ad-hoc sibling concatenation.
- ESON consumes ESPACK-loaded native state as borrowed ownership inside the composed distribution.
- The live gate now includes an explicit cold manifest-v2 root proof before the existing deterministic localhost transport contract.

## Verification

- `npm run release:gate`: exit 0 on the final v1.2.0 release candidate.
- Typecheck, deterministic build, full Node harness, ESON parity, ESB64 parity, never-throw audit, distribution audit, and manifest-v2 checks: pass.
- ESTC static and live parse: pass for standalone, native accelerator, x64/x86 v2 roots, and jsxinc surfaces.
- Manifest-v2 live proof: evaluating only the x64 root activates ESB64 -> ESON -> ESHTTP transitively and deduplicates the library identities on repeat evaluation.
- Existing live localhost HTTP contract: pass on Adobe Illustrator 30.6.0 / ExtendScript 4.5.6 through COMTool V2.

## Release assets

- `eshttp.jsx`
- `eshttp-native-accel.jsx`
- `eshttp-native-accel-x86.jsx`
- `eshttp.accel-x64.jsx`
- `eshttp.accel-x86.jsx`
- `eshttp.accel-x64.manifest.json`
- `eshttp.accel-x86.manifest.json`
- corresponding x64/x86 CLI and IPC native payloads
