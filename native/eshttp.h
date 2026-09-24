/*
 * eshttp.h — Public ABI for eshttp.dll, the eshttp native HTTP accelerator.
 *
 * Contract: eshttp/docs/native-abi.md (contracts/native-abi-v2, binding).
 * Implemented by t-native (eshttp). Consumed by core-dev (eshttp.jsxinc /
 * driver-native.ts) and audited by qa (t-integrate).
 *
 * Backend: WinHTTP (declared in envelope meta as "backend":"winhttp").
 *
 * ABI: ExtendScript ExternalObject direct interface through pinned ESABI
 * v0.3.0. Its Windows LONG32 profile is live-verified on Illustrator 30.6.0;
 * ESABI owns value layout, tags, status codes, packing, and cdecl.
 * host calls every export with (argv, argc, retval); the ESInitialize
 * signature string drives the host's argument casting.
 *
 * Exports (exactly 8): 4 mandatory ES* lifecycle + 4 business methods.
 *   ESInitialize(esabi_value*, long) -> signature metadata string (malloc'd,
 *     freed via ESFreeMem like any returned string — ESON verified pattern)
 *   ESGetVersion() -> long (= 1, exposed as ExternalObject.version)
 *   ESFreeMem(void*) -> void (free; matches the malloc/calloc of every
 *     returned buffer)
 *   ESTerminate() -> void (session cache cleanup)
 *   eshttp_request / eshttp_version / eshttp_last_error / eshttp_available
 *
 * Memory rules (native-abi v2 §4.4):
 *   - The HOST frees every ESABI_TYPE_STRING return via ESFreeMem (= free). The
 *     DLL NEVER returns a static buffer: version/last_error/request all
 *     return malloc'd copies. There is NO caller-side free function
 *     (eshttp_free was removed in v2 — calling it was the double-free flaw).
 *   - ESABI_TYPE_STRING (4) returns are UTF-8, null-terminated, malloc'd.
 *   - Methods never return negative error codes (fatal/uncatchable);
 *     ESABI_OK (0) on success, ESABI_ERR_BAD_ARGUMENTS (20) on bad args.
 */
#ifndef ESHTTP_H
#define ESHTTP_H

#include <esabi/esabi.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ESABI v0.3.0 is the sole ExternalObject ABI authority. ESHTTP owns only
 * its HTTP API and memory/state behavior; value layout, tags, status codes,
 * packing, and calling convention come from ESABI. */

/* ---- export/import decorators ---- */
#if defined(ESHTTP_BUILD)
#  define ESHTTP_API __declspec(dllexport)   /* building the DLL (MSVC) */
#elif defined(ESHTTP_STATIC)
#  define ESHTTP_API extern                  /* statically linked (selftest) */
#else
#  define ESHTTP_API __declspec(dllimport)   /* consuming the DLL */
#endif

#define ESHTTP_CALL ESABI_CALL

/* ---- version ---- */
#define ESHTTP_VERSION_MAJOR 1
#define ESHTTP_VERSION_MINOR 0
#define ESHTTP_VERSION_PATCH 0
#define ESHTTP_VERSION "1.0.0"

/* ---- ABI marker (must match the JS-side constant) ---- */
#define ESHTTP_ENVELOPE_ABI "http-v1"

/* ---- mandatory ES* lifecycle exports (exactly these 4) ---- */

/* Return the signature metadata string: comma-separated `name_<argcodes>`.
 * v2 (native-abi-v2, pinned): no-arg methods declared with a dummy `_f`
 * argument (skill: bare no-arg names are unreliable; ESON uses _f for all
 * no-arg methods, e.g. version_f — the JSX side passes a dummy 0).
 * Signature string (FINAL): "eshttp_request_sssss,eshttp_last_error_f,
 * eshttp_version_f,eshttp_available_f".
 * Returns a MALLOC'd string (freed via ESFreeMem, ESON verified pattern). */
ESHTTP_API char* ESHTTP_CALL ESInitialize(esabi_value* argv, esabi_long argc);

/* Version exposed as the read-only ExternalObject.version property (= 1). */
ESHTTP_API esabi_long ESHTTP_CALL ESGetVersion(void);

/* Release a buffer the DLL returned. MUST match the DLL's allocator (free). */
ESHTTP_API void ESHTTP_CALL ESFreeMem(void* p);

/* Release persistent native state (session cache) during unload. */
ESHTTP_API void ESHTTP_CALL ESTerminate(void);

/* ---- exported business methods (exactly these 4) ---- */

/* Perform one blocking HTTP request.
 *   argv[0] method      "GET","POST",...  non-NULL, ASCII token
 *   argv[1] url         absolute http(s):// URL, non-NULL, UTF-8
 *   argv[2] headersJson JSON object {name: string|array-of-strings} or ""
 *   argv[3] body        UTF-8 byte string, or ""
 *   argv[4] optsJson    JSON object (see below) or ""
 * All 5 are ESABI_TYPE_STRING per the `_sssss` signature cast.
 *
 * retval: ESABI_TYPE_STRING (4) = freshly malloc'd UTF-8 JSON envelope (see
 * eshttp_envelope_* below), host-freed via ESFreeMem. Returns ESABI_OK.
 * On NULL-arg/type mismatch returns ESABI_ERR_BAD_ARGUMENTS (catchable).
 *
 * optsJson keys (unknown keys ignored; wrong types -> "invalid-args"):
 *   timeoutMs      number  default 30000   (0 = no timeout, discouraged)
 *   redirect       "follow"|"manual" default "follow"
 *   maxRedirects   number  default 5       (follow only)
 *   verifyTls      bool    default true    (false disables cert validation)
 *   userAgent      string|null (null = a User-Agent header already won in
 *                               headersJson, or the caller suppressed it;
 *                               DLL adds NO default, native-abi §3.1/§3.3)
 *   username       string  (-> preemptive Authorization: Basic)
 *   password       string
 *   proxy          null | "direct" | "host:port" | "http://host:port"
 *                  default null = system proxy (WinHTTP default)
 *   decompress     bool    default true    (Accept-Encoding gzip/deflate +
 *                                          auto-decompress when supported)
 *   maxBodyBytes   number  default 52428800 (50 MiB cap on response body)
 *   bodyIsBase64   bool    default false
 */
ESHTTP_API esabi_error ESHTTP_CALL eshttp_request(
    esabi_value* argv, esabi_long argc, esabi_value* retval);

/* Last error message (UTF-8, human, no credentials). retval: ESABI_TYPE_STRING =
 * malloc'd copy of the last error (host-freed via ESFreeMem). "" when there
 * is no error. Call with a dummy 0 (`eshttp_last_error_f` signature). */
ESHTTP_API esabi_error ESHTTP_CALL eshttp_last_error(
    esabi_value* argv, esabi_long argc, esabi_value* retval);

/* Static version string "major.minor.patch" e.g. "1.0.0". retval:
 * ESABI_TYPE_STRING = malloc'd copy (host-freed via ESFreeMem). Always callable
 * (liveness probe). Call with a dummy 0 (`eshttp_version_f` signature). */
ESHTTP_API esabi_error ESHTTP_CALL eshttp_version(
    esabi_value* argv, esabi_long argc, esabi_value* retval);

/* 1 if the WinHTTP backend initialized successfully, else 0. retval:
 * ESABI_TYPE_INTEGER (123). Lets the wrapper health-check without a network call.
 * Call with a dummy 0 (`eshttp_available_f` signature). */
ESHTTP_API esabi_error ESHTTP_CALL eshttp_available(
    esabi_value* argv, esabi_long argc, esabi_value* retval);

/* ---- response envelope schema (the return value of eshttp_request) ----
 *
 * One shape for success AND failure — the ok/error fields tell them apart:
 *
 * { "abi": "http-v1",              REQUIRED envelope contract marker
 *   "ok": true,                    true iff a response was received (any status)
 *   "status": 200,                 0 when no response
 *   "statusText": "OK",            reason phrase; "" when no response
 *   "headers": { "content-type": "application/json" },  lowercased keys;
 *                                  repeated headers joined ", "
 *                                  (Set-Cookie joined "; ")
 *   "body": "...",                 decoded string: UTF-8 text when
 *                                  bodyEncoding=="utf8", else base64
 *   "bodyEncoding": "utf8"|"base64"
 *   "error": null | { "code": "timeout", "message": "...", "category": "...",
 *                     "retryable": false },
 *                                  non-null ONLY when no HTTP response
 *   "meta": { "path": "native",
 *             "method": "GET",
 *             "finalUrl": "https://...",   after redirects
 *             "redirects": 0,
 *             "timeMs": 123,              wall time, integer ms
 *             "bytes": 456,               decoded body byte length
 *             "httpVersion": "1.1",
 *             "tlsVersion": "1.2",        null on plain http
 *             "encodingWasApplied": false,
 *             "nativeVersion": "1.0.0",
 *             "winhttpError": null,       raw WinHTTP code on transport error
 *             "backend": "winhttp" } }
 *
 * error.code values (mapped 1:1 to api-spec §7 taxonomy):
 *   bad-url invalid-args invalid-header dns connect network tls timeout
 *   aborted too-many-redirects body-too-large unsupported internal
 */

#ifdef __cplusplus
}
#endif

#endif /* ESHTTP_H */
