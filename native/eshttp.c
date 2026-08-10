/*
 * eshttp.c — eshttp.dll, the eshttp native HTTP accelerator (WinHTTP backend).
 *
 * Contract: eshttp/docs/native-abi.md (contracts/native-abi-v2, binding).
 * ABI header: eshttp.h (this file implements exactly its 8 exports).
 * Implementer: t-native (eshttp). Consumed by core-dev (driver-native.ts /
 * eshttp.jsxinc), audited by qa (t-integrate).
 *
 * Build (MSVC, C mode):
 *   cl /nologo /TC /LD /MT /O2 /D ESHTTP_BUILD /D WIN32_LEAN_AND_MEAN
 *       /D _CRT_SECURE_NO_WARNINGS eshttp.c /Fe:eshttp2-x64.dll
 *   (winhttp.lib is linked via #pragma comment(lib) — do NOT pass it on the
 *   command line, because /TC would force the compiler to read it as a
 *   source file. x86: same with the vcvars32 environment. See BUILD.md.)
 *   NOTE: the loaded eshttp.dll is LOCKED in a running Illustrator session
 *   (LNK1104 on rebuild) — iterate with numbered names (eshttp2.dll, ...)
 *   per the externalobject-extendscript skill (L551-554).
 * Selftest (statically linked, no DLL):
 *   cl /nologo /TC /MT /O2 /D ESHTTP_STATIC selftest.c /Fe:eshttp-selftest.exe
 *
 * ABI (native-abi v2, pinned): canonical ExtendScript ExternalObject
 * DIRECT-INTERFACE shape `long fn(TaggedData* argv, long argc,
 * TaggedData* retval)` (SoSharedLibDefs.h ESFunction), live-verified on
 * Illustrator 30.6.0 via the sibling ESON prototype (eson/native/eson_json.c).
 * ESInitialize signature string (FINAL):
 *   "eshttp_request_sssss,eshttp_last_error_f,eshttp_version_f,eshttp_available_f"
 *   — no-arg methods declared with a dummy `_f` (bare no-arg names are
 *   unreliable per the skill; ESON uses _f for all no-arg methods); the JSX
 *   wrapper passes a dummy 0. eshttp_free is REMOVED (v2).
 *
 * Memory rules (native-abi v2 §4.4):
 *   - The HOST frees every kTypeString return via ESFreeMem (= free). The
 *     DLL NEVER returns a static buffer: eshttp_version/eshttp_last_error/
 *     eshttp_request all return malloc'd copies. No caller-side free.
 *   - Envelopes are emitted as pure-ASCII JSON (see below).
 *
 * Envelope rules (native-abi §4):
 *   - Every envelope carries "abi":"http-v1" (ESHTTP_ENVELOPE_ABI).
 *   - One shape for success and failure; "error" non-null iff no HTTP
 *     response was received.
 *   - The envelope is emitted as pure-ASCII JSON: every byte is < 0x80.
 *     Non-ASCII is escaped as \uXXXX (surrogate pairs for > BMP) and control
 *     characters as \uXXXX/\b\t\n\f\r. This makes the envelope immune to the
 *     host's char* -> JS string codepage conversion and guarantees the JS
 *     wrapper can always parse it (envelope correctness is priority #1).
 *
 * Rulings applied (native-abi §10, binding):
 *   - WinHTTP backend, per-request WinHttpOpen/WinHttpClose sessions.
 *   - decompress: WINHTTP_OPTION_DECOMPRESSION (flag ALL) when settable;
 *     silent identity fallback (no Accept-Encoding) otherwise, with
 *     meta.encodingWasApplied:false. NO manual gzip inflate in C (v1).
 *   - proxy: null -> system (DEFAULT_PROXY), "direct" -> NO_PROXY,
 *     "host:port" / "http://host:port" / "https://host:port" -> NAMED_PROXY.
 *   - verifyTls:false disables certificate validation only.
 *  - Redirects handled manually (WINHTTP_OPTION_REDIRECT_POLICY_NEVER):
 *     301/302/303 -> GET (body + Content-Type dropped), 307/308 preserve;
 *     Authorization dropped when the redirect target host differs from the
 *     request host OR the scheme changes (https->http would replay
 *     credentials over cleartext; RFC 9110 §9.6.4); maxRedirects cap ->
 *     too-many-redirects; relative Location resolved in C; meta.redirects
 *     counted.
 *   - URL userinfo (https://user:pw@host/...) is STRIPPED and never mapped to
 *     Basic auth; credentials never appear in messages or meta.
 *   - Caller-supplied Host / Content-Length are ignored (WinHTTP computes).
 *   - optsJson.userAgent: JSON null or "" -> NO User-Agent sent, no default.
 *     Non-empty string -> sent unless headersJson has an explicit User-Agent
 *     (explicit header wins, never duplicated).
 *   - Authorization: if headersJson has an explicit Authorization header it
 *     wins; else opts.username != null -> preemptive Basic (RFC 7617).
 *   - bodyIsBase64: base64-decoded by the DLL before sending.
 *   - Host/Content-Length, Content-Length for the body: computed by WinHTTP
 *     from the (decoded) length.
 *
 * Error mapping (native-abi §5; raw code also in meta.winhttpError):
 *   WinHTTP 12002 timeout | 12005/12006 bad-url | 12007 dns |
 *   12029 connect | 12030/12031 network | 12037/12038/12044/12045/12057/
 *   12170/12175/12179 + proxy twins -> tls | else internal.
 */

#include "eshttp.h"

#include <windows.h>
#include <winhttp.h>

#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Link winhttp statically (dynamic-link with the OS WinHTTP.dll at load
 * time). With /TC, a .lib named on the command line is treated as a source
 * file, so the library reference must come from here (pragma) — keeps the
 * BUILD.md commands single-line and identical for selftest and DLL builds. */
#pragma comment(lib, "winhttp.lib")

#if !defined(ESHTTP_BUILD) && !defined(ESHTTP_STATIC)
#error "eshttp.c must be compiled with ESHTTP_BUILD (DLL) or ESHTTP_STATIC (selftest)"
#endif

/* ==========================================================================
 * Small utilities
 * ========================================================================== */

/* Growable byte buffer (not NUL-terminated until explicitly finalized). */
typedef struct {
    char* d;
    size_t n;
    size_t cap;
} buf_t;

static int buf_reserve(buf_t* b, size_t extra) {
    if (b->n + extra + 1 <= b->cap) { return 1; }
    size_t nc = b->cap ? b->cap * 2 : 256;
    while (nc < b->n + extra + 1) { nc *= 2; }
    char* nd = (char*)realloc(b->d, nc);
    if (!nd) { return 0; }
    b->d = nd;
    b->cap = nc;
    return 1;
}

static int buf_putc(buf_t* b, char c) {
    if (!buf_reserve(b, 1)) { return 0; }
    b->d[b->n++] = c;
    return 1;
}

static int buf_app(buf_t* b, const void* p, size_t n) {
    if (n == 0) { return 1; }
    if (!buf_reserve(b, n)) { return 0; }
    memcpy(b->d + b->n, p, n);
    b->n += n;
    return 1;
}

static int buf_apps(buf_t* b, const char* s) { return buf_app(b, s, strlen(s)); }

static void buf_free(buf_t* b) {
    free(b->d);
    b->d = NULL;
    b->n = b->cap = 0;
}

/* Decode one UTF-8 sequence at s (n bytes available). Returns the code point
 * or -1 on invalid input; *used = bytes consumed (1 on invalid). */
static int32_t utf8_decode(const unsigned char* s, size_t n, size_t* used) {
    if (n == 0) { *used = 0; return -1; }
    unsigned char c = s[0];
    if (c < 0x80) { *used = 1; return (int32_t)c; }
    int32_t cp;
    int need;
    if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; need = 1; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; need = 2; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; need = 3; }
    else { *used = 1; return -1; }
    if (n < (size_t)need + 1) { *used = 1; return -1; }
    for (int k = 1; k <= need; k++) {
        if ((s[k] & 0xC0) != 0x80) { *used = 1; return -1; }
        cp = (cp << 6) | (s[k] & 0x3F);
    }
    if ((need == 1 && cp < 0x80) || (need == 2 && cp < 0x800) ||
        (need == 3 && cp < 0x10000) || cp > 0x10FFFF ||
        (cp >= 0xD800 && cp <= 0xDFFF)) {
        *used = 1;
        return -1;
    }
    *used = (size_t)need + 1;
    return cp;
}

/* Encode a code point as UTF-8 into out[4]. Returns bytes written. */
static size_t utf8_encode(int32_t cp, char out[4]) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

/* Replace invalid UTF-8 sequences with U+FFFD (EF BF BD). Returns calloc'd
 * string (always NUL-terminated); *out_len = byte length. NULL on OOM. */
static char* utf8_fix(const char* s, size_t n, size_t* out_len) {
    buf_t b = {0};
    size_t i = 0;
    while (i < n) {
        size_t used = 0;
        int32_t cp = utf8_decode((const unsigned char*)s + i, n - i, &used);
        if (cp < 0) {
            static const char repl[3] = { (char)0xEF, (char)0xBF, (char)0xBD };
            if (!buf_app(&b, repl, 3)) { buf_free(&b); return NULL; }
            i += 1;
            continue;
        }
        if (!buf_app(&b, s + i, used)) { buf_free(&b); return NULL; }
        i += used;
    }
    if (!buf_putc(&b, '\0')) { buf_free(&b); return NULL; }
    if (out_len) { *out_len = b.n - 1; }
    return b.d;
}

/* UTF-8 -> UTF-16 (malloc'd). NULL on failure. */
static wchar_t* utf8_to_w(const char* s) {
    if (!s) { return NULL; }
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) { return NULL; }
    wchar_t* w = (wchar_t*)malloc((size_t)n * sizeof(wchar_t));
    if (!w) { return NULL; }
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

/* UTF-16 -> UTF-8 (malloc'd). NULL on failure. */
static char* w_to_utf8(const wchar_t* w) {
    if (!w) { return NULL; }
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) { return NULL; }
    char* s = (char*)malloc((size_t)n);
    if (!s) { return NULL; }
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL);
    return s;
}

/* ASCII-only case-insensitive string equality. */
static int ci_eq(const char* a, const char* b) {
    while (*a && *b) {
        char ca = *a, cb = *b;
        if (ca >= 'A' && ca <= 'Z') { ca = (char)(ca - 'A' + 'a'); }
        if (cb >= 'A' && cb <= 'Z') { cb = (char)(cb - 'A' + 'a'); }
        if (ca != cb) { return 0; }
        a++; b++;
    }
    return *a == *b;
}

/* ASCII-only case-insensitive prefix test. */
static int ci_starts(const char* s, const char* prefix) {
    size_t pl = strlen(prefix);
    for (size_t i = 0; i < pl; i++) {
        if (!s[i]) { return 0; }
        char a = s[i], b = prefix[i];
        if (a >= 'A' && a <= 'Z') { a = (char)(a - 'A' + 'a'); }
        if (b >= 'A' && b <= 'Z') { b = (char)(b - 'A' + 'a'); }
        if (a != b) { return 0; }
    }
    return 1;
}

/* HTTP method token per RFC 7230 §3.2.6 (token chars only). */
static int is_method_token(const char* m) {
    if (!m || !*m) { return 0; }
    for (const char* p = m; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') ||
              c == '!' || c == '#' || c == '$' || c == '%' || c == '&' ||
              c == '\'' || c == '*' || c == '+' || c == '-' || c == '.' ||
              c == '^' || c == '_' || c == '`' || c == '|' || c == '~')) {
            return 0;
        }
    }
    return 1;
}

/* Duplicate a substring. */
static char* str_ndup(const char* s, size_t n) {
    char* d = (char*)malloc(n + 1);
    if (!d) { return NULL; }
    memcpy(d, s, n);
    d[n] = '\0';
    return d;
}

static char* str_dup(const char* s) {
    if (!s) { return NULL; }
    size_t n = strlen(s);
    return str_ndup(s, n);
}

/* forward decl (defined with the header-list section) */
static int has_crlf(const char* s, size_t n);

/* ==========================================================================
 * Base64 (RFC 4648; strict decode, padding required)
 * ========================================================================== */
static const char B64_ENC[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int b64_encode(const unsigned char* in, size_t n, char** out) {
    size_t olen = ((n + 2) / 3) * 4;
    char* o = (char*)calloc(olen + 1, 1);
    if (!o) { return 0; }
    size_t i = 0, j = 0;
    while (i + 3 <= n) {
        unsigned v = ((unsigned)in[i] << 16) | ((unsigned)in[i + 1] << 8) | in[i + 2];
        o[j++] = B64_ENC[(v >> 18) & 63];
        o[j++] = B64_ENC[(v >> 12) & 63];
        o[j++] = B64_ENC[(v >> 6) & 63];
        o[j++] = B64_ENC[v & 63];
        i += 3;
    }
    if (n - i == 1) {
        unsigned v = (unsigned)in[i] << 16;
        o[j++] = B64_ENC[(v >> 18) & 63];
        o[j++] = B64_ENC[(v >> 12) & 63];
        o[j++] = '=';
        o[j++] = '=';
    } else if (n - i == 2) {
        unsigned v = ((unsigned)in[i] << 16) | ((unsigned)in[i + 1] << 8);
        o[j++] = B64_ENC[(v >> 18) & 63];
        o[j++] = B64_ENC[(v >> 12) & 63];
        o[j++] = B64_ENC[(v >> 6) & 63];
        o[j++] = '=';
    }
    *out = o;
    return 1;
}

/* Returns 0 on success (out calloc'd, *outlen = decoded size), -1 on invalid
 * input (out untouched). */
static int b64_decode(const char* in, size_t n, unsigned char** out, size_t* outlen) {
    static signed char R[256];
    static int R_ready = 0;
    if (!R_ready) {
        for (int i = 0; i < 256; i++) { R[i] = -1; }
        for (int i = 0; i < 64; i++) { R[(unsigned char)B64_ENC[i]] = (signed char)i; }
        R_ready = 1;
    }
    if (n % 4 != 0) { return -1; }
    size_t pad = 0;
    if (n >= 1 && in[n - 1] == '=') { pad++; }
    if (n >= 2 && in[n - 2] == '=') { pad++; }
    if (pad > 2) { return -1; }
    size_t olen = (n / 4) * 3 - pad;
    unsigned char* o = (unsigned char*)calloc(olen ? olen : 1, 1);
    if (!o) { return -1; }
    size_t oi = 0;
    for (size_t i = 0; i < n; i += 4) {
        signed char c0 = R[(unsigned char)in[i]];
        signed char c1 = R[(unsigned char)in[i + 1]];
        signed char c2 = (i + 2 < n && in[i + 2] != '=') ? R[(unsigned char)in[i + 2]] : 0;
        signed char c3 = (i + 3 < n && in[i + 3] != '=') ? R[(unsigned char)in[i + 3]] : 0;
        if (c0 < 0 || c1 < 0 || (i + 2 < n && in[i + 2] != '=' && c2 < 0) ||
            (i + 3 < n && in[i + 3] != '=' && c3 < 0)) {
            free(o);
            return -1;
        }
        unsigned v = ((unsigned)c0 << 18) | ((unsigned)c1 << 12) | ((unsigned)c2 << 6) | (unsigned)c3;
        if (oi < olen) { o[oi++] = (unsigned char)(v >> 16); }
        if (oi < olen) { o[oi++] = (unsigned char)(v >> 8); }
        if (oi < olen) { o[oi++] = (unsigned char)v; }
    }
    *out = o;
    *outlen = olen;
    return 0;
}

/* ==========================================================================
 * Minimal JSON parser (tree). Strings stored as UTF-8 bytes.
 * ========================================================================== */
typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } jk;

typedef struct jv jv;
struct jv {
    jk kind;
    int b;           /* bool */
    double num;      /* number */
    char* s;         /* string bytes (UTF-8) */
    size_t slen;     /* string byte length */
    jv** v;          /* array items, or obj pairs: [k0,v0,k1,v1,...] */
    size_t n, cap;   /* arrays: item count; objects: pair count */
};

static jv* jv_new(jk k) {
    jv* j = (jv*)calloc(1, sizeof(jv));
    if (j) { j->kind = k; }
    return j;
}

static void jv_free(jv* j) {
    if (!j) { return; }
    if (j->kind == J_STR) { free(j->s); }
    else if (j->kind == J_ARR) {
        for (size_t i = 0; i < j->n; i++) { jv_free(j->v[i]); }
        free(j->v);
    } else if (j->kind == J_OBJ) {
        /* j->n is the CHILD count (key+value pushed per pair via jv_push) */
        for (size_t i = 0; i < j->n; i++) { jv_free(j->v[i]); }
        free(j->v);
    }
    free(j);
}

static int jv_push(jv* j, jv* child) {
    if (j->n == j->cap) {
        size_t nc = j->cap ? j->cap * 2 : 8;
        jv** nv = (jv**)realloc(j->v, nc * sizeof(jv*));
        if (!nv) { return 0; }
        j->v = nv;
        j->cap = nc;
    }
    j->v[j->n++] = child;
    return 1;
}

/* Find a key in an object; returns the LAST match (later keys win).
 * j->n is the CHILD count (2 per pair: [k0,v0,k1,v1,...]), so step by 2. */
static const jv* obj_get(const jv* obj, const char* key) {
    if (!obj || obj->kind != J_OBJ) { return NULL; }
    const jv* hit = NULL;
    for (size_t i = 0; i + 1 < obj->n; i += 2) {
        const jv* k = obj->v[i];
        if (k->kind == J_STR && strlen(key) == k->slen && memcmp(k->s, key, k->slen) == 0) {
            hit = obj->v[i + 1];
        }
    }
    return hit;
}

typedef struct { const char* p; const char* end; int failed; } jp;

static void jp_ws(jp* c) {
    while (c->p < c->end && (*c->p == ' ' || *c->p == '\t' || *c->p == '\n' || *c->p == '\r')) {
        c->p++;
    }
}

/* Parse \uXXXX (and surrogate pairs) into UTF-8 bytes appended to a buf. */
static int jp_hex4(const char* p, unsigned* out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char ch = p[i];
        v <<= 4;
        if (ch >= '0' && ch <= '9') { v |= (unsigned)(ch - '0'); }
        else if (ch >= 'a' && ch <= 'f') { v |= (unsigned)(ch - 'a' + 10); }
        else if (ch >= 'A' && ch <= 'F') { v |= (unsigned)(ch - 'A' + 10); }
        else { return 0; }
    }
    *out = v;
    return 1;
}

static jv* jp_string(jp* c) {
    if (c->p >= c->end || *c->p != '"') { c->failed = 1; return NULL; }
    c->p++;
    buf_t b = {0};
    while (c->p < c->end) {
        char ch = *c->p;
        if (ch == '"') {
            c->p++;
            if (!buf_putc(&b, '\0')) { buf_free(&b); return NULL; }
            jv* j = jv_new(J_STR);
            if (!j) { buf_free(&b); return NULL; }
            j->s = b.d;
            j->slen = b.n - 1;
            return j;
        }
        if (ch == '\\') {
            c->p++;
            if (c->p >= c->end) { c->failed = 1; buf_free(&b); return NULL; }
            char e = *c->p++;
            switch (e) {
                case '"': buf_putc(&b, '"'); break;
                case '\\': buf_putc(&b, '\\'); break;
                case '/': buf_putc(&b, '/'); break;
                case 'b': buf_putc(&b, '\b'); break;
                case 'f': buf_putc(&b, '\f'); break;
                case 'n': buf_putc(&b, '\n'); break;
                case 'r': buf_putc(&b, '\r'); break;
                case 't': buf_putc(&b, '\t'); break;
                case 'u': {
                    if (c->end - c->p < 4) { c->failed = 1; buf_free(&b); return NULL; }
                    unsigned u0;
                    if (!jp_hex4(c->p, &u0)) { c->failed = 1; buf_free(&b); return NULL; }
                    c->p += 4;
                    int32_t cp = (int32_t)u0;
                    if (u0 >= 0xD800 && u0 <= 0xDBFF) {
                        /* expect a low surrogate */
                        if (c->end - c->p >= 6 && c->p[0] == '\\' && c->p[1] == 'u') {
                            unsigned u1;
                            if (jp_hex4(c->p + 2, &u1) && u1 >= 0xDC00 && u1 <= 0xDFFF) {
                                cp = 0x10000 + ((u0 - 0xD800) << 10) + (u1 - 0xDC00);
                                c->p += 6;
                            } else {
                                cp = 0xFFFD;
                            }
                        } else {
                            cp = 0xFFFD;
                        }
                    } else if (u0 >= 0xDC00 && u0 <= 0xDFFF) {
                        cp = 0xFFFD; /* lone low surrogate */
                    }
                    char tmp[4];
                    size_t tn = utf8_encode(cp, tmp);
                    if (!buf_app(&b, tmp, tn)) { buf_free(&b); return NULL; }
                    break;
                }
                default: c->failed = 1; buf_free(&b); return NULL;
            }
        } else {
            /* raw byte (already UTF-8 from the boundary); copy as-is */
            buf_putc(&b, ch);
            c->p++;
        }
    }
    c->failed = 1;
    buf_free(&b);
    return NULL;
}

static jv* jp_value(jp* c);

static jv* jp_number(jp* c) {
    const char* start = c->p;
    if (c->p < c->end && *c->p == '-') { c->p++; }
    while (c->p < c->end && ((*c->p >= '0' && *c->p <= '9') || *c->p == '.' ||
                             *c->p == 'e' || *c->p == 'E' || *c->p == '+' || *c->p == '-')) {
        c->p++;
    }
    char tmp[64];
    size_t ln = (size_t)(c->p - start);
    if (ln == 0 || ln >= sizeof(tmp)) { c->failed = 1; return NULL; }
    memcpy(tmp, start, ln);
    tmp[ln] = '\0';
    char* endp = NULL;
    double d = strtod(tmp, &endp);
    if (!endp || *endp != '\0' || !(d == d) /* NaN check */) { c->failed = 1; return NULL; }
    jv* j = jv_new(J_NUM);
    if (!j) { return NULL; }
    j->num = d;
    return j;
}

static jv* jp_array(jp* c) {
    c->p++; /* '[' */
    jv* j = jv_new(J_ARR);
    if (!j) { c->failed = 1; return NULL; }
    jp_ws(c);
    if (c->p < c->end && *c->p == ']') { c->p++; return j; }
    for (;;) {
        jp_ws(c);
        jv* v = jp_value(c);
        if (!v) { jv_free(j); return NULL; }
        if (!jv_push(j, v)) { jv_free(v); jv_free(j); return NULL; }
        jp_ws(c);
        if (c->p >= c->end) { c->failed = 1; jv_free(j); return NULL; }
        if (*c->p == ',') { c->p++; continue; }
        if (*c->p == ']') { c->p++; return j; }
        c->failed = 1;
        jv_free(j);
        return NULL;
    }
}

static jv* jp_object(jp* c) {
    c->p++; /* '{' */
    jv* j = jv_new(J_OBJ);
    if (!j) { c->failed = 1; return NULL; }
    jp_ws(c);
    if (c->p < c->end && *c->p == '}') { c->p++; return j; }
    for (;;) {
        jp_ws(c);
        jv* k = jp_string(c);
        if (!k) { jv_free(j); return NULL; }
        jp_ws(c);
        if (c->p >= c->end || *c->p != ':') { jv_free(k); jv_free(j); c->failed = 1; return NULL; }
        c->p++;
        jp_ws(c);
        jv* v = jp_value(c);
        if (!v) { jv_free(k); jv_free(j); return NULL; }
        if (!jv_push(j, k) || !jv_push(j, v)) {
            jv_free(k); jv_free(v); jv_free(j);
            return NULL;
        }
        jp_ws(c);
        if (c->p >= c->end) { c->failed = 1; jv_free(j); return NULL; }
        if (*c->p == ',') { c->p++; continue; }
        if (*c->p == '}') { c->p++; return j; }
        c->failed = 1;
        jv_free(j);
        return NULL;
    }
}

static jv* jp_value(jp* c) {
    jp_ws(c);
    if (c->p >= c->end) { c->failed = 1; return NULL; }
    char ch = *c->p;
    if (ch == '"') { return jp_string(c); }
    if (ch == '{') { return jp_object(c); }
    if (ch == '[') { return jp_array(c); }
    if (ch == 't') {
        if (c->end - c->p >= 4 && memcmp(c->p, "true", 4) == 0) { c->p += 4; jv* j = jv_new(J_BOOL); if (j) j->b = 1; return j; }
        c->failed = 1; return NULL;
    }
    if (ch == 'f') {
        if (c->end - c->p >= 5 && memcmp(c->p, "false", 5) == 0) { c->p += 5; return jv_new(J_BOOL); }
        c->failed = 1; return NULL;
    }
    if (ch == 'n') {
        if (c->end - c->p >= 4 && memcmp(c->p, "null", 4) == 0) { c->p += 4; return jv_new(J_NULL); }
        c->failed = 1; return NULL;
    }
    if (ch == '-' || (ch >= '0' && ch <= '9')) { return jp_number(c); }
    c->failed = 1;
    return NULL;
}

/* Parse a JSON document; returns tree or NULL on any error. */
static jv* json_parse(const char* txt, size_t len) {
    jp c = { txt, txt + len, 0 };
    jp_ws(&c);
    jv* j = jp_value(&c);
    if (!j) { return NULL; }
    jp_ws(&c);
    if (c.p != c.end) { jv_free(j); return NULL; }
    return j;
}

/* ==========================================================================
 * JSON writer (pure-ASCII output: non-ASCII -> \uXXXX)
 * ========================================================================== */
static void w_hex4(buf_t* b, unsigned v) {
    static const char H[] = "0123456789abcdef";
    buf_putc(b, '\\');
    buf_putc(b, 'u');
    buf_putc(b, H[(v >> 12) & 15]);
    buf_putc(b, H[(v >> 8) & 15]);
    buf_putc(b, H[(v >> 4) & 15]);
    buf_putc(b, H[v & 15]);
}

/* Write a JSON string (with quotes). s may contain NULs (n is the length). */
static void w_str(buf_t* b, const char* s, size_t n) {
    buf_putc(b, '"');
    size_t i = 0;
    while (i < n) {
        size_t used = 0;
        int32_t cp = utf8_decode((const unsigned char*)s + i, n - i, &used);
        if (cp < 0) { w_hex4(b, 0xFFFD); i++; continue; }
        i += used;
        if (cp == '"') { buf_apps(b, "\\\""); }
        else if (cp == '\\') { buf_apps(b, "\\\\"); }
        else if (cp == '\b') { buf_apps(b, "\\b"); }
        else if (cp == '\t') { buf_apps(b, "\\t"); }
        else if (cp == '\n') { buf_apps(b, "\\n"); }
        else if (cp == '\f') { buf_apps(b, "\\f"); }
        else if (cp == '\r') { buf_apps(b, "\\r"); }
        else if (cp < 0x20) { w_hex4(b, (unsigned)cp); }
        else if (cp < 0x7F) { buf_putc(b, (char)cp); }
        else if (cp < 0x10000) { w_hex4(b, (unsigned)cp); }
        else {
            unsigned u = (unsigned)(cp - 0x10000);
            w_hex4(b, 0xD800 + (u >> 10));
            w_hex4(b, 0xDC00 + (u & 0x3FF));
        }
    }
    buf_putc(b, '"');
}

static void w_key(buf_t* b, const char* k) { w_str(b, k, strlen(k)); }

static void w_i64(buf_t* b, int64_t v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%lld", (long long)v);
    buf_apps(b, tmp);
}

static void w_bool(buf_t* b, int v) { buf_apps(b, v ? "true" : "false"); }
static void w_null(buf_t* b) { buf_apps(b, "null"); }

/* ==========================================================================
 * URL parsing (userinfo stripped, fragment stripped)
 * ========================================================================== */
typedef struct {
    int https;         /* 1 = https, 0 = http */
    char* host;        /* ASCII-lowercased host (IPv6 kept bracketed) */
    int port;          /* 80/443 defaults filled in */
    char* path;        /* path + query, always starts with '/' */
} eshttp_url;

/* Free the MEMBERS of a url (host/path). eshttp_url values in this file are
 * stack locals — url_parse fills a caller-owned struct and the struct itself
 * is never heap-allocated, so we must NOT free(u) here (that would free a
 * stack address). */
static void url_free(eshttp_url* u) {
    if (!u) { return; }
    free(u->host);
    free(u->path);
}

/* Returns 1 on success, 0 on failure (err set to a static reason string). */
static int url_parse(const char* url, eshttp_url* out, const char** err) {
    *err = NULL;
    if (!url || !*url) { *err = "empty URL"; return 0; }
    /* request-line injection guard: CR/LF would terminate the URL inside the
     * HTTP request line; NUL would truncate it mid-parse. Reject outright. */
    if (has_crlf(url, strlen(url))) { *err = "URL contains CR/LF/NUL"; return 0; }
    const char* p = url;
    /* scheme */
    const char* scheme = NULL;
    const char* q = strstr(p, "://");
    if (!q || q == p) { *err = "missing scheme (must be http:// or https://)"; return 0; }
    int https = 0;
    /* P0 fix (R-G5-E1 wire gate): ci_eq was a FULL-string equality test, but
     * p points at the whole URL ("http://..."), so it always failed -> every
     * http(s):// URL was rejected as "unsupported scheme". The scheme is
     * delimited by the "://" separator, so combine an exact length check
     * (q - p == 4/5) with a PREFIX test (ci_starts). */
    if (q - p == 4 && ci_starts(p, "http")) { https = 0; }
    else if (q - p == 5 && ci_starts(p, "https")) { https = 1; }
    else { *err = "unsupported scheme (must be http:// or https://)"; return 0; }
    p = q + 3;
    /* userinfo (stripped; never kept, never used) */
    const char* slash = strchr(p, '/');
    const char* at = NULL;
    {
        const char* scan = p;
        while (*scan && *scan != '/' && *scan != '?' && *scan != '#') {
            if (*scan == '@') { at = scan; }
            scan++;
        }
    }
    if (at) { p = at + 1; }
    /* host[:port] */
    const char* host_start = p;
    const char* host_end = p;
    int port = https ? 443 : 80;
    if (*p == '[') {
        /* IPv6 literal */
        const char* close = strchr(p, ']');
        if (!close) { *err = "invalid IPv6 host"; return 0; }
        host_end = close + 1;
        p = host_end;
        if (*p == ':') {
            p++;
            char* endp = NULL;
            long v = strtol(p, &endp, 10);
            if (endp == p || v < 1 || v > 65535) { *err = "invalid port"; return 0; }
            port = (int)v;
            p = endp;
        }
    } else {
        while (*p && *p != ':' && *p != '/' && *p != '?' && *p != '#') { p++; }
        host_end = p;
        if (*p == ':') {
            p++;
            char* endp = NULL;
            long v = strtol(p, &endp, 10);
            if (endp == p || v < 1 || v > 65535) { *err = "invalid port"; return 0; }
            port = (int)v;
            p = endp;
        }
    }
    if (host_end == host_start) { *err = "missing host"; return 0; }
    /* path (fragment stripped) */
    const char* path_start = p;
    const char* path_end = p;
    if (*p == '/' || *p == '?') {
        const char* h = strchr(p, '#');
        path_end = h ? h : p + strlen(p);
    } else {
        path_start = p; /* nothing left after host:port -> "/" */
        path_end = p;
    }
    /* assemble */
    char* host = str_ndup(host_start, (size_t)(host_end - host_start));
    if (!host) { *err = "oom"; return 0; }
    for (char* c = host; *c; c++) {
        if (*c >= 'A' && *c <= 'Z') { *c = (char)(*c - 'A' + 'a'); }
    }
    size_t plen = (size_t)(path_end - path_start);
    char* path = (char*)malloc(plen + 2);
    if (!path) { free(host); *err = "oom"; return 0; }
    if (plen == 0) { path[0] = '/'; path[1] = '\0'; }
    else {
        if (path_start[0] == '/') { memcpy(path, path_start, plen); path[plen] = '\0'; }
        else { path[0] = '/'; memcpy(path + 1, path_start, plen); path[plen + 1] = '\0'; }
    }
    out->https = https;
    out->host = host;
    out->port = port;
    out->path = path;
    return 1;
}

/* Sanitized absolute URL (userinfo never present). calloc'd. */
static char* url_tostring(const eshttp_url* u) {
    buf_t b = {0};
    buf_apps(&b, u->https ? "https://" : "http://");
    buf_apps(&b, u->host);
    if ((u->https && u->port != 443) || (!u->https && u->port != 80)) {
        char tmp[16];
        snprintf(tmp, sizeof(tmp), ":%d", u->port);
        buf_apps(&b, tmp);
    }
    buf_apps(&b, u->path);
    if (!buf_putc(&b, '\0')) { buf_free(&b); return NULL; }
    return b.d;
}

/* Resolve a Location header against base. Returns calloc'd absolute URL
 * (userinfo stripped) or NULL on invalid input. RFC 3986 §5 subset. */

/* RFC 3986 §5.2.4 remove_dot_segments, applied in place (only ever shrinks).
 * Rule order matters: the longer "/.." prefix must be matched BEFORE the
 * shorter "/." prefix, and the leading "." rules only match whole segments
 * (always followed by '/' or end-of-input). */
static void remove_dot_segments(char* p) {
    size_t n = strlen(p);
    char* tmp = (char*)malloc(n + 1);
    if (!tmp) { return; } /* OOM: leave as-is; caller still works */
    size_t in = 0, out = 0;
    while (in < n) {
        size_t rest = n - in;
        /* A: leading "../" or "./" (whole segment: must be followed by '/' or end) */
        if (rest >= 3 && p[in] == '.' && p[in + 1] == '.' && p[in + 2] == '/') { in += 3; }
        else if (rest >= 2 && p[in] == '.' && p[in + 1] == '/') { in += 2; }
        /* C: "/../" or "/.." (pop the last output segment) — check BEFORE "/." */
        else if (rest >= 4 && p[in] == '/' && p[in + 1] == '.' && p[in + 2] == '.' && p[in + 3] == '/') {
            if (out > 1 && tmp[out - 1] == '/') { out--; }
            while (out > 0 && tmp[out - 1] != '/') { out--; }
            if (out == 0 || tmp[out - 1] != '/') { tmp[out++] = '/'; }
            in += 4;
        }
        else if (rest >= 3 && p[in] == '/' && p[in + 1] == '.' && p[in + 2] == '.') { /* "/.." at end */
            if (out > 1 && tmp[out - 1] == '/') { out--; }
            while (out > 0 && tmp[out - 1] != '/') { out--; }
            if (out == 0 || tmp[out - 1] != '/') { tmp[out++] = '/'; }
            in += 3;
        }
        /* B: "/./" or "/." -> "/" */
        else if (rest >= 3 && p[in] == '/' && p[in + 1] == '.' && p[in + 2] == '/') {
            if (out == 0 || tmp[out - 1] != '/') { tmp[out++] = '/'; }
            in += 3;
        }
        else if (rest >= 2 && p[in] == '/' && p[in + 1] == '.') { /* "/." at end */
            if (out == 0 || tmp[out - 1] != '/') { tmp[out++] = '/'; }
            in += 2;
        }
        /* D: input is exactly "." or ".." (whole remaining input) */
        else if (rest == 1 && p[in] == '.') { in += 1; }
        else if (rest == 2 && p[in] == '.' && p[in + 1] == '.') { in += 2; }
        /* E: copy one segment (chars up to but not including the next '/') */
        else {
            tmp[out++] = p[in++];
        }
    }
    tmp[out] = '\0';
    memcpy(p, tmp, out + 1);
    free(tmp);
}

static char* url_resolve(const eshttp_url* base, const char* loc) {
    while (*loc == ' ' || *loc == '\t') { loc++; }
    size_t ll = strlen(loc);
    while (ll > 0 && (loc[ll - 1] == ' ' || loc[ll - 1] == '\t')) { ll--; }
    if (ll == 0) { return NULL; }
    char* lc = str_ndup(loc, ll);
    if (!lc) { return NULL; }
    /* absolute? */
    const char* scheme = strstr(lc, "://");
    if (scheme) {
        eshttp_url nu;
        const char* e = NULL;
        if (!url_parse(lc, &nu, &e)) { free(lc); return NULL; }
        char* s = url_tostring(&nu);
        url_free(&nu);
        free(lc);
        return s;
    }
    buf_t b = {0};
    if (lc[0] == '/' && lc[1] == '/') {
        /* scheme-relative */
        buf_apps(&b, base->https ? "https:" : "http:");
        buf_apps(&b, lc);
    } else if (lc[0] == '/') {
        buf_apps(&b, base->https ? "https://" : "http://");
        buf_apps(&b, base->host);
        if ((base->https && base->port != 443) || (!base->https && base->port != 80)) {
            char tmp[16];
            snprintf(tmp, sizeof(tmp), ":%d", base->port);
            buf_apps(&b, tmp);
        }
        buf_apps(&b, lc);
    } else {
        /* relative to the current path's directory — the base PATH only,
         * never its query/fragment (RFC 3986 §5.3: reference is resolved
         * against the base path component) */
        buf_apps(&b, base->https ? "https://" : "http://");
        buf_apps(&b, base->host);
        if ((base->https && base->port != 443) || (!base->https && base->port != 80)) {
            char tmp[16];
            snprintf(tmp, sizeof(tmp), ":%d", base->port);
            buf_apps(&b, tmp);
        }
        const char* path = base->path;
        size_t path_len = strlen(path);
        const char* qmark = (const char*)memchr(path, '?', path_len);
        if (qmark) { path_len = (size_t)(qmark - path); }
        const char* last = NULL;
        for (size_t i = 0; i < path_len; i++) {
            if (path[i] == '/') { last = path + i; }
        }
        if (last && last != path) {
            buf_app(&b, path, (size_t)(last - path) + 1);
        } else {
            buf_putc(&b, '/');
        }
        buf_apps(&b, lc);
    }
    free(lc);
    if (!buf_putc(&b, '\0')) { buf_free(&b); return NULL; }
    /* RFC 3986 §5.2.4: normalize dot segments in the PATH only — never in the
     * query or fragment — so locate the path extent first. remove_dot_segments
     * only shrinks, so the final buffer is always large enough. */
    if (b.d) {
        char* path_start = strstr(b.d, "://");
        if (path_start) {
            path_start += 3;          /* after "://" */
            char* slash = strchr(path_start, '/');
            if (slash) {
                char* end = slash;
                while (*end && *end != '?' && *end != '#') { end++; }
                char* suffix = NULL;
                if (*end == '?' || *end == '#') {
                    suffix = str_dup(end);   /* copy BEFORE NUL-isolating */
                    *end = '\0';             /* isolate the path (no query) */
                }
                remove_dot_segments(slash);  /* NUL-terminates at path end */
                if (suffix) { strcat(b.d, suffix); free(suffix); } /* re-attach ?query#frag */
            }
        }
    }
    return b.d;
}

/* ==========================================================================
 * Header list
 * ========================================================================== */
typedef struct { char* name; char* value; } hdr_t;
typedef struct { hdr_t* v; size_t n, cap; } hdrlist;

static hdr_t* hdr_find(const hdrlist* l, const char* name) {
    for (size_t i = 0; i < l->n; i++) {
        if (ci_eq(l->v[i].name, name)) { return &l->v[i]; }
    }
    return NULL;
}

static int hdr_push(hdrlist* l, const char* name, const char* value) {
    if (l->n == l->cap) {
        size_t nc = l->cap ? l->cap * 2 : 8;
        hdr_t* nv = (hdr_t*)realloc(l->v, nc * sizeof(hdr_t));
        if (!nv) { return 0; }
        l->v = nv;
        l->cap = nc;
    }
    hdr_t* h = &l->v[l->n];
    h->name = str_dup(name);
    h->value = str_dup(value);
    if (!h->name || !h->value) {
        free(h->name);
        free(h->value);
        return 0;
    }
    l->n++;
    return 1;
}

static void hdrlist_free(hdrlist* l) {
    for (size_t i = 0; i < l->n; i++) {
        free(l->v[i].name);
        free(l->v[i].value);
    }
    free(l->v);
    l->v = NULL;
    l->n = l->cap = 0;
}

/* Does the byte range contain CR, LF, or NUL? (CR/LF -> header injection;
 * NUL would silently truncate an emitted header at the C-string boundary.) */
static int has_crlf(const char* s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '\r' || s[i] == '\n' || s[i] == '\0') { return 1; }
    }
    return 0;
}

/* ==========================================================================
 * Request options (optsJson)
 * ========================================================================== */
typedef struct {
    int64_t timeout_ms;    /* 0 = no timeout */
    int follow;            /* 1 follow, 0 manual */
    int max_redirects;
    int verify_tls;
    char* user_agent;      /* NULL = do NOT send a User-Agent */
    char* username;        /* NULL = none */
    char* password;        /* NULL = none */
    int proxy_mode;        /* 0 system, 1 direct, 2 named */
    wchar_t* proxy_w;      /* named proxy (UTF-16) or NULL */
    int decompress;
    int64_t max_body;      /* 0 = unlimited */
    int body_is_base64;
} opts_t;

static void opts_free(opts_t* o) {
    free(o->user_agent);
    free(o->username);
    free(o->password);
    free(o->proxy_w);
    memset(o, 0, sizeof(*o));
}

/* Parse optsJson into o. Returns NULL on success; a static reason string on
 * failure (no allocations leaked). */
static const char* opts_parse(const char* opts_json, opts_t* o) {
    memset(o, 0, sizeof(*o));
    o->timeout_ms = 30000;
    o->follow = 1;
    o->max_redirects = 5;
    o->verify_tls = 1;
    o->decompress = 1;
    o->max_body = 52428800;
    if (!opts_json || !*opts_json || strcmp(opts_json, "{}") == 0) { return NULL; }
    jv* j = json_parse(opts_json, strlen(opts_json));
    if (!j) { return "malformed optsJson"; }
    if (j->kind != J_OBJ) { jv_free(j); return "optsJson must be a JSON object"; }
    const jv* v;

    if ((v = obj_get(j, "timeoutMs")) != NULL) {
        if (v->kind != J_NUM || v->num < 0 || v->num > 2.1e9) { jv_free(j); return "timeoutMs must be a number >= 0"; }
        o->timeout_ms = (int64_t)v->num;
    }
    if ((v = obj_get(j, "redirect")) != NULL) {
        if (v->kind != J_STR) { jv_free(j); return "redirect must be a string"; }
        if (v->slen == 6 && memcmp(v->s, "follow", 6) == 0) { o->follow = 1; }
        else if (v->slen == 6 && memcmp(v->s, "manual", 6) == 0) { o->follow = 0; }
        else { jv_free(j); return "redirect must be \"follow\" or \"manual\""; }
    }
    if ((v = obj_get(j, "maxRedirects")) != NULL) {
        if (v->kind != J_NUM || v->num < 0 || v->num > 10000) { jv_free(j); return "maxRedirects must be a number >= 0"; }
        o->max_redirects = (int)v->num;
    }
    if ((v = obj_get(j, "verifyTls")) != NULL) {
        if (v->kind != J_BOOL) { jv_free(j); return "verifyTls must be a boolean"; }
        o->verify_tls = v->b;
    }
    if ((v = obj_get(j, "userAgent")) != NULL) {
        if (v->kind == J_STR && v->slen > 0) {
            /* header-injection guard: a UA is emitted as a header value
             * (build_request_headers "User-Agent: <ua>"), so CR/LF/NUL must
             * not reach the wire */
            if (has_crlf(v->s, v->slen)) { jv_free(j); return "userAgent must not contain CR/LF/NUL"; }
            o->user_agent = str_ndup(v->s, v->slen);
            if (!o->user_agent) { jv_free(j); return "oom"; }
        }
        /* J_STR with slen==0 or J_NULL -> NULL -> no User-Agent at all */
    }
    if ((v = obj_get(j, "username")) != NULL) {
        if (v->kind == J_STR) {
            if (has_crlf(v->s, v->slen)) { jv_free(j); return "username must not contain CR/LF/NUL"; }
            o->username = str_ndup(v->s, v->slen);
            if (!o->username) { jv_free(j); return "oom"; }
        } else if (v->kind != J_NULL) { jv_free(j); return "username must be a string or null"; }
    }
    if ((v = obj_get(j, "password")) != NULL) {
        if (v->kind == J_STR) {
            if (has_crlf(v->s, v->slen)) { jv_free(j); return "password must not contain CR/LF/NUL"; }
            o->password = str_ndup(v->s, v->slen);
            if (!o->password) { jv_free(j); return "oom"; }
        } else if (v->kind != J_NULL) { jv_free(j); return "password must be a string or null"; }
    }
    if ((v = obj_get(j, "proxy")) != NULL) {
        if (v->kind == J_NULL) { o->proxy_mode = 0; }
        else if (v->kind == J_STR) {
            if (v->slen == 6 && memcmp(v->s, "direct", 6) == 0) { o->proxy_mode = 1; }
            else {
                /* named proxy: http://host:port | https://host:port | host:port */
                size_t plen = v->slen;
                const char* ps = v->s;
                const char* hostp = ps;
                if (plen > 7 && (memcmp(ps, "http://", 7) == 0)) { hostp = ps + 7; }
                else if (plen > 8 && (memcmp(ps, "https://", 8) == 0)) { hostp = ps + 8; }
                const char* colon = NULL;
                for (const char* c = hostp; c < ps + plen; c++) {
                    if (*c == ':') { colon = c; break; }
                }
                if (!colon || colon == hostp) { jv_free(j); return "proxy must be \"direct\", \"host:port\", or \"http(s)://host:port\""; }
                char* pv = str_ndup(ps, plen);
                if (!pv) { jv_free(j); return "oom"; }
                o->proxy_w = utf8_to_w(pv);
                free(pv);
                if (!o->proxy_w) { jv_free(j); return "oom"; }
                o->proxy_mode = 2;
            }
        } else { jv_free(j); return "proxy must be a string or null"; }
    }
    if ((v = obj_get(j, "decompress")) != NULL) {
        if (v->kind != J_BOOL) { jv_free(j); return "decompress must be a boolean"; }
        o->decompress = v->b;
    }
    if ((v = obj_get(j, "maxBodyBytes")) != NULL) {
        if (v->kind != J_NUM || v->num < 0) { jv_free(j); return "maxBodyBytes must be a number >= 0"; }
        o->max_body = (int64_t)v->num;
    }
    if ((v = obj_get(j, "bodyIsBase64")) != NULL) {
        if (v->kind != J_BOOL) { jv_free(j); return "bodyIsBase64 must be a boolean"; }
        o->body_is_base64 = v->b;
    }
    jv_free(j);
    return NULL;
}

/* ==========================================================================
 * Envelope assembly
 * ========================================================================== */
typedef struct {
    int ok;
    int status;
    char* status_text;        /* "" when none */
    hdrlist headers;          /* lowercased response headers */
    char* body;               /* decoded body bytes (length body_len) */
    size_t body_len;
    int body_base64;          /* 1 = emit base64, 0 = emit fixed UTF-8 */
    /* error (NULL code = no error) */
    const char* err_code;
    const char* err_cat;
    int err_retryable;
    const char* err_msg;
    /* meta */
    char* method;
    char* final_url;
    int redirects;
    int64_t time_ms;
    int64_t bytes;
    char* http_version;       /* NULL -> null */
    char* tls_version;        /* NULL -> null */
    int encoding_was_applied;
    DWORD winhttp_err;        /* 0 = null (WinHTTP errors start at 12000) */
} env_t;

static void env_free(env_t* e) {
    free(e->status_text);
    hdrlist_free(&e->headers);
    free(e->body);
    free(e->method);
    free(e->final_url);
    free(e->http_version);
    free(e->tls_version);
    memset(e, 0, sizeof(*e));
}

/* Serialize env to out. Returns 0 on OOM. */
static int env_build(const env_t* e, buf_t* out) {
    buf_putc(out, '{');
    w_key(out, "abi"); buf_putc(out, ':'); w_str(out, ESHTTP_ENVELOPE_ABI, strlen(ESHTTP_ENVELOPE_ABI)); buf_putc(out, ',');
    w_key(out, "ok"); buf_putc(out, ':'); w_bool(out, e->ok); buf_putc(out, ',');
    w_key(out, "status"); buf_putc(out, ':'); w_i64(out, e->status); buf_putc(out, ',');
    w_key(out, "statusText"); buf_putc(out, ':'); w_str(out, e->status_text ? e->status_text : "", e->status_text ? strlen(e->status_text) : 0); buf_putc(out, ',');
    w_key(out, "headers"); buf_putc(out, ':');
    buf_putc(out, '{');
    for (size_t i = 0; i < e->headers.n; i++) {
        if (i) { buf_putc(out, ','); }
        w_str(out, e->headers.v[i].name, strlen(e->headers.v[i].name));
        buf_putc(out, ':');
        w_str(out, e->headers.v[i].value, strlen(e->headers.v[i].value));
    }
    buf_putc(out, '}');
    buf_putc(out, ',');
    w_key(out, "body"); buf_putc(out, ':');
    if (e->body_base64) {
        char* b64 = NULL;
        if (!b64_encode((const unsigned char*)(e->body ? e->body : ""), e->body ? e->body_len : 0, &b64)) { return 0; }
        w_str(out, b64, strlen(b64));
        free(b64);
    } else {
        size_t fixed_len = 0;
        char* fixed = utf8_fix(e->body ? e->body : "", e->body ? e->body_len : 0, &fixed_len);
        if (!fixed) { return 0; }
        w_str(out, fixed, fixed_len);
        free(fixed);
    }
    buf_putc(out, ',');
    w_key(out, "bodyEncoding"); buf_putc(out, ':');
    w_str(out, e->body_base64 ? "base64" : "utf8", e->body_base64 ? 6 : 4); buf_putc(out, ',');
    w_key(out, "error"); buf_putc(out, ':');
    if (e->err_code) {
        buf_putc(out, '{');
        w_key(out, "code"); buf_putc(out, ':'); w_str(out, e->err_code, strlen(e->err_code)); buf_putc(out, ',');
        w_key(out, "message"); buf_putc(out, ':'); w_str(out, e->err_msg ? e->err_msg : e->err_code, e->err_msg ? strlen(e->err_msg) : strlen(e->err_code)); buf_putc(out, ',');
        w_key(out, "category"); buf_putc(out, ':'); w_str(out, e->err_cat ? e->err_cat : "internal", e->err_cat ? strlen(e->err_cat) : 8); buf_putc(out, ',');
        w_key(out, "retryable"); buf_putc(out, ':'); w_bool(out, e->err_retryable);
        buf_putc(out, '}');
    } else {
        w_null(out);
    }
    buf_putc(out, ',');
    w_key(out, "meta"); buf_putc(out, ':');
    buf_putc(out, '{');
    w_key(out, "path"); buf_putc(out, ':'); w_str(out, "native", 6); buf_putc(out, ',');
    w_key(out, "method"); buf_putc(out, ':'); w_str(out, e->method ? e->method : "", e->method ? strlen(e->method) : 0); buf_putc(out, ',');
    w_key(out, "finalUrl"); buf_putc(out, ':'); w_str(out, e->final_url ? e->final_url : "", e->final_url ? strlen(e->final_url) : 0); buf_putc(out, ',');
    w_key(out, "redirects"); buf_putc(out, ':'); w_i64(out, e->redirects); buf_putc(out, ',');
    w_key(out, "timeMs"); buf_putc(out, ':'); w_i64(out, e->time_ms); buf_putc(out, ',');
    w_key(out, "bytes"); buf_putc(out, ':'); w_i64(out, e->bytes); buf_putc(out, ',');
    w_key(out, "httpVersion"); buf_putc(out, ':');
    if (e->http_version) { w_str(out, e->http_version, strlen(e->http_version)); } else { w_null(out); }
    buf_putc(out, ',');
    w_key(out, "tlsVersion"); buf_putc(out, ':');
    if (e->tls_version) { w_str(out, e->tls_version, strlen(e->tls_version)); } else { w_null(out); }
    buf_putc(out, ',');
    w_key(out, "encodingWasApplied"); buf_putc(out, ':'); w_bool(out, e->encoding_was_applied); buf_putc(out, ',');
    w_key(out, "nativeVersion"); buf_putc(out, ':'); w_str(out, ESHTTP_VERSION, strlen(ESHTTP_VERSION)); buf_putc(out, ',');
    w_key(out, "winhttpError"); buf_putc(out, ':');
    if (e->winhttp_err) { w_i64(out, (int64_t)e->winhttp_err); } else { w_null(out); }
    buf_putc(out, ',');
    w_key(out, "backend"); buf_putc(out, ':'); w_str(out, "winhttp", 7);
    buf_putc(out, '}');
    buf_putc(out, '}');
    return buf_reserve(out, 0) && buf_putc(out, '\0');
}

/* ==========================================================================
 * WinHTTP error -> taxonomy mapping (native-abi §5)
 * ========================================================================== */
typedef struct { const char* code; const char* cat; int retryable; } errinfo;

static errinfo map_winhttp(DWORD e) {
    switch (e) {
        case ERROR_WINHTTP_TIMEOUT:                      return (errinfo){ "timeout", "timeout", 1 };
        case ERROR_WINHTTP_INVALID_URL:                  return (errinfo){ "bad-url", "usage", 0 };
        case ERROR_WINHTTP_UNRECOGNIZED_SCHEME:          return (errinfo){ "bad-url", "usage", 0 };
        case ERROR_WINHTTP_NAME_NOT_RESOLVED:            return (errinfo){ "dns", "transport", 1 };
        case ERROR_WINHTTP_CANNOT_CONNECT:               return (errinfo){ "connect", "transport", 1 };
        case ERROR_WINHTTP_CONNECTION_ERROR:             return (errinfo){ "network", "transport", 1 };
        case ERROR_WINHTTP_OPERATION_CANCELLED:          return (errinfo){ "aborted", "abort", 0 };
        case ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED:      return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_CERT_DATE_INVALID:     return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_CERT_CN_INVALID:       return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_INVALID_CA:            return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_CERT_REV_FAILED:       return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_CERT_REVOKED:          return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_CERT_WRONG_USAGE:      return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_FAILURE:               return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_SECURE_FAILURE_PROXY:         return (errinfo){ "tls", "tls", 0 };
        case ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED_PROXY: return (errinfo){ "tls", "tls", 0 };
        default:                                          return (errinfo){ "internal", "internal", 0 };
    }
}

/* Human message for an error envelope (no credentials ever). */
static void errmsg(const errinfo* ei, DWORD code, const char* host, int port,
                   int64_t timeout_ms, int64_t max_body, int max_redirects,
                   char* out, size_t outsz) {
    if (strcmp(ei->code, "timeout") == 0) {
        snprintf(out, outsz, "Request timed out after %lld ms (WinHTTP %lu)",
                 (long long)timeout_ms, (unsigned long)code);
    } else if (strcmp(ei->code, "dns") == 0) {
        snprintf(out, outsz, "DNS resolution failed for host '%s' (WinHTTP %lu)",
                 host ? host : "", (unsigned long)code);
    } else if (strcmp(ei->code, "connect") == 0) {
        snprintf(out, outsz, "Could not connect to host '%s:%d' (WinHTTP %lu)",
                 host ? host : "", port, (unsigned long)code);
    } else if (strcmp(ei->code, "network") == 0) {
        snprintf(out, outsz, "Network error (connection lost/reset) (WinHTTP %lu)",
                 (unsigned long)code);
    } else if (strcmp(ei->code, "tls") == 0) {
        snprintf(out, outsz, "TLS/SSL failure (WinHTTP %lu)", (unsigned long)code);
    } else if (strcmp(ei->code, "aborted") == 0) {
        snprintf(out, outsz, "Request aborted (WinHTTP %lu)", (unsigned long)code);
    } else if (strcmp(ei->code, "bad-url") == 0) {
        snprintf(out, outsz, "Invalid URL (WinHTTP %lu)", (unsigned long)code);
    } else if (strcmp(ei->code, "too-many-redirects") == 0) {
        snprintf(out, outsz, "Too many redirects (max %d)", max_redirects);
    } else if (strcmp(ei->code, "body-too-large") == 0) {
        snprintf(out, outsz, "Response body exceeds maxBodyBytes (%lld)", (long long)max_body);
    } else {
        snprintf(out, outsz, "Internal error (WinHTTP %lu)", (unsigned long)code);
    }
}

/* ==========================================================================
 * Backend registry + last error (DLL-owned state)
 * ========================================================================== */
/* native-abi v2: NO caller-side free. The host frees every kTypeString
 * return via ESFreeMem (= free). The old PTR_SLOTS registry was the v1
 * caller-frees mechanism and is removed (it also became a double-free
 * hazard once the host freed via ESFreeMem). */

static char g_last_error[1024];

static void last_error_set(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_last_error, sizeof(g_last_error), fmt, ap);
    va_end(ap);
}

static void last_error_clear(void) { g_last_error[0] = '\0'; }

/* ==========================================================================
 * Session cache (WinHTTP session reuse)
 * ========================================================================== */
#define SESSION_CACHE_SLOTS 16

typedef struct {
    HINTERNET session;
    wchar_t* user_agent;      /* NULL or owned wide string */
    DWORD access_type;        /* WINHTTP_ACCESS_TYPE_* */
    wchar_t* proxy_name;      /* NULL or owned wide string (when NAMED_PROXY) */
    int in_use;               /* 1 if this slot holds a valid session */
} session_cache_entry;

static session_cache_entry g_session_cache[SESSION_CACHE_SLOTS] = {0};

/* Compare two wide strings (NULL-safe). */
static int wstr_eq(const wchar_t* a, const wchar_t* b) {
    if (a == b) { return 1; }
    if (!a || !b) { return 0; }
    return wcscmp(a, b) == 0;
}

/* Find a matching cached session or an empty slot. Returns index or -1. */
static int session_cache_find(DWORD access_type, const wchar_t* proxy_name, const wchar_t* user_agent) {
    int empty_slot = -1;
    for (int i = 0; i < SESSION_CACHE_SLOTS; i++) {
        if (!g_session_cache[i].in_use) {
            if (empty_slot == -1) { empty_slot = i; }
            continue;
        }
        if (g_session_cache[i].access_type == access_type &&
            wstr_eq(g_session_cache[i].proxy_name, proxy_name) &&
            wstr_eq(g_session_cache[i].user_agent, user_agent)) {
            return i; /* exact match */
        }
    }
    return empty_slot; /* no match, return empty slot (or -1 if full) */
}

/* Get or create a session matching the configuration. */
static HINTERNET session_cache_get(DWORD access_type, const wchar_t* proxy_name, const wchar_t* user_agent) {
    int idx = session_cache_find(access_type, proxy_name, user_agent);
    if (idx == -1) {
        /* Cache full: evict the first entry (simple FIFO) */
        idx = 0;
        if (g_session_cache[idx].in_use) {
            if (g_session_cache[idx].session) { WinHttpCloseHandle(g_session_cache[idx].session); }
            free(g_session_cache[idx].user_agent);
            free(g_session_cache[idx].proxy_name);
            g_session_cache[idx].in_use = 0;
        }
    }
    if (!g_session_cache[idx].in_use) {
        /* Create new session */
        wchar_t* ua_copy = user_agent ? _wcsdup(user_agent) : NULL;
        wchar_t* proxy_copy = proxy_name ? _wcsdup(proxy_name) : NULL;
        HINTERNET h = WinHttpOpen(ua_copy ? ua_copy : NULL, access_type,
                                  proxy_copy ? proxy_copy : WINHTTP_NO_PROXY_NAME,
                                  WINHTTP_NO_PROXY_BYPASS, 0);
        if (!h) {
            free(ua_copy);
            free(proxy_copy);
            return NULL;
        }
        g_session_cache[idx].session = h;
        g_session_cache[idx].user_agent = ua_copy;
        g_session_cache[idx].proxy_name = proxy_copy;
        g_session_cache[idx].access_type = access_type;
        g_session_cache[idx].in_use = 1;
    }
    return g_session_cache[idx].session;
}

/* Close all cached sessions (called from DllMain on process detach). */
static void session_cache_cleanup(void) {
    for (int i = 0; i < SESSION_CACHE_SLOTS; i++) {
        if (g_session_cache[i].in_use) {
            if (g_session_cache[i].session) { WinHttpCloseHandle(g_session_cache[i].session); }
            free(g_session_cache[i].user_agent);
            free(g_session_cache[i].proxy_name);
            g_session_cache[i].in_use = 0;
        }
    }
}

/* ==========================================================================
 * The request engine
 * ========================================================================== */

/* Build the effective request headers for one hop from the parsed base list.
 * Returns a wide-char header block (calloc'd) or NULL on OOM. */
static wchar_t* build_request_headers(const hdrlist* base, const opts_t* opts,
                                      const char* hop_host, const char* first_host,
                                      int hop_https, int first_https,
                                      int drop_content_type, int convert_to_get,
                                      char** auth_header_out /* optional utf8 "Authorization: Basic ..." */) {
    buf_t hdrs = {0};
    int have_ua = 0;
    int have_auth = 0;
    for (size_t i = 0; i < base->n; i++) {
        const char* nm = base->v[i].name;
        const char* vl = base->v[i].value;
        if (ci_eq(nm, "user-agent")) { have_ua = 1; }
        if (ci_eq(nm, "authorization")) { have_auth = 1; }
        if (convert_to_get && ci_eq(nm, "content-type")) { continue; }
        if (drop_content_type && ci_eq(nm, "content-type")) { continue; }
        /* redirect auth strip: credentials never follow a different host, and
         * never follow an https->http (or any scheme) downgrade — otherwise
         * an https://host -> http://host redirect would replay the
         * Authorization header over cleartext (RFC 9110 §9.6.4). */
        if (ci_eq(nm, "authorization") &&
            ((hop_host && first_host && !ci_eq(hop_host, first_host)) ||
             (hop_https != first_https))) {
            continue;
        }
        if (!buf_apps(&hdrs, nm) || !buf_apps(&hdrs, ": ") || !buf_apps(&hdrs, vl) ||
            !buf_apps(&hdrs, "\r\n")) {
            buf_free(&hdrs);
            return NULL;
        }
    }
    /* User-Agent default only when the caller did not supply one AND opts
     * carries a UA (null userAgent -> no UA at all). */
    if (!have_ua && opts->user_agent) {
        if (!buf_apps(&hdrs, "User-Agent: ") || !buf_apps(&hdrs, opts->user_agent) ||
            !buf_apps(&hdrs, "\r\n")) {
            buf_free(&hdrs);
            return NULL;
        }
    }
    /* Preemptive Basic auth only when no explicit Authorization header. */
    if (!have_auth && opts->username) {
        buf_t cred = {0};
        buf_apps(&cred, opts->username);
        buf_putc(&cred, ':');
        if (opts->password) { buf_apps(&cred, opts->password); }
        buf_putc(&cred, '\0');
        char* b64 = NULL;
        int ok = cred.d && b64_encode((const unsigned char*)cred.d, cred.n - 1, &b64);
        buf_free(&cred);
        if (!ok) { buf_free(&hdrs); return NULL; }
        if (!buf_apps(&hdrs, "Authorization: Basic ") || !buf_apps(&hdrs, b64) ||
            !buf_apps(&hdrs, "\r\n")) {
            free(b64);
            buf_free(&hdrs);
            return NULL;
        }
        free(b64);
    }
    if (!buf_putc(&hdrs, '\0')) { buf_free(&hdrs); return NULL; }
    wchar_t* w = utf8_to_w(hdrs.d);
    buf_free(&hdrs);
    return w;
}

/* Parse the raw CRLF response header block into a lowercased header list,
 * joining repeats ", " (Set-Cookie "; "). */
static void parse_response_headers(const char* raw, hdrlist* out) {
    const char* p = raw;
    int first = 1;
    while (p && *p) {
        const char* e = strstr(p, "\r\n");
        size_t ln = e ? (size_t)(e - p) : strlen(p);
        if (!first && ln > 0) {
            const char* colon = (const char*)memchr(p, ':', ln);
            if (colon) {
                size_t nl = (size_t)(colon - p);
                const char* v = colon + 1;
                while (v < p + ln && (*v == ' ' || *v == '\t')) { v++; }
                size_t vl = (size_t)((p + ln) - v);
                char* name = str_ndup(p, nl);
                if (name) {
                    for (char* c = name; *c; c++) {
                        if (*c >= 'A' && *c <= 'Z') { *c = (char)(*c - 'A' + 'a'); }
                    }
                    char* value = str_ndup(v, vl);
                    if (value) {
                        hdr_t* existing = hdr_find(out, name);
                        if (existing) {
                            size_t old = strlen(existing->value);
                            size_t nv = old + 2 + strlen(value) + 1;
                            char* joined = (char*)malloc(nv);
                            if (joined) {
                                snprintf(joined, nv, "%s%s%s",
                                         existing->value,
                                         (ci_eq(name, "set-cookie") ? "; " : ", "),
                                         value);
                                free(existing->value);
                                existing->value = joined;
                            }
                            free(value);
                        } else {
                            hdr_push(out, name, value);
                            free(value);
                        }
                        free(name);
                    } else {
                        free(name);
                    }
                }
            }
            /* folded continuation lines (no colon): ignored */
        }
        if (!e) { break; }
        p = e + 2;
        first = 0;
    }
}

/* Get the negotiated TLS version ("1.2", ...) or NULL. Best-effort: the
 * WINHTTP_OPTION_TLS_PROTOCOL_VERSION option is only available on newer
 * Windows; when absent we report null (never guess). */
static char* query_tls_version(HINTERNET h) {
#ifndef WINHTTP_OPTION_TLS_PROTOCOL_VERSION
#define WINHTTP_OPTION_TLS_PROTOCOL_VERSION 0x10F
#endif
    DWORD tv = 0;
    DWORD tl = sizeof(tv);
    if (!WinHttpQueryOption(h, WINHTTP_OPTION_TLS_PROTOCOL_VERSION, &tv, &tl)) {
        return NULL;
    }
    if (((tv >> 8) & 0xFF) != 3) { return NULL; } /* major must be 3 (TLS) */
    unsigned minor = tv & 0xFF;
    if (minor > 4) { return NULL; }
    char tmp[8];
    snprintf(tmp, sizeof(tmp), "1.%u", minor);
    return str_dup(tmp);
}

/* The engine. Returns a malloc'd envelope (native-abi v2: the host frees it
 * via ESFreeMem — there is NO caller-side free) or NULL (OOM / uninitialized
 * backend; eshttp_last_error() set). */
static const char* engine(
    const char* method_in, const char* url_in,
    const char* headers_json, const char* body_in, const char* opts_json) {

    int64_t t0 = (int64_t)GetTickCount64();
    last_error_clear();

    /* ---------- options ---------- */
    opts_t opts;
    const char* oerr = opts_parse(opts_json, &opts);
    if (oerr) {
        opts_t zero; memset(&zero, 0, sizeof(zero));
        opts = zero;
        env_t e; memset(&e, 0, sizeof(e));
        e.err_code = "invalid-args";
        e.err_cat = "usage";
        e.err_msg = oerr;
        e.method = str_dup(method_in ? method_in : "");
        e.final_url = str_dup(url_in ? url_in : "");
        e.time_ms = (int64_t)GetTickCount64() - t0;
        buf_t b = {0};
        env_build(&e, &b);
        env_free(&e);
        if (!b.d) { return NULL; }
        return b.d;
    }

    /* ---------- method ---------- */
    if (!method_in || !*method_in || !is_method_token(method_in)) {
        opts_free(&opts);
        env_t e; memset(&e, 0, sizeof(e));
        e.err_code = "invalid-args";
        e.err_cat = "usage";
        e.err_msg = "method must be a valid HTTP token";
        e.method = str_dup(method_in ? method_in : "");
        e.final_url = str_dup(url_in ? url_in : "");
        e.time_ms = (int64_t)GetTickCount64() - t0;
        buf_t b = {0};
        env_build(&e, &b);
        env_free(&e);
        if (!b.d) { return NULL; }
        return b.d;
    }

    /* ---------- url ---------- */
    if (!url_in || !*url_in) {
        opts_free(&opts);
        env_t e; memset(&e, 0, sizeof(e));
        e.err_code = "bad-url";
        e.err_cat = "usage";
        e.err_msg = "URL is required";
        e.method = str_dup(method_in);
        e.final_url = str_dup("");
        e.time_ms = (int64_t)GetTickCount64() - t0;
        buf_t b = {0};
        env_build(&e, &b);
        env_free(&e);
        if (!b.d) { return NULL; }
        return b.d;
    }
    eshttp_url first_url;
    const char* uerr = NULL;
    if (!url_parse(url_in, &first_url, &uerr)) {
        opts_free(&opts);
        env_t e; memset(&e, 0, sizeof(e));
        e.err_code = "bad-url";
        e.err_cat = "usage";
        e.err_msg = uerr;
        e.method = str_dup(method_in);
        e.final_url = str_dup(url_in);
        e.time_ms = (int64_t)GetTickCount64() - t0;
        buf_t b = {0};
        env_build(&e, &b);
        env_free(&e);
        if (!b.d) { return NULL; }
        return b.d;
    }

    /* ---------- headers ---------- */
    hdrlist base = {0};
    const char* hdr_err = NULL;
    int hdr_kind = 0; /* 0 none, 1 invalid-args, 2 invalid-header */
    if (headers_json && *headers_json && strcmp(headers_json, "{}") != 0) {
        jv* hj = json_parse(headers_json, strlen(headers_json));
        if (!hj) { hdr_kind = 1; hdr_err = "malformed headersJson"; }
        else if (hj->kind != J_OBJ) { hdr_kind = 1; hdr_err = "headersJson must be a JSON object"; }
        else {
            /* hj->n is the CHILD count (2 per pair), so step by 2 */
            for (size_t i = 0; i + 1 < hj->n && !hdr_kind; i += 2) {
                const jv* k = hj->v[i];
                const jv* v = hj->v[i + 1];
                if (k->kind != J_STR || has_crlf(k->s, k->slen)) { hdr_kind = 2; hdr_err = "header name contains CR/LF/NUL or is not a string"; break; }
                if (v->kind == J_STR) {
                    if (has_crlf(v->s, v->slen)) { hdr_kind = 2; hdr_err = "header value contains CR/LF/NUL"; break; }
                    if (ci_eq(k->s, "host") || ci_eq(k->s, "content-length")) { continue; } /* computed by DLL */
                    if (!hdr_push(&base, k->s, v->s)) { hdr_kind = 1; hdr_err = "oom"; break; }
                } else if (v->kind == J_ARR) {
                    for (size_t a = 0; a < v->n; a++) {
                        const jv* item = v->v[a];
                        if (item->kind != J_STR) { hdr_kind = 1; hdr_err = "header value array must contain strings"; break; }
                        if (has_crlf(item->s, item->slen)) { hdr_kind = 2; hdr_err = "header value contains CR/LF/NUL"; break; }
                        if (ci_eq(k->s, "host") || ci_eq(k->s, "content-length")) { continue; }
                        if (!hdr_push(&base, k->s, item->s)) { hdr_kind = 1; hdr_err = "oom"; break; }
                    }
                } else {
                    hdr_kind = 1;
                    hdr_err = "header value must be a string or array of strings";
                }
            }
        }
        if (hj) { jv_free(hj); }
    }
    if (hdr_kind) {
        opts_free(&opts);
        hdrlist_free(&base);
        char* final_url = url_tostring(&first_url);
        env_t e; memset(&e, 0, sizeof(e));
        e.err_code = (hdr_kind == 2) ? "invalid-header" : "invalid-args";
        e.err_cat = "usage";
        e.err_msg = hdr_err;
        e.method = str_dup(method_in);
        e.final_url = final_url ? final_url : str_dup("");
        e.time_ms = (int64_t)GetTickCount64() - t0;
        buf_t b = {0};
        env_build(&e, &b);
        env_free(&e);
        url_free(&first_url);
        if (!b.d) { return NULL; }
        return b.d;
    }

    /* ---------- body ---------- */
    const unsigned char* body = NULL;
    size_t body_len = 0;
    unsigned char* decoded = NULL;
    size_t decoded_len = 0;
    if (opts.body_is_base64) {
        const char* b64 = body_in ? body_in : "";
        if (b64_decode(b64, strlen(b64), &decoded, &decoded_len) != 0) {
            opts_free(&opts);
            hdrlist_free(&base);
            char* final_url = url_tostring(&first_url);
            env_t e; memset(&e, 0, sizeof(e));
            e.err_code = "invalid-args";
            e.err_cat = "usage";
            e.err_msg = "bodyIsBase64 is set but the body is not valid base64";
            e.method = str_dup(method_in);
            e.final_url = final_url ? final_url : str_dup("");
            e.time_ms = (int64_t)GetTickCount64() - t0;
            buf_t b = {0};
            env_build(&e, &b);
            env_free(&e);
            url_free(&first_url);
            if (!b.d) { return NULL; }
            return b.d;
        }
        body = decoded;
        body_len = decoded_len;
    } else if (body_in && *body_in) {
        body = (const unsigned char*)body_in;
        body_len = strlen(body_in);
    }

    /* ---------- backend session (cached) ---------- */
    DWORD access_type = WINHTTP_ACCESS_TYPE_DEFAULT_PROXY;
    LPCWSTR proxy_name = WINHTTP_NO_PROXY_NAME;
    LPCWSTR proxy_bypass = WINHTTP_NO_PROXY_BYPASS;
    if (opts.proxy_mode == 1) { access_type = WINHTTP_ACCESS_TYPE_NO_PROXY; }
    else if (opts.proxy_mode == 2) { access_type = WINHTTP_ACCESS_TYPE_NAMED_PROXY; proxy_name = opts.proxy_w; }

    /* R-G5-E1 (errata, binding): when opts.user_agent is NULL (caller
     * suppressed the UA, or an explicit User-Agent header already won in
     * headersJson), pass NULL to WinHttpOpen so NOTHING is sent on the wire —
     * the session agent is exactly what WinHTTP appends to every request, so
     * substituting L"eshttp/1.0.0" here would re-introduce a UA the caller
     * suppressed (api-spec §6.2 row 4 / native-abi §3.1). WinHttpOpen(NULL,
     * ...) is valid and sends no User-Agent. The header block above
     * (build_request_headers) already handles the non-null case. */
    LPCWSTR ua_w = opts.user_agent ? utf8_to_w(opts.user_agent) : NULL;
    HINTERNET hSession = session_cache_get(access_type, proxy_name, ua_w);
    if (ua_w) { free((void*)ua_w); } /* free only when actually allocated */
    if (!hSession) {
        DWORD le = GetLastError();
        opts_free(&opts);
        hdrlist_free(&base);
        url_free(&first_url);
        free(decoded);
        last_error_set("WinHTTP session creation failed (code %lu)", (unsigned long)le);
        return NULL; /* uninitialized backend -> NULL + last_error */
    }

    /* ---------- redirect loop ---------- */
    char* method = str_dup(method_in);
    eshttp_url cur = first_url; /* first_url moved (we free at the end) */
    int first_hop = 1;
    int redirects = 0;
    int convert_to_get = 0;
    int encoding_was_applied = 0;
    int got_response = 0;
    int status = 0;
    char* status_text = NULL;
    char* http_version = NULL;
    char* tls_version = NULL;
    hdrlist resp_headers = {0};
    char* body_out = NULL;
    size_t body_out_len = 0;
    int body_base64 = 0;
    int64_t bytes_meta = 0;
    const char* err_code = NULL;
    const char* err_cat = NULL;
    int err_retryable = 0;
    char err_msg[512] = "";
    DWORD winhttp_err = 0;

    char* first_host = str_dup(cur.host);
    int first_https = cur.https; /* scheme of the ORIGINAL request (auth-strip basis) */

    for (;;) {
        /* per-hop request handles */
        wchar_t* host_w = utf8_to_w(cur.host);
        wchar_t* path_w = utf8_to_w(cur.path);
        wchar_t* method_w = utf8_to_w(method);
        wchar_t* headers_w = NULL;
        if (!host_w || !path_w || !method_w) {
            free(host_w); free(path_w); free(method_w);
            winhttp_err = ERROR_NOT_ENOUGH_MEMORY;
            err_code = "internal"; err_cat = "internal"; err_retryable = 0;
            snprintf(err_msg, sizeof(err_msg), "out of memory");
            break;
        }
        HINTERNET hConn = WinHttpConnect(hSession, host_w, (INTERNET_PORT)cur.port, 0);
        if (!hConn) {
            DWORD le = GetLastError();
            free(host_w); free(path_w); free(method_w);
            winhttp_err = le;
            errinfo ei = map_winhttp(le);
            err_code = ei.code; err_cat = ei.cat; err_retryable = ei.retryable;
            errmsg(&ei, le, cur.host, cur.port, opts.timeout_ms, opts.max_body, opts.max_redirects, err_msg, sizeof(err_msg));
            break;
        }
        /* timeouts: resolve/connect/send/receive from opts.timeoutMs */
        DWORD tmo = (DWORD)opts.timeout_ms;
        WinHttpSetTimeouts(hConn, tmo, tmo, tmo, tmo);

        DWORD flags = cur.https ? WINHTTP_FLAG_SECURE : 0;
        HINTERNET hReq = WinHttpOpenRequest(hConn, method_w, path_w, NULL, WINHTTP_NO_REFERER,
                                            WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
        if (!hReq) {
            DWORD le = GetLastError();
            WinHttpCloseHandle(hConn);
            free(host_w); free(path_w); free(method_w);
            winhttp_err = le;
            errinfo ei = map_winhttp(le);
            err_code = ei.code; err_cat = ei.cat; err_retryable = ei.retryable;
            errmsg(&ei, le, cur.host, cur.port, opts.timeout_ms, opts.max_body, opts.max_redirects, err_msg, sizeof(err_msg));
            break;
        }
        /* manual redirects */
        DWORD rp = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        WinHttpSetOption(hReq, WINHTTP_OPTION_REDIRECT_POLICY, &rp, sizeof(rp));
        /* verifyTls:false -> disable cert validation only */
        if (!opts.verify_tls) {
            DWORD sf = SECURITY_FLAG_IGNORE_UNKNOWN_CA | SECURITY_FLAG_IGNORE_CERT_DATE_INVALID |
                       SECURITY_FLAG_IGNORE_CERT_CN_INVALID | SECURITY_FLAG_IGNORE_CERT_WRONG_USAGE;
            WinHttpSetOption(hReq, WINHTTP_OPTION_SECURITY_FLAGS, &sf, sizeof(sf));
        }
        /* decompress: WINHTTP_OPTION_DECOMPRESSION when settable */
        if (opts.decompress) {
            DWORD dec = WINHTTP_DECOMPRESSION_FLAG_ALL;
            if (WinHttpSetOption(hReq, WINHTTP_OPTION_DECOMPRESSION, &dec, sizeof(dec))) {
                encoding_was_applied = 1;
            }
        }
        /* effective headers for this hop */
        headers_w = build_request_headers(&base, &opts, cur.host, first_host,
                                          cur.https, first_https,
                                          convert_to_get, convert_to_get, NULL);
        if (!headers_w) {
            WinHttpCloseHandle(hReq);
            WinHttpCloseHandle(hConn);
            free(host_w); free(path_w); free(method_w);
            winhttp_err = ERROR_NOT_ENOUGH_MEMORY;
            err_code = "internal"; err_cat = "internal"; err_retryable = 0;
            snprintf(err_msg, sizeof(err_msg), "out of memory");
            break;
        }

        BOOL sent = WinHttpSendRequest(hReq, headers_w, (DWORD)-1L,
                                       body_len ? (LPVOID)body : NULL,
                                       (DWORD)body_len, (DWORD)body_len, 0);
        if (!sent) {
            DWORD le = GetLastError();
            WinHttpCloseHandle(hReq);
            WinHttpCloseHandle(hConn);
            free(headers_w); free(host_w); free(path_w); free(method_w);
            winhttp_err = le;
            errinfo ei = map_winhttp(le);
            err_code = ei.code; err_cat = ei.cat; err_retryable = ei.retryable;
            errmsg(&ei, le, cur.host, cur.port, opts.timeout_ms, opts.max_body, opts.max_redirects, err_msg, sizeof(err_msg));
            break;
        }
        if (!WinHttpReceiveResponse(hReq, NULL)) {
            DWORD le = GetLastError();
            WinHttpCloseHandle(hReq);
            WinHttpCloseHandle(hConn);
            free(headers_w); free(host_w); free(path_w); free(method_w);
            winhttp_err = le;
            errinfo ei = map_winhttp(le);
            err_code = ei.code; err_cat = ei.cat; err_retryable = ei.retryable;
            errmsg(&ei, le, cur.host, cur.port, opts.timeout_ms, opts.max_body, opts.max_redirects, err_msg, sizeof(err_msg));
            break;
        }
        got_response = 1;

        /* status / statusText / http version */
        DWORD st = 0, stl = sizeof(st);
        if (WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &st, &stl, WINHTTP_NO_HEADER_INDEX)) {
            status = (int)st;
        }
        {
            /* MSDN two-step query: the first call (NULL buffer) fails with
             * ERROR_INSUFFICIENT_BUFFER and returns the required size in len2;
             * gate on len2, not on the first call's return value. */
            DWORD len2 = 0;
            WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_TEXT, WINHTTP_HEADER_NAME_BY_INDEX,
                                NULL, &len2, WINHTTP_NO_HEADER_INDEX);
            if (len2 > 0) {
                wchar_t* wt = (wchar_t*)malloc((size_t)len2 + sizeof(wchar_t));
                if (wt) {
                    if (WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_TEXT, WINHTTP_HEADER_NAME_BY_INDEX,
                                            wt, &len2, WINHTTP_NO_HEADER_INDEX)) {
                        status_text = w_to_utf8(wt);
                    }
                    free(wt);
                }
            }
        }
        {
            DWORD len2 = 0;
            WinHttpQueryHeaders(hReq, WINHTTP_QUERY_VERSION, WINHTTP_HEADER_NAME_BY_INDEX,
                                NULL, &len2, WINHTTP_NO_HEADER_INDEX);
            if (len2 > 0) {
                wchar_t* wt = (wchar_t*)malloc((size_t)len2 + sizeof(wchar_t));
                if (wt) {
                    if (WinHttpQueryHeaders(hReq, WINHTTP_QUERY_VERSION, WINHTTP_HEADER_NAME_BY_INDEX,
                                            wt, &len2, WINHTTP_NO_HEADER_INDEX)) {
                        char* v = w_to_utf8(wt);
                        if (v) {
                            const char* prefix = "HTTP/";
                            if (ci_starts(v, prefix)) { memmove(v, v + 5, strlen(v + 5) + 1); }
                            free(http_version);
                            http_version = v;
                        }
                    }
                    free(wt);
                }
            }
        }
        if (cur.https) { tls_version = query_tls_version(hReq); }

        /* raw response headers (WinHTTP returns these as UTF-16, so convert
         * to UTF-8 before parsing) */
        {
            DWORD hl = 0;
            WinHttpQueryHeaders(hReq, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                                NULL, &hl, WINHTTP_NO_HEADER_INDEX);
            if (hl > 0) {
                /* Defensive allocation: the WINHTTP_QUERY_RAW_HEADERS_CRLF
                 * size probe is documented to include the terminating null on
                 * some Windows versions and not on others. Allocate one extra
                 * wchar_t and zero-fill so w_to_utf8 (which reads until a NUL)
                 * can never walk off the end of the buffer on a quirk. */
                wchar_t* raw = (wchar_t*)calloc((size_t)hl + sizeof(wchar_t), 1);
                if (raw) {
                    /* Use a SEPARATE length variable for the second call: the
                     * first (size probe) call and the second (copy) call are
                     * distinct queries, and WinHTTP updates the length on
                     * output — reusing hl would hand the second call a
                     * possibly-shrunk value. */
                    DWORD hl2 = hl;
                    if (WinHttpQueryHeaders(hReq, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                                            raw, &hl2, WINHTTP_NO_HEADER_INDEX)) {
                        char* raw8 = w_to_utf8(raw);
                        if (raw8) {
                            parse_response_headers(raw8, &resp_headers);
                            free(raw8);
                        }
                    }
                    free(raw);
                }
            }
        }

        /* body (maxBodyBytes enforced) */
        /* Pre-allocate body buffer based on Content-Length if available */
        size_t body_initial_cap = 0;
        hdr_t* cl_hdr = hdr_find(&resp_headers, "content-length");
        if (cl_hdr && cl_hdr->value) {
            long cl = strtol(cl_hdr->value, NULL, 10);
            if (cl > 0 && (opts.max_body <= 0 || cl <= opts.max_body)) {
                body_initial_cap = (size_t)cl;
            }
        }
        /* Cap initial allocation at 1MB to avoid excessive allocation for malformed headers */
        if (body_initial_cap > 1048576) { body_initial_cap = 1048576; }
        buf_t bbody = {0};
        if (body_initial_cap > 0) {
            bbody.d = (char*)malloc(body_initial_cap + 1);
            if (bbody.d) {
                bbody.cap = body_initial_cap + 1;
                bbody.n = 0;
            }
        }
        int64_t total = 0;
        int body_too_large = 0;
        for (;;) {
            DWORD avail = 0;
            if (!WinHttpQueryDataAvailable(hReq, &avail)) {
                DWORD le = GetLastError();
                WinHttpCloseHandle(hReq);
                WinHttpCloseHandle(hConn);
                free(headers_w); free(host_w); free(path_w); free(method_w);
                buf_free(&bbody);
                winhttp_err = le;
                errinfo ei = map_winhttp(le);
                err_code = ei.code; err_cat = ei.cat; err_retryable = ei.retryable;
                errmsg(&ei, le, cur.host, cur.port, opts.timeout_ms, opts.max_body, opts.max_redirects, err_msg, sizeof(err_msg));
                bytes_meta = total;
                free(body_out); body_out = NULL;
                goto body_done;
            }
            if (avail == 0) { break; }
            if (opts.max_body > 0 && total + (int64_t)avail > opts.max_body) {
                body_too_large = 1;
                break;
            }
            while (avail > 0) {
                /* Use 64KB read buffer for better throughput */
                char tmp[65536];
                DWORD want = avail < sizeof(tmp) ? avail : (DWORD)sizeof(tmp);
                DWORD got = 0;
                if (!WinHttpReadData(hReq, tmp, want, &got)) {
                    DWORD le = GetLastError();
                    WinHttpCloseHandle(hReq);
                    WinHttpCloseHandle(hConn);
                    free(headers_w); free(host_w); free(path_w); free(method_w);
                    buf_free(&bbody);
                    winhttp_err = le;
                    errinfo ei = map_winhttp(le);
                    err_code = ei.code; err_cat = ei.cat; err_retryable = ei.retryable;
                    errmsg(&ei, le, cur.host, cur.port, opts.timeout_ms, opts.max_body, opts.max_redirects, err_msg, sizeof(err_msg));
                    bytes_meta = total;
                    free(body_out); body_out = NULL;
                    goto body_done;
                }
                if (got == 0) { break; }
                if (!buf_app(&bbody, tmp, got)) {
                    WinHttpCloseHandle(hReq);
                    WinHttpCloseHandle(hConn);
                    free(headers_w); free(host_w); free(path_w); free(method_w);
                    buf_free(&bbody);
                    winhttp_err = ERROR_NOT_ENOUGH_MEMORY;
                    err_code = "internal"; err_cat = "internal"; err_retryable = 0;
                    snprintf(err_msg, sizeof(err_msg), "out of memory");
                    bytes_meta = total;
                    free(body_out); body_out = NULL;
                    goto body_done;
                }
                total += got;
                avail -= got;
            }
        }
        bytes_meta = total;
        if (body_too_large) {
            WinHttpCloseHandle(hReq);
            WinHttpCloseHandle(hConn);
            free(headers_w); free(host_w); free(path_w); free(method_w);
            buf_free(&bbody);
            err_code = "body-too-large";
            err_cat = "protocol";
            err_retryable = 0;
            snprintf(err_msg, sizeof(err_msg), "Response body exceeds maxBodyBytes (%lld)", (long long)opts.max_body);
            break;
        }
        body_out = (char*)bbody.d; /* take ownership */
        body_out_len = bbody.n;

    body_done:
        WinHttpCloseHandle(hReq);
        WinHttpCloseHandle(hConn);
        free(headers_w);
        free(host_w); free(path_w); free(method_w);
        if (err_code) { break; } /* transport error already recorded */

        /* ---------- redirect handling ---------- */
        if (opts.follow && (status == 301 || status == 302 || status == 303 ||
                            status == 307 || status == 308)) {
            hdr_t* loc = hdr_find(&resp_headers, "location");
            if (loc && loc->value && *loc->value) {
                if (redirects >= opts.max_redirects) {
                    err_code = "too-many-redirects";
                    err_cat = "protocol";
                    err_retryable = 0;
                    snprintf(err_msg, sizeof(err_msg), "Too many redirects (max %d)", opts.max_redirects);
                    break;
                }
                char* resolved = url_resolve(&cur, loc->value);
                if (!resolved) {
                    err_code = "bad-url";
                    err_cat = "usage";
                    err_retryable = 0;
                    snprintf(err_msg, sizeof(err_msg), "Redirect Location header is not a valid URL");
                    break;
                }
                eshttp_url nu;
                const char* ne = NULL;
                if (!url_parse(resolved, &nu, &ne)) {
                    free(resolved);
                    err_code = "bad-url";
                    err_cat = "usage";
                    err_retryable = 0;
                    snprintf(err_msg, sizeof(err_msg), "Redirect Location header is not a valid URL");
                    break;
                }
                free(resolved);
                if (status == 301 || status == 302 || status == 303) {
                    free(method);
                    method = str_dup("GET");
                    convert_to_get = 1;
                    body = NULL;
                    body_len = 0;
                }
                url_free(&cur);
                cur = nu;
                redirects++;
                hdrlist_free(&resp_headers);
                free(body_out);
                body_out = NULL;
                body_out_len = 0;
                continue;
            }
            /* no Location -> fall through, return the 3xx as-is */
        }
        break;
    }

    /* meta.finalUrl = the LAST hop's URL (after any redirects), per
     * native-abi §4. Captured before cur is torn down. */
    char* final_url_str = url_tostring(&cur);
    free(first_host);
    free(method);
    url_free(&cur);
    opts_free(&opts);
    hdrlist_free(&base);
    free(decoded);
    /* hSession is cached; do NOT close it here */

    /* ---------- content sniffing (native-abi §4.1) ---------- */
    if (!err_code && got_response) {
        int text = 0;
        hdr_t* ct = hdr_find(&resp_headers, "content-type");
        if (ct && ct->value) {
            /* take the media type token up to ';' */
            const char* v = ct->value;
            size_t vl = strlen(v);
            const char* semi = memchr(v, ';', vl);
            size_t tl = semi ? (size_t)(semi - v) : vl;
            char* type = str_ndup(v, tl);
            if (type) {
                /* trim trailing space */
                while (tl > 0 && (type[tl - 1] == ' ' || type[tl - 1] == '\t')) { type[--tl] = '\0'; }
                if (ci_starts(type, "text/") ||
                    ci_eq(type, "application/json") ||
                    ci_eq(type, "application/xml") ||
                    ci_eq(type, "application/javascript") ||
                    ci_eq(type, "application/x-www-form-urlencoded") ||
                    ci_eq(type, "application/xhtml+xml") ||
                    ci_eq(type, "application/atom+xml")) {
                    text = 1;
                }
                free(type);
            }
        }
        /* NUL guard: binary content with a text content-type -> base64 */
        if (text && body_out_len > 0 && memchr(body_out, 0, body_out_len)) { text = 0; }
        if (body_out_len == 0) { text = 1; }
        body_base64 = text ? 0 : 1;
        if (text) {
            size_t fixed_len = 0;
            char* fixed = utf8_fix(body_out ? body_out : "", body_out ? body_out_len : 0, &fixed_len);
            if (fixed) { free(body_out); body_out = fixed; body_out_len = fixed_len; }
        }
    }

    /* ---------- assemble envelope ---------- */
    /* §4.3 invariant: error != null ⟺ no usable HTTP response. Any error
     * (transport, too-many-redirects, body-too-large, ...) -> ok:false,
     * status:0; only clean responses (including 4xx/5xx) carry the real
     * status with error:null. Mirrors the socket-path redirector, which
     * returns a status:0 error result on a capped redirect chain. */
    if (err_code) { free(status_text); status_text = NULL; }
    env_t e; memset(&e, 0, sizeof(e));
    e.ok = (got_response && !err_code) ? 1 : 0;
    e.status = (got_response && !err_code) ? status : 0;
    e.status_text = status_text ? status_text : str_dup("");
    e.headers = resp_headers;
    e.body = body_out;
    e.body_len = body_out_len;
    e.body_base64 = body_base64;
    if (err_code) {
        e.err_code = err_code;
        e.err_cat = err_cat;
        e.err_retryable = err_retryable;
        e.err_msg = err_msg;
    }
    e.method = str_dup(method_in); /* original method in meta */
    e.final_url = final_url_str;   /* ownership moves into the envelope */
    if (!e.final_url) { e.final_url = str_dup(""); }
    e.redirects = redirects;
    e.time_ms = (int64_t)GetTickCount64() - t0;
    e.bytes = err_code ? bytes_meta : (int64_t)body_out_len;
    e.http_version = http_version;
    e.tls_version = tls_version;
    e.encoding_was_applied = encoding_was_applied;
    e.winhttp_err = winhttp_err;

    /* Pre-allocate envelope buffer: typical envelope is 1-4KB without body.
     * With body, the body is written separately (base64 or utf8_fix), so
     * the envelope structure itself is small. Use 4KB initial capacity. */
    buf_t out = {0};
    out.d = (char*)malloc(4096);
    if (out.d) {
        out.cap = 4096;
        out.n = 0;
    }
    if (!env_build(&e, &out)) {
        env_free(&e);
        buf_free(&out);
        last_error_set("out of memory building envelope");
        return NULL;
    }
    env_free(&e);
    return out.d;
}

/* ==========================================================================
 * Exported API (native-abi v2 — exactly 8 exports: 4 ES* + 4 business)
 * Canonical ExtendScript ExternalObject direct-interface shape:
 *   long fn(TaggedData* argv, long argc, TaggedData* retval)
 * (SoSharedLibDefs.h ESFunction typedef). The host calls every export with
 * (argv, argc, retval); ESInitialize's signature string drives arg casting.
 * ========================================================================== */

/* --- TaggedData helpers (ESON eson_json.c pattern) --- */
static void abi_clear_retval(TaggedData* retval) {
    if (!retval) return;
    retval->data.intval = 0;
    retval->type = kTypeUndefined;
    retval->filler = 0;
}

/* kTypeString (4): the returned buffer must be malloc'd — ExtendScript frees
 * it via ESFreeMem (this DLL's ESFreeMem = free). */
static void abi_set_string(TaggedData* retval, char* value) {
    if (!retval) return;
    retval->data.string = value ? value : (char*)"";
    retval->type = kTypeString;
    retval->filler = 0;
}

/* kTypeInteger (123): JS receives a number (data.intval). Verified. */
static void abi_set_integer(TaggedData* retval, long value) {
    if (!retval) return;
    retval->data.intval = value;
    retval->type = kTypeInteger;
    retval->filler = 0;
}

/* Read a kTypeString argument per the declared _s signature cast. Returns 0
 * (and leaves *value untouched) when the arg is absent or not a string. */
static int abi_string_arg(TaggedData* argv, long argc, long index,
                          const char** value) {
    if (!argv || index < 0 || index >= argc) return 0;
    if (argv[index].type != kTypeString) return 0; /* _s signature cast */
    *value = argv[index].data.string ? argv[index].data.string : "";
    return 1;
}

/* --- mandatory ES* lifecycle exports --- */

/* Signature metadata string. v2 (pinned): no-arg methods declared with a
 * dummy `_f` (bare no-arg names are unreliable per the skill; ESON uses _f
 * for all no-arg methods). Malloc'd — freed via ESFreeMem like any returned
 * string (ESON verified pattern). */
ESHTTP_API char* ESHTTP_CALL ESInitialize(TaggedData* argv, long argc) {
    (void)argv; (void)argc;
    return str_dup("eshttp_request_sssss,eshttp_last_error_f,"
                   "eshttp_version_f,eshttp_available_f");
}

/* Version exposed as the read-only ExternalObject.version property (= 1). */
ESHTTP_API long ESHTTP_CALL ESGetVersion(void) { return 1; }

/* Release a returned buffer. MUST match the DLL's allocator (free). */
ESHTTP_API void ESHTTP_CALL ESFreeMem(void* p) { free(p); }

/* Release persistent native state (session cache) during unload. */
ESHTTP_API void ESHTTP_CALL ESTerminate(void) { session_cache_cleanup(); }

/* --- business methods (direct-interface shape) --- */

/* eshttp_request(m, u, h, b, o) -> kTypeString envelope. 5 kTypeString args
 * per the _sssss signature cast. Returns kESErrOK or kESErrBadArgumentList
 * (catchable). Never returns a negative code. */
ESHTTP_API long ESHTTP_CALL eshttp_request(
    TaggedData* argv, long argc, TaggedData* retval) {

    const char* method = NULL, *url = NULL, *headers_json = NULL,
               *body = NULL, *opts_json = NULL;
    const char* env;
    abi_clear_retval(retval);
    if (!abi_string_arg(argv, argc, 0, &method) ||
        !abi_string_arg(argv, argc, 1, &url) ||
        !abi_string_arg(argv, argc, 2, &headers_json) ||
        !abi_string_arg(argv, argc, 3, &body) ||
        !abi_string_arg(argv, argc, 4, &opts_json)) {
        return kESErrBadArgumentList; /* catchable (>= 0) */
    }
    env = engine(method, url, headers_json, body, opts_json);
    if (!env) {
        /* OOM / uninitialized backend. The v1 NULL+last_error contract is
         * replaced: build an "internal" error envelope (never return NULL —
         * the host requires a set retval; negative codes are fatal). */
        char* msg = str_dup(g_last_error[0] ? g_last_error
                                            : "eshttp native backend unavailable");
        if (!msg) { return kESErrOK; /* retval stays undefined */ }
        abi_set_string(retval, msg);
        return kESErrOK;
    }
    /* env is a malloc'd/calloc'd envelope — the host frees it via ESFreeMem. */
    abi_set_string(retval, (char*)env);
    return kESErrOK;
}

/* eshttp_last_error(0) -> kTypeString (malloc'd copy of the last error).
 * The v1 DLL-owned static buffer must NOT be returned (the host would free
 * it via ESFreeMem — returning a static buffer would be freed illegally). */
ESHTTP_API long ESHTTP_CALL eshttp_last_error(
    TaggedData* argv, long argc, TaggedData* retval) {
    (void)argv; (void)argc;
    abi_clear_retval(retval);
    abi_set_string(retval, str_dup(g_last_error));
    return kESErrOK;
}

/* eshttp_version(0) -> kTypeString (malloc'd copy of the version string). */
ESHTTP_API long ESHTTP_CALL eshttp_version(
    TaggedData* argv, long argc, TaggedData* retval) {
    (void)argv; (void)argc;
    abi_clear_retval(retval);
    abi_set_string(retval, str_dup(ESHTTP_VERSION));
    return kESErrOK;
}

/* eshttp_available(0) -> kTypeInteger 1/0 (WinHTTP backend probe). */
ESHTTP_API long ESHTTP_CALL eshttp_available(
    TaggedData* argv, long argc, TaggedData* retval) {
    HINTERNET h;
    long ok = 0;
    (void)argv; (void)argc;
    abi_clear_retval(retval);
    h = WinHttpOpen(L"eshttp/1.0.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (h) {
        WinHttpCloseHandle(h);
        ok = 1;
    }
    abi_set_integer(retval, ok);
    return kESErrOK;
}

/* ==========================================================================
 * Selftest hooks (ESHTTP_STATIC only — compiled into selftest.c)
 * ========================================================================== */
#if defined(ESHTTP_SELFTEST)
int eshttp_st_utf8_decode(const unsigned char* s, size_t n, size_t* used) { return utf8_decode(s, n, used); }
int eshttp_st_b64_decode(const char* in, size_t n, unsigned char** out, size_t* outlen) { return b64_decode(in, n, out, outlen); }
int eshttp_st_b64_encode(const unsigned char* in, size_t n, char** out) { return b64_encode(in, n, out); }
int eshttp_st_url_parse(const char* url, eshttp_url* out, const char** err) { return url_parse(url, out, err); }
char* eshttp_st_url_tostring(const eshttp_url* u) { return url_tostring(u); }
char* eshttp_st_url_resolve(const eshttp_url* base, const char* loc) { return url_resolve(base, loc); }
int eshttp_st_ci_eq(const char* a, const char* b) { return ci_eq(a, b); }
void eshttp_st_wstr(buf_t* b, const char* s, size_t n) { w_str(b, s, n); }
errinfo eshttp_st_map_winhttp(DWORD e) { return map_winhttp(e); }
char* eshttp_st_utf8_fix(const char* s, size_t n, size_t* out_len) { return utf8_fix(s, n, out_len); }
void eshttp_st_parse_response_headers(const char* raw, hdrlist* out) { parse_response_headers(raw, out); }
#endif /* ESHTTP_SELFTEST */

/* ==========================================================================
 * DllMain (DLL build only)
 * ========================================================================== */
#if defined(ESHTTP_BUILD)
BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    (void)hinst; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) { DisableThreadLibraryCalls(hinst); }
    else if (reason == DLL_PROCESS_DETACH) { session_cache_cleanup(); }
    return TRUE;
}
#endif
