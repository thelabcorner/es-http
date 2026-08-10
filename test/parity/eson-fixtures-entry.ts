// eson fixtures re-export — bundled to ESM by parity.mjs so the differential
// harness runs the EXACT vectors eson/tests/fixtures.ts defines (zero drift).
// Source of truth: eson/tests/fixtures.ts (read-only sibling repo).
export {
  makeValues,
  makeRootSpecials,
  makeReplacerCases,
  makeValidJson,
  makeInvalidJson,
  makeSecurityFixtures
} from '../../../eson/tests/fixtures';
