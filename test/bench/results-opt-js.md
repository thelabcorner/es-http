# opt-js Optimization Results — t2-js-opt

## Summary
Optimized `_base64EncodeBytes` (internal non-throwing base64 encode used for response `bodyBytes`) from a double-pass to a single-pass implementation.

## Change
**File:** `src/eshttp.jsxinc` (lines 611-630)

**Before (double-pass):**
1. First pass: mask each char to byte, build intermediate string via chunked joins
2. Second pass: call `_b64EncodeRaw` on the masked string

**After (single-pass fused):**
- Mask and encode in one loop, writing directly to the output buffer
- Fast path (latin1-only input) unchanged — still delegates to `_b64EncodeRaw`

## Harness Status
```
node test/harness.js --all
→ 176 pass / 0 fail / 0 known-issue (EXIT=0)
```
Original 162+ assertions still pass. No new failures introduced.

## A/B Benchmark — Slow Path (non-latin1 / binary input)

| Metric | Before (double-pass) | After (single-pass) | Delta |
|--------|---------------------|---------------------|-------|
| Total time (70k calls) | 11,074 ms | 3,528 ms | **-68.1%** |
| Per call (median) | 158.2 μs | 50.4 μs | **3.14x faster** |

**Test inputs:** 7 strings (11–5002 chars) containing non-latin1 chars (`\u0100`, `\u00e9`, `\x00`, etc.) that trigger the slow path.

## Fast Path Verification (latin1-only)
- Unchanged: still delegates to `_b64EncodeRaw` (no regression)
- Perf-bench baseline: ~36 μs for ~560 bytes (helpers.base64Encode)
- This optimization only affects the slow path used for binary/non-latin1 response bodies

## Impact
- Response body base64 encoding (for `bodyBytes` in Result) is now ~3x faster for binary/non-UTF8 payloads
- No change to public `base64Encode`/`base64Decode` helpers
- No change to JSON, URL parsing, or header building paths