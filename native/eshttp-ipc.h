/* eshttp-ipc.h - shared IPC protocol between the eshttp IPC bridge DLL
   (eshttp-ipc.dll, ExternalObject in-process in the Adobe host; see T18) and
   the persistent eshttp worker EXE (eshttp-cli.exe --worker, out-of-process).

   Design constraints (adapted from the proven ArcFit template
   arcfit/native/arcfit-ipc.h, per coordinator decision msg_6c49bd79b4ec4b6c9fae7a5b8ca6c68b;
   the externalobject-extendscript SKILL.md "staged bridge pattern" L414-447 and
   "Load from JSX" L367-413):
     - The DLL is a pure pipe client: connect/write/read/classify only.
       No HTTP, WinHTTP, or networking ever runs inside the Adobe host.
     - Every request carries protocol magic, operation, invocation id
       (requestId), max sizes, and a hard timeout.
     - The worker consumes each request exactly once (single-instance,
       message-mode pipe, one request per accepted connection).
     - Version incompatibility fails the handshake before any operation.
     - Responses are bounded, line-based key=value UTF-8 text, LF-separated.
     - Payloads are single-line text (no CR/LF/NUL); large request bodies
       stay in files and travel by path (jobFile=), not through the pipe
       (skill: multi-MB strings across the boundary are unsafe - L193-195).

   Both sides must be rebuilt from this single header; do not fork values. */

#ifndef ESHTTP_IPC_H
#define ESHTTP_IPC_H

/* ---- Pipe identity ---- */
/* Fixed well-known name. The worker holds the single instance for its whole
   lifetime, so the pipe never disappears while the worker is alive. The
   default kernel-object DACL restricts access to the creator account. */
#define ESHTTP_IPC_PIPE_NAME "\\\\.\\pipe\\EshttpBridge"
#define ESHTTP_IPC_PIPE_NAME_W L"\\\\.\\pipe\\EshttpBridge"
/* Loopback selftest pipe (worker --selftest spins its own client against it) */
#define ESHTTP_IPC_PIPE_SELFTEST "\\\\.\\pipe\\EshttpBridgeSelftest"

/* ---- Protocol identity ---- */
#define ESHTTP_IPC_PROTO_MAJOR 1
#define ESHTTP_IPC_PROTO_MINOR 0
#define ESHTTP_IPC_DLL_ABI 1          /* DLL surface (entry points, tags) */
#define ESHTTP_IPC_WORKER_ABI 1       /* worker behavior contract */
/* Stamped by the build (short release id); override with /D. Pairs a worker
   with the DLL build that understands it. Not a secret. */
#ifndef ESHTTP_IPC_BUILD_ID
#define ESHTTP_IPC_BUILD_ID "00000000000000000000000000000000"
#endif

/* ---- Wire messages ---- */
#define ESHTTP_IPC_REQ_MAGIC "EshttpIpcReq_1"
#define ESHTTP_IPC_RESP_MAGIC "EshttpIpcResp_1"

/* ---- Sizes (bytes) ---- */
#define ESHTTP_IPC_OP_MAX 48          /* op names are short ASCII tokens */
#define ESHTTP_IPC_PAYLOAD_MAX 4096   /* single-line bounded payload */
#define ESHTTP_IPC_REQ_MAX (1024 + ESHTTP_IPC_PAYLOAD_MAX)
#define ESHTTP_IPC_RESP_MAX 16384     /* worker response message cap */
#define ESHTTP_IPC_REPORT_MAX 8192    /* DLL->JSX normalized report cap */

/* ---- Timeouts (ms) ---- */
#define ESHTTP_IPC_TIMEOUT_DEFAULT_MS 3000
#define ESHTTP_IPC_TIMEOUT_MIN_MS 50
#define ESHTTP_IPC_TIMEOUT_MAX_MS 120000
#define ESHTTP_IPC_WAITNAMED_MS 200   /* single WaitNamedPipeA wait */
#define ESHTTP_IPC_RETRY_SLEEP_MS 10  /* startup retry pause */
#define ESHTTP_IPC_CONNECT_BUDGET_MS 1500 /* max wait for the worker to exist */
/* Worker lifecycle: idle timeout before self-exit (default; override with
   --idle-ms <n> or ESHTTP_WORKER_IDLE_MS env). */
#define ESHTTP_IPC_IDLE_DEFAULT_MS 120000
#define ESHTTP_IPC_IDLE_MIN_MS 5000

/* ---- Operations ---- */
#define ESHTTP_IPC_OP_PING "ping"
#define ESHTTP_IPC_OP_STATUS "status"
#define ESHTTP_IPC_OP_VERSION "version"
#define ESHTTP_IPC_OP_QUIT "quit"
#define ESHTTP_IPC_OP_ECHO "echo"
/* Real engine work: the payload is the http-v1 request envelope in the
   ESHTTP_CLI_1 job-file key=value form (method/url/headers/opts), OR a
   `jobFile=<path>` reference for large payloads. The worker claims it and
   runs the standard v2 engine; the response envelope is the payload. */
#define ESHTTP_IPC_OP_REQUEST "request"
/* Adversarial test operations. Recognized ONLY when launched with --test or
   ESHTTP_IPC_TEST_OPS=1; otherwise they answer unknown-op so a production
   worker never exposes hang/crash behavior to arbitrary local callers. */
#define ESHTTP_IPC_OP_CRASH_AFTER_ACCEPT "crashAfterAccept"
#define ESHTTP_IPC_OP_HANG "hang"
#define ESHTTP_IPC_OP_SLOW "slow"
#define ESHTTP_IPC_OP_OVERSIZE "oversize"
#define ESHTTP_IPC_OP_PARTIAL "partial"
#define ESHTTP_IPC_OP_GARBAGE "garbage"
#define ESHTTP_IPC_OP_BAD_VERSION "badVersion"

/* ---- Error classes (DLL-side classification, ASCII, no spaces) ---- */
#define ESHTTP_IPC_EC_OK "ok"
#define ESHTTP_IPC_EC_WORKER_UNAVAILABLE "worker-unavailable"
#define ESHTTP_IPC_EC_PIPE_BUSY "pipe-busy"
#define ESHTTP_IPC_EC_CONNECT_DENIED "connect-denied"
#define ESHTTP_IPC_EC_TIMEOUT "timeout"
#define ESHTTP_IPC_EC_WORKER_CRASH "worker-crash"
#define ESHTTP_IPC_EC_RESPONSE_OVERSIZE "response-oversize"
#define ESHTTP_IPC_EC_RESPONSE_INVALID "response-invalid"
#define ESHTTP_IPC_EC_VERSION_MISMATCH "version-mismatch"
#define ESHTTP_IPC_EC_REQUEST_OVERSIZE "request-oversize"
#define ESHTTP_IPC_EC_REQUEST_INVALID "request-invalid"
#define ESHTTP_IPC_EC_BUSY "busy"
#define ESHTTP_IPC_EC_INTERNAL "internal"
/* Worker-side class for a handled operation that failed (request executed
   but returned an error envelope): success=0 + errClass=worker-error + the
   http-v1 envelope as the payload. */
#define ESHTTP_IPC_EC_WORKER_ERROR "worker-error"
/* Worker-side class for unrecognized operations (echoed through the DLL
   report verbatim on success=0 responses). */
#define ESHTTP_IPC_EC_UNKNOWN_OP "unknown-op"

#endif /* ESHTTP_IPC_H */
