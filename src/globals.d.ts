// ESHTTP host-global declarations (Illustrator-agnostic module boundary).
//
// Ambient declarations for host globals not present in lib.es5. ALL are
// runtime-guarded with typeof probes at CALL time before use; the
// declarations exist only for typechecking. Nothing here may be referenced
// at module-eval time (the Node ESM import path stages these on globalThis;
// the vm-sandbox QA harness provides them per-run).
//
// Two of these are NOT host globals: ESON_ACCEL_BUNDLE / ESB64_ACCEL_BUNDLE
// are string literals injected by eshttp-build.mjs BEFORE the bundle (the
// embedded self-extracting sibling bundles — see vendor-json.ts /
// vendor-b64.ts). They are never parsed by esbuild.

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

// Embedded self-extracting sibling bundles (injected by eshttp-build.mjs).
declare var ESON_ACCEL_BUNDLE: string;
declare var ESB64_ACCEL_BUNDLE: string;
