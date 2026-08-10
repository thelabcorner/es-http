/*
 * selftest.c — N16: compilable harness for the eshttp native accelerator.
 *
 * Contract: eshttp/docs/native-abi.md (native-abi-v2, binding)
 *           eshttp/docs/api-spec.md §6.2 (User-Agent wire rule) / §7 / §8
 * Acceptance: integration-checklist.md N1-N16 (t1 gate)
 *
 * WHAT IT DOES
 *   - Statically links eshttp.c (ESHTTP_STATIC + ESHTTP_SELFTEST) so the
 *     exported API and every static helper are in this one translation unit.
 *   - Drives the ESHTTP_SELFTEST hooks (eshttp_st_*) + the exported API.
 *   - Runs a local loopback HTTP server (WinSock, no external deps) so the
 *     REAL wire bytes can be captured and asserted — including the R-G5-E1
 *     proof: a suppressed User-Agent puts ZERO "user-agent" bytes on the
 *     wire, while the normal case sends exactly one.
 *   - Requires NO network access (everything is 127.0.0.1 / 127.0.0.2).
 *
 * BUILD + RUN (MSVC, any bitness; see native/BUILD.md for the full story):
 *   cl /nologo /TC /MT /O2 /D ESHTTP_STATIC /D ESHTTP_SELFTEST
 *      /D WIN32_LEAN_AND_MEAN /D _CRT_SECURE_NO_WARNINGS
 *      selftest.c /Fe:eshttp-selftest.exe
 *   eshttp-selftest.exe
 *   (winhttp.lib / ws2_32.lib are linked via #pragma comment(lib) — do NOT
 *   pass them on the command line, because /TC would read them as C sources.)
 *
 * Exit code: 0 = all green, 1 = one or more assertions failed.
 */

#define WIN32_LEAN_AND_MEAN   /* keep <windows.h> from pulling winsock.h */
#define _CRT_SECURE_NO_WARNINGS
#define ESHTTP_STATIC         /* link eshttp.c statically (no DLL) */
#define ESHTTP_SELFTEST       /* expose the eshttp_st_* hooks */

#include <winsock2.h>
#include <ws2tcpip.h>

#include "eshttp.c"           /* same-TU: API + statics + hooks */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "ws2_32.lib")

/* ==========================================================================
 * Tiny test harness
 * ========================================================================== */
static int g_pass = 0;
static int g_fail = 0;

static void do_check(int cond, const char* name) {
    if (cond) { g_pass++; printf("  PASS  %s\n", name); }
    else      { g_fail++; printf("  FAIL  %s\n", name); }
}
#define CHECK(cond, name) do_check((cond), (name))

/* printf-style variant (message built into a local buffer first). */
static void checkf(int cond, const char* fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    do_check(cond, buf);
}

/* ASCII-only case-insensitive helpers (independent of eshttp internals). */
static char ci_lc(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c; }
static int s_contains(const char* hay, const char* needle) {
    return strstr(hay, needle) != NULL;
}
static int s_contains_ci(const char* hay, const char* needle) {
    size_t hn = strlen(hay), nn = strlen(needle);
    if (nn == 0) { return 1; }
    if (nn > hn) { return 0; }
    for (size_t i = 0; i + nn <= hn; i++) {
        size_t k = 0;
        while (k < nn && ci_lc(hay[i + k]) == ci_lc(needle[k])) { k++; }
        if (k == nn) { return 1; }
    }
    return 0;
}
static int s_count_ci(const char* hay, const char* needle) {
    size_t hn = strlen(hay), nn = strlen(needle), n = 0;
    if (nn == 0 || nn > hn) { return 0; }
    for (size_t i = 0; i + nn <= hn; i++) {
        size_t k = 0;
        while (k < nn && ci_lc(hay[i + k]) == ci_lc(needle[k])) { k++; }
        if (k == nn) { n++; i += nn - 1; }
    }
    return (int)n;
}

/* Envelope fragment checks — the writer emits compact JSON (no spaces), so
 * these strstr probes are deterministic. */
static int env_abi(const char* e)            { return s_contains(e, "\"abi\":\"http-v1\""); }
static int env_ok(const char* e, int v)      { return s_contains(e, v ? "\"ok\":true" : "\"ok\":false"); }
static int env_status(const char* e, int st) { char f[64]; snprintf(f, sizeof(f), "\"status\":%d", st); return s_contains(e, f); }
static int env_err_null(const char* e)       { return s_contains(e, "\"error\":null"); }
static int env_err_code(const char* e, const char* code) {
    char f[96]; snprintf(f, sizeof(f), "\"error\":{\"code\":\"%s\"", code); return s_contains(e, f);
}
static int env_body_enc(const char* e, const char* enc) {
    char f[64]; snprintf(f, sizeof(f), "\"bodyEncoding\":\"%s\"", enc); return s_contains(e, f);
}
static int env_redirects(const char* e, int n) { char f[64]; snprintf(f, sizeof(f), "\"redirects\":%d", n); return s_contains(e, f); }

/* native-abi v2: drive the exported direct-interface shape (TaggedData
 * argv/retval). Returns the malloc'd envelope (ownership passes to the
 * caller, freed via ESFreeMem — exactly what the host does). */
static const char* do_req(const char* m, const char* u, const char* h,
                          const char* b, const char* o) {
    TaggedData argv[5];
    TaggedData retval;
    const char* strs[5] = { m ? m : "", u ? u : "", h ? h : "",
                            b ? b : "", o ? o : "" };
    long i;
    memset(argv, 0, sizeof(argv));
    for (i = 0; i < 5; i++) {
        argv[i].type = kTypeString;
        argv[i].data.string = (char*)strs[i];
        argv[i].filler = 0;
    }
    memset(&retval, 0, sizeof(retval));
    if (eshttp_request(argv, 5, &retval) != kESErrOK) { return NULL; }
    if (retval.type != kTypeString) { return NULL; }
    return retval.data.string; /* malloc'd; caller frees via ESFreeMem */
}

/* v2: no caller-side free — free the way the host does (ESFreeMem = free). */
#define env_free(env) ESFreeMem((void*)(env))

/* ==========================================================================
 * Local loopback HTTP server (wire capture)
 *
 * Listens on INADDR_ANY:ephemeral (covers 127.0.0.1 AND 127.0.0.2, both
 * loopback — used for the cross-host redirect test). Each accepted request
 * is stored verbatim (raw request bytes) in a capture log so tests can
 * assert on the actual wire data, then answered from a tiny router.
 * ========================================================================== */
#define MAX_CAPTURES 64

typedef struct { char* raw; size_t len; } capture;

typedef struct {
    SOCKET listener;
    unsigned short port;
    HANDLE thread;
    CRITICAL_SECTION cs;
    capture caps[MAX_CAPTURES];
    int count;
} server_ctx;

static server_ctx g_srv;

static int srv_count(void) {
    int c; EnterCriticalSection(&g_srv.cs); c = g_srv.count; LeaveCriticalSection(&g_srv.cs);
    return c;
}

static const capture* srv_get(int i) {
    return (i >= 0 && i < g_srv.count) ? &g_srv.caps[i] : NULL;
}

static void srv_print_capture(int i, const char* label) {
    const capture* c = srv_get(i);
    if (!c) { printf("    [no capture %d]\n", i); return; }
    printf("    --- %s (capture %d, %u bytes) ---\n", label, i, (unsigned)c->len);
    for (size_t k = 0; k < c->len; k++) {
        if (c->raw[k] == '\r') { printf("\\r"); }
        else if (c->raw[k] == '\n') { printf("\\n\n"); }
        else { putchar(c->raw[k]); }
    }
    printf("\n");
}

static const char* srv_reason(int code) {
    switch (code) {
        case 200: return "OK";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 303: return "See Other";
        case 307: return "Temporary Redirect";
        case 308: return "Permanent Redirect";
        case 404: return "Not Found";
        case 500: return "Internal Server Error";
        default:  return "Status";
    }
}

/* Find "content-length:" (case-insensitive) in [start, end) of a raw request
 * header block. Returns 1 and sets *out when present. */
static int block_content_length(const char* start, const char* end, long* out) {
    const char* p = start;
    while (p < end) {
        const char* eol = p;
        while (eol < end && eol[0] != '\r' && eol[0] != '\n') { eol++; }
        size_t ln = (size_t)(eol - p);
        if (ln >= 15) {
            static const char* KEY = "content-length:";
            int match = 1;
            for (int i = 0; i < 15; i++) {
                if (ci_lc(p[i]) != KEY[i]) { match = 0; break; }
            }
            if (match) {
                const char* v = p + 15;
                while (v < eol && (*v == ' ' || *v == '\t')) { v++; }
                *out = strtol(v, NULL, 10);
                return 1;
            }
        }
        if (eol >= end) { break; }
        p = eol;
        while (p < end && (*p == '\r' || *p == '\n')) { p++; }
    }
    return 0;
}

static void server_send(SOCKET c, int status, const char* ctype,
                        const char* body, size_t body_len,
                        const char* extra_hdrs) {
    char head[512];
    int hn = snprintf(head, sizeof(head),
                      "HTTP/1.1 %d %s\r\n"
                      "Content-Type: %s\r\n"
                      "Content-Length: %u\r\n"
                      "%s"           /* e.g. "Location: /x\r\n" or "" */
                      "Connection: close\r\n"
                      "\r\n",
                      status, srv_reason(status), ctype, (unsigned)body_len,
                      extra_hdrs ? extra_hdrs : "");
    send(c, head, hn, 0);
    if (body_len > 0) { send(c, body, (int)body_len, 0); }
}

static void server_handle(SOCKET c) {
    /* read the full request */
    buf_t b = {0};
    char tmp[8192];
    long expected_body = -1;      /* -1 = headers not finished yet */
    for (;;) {
        int r = recv(c, tmp, sizeof(tmp), 0);
        if (r <= 0) { break; }
        if (!buf_app(&b, tmp, (size_t)r)) { buf_free(&b); closesocket(c); return; }
        if (expected_body < 0) {
            const char* end = NULL;
            for (size_t i = 0; i + 3 < b.n; i++) {
                if (b.d[i] == '\r' && b.d[i+1] == '\n' && b.d[i+2] == '\r' && b.d[i+3] == '\n') {
                    end = &b.d[i]; break;
                }
            }
            if (end) {
                long cl = 0;
                if (!block_content_length(b.d, end, &cl)) { cl = 0; }
                expected_body = cl;
            }
        }
        if (expected_body >= 0) {
            size_t hs = 0;
            for (size_t i = 0; i + 3 < b.n; i++) {
                if (b.d[i] == '\r' && b.d[i+1] == '\n' && b.d[i+2] == '\r' && b.d[i+3] == '\n') {
                    hs = i + 4; break;
                }
            }
            if (b.n >= hs + (size_t)expected_body) { break; }
        }
    }
    if (b.n == 0) { buf_free(&b); closesocket(c); return; }

    /* store the raw request (wire capture); ownership of b.d moves into the
     * capture log on success, otherwise we free it here */
    char* raw = b.d;
    size_t rawlen = b.n;
    int stored = 0;
    EnterCriticalSection(&g_srv.cs);
    if (g_srv.count < MAX_CAPTURES) {
        g_srv.caps[g_srv.count].raw = raw;
        g_srv.caps[g_srv.count].len = rawlen;
        g_srv.count++;
        stored = 1;
    }
    LeaveCriticalSection(&g_srv.cs);
    if (!stored) { free(raw); closesocket(c); return; }

    /* parse the request line: METHOD TARGET VERSION */
    char* line_end = strstr(raw, "\r\n");
    size_t linelen = line_end ? (size_t)(line_end - raw) : rawlen;
    char line[1024];
    if (linelen >= sizeof(line)) { linelen = sizeof(line) - 1; }
    memcpy(line, raw, linelen); line[linelen] = '\0';
    char method[64] = "", target[512] = "", version[32] = "";
    sscanf(line, "%63s %511s %31s", method, target, version);
    if (!*target) { closesocket(c); return; }

    /* route */
    char loc[640] = "";
    int status = 0;
    const char* ctype = "text/plain; charset=utf-8";
    const char* body = "";
    size_t body_len = 0;

    if (strcmp(target, "/echo") == 0) {
        status = 200; body = raw; body_len = rawlen;   /* body = raw request */
    } else if (strncmp(target, "/status/", 8) == 0) {
        status = atoi(target + 8);
        static char sb[64];
        snprintf(sb, sizeof(sb), "status-body-%d", status);
        body = sb; body_len = strlen(sb);
    } else if (strncmp(target, "/redirect/", 10) == 0) {
        status = atoi(target + 10);
        const char* q = strchr(target, '?');
        if (q && strncmp(q + 1, "loc=", 4) == 0) {
            snprintf(loc, sizeof(loc), "Location: %s\r\n", q + 5);
        }
    } else if (strcmp(target, "/loop") == 0) {
        status = 302;
        snprintf(loc, sizeof(loc), "Location: /loop\r\n");
    } else if (strcmp(target, "/bin") == 0) {
        static const unsigned char bin[] = { 0x00, 0x01, 0x02, 0xFF, 0x10 };
        status = 200; ctype = "application/octet-stream";
        body = (const char*)bin; body_len = sizeof(bin);
    } else if (strcmp(target, "/nultext") == 0) {
        static const char nulbody[] = { 'A', '\0', 'B' };
        status = 200; body = nulbody; body_len = sizeof(nulbody);
    } else {
        status = 404;
        static const char nb[] = "no-such-route";
        body = nb; body_len = sizeof(nb) - 1;
    }

    server_send(c, status, ctype, body, body_len, loc[0] ? loc : NULL);
    closesocket(c);
}

static DWORD WINAPI server_thread(LPVOID arg) {
    (void)arg;
    for (;;) {
        struct sockaddr_in ca;
        int clen = (int)sizeof(ca);
        SOCKET c = accept(g_srv.listener, (struct sockaddr*)&ca, &clen);
        if (c == INVALID_SOCKET) { break; }   /* listener closed -> stop */
        server_handle(c);
    }
    return 0;
}

static int server_start(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { return 0; }
    InitializeCriticalSection(&g_srv.cs);
    g_srv.listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (g_srv.listener == INVALID_SOCKET) { return 0; }
    {
        int yes = 1;
        setsockopt(g_srv.listener, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));
    }
    {
        struct sockaddr_in a;
        memset(&a, 0, sizeof(a));
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_ANY);
        a.sin_port = 0;
        if (bind(g_srv.listener, (struct sockaddr*)&a, sizeof(a)) != 0) { return 0; }
    }
    {
        struct sockaddr_in a;
        int alen = sizeof(a);
        if (getsockname(g_srv.listener, (struct sockaddr*)&a, &alen) != 0) { return 0; }
        g_srv.port = ntohs(a.sin_port);
    }
    if (listen(g_srv.listener, 16) != 0) { return 0; }
    g_srv.thread = CreateThread(NULL, 0, server_thread, NULL, 0, NULL);
    return g_srv.thread != NULL;
}

static void server_stop(void) {
    if (g_srv.listener != INVALID_SOCKET) {
        closesocket(g_srv.listener);          /* unblocks accept() in the thread */
        g_srv.listener = INVALID_SOCKET;
    }
    if (g_srv.thread) {
        WaitForSingleObject(g_srv.thread, 5000);
        CloseHandle(g_srv.thread);
        g_srv.thread = NULL;
    }
    for (int i = 0; i < g_srv.count; i++) { free(g_srv.caps[i].raw); }
    DeleteCriticalSection(&g_srv.cs);
    WSACleanup();
}

static void url_into(char* out, size_t outsz, const char* host, const char* path) {
    snprintf(out, outsz, "http://%s:%u%s", host, g_srv.port, path);
}

/* ==========================================================================
 * Tests
 * ========================================================================== */

static void test_version(void) {
    TaggedData argv[1];
    TaggedData retval;
    const char* v;
    printf("[version] eshttp_version(0)\n");
    /* _f signature: one dummy arg (the host passes 0) */
    memset(argv, 0, sizeof(argv));
    argv[0].type = kTypeDouble;
    argv[0].data.fltval = 0.0;
    argv[0].filler = 0;
    memset(&retval, 0, sizeof(retval));
    CHECK(eshttp_version(argv, 1, &retval) == kESErrOK, "eshttp_version(0) returns kESErrOK");
    CHECK(retval.type == kTypeString, "  eshttp_version(0) returns kTypeString");
    v = retval.data.string ? retval.data.string : "";
    CHECK(strcmp(v, "1.0.0") == 0, "  eshttp_version(0) == \"1.0.0\"");
    CHECK(strcmp(ESHTTP_VERSION, "1.0.0") == 0, "ESHTTP_VERSION == \"1.0.0\"");
    ESFreeMem(retval.data.string);   /* host frees kTypeString via ESFreeMem */
}

static void test_available(void) {
    TaggedData argv[1];
    TaggedData retval;
    printf("[available] eshttp_available(0)\n");
    memset(argv, 0, sizeof(argv));
    argv[0].type = kTypeDouble;
    argv[0].data.fltval = 0.0;
    argv[0].filler = 0;
    memset(&retval, 0, sizeof(retval));
    CHECK(eshttp_available(argv, 1, &retval) == kESErrOK, "eshttp_available(0) returns kESErrOK");
    CHECK(retval.type == kTypeInteger, "  eshttp_available(0) returns kTypeInteger");
    CHECK(retval.data.intval == 1, "  eshttp_available(0) == 1 (WinHTTP backend inits)");
}

static void test_es_lifecycle(void) {
    char* sig;
    printf("[es] ES* lifecycle exports (native-abi v2)\n");
    CHECK(ESGetVersion() == 1, "ESGetVersion() == 1");
    sig = ESInitialize(NULL, 0);
    CHECK(sig != NULL && strstr(sig, "eshttp_request_sssss") != NULL,
          "  ESInitialize lists eshttp_request_sssss");
    CHECK(sig != NULL && strstr(sig, "eshttp_last_error_f") != NULL,
          "  ESInitialize lists eshttp_last_error_f");
    CHECK(sig != NULL && strstr(sig, "eshttp_version_f") != NULL,
          "  ESInitialize lists eshttp_version_f");
    CHECK(sig != NULL && strstr(sig, "eshttp_available_f") != NULL,
          "  ESInitialize lists eshttp_available_f");
    CHECK(sig != NULL && strstr(sig, "eshttp_free") == NULL,
          "  ESInitialize does NOT list eshttp_free (v2 removes it)");
    if (sig) { ESFreeMem(sig); }
    /* ESFreeMem must match the allocator (free). NULL + foreign pointers are
     * free()-safe no-ops per the standard allocator contract. */
    ESFreeMem(NULL);
    ESTerminate();   /* idempotent session-cache cleanup */
    ESTerminate();
    CHECK(1, "ESFreeMem(NULL)/ESTerminate() callable (no crash)");
}

static void test_abi_request_shape(void) {
    TaggedData argv[1];
    TaggedData retval;
    printf("[abi] eshttp_request direct-interface shape\n");
    /* wrong arg count -> catchable kESErrBadArgumentList (20), never negative */
    memset(argv, 0, sizeof(argv));
    argv[0].type = kTypeString;
    argv[0].data.string = (char*)"GET";
    argv[0].filler = 0;
    memset(&retval, 0, sizeof(retval));
    CHECK(eshttp_request(argv, 1, &retval) == kESErrBadArgumentList,
          "  eshttp_request(1 arg) -> kESErrBadArgumentList");
    /* non-string arg -> kESErrBadArgumentList (per _sssss signature cast) */
    memset(argv, 0, sizeof(argv));
    argv[0].type = kTypeDouble;
    argv[0].data.fltval = 42.0;
    memset(&retval, 0, sizeof(retval));
    CHECK(eshttp_request(argv, 5, &retval) == kESErrBadArgumentList,
          "  eshttp_request(non-string arg) -> kESErrBadArgumentList");
}

static void test_hooks(void) {
    printf("[hooks] ESHTTP_SELFTEST hooks\n");
    CHECK(eshttp_st_ci_eq("Host", "host") == 1, "ci_eq(\"Host\",\"host\") == 1");
    CHECK(eshttp_st_ci_eq("abc", "abd") == 0, "ci_eq(\"abc\",\"abd\") == 0");

    char* b64 = NULL;
    CHECK(eshttp_st_b64_encode((const unsigned char*)"hello", 5, &b64) != 0 && b64 &&
          strcmp(b64, "aGVsbG8=") == 0, "b64_encode(\"hello\") == \"aGVsbG8=\"");
    free(b64); b64 = NULL;

    unsigned char* dec = NULL; size_t declen = 0;
    CHECK(eshttp_st_b64_decode("aGVsbG8=", 8, &dec, &declen) == 0 && declen == 5 &&
          memcmp(dec, "hello", 5) == 0, "b64_decode(\"aGVsbG8=\") == \"hello\"");
    free(dec); dec = NULL;
    CHECK(eshttp_st_b64_decode("ab", 2, &dec, &declen) == -1, "b64_decode rejects bad input (len not % 4)");
    CHECK(eshttp_st_b64_decode("a!Vs", 4, &dec, &declen) == -1, "b64_decode rejects bad input (invalid chars)");

    size_t used = 0;
    CHECK(eshttp_st_utf8_decode((const unsigned char*)"A", 1, &used) == 65 && used == 1,
          "utf8_decode('A') == 65");
    CHECK(eshttp_st_utf8_decode((const unsigned char*)"\xC3\xA9", 2, &used) == 0xE9 && used == 2,
          "utf8_decode(0xC3 0xA9) == U+00E9");

    size_t flen = 0;
    char* fixed = eshttp_st_utf8_fix("\xFF""A", 2, &flen);
    CHECK(fixed && flen == 4 && memcmp(fixed, "\xEF\xBF\xBD""A", 4) == 0,
          "utf8_fix invalid byte -> U+FFFD");
    free(fixed);

    eshttp_url u;
    const char* perr = NULL;
    CHECK(eshttp_st_url_parse("http://user:pw@Example.com:8080/path?q=1#frag", &u, &perr) == 1 &&
          u.https == 0 && strcmp(u.host, "example.com") == 0 && u.port == 8080 &&
          strcmp(u.path, "/path?q=1") == 0,
          "url_parse strips userinfo, lowercases host, drops fragment");
    char* s = eshttp_st_url_tostring(&u);
    CHECK(s && strcmp(s, "http://example.com:8080/path?q=1") == 0,
          "url_tostring sanitized (no userinfo)");
    free(s);
    url_free(&u);
    CHECK(eshttp_st_url_parse("ftp://x/", &u, &perr) == 0, "url_parse rejects ftp://");

    eshttp_url base;
    if (eshttp_st_url_parse("http://example.com/a/b", &base, &perr) == 1) {
        char* up = eshttp_st_url_resolve(&base, "../c");
        CHECK(up && strcmp(up, "http://example.com/c") == 0, "url_resolve(\"../c\")");
        free(up);
        up = eshttp_st_url_resolve(&base, "/x?y=1");
        CHECK(up && strcmp(up, "http://example.com/x?y=1") == 0, "url_resolve(\"/x?y=1\")");
        free(up);
        up = eshttp_st_url_resolve(&base, "http://other.com/z");
        CHECK(up && strcmp(up, "http://other.com/z") == 0, "url_resolve(absolute)");
        free(up);
        url_free(&base);
    } else {
        CHECK(0, "url_resolve: base parse");
    }

    errinfo ei = eshttp_st_map_winhttp(12007);
    CHECK(strcmp(ei.code, "dns") == 0 && ei.retryable == 1, "map_winhttp(12007) == dns");
    ei = eshttp_st_map_winhttp(12002);
    CHECK(strcmp(ei.code, "timeout") == 0, "map_winhttp(12002) == timeout");
    ei = eshttp_st_map_winhttp(99999);
    CHECK(strcmp(ei.code, "internal") == 0, "map_winhttp(unknown) == internal");

    hdrlist hl = {0};
    eshttp_st_parse_response_headers(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-N: 1\r\nX-N: 2\r\n"
        "Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n", &hl);
    hdr_t* hh = hdr_find(&hl, "content-type");
    CHECK(hh && strcmp(hh->value, "text/plain") == 0, "headers: content-type parsed");
    hh = hdr_find(&hl, "x-n");
    CHECK(hh && strcmp(hh->value, "1, 2") == 0, "headers: repeated joined \", \"");
    hh = hdr_find(&hl, "set-cookie");
    CHECK(hh && strcmp(hh->value, "a=1; b=2") == 0, "headers: Set-Cookie joined \"; \"");
    hdrlist_free(&hl);

    CHECK(is_method_token("GET") == 1, "is_method_token(\"GET\")");
    CHECK(is_method_token("GE T") == 0, "is_method_token rejects space");
    CHECK(is_method_token("") == 0, "is_method_token rejects empty");

    /* redirect auth strip (unit-level via build_request_headers): the loopback
     * server is plain HTTP so a real https->http 2-hop downgrade cannot be
     * exercised here; the header-builder rule is tested directly instead. */
    {
        hdrlist bl = {0};
        opts_t oz; memset(&oz, 0, sizeof(oz));
        hdr_push(&bl, "Authorization", "Bearer sec-123");
        hdr_push(&bl, "X-Keep", "1");
        wchar_t* wh = build_request_headers(&bl, &oz, "example.com", "example.com", 0, 1, 0, 0, NULL);
        char* h8 = wh ? w_to_utf8(wh) : NULL;
        CHECK(h8 && !s_contains_ci(h8, "authorization"),
              "auth stripped on https->http same-host downgrade");
        CHECK(h8 && s_contains(h8, "X-Keep: 1"), "non-auth headers kept on downgrade");
        free(h8); free(wh);
        wh = build_request_headers(&bl, &oz, "example.com", "example.com", 1, 1, 0, 0, NULL);
        h8 = wh ? w_to_utf8(wh) : NULL;
        CHECK(h8 && s_contains(h8, "Authorization: Bearer sec-123"),
              "auth kept on same-scheme same-host hop");
        free(h8); free(wh);
        wh = build_request_headers(&bl, &oz, "other.com", "example.com", 1, 1, 0, 0, NULL);
        h8 = wh ? w_to_utf8(wh) : NULL;
        CHECK(h8 && !s_contains_ci(h8, "authorization"),
              "auth stripped on cross-host redirect (same scheme)");
        free(h8); free(wh);
        hdrlist_free(&bl);
    }
}

/* ---- HTTP-level tests (envelope contract, §4.3 shapes) ---- */

static void test_error_envelopes(void) {
    printf("[envelope] error-shaped envelopes carry abi + ok:false + status:0\n");
    const char* env = do_req("GE T", "http://127.0.0.1:1/x", "{}", "", "{}");
    CHECK(env != NULL, "bad-method request returns envelope (not NULL)");
    if (env) {
        CHECK(env_abi(env), "  invalid-args envelope has abi http-v1");
        CHECK(env_ok(env, 0) && env_status(env, 0), "  invalid-args: ok:false, status:0");
        CHECK(env_err_code(env, "invalid-args"), "  invalid-args: error.code invalid-args");
        env_free(env);
    }

    env = do_req("GET", "ftp://example.com/", "{}", "", "{}");
    CHECK(env != NULL, "bad-scheme request returns envelope");
    if (env) {
        CHECK(env_abi(env), "  bad-url envelope has abi http-v1");
        CHECK(env_ok(env, 0) && env_status(env, 0), "  bad-url: ok:false, status:0");
        CHECK(env_err_code(env, "bad-url"), "  bad-url: error.code bad-url");
        env_free(env);
    }

    env = do_req("GET", "http://127.0.0.1:1/x", "{\"X-Bad\":\"a\nb\"}", "", "{}");
    CHECK(env != NULL, "CRLF-header request returns envelope");
    if (env) {
        CHECK(env_abi(env), "  invalid-header envelope has abi http-v1");
        CHECK(env_err_code(env, "invalid-header"), "  invalid-header: error.code invalid-header");
        CHECK(env_ok(env, 0) && env_status(env, 0), "  invalid-header: ok:false, status:0");
        env_free(env);
    }

    env = do_req("GET", "http://127.0.0.1:1/x", "{}", "!!!!", "{\"bodyIsBase64\":true}");
    CHECK(env != NULL, "bad-base64 request returns envelope");
    if (env) {
        CHECK(env_abi(env), "  bad-base64 envelope has abi http-v1");
        CHECK(env_err_code(env, "invalid-args"), "  bad-base64: error.code invalid-args");
        env_free(env);
    }

    /* security guards (native audit, t1): CR/LF must never reach the wire
     * through opts.userAgent or the URL */
    env = do_req("GET", "http://127.0.0.1:1/x", "{}", "",
                 "{\"userAgent\":\"a\r\nX-Injected: 1\"}");
    CHECK(env != NULL, "CRLF-userAgent request returns envelope");
    if (env) {
        CHECK(env_err_code(env, "invalid-args"), "  userAgent CR/LF -> invalid-args (header-injection guard)");
        env_free(env);
    }
    env = do_req("GET", "http://127.0.0.1:1/x\r\nX-Injected: 1", "{}", "", "{}");
    CHECK(env != NULL, "CRLF-URL request returns envelope");
    if (env) {
        CHECK(env_err_code(env, "bad-url"), "  URL CR/LF -> bad-url (request-line injection guard)");
        env_free(env);
    }
}

static void test_transport_error(void) {
    printf("[envelope] transport error: connect to a closed loopback port\n");
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    unsigned short dead_port = 0;
    if (s != INVALID_SOCKET && bind(s, (struct sockaddr*)&a, sizeof(a)) == 0) {
        int alen = sizeof(a);
        if (getsockname(s, (struct sockaddr*)&a, &alen) == 0) { dead_port = ntohs(a.sin_port); }
        closesocket(s);
    }
    CHECK(dead_port != 0, "obtained a closed loopback port");
    char url[128];
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/x", dead_port);
    const char* env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\",\"timeoutMs\":5000}");
    CHECK(env != NULL, "transport-failure request returns envelope (not NULL)");
    if (env) {
        CHECK(env_abi(env), "  error envelope has abi http-v1");
        CHECK(env_ok(env, 0) && env_status(env, 0), "  error envelope: ok:false, status:0");
        CHECK(!env_err_null(env), "  error envelope: error != null");
        CHECK(env_err_code(env, "connect"), "  error envelope: error.code == connect");
        env_free(env);   /* host path: freed via ESFreeMem */
        CHECK(1, "  error envelope freed via ESFreeMem (no crash)");
    }
}

static void test_status_responses(void) {
    printf("[envelope] 4xx/5xx are NORMAL envelopes (ok:true, error:null)\n");
    char url[128];
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/status/404", g_srv.port);
    const char* env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL, "404 request returns envelope");
    if (env) {
        CHECK(env_abi(env), "  404 envelope has abi http-v1");
        CHECK(env_ok(env, 1) && env_status(env, 404), "  404: ok:true, status:404");
        CHECK(env_err_null(env), "  404: error:null (response was received)");
        CHECK(env_body_enc(env, "utf8"), "  404: bodyEncoding utf8");
        env_free(env);
    }
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/status/500", g_srv.port);
    env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL, "500 request returns envelope");
    if (env) {
        CHECK(env_ok(env, 1) && env_status(env, 500), "  500: ok:true, status:500");
        CHECK(env_err_null(env), "  500: error:null");
        CHECK(env_redirects(env, 0), "  500: meta.redirects == 0");
        env_free(env);
    }
}

static void test_host_cl_ignored(void) {
    printf("[headers] caller Host/Content-Length ignored (DLL computes)\n");
    char url[128];
    url_into(url, sizeof(url), "127.0.0.1", "/echo");
    int start = srv_count();
    const char* env = do_req("POST", url,
                             "{\"Host\":\"attacker.example.com\",\"Content-Length\":\"999\",\"X-Probe\":\"1\"}",
                             "hello", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1), "POST /echo ok");
    if (env) { env_free(env); }
    const capture* c = srv_get(start);
    CHECK(c != NULL, "wire capture present");
    if (c) {
        char want_host[96];
        snprintf(want_host, sizeof(want_host), "Host: 127.0.0.1:%u", g_srv.port);
        CHECK(s_contains(c->raw, want_host), "  wire Host == real 127.0.0.1:port");
        CHECK(!s_contains_ci(c->raw, "attacker.example.com"), "  wire has NO attacker Host");
        CHECK(s_contains(c->raw, "Content-Length: 5"), "  wire Content-Length == 5 (body length)");
        CHECK(!s_contains_ci(c->raw, "Content-Length: 999"), "  wire has NO caller Content-Length 999");
        CHECK(s_contains(c->raw, "X-Probe: 1"), "  caller X-Probe survives");
        srv_print_capture(start, "POST /echo");
    }
}

static void test_body_is_base64(void) {
    printf("[body] bodyIsBase64 decoded before send; Content-Length on decoded length\n");
    char url[128];
    url_into(url, sizeof(url), "127.0.0.1", "/echo");
    int start = srv_count();
    const char* env = do_req("POST", url, "{}", "aGVsbG8gd29ybGQ=",
                             "{\"proxy\":\"direct\",\"bodyIsBase64\":true}");
    CHECK(env != NULL && env_ok(env, 1), "POST /echo (b64 body) ok");
    if (env) { env_free(env); }
    const capture* c = srv_get(start);
    CHECK(c != NULL, "wire capture present");
    if (c) {
        CHECK(s_contains(c->raw, "Content-Length: 11"), "  wire Content-Length == 11 (decoded len)");
        CHECK(s_contains(c->raw, "hello world"), "  wire body == decoded \"hello world\"");
        CHECK(!s_contains(c->raw, "aGVsbG8gd29ybGQ="), "  wire body is NOT the raw base64");
        srv_print_capture(start, "POST /echo b64");
    }
}

static void test_redirect_get_family(void) {
    printf("[redirect] 301/302/303 -> GET + body dropped\n");
    const int codes[] = { 301, 302, 303 };
    const char* names[] = { "301", "302", "303" };
    for (int i = 0; i < 3; i++) {
        char url[192], want_url[192];
        snprintf(url, sizeof(url), "http://127.0.0.1:%u/redirect/%d?loc=/echo", g_srv.port, codes[i]);
        int start = srv_count();
        const char* env = do_req("POST", url, "{}", "dropme",
                                 "{\"proxy\":\"direct\"}");
        checkf(env != NULL && env_ok(env, 1), "  %s: follow ok", names[i]);
        if (env) {
            checkf(env_redirects(env, 1), "  %s: meta.redirects == 1", names[i]);
            url_into(want_url, sizeof(want_url), "127.0.0.1", "/echo");
            char f[256];
            snprintf(f, sizeof(f), "\"finalUrl\":\"%s\"", want_url);
            checkf(s_contains(env, f), "  %s: meta.finalUrl == /echo (after redirect)", names[i]);
            env_free(env);
        }
        const capture* hop1 = srv_get(start);
        const capture* hop2 = srv_get(start + 1);
        checkf(hop1 && hop2, "  %s: two wire hops captured", names[i]);
        if (hop1 && hop2) {
            checkf(s_contains(hop1->raw, "POST /redirect/") && s_contains(hop1->raw, "dropme"),
                   "  %s: hop1 POST with body", names[i]);
            checkf(s_contains(hop2->raw, "GET /echo"), "  %s: hop2 is GET (converted)", names[i]);
            checkf(!s_contains(hop2->raw, "dropme"), "  %s: hop2 body dropped", names[i]);
            checkf(!s_contains(hop2->raw, "Content-Type: "), "  %s: hop2 Content-Type dropped", names[i]);
        }
    }
}

static void test_redirect_preserve_family(void) {
    printf("[redirect] 307/308 preserve method + body\n");
    const int codes[] = { 307, 308 };
    const char* names[] = { "307", "308" };
    for (int i = 0; i < 2; i++) {
        char url[192];
        snprintf(url, sizeof(url), "http://127.0.0.1:%u/redirect/%d?loc=/echo", g_srv.port, codes[i]);
        int start = srv_count();
        const char* env = do_req("POST", url, "{}", "keepme",
                                 "{\"proxy\":\"direct\"}");
        checkf(env != NULL && env_ok(env, 1), "  %s: follow ok", names[i]);
        if (env) { env_free(env); }
        const capture* hop2 = srv_get(start + 1);
        checkf(hop2 != NULL, "  %s: hop2 captured", names[i]);
        if (hop2) {
            checkf(s_contains(hop2->raw, "POST /echo"), "  %s: hop2 still POST", names[i]);
            checkf(s_contains(hop2->raw, "keepme"), "  %s: hop2 body preserved", names[i]);
            checkf(s_contains(hop2->raw, "Content-Length: 6"), "  %s: hop2 Content-Length 6", names[i]);
        }
    }
}

static void test_redirect_auth_cross_host(void) {
    printf("[redirect] Authorization dropped on cross-host, kept same-host\n");
    char url[192];
    /* cross-host: 127.0.0.1 -> 127.0.0.2 (different host string, same loopback) */
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/redirect/302?loc=http://127.0.0.2:%u/echo",
             g_srv.port, g_srv.port);
    int start = srv_count();
    const char* env = do_req("GET", url, "{\"Authorization\":\"Bearer sec-123\"}", "",
                             "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1) && env_redirects(env, 1),
          "cross-host follow ok, redirects==1");
    if (env) { env_free(env); }
    const capture* hop2 = srv_get(start + 1);
    CHECK(hop2 != NULL, "cross-host hop2 captured");
    if (hop2) {
        CHECK(!s_contains_ci(hop2->raw, "authorization"), "  hop2 has NO Authorization (dropped)");
        CHECK(!s_contains_ci(hop2->raw, "sec-123"), "  hop2 has NO credential bytes");
        srv_print_capture(start + 1, "cross-host hop2");
    }

    /* same-host control: loc=/echo keeps the same host */
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/redirect/302?loc=/echo", g_srv.port);
    start = srv_count();
    env = do_req("GET", url, "{\"Authorization\":\"Bearer sec-123\"}", "",
                 "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1), "same-host follow ok");
    if (env) { env_free(env); }
    hop2 = srv_get(start + 1);
    CHECK(hop2 != NULL, "same-host hop2 captured");
    if (hop2) {
        CHECK(s_contains(hop2->raw, "Authorization: Bearer sec-123"), "  hop2 KEEPS Authorization");
    }
}

static void test_redirect_manual(void) {
    printf("[redirect] manual: 3xx returned as-is, no follow\n");
    char url[192], want_url[192];
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/redirect/302?loc=/echo", g_srv.port);
    const char* env = do_req("GET", url, "{}", "",
                             "{\"proxy\":\"direct\",\"redirect\":\"manual\"}");
    CHECK(env != NULL && env_ok(env, 1) && env_status(env, 302), "manual: ok:true, status:302");
    if (env) {
        CHECK(env_redirects(env, 0), "manual: meta.redirects == 0");
        CHECK(env_err_null(env), "manual: error:null");
        url_into(want_url, sizeof(want_url), "127.0.0.1", "/redirect/302?loc=/echo");
        char f[256];
        snprintf(f, sizeof(f), "\"finalUrl\":\"%s\"", want_url);
        CHECK(s_contains(env, f), "manual: finalUrl == original URL");
        env_free(env);
    }
}

static void test_redirect_max_cap(void) {
    printf("[redirect] maxRedirects cap -> too-many-redirects error envelope\n");
    char url[192];
    url_into(url, sizeof(url), "127.0.0.1", "/loop");
    const char* env = do_req("GET", url, "{}", "",
                             "{\"proxy\":\"direct\",\"maxRedirects\":1}");
    CHECK(env != NULL, "loop request returns envelope");
    if (env) {
        CHECK(env_abi(env), "  too-many-redirects envelope has abi http-v1");
        CHECK(env_ok(env, 0) && env_status(env, 0),
              "  ok:false, status:0 (§4.3: error iff no usable response)");
        CHECK(env_err_code(env, "too-many-redirects"), "  error.code == too-many-redirects");
        CHECK(env_redirects(env, 1), "  meta.redirects == 1 (capped at maxRedirects)");
        env_free(env);
    }
}

static void test_relative_redirect_resolution(void) {
    printf("[redirect] relative Location resolved in C (native-abi §10 notes)\n");
    char url[192];
    snprintf(url, sizeof(url), "http://127.0.0.1:%u/redirect/302?loc=../echo", g_srv.port);
    int start = srv_count();
    const char* env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1) && env_redirects(env, 1),
          "relative ../echo redirect followed");
    if (env) { env_free(env); }
    const capture* hop2 = srv_get(start + 1);
    CHECK(hop2 != NULL && s_contains(hop2->raw, "GET /echo"), "  hop2 resolved to /echo");
}

static void test_sniffing(void) {
    printf("[sniff] text/binary + NUL guard (native-abi §4.1)\n");
    char url[128];
    url_into(url, sizeof(url), "127.0.0.1", "/echo");
    const char* env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1), "text/plain body ok");
    if (env) {
        CHECK(env_body_enc(env, "utf8"), "  text/plain -> bodyEncoding utf8");
        CHECK(s_contains(env, "\"backend\":\"winhttp\""), "  meta.backend == winhttp");
        CHECK(s_contains(env, "\"nativeVersion\":\"1.0.0\""), "  meta.nativeVersion == 1.0.0");
        env_free(env);
    }
    url_into(url, sizeof(url), "127.0.0.1", "/bin");
    env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1), "binary body ok");
    if (env) {
        CHECK(env_body_enc(env, "base64"), "  application/octet-stream -> base64");
        CHECK(s_contains(env, "\"body\":\"AAEC/xA=\""), "  body == base64(00 01 02 FF 10)");
        env_free(env);
    }
    url_into(url, sizeof(url), "127.0.0.1", "/nultext");
    env = do_req("GET", url, "{}", "", "{\"proxy\":\"direct\"}");
    CHECK(env != NULL && env_ok(env, 1), "NUL-guard body ok");
    if (env) {
        CHECK(env_body_enc(env, "base64"), "  text/plain WITH NUL -> base64 (NUL guard)");
        CHECK(s_contains(env, "\"body\":\"QQBC\""), "  body == base64(A NUL B)");
        env_free(env);
    }
}

/* ---- R-G5-E1 wire capture: the User-Agent guarantees ---- */

static void test_wire_ua_normal(void) {
    printf("[wire R-G5-E1] User-Agent: normal case sends exactly one\n");
    char url[128];
    url_into(url, sizeof(url), "127.0.0.1", "/echo");
    int start = srv_count();
    const char* env = do_req("GET", url, "{}", "",
                             "{\"proxy\":\"direct\",\"userAgent\":\"native-selftest/9.9\"}");
    CHECK(env != NULL && env_ok(env, 1), "GET /echo with userAgent ok");
    if (env) { env_free(env); }
    const capture* c = srv_get(start);
    CHECK(c != NULL, "wire capture present");
    if (c) {
        CHECK(s_contains(c->raw, "User-Agent: native-selftest/9.9"),
              "  wire carries the caller's User-Agent value");
        int n = s_count_ci(c->raw, "user-agent");
        printf("    [info] 'user-agent' occurrences on wire: %d\n", n);
        CHECK(n == 1, "  exactly ONE User-Agent header on the wire");
        srv_print_capture(start, "UA normal");
    }
}

static void test_wire_ua_suppressed(void) {
    printf("[wire R-G5-E1] User-Agent: suppressed (userAgent:null) -> ZERO UA bytes\n");
    char url[128];
    url_into(url, sizeof(url), "127.0.0.1", "/echo");
    int start = srv_count();
    const char* env = do_req("GET", url, "{}", "",
                             "{\"proxy\":\"direct\",\"userAgent\":null}");
    CHECK(env != NULL && env_ok(env, 1), "GET /echo with userAgent:null ok");
    if (env) { env_free(env); }
    const capture* c = srv_get(start);
    CHECK(c != NULL, "wire capture present");
    if (c) {
        int n = s_count_ci(c->raw, "user-agent");
        printf("    [info] 'user-agent' occurrences on wire: %d\n", n);
        CHECK(n == 0, "  ZERO 'user-agent' bytes on the wire (api-spec §6.2 row 4)");
        CHECK(!s_contains_ci(c->raw, "eshttp/1.0.0"), "  no default 'eshttp/1.0.0' leak");
        srv_print_capture(start, "UA suppressed");
    }
}

static void test_wire_ua_header_wins(void) {
    printf("[wire R-G5-E1] User-Agent: explicit header wins, no session-agent leak\n");
    char url[128];
    url_into(url, sizeof(url), "127.0.0.1", "/echo");
    int start = srv_count();
    const char* env = do_req("GET", url,
                             "{\"User-Agent\":\"explicit-agent/7\"}", "",
                             "{\"proxy\":\"direct\",\"userAgent\":\"native-selftest/9.9\"}");
    CHECK(env != NULL && env_ok(env, 1), "GET /echo with explicit UA header ok");
    if (env) { env_free(env); }
    const capture* c = srv_get(start);
    CHECK(c != NULL, "wire capture present");
    if (c) {
        CHECK(s_contains(c->raw, "User-Agent: explicit-agent/7"),
              "  wire carries the explicit caller header value");
        int n = s_count_ci(c->raw, "user-agent");
        printf("    [info] 'user-agent' occurrences on wire: %d\n", n);
        CHECK(n == 1, "  exactly ONE User-Agent on the wire (explicit wins)");
        CHECK(!s_contains(c->raw, "native-selftest/9.9"),
              "  opts.userAgent does NOT leak when a header won");
        srv_print_capture(start, "UA header-wins");
    }
}

/* ========================================================================== */

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);   /* unbuffered: crash position visible even when redirected */
    printf("=== native/selftest.c — eshttp native selftest (ESHTTP_STATIC) ===\n");
    printf("ABI: %s  version: %s\n\n", ESHTTP_ENVELOPE_ABI, ESHTTP_VERSION);

    test_version();
    test_available();
    test_es_lifecycle();
    test_abi_request_shape();
    test_hooks();
    test_error_envelopes();

    if (!server_start()) {
        printf("\nFATAL: could not start the loopback test server: %lu\n",
               (unsigned long)WSAGetLastError());
        return 1;
    }
    printf("\n[server] loopback listener on 127.0.0.1/127.0.0.2:%u\n", g_srv.port);

    test_transport_error();
    test_status_responses();
    test_host_cl_ignored();
    test_body_is_base64();
    test_redirect_get_family();
    test_redirect_preserve_family();
    test_redirect_auth_cross_host();
    test_redirect_manual();
    test_redirect_max_cap();
    test_relative_redirect_resolution();
    test_sniffing();
    test_wire_ua_normal();
    test_wire_ua_suppressed();
    test_wire_ua_header_wins();

    server_stop();

    printf("\n=== RESULT: %d pass, %d fail ===\n", g_pass, g_fail);
    if (g_fail == 0) {
        printf("ALL GREEN — t1 native gate items satisfied.\n");
    } else {
        printf("FAILURES PRESENT — see FAIL lines above.\n");
    }
    return g_fail == 0 ? 0 : 1;
}
