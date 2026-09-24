// ESHTTP host-global declarations (Illustrator-agnostic module boundary).
//
// Ambient declarations for host globals not present in lib.es5. ALL are
// runtime-guarded with typeof probes at CALL time before use; the
// declarations exist only for typechecking. Nothing here may be referenced
// at module-eval time (the Node ESM import path stages these on globalThis;
// the vm-sandbox QA harness provides them per-run).
//
// Two of these are NOT host globals: ESON_ACCEL_BUNDLE / ESB64_ACCEL_BUNDLE
// are string literals injected by the ESTC prelude (extendscript.estc.config.mjs
// — the embedded self-extracting sibling bundles; see vendor-json.ts /
// vendor-b64.ts). They are never parsed by esbuild.
//
// T28 (merge architecture v1): the merged-bundle facades ESON / ESB64 (and
// the espack loader ESPAK) are published on the session global by the
// composer's facade artifacts — vendor-json.ts / vendor-b64.ts CONSUME them
// by name (sessionGlobal().ESON / .ESB64) with the embedded strings as the
// plain-build fallback. They are read via the session-global object, so no
// ambient declarations are needed here (the same typeof-guarded access
// pattern as $.global).
//
// ESTC overlay (extendscript.estc.config.mjs additionalTypes): under the
// toolchain's noLib compiler environment the pinned Types-for-Adobe
// declarations supply ObjectConstructor/Error/String/ExternalObject shapes
// that omit the APIs this library actually uses. The narrow interface
// augmentations below are type-only and match the verified host surface
// (ESTC evidence/illustrator-30.6-host-features.json: Object.defineProperty /
// getOwnPropertyDescriptor / getOwnPropertyNames and Function.prototype.bind
// are present on Illustrator 30.6; ES3 Error.prototype.name is standard).
// They never emit code and never relax a runtime guard.

declare var $: {
  os: string;
  global: any;
  fileName: string;
  getenv(name: string): string;
  sleep(ms: number): void;
};

declare var app: {
  name: string;
  version: string;
};

declare var ExternalObject: any;

declare var Socket: any;

declare var File: any;

declare var Folder: any;

declare var console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

// Node global (ESM core import path); typeof-guarded.
declare var global: any;

// Embedded self-extracting sibling bundles (injected by the ESTC prelude).
declare var ESON_ACCEL_BUNDLE: string;
declare var ESB64_ACCEL_BUNDLE: string;

/* ------------------------------------------------------------------ *
 * Narrow type-only overlays (ESTC noLib environment)
 * ------------------------------------------------------------------ */

interface ObjectConstructor {
  defineProperty(obj: any, prop: any, desc: any): any;
}

interface Error {
  name: string;
}
