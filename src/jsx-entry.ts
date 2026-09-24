// ESHTTP JSX-only entry (ESTC canonical emission).
//
// SIDE-EFFECT ONLY — deliberately exports nothing. esbuild emits its
// export-namespace helpers (__export/__defProp/__copyProps) only when the
// ENTRY MODULE has exports; those helpers require Object.defineProperty /
// Object.getOwnPropertyDescriptor, which are absent or version-sensitive on
// some ExtendScript engines. With no entry exports the emitted IIFE contains
// no descriptor-dependent helper at all, so the strict-engine path (no
// Object.defineProperty, no __defineGetter__) keeps working exactly like the
// pre-rewrite jsxinc.
//
// The facade itself is published by ./index (guarded data-descriptor publish
// onto the session global, plain-assignment fallback). The ESTC footer
// (tooling/estc-unwrap-footer.js) binds the eval-scope `eshttp` global from
// that publish for #include / $.evalFile consumers.
//
// The Node/ESM surface stays on ./index (default export) and is emitted
// separately as dist/eshttp-core.esm.mjs — this entry is never used there.
import './index';
