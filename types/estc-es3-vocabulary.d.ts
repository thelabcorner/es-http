// ESTC-only TypeScript vocabulary (compile-time only).
//
// The shared toolchain type-checks with `noLib: true` against the pinned
// Types-for-Adobe declarations. Those declarations reference the TypeScript
// standard-library utility type `Extract<T, U>`; with no default lib loaded
// the compiler reports TS2318 ("Cannot find global type 'Extract'").
//
// This file supplies that vocabulary for the ESTC build only. It emits no
// runtime code, makes no host/API claim, and is deliberately OUTSIDE the
// project's own tsconfig include set (`src/**/*.ts`, `test/**/*.ts`) so the
// normal `npx tsc --noEmit -p .` (which has the ES5 lib) is unaffected.
type Extract<T, U> = T extends U ? T : never;
