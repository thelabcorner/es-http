/* dll-smoke.c — load eshttp2-x64.dll dynamically and exercise the canonical
 * direct-interface ABI (native-abi v2): 4 ES* + 4 business exports, all
 * driven with the documented `long fn(TaggedData*, long, TaggedData*)`
 * shape (SoSharedLibDefs.h ESFunction).
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

/* --- canonical ABI (mirror of eshttp.h / SoSharedLibDefs.h) --- */
typedef struct TaggedData TaggedData;
struct TaggedData {
    union {
        long intval;
        double fltval;
        char* string;
        void* hObject;
    } data;
    long type;
    long filler;
};
#define kTypeUndefined 0
#define kTypeDouble    3
#define kTypeString    4
#define kTypeInteger   123
#define kESErrOK       0
#define kESErrBadArgumentList 20

typedef char*  (*es_init_fn)(TaggedData*, long);
typedef long   (*es_getver_fn)(void);
typedef void   (*es_freemem_fn)(void*);
typedef void   (*es_terminate_fn)(void);
typedef long   (*es_http_fn)(TaggedData*, long, TaggedData*);

static const char* tag_name(long t) {
    switch (t) {
        case kTypeUndefined: return "undefined(0)";
        case kTypeDouble:    return "double(3)";
        case kTypeString:    return "string(4)";
        case kTypeInteger:   return "integer(123)";
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

    /* eshttp_version(0) -> kTypeString */
    {
        TaggedData argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = kTypeDouble; argv[0].data.fltval = 0.0;
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_version(argv, 1, &retval);
        printf("version(0): rc=%ld type=%s value=%s\n", rc, tag_name(retval.type),
               retval.type == kTypeString ? (retval.data.string ? retval.data.string : "(null)") : "-");
        if (retval.type == kTypeString) { ESFreeMem(retval.data.string); }
    }

    /* eshttp_available(0) -> kTypeInteger 1/0 */
    {
        TaggedData argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = kTypeDouble; argv[0].data.fltval = 0.0;
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_available(argv, 1, &retval);
        printf("available(0): rc=%ld type=%s value=%ld\n", rc, tag_name(retval.type), retval.data.intval);
    }

    /* eshttp_request(m,u,h,b,o) -> kTypeString envelope */
    {
        TaggedData argv[5], retval;
        const char* strs[5] = { "GET", "ftp://example.com/", "{}", "", "{}" };
        int i;
        memset(argv, 0, sizeof(argv));
        for (i = 0; i < 5; i++) {
            argv[i].type = kTypeString;
            argv[i].data.string = (char*)strs[i];
        }
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_request(argv, 5, &retval);
        printf("request(ftp) rc=%ld type=%s\n", rc, tag_name(retval.type));
        if (retval.type == kTypeString) {
            printf("  env=%s\n", retval.data.string ? retval.data.string : "(null)");
            ESFreeMem(retval.data.string);
        }
    }

    /* failure path: transport error (connect refused) -> envelope */
    {
        TaggedData argv[5], retval;
        const char* strs[5] = { "GET", "http://127.0.0.1:9/x", "{}", "",
                                "{\"proxy\":\"direct\",\"timeoutMs\":5000}" };
        int i;
        memset(argv, 0, sizeof(argv));
        for (i = 0; i < 5; i++) {
            argv[i].type = kTypeString;
            argv[i].data.string = (char*)strs[i];
        }
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_request(argv, 5, &retval);
        printf("request(refused) rc=%ld type=%s\n", rc, tag_name(retval.type));
        if (retval.type == kTypeString) {
            const char* e = retval.data.string ? retval.data.string : "";
            printf("  has-error-code=%s\n", strstr(e, "\"code\":\"connect\"") ? "yes" : "no");
            ESFreeMem(retval.data.string);
        }
    }

    /* bad arg count -> catchable kESErrBadArgumentList, never negative */
    {
        TaggedData argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = kTypeString; argv[0].data.string = (char*)"GET";
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_request(argv, 1, &retval);
        printf("request(1 arg) rc=%ld (expect %d)\n", rc, kESErrBadArgumentList);
    }

    /* last_error(0) -> kTypeString (malloc'd copy) */
    {
        TaggedData argv[1], retval;
        memset(argv, 0, sizeof(argv));
        argv[0].type = kTypeDouble; argv[0].data.fltval = 0.0;
        memset(&retval, 0, sizeof(retval));
        long rc = eshttp_last_error(argv, 1, &retval);
        printf("last_error(0): rc=%ld type=%s len=%lu\n", rc, tag_name(retval.type),
               retval.type == kTypeString ? (unsigned long)strlen(retval.data.string ? retval.data.string : "") : 0UL);
        if (retval.type == kTypeString) { ESFreeMem(retval.data.string); }
    }

    ESTerminate();
    FreeLibrary(h);
    printf("DLL-SMOKE OK\n");
    return 0;
}
