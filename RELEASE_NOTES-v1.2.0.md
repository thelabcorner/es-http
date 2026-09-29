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
- Full Node QA harness: **205/205 assertions passed** across 10 suites and the Q1-Q12 matrix.
- ESON parity: **753 assertions, 0 failures**; ESB64 parity: **103,711 checks passed** (`seed 42`, 5,000 fuzz iterations).
- Never-throw audit: **736/736 public-entry checks** returned a Result; distribution audit found no forbidden tokens.
- Manifest-v2 static contract: **PASS** for both x64/x86 identity, provenance, capability, order, and single-control-plane/dedup invariants.
- ESTC static/live parse: all standalone, native accelerator, x64/x86 v2 root, and jsxinc surfaces pass on Adobe Illustrator 30.6.0 / ExtendScript 4.5.6.
- Cold manifest-v2 proof: **PASS**; evaluating only the x64 root activates `ESB64 -> ESON -> ESHTTP`, preserves borrowed ESON native ownership, and deduplicates repeated evaluation.
- Existing live localhost contract: **10/10 checks passed**, including the **46-check** in-engine self-test and a real 200 response through the CLI transport.
- Final composed UTF-8 sizes: x64 **628,222 B**; x86 **574,306 B**.

## Release assets

- `eshttp.jsx`
- `eshttp-native-accel.jsx`
- `eshttp-native-accel-x86.jsx`
- `eshttp.accel-x64.jsx`
- `eshttp.accel-x86.jsx`
- `eshttp.accel-x64.manifest.json`
- `eshttp.accel-x86.manifest.json`
- corresponding x64/x86 CLI and IPC native payloads
