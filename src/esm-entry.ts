// ESHTTP Node/ESM entry (consumed only by dist/eshttp-core.esm.mjs).
//
// The facade object is published onto the session global by src/index.ts (and
// bound as the global `eshttp` by the ESTC JSX footer). This ESM-only module
// re-exports it as the default export so the Node QA harness (test/load-core.mjs)
// can `import()` the facade object. Keeping the default export HERE — not in
// src/index.ts — means the shared TypeScript core stays export-free, so esbuild
// never synthesizes the __toCommonJS/__export descriptor helpers that legacy
// ExtendScript engines cannot run.
import { eshttp } from './index';

export default eshttp;
