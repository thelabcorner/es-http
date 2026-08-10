# t1-native handoff — native accelerator gate GREEN (2026-08-09)

**Status: COMPLETE.** `native/selftest.c`: **157 pass / 0 fail / exit 0 /
"ALL GREEN"** (built as `eshttp-selftest.exe` — renamed from
`espack-selftest.exe` per the coordinator's naming decision, 2026-08-09; see
the "exe rename" note below). `espack-x64.dll` + `espack-x86.dll` rebuild
cleanly (exactly 5 exports each, verified with `dumpbin /exports`), and the
x64 DLL was smoke-tested end-to-end via `LoadLibrary` (bad-url / invalid-args
/ connect error envelopes all correct). `native/BUILD.md` written (N15).

This file is the durable handoff because the native-dev session lost its swarm
membership token in the server restart and can no longer broadcast / mark the
task complete. The task `t1-native` remains "claimed" by the native-dev member
record; coordinator can mark it complete from the digest.

---

## Every fix (file:line in `native/` — all verified by rebuild + rerun)

### `espack.c`

| # | Fix | Location (approx, current file) | Impact |
|---|---|---|---|
| 1 | **P0 url_parse scheme**: `ci_eq(p,"http")` (full-string equality) -> `ci_starts(p,"http")` (prefix, with exact length check) | url_parse scheme block (~L704) | EVERY `http://`/`https://` URL was rejected as "unsupported scheme" — the real DLL failed every request |
| 2 | `ci_starts` typo `b - 'A' + 'b'` -> `+'a'` | ~L240 | latent wrong comparison for uppercase prefixes |
| 3 | **jv_free J_OBJ child-count overrun**: `i < j->n * 2` -> `i < j->n` (n is already the child count; key+value each pushed) | jv_free (~L376) | frees 2x children -> `free(garbage)` -> the 0xC0000005 startup crash |
| 4 | `obj_get` off-by-2: iterate `i += 2` over `v[i]/v[i+1]` | obj_get (~L401) | out-of-bounds read on any object with 1+ pair |
| 5 | headers loop: same off-by-2 fix | engine (~L1532) | OOB read in the headersJson loop |
| 6 | **WinHTTP two-step size queries**: statusText / httpVersion / raw headers were gated on the first call's return value — the first call with NULL buffer *always* fails (ERROR_INSUFFICIENT_BUFFER), so the real query never ran | (~L1760-1810) | empty `headers` in every envelope, no `statusText`, no `httpVersion`, **redirects never followed** (no Location) |
| 7 | **raw response headers are UTF-16**: convert with `w_to_utf8` before `parse_response_headers` | (~L1795) | headers were parsed as char* over wide bytes (every ASCII char followed by NUL) -> always empty |
| 8 | `bodyEncoding` length: `w_str(..., 5)` -> `6 : 4` ("base64"/"utf8") | env_build (~L1156) | before: `"utf8\x00"` embedded NUL / truncated `"base6"` in the envelope |
| 9 | `url_resolve` RFC 3986 §5.2.4: added `remove_dot_segments` (in-place, path-only), dot-segment normalization on resolved relative paths, base-path computed WITHOUT query | (~L813-945) | `../c` now resolves to `/c`; `?q=../d` query dots preserved; query never duplicated |
| 10 | `has_crlf` also rejects NUL (header-truncation hardening) | ~L975 | defense-in-depth |
| 11 | opts injection guards: `userAgent`/`username`/`password` with CR/LF/NUL -> "invalid-args" | opts_parse (~L1063) | **header injection via `userAgent: "x\r\nX-Evil: 1"` blocked** |
| 12 | URL CR/LF/NUL guard -> "bad-url" | url_parse | request-line injection blocked |
| 13 | header single-value leak: `str_ndup(k->s,...) ? k->s : k->s` -> `k->s` | engine (~L1539) | leaked a dup per single-string header |
| 14 | removed dead buggy `query_header_str` (same size-query bug) | — | dead code |
| 15 | `#pragma comment(lib, "winhttp.lib")` | top of file | `/TC` misread `.lib` on the command line as a C source (C1083); BUILD.md commands updated to match |
| 16 | **raw-headers length reuse** (`hl` passed to the copy call) -> separate `hl2` + `calloc(hl + sizeof(wchar_t))` zero-padded buffer | raw-headers block (~L1838-1852) | the copy call could receive a shrunk length / unterminated UTF-16 buffer; headers now always parse (this completed the redirect-follow + body-sniffing fixes) |
| 17 | **Authorization scheme-downgrade strip**: `https://host` -> `http://host` redirect (same host) now drops `Authorization` (RFC 9110 §9.6.4) — added `hop_https`/`first_https` params | build_request_headers (~L1345-1352) + engine (~L1684, ~L1744) | credentials never replayed over cleartext; 4 new selftest checks |

### Exe rename (2026-08-09, coordinator decision)

The selftest binary was renamed `espack-selftest.exe` -> `eshttp-selftest.exe`
(project-prefixed; the DLL keeps its contract-baked name `espack.dll` /
`lib:espack`). References updated in `selftest.c`, `espack.c`, `native/BUILD.md`;
stale `espack-selftest*.exe/.obj/.pdb` artifacts removed. Nothing outside
`native/` referenced the old exe name (test harness uses a fake ExternalObject
stub, never the exe).

### `selftest.c`

- b64_encode success contract: `== 0` -> `!= 0` (encode returns 1 on success).
- b64_decode reject case: `"aGVs"` is *valid* unpadded base64 -> use `"ab"`
  (len%4) and `"a!Vs"` (invalid chars).
- Added 2 security-guard assertions: CRLF userAgent -> invalid-args; CRLF URL
  -> bad-url.
- Removed all temporary debug traces; fixed the header build comment.

## R-G5-E1 (UA suppression) — confirmed complete + wire-verified

- `WinHttpOpen(ua_w, ...)` with `ua_w = NULL` when suppressed (session agent is
  what WinHTTP appends to every request — NULL sends nothing).
- `build_request_headers`: default UA added only when caller supplied none AND
  `opts.user_agent` non-NULL; explicit User-Agent header wins, never duplicated.
- `espack_available` uses a fixed agent only for its session-probe — no wire
  bytes, so harmless.
- Selftest wire captures prove: `userAgent:null` -> **0** "user-agent" bytes;
  normal -> exactly 1; explicit header -> exactly 1 and `opts.userAgent` does
  not leak.

## Build / run evidence

```
cl /nologo /TC /MT /O2 /D ESPACK_STATIC /D ESPACK_SELFTEST
   /D WIN32_LEAN_AND_MEAN /D _CRT_SECURE_NO_WARNINGS selftest.c
   /Fe:eshttp-selftest.exe
eshttp-selftest.exe          -> 157 pass / 0 fail / exit 0 / ALL GREEN

cl /nologo /TC /LD /MT /O2 /D ESPACK_BUILD /D WIN32_LEAN_AND_MEAN
   /D _CRT_SECURE_NO_WARNINGS espack.c /Fe:espack-x64.dll
dumpbin /exports espack-x64.dll  -> exactly 5: espack_request, espack_last_error,
                                    espack_free, espack_version, espack_available
espack-x86.dll                 -> same, machine 14C (x86)
dll-smoke.exe (temp, LoadLibrary) -> version=1.0.0 available=1; ftp:// -> bad-url;
                                    CRLF userAgent -> invalid-args; refused port -> connect (12029)
```

Toolchain note: `vcvars64.bat` is broken (no vswhere). Exact working env is in
`native/BUILD.md` §1.1 (MSVC 14.29.30133 + SDK 10.0.19041.0, set INCLUDE/LIB/PATH
directly).

## Security audit summary (native path)

- **Buffer overflows:** reviewed buf_t growth, b64 encode/decode length math,
  JSON parser (`tmp[64]` bounded), snprintf call sites, sscanf widths — no
  overflows found; all writes length-bounded.
- **NUL handling:** response bodies with NUL -> base64 (sniffing guard);
  header name/value/UA NUL now rejected; envelope writer is length-based.
- **Header injection:** CR/LF/NUL rejected for header names, header values
  (string + array), `userAgent`, `username`, `password`, and the URL itself.
- **Redirect auth leaks:** `Authorization` dropped on cross-host redirect AND
  on any scheme change (https->http downgrade, RFC 9110 §9.6.4)
  (build_request_headers), verified on the wire by selftest (127.0.0.1 ->
  127.0.0.2 hop has zero credential bytes; same-host keeps it) + 4 unit checks
  for the downgrade rule.
- **URL userinfo:** stripped in url_parse, never re-emitted (url_tostring /
  finalUrl sanitized); verified by selftest + probe matrix.
- **Envelope pure-ASCII:** w_str escapes non-ASCII to \uXXXX (incl. surrogate
  pairs) and all control chars; bodyEncoding length bug fixed.
- **maxBodyBytes:** enforced in the read loop before buffering; body-too-large
  error path present.

## Known limitations / not run

- No automated tests for the DLL in the JS harness (20-native-abi.js uses a
  harness stub, not the real DLL) — the binary is covered by selftest + smoke.
- IPv6 host with port was probe-verified only (no IPv6 loopback server test).
- Absolute URL with dot segments (`http://h/z/../w`) passes through
  un-normalized (documented subset; selftest asserts passthrough).
