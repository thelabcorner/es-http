/* eshttp-cli.c — production eshttp firewall-escape transport helper.
 *
 * Links eshttp.c statically (the EXACT same v2 engine as eshttp.dll) and
 * exposes ONE action: perform an HTTP request and write the http-v1 envelope
 * to a done file. A SEPARATE process (spawned from Illustrator via
 * File.execute with no argv, ArcFit-style) — this process image is NOT
 * matched by per-app firewall rules that block Illustrator.exe outbound.
 *
 * IPC PROTOCOL (contracts/cli-transport-v1, docs/cli-transport.md):
 *   job file  = text, FIRST line exactly `ESHTTP_CLI_1`, then `key=value`
 *               lines: method, url, done, headers, opts   (headers/opts opt.)
 *   done file = the JSON response envelope (http-v1), written atomically
 *               (`.tmp` + rename). The EXE deletes the job file after claim.
 *
 * CLAIM MODES:
 *   argv mode : eshttp-cli.exe <jobfile>   (explicit path; used by tests)
 *   scan mode : eshttp-cli.exe             (no argv) — scans the ArcFit-style
 *               work dirs (%TEMP% and %TEMP%\opencode) for ESHTTP_*.job,
 *               claims the NEWEST via an EXCLUSIVE open (CreateFileA with
 *               dwShareMode=0 — a second process fails the open, so two
 *               concurrent CLIs cannot double-process), processes it, deletes
 *               it. This is the File.execute() path (driver-cli.ts).
 *
 * EXIT CODES:
 *   0 = request completed, envelope written to <done>
 *   1 = request/IO failure (error detail written to <done> when possible)
 *   2 = usage / no job file / invalid job (no <done> written)
 *
 * BUILD (MSVC, x64 or x86; run the matching vcvars first):
 *   cl /nologo /TC /MT /O2 /D ESHTTP_STATIC /D WIN32_LEAN_AND_MEAN
 *      /D _CRT_SECURE_NO_WARNINGS eshttp-cli.c /Fe:eshttp-cli.exe
 *   (winhttp.lib is linked via #pragma in eshttp.c — do not pass on cmdline)
 */

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#define ESHTTP_STATIC          /* static link: ESHTTP_API = extern */

#include "eshttp.c"            /* same-TU: full engine + exported API */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

#define MAX_LINE 16384
#define MAX_JOB_BYTES (1024 * 1024)  /* hard bound on job file size */

/* ---- atomic done-file write: <done>.tmp then rename ---- */

static int write_file_atomic(const char* path, const char* data) {
    char tmp[MAX_PATH * 2];
    size_t n = strlen(data);
    HANDLE h;
    DWORD written = 0;
    BOOL ok;

    if (_snprintf(tmp, sizeof(tmp), "%s.tmp", path) >= (int)sizeof(tmp)) {
        return 0;
    }
    h = CreateFileA(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) { return 0; }
    ok = WriteFile(h, data, (DWORD)n, &written, NULL);
    CloseHandle(h);
    if (!ok || written != (DWORD)n) { DeleteFileA(tmp); return 0; }
    if (!MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileA(tmp);
        return 0;
    }
    return 1;
}

/* ---- job file read ---- */

static char* read_file(const char* path, size_t* outlen) {
    FILE* f = fopen(path, "rb");
    long sz;
    char* buf;
    if (!f) { return NULL; }
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0 || sz > MAX_JOB_BYTES) { fclose(f); return NULL; }
    buf = (char*)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { free(buf); fclose(f); return NULL; }
    buf[sz] = 0;
    fclose(f);
    if (outlen) { *outlen = (size_t)sz; }
    return buf;
}

/* Read one key=value line from a buffer; advance the cursor. Returns 0 at
 * end of input. Keys and values are NUL-terminated, CR/LF trimmed. */
static int next_kv(const char* buf, size_t len, size_t* pos,
                   char* key, size_t keysz, char* val, size_t valsz) {
    size_t i = *pos;
    size_t start = i;
    size_t eol, j, k;
    if (i >= len) { return 0; }
    while (i < len && buf[i] != '\n') { i++; }
    eol = i;
    j = start; k = 0;
    while (j < eol && buf[j] != '=' && buf[j] != '\r' && k < keysz - 1) { key[k++] = buf[j++]; }
    key[k] = 0;
    if (buf[j] == '=') { j++; }
    k = 0;
    while (j < eol && buf[j] != '\r' && k < valsz - 1) { val[k++] = buf[j++]; }
    val[k] = 0;
    *pos = (i < len) ? i + 1 : i;
    return 1;
}

/* ---- scan-and-claim (no argv): exclusive-open claim ---- */

typedef struct {
    char path[MAX_PATH * 2];
    FILETIME mtime;
} job_candidate;

/* Scan one dir for <pattern>; when excludeWorker is set, skip files whose
   name starts with "ESHTTP_worker_" (worker spawn markers must only ever be
   consumed by the worker-mode path - coordinator-ruled convention with
   core-porter: same ESHTTP_*.job prefix, mode=worker key disambiguates). */
static void scan_dir(const char* dir, job_candidate* best, const char* pattern,
                     int excludeWorker) {
    char pat[MAX_PATH * 2];
    WIN32_FIND_DATAA fd;
    HANDLE h;
    _snprintf(pat, sizeof(pat), "%s\\%s", dir, pattern);
    h = FindFirstFileA(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) { return; }
    do {
        char full[MAX_PATH * 2];
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { continue; }
        if (excludeWorker &&
            strncmp(fd.cFileName, "ESHTTP_worker_", 14) == 0) { continue; }
        _snprintf(full, sizeof(full), "%s\\%s", dir, fd.cFileName);
        if (!best->path[0] ||
            CompareFileTime(&fd.ftLastWriteTime, &best->mtime) > 0) {
            best->mtime = fd.ftLastWriteTime;
            _snprintf(best->path, sizeof(best->path), "%s", full);
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
}

/* Claim via EXCLUSIVE open. which=0 -> worker spawn markers only
   (ESHTTP_worker_*.job); which=1 -> request jobs (ESHTTP_*.job, markers
   excluded). A sharing-violation means another process already claimed it.
   Returns claimed path (malloc'd) or NULL. */
static char* claim_job(int which) {
    char tmp[MAX_PATH];
    job_candidate best;
    DWORD n;
    HANDLE h;
    const char* pattern = (which == 0) ? "ESHTTP_worker_*.job" : "ESHTTP_*.job";
    int excludeWorker = (which == 0) ? 0 : 1;
    memset(&best, 0, sizeof(best));
    n = GetTempPathA(MAX_PATH, tmp);
    if (n > 0 && n < MAX_PATH) {
        scan_dir(tmp, &best, pattern, excludeWorker);
        {
            char sub[MAX_PATH * 2];
            _snprintf(sub, sizeof(sub), "%sopencode", tmp);
            scan_dir(sub, &best, pattern, excludeWorker);
        }
    }
    if (!best.path[0]) { return NULL; }
    /* Exclusive claim: no sharing allowed. If it fails, another process is
     * already processing this job (or it is locked) — treat as not-ours. */
    h = CreateFileA(best.path, GENERIC_READ, 0, NULL, OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) { return NULL; }
    CloseHandle(h);
    return _strdup(best.path);
}

/* ================================================================== */
/* WORKER MODE (T17) — persistent named-pipe server                    */
/* ================================================================== */
/* eshttp-cli.exe --worker: persistent process owning the single-instance
 * \\.\pipe\EshttpBridge. Warm WinHTTP session (the v2 engine's session cache
 * persists in this process; eshttp.c keeps WinHTTP init lazy per
 * native-abi-v2), pid-file lifecycle, idle timeout. One request per accepted
 * connection (message-mode pipe), consumed exactly once. Protocol: see
 * eshttp-ipc.h (single source of truth for worker + bridge DLL).
 *
 * Skill-driven design (externalobject-extendscript SKILL.md): the worker is
 * a plain EXE - no ExternalObject, so no signature-cast / per-method-binding
 * concerns here (those are the bridge DLL's, T18); never-negative error
 * codes (the engine returns kESErrOK/kESErrBadArgumentList only); ESFreeMem
 * ownership exactness (every kTypeString envelope freed exactly once);
 * bounded payloads (ESHTTP_IPC_PAYLOAD_MAX; large response envelopes travel
 * by file path - skill L193-195 multi-MB strings unsafe).
 */
#include "eshttp-ipc.h"

static unsigned long long g_started_tick;
static unsigned long long g_requests;
static int g_quit;
static int g_test_ops;
static DWORD g_idle_ms = ESHTTP_IPC_IDLE_DEFAULT_MS;
static unsigned long long g_last_activity;

/* ---- request parsing (line-based; mirrors the ArcFit template) ---- */

typedef struct EshttpIpcReq {
    const char* op;
    const char* requestId;
    const char* payload;       /* single-line payload field value */
    const char* raw;           /* the full normalized request message */
    long protoMajor, protoMinor, dllAbi;
    int hasProtoMajor, hasProtoMinor, hasDllAbi;
} EshttpIpcReq;

static void normalize_lines(char* buf, size_t len) {
    size_t i;
    for (i = 0; i < len; i++) {
        if (buf[i] == '\r' || buf[i] == '\n') buf[i] = 0;
    }
    buf[len] = 0;
}

static const char* req_field(const char* buf, const char* key) {
    size_t kl = strlen(key);
    const char* p = buf;
    while (*p) {
        if (strncmp(p, key, kl) == 0 && p[kl] == '=') return p + kl + 1;
        p += strlen(p) + 1;
    }
    return NULL;
}

/* Newline-aware field scan for LF-separated text (the request op's raw job
   body, which must stay LF-separated for next_kv). An EMPTY value
   (`payload=` with nothing after the '=') is a valid match — the request op
   uses an empty payload= marker followed by the job body on later lines. */
static const char* req_field_nl(const char* buf, const char* key) {
    size_t kl = strlen(key);
    const char* p = buf;
    while (*p) {
        const char* eol = strchr(p, '\n');
        size_t linelen = eol ? (size_t)(eol - p) : strlen(p);
        if (linelen >= kl && strncmp(p, key, kl) == 0 && p[kl] == '=') {
            return p + kl + 1;
        }
        if (!eol) break;
        p = eol + 1;
    }
    return NULL;
}

static long req_field_long(const char* buf, const char* key, int* ok) {
    const char* v = req_field(buf, key);
    char* endp = NULL;
    long n;
    *ok = 0;
    if (!v || *v == 0) return 0;
    n = strtol(v, &endp, 10);
    if (endp == v || *endp != 0) return 0;
    *ok = 1;
    return n;
}

/* For op=request: the job body rides the pipe as the message remainder
   after the `payload=` marker line (multi-line http-v1 job text, LF-
   separated - the raw copy, since next_kv requires LF separators). */
static const char* req_payload_remainder(const char* buf) {
    const char* v = req_field_nl(buf, "payload");
    const char* nl;
    if (!v) return NULL;
    nl = strchr(v, '\n');
    if (!nl) return NULL;
    return nl + 1;
}

static int parse_request(char* buf, size_t got, EshttpIpcReq* r) {
    const char* magic;
    (void)got;
    memset(r, 0, sizeof(*r));
    r->raw = buf;
    magic = buf;
    if (strcmp(magic, ESHTTP_IPC_REQ_MAGIC) != 0) return 0;
    r->op = req_field(buf, "op");
    r->requestId = req_field(buf, "requestId");
    r->payload = req_field(buf, "payload");
    if (!r->op || strlen(r->op) == 0 || strlen(r->op) > ESHTTP_IPC_OP_MAX) return 0;
    if (r->requestId && strlen(r->requestId) > ESHTTP_IPC_OP_MAX * 2) return 0;
    r->protoMajor = req_field_long(buf, "protoMajor", &r->hasProtoMajor);
    r->protoMinor = req_field_long(buf, "protoMinor", &r->hasProtoMinor);
    r->dllAbi = req_field_long(buf, "dllAbi", &r->hasDllAbi);
    return 1;
}

/* ---- response building ---- */

typedef struct RespBuilder {
    char* buf;
    size_t cap;
    size_t used;
} RespBuilder;

static void rb_printf(RespBuilder* b, const char* fmt, ...) {
    va_list ap;
    size_t room = b->cap - b->used;
    int n;
    if (room == 0) return;
    va_start(ap, fmt);
    n = _vsnprintf_s(b->buf + b->used, room, _TRUNCATE, fmt, ap);
    va_end(ap);
    if (n > 0) b->used += (size_t)n;
}

static void respond(HANDLE pipe, RespBuilder* b, const char* op,
                    const char* requestId, int success, const char* errClass,
                    const char* message, const char* payload) {
    DWORD w = 0;
    b->used = 0;
    rb_printf(b, ESHTTP_IPC_RESP_MAGIC "\n");
    rb_printf(b, "success=%d\n", success);
    rb_printf(b, "op=%s\n", op ? op : "-");
    rb_printf(b, "requestId=%s\n", requestId ? requestId : "-");
    rb_printf(b, "message=%s\n", message ? message : "");
    rb_printf(b, "errClass=%s\n", errClass ? errClass : ESHTTP_IPC_EC_OK);
    rb_printf(b, "winerr=0\n");
    rb_printf(b, "protoMajor=%d\n", ESHTTP_IPC_PROTO_MAJOR);
    rb_printf(b, "protoMinor=%d\n", ESHTTP_IPC_PROTO_MINOR);
    rb_printf(b, "workerAbi=%d\n", ESHTTP_IPC_WORKER_ABI);
    rb_printf(b, "buildId=%s\n", ESHTTP_IPC_BUILD_ID);
    rb_printf(b, "pid=%lu\n", (unsigned long)GetCurrentProcessId());
    rb_printf(b, "uptimeMs=%llu\n",
              (unsigned long long)(GetTickCount64() - g_started_tick));
    rb_printf(b, "requests=%llu\n", g_requests);
    if (payload && payload[0]) rb_printf(b, "payload=%s\n", payload);
    WriteFile(pipe, b->buf, (DWORD)b->used, &w, NULL);
    FlushFileBuffers(pipe);
}

/* ---- request execution (the v2 engine, shared with the one-shot mode) ---- */

/* Parse http-v1 job text (optional ESHTTP_CLI_1 header) and run the request.
 * Returns the http-v1 envelope (malloc'd; caller frees via ESFreeMem) or NULL
 * on execution failure. Never leaves a dangling allocation on error paths. */
static char* run_request_from_job(const char* text, size_t len) {
    size_t pos = 0;
    char key[MAX_LINE], val[MAX_LINE];
    const char* method = "GET";
    const char* url = NULL;
    const char* headers = "{}";
    const char* opts = "{\"proxy\":\"direct\",\"timeoutMs\":15000}";
    TaggedData args[5];
    TaggedData retval;
    const char* strs[5];
    long i;

    while (next_kv(text, len, &pos, key, sizeof(key), val, sizeof(val))) {
        if (strcmp(key, "ESHTTP_CLI_1") == 0) { continue; }  /* optional header */
        if (strcmp(key, "method") == 0)  { method = _strdup(val); }
        else if (strcmp(key, "url") == 0)     { url = _strdup(val); }
        else if (strcmp(key, "headers") == 0) { headers = _strdup(val); }
        else if (strcmp(key, "opts") == 0)    { opts = _strdup(val); }
        /* unknown keys ignored (forward compatible) */
    }
    if (!url) return NULL;

    strs[0] = method;
    strs[1] = url;
    strs[2] = headers;
    strs[3] = "";
    strs[4] = opts;
    memset(args, 0, sizeof(args));
    for (i = 0; i < 5; i++) {
        args[i].type = kTypeString;
        args[i].data.string = (char*)strs[i];
        args[i].filler = 0;
    }
    memset(&retval, 0, sizeof(retval));
    if (eshttp_request(args, 5, &retval) != kESErrOK) return NULL;
    if (retval.type != kTypeString || !retval.data.string) return NULL;
    return retval.data.string;   /* caller frees via ESFreeMem (exact once) */
}

static void result_file_path(const char* requestId, char* out, size_t outsz) {
    char tmp[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, tmp);
    _snprintf(out, outsz, "%sopencode\\eshttp-resp_%s.json", tmp,
              (requestId && requestId[0]) ? requestId : "x");
}

/* ---- dispatch ---- */

static int dispatch_op(HANDLE pipe, RespBuilder* b, const EshttpIpcReq* r) {
    const char* op = r->op;

    if (strcmp(op, ESHTTP_IPC_OP_QUIT) == 0) {
        respond(pipe, b, op, r->requestId, 1, ESHTTP_IPC_EC_OK, "bye", NULL);
        return 0;
    }
    if (strcmp(op, ESHTTP_IPC_OP_PING) == 0) {
        respond(pipe, b, op, r->requestId, 1, ESHTTP_IPC_EC_OK, "pong", NULL);
        return 1;
    }
    if (strcmp(op, ESHTTP_IPC_OP_STATUS) == 0) {
        respond(pipe, b, op, r->requestId, 1, ESHTTP_IPC_EC_OK, "ready", NULL);
        return 1;
    }
    if (strcmp(op, ESHTTP_IPC_OP_VERSION) == 0) {
        respond(pipe, b, op, r->requestId, 1, ESHTTP_IPC_EC_OK, "version", NULL);
        return 1;
    }
    if (strcmp(op, ESHTTP_IPC_OP_ECHO) == 0) {
        if (!r->payload) {
            respond(pipe, b, op, r->requestId, 0, ESHTTP_IPC_EC_REQUEST_INVALID,
                    "missing-payload", NULL);
            return 1;
        }
        respond(pipe, b, op, r->requestId, 1, ESHTTP_IPC_EC_OK, "echo", r->payload);
        return 1;
    }
    if (strcmp(op, ESHTTP_IPC_OP_REQUEST) == 0) {
        /* job body rides the pipe (message remainder after the payload= line)
           or a jobFile= path for large payloads */
        const char* rem = req_payload_remainder(r->raw);
        const char* jf = NULL;
        char* env = NULL;
        size_t envlen = 0;
        char* envelope;
        if (!rem || !rem[0]) {
            respond(pipe, b, op, r->requestId, 0, ESHTTP_IPC_EC_REQUEST_INVALID,
                    "missing-payload", NULL);
            return 1;
        }
        jf = req_field_nl(rem, "jobFile");
        if (jf && jf[0]) {
            env = read_file(jf, &envlen);
            if (!env) {
                respond(pipe, b, op, r->requestId, 0, ESHTTP_IPC_EC_REQUEST_INVALID,
                        "jobFile-unreadable", NULL);
                return 1;
            }
        } else {
            envlen = strlen(rem);
            env = (char*)malloc(envlen + 1);
            if (!env) { respond(pipe, b, op, r->requestId, 0,
                                ESHTTP_IPC_EC_INTERNAL, "oom", NULL); return 1; }
            memcpy(env, rem, envlen + 1);
        }
        g_last_activity = GetTickCount64();
        envelope = run_request_from_job(env, envlen);
        if (!envelope) {
            respond(pipe, b, op, r->requestId, 0, ESHTTP_IPC_EC_WORKER_ERROR,
                    "request-exec-failed", NULL);
        } else {
            /* http-v1 envelope: `ok` field tells success vs handled error.
             * Per eshttp-ipc.h, a request that EXECUTED but returned an
             * error envelope is success=0 + errClass=worker-error with the
             * envelope as the payload (so the bridge's JSX side can
             * distinguish a handled HTTP failure from a transport failure). */
            int env_ok = strstr(envelope, "\"ok\":true") != NULL;
            const char* eclass = env_ok ? ESHTTP_IPC_EC_OK
                                        : ESHTTP_IPC_EC_WORKER_ERROR;
            const char* emsg = env_ok ? "request-done" : "request-done-error";
            if (strlen(envelope) <= ESHTTP_IPC_PAYLOAD_MAX) {
                respond(pipe, b, op, r->requestId, env_ok ? 1 : 0,
                        eclass, emsg, envelope);
                ESFreeMem(envelope);
            } else {
                /* large envelope: travel by file path (skill: multi-MB strings
                   across the boundary are unsafe) */
                char rfpath[MAX_PATH * 2];
                result_file_path(r->requestId, rfpath, sizeof(rfpath));
                if (write_file_atomic(rfpath, envelope)) {
                    respond(pipe, b, op, r->requestId, env_ok ? 1 : 0,
                            eclass, env_ok ? "request-done-file"
                                           : "request-done-error-file",
                            rfpath);
                } else {
                    respond(pipe, b, op, r->requestId, 0, ESHTTP_IPC_EC_INTERNAL,
                            "result-file-write-failed", NULL);
                }
                ESFreeMem(envelope);
            }
        }
        free(env);
        return 1;
    }

    /* ---- adversarial test ops (only with --test / ESHTTP_IPC_TEST_OPS=1) ---- */
    if (g_test_ops) {
        if (strcmp(op, ESHTTP_IPC_OP_SLOW) == 0) {
            Sleep(500);
            respond(pipe, b, op, r->requestId, 1, ESHTTP_IPC_EC_OK, "slow-done", NULL);
            return 1;
        }
        if (strcmp(op, ESHTTP_IPC_OP_HANG) == 0) {
            Sleep(4000);
            return 1;
        }
        if (strcmp(op, ESHTTP_IPC_OP_CRASH_AFTER_ACCEPT) == 0) {
            TerminateProcess(GetCurrentProcess(), 1);
        }
        if (strcmp(op, ESHTTP_IPC_OP_OVERSIZE) == 0) {
            size_t i;
            DWORD w = 0;
            b->used = 0;
            rb_printf(b, ESHTTP_IPC_RESP_MAGIC "\n");
            rb_printf(b, "success=1\nop=%s\nrequestId=%s\nmessage=oversize\n",
                      op, r->requestId);
            rb_printf(b, "protoMajor=%d\nprotoMinor=%d\nworkerAbi=%d\n",
                      ESHTTP_IPC_PROTO_MAJOR, ESHTTP_IPC_PROTO_MINOR,
                      ESHTTP_IPC_WORKER_ABI);
            rb_printf(b, "payload=");
            for (i = b->used; i < b->cap; i++) b->buf[i] = 'x';
            b->used = b->cap;
            WriteFile(pipe, b->buf, (DWORD)b->used, &w, NULL);
            FlushFileBuffers(pipe);
            return 1;
        }
        if (strcmp(op, ESHTTP_IPC_OP_PARTIAL) == 0) {
            DWORD w = 0;
            char bad[512];
            int n = _snprintf_s(bad, sizeof(bad), _TRUNCATE,
                ESHTTP_IPC_RESP_MAGIC "\nop=%s\nrequestId=%s\nmessage=truncated\n",
                op, r->requestId);
            WriteFile(pipe, bad, (DWORD)(n > 0 ? n : 0), &w, NULL);
            FlushFileBuffers(pipe);
            return 1;
        }
        if (strcmp(op, ESHTTP_IPC_OP_GARBAGE) == 0) {
            DWORD w = 0;
            static const char junk[] = "hello this is not a protocol\n\n";
            WriteFile(pipe, junk, (DWORD)(sizeof(junk) - 1), &w, NULL);
            FlushFileBuffers(pipe);
            return 1;
        }
        if (strcmp(op, ESHTTP_IPC_OP_BAD_VERSION) == 0) {
            DWORD w = 0;
            char bad[512];
            int n = _snprintf_s(bad, sizeof(bad), _TRUNCATE,
                ESHTTP_IPC_RESP_MAGIC "\nsuccess=1\nop=%s\nrequestId=%s\nmessage=stale\n"
                "errClass=ok\nwinerr=0\nprotoMajor=999\nprotoMinor=0\nworkerAbi=999\n"
                "buildId=%s\n",
                op, r->requestId, ESHTTP_IPC_BUILD_ID);
            WriteFile(pipe, bad, (DWORD)(n > 0 ? n : 0), &w, NULL);
            FlushFileBuffers(pipe);
            return 1;
        }
    }

    respond(pipe, b, op, r->requestId, 0, ESHTTP_IPC_EC_UNKNOWN_OP, "unknown-op", NULL);
    return 1;
}

/* ---- connection handling ---- */

static void handle_connection(HANDLE pipe) {
    char req[ESHTTP_IPC_REQ_MAX + 1];
    char reqraw[ESHTTP_IPC_REQ_MAX + 1];
    char resp[ESHTTP_IPC_RESP_MAX + 1];
    DWORD got = 0;
    EshttpIpcReq r;
    RespBuilder b;
    DWORD err;

    b.buf = resp;
    b.cap = sizeof(resp);
    b.used = 0;

    if (!ReadFile(pipe, req, ESHTTP_IPC_REQ_MAX, &got, NULL)) {
        err = GetLastError();
        if (err == ERROR_MORE_DATA) {
            b.used = 0;
            rb_printf(&b, ESHTTP_IPC_RESP_MAGIC "\n");
            rb_printf(&b, "success=0\nop=-\nrequestId=-\n");
            rb_printf(&b, "message=request-oversize\nerrClass=%s\nwinerr=%lu\n",
                      ESHTTP_IPC_EC_REQUEST_OVERSIZE, (unsigned long)err);
            rb_printf(&b, "protoMajor=%d\nprotoMinor=%d\nworkerAbi=%d\n",
                      ESHTTP_IPC_PROTO_MAJOR, ESHTTP_IPC_PROTO_MINOR,
                      ESHTTP_IPC_WORKER_ABI);
            WriteFile(pipe, b.buf, (DWORD)b.used, &got, NULL);
            FlushFileBuffers(pipe);
        }
        return;
    }
    g_requests++;
    g_last_activity = GetTickCount64();
    req[got] = 0;
    memcpy(reqraw, req, got + 1);   /* keep the raw LF-separated copy for the
                                       request op's job-body parsing (next_kv
                                       requires LF, not NUL, separators) */
    normalize_lines(req, got);

    if (!parse_request(req, got, &r)) {
        respond(pipe, &b, "-", NULL, 0, ESHTTP_IPC_EC_RESPONSE_INVALID,
                "request is malformed", NULL);
        return;
    }

    /* handshake gate: reject incompatible/stale callers before any op */
    if (!r.hasProtoMajor || !r.hasProtoMinor || !r.hasDllAbi ||
        r.protoMajor != ESHTTP_IPC_PROTO_MAJOR ||
        r.protoMinor != ESHTTP_IPC_PROTO_MINOR ||
        r.dllAbi != ESHTTP_IPC_DLL_ABI) {
        respond(pipe, &b, r.op, r.requestId, 0, ESHTTP_IPC_EC_VERSION_MISMATCH,
                "request protocol mismatch", NULL);
        return;
    }

    r.raw = reqraw;   /* dispatch's request op re-parses the LF job text */
    if (!dispatch_op(pipe, &b, &r)) g_quit = 1;
}

/* ---- idle-aware single-instance connect ---- */

static int connect_with_idle(HANDLE pipe) {
    OVERLAPPED ov;
    DWORD dummy = 0;
    BOOL ok;
    memset(&ov, 0, sizeof(ov));
    ov.hEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) return -1;
    ok = ConnectNamedPipe(pipe, &ov);
    if (!ok && GetLastError() == ERROR_IO_PENDING) {
        for (;;) {
            DWORD w = WaitForSingleObject(ov.hEvent, 250);
            if (w == WAIT_OBJECT_0) {
                GetOverlappedResult(pipe, &ov, &dummy, FALSE);
                break;
            }
            if (w == WAIT_TIMEOUT) {
                if ((unsigned long long)GetTickCount64() - g_last_activity > g_idle_ms) {
                    CancelIo(pipe);
                    CloseHandle(ov.hEvent);
                    return 0;   /* idle timeout: worker self-exits */
                }
                continue;
            }
            CancelIo(pipe);
            CloseHandle(ov.hEvent);
            return -1;
        }
    } else if (!ok && GetLastError() != ERROR_PIPE_CONNECTED) {
        CloseHandle(ov.hEvent);
        return -1;
    }
    CloseHandle(ov.hEvent);
    return 1;
}

/* ---- pid-file lifecycle ---- */

static void write_pidfile(void) {
    char tmp[MAX_PATH];
    char path[MAX_PATH * 2];
    HANDLE h;
    DWORD n, wrote = 0;
    char buf[32];
    n = GetTempPathA(MAX_PATH, tmp);
    if (n == 0 || n >= MAX_PATH) return;
    _snprintf(path, sizeof(path), "%sopencode\\eshttp-worker.pid", tmp);
    h = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    _snprintf(buf, sizeof(buf), "%lu\n", (unsigned long)GetCurrentProcessId());
    WriteFile(h, buf, (DWORD)strlen(buf), &wrote, NULL);
    CloseHandle(h);
}

static void remove_pidfile(void) {
    char tmp[MAX_PATH];
    char path[MAX_PATH * 2];
    DWORD n = GetTempPathA(MAX_PATH, tmp);
    if (n == 0 || n >= MAX_PATH) return;
    _snprintf(path, sizeof(path), "%sopencode\\eshttp-worker.pid", tmp);
    DeleteFileA(path);
}

/* ---- loopback selftest (ALL GREEN gate) ---- */

/* Server thread: blocking ConnectNamedPipe + serve loop. A single-threaded
   handshake deadlocks (client CreateFile <-> server ConnectNamedPipe), so
   the loopback uses the canonical two-thread pattern. */
static DWORD WINAPI selftest_server(LPVOID arg) {
    HANDLE pipe = (HANDLE)arg;
    while (!g_quit) {
        if (!ConnectNamedPipe(pipe, NULL) &&
            GetLastError() != ERROR_PIPE_CONNECTED) {
            DisconnectNamedPipe(pipe);
            continue;   /* transient: reset the instance */
        }
        handle_connection(pipe);
        DisconnectNamedPipe(pipe);
    }
    return 0;
}

/* Client-side per-op connection (one connection per request). Returns a
   connected client handle or INVALID_HANDLE_VALUE. */
static HANDLE selftest_connect(void) {
    if (!WaitNamedPipeA(ESHTTP_IPC_PIPE_SELFTEST, 5000)) return INVALID_HANDLE_VALUE;
    return CreateFileA(ESHTTP_IPC_PIPE_SELFTEST,
                       GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
}

/* One op round-trip from the client side: open a fresh connection, write the
   request, read the response (the server thread serves it), close. */
static int selftest_op(const char* msg, char* out, size_t outsz) {
    HANDLE c;
    DWORD w = 0, got = 0;
    int ok = 0;
    c = selftest_connect();
    if (c == INVALID_HANDLE_VALUE) return 0;
    if (WriteFile(c, msg, (DWORD)strlen(msg), &w, NULL)) {
        if (ReadFile(c, out, (DWORD)outsz - 1, &got, NULL) ||
            GetLastError() == ERROR_MORE_DATA) {
            out[got] = 0;
            ok = 1;
        }
    }
    CloseHandle(c);
    return ok;
}

static int selftest_expect(const char* label, int cond) {
    printf("%s %s\n", cond ? "PASS" : "FAIL", label);
    return cond ? 0 : 1;
}

static int selftest_main(void) {
    int fails = 0;
    HANDLE pipe, c, th;
    char resp[ESHTTP_IPC_RESP_MAX + 1];

    setvbuf(stdout, NULL, _IONBF, 0);   /* unbuffered: prints flush live */
    printf("=== eshttp-cli worker loopback selftest ===\n");
    g_started_tick = GetTickCount64();
    g_requests = 0;
    g_quit = 0;
    g_test_ops = 1;   /* selftest exercises the full dispatch incl. adversarial */

    printf("selftest: CreateNamedPipe\n");
    pipe = CreateNamedPipeA(ESHTTP_IPC_PIPE_SELFTEST, PIPE_ACCESS_DUPLEX,
                            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                            1, ESHTTP_IPC_RESP_MAX, ESHTTP_IPC_REQ_MAX + 1024,
                            0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        printf("FAIL CreateNamedPipe(selftest) (%lu)\n", GetLastError());
        return 1;
    }

    printf("selftest: server thread\n");
    th = CreateThread(NULL, 0, selftest_server, (LPVOID)pipe, 0, NULL);
    if (!th) {
        printf("FAIL CreateThread (selftest)\n");
        CloseHandle(pipe);
        return 1;
    }

    printf("selftest: WaitNamedPipe + client CreateFile\n");
    if (!WaitNamedPipeA(ESHTTP_IPC_PIPE_SELFTEST, 5000)) {
        printf("FAIL WaitNamedPipe (selftest) (%lu)\n", GetLastError());
        return 1;
    }
    c = CreateFileA(ESHTTP_IPC_PIPE_SELFTEST,
                    GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (c == INVALID_HANDLE_VALUE) {
        printf("FAIL client open (selftest) (%lu)\n", GetLastError());
        return 1;
    }
    printf("selftest: connected, running ops\n");
    CloseHandle(c);   /* the first connection is consumed by the ping below */
    /* One connection per request (the worker's single-instance message-mode
       model: each accepted connection carries exactly one request). Reconnect
       for every op. */

    /* ping */
    fails += selftest_expect("ping roundtrip",
        selftest_op(
          ESHTTP_IPC_REQ_MAGIC "\nop=ping\nrequestId=t1\nprotoMajor=1\nprotoMinor=0\ndllAbi=1\n",
          resp, sizeof(resp)) &&
        strstr(resp, "success=1") && strstr(resp, "message=pong"));
    fails += selftest_expect("ping errClass=ok", strstr(resp, "errClass=ok") != NULL);

    /* version */
    fails += selftest_expect("version roundtrip",
        selftest_op(
          ESHTTP_IPC_REQ_MAGIC "\nop=version\nrequestId=t2\nprotoMajor=1\nprotoMinor=0\ndllAbi=1\n",
          resp, sizeof(resp)) &&
        strstr(resp, "success=1"));
    fails += selftest_expect("version proto/abi echoed",
        strstr(resp, "protoMajor=1") && strstr(resp, "workerAbi=1"));

    /* echo */
    fails += selftest_expect("echo roundtrip",
        selftest_op(
          ESHTTP_IPC_REQ_MAGIC "\nop=echo\nrequestId=t3\nprotoMajor=1\nprotoMinor=0\ndllAbi=1\npayload=hello-echo\n",
          resp, sizeof(resp)) &&
        strstr(resp, "success=1"));
    fails += selftest_expect("echo payload", strstr(resp, "payload=hello-echo") != NULL);

    /* request op (no network: localhost port 1 -> connect error envelope;
       exercises the FULL v2 engine + envelope mapping through the pipe) */
    {
        const char* reqmsg =
          ESHTTP_IPC_REQ_MAGIC "\nop=request\nrequestId=t4\nprotoMajor=1\nprotoMinor=0\ndllAbi=1\npayload=\n"
          "method=GET\nurl=http://127.0.0.1:1/probe\nheaders={}\nopts={\"proxy\":\"direct\",\"timeoutMs\":3000}\n";
        fails += selftest_expect("request roundtrip",
            selftest_op( reqmsg, resp, sizeof(resp)) &&
            strstr(resp, "success="));
        fails += selftest_expect("request worker-error + http-v1 envelope",
            strstr(resp, "errClass=worker-error") != NULL &&
            strstr(resp, "payload=") != NULL &&
            strstr(resp, "\"error\"") != NULL);
    }

    /* adversarial: garbage -> response-invalid, badVersion -> version-mismatch */
    fails += selftest_expect("garbage rejected",
        selftest_op( "this is not protocol\n\n", resp, sizeof(resp)) &&
        strstr(resp, "success=0"));
    fails += selftest_expect("bad-version -> version-mismatch",
        selftest_op(
          ESHTTP_IPC_REQ_MAGIC "\nop=ping\nrequestId=t6\nprotoMajor=999\nprotoMinor=0\ndllAbi=999\n",
          resp, sizeof(resp)) &&
        strstr(resp, "errClass=version-mismatch"));

    /* quit (server thread's handle_connection sets g_quit -> loop exits) */
    fails += selftest_expect("quit roundtrip",
        selftest_op(
          ESHTTP_IPC_REQ_MAGIC "\nop=quit\nrequestId=t7\nprotoMajor=1\nprotoMinor=0\ndllAbi=1\n",
          resp, sizeof(resp)) &&
        strstr(resp, "message=bye"));

    WaitForSingleObject(th, 5000);   /* join the server thread */
    CloseHandle(th);
    CloseHandle(pipe);

    printf("=== RESULT: %s (%d check groups, requests=%llu) ===\n",
           fails == 0 ? "ALL GREEN" : "FAILURES", 10, g_requests);
    return fails == 0 ? 0 : 1;
}

/* ---- worker main ---- */

static int worker_main(void) {
    HANDLE pipe;

    g_started_tick = GetTickCount64();
    g_requests = 0;
    g_quit = 0;
    g_last_activity = GetTickCount64();

    pipe = CreateNamedPipeA(ESHTTP_IPC_PIPE_NAME, PIPE_ACCESS_DUPLEX,
                            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                            1, ESHTTP_IPC_RESP_MAX, ESHTTP_IPC_REQ_MAX + 1024,
                            0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "worker: CreateNamedPipe failed (%lu)\n", GetLastError());
        return 2;
    }

    /* Create the pipe BEFORE advertising the pid file: a driver that polls
       the pid file and immediately connects must never see a pid file with
       no pipe behind it (the T18 bridge connect budget covers the window,
       but ordering removes it entirely — no worker-unavailable race). */
    write_pidfile();

    /* The instance persists for the process lifetime, so the pipe name always
       exists while the worker is alive (no close/recreate race). */
    while (!g_quit) {
        int rc = connect_with_idle(pipe);
        if (rc == 0) break;                 /* idle timeout: self-exit */
        if (rc < 0) {
            DisconnectNamedPipe(pipe);
            continue;                       /* transient: reset the instance */
        }
        handle_connection(pipe);
        DisconnectNamedPipe(pipe);
    }

    CloseHandle(pipe);
    remove_pidfile();
    return 0;
}

int main(int argc, char** argv) {
    int i;

    /* mode dispatch (must precede the one-shot argv-as-jobfile path) */
    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--worker") == 0) return worker_main();
        if (strcmp(argv[i], "--selftest") == 0) return selftest_main();
        if (strcmp(argv[i], "--test") == 0) g_test_ops = 1;
        if (strcmp(argv[i], "--idle-ms") == 0 && i + 1 < argc) {
            long v = atol(argv[++i]);
            if (v > 0) g_idle_ms = (DWORD)v;
        }
    }
    if (g_idle_ms < ESHTTP_IPC_IDLE_MIN_MS) g_idle_ms = ESHTTP_IPC_IDLE_MIN_MS;

    char* job = NULL;
    char* jobpath = NULL;
    size_t joblen = 0;
    size_t pos = 0;
    char key[MAX_LINE], val[MAX_LINE];
    const char* method = "GET";
    const char* url = NULL;
    const char* done = NULL;
    const char* headers = "{}";
    const char* opts = "{\"proxy\":\"direct\",\"timeoutMs\":15000}";
    const char* mode = NULL;
    int headerSeen = 0;
    TaggedData args[5];
    TaggedData retval;
    const char* strs[5];
    int rc = 1;

    if (argc >= 2) {
        jobpath = _strdup(argv[1]);
    } else {
        /* Two-pass claim (coordinator-ruled option a + core-porter's filter):
           pass 0 claims a worker spawn marker ONLY (ESHTTP_worker_*.job) and
           routes to worker_main(); pass 1 claims request jobs (ESHTTP_*.job
           with worker markers EXCLUDED), so a racing oneshot scan can never
           consume a marker and a request job is never delayed by one. */
        jobpath = claim_job(0);
        if (jobpath) {
            job = read_file(jobpath, &joblen);
            if (job) {
                size_t p2 = 0;
                char k2[MAX_LINE], v2[MAX_LINE];
                int h2 = 0;
                while (next_kv(job, joblen, &p2, k2, sizeof(k2), v2, sizeof(v2))) {
                    if (!h2) {
                        if (strcmp(k2, "ESHTTP_CLI_1") == 0) { h2 = 1; }
                        continue;
                    }
                    if (strcmp(k2, "mode") == 0 && strcmp(v2, "worker") == 0) {
                        remove(jobpath);          /* claimed: delete the marker */
                        free(job);
                        free(jobpath);
                        return worker_main();
                    }
                }
                /* worker-named job WITHOUT mode=worker: malformed litter -
                   delete and fall through to the request-job claim */
                remove(jobpath);
                free(job);
            }
            free(jobpath);
            jobpath = NULL;
        }
        jobpath = claim_job(1);
        if (jobpath) { fprintf(stderr, "claimed: %s\n", jobpath); }
    }
    if (!jobpath) {
        fprintf(stderr, "no job file\n");
        return 2;
    }
    job = read_file(jobpath, &joblen);
    if (!job) { free(jobpath); return 2; }

    while (next_kv(job, joblen, &pos, key, sizeof(key), val, sizeof(val))) {
        if (!headerSeen) {
            if (strcmp(key, "ESHTTP_CLI_1") == 0) { headerSeen = 1; }
            continue;   /* ignore any preamble before the header */
        }
        if (strcmp(key, "method") == 0)  { method = _strdup(val); }
        else if (strcmp(key, "url") == 0)     { url = _strdup(val); }
        else if (strcmp(key, "done") == 0)    { done = _strdup(val); }
        else if (strcmp(key, "headers") == 0) { headers = _strdup(val); }
        else if (strcmp(key, "opts") == 0)    { opts = _strdup(val); }
        else if (strcmp(key, "mode") == 0)    { mode = _strdup(val); }
        /* unknown keys are ignored (forward compatible) */
    }

    /* Belt-and-suspenders: a marker that reached the request path (e.g. an
       explicit argv reference) still routes to worker_main(). The normal
       scan path never delivers one here (pass 1 excludes markers). */
    if (mode && strcmp(mode, "worker") == 0) {
        remove(jobpath);   /* claimed: delete the marker */
        free(job);
        free(jobpath);
        return worker_main();
    }

    if (!headerSeen || !url || !done) {
        fprintf(stderr, "job file needs header + url + done\n");
        free(job);
        free(jobpath);
        return 2;
    }

    strs[0] = method;
    strs[1] = url;
    strs[2] = headers;
    strs[3] = "";
    strs[4] = opts;

    memset(args, 0, sizeof(args));
    for (i = 0; i < 5; i++) {
        args[i].type = kTypeString;
        args[i].data.string = (char*)strs[i];
        args[i].filler = 0;
    }
    memset(&retval, 0, sizeof(retval));

    if (eshttp_request(args, 5, &retval) != kESErrOK) {
        write_file_atomic(done, "{\"ok\":false,\"error\":\"eshttp_request returned non-OK\"}");
        rc = 1;
    } else if (retval.type != kTypeString || !retval.data.string) {
        write_file_atomic(done, "{\"ok\":false,\"error\":\"eshttp_request returned no envelope\"}");
        rc = 1;
    } else {
        rc = write_file_atomic(done, retval.data.string) ? 0 : 1;
        ESFreeMem(retval.data.string);
    }

    /* Claimed: remove the job file so the caller knows it was consumed. */
    remove(jobpath);
    free(job);
    free(jobpath);
    return rc;
}
