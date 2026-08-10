/*
 * load-core.mjs — shared core loader for the eshttp QA suite.
 * ============================================================================
 * Retarget layer (task T4): the suite under test is now the TypeScript core
 * produced by eshttp-build.mjs, loaded from ONE of three sources:
 *
 *   source "esm"   (default when dist/eshttp-core.esm.mjs exists)
 *       import() the ESM core bundle. The module references the ExtendScript
 *       globals (ExternalObject/Socket/$/app/File/Folder) as free variables,
 *       so they are staged on `globalThis` for the duration of the run (the
 *       old vm-sandbox approach only works for the IIFE text, not an ESM
 *       module). Returns the facade OBJECT — either the module's default
 *       export (preferred; mirrors `sandbox.eshttp` from the old harness) or
 *       the namespace itself when it already carries the facade members.
 *
 *   source "iife"  (when dist/eshttp.jsx exists and ESHTTP_CORE=iife)
 *       eval the built IIFE in a vm sandbox, exactly like the old jsxinc
 *       load — this is the verification lane for the shipping Illustrator
 *       artifact (global `eshttp` + public API contract).
 *
 *   source "jsxinc" (ESHTTP_CORE=jsxinc, or no dist yet)
 *       the ORIGINAL src/eshttp.jsxinc in a vm sandbox — the pre-rewrite
 *       baseline, kept so the suite still runs and parity is measurable.
 *
 * Both vm paths reuse the harness's ExtendScript global stubs (Socket over
 * real TCP via tcp-client.js, fake ExternalObject/eshttp DLL, File/Folder
 * shape stubs, `$`, `app`). The "esm" path stages the SAME stubs on
 * globalThis so the bundled code resolves them identically.
 *
 * Export surface contract (build-engineer/core-porter):
 *   - dist/eshttp-core.esm.mjs exports the facade object (default export) —
 *     request/get/post/put/del/json/configure/forceTransport/resetTransport/
 *     transportInfo/transport/DEFAULTS/error/version + test hooks
 *     (__noNetwork, helpers, _drivers, _setDriver, _selftest).
 *   - dist/eshttp.jsx defines the global `eshttp` (the facade) when evaled.
 *
 * Consumers: test/harness.js (CommonJS, dynamic import) and
 * test/parity/*.mjs (ESM import). QA infrastructure only — NOT part of the
 * eshttp library.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFakeCli } from './fake-cli.mjs';
import { makeFakeBridge } from './fake-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const DIST = path.join(ROOT, 'dist');
export const SRC_JSXINC = path.join(ROOT, 'src', 'eshttp.jsxinc');
export const DIST_ESM = path.join(DIST, 'eshttp-core.esm.mjs');
export const DIST_JSX = path.join(DIST, 'eshttp.jsx');
const TCP_CLIENT = path.join(HERE, 'tcp-client.js');

// ---------------------------------------------------------------------------
// 1. ExtendScript global stubs (shared by every source)
// ---------------------------------------------------------------------------

// Socket stub: synchronous TCP via test/tcp-client.js. The ES3 driver
// sequence is open() -> write(head) -> write(body) -> read() loop -> eof ->
// close(). Writes are buffered; the helper spawns at the first read(),
// sending the complete request in one connection — exactly one TCP
// connection per eshttp request, like the real host.
export function SocketStub() {
    this._pending = "";
    this._buffer = "";
    this._eof = false;
    this._host = "";
    this._port = 0;
    this._timeoutMs = 30000;
    this._spawned = false;
}
SocketStub.prototype.open = function (host, port, timeoutSec) {
    this._host = String(host);
    this._port = parseInt(port, 10) || 0;
    this._timeoutMs = Math.max(1000, (parseInt(timeoutSec, 10) || 30) * 1000);
    this._pending = "";
    this._buffer = "";
    this._eof = false;
    this._spawned = false;
    return true;
};
SocketStub.prototype.write = function (str) {
    this._pending += String(str);
};
SocketStub.prototype.read = function () {
    if (!this._spawned) { this._spawn(); }
    if (this._buffer.length === 0) { this._eof = true; return ""; }
    const chunk = this._buffer.slice(0, 65536);
    this._buffer = this._buffer.slice(65536);
    if (this._buffer.length === 0) { this._eof = true; }
    return chunk;
};
SocketStub.prototype.close = function () { /* helper already exited */ };
Object.defineProperty(SocketStub.prototype, "eof", {
    get: function () { return this._eof; },
    configurable: true
});
SocketStub.prototype._spawn = function () {
    this._spawned = true;
    const r = spawnSync(
        process.execPath,
        [TCP_CLIENT, this._host, String(this._port), String(this._timeoutMs)],
        {
            input: this._pending,
            encoding: "utf8",
            timeout: this._timeoutMs + 15000,
            maxBuffer: 128 * 1024 * 1024,
            windowsHide: true
        }
    );
    this._pending = "";
    this._buffer = "";
    if (r.status === 0 && r.stdout && r.stdout.indexOf("OK:") === 0) {
        this._buffer = Buffer.from(r.stdout.slice(3), "base64").toString("utf8");
    }
};

// File / Folder stubs (host-shape completeness). The embedded ESPAK accel
// bundles (ESON/ESB64) probe these during self-extraction; in the Node
// sandbox extraction must FAIL GRACEFULLY so the bundle falls back to its
// internal ES3 lane (coordinator decision v2, directive 5). The stubs are
// deliberately shape-complete but non-functional: `.exists` false, `.length`
// undefined, `.create()` true-but-noop, `getFiles` empty. The bundle's own
// try/catch turns the resulting extraction failure into ES3-lane fallback.
function FolderStub(p) { this.path = p || ""; }
// Real temp/desktop/script for host-shape probes the cli transport relies on
// (cliWorkDir resolves %TEMP%\opencode via Folder.temp.fsName). The accel
// bundles still degrade because File exists=false on the non-cli shape stub.
FolderStub.temp = { fsName: os.tmpdir() };
FolderStub.desktop = { fsName: path.join(os.homedir(), "Desktop") };
FolderStub.script = { fsName: HERE };
FolderStub.prototype.exists = false;
FolderStub.prototype.create = function () { return true; };
FolderStub.prototype.getFiles = function (pattern) { return []; };

function FileStub(p) { this.path = p || ""; this.encoding = "UTF-8"; }
FileStub.prototype.exists = false;
FileStub.prototype.name = "";
FileStub.prototype.length = undefined;
FileStub.prototype.open = function () { return true; };
FileStub.prototype.close = function () {};
FileStub.prototype.write = function () {};
FileStub.prototype.read = function () { return ""; };
FileStub.prototype.remove = function () { return true; };

// RealFileStub — REAL filesystem-backed File for the cli transport lane.
// The cli tier does actual job/done file I/O (wrapper writes ESHTTP_*.job to
// %TEMP%\opencode, the fake CLI claims it and writes the .done envelope, the
// wrapper polls the .done). The shape-only FileStub above cannot drive that
// lifecycle, so the cli lane swaps in this real-backed stub. `.execute()`
// drains the fake CLI synchronously (one job per call), mimicking
// eshttp-cli.exe's scan-and-claim mode.
function RealFileStub(p) {
    this.path = String(p || "");
    this.encoding = "UTF-8";
    this._fh = null;
    this._data = "";
    this._open = false;
}
Object.defineProperty(RealFileStub.prototype, "exists", {
    get: function () { return fs.existsSync(this.path); },
    configurable: true
});
Object.defineProperty(RealFileStub.prototype, "length", {
    get: function () { try { return fs.statSync(this.path).size; } catch (e) { return undefined; } },
    configurable: true
});
Object.defineProperty(RealFileStub.prototype, "fsName", {
    get: function () { return this.path; },
    configurable: true
});
Object.defineProperty(RealFileStub.prototype, "name", {
    get: function () { return path.basename(this.path); },
    configurable: true
});
Object.defineProperty(RealFileStub.prototype, "parent", {
    get: function () {
        const dir = path.dirname(this.path);
        const f = new RealFileStub(dir);
        return f;
    },
    configurable: true
});
RealFileStub.prototype.open = function (mode) {
    try {
        const m = String(mode || "r");
        if (m.indexOf("w") >= 0) {
            this._data = "";
            this._open = true;
            return true;
        }
        if (m.indexOf("r") >= 0) {
            this._data = fs.existsSync(this.path) ? fs.readFileSync(this.path, "utf8") : "";
            this._open = true;
            return true;
        }
        return false;
    } catch (e) { return false; }
};
RealFileStub.prototype.write = function (s) {
    if (!this._open) { return false; }
    this._data += String(s);
    return true;
};
RealFileStub.prototype.close = function () {
    if (this._open && this._data !== null && this._data !== undefined) {
        try { fs.writeFileSync(this.path, this._data, "utf8"); } catch (e) {}
    }
    this._open = false;
};
RealFileStub.prototype.read = function () { return this._data; };
RealFileStub.prototype.remove = function () {
    try { fs.unlinkSync(this.path); return true; } catch (e) { return false; }
};
RealFileStub.prototype.execute = function () {
    // Mimics eshttp-cli.exe's scan-and-claim. The pipe lane (T19) adds a
    // WORKER marker path: ESHTTP_worker_<id>.job (mode=worker) is claimed by
    // the worker-mode dispatch, not the oneshot scan. Route by job type:
    //   - worker marker -> fake bridge claims it (worker spawn + pid file)
    //   - normal ESHTTP_*.job -> fake CLI one-shot drain
    try {
        if (fakeBridge.claimWorkerMarker()) { return true; }
        return fakeCli.runOnce() !== null;
    } catch (e) { return false; }
};

// The shared fake bridge (test/fake-bridge.mjs) — the eshttp-ipc.dll pipe
// client fake for the T19 pipe lane. Lazy-imported on first use.
let fakeBridge = null;
function getFakeBridge() {
    if (!fakeBridge) { fakeBridge = makeFakeBridge(); }
    return fakeBridge;
}

// Bridge tier availability + the ExternalObject-shaped bridge ctor the
// driver's bridgeGet() resolves via `new ExternalObject("lib:eshttp-ipc")`.
let bridgeAvailable = false;
function bridgeCtor(lib) {
    this._lib = lib;
}
bridgeCtor.prototype.eshttp_pipe_request = function (op, payload, timeoutMs) {
    const b = getFakeBridge();
    return b.eshttp_pipe_request(op, payload, timeoutMs);
};
bridgeCtor.prototype.eshttp_pipe_version = function () { return "1.0.0"; };
bridgeCtor.prototype.eshttp_pipe_status = function () { return "ok"; };
bridgeCtor.prototype.eshttp_pipe_quit = function () {
    const b = getFakeBridge();
    b.eshttp_pipe_request("quit", "", 3000);
    return 1;
};

// The shared fake CLI instance (test/fake-cli.mjs) — drives the real job-file
// protocol headlessly. Lazy-imported on first cli use.
let fakeCli = null;
function getFakeCli() {
    if (!fakeCli) { fakeCli = makeFakeCli(); }
    return fakeCli;
}

// cli tier availability (mirrors the wrapper's findCliExe probe). When true,
// the global File is the REAL-file-backed stub so the job/done lifecycle
// works; when false, the shape-only FileStub is used.
let cliAvailable = false;
function activeFileStub() {
    return cliAvailable ? RealFileStub : FileStub;
}

// $ needs the probes the accel bundles and the cli transport call during
// startup: getenv returns REAL env vars (the cli transport resolves
// eshttp-cli.exe via $.getenv("LOCALAPPDATA")); the accel bundles still
// degrade to their ES3 lanes because the non-cli File/Folder stubs are shape-
// only (exists=false), so extraction aborts gracefully. hiresTimer is avoided
// via the bundles' own try/catch.
function makeDollar(osName) {
    return {
        writeln: function (s) { process.stdout.write("[$.writeln] " + String(s) + "\n"); },
        os: osName || "Windows",
        global: null,
        getenv: function (name) {
            try {
                if (name === "LOCALAPPDATA") { return process.env.LOCALAPPDATA || null; }
                if (name === "TEMP" || name === "TMP") { return process.env.TEMP || os.tmpdir(); }
                return process.env[String(name)] !== undefined ? process.env[String(name)] : null;
            } catch (e) { return null; }
        },
        hiresTimer: 0
    };
}

// ExternalObject stub — the fake native accelerator (eshttp.dll, renamed to
// eshttp per the coordinator's T5 decision). Drives the native transport lane
// without any real DLL: records calls and answers with envelopes per
// docs/native-abi.md §4.
//
// native-abi-v2 surface (T6/T7): the fake DLL mirrors the REAL eshttp.dll v2
// boundary — 4 business methods ONLY (eshttp_request + the three no-arg
// methods), eshttp_free REMOVED (the host frees kTypeString via ESFreeMem;
// v1 caller-frees was the double-free flaw). The no-arg methods accept the
// _f dummy-arg convention (the wrapper passes 0) and are tolerant of any
// extra args. `state.freeCalls` records any (nonexistent) free invocations so
// the 20-native-abi v2 regression can assert the wrapper NEVER calls a free.
export function makeExternalObjectStub() {
    const defaultResponder = function () {      // default: good envelope
        return {
            abi: "http-v1", ok: true, status: 200, statusText: "OK",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: "{\"ok\":true}", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: "GET", finalUrl: null, redirects: 0,
                    timeMs: 1, bytes: 10, httpVersion: "1.1", tlsVersion: "1.2",
                    encodingWasApplied: false, nativeVersion: "1.0.0",
                    winhttpError: null, backend: "winhttp" }
        };
    };
    const state = {
        calls: [],                    // { method, url, headersJson, body, optsJson }
        freeCalls: 0,                 // v2: must stay 0 (no eshttp_free export)
        hasFreeExport: false,         // v2: eshttp_free REMOVED from the export set
        responder: defaultResponder
    };

    function ExternalObjectCtor(lib) { this._lib = lib; }
    // v2 no-arg methods are declared _f in ESInitialize — the wrapper passes
    // a dummy 0; the stub tolerates any args (extra JS args are ignored).
    ExternalObjectCtor.prototype.eshttp_version = function () { return "1.0.0"; };
    ExternalObjectCtor.prototype.eshttp_available = function () { return 1; };
    ExternalObjectCtor.prototype.eshttp_last_error = function () { return ""; };
    // NOTE: no eshttp_free prototype — the v2 DLL has no such export. If the
    // wrapper ever calls accel.eshttp_free it throws TypeError, which the
    // wrapper must treat as "DLL unusable -> dead" (it currently does not call
    // it at all, per the double-free fix).
    ExternalObjectCtor.prototype.eshttp_request = function (method, url, headersJson, body, optsJson) {
        state.calls.push({ method: method, url: url, headersJson: headersJson, body: body, optsJson: optsJson });
        const res = state.responder(method, url, headersJson, body, optsJson);
        if (res && res.__throw) { throw new Error(String(res.__throw)); }
        if (res && res.__returnNull) { return "null"; }
        if (res && res.__rawString) { return String(res.__rawString); }
        return JSON.stringify(res || { abi: "http-v1", ok: true, status: 200, statusText: "OK",
            headers: {}, body: "", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: method, finalUrl: url, redirects: 0, timeMs: 1,
                    bytes: 0, httpVersion: "1.1", tlsVersion: "1.2",
                    encodingWasApplied: false, nativeVersion: "1.0.0",
                    winhttpError: null, backend: "winhttp" } });
    };
    return { ctor: ExternalObjectCtor, state: state, defaultResponder: defaultResponder };
}

// ---------------------------------------------------------------------------
// 2. Sandbox construction (vm paths: iife + jsxinc)
// ---------------------------------------------------------------------------
export function createSandbox(externalObjectState) {
    const sandbox = {};
    sandbox.$ = makeDollar("Windows");
    sandbox.Socket = SocketStub;
    sandbox.ExternalObject = externalObjectState.ctor;
    sandbox.File = activeFileStub();
    sandbox.Folder = FolderStub;
    sandbox.app = { name: "QA Headless" };
    sandbox.console = {
        log: function () {}, warn: function () {}, error: function () {},
        info: function () {}
    };
    sandbox.$.global = sandbox;
    return vm.createContext(sandbox);
}

// ---------------------------------------------------------------------------
// 3. Source selection
// ---------------------------------------------------------------------------
export function resolveSource(override) {
    if (override) { return override; }
    if (fs.existsSync(DIST_ESM)) { return "esm"; }
    if (fs.existsSync(DIST_JSX)) { return "iife"; }
    return "jsxinc";
}

// ---------------------------------------------------------------------------
// 4. Core loaders
// ---------------------------------------------------------------------------
function loadJsxinc(sandbox, file, filename) {
    const src = fs.readFileSync(file, "utf8");
    vm.runInContext(src, sandbox, { filename: filename });
    return sandbox.eshttp;
}

async function loadEsm(extStub) {
    // Stage the ExtendScript globals on globalThis so the bundled code
    // resolves ExternalObject/Socket/$/app/File/Folder as free variables,
    // exactly as it would on the real host. Saved/restored by the caller.
    globalThis.ExternalObject = extStub.ctor;
    globalThis.Socket = SocketStub;
    globalThis.File = activeFileStub();
    globalThis.Folder = FolderStub;
    globalThis.app = { name: "QA Headless" };
    if (typeof globalThis.$ === "undefined" || globalThis.$ === null) {
        globalThis.$ = makeDollar("Windows");
    }
    globalThis.$.os = globalThis.$.os || "Windows";
    if (typeof globalThis.$.getenv !== "function") {
        globalThis.$.getenv = function (name) {
            try {
                if (name === "LOCALAPPDATA") { return process.env.LOCALAPPDATA || null; }
                if (name === "TEMP" || name === "TMP") { return process.env.TEMP || os.tmpdir(); }
                return process.env[String(name)] !== undefined ? process.env[String(name)] : null;
            } catch (e) { return null; }
        };
    }
    if (typeof globalThis.console === "undefined") {
        globalThis.console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };
    }
    const mod = await import(pathToFileURL(DIST_ESM).href + "?t=" + Date.now());
    // Prefer the default-export facade (mirrors sandbox.eshttp); fall back to
    // the namespace itself when it already carries the facade members.
    if (mod && typeof mod.default === "object" && mod.default !== null && typeof mod.default.request === "function") {
        return mod.default;
    }
    if (mod && typeof mod.request === "function") {
        return mod;
    }
    throw new Error("dist/eshttp-core.esm.mjs does not expose the eshttp facade " +
        "(no default-export object with .request, no namespace .request). Exports: " +
        Object.keys(mod || {}).join(","));
}

// ---------------------------------------------------------------------------
// 5. Public entry
// ---------------------------------------------------------------------------
// loadCore({ source?, extStub? }) -> { eshttp, controls, source, file }
//   controls.setExternalObjectAvailable(yes) — toggle the ExternalObject
//     global (vm sandbox property for vm paths, globalThis for esm).
//   controls.setSocketAvailable(yes)         — same for Socket.
//   controls.nativeState / setNativeResponder — fake-DLL call recording.
export async function loadCore(opts) {
    const override = opts && opts.source;
    const source = resolveSource(override);
    const extStub = (opts && opts.extStub) || makeExternalObjectStub();
    const cli = getFakeCli();
    const bridge = getFakeBridge();
    const controls = {
        nativeState: extStub.state,
        setNativeResponder: function (fn) {
            // Restoring the DEFAULT responder on null (NOT null itself): a
            // null responder makes the stub's eshttp_request call null(...)
            // -> TypeError -> the driver marks native dead, which leaks into
            // later suites. Tests that "clear" the responder with null get
            // the healthy default envelope instead.
            extStub.state.responder = (fn === null || fn === undefined) ? extStub.defaultResponder : fn;
        },
        cliState: cli.state,
        setCliResponder: function (fn) { cli.state.responder = fn; },
        bridgeState: bridge.state,
        setBridgeResponder: function (fn) { bridge.state.responder = fn; },
        clearWorkerPid: function () { bridge.clearPid(); },
        setBridgeAvailable: function (yes) {
            // Stage (or unstage) the fake eshttp-ipc.dll bridge as the
            // ExternalObject for the T19 pipe lane. The driver's bridgeGet()
            // does `new ExternalObject("lib:eshttp-ipc")` and requires
            // `eshttp_pipe_request` — the fake bridge ctor provides it. When
            // the bridge is unavailable (ExternalObject missing / not a
            // function), the driver marks the pipe dead and degrades to the
            // oneshot lane. The pipe lane also needs the real-file File stub
            // (pid file + result files), so this also flips cliAvailable.
            bridgeAvailable = yes;
            cliAvailable = yes;
            const ctor = yes ? bridgeCtor : extStub.ctor;
            if (source === "esm") {
                globalThis.ExternalObject = ctor;
                globalThis.File = activeFileStub();
            } else if (sandboxRef) {
                sandboxRef.ExternalObject = ctor;
                sandboxRef.File = activeFileStub();
            }
        },
        setCliAvailable: function (yes) {
            // Stage (or unstage) the fake eshttp-cli.exe at findCliExe()'s
            // FIRST candidate (%LOCALAPPDATA%\eshttp\eshttp-cli.exe), so the
            // wrapper's File.exists probe resolves it naturally and the cli
            // tier exercises the REAL resolution order + real job-file IPC.
            // The path is ALSO the T10 production staging target (the real
            // eshttp-cli.exe, staged by eshttp-build.mjs), so the fake
            // backup/restores whatever real artifact is present: on stage,
            // move any existing binary aside to <dest>.harness-bak before
            // writing the shim; on unstage, delete the shim and restore the
            // backup. This keeps npm test non-destructive to the staged
            // runtime artifact (build-engineer T10, build-contract v7).
            const dest = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "eshttp", "eshttp-cli.exe");
            const bak = dest + ".harness-bak";
            if (yes) {
                try {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    if (!fs.existsSync(bak) && fs.existsSync(dest)) {
                        fs.copyFileSync(dest, bak);
                        fs.unlinkSync(dest);
                    }
                    if (!fs.existsSync(dest)) {
                        fs.writeFileSync(dest, "#!/usr/bin/env node\n// fake eshttp-cli.exe shim (T11 harness)\n", "utf8");
                    }
                } catch (e) { /* probe will just fail -> tier unavailable */ }
            } else {
                try {
                    if (fs.existsSync(dest)) { fs.unlinkSync(dest); }
                    if (fs.existsSync(bak)) { fs.renameSync(bak, dest); }
                } catch (e) {}
            }
            cliAvailable = yes;
            // Refresh the staged File global (vm sandbox property vs globalThis)
            // so the job/done lifecycle uses the real-file stub when active.
            if (source === "esm") { globalThis.File = activeFileStub(); }
            else if (sandboxRef) { sandboxRef.File = activeFileStub(); }
        },
        setExternalObjectAvailable: function (yes) {
            if (source === "esm") { globalThis.ExternalObject = yes ? extStub.ctor : undefined; }
            else { sandboxRef.ExternalObject = yes ? extStub.ctor : undefined; }
        },
        resetNativeCache: function () {
            // Force a clean native probe for the next request: re-stage the
            // native ExternalObject ctor and reset transport state. The
            // driver's probeNative caches availability/dead on the session
            // global; a tamper-death from a prior suite must not persist.
            if (source === "esm") { globalThis.ExternalObject = extStub.ctor; }
            else if (sandboxRef) { sandboxRef.ExternalObject = extStub.ctor; }
            // Clear the session-global native cache the driver persists
            // (sessionGlobal() = $.global in hosts, `global`/globalThis in
            // Node ESM — clear both the staged $ and globalThis).
            try {
                const g = typeof globalThis.$ !== "undefined" && globalThis.$ && globalThis.$.global
                    ? globalThis.$.global : null;
                if (g) { delete g.__eshttp_native_v1; }
            } catch (e) {}
            try { delete globalThis.__eshttp_native_v1; } catch (e) {}
        },
        setSocketAvailable: function (yes) {
            if (source === "esm") { globalThis.Socket = yes ? SocketStub : undefined; }
            else { sandboxRef.Socket = yes ? SocketStub : undefined; }
        }
    };
    let sandboxRef = null;

    if (source === "esm") {
        const eshttp = await loadEsm(extStub);
        return { eshttp: eshttp, controls: controls, source: source, file: DIST_ESM, cleanup: restoreGlobals };
    }
    if (source === "iife") {
        sandboxRef = createSandbox(extStub);
        const eshttp = loadJsxinc(sandboxRef, DIST_JSX, "eshttp.jsx");
        return { eshttp: eshttp, controls: controls, source: source, file: DIST_JSX, sandbox: sandboxRef };
    }
    sandboxRef = createSandbox(extStub);
    const eshttp = loadJsxinc(sandboxRef, SRC_JSXINC, "eshttp.jsxinc");
    return { eshttp: eshttp, controls: controls, source: source, file: SRC_JSXINC, sandbox: sandboxRef };
}

// Save prior globalThis values for the staged globals, so the esm path can
// restore them when the run ends. Called once at first esm load.
const SAVED_GLOBALS = {};
let savedGlobalsOnce = false;
function saveGlobals() {
    if (savedGlobalsOnce) { return; }
    savedGlobalsOnce = true;
    for (const k of ["ExternalObject", "Socket", "File", "Folder", "app", "$", "console"]) {
        SAVED_GLOBALS[k] = globalThis[k];
    }
}
function restoreGlobals() {
    for (const k of Object.keys(SAVED_GLOBALS)) {
        globalThis[k] = SAVED_GLOBALS[k];
    }
}
// Hook saveGlobals before the first esm load so cleanup can restore.
{
    const origLoadEsm = loadEsm;
    loadEsm = async function (extStub) {
        saveGlobals();
        return origLoadEsm(extStub);
    };
}
