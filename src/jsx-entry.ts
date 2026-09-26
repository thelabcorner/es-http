// ESHTTP JSX-only entry (ESTC canonical emission).
//
// SIDE-EFFECT ONLY — deliberately exports nothing. esbuild emits its
// export-namespace helpers (__export/__defProp/__copyProps/__toCommonJS) only
// when the ENTRY MODULE (or its re-exported graph) carries exports; those
// helpers require Object.defineProperty / Object.getOwnPropertyDescriptor,
// which are absent or version-sensitive on some ExtendScript engines. With no
// entry exports the emitted IIFE contains no descriptor-dependent helper at
// all, so legacy engines keep working exactly like the pre-rewrite jsxinc.
//
// The facade is assembled by ./index. This entry imports it as a NAMED VALUE
// (not a bare `import './index'`, which would make esbuild preserve the whole
// re-export graph and re-introduce the helper bridge) and publishes it onto the
// session global. The ESTC footer (tooling/estc-unwrap-footer.js) then binds
// the eval-scope `eshttp` global from that publish for #include / $.evalFile
// consumers.
//
// The Node/ESM surface stays on ./esm-entry (default export) and is emitted
// separately as dist/eshttp-core.esm.mjs — this entry is never used there.
import { eshttp } from './index';

// Explicit publish (mirrors src/index.ts's guarded publish, idempotent here):
// guarantees the facade is on the session global even before the footer runs.
var __eshttpGlobal = null;
try { if (typeof $ !== 'undefined' && $.global) { __eshttpGlobal = $.global; } } catch (e1) {}
if (__eshttpGlobal && eshttp) { __eshttpGlobal.eshttp = eshttp; }

// Module-identity marker only: forces this .ts entry to remain ESM under the
// package's `type: commonjs` boundary without exporting a runtime value.
export {};
