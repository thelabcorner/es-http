# eshttp.json ⇄ ESON parity harness (task t4-eson)

Differential harness proving `eshttp.json.parse` / `eshttp.json.stringify`
behave like the ESON core on **the same vectors**. The subject is loaded via
`test/load-core.mjs` (shared with `test/harness.js`): the built TS core
(`dist/eshttp-core.esm.mjs`, `esm` lane) by default, or the original
`src/eshttp.jsxinc` (`ESHTTP_CORE=jsxinc`) as baseline. The D1–D7 divergence
manifest below is the contract either way.

## Run it

```
cd eshttp
node test/parity/parity.mjs        # or: npm run test:parity
ESHTTP_CORE=jsxinc node test/parity/parity.mjs   # baseline vs old source
```

Exit `0` = every required dimension green (all remaining divergences are the
documented manifest below). Exit `1` = unexpected behavioral divergence.

On the first run (or whenever `eson/tests/fixtures.ts` changes) the harness
rebundles eson's fixture module with esbuild (`eson-fixtures.mjs`,
gitignored). It needs eson's `node_modules` esbuild, or `ESBUILD_PATH` set.

## Sources of truth (both read-only)

- `eson/dist/eson-core.esm.mjs` — oracle (`parse`/`stringify`, json2 injected
  from `eson/vendor/json2.raw.js` via `install()`).
- `eson/tests/fixtures.ts` — the exact vectors (values, valid/invalid/security
  corpora, replacers).
- `eson/tests/eson-test-entry.ts` — hangClass, depth, reviver cases.

## Dimensions covered

1. parse valid corpus + targeted escapes — both accept, deep-equal.
2. parse invalid corpus + hangClass + targeted — both reject (eshttp: `null`,
   never throws; ESON: throws).
3. security fixtures — both reject (no execution).
4. nesting depth — 512 accepted, 513+ rejected (ESON MAX_DEPTH parity).
5. stringify value corpus — byte-for-byte vs ESON, with the documented
   divergence set classified per-vector.
6. root specials; 7. escape-vector table (control chars, surrogates, unicode
   ranges); 7. getter reads-once; 8. replacer/space (ESON-facade scope);
   9. reviver semantics; 10. round-trip lane parity.

## Documented divergences (decided 2026-08-09 — deliberate, contracted)

| id | Divergence | Rationale (file:line) |
|---|---|---|
| D1 | stringify: eshttp emits `\uXXXX` for ALL non-ASCII; ESON/json2 leave ordinary non-ASCII (letters/CJK/valid surrogate pairs) raw. Byte-only: both sides parse to identical values. | `src/eshttp.jsxinc` `_jsonQuote`; api-spec §5 "7-bit clean — UTF-8 ABI boundary"; asserted by `test/tests/10-headless.js` |
| D2 | stringify: cycles — ESON/json2 throw; eshttp emits `null` for the offending branch. | api-spec §5 "documented simplification"; `eshttp._selftest()` |
| D3 | stringify: no `toJSON`/Date hook — ESON/json2 call `value.toJSON()` (Date → ISO string); eshttp serializes by own shape (Date → `{}`). | api-spec §5 contract domain (Object/Array/string/number/boolean/null) |
| D4 | stringify: root `undefined`/function — ESON/json2 return `undefined`; eshttp returns the JSON text `null`. | always-a-string, never-throw posture |
| D5 | stringify: `replacer`/`space` args — ESON facade supports them; eshttp is 1-arg, extra args ignored. | api-spec §5 (`stringify(v)` single-arg) |
| D6 | parse: error signaling — ESON throws on invalid; eshttp returns `null` and coerces non-string input to `null`. Verdicts agree. | api-spec §5 "Never throws" |
| D7 | parse: a **throwing reviver** is swallowed to `null` by eshttp's never-throw contract; ESON propagates. (Reviver itself is supported in both.) | `src/eshttp.jsxinc` `_jsonParse`; never-throw contract |

## Fixes landed for parity (2026-08-09)

`src/eshttp.jsxinc`:

- **parse — RFC 8259 strictness** (`_jsonParseStrict`):
  - leading zeros rejected (`01`, `-01`, `00`, `-00`, `00.5`, `01e1`);
  - bare/trailing decimal rejected (`1.`, `-.5`, `.5`);
  - malformed `\u` escapes rejected (`\u12g4`, `\u000x`, `\u00zz` — the old
    `parseInt` truncation accepted non-hex tails);
  - raw control chars (U+0000–U+001F) inside strings rejected;
  - nesting depth capped at 512 (ESON MAX_DEPTH parity).
- **stringify** (`_jsonQuote`): control chars now use the json2/ESON short
  escapes `\b \f \n \r \t` (other `<0x20` as `\uXXXX`); 7-bit-clean non-ASCII
  `\uXXXX` unchanged.
- **reviver**: `eshttp.json.parse(text, reviver)` — json2 walk semantics
  (bottom-up, `this` = holder, `undefined` return deletes the key, root key
  `""`); never-throw preserved.

Regression guards: `test/tests/15-json-strictness.js` (14 tests, part of
`npm test`). The eson suite itself is untouched — `node tests/eson-test.mjs`
stays at its baseline.
