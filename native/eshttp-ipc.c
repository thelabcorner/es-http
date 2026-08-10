/* eshttp-ipc.c — eshttp IPC bridge DLL (ExternalObject, x64/x86).
 *
 * PURE named-pipe client. It never does networking, HTTP, or WinHTTP — it
 * connects to the persistent eshttp worker (eshttp-cli.exe --worker) over
 * the single-instance message-mode pipe \\.\pipe\EshttpBridge and asks the
 * worker to run the http request out-of-process (the firewall-escape lane).
 *
 * ABI: canonical ExtendScript ExternalObject direct-interface
 *   long fn(TaggedData* argv, long argc, TaggedData* retval)
 * (SoSharedLibDefs.h ESFunction; live-verified on Illustrator 30.6.0 via
 * the sibling ESON prototype). Exports (exactly 5):
 *   ESInitialize  -> signature metadata string
 *   ESGetVersion  -> 1 (ExternalObject.version)
 *   ESFreeMem     -> HeapFree (matches THIS DLL's allocator exactly)
 *   ESTerminate   -> no persistent state
 *   eshttp_pipe_request -> the single business method
 *
 * FREESTANDING (per the externalobject-extendscript skill discipline):
 *   - No CRT, no <windows.h>. Win32 imports are hand-declared.
 *   - Heap memory from the process heap (HeapAlloc/HeapFree) so the
 *     ESFreeMem ownership contract stays exact (never free() a CRT buffer,
 *     never HeapFree a CRT buffer — the two allocators must not mix).
 *   - Every wait carries a hard deadline (connect budget, per-phase I/O
 *     timeout) so a hung/crashed worker can never block Illustrator's UI
 *     thread indefinitely.
 *   - Every failure path returns a BOUNDED normalized report string
 *     (kTypeString) with a machine-readable errClass; NO negative (fatal)
 *     kESErr* codes are ever returned.
 *
 * Report format (kTypeString -> JSX, LF-separated key=value):
 *   protocol=ESHTTP_IPC_1
 *   success=1|0
 *   op=<op>
 *   requestId=<32-hex>
 *   errClass=<class>
 *   message=<msg>
 *   winerr=<n>
 *   protoMajor=1
 *   protoMinor=0
 *   workerAbi=1
 *   buildId=<id>
 *   pid=<n>
 *   uptimeMs=<n>
 *   requests=<n>
 *   [payload=<envelope-or-file-path>]
 * The JSX driver parses this report (T19). Large response envelopes travel
 * by file path (worker writes eshttp-resp_<id>.json, payload = the path) —
 * the bridge is a pure pipe client and does NOT read result files.
 *
 * Protocol: eshttp-ipc.h (single source of truth for DLL + worker).
 *
 * Build (x64, MSVC — freestanding, /nodefaultlib):
 *   cl /nologo /TC /LD /MT /O2 /nodefaultlib /D WIN32_LEAN_AND_MEAN
 *       eshttp-ipc.c /link /entry:DllMain /subsystem:windows
 *       /Fe:eshttp-ipc-x64.dll
 *   (x86: the x86 vcvars environment + /Fe:eshttp-ipc-x86.dll)
 */

/* ---- freestanding Win32 surface (no windows.h, no CRT) ---- */
#define WINAPI __stdcall
#define DLLIMPORT __declspec(dllimport)

typedef void *HANDLE;
typedef unsigned long DWORD;
typedef int BOOL;
typedef unsigned __int64 ULONGLONG;
/* SIZE_T is pointer-sized: 8 bytes on x64, 4 bytes on x86. HeapAlloc's third
   argument is SIZE_T, so the stdcall decoration on x86 must be @12 — a
   hard-coded ULONGLONG would produce @16 and fail to resolve. */
#ifdef _WIN64
typedef unsigned __int64 SIZE_T_OWN;
#else
typedef unsigned long SIZE_T_OWN;
#endif

#define INVALID_HANDLE_VALUE ((HANDLE)(long long)-1)
#define NULL 0
#define TRUE 1
#define FALSE 0

#define GENERIC_READ 0x80000000ul
#define GENERIC_WRITE 0x40000000ul
#define OPEN_EXISTING 3
#define FILE_FLAG_OVERLAPPED 0x40000000ul
#define PIPE_READMODE_MESSAGE 0x2
#define ERROR_IO_PENDING 997
#define ERROR_MORE_DATA 234
#define ERROR_BROKEN_PIPE 109
#define ERROR_PIPE_NOT_CONNECTED 233
#define ERROR_FILE_NOT_FOUND 2
#define ERROR_PIPE_BUSY 231
#define ERROR_SEM_TIMEOUT 121
#define ERROR_ACCESS_DENIED 5
#define ERROR_INVALID_USER_BUFFER 1784
#define WAIT_OBJECT_0 0
#define WAIT_TIMEOUT 258

DLLIMPORT BOOL WINAPI WaitNamedPipeA(const char*, DWORD);
DLLIMPORT HANDLE WINAPI CreateFileA(const char*, DWORD, DWORD, void*, DWORD, DWORD, HANDLE);
DLLIMPORT BOOL WINAPI SetNamedPipeHandleState(HANDLE, DWORD*, DWORD*, DWORD*);
DLLIMPORT BOOL WINAPI ReadFile(HANDLE, void*, DWORD, DWORD*, void*);
DLLIMPORT BOOL WINAPI WriteFile(HANDLE, const void*, DWORD, DWORD*, void*);
DLLIMPORT BOOL WINAPI CloseHandle(HANDLE);
DLLIMPORT DWORD WINAPI GetLastError(void);
DLLIMPORT unsigned __int64 WINAPI GetTickCount64(void);
DLLIMPORT HANDLE WINAPI CreateEventA(void*, BOOL, BOOL, const char*);
DLLIMPORT BOOL WINAPI ResetEvent(HANDLE);
DLLIMPORT DWORD WINAPI WaitForSingleObject(HANDLE, DWORD);
DLLIMPORT BOOL WINAPI CancelIo(HANDLE);
DLLIMPORT BOOL WINAPI GetOverlappedResult(HANDLE, void*, DWORD*, BOOL);
DLLIMPORT void WINAPI Sleep(DWORD);
DLLIMPORT DWORD WINAPI GetCurrentProcessId(void);
DLLIMPORT HANDLE WINAPI GetProcessHeap(void);
DLLIMPORT void* WINAPI HeapAlloc(HANDLE, DWORD, SIZE_T_OWN);
DLLIMPORT BOOL WINAPI HeapFree(HANDLE, DWORD, void*);

typedef struct OVERLAPPED_S {
    ULONGLONG Internal;
    ULONGLONG InternalHigh;
    union {
        struct { DWORD Offset; DWORD OffsetHigh; } s;
        void *Pointer;
    } u;
    HANDLE hEvent;
} OVERLAPPED_S;

#include "eshttp-ipc.h"
#include "eshttp.h"   /* TaggedData, kType*, kESErr* (type-only, CRT-free) */

#define ESHTTP_IPC_API __declspec(dllexport)
#define ESHTTP_REQ_ID_HEX 32
#define ESHTTP_REPORT_OP_MAX 64
#define ESHTTP_FIELD_MESSAGE_MAX 512
#define ESHTTP_FIELD_ID_MAX 64
#define ESHTTP_FIELD_CLASS_MAX 64

#ifdef _MSC_VER
#include <intrin.h>
#define ESHTTP_CAS(dest, exch, cmp) \
    _InterlockedCompareExchange((volatile long *)(dest), (long)(exch), (long)(cmp))
#else
#define ESHTTP_CAS(dest, exch, cmp) \
    __sync_val_compare_and_swap((dest), (long)(cmp), (long)(exch))
#endif

/* Serialize pipe transactions in-process (single flight). Illustrator is
   single-threaded, but COM automation or test hosts may call concurrently;
   a second call while one is in flight gets a bounded `busy` report instead
   of interleaved pipe traffic. */
static volatile long g_in_flight = 0;

typedef struct EshttpIpcResp {
    int success;                 /* -1 = absent/invalid */
    const char *op;
    const char *requestId;
    const char *message;
    const char *errClass;
    const char *buildId;
    const char *payload;
    long protoMajor, protoMinor, workerAbi;
    int hasProtoMajor, hasProtoMinor, hasWorkerAbi;
    unsigned long long pid, uptimeMs, requests;
    DWORD winerr;
} EshttpIpcResp;

/* ------------------------------------------------------------------ */
/* freestanding string/number helpers (no CRT)                         */
/* ------------------------------------------------------------------ */

static unsigned int slen(const char *s) {
    unsigned int n = 0;
    while (s && s[n]) n++;
    return n;
}

/* full-string equality (both NUL-terminated) */
static int seq(const char *a, const char *b) {
    while (*a && *b) { if (*a != *b) return 0; a++; b++; }
    return *a == *b;
}

/* find any of `set` in s */
static const char *spbrk(const char *s, const char *set) {
    while (*s) {
        const char *q = set;
        while (*q) { if (*s == *q) return s; q++; }
        s++;
    }
    return NULL;
}

static void memzero(void *p, unsigned int n) {
    volatile unsigned char *b = (volatile unsigned char *)p;
    while (n--) *b++ = 0;
}

static void memcpy_n(void *dst, const void *src, unsigned int n) {
    const unsigned char *s = (const unsigned char *)src;
    unsigned char *d = (unsigned char *)dst;
    while (n--) *d++ = *s++;
}

/* decimal parse (non-negative); returns -1 on failure */
static long atol10(const char *s) {
    long n = 0;
    int any = 0;
    if (!s) return -1;
    while (*s >= '0' && *s <= '9') { n = n * 10 + (*s - '0'); s++; any = 1; }
    return (any && *s == 0) ? n : -1;
}

static unsigned long long atoull10(const char *s) {
    unsigned long long n = 0;
    int any = 0;
    if (!s) return 0;
    while (*s >= '0' && *s <= '9') { n = n * 10 + (unsigned long long)(*s - '0'); s++; any = 1; }
    return (any && *s == 0) ? n : 0;
}

static void uitoa10(char *out, unsigned int cap, unsigned long long v) {
    char tmp[24];
    int t = 0, i = 0;
    if (v == 0) { out[0] = '0'; out[1] = 0; return; }
    while (v) { tmp[t++] = (char)('0' + v % 10); v /= 10; }
    while (t && i + 1 < (int)cap) out[i++] = tmp[--t];
    out[i] = 0;
}

static void itoa10(char *out, unsigned int cap, long v) {
    char tmp[16];
    int t = 0, i = 0;
    if (v == 0) { out[0] = '0'; out[1] = 0; return; }
    while (v) { tmp[t++] = (char)('0' + v % 10); v /= 10; }
    while (t && i + 1 < (int)cap) out[i++] = tmp[--t];
    out[i] = 0;
}

/* bounded append; returns the new used length */
static unsigned int bcat(char *out, unsigned int cap, unsigned int used,
                         const char *s) {
    while (*s && used + 1 < cap) out[used++] = *s++;
    out[used] = 0;
    return used;
}

static unsigned int bcat10(char *out, unsigned int cap, unsigned int used, long v) {
    char num[16];
    itoa10(num, sizeof(num), v);
    return bcat(out, cap, used, num);
}

static unsigned int bcatu10(char *out, unsigned int cap, unsigned int used,
                            unsigned long long v) {
    char num[24];
    uitoa10(num, sizeof(num), v);
    return bcat(out, cap, used, num);
}

/* hex writer for the 32-char invocation id */
static void hex64(char *out, unsigned __int64 v) {
    static const char hex[] = "0123456789abcdef";
    int i;
    for (i = 15; i >= 0; i--) { out[i] = hex[v & 15]; v >>= 4; }
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

static char *dup_cstr(const char *s) {
    unsigned int n = slen(s);
    char *out = (char *)HeapAlloc(GetProcessHeap(), 0, (unsigned __int64)n + 1);
    if (!out) return NULL;
    memcpy_n(out, s, n);
    out[n] = 0;
    return out;
}

static long return_string(TaggedData *retval, const char *s) {
    char *out = dup_cstr(s);
    if (!out) return kESErrNoMemory;
    retval->type = kTypeString;
    retval->data.string = out;
    return kESErrOK;
}

/* Per-request invocation id: 32 hex chars, fresh on every request, echoed
   by the worker and validated. Not cryptographic; identity/exactly-once
   bookkeeping only (payloads travel by file path, not secret data).
   The mix is 32-bit-arithmetic only (x86 freestanding has no 64-bit
   multiply helper — no CRT __allmul in a /nodefaultlib build). */
static unsigned __int64 g_req_counter = 0;

static void make_request_id(char out[ESHTTP_REQ_ID_HEX + 1]) {
    unsigned __int64 t = GetTickCount64();
    unsigned __int64 c = ++g_req_counter;
    unsigned __int64 s = t ^ (c * 2654435761ull) ^
                         ((unsigned __int64)GetCurrentProcessId() << 32);
    s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
    hex64(out, s);
    hex64(out + 16, c ^ t);
    out[32] = 0;
}

/* ------------------------------------------------------------------ */
/* request building                                                    */
/* ------------------------------------------------------------------ */

/* Build the wire request message (eshttp-ipc.h protocol):
 *   EshttpIpcReq_1
 *   op=<op>
 *   requestId=<id>
 *   protoMajor=1
 *   protoMinor=0
 *   dllAbi=1
 *   payload=<single-line value>     (non-request ops)
 *   -- OR for op=request --
 *   payload=                        (empty marker)
 *   <multi-line job body as the remainder — travels LF-separated>
 * Returns message length (>0) or -1 with *errClassOut set. */
static int build_request(const char *op, const char *payload, char *buf,
                         unsigned int cap, const char *requestId,
                         const char **errClassOut) {
    unsigned int used = 0;
    const char *val;
    if (slen(op) == 0 || slen(op) > ESHTTP_IPC_OP_MAX ||
        spbrk(op, "\r\n") != NULL) {
        *errClassOut = ESHTTP_IPC_EC_REQUEST_INVALID;
        return -1;
    }
    if (slen(payload) > ESHTTP_IPC_PAYLOAD_MAX + 512) {
        *errClassOut = ESHTTP_IPC_EC_REQUEST_OVERSIZE;
        return -1;
    }
    used = bcat(buf, cap, used, ESHTTP_IPC_REQ_MAGIC "\n");
    used = bcat(buf, cap, used, "op=");
    used = bcat(buf, cap, used, op);
    used = bcat(buf, cap, used, "\nrequestId=");
    used = bcat(buf, cap, used, requestId);
    used = bcat(buf, cap, used, "\nprotoMajor=");
    used = bcat10(buf, cap, used, ESHTTP_IPC_PROTO_MAJOR);
    used = bcat(buf, cap, used, "\nprotoMinor=");
    used = bcat10(buf, cap, used, ESHTTP_IPC_PROTO_MINOR);
    used = bcat(buf, cap, used, "\ndllAbi=");
    used = bcat10(buf, cap, used, ESHTTP_IPC_DLL_ABI);
    if (seq(op, ESHTTP_IPC_OP_REQUEST)) {
        /* empty payload= marker; the job body follows as the remainder.
           The worker's req_payload_remainder scans for the payload= line
           and takes everything after it (LF-separated, next_kv-compatible). */
        used = bcat(buf, cap, used, "\npayload=\n");
        used = bcat(buf, cap, used, payload ? payload : "");
        if (payload && payload[0] && payload[slen(payload) - 1] != '\n') {
            used = bcat(buf, cap, used, "\n");
        }
    } else {
        val = payload ? payload : "";
        if (spbrk(val, "\r\n") != NULL) {
            *errClassOut = ESHTTP_IPC_EC_REQUEST_INVALID;
            return -1;
        }
        used = bcat(buf, cap, used, "\npayload=");
        used = bcat(buf, cap, used, val);
        used = bcat(buf, cap, used, "\n");
    }
    if (used == 0 || used + 1 >= cap) {
        *errClassOut = ESHTTP_IPC_EC_INTERNAL;
        return -1;
    }
    return (int)used;
}

/* ------------------------------------------------------------------ */
/* response parsing + handshake validation                             */
/* ------------------------------------------------------------------ */

/* Normalize the response buffer for line parsing: CR/LF become NUL, so
   each line is a plain C string and the caller's buffer keeps a NUL. */
static void normalize_lines(char *buf, unsigned int len) {
    unsigned int i;
    for (i = 0; i < len; i++) {
        if (buf[i] == '\r' || buf[i] == '\n') buf[i] = 0;
    }
    buf[len] = 0;
}

/* Value of `key=` line, or NULL when absent. Assumes normalized buffer. */
static const char *resp_field(const char *buf, const char *key) {
    unsigned int kl = slen(key);
    const char *p = buf;
    while (*p) {
        unsigned int i;
        for (i = 0; i < kl; i++) if (p[i] != key[i]) break;
        if (i == kl && p[kl] == '=') return p + kl + 1;
        p += slen(p) + 1;
    }
    return NULL;
}

static int field_ok(const char *v, unsigned int maxLen) {
    return v != NULL && slen(v) <= maxLen;
}

static long field_long(const char *buf, const char *key, int *ok) {
    const char *v = resp_field(buf, key);
    long n;
    *ok = 0;
    if (!v || *v == 0) return 0;
    n = atol10(v);
    if (n < 0) return 0;
    *ok = 1;
    return n;
}

static unsigned long long field_ull(const char *buf, const char *key, int *ok) {
    const char *v = resp_field(buf, key);
    unsigned long long n;
    *ok = 0;
    if (!v || *v == 0) return 0;
    n = atoull10(v);
    if (n == 0 && v[0] != '0') return 0;
    *ok = 1;
    return n;
}

/* Parse + bound-check every field. Returns 0 on malformed response. */
static int parse_response(char *buf, unsigned int got, EshttpIpcResp *r) {
    const char *magic;
    int ok;
    (void)got;
    memzero(r, sizeof(*r));
    r->success = -1;
    magic = buf;
    if (!seq(magic, ESHTTP_IPC_RESP_MAGIC)) return 0;
    r->op = resp_field(buf, "op");
    r->requestId = resp_field(buf, "requestId");
    r->message = resp_field(buf, "message");
    r->errClass = resp_field(buf, "errClass");
    r->buildId = resp_field(buf, "buildId");
    r->payload = resp_field(buf, "payload");
    if (!field_ok(r->op, ESHTTP_REPORT_OP_MAX) ||
        !field_ok(r->requestId, ESHTTP_FIELD_ID_MAX) ||
        !field_ok(r->message, ESHTTP_FIELD_MESSAGE_MAX) ||
        !field_ok(r->errClass, ESHTTP_FIELD_CLASS_MAX) ||
        !field_ok(r->buildId, ESHTTP_FIELD_ID_MAX)) return 0;
    /* payload is optional (ops without payloads omit the line); when present
       it is either a bounded inline envelope or a result-file path */
    if (r->payload && slen(r->payload) > ESHTTP_IPC_REPORT_MAX) return 0;
    r->protoMajor = field_long(buf, "protoMajor", &r->hasProtoMajor);
    r->protoMinor = field_long(buf, "protoMinor", &r->hasProtoMinor);
    r->workerAbi = field_long(buf, "workerAbi", &r->hasWorkerAbi);
    r->success = (int)field_long(buf, "success", &ok);
    if (!ok || (r->success != 0 && r->success != 1)) return 0;
    r->winerr = (DWORD)field_long(buf, "winerr", &ok);
    r->pid = field_ull(buf, "pid", &ok);
    r->uptimeMs = field_ull(buf, "uptimeMs", &ok);
    r->requests = field_ull(buf, "requests", &ok);
    return 1;
}

/* Handshake gate: version/ABI identity must match before ANY parsed
   response is accepted. Returns NULL when ok, else the errClass. */
static const char *validate_response(const EshttpIpcResp *r,
                                     const char *wantOp,
                                     const char *wantRequestId) {
    if (!r->hasProtoMajor || !r->hasProtoMinor) return ESHTTP_IPC_EC_VERSION_MISMATCH;
    if (!r->hasWorkerAbi) return ESHTTP_IPC_EC_VERSION_MISMATCH;
    if (r->protoMajor != ESHTTP_IPC_PROTO_MAJOR ||
        r->protoMinor != ESHTTP_IPC_PROTO_MINOR) return ESHTTP_IPC_EC_VERSION_MISMATCH;
    if (r->workerAbi != ESHTTP_IPC_WORKER_ABI) return ESHTTP_IPC_EC_VERSION_MISMATCH;
    if (!seq(r->op, wantOp)) return ESHTTP_IPC_EC_RESPONSE_INVALID;
    if (!seq(r->requestId, wantRequestId)) return ESHTTP_IPC_EC_RESPONSE_INVALID;
    return NULL;
}

/* ------------------------------------------------------------------ */
/* pipe transport (hard deadlines on every phase)                      */
/* ------------------------------------------------------------------ */

static const char *io_classify(DWORD err) {
    if (err == ERROR_MORE_DATA) return ESHTTP_IPC_EC_RESPONSE_OVERSIZE;
    if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED)
        return ESHTTP_IPC_EC_WORKER_CRASH;
    return ESHTTP_IPC_EC_INTERNAL;
}

/* Connect to the worker pipe with a bounded budget. Returns 0 ok.
   Classifies: worker-unavailable (pipe never existed), pipe-busy,
   connect-denied, timeout. */
static int pipe_connect(HANDLE *out, unsigned __int64 deadline,
                        const char **errClassOut, DWORD *winerrOut) {
    unsigned __int64 now = GetTickCount64();
    unsigned __int64 budgetEnd = now + ESHTTP_IPC_CONNECT_BUDGET_MS;
    unsigned __int64 end = deadline < budgetEnd ? deadline : budgetEnd;
    int saw_pipe = 0;
    DWORD lastErr = 0;

    for (;;) {
        DWORD waitMs;
        BOOL ok;
        HANDLE h;
        now = GetTickCount64();
        if (now >= end) {
            *winerrOut = lastErr ? lastErr : ERROR_SEM_TIMEOUT;
            if (!saw_pipe) *errClassOut = ESHTTP_IPC_EC_WORKER_UNAVAILABLE;
            else if (lastErr == ERROR_PIPE_BUSY) *errClassOut = ESHTTP_IPC_EC_PIPE_BUSY;
            else *errClassOut = ESHTTP_IPC_EC_TIMEOUT;
            return -1;
        }
        waitMs = (DWORD)(end - now);
        if (waitMs > ESHTTP_IPC_WAITNAMED_MS) waitMs = ESHTTP_IPC_WAITNAMED_MS;
        ok = WaitNamedPipeA(ESHTTP_IPC_PIPE_NAME, waitMs);
        if (ok) saw_pipe = 1;
        else {
            lastErr = GetLastError();
            if (lastErr == ERROR_FILE_NOT_FOUND) {
                Sleep(ESHTTP_IPC_RETRY_SLEEP_MS);
                continue;
            }
            if (lastErr == ERROR_PIPE_BUSY || lastErr == ERROR_SEM_TIMEOUT) {
                saw_pipe = 1;
                Sleep(ESHTTP_IPC_RETRY_SLEEP_MS);
                continue;
            }
            *errClassOut = ESHTTP_IPC_EC_CONNECT_DENIED;
            *winerrOut = lastErr;
            return -1;
        }
        h = CreateFileA(ESHTTP_IPC_PIPE_NAME,
                        GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                        FILE_FLAG_OVERLAPPED, NULL);
        if (h != INVALID_HANDLE_VALUE) {
            /* The worker pipe is message-mode; the client must read in message
               mode too, or ReadFile returns partial bytes and message
               boundaries are lost. Byte-mode is the client default. */
            DWORD mode = PIPE_READMODE_MESSAGE;
            if (!SetNamedPipeHandleState(h, &mode, NULL, NULL)) {
                DWORD se = GetLastError();
                CloseHandle(h);
                *errClassOut = ESHTTP_IPC_EC_INTERNAL;
                *winerrOut = se;
                return -1;
            }
            *out = h;
            *winerrOut = 0;
            return 0;
        }
        lastErr = GetLastError();
        if (lastErr == ERROR_PIPE_BUSY || lastErr == ERROR_FILE_NOT_FOUND) {
            saw_pipe = 1;
            Sleep(ESHTTP_IPC_RETRY_SLEEP_MS);
            continue;
        }
        if (lastErr == ERROR_ACCESS_DENIED) {
            *errClassOut = ESHTTP_IPC_EC_CONNECT_DENIED;
            *winerrOut = lastErr;
            return -1;
        }
        *errClassOut = ESHTTP_IPC_EC_CONNECT_DENIED;
        *winerrOut = lastErr;
        return -1;
    }
}

/* One overlapped read/write with a hard deadline. Returns 0 ok. */
static int overlapped_io(HANDLE h, OVERLAPPED_S *o, unsigned __int64 deadline,
                         int isRead, void *buf, DWORD bufLen, DWORD *bytesDone,
                         const char **errClassOut, DWORD *winerrOut) {
    unsigned __int64 now = GetTickCount64();
    unsigned __int64 remaining = deadline > now ? deadline - now : 0;
    BOOL ok;
    DWORD err;

    if (remaining == 0) {
        *errClassOut = ESHTTP_IPC_EC_TIMEOUT;
        *winerrOut = ERROR_SEM_TIMEOUT;
        return -1;
    }
    ok = isRead ? ReadFile(h, buf, bufLen, bytesDone, o)
                : WriteFile(h, buf, bufLen, bytesDone, o);
    if (ok) {
        *winerrOut = 0;
        return 0;
    }
    err = GetLastError();
    if (err != ERROR_IO_PENDING) {
        *errClassOut = io_classify(err);
        *winerrOut = err;
        return -1;
    }
    {
        DWORD waitRes = WaitForSingleObject(o->hEvent, (DWORD)remaining);
        if (waitRes == WAIT_TIMEOUT) {
            CancelIo(h);
            *errClassOut = ESHTTP_IPC_EC_TIMEOUT;
            *winerrOut = ERROR_SEM_TIMEOUT;
            return -1;
        }
        if (waitRes != WAIT_OBJECT_0) {
            *errClassOut = ESHTTP_IPC_EC_INTERNAL;
            *winerrOut = err;
            return -1;
        }
        if (!GetOverlappedResult(h, o, bytesDone, FALSE)) {
            err = GetLastError();
            *errClassOut = io_classify(err);
            *winerrOut = err;
            return -1;
        }
        *winerrOut = 0;
        return 0;
    }
}

/* Full transaction. Returns response byte count (>0) or -1 with errClass
   set. The response buffer is NUL-terminated at respCap-1 on success.
   Buffers are static (bounded): the single-flight guard serializes every
   call, and static storage keeps the stack frames under the 4 KB
   __chkstk threshold of the freestanding build. */
static int pipe_transact(const char *op, const char *payload, DWORD timeoutMs,
                         char *respBuf, unsigned int respCap, const char *requestId,
                         const char **errClassOut, DWORD *winerrOut) {
    static char req[ESHTTP_IPC_REQ_MAX + 1];
    OVERLAPPED_S o;
    HANDLE h = INVALID_HANDLE_VALUE;
    HANDLE evt = NULL;
    DWORD written = 0, got = 0;
    unsigned __int64 deadline = GetTickCount64() + timeoutMs;
    int n = build_request(op, payload, req, sizeof(req), requestId, errClassOut);

    if (n < 0) {
        *winerrOut = 0;
        return -1;
    }
    if (pipe_connect(&h, deadline, errClassOut, winerrOut)) return -1;

    memzero(&o, sizeof(o));
    evt = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!evt) {
        CloseHandle(h);
        *errClassOut = ESHTTP_IPC_EC_INTERNAL;
        *winerrOut = GetLastError();
        return -1;
    }
    o.hEvent = evt;

    if (overlapped_io(h, &o, deadline, 0, req, (DWORD)n, &written,
                      errClassOut, winerrOut)) {
        CloseHandle(evt);
        CloseHandle(h);
        return -1;
    }
    if (written != (DWORD)n) {
        CloseHandle(evt);
        CloseHandle(h);
        *errClassOut = ESHTTP_IPC_EC_INTERNAL;
        *winerrOut = ERROR_INVALID_USER_BUFFER;
        return -1;
    }
    ResetEvent(evt);
    if (overlapped_io(h, &o, deadline, 1, respBuf, respCap - 1, &got,
                      errClassOut, winerrOut)) {
        CloseHandle(evt);
        CloseHandle(h);
        return -1;
    }
    CloseHandle(evt);
    CloseHandle(h);
    respBuf[got] = 0;
    return (int)got;
}

/* ------------------------------------------------------------------ */
/* normalized report to JSX                                            */
/* ------------------------------------------------------------------ */

static long report_emit(TaggedData *retval, const char *op, int success,
                        const char *errClass, const char *message,
                        DWORD winerr, long workerAbi, const char *buildId,
                        unsigned long long pid, unsigned long long uptimeMs,
                        unsigned long long requests, const char *payload,
                        const char *requestId) {
    static char out[ESHTTP_IPC_REPORT_MAX + 1]; /* static: bounded, single-flight */
    unsigned int used = 0;
    used = bcat(out, sizeof(out), used, "protocol=ESHTTP_IPC_1\n");
    used = bcat(out, sizeof(out), used, "success=");
    used = bcat10(out, sizeof(out), used, success ? 1 : 0);
    used = bcat(out, sizeof(out), used, "\nop=");
    used = bcat(out, sizeof(out), used, op);
    used = bcat(out, sizeof(out), used, "\nrequestId=");
    used = bcat(out, sizeof(out), used, requestId ? requestId : "-");
    used = bcat(out, sizeof(out), used, "\nerrClass=");
    used = bcat(out, sizeof(out), used, errClass);
    used = bcat(out, sizeof(out), used, "\nmessage=");
    used = bcat(out, sizeof(out), used, message ? message : "");
    used = bcat(out, sizeof(out), used, "\nwinerr=");
    used = bcatu10(out, sizeof(out), used, winerr);
    used = bcat(out, sizeof(out), used, "\nprotoMajor=");
    used = bcat10(out, sizeof(out), used, ESHTTP_IPC_PROTO_MAJOR);
    used = bcat(out, sizeof(out), used, "\nprotoMinor=");
    used = bcat10(out, sizeof(out), used, ESHTTP_IPC_PROTO_MINOR);
    used = bcat(out, sizeof(out), used, "\nworkerAbi=");
    used = bcat10(out, sizeof(out), used, workerAbi);
    used = bcat(out, sizeof(out), used, "\nbuildId=");
    used = bcat(out, sizeof(out), used, buildId ? buildId : "-");
    used = bcat(out, sizeof(out), used, "\npid=");
    used = bcatu10(out, sizeof(out), used, pid);
    used = bcat(out, sizeof(out), used, "\nuptimeMs=");
    used = bcatu10(out, sizeof(out), used, uptimeMs);
    used = bcat(out, sizeof(out), used, "\nrequests=");
    used = bcatu10(out, sizeof(out), used, requests);
    used = bcat(out, sizeof(out), used, "\n");
    if (payload && payload[0] && used + slen(payload) + 10 < sizeof(out)) {
        used = bcat(out, sizeof(out), used, "payload=");
        used = bcat(out, sizeof(out), used, payload);
        used = bcat(out, sizeof(out), used, "\n");
    }
    return return_string(retval, out);
}

static int class_eq(const char *a, const char *b) {
    return a && b && seq(a, b);
}

static const char *transport_message(const char *errClass) {
    if (class_eq(errClass, ESHTTP_IPC_EC_TIMEOUT)) return "worker did not respond within the deadline";
    if (class_eq(errClass, ESHTTP_IPC_EC_WORKER_CRASH)) return "worker terminated mid-request";
    if (class_eq(errClass, ESHTTP_IPC_EC_RESPONSE_OVERSIZE)) return "worker response exceeded the size cap";
    if (class_eq(errClass, ESHTTP_IPC_EC_WORKER_UNAVAILABLE)) return "worker is not running";
    if (class_eq(errClass, ESHTTP_IPC_EC_PIPE_BUSY)) return "worker pipe is busy";
    if (class_eq(errClass, ESHTTP_IPC_EC_CONNECT_DENIED)) return "cannot connect to worker pipe";
    if (class_eq(errClass, ESHTTP_IPC_EC_REQUEST_OVERSIZE)) return "request payload exceeded the size cap";
    if (class_eq(errClass, ESHTTP_IPC_EC_REQUEST_INVALID)) return "request contains invalid characters";
    if (class_eq(errClass, ESHTTP_IPC_EC_BUSY)) return "another IPC call is in flight";
    if (class_eq(errClass, ESHTTP_IPC_EC_VERSION_MISMATCH)) return "worker handshake mismatch";
    if (class_eq(errClass, ESHTTP_IPC_EC_RESPONSE_INVALID)) return "worker response is malformed";
    return "internal pipe error";
}

/* Single-flight guard wrapper. */
static long request_impl(TaggedData *retval, const char *op,
                         const char *payload, DWORD timeoutMs) {
    static char resp[ESHTTP_IPC_RESP_MAX + 1]; /* static: bounded, single-flight */
    char requestId[ESHTTP_REQ_ID_HEX + 1];
    EshttpIpcResp r;
    const char *errClass = NULL;
    const char *vmsg;
    DWORD winerr = 0;
    int n;

    if (ESHTTP_CAS(&g_in_flight, 1, 0) != 0) {
        return report_emit(retval, op, 0, ESHTTP_IPC_EC_BUSY,
                           transport_message(ESHTTP_IPC_EC_BUSY), 0, 0, NULL,
                           0, 0, 0, NULL, NULL);
    }

    make_request_id(requestId);
    n = pipe_transact(op, payload, timeoutMs, resp, sizeof(resp), requestId,
                      &errClass, &winerr);
    if (n < 0) {
        vmsg = transport_message(errClass);
        ESHTTP_CAS(&g_in_flight, 0, 1);
        return report_emit(retval, op, 0, errClass, vmsg, winerr, 0, NULL,
                           0, 0, 0, NULL, requestId);
    }

    normalize_lines(resp, (unsigned int)n);
    if (!parse_response(resp, (unsigned int)n, &r)) {
        ESHTTP_CAS(&g_in_flight, 0, 1);
        return report_emit(retval, op, 0, ESHTTP_IPC_EC_RESPONSE_INVALID,
                           transport_message(ESHTTP_IPC_EC_RESPONSE_INVALID),
                           0, 0, NULL, 0, 0, 0, NULL, requestId);
    }
    errClass = validate_response(&r, op, requestId);
    if (errClass) {
        ESHTTP_CAS(&g_in_flight, 0, 1);
        return report_emit(retval, op, 0, errClass,
                           transport_message(errClass), r.winerr,
                           r.workerAbi, r.buildId, r.pid, r.uptimeMs,
                           r.requests, NULL, requestId);
    }
    ESHTTP_CAS(&g_in_flight, 0, 1);
    /* handshake passed: pass the worker's outcome through, normalized */
    return report_emit(retval, r.op, r.success,
                       r.success ? ESHTTP_IPC_EC_OK
                                 : (r.errClass && r.errClass[0] ? r.errClass
                                                                 : ESHTTP_IPC_EC_INTERNAL),
                       r.message && r.message[0] ? r.message
                                                 : (r.success ? "ok" : "worker error"),
                       r.winerr, r.workerAbi, r.buildId, r.pid, r.uptimeMs,
                       r.requests, r.payload, requestId);
}

/* ------------------------------------------------------------------ */
/* ExternalObject entry points                                         */
/* ------------------------------------------------------------------ */

/* Minimal DLL entry point: the freestanding build has no CRT
   DllMainCRTStartup, so the linker is pointed at this directly
   (/entry:DllMain). Returning TRUE on PROCESS_ATTACH is the whole job. */
ESHTTP_IPC_API BOOL WINAPI DllMain(void *hinst, DWORD reason, void *reserved) {
    (void)hinst;
    (void)reason;
    (void)reserved;
    return TRUE;
}

/* Signature string: ONE business method, 3 args (op_s, payload_s, timeout).
 * The timeout is declared _d (arrives as kTypeInteger per the skill's
 * "signature codes cast argument types" — accept the numeric family). */
ESHTTP_IPC_API char *ESInitialize(TaggedData *argv, long argc) {
    (void)argv;
    (void)argc;
    return "eshttp_pipe_request_ssd";
}

ESHTTP_IPC_API long ESGetVersion(void) {
    return 1;
}

/* MUST match this DLL's allocator exactly: every returned buffer comes from
   HeapAlloc(GetProcessHeap()) -> HeapFree. Never free() a static buffer. */
ESHTTP_IPC_API void ESFreeMem(void *p) {
    if (p) HeapFree(GetProcessHeap(), 0, p);
}

ESHTTP_IPC_API void ESTerminate(void) {
    /* no persistent native state to release */
}

/* eshttp_pipe_request(op, payload, timeoutMs) -> kTypeString report.
 *   argv[0] op        kTypeString (ping|status|version|quit|echo|request)
 *   argv[1] payload   kTypeString (op-specific; for request = the LF job
 *                     body or a jobFile=<path> reference)
 *   argv[2] timeoutMs numeric (kTypeInteger/kTypeDouble/kTypeUInteger),
 *                     clamped to [MIN, MAX]; <=0 -> default
 * Returns kESErrOK with a bounded kTypeString report, or
 * kESErrBadArgumentList (catchable). NEVER returns a negative code. */
ESHTTP_IPC_API long eshttp_pipe_request(TaggedData *argv, long argc,
                                        TaggedData *retval) {
    long t;
    DWORD timeoutMs;
    if (argc < 2 || !argv[0].data.string || !argv[1].data.string)
        return kESErrBadArgumentList;
    if (argv[0].type != kTypeString || argv[1].type != kTypeString)
        return kESErrBadArgumentList;
    /* numeric timeout: accept the whole numeric family (skill: signature
       codes cast args; _d arrives as kTypeInteger on this host) */
    if (argc >= 3) {
        if (argv[2].type == kTypeDouble) t = (long)argv[2].data.fltval;
        else if (argv[2].type == kTypeInteger || argv[2].type == kTypeUInteger)
            t = argv[2].data.intval;
        else t = ESHTTP_IPC_TIMEOUT_DEFAULT_MS;
    } else {
        t = ESHTTP_IPC_TIMEOUT_DEFAULT_MS;
    }
    if (t <= 0) t = ESHTTP_IPC_TIMEOUT_DEFAULT_MS;
    if (t < ESHTTP_IPC_TIMEOUT_MIN_MS) t = ESHTTP_IPC_TIMEOUT_MIN_MS;
    if (t > ESHTTP_IPC_TIMEOUT_MAX_MS) t = ESHTTP_IPC_TIMEOUT_MAX_MS;
    timeoutMs = (DWORD)t;
    return request_impl(retval, argv[0].data.string, argv[1].data.string,
                        timeoutMs);
}
