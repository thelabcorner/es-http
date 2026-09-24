/* dll-smoke.c — load eshttp2-x64.dll dynamically and exercise the canonical
 * direct-interface ABI (native-abi v2): 4 ES* + 4 business exports, all
 * driven with the pinned ESABI v0.3.0 direct-function shape.
 * Temp verification tool (not part of deliverables).
 *
 * Build (x64, MSVC):
 *   cl /nologo /TC /MT /O2 dll-smoke.c /Fe:dll-smoke.exe
 * Run: dll-smoke.exe
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <esabi/esabi.h>

typedef char* (ESABI_CALL *es_init_fn)(esabi_value*, esabi_long);
typedef esabi_long (ESABI_CALL *es_getver_fn)(void);
typedef void (ESABI_CALL *es_freemem_fn)(void*);
typedef void (ESABI_CALL *es_terminate_fn)(void);
typedef esabi_error (ESABI_CALL *es_http_fn)(esabi_value*, esabi_long, esabi_value*);

static const char* tag_name(long t) {
    switch (t) {
        case ESABI_TYPE_UNDEFINED: return "undefined(0)";
        case ESABI_TYPE_DOUBLE:    return "double(3)";
        case ESABI_TYPE_STRING:    return "string(4)";
        case ESABI_TYPE_INTEGER:   return "integer(123)";
        default: { static char b[32]; snprintf(b, sizeof(b), "tag(%ld)", t); return b; }
    }
}

int main(void) {
    HMODULE h = LoadLibraryA("eshttp2-x64.dll");
    if (!h) { printf("LoadLibrary(eshttp2-x64.dll) failed: %lu\n", (unsigned long)GetLastError()); return 1; }

    es_init_fn     ESInitialize = (es_init_fn)GetProcAddress(h, "ESInitialize");
    es_getver_fn   ESGetVersion = (es_getver_fn)GetProcAddress(h, "ESGetVersion");
    es_freemem_fn  ESFreeMem    = (es_freemem_fn)GetProcAddress(h, "ESFreeMem");
    es_terminate_fn ESTerminate = (es_terminate_fn)GetProcAddress(h, "ESTerminate");
    es_http_fn     eshttp_request   = (es_http_fn)GetProcAddress(h, "eshttp_request");
    es_http_fn     eshttp_version   = (es_http_fn)GetProcAddress(h, "eshttp_version");
    es_http_fn     eshttp_last_error = (es_http_fn)GetProcAddress(h, "eshttp_last_error");
    es_http_fn     eshttp_available = (es_http_fn)GetProcAddress(h, "eshttp_available");
    if (!ESInitialize || !ESGetVersion || !ESFreeMem || !ESTerminate ||
        !eshttp_request || !eshttp_version || !eshttp_last_error || !eshttp_available) {
        printf("missing export\n");
        return 1;
    }
    if (GetProcAddress(h, "eshttp_free")) { printf("ERROR: eshttp_free still exported (v2 removes it)\n"); return 1; }
    printf("version=%ld\n", ESGetVersion());

    char* sig = ESInitialize(NULL, 0);
    printf("ESInitialize=%s\n", sig ? sig : "(null)");
    if (sig) { ESFreeMem(sig); }

    /* eshttp_version(0) -> ESABI_TYPE_STRING */
    {
        esabi_value argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = ESABI_TYPE_DOUBLE; argv[0].payload.double_value = 0.0;
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_version(argv, 1, &retval);
        printf("version(0): rc=%ld type=%s value=%s\n", rc, tag_name(retval.type),
               retval.type == ESABI_TYPE_STRING ? (retval.payload.string_value ? retval.payload.string_value : "(null)") : "-");
        if (retval.type == ESABI_TYPE_STRING) { ESFreeMem(retval.payload.string_value); }
    }

    /* eshttp_available(0) -> ESABI_TYPE_INTEGER 1/0 */
    {
        esabi_value argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = ESABI_TYPE_DOUBLE; argv[0].payload.double_value = 0.0;
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_available(argv, 1, &retval);
        printf("available(0): rc=%ld type=%s value=%ld\n", rc, tag_name(retval.type), retval.payload.signed_value);
    }

    /* eshttp_request(m,u,h,b,o) -> ESABI_TYPE_STRING envelope */
    {
        esabi_value argv[5], retval;
        const char* strs[5] = { "GET", "ftp://example.com/", "{}", "", "{}" };
        int i;
        memset(argv, 0, sizeof(argv));
        for (i = 0; i < 5; i++) {
            argv[i].type = ESABI_TYPE_STRING;
            argv[i].payload.string_value = (char*)strs[i];
        }
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_request(argv, 5, &retval);
        printf("request(ftp) rc=%ld type=%s\n", rc, tag_name(retval.type));
        if (retval.type == ESABI_TYPE_STRING) {
            printf("  env=%s\n", retval.payload.string_value ? retval.payload.string_value : "(null)");
            ESFreeMem(retval.payload.string_value);
        }
    }

    /* failure path: transport error (connect refused) -> envelope */
    {
        esabi_value argv[5], retval;
        const char* strs[5] = { "GET", "http://127.0.0.1:9/x", "{}", "",
                                "{\"proxy\":\"direct\",\"timeoutMs\":5000}" };
        int i;
        memset(argv, 0, sizeof(argv));
        for (i = 0; i < 5; i++) {
            argv[i].type = ESABI_TYPE_STRING;
            argv[i].payload.string_value = (char*)strs[i];
        }
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_request(argv, 5, &retval);
        printf("request(refused) rc=%ld type=%s\n", rc, tag_name(retval.type));
        if (retval.type == ESABI_TYPE_STRING) {
            const char* e = retval.payload.string_value ? retval.payload.string_value : "";
            printf("  has-error-code=%s\n", strstr(e, "\"code\":\"connect\"") ? "yes" : "no");
            ESFreeMem(retval.payload.string_value);
        }
    }

    /* bad arg count -> catchable ESABI_ERR_BAD_ARGUMENTS, never negative */
    {
        esabi_value argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = ESABI_TYPE_STRING; argv[0].payload.string_value = (char*)"GET";
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_request(argv, 1, &retval);
        printf("request(1 arg) rc=%ld (expect %d)\n", rc, ESABI_ERR_BAD_ARGUMENTS);
    }

    /* last_error(0) -> ESABI_TYPE_STRING (malloc'd copy) */
    {
        esabi_value argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = ESABI_TYPE_DOUBLE; argv[0].payload.double_value = 0.0;
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_last_error(argv, 1, &retval);
        printf("last_error(0): rc=%ld type=%s len=%lu\n", rc, tag_name(retval.type),
               retval.type == ESABI_TYPE_STRING ? (unsigned long)strlen(retval.payload.string_value ? retval.payload.string_value : "") : 0UL);
        if (retval.type == ESABI_TYPE_STRING) { ESFreeMem(retval.payload.string_value); }
    }

    ESTerminate();
    FreeLibrary(h);
    printf("DLL-SMOKE OK\n");
    return 0;
}
