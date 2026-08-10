// ESHTTP cli driver — eshttp-cli.exe job-file transport (driver-cli.ts).
//
// native-abi-v2 addendum (T6 contract + T9 wiring, coordinator-ratified):
// the FIREWALL-ESCAPE lane. eshttp-cli.exe is a static-link build of the SAME
// v2 eshttp.c engine (native/eshttp-cli.c) run as a SEPARATE process, so it
// can reach the network even when the host's firewall blocks Illustrator.exe
// outbound (the per-app rule matches the host process image only). It is the
// https-capable fallback when the native DLL is dead/unavailable.
//
// IPC PROTOCOL (mirrors ArcFit's one-shot EXE job-file path; native/eshttp-cli.c
// main() + the coordinator's live microprototype):
//   job file  = %TEMP%\opencode\ESHTTP_<id>.job, text:
//                 ESHTTP_CLI_1                (header, first line)
//                 method=GET
//                 url=...
//                 done=<absolute .done path>
//                 headers={json}              (optional)
//                 opts={json}                 (optional)
//   spawn     = File.execute() on the EXE with NO argv -> the EXE scans
//               %TEMP% + %TEMP%\opencode for ESHTTP_*.job, claims the NEWEST
//               by mtime (exclusive read), processes it, DELETES the job.
//   done file = the http-v1 JSON envelope (identical schema to the DLL).
//
// LIMITS (v1 of the CLI, eshttp-cli.c:184-188): the job protocol has NO body
// key — the CLI hardcodes the request body to "". So the cli tier is
// GET/HEAD-only; a non-empty body (or bodyIsBase64) returns "unsupported"
// (usage) rather than silently dropping bytes. T10 may harden the CLI with a
// body key; the wrapper-side change would be confined to this file.
//
// Degradation: exe missing -> tier unavailable (auto skips, forceTransport
// 'cli' -> 'none'); .done missing at timeout -> 'timeout'; unparseable or
// ABI-mismatched envelope -> cli marked dead for the session (same model as
// native). NEVER throws — every failure is an error Result.
//
// Host globals (File, Folder, $) are typeof-guarded at CALL time only.
import { now, errStr } from './utils';
import { mkError } from './errors';
import { jsonEncode, jsonParseStrict } from './vendor-json';
import { headersToJsonObject } from './headers';
import { envelopeToResult } from './driver-native';
import { RequestContext, Result, EshttpError } from './types';
import { _ABI, noNetwork } from './state';

/** Session-cached cli availability (exe found once, dead-marked once). */
var _cliExe: any = null;       // cached File handle, or null
var _cliProbed = false;        // exe lookup done (avoids repeat fs probes)
var _cliDead = false;          // session-dead after a bad envelope/timout-less run

var _CLI_SCAN_DIR = "";        // resolved once: %TEMP%\opencode

// --- T19 pipe-lane state (named-pipe persistent worker, primary) -----------
var _bridge: any = null;       // ExternalObject eshttp-ipc bridge, or null
var _bridgeProbed = false;     // bridge load attempted
var _workerSpawned = false;    // worker marker written + File.execute fired this session
var _workerPidOk = false;      // pid file observed alive
var _pipeDead = false;         // pipe lane degraded (bridge/worker failure) for the session

/** Bridge load specifier — lib:eshttp-ipc (T18 contract; numbered dev name
 *  eshttp-ipc2 was the live-iteration convention only, per skill L551-554). */
var _BRIDGE_LIB = "lib:eshttp-ipc";
var _BRIDGE_PROTO = "ESHTTP_IPC_1";

/** Default done-poll interval (ms) — chunked $.sleep, never a tight spin. */
var _CLI_POLL_MS = 200;

/**
 * Strip trailing '/' and '\' from a path WITHOUT a regex — the
 * /[\\/]+$/ character-class shape mis-parses in the ES3 lexer (skill §11,
 * live-verified 2026-08-10 on Illustrator 30.6: "Expected: )" at the regex).
 * Node/V8 accept it; ExtendScript does not.
 */
function stripTrailingSlashes(p: string): string {
  var s = String(p);
  while (s.length > 0 &&
         (s.charAt(s.length - 1) === "/" || s.charAt(s.length - 1) === "\\")) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Work-dir + exe resolution (ArcFit convention: per-user runtime root, never
// the read-only Scripts folder)
// ---------------------------------------------------------------------------

/** Resolve the cli work dir (%TEMP%\opencode, the CLI's scan dir). */
function cliWorkDir(): any {
  if (_CLI_SCAN_DIR) { return new File(_CLI_SCAN_DIR + "/."); }  // probe only
  var dir: string = "";
  try {
    var tmp = Folder.temp;
    if (tmp && tmp.fsName) { dir = stripTrailingSlashes(tmp.fsName) + "/opencode"; }
  } catch (e) {
    dir = "";
  }
  if (!dir) { dir = "%TEMP%/opencode"; } // last-resort; unlikely
  _CLI_SCAN_DIR = dir;
  var f = new File(dir + "/.");
  return f;
}

/**
 * Resolve eshttp-cli.exe. Order (ArcFit-style per-user runtime root first —
 * the Scripts folder is read-only at runtime):
 *   1. %LOCALAPPDATA%\eshttp\eshttp-cli.exe   (runtime root; T10 staging)
 *      LOCALAPPDATA from $.getenv, else Folder.temp.parent (ArcFit's
 *      localAppDataRoot fallback: Folder.temp = %LOCALAPPDATA%\Temp).
 *   2. sibling of the running script ($.fileName parent) — dev layout
 *   3. %TEMP%\opencode\eshttp-cli.exe          (scan-dir convenience)
 * Cached after first probe; null when not found (tier unavailable).
 */
export function findCliExe(): any {
  if (_cliProbed) { return _cliExe; }
  _cliProbed = true;
  _cliExe = null;
  var candidates: string[] = [];
  var localAppData = "";
  try {
    var env = $.getenv("LOCALAPPDATA");
    if (env) { localAppData = String(env); }
  } catch (e1) {}
  if (!localAppData) {
    try {
      var tmpF = Folder.temp;
      if (tmpF && tmpF.parent && tmpF.parent.fsName) {
        localAppData = String(tmpF.parent.fsName);
      }
    } catch (e1b) {}
  }
  if (localAppData) {
    candidates.push(stripTrailingSlashes(localAppData) + "/eshttp/eshttp-cli.exe");
  }
  try {
    var self = new File($.fileName);
    if (self && self.parent && self.parent.fsName) {
      candidates.push(stripTrailingSlashes(self.parent.fsName) + "/eshttp-cli.exe");
    }
  } catch (e2) {}
  try {
    var tmp = Folder.temp;
    if (tmp && tmp.fsName) {
      candidates.push(stripTrailingSlashes(tmp.fsName) + "/opencode/eshttp-cli.exe");
    }
  } catch (e3) {}
  var i: number;
  for (i = 0; i < candidates.length; i++) {
    try {
      var f = new File(candidates[i]);
      if (f && f.exists) { _cliExe = f; return f; }
    } catch (e4) {}
  }
  return null;
}

/** True when the cli tier is available (exe present, not dead, net on). */
export function cliAvailable(): boolean {
  if (noNetwork()) { return false; }
  if (_cliDead) { return false; }
  return findCliExe() !== null;
}

/**
 * True when the cli tier is PRESENT (exe on disk) — regardless of session
 * dead state. A FORCED 'cli' uses this so a session-dead tier still routes to
 * cliRequest, which reports the dead marker as an `internal` error carrying
 * "dead" in the message (T9/35-cli-transport Q3: forced dead cli -> internal
 * (dead), never throws). Auto mode uses cliAvailable() (skips dead tiers).
 */
export function cliPresent(): boolean {
  if (noNetwork()) { return false; }
  return findCliExe() !== null;
}

/** Reset cli session state (resetTransport). */
export function resetCliState(): void {
  _cliProbed = false;
  _cliExe = null;
  _cliDead = false;
  _bridge = null;
  _bridgeProbed = false;
  _workerSpawned = false;
  _workerPidOk = false;
  _pipeDead = false;
}

/**
 * Reset ONLY the pipe-lane state for a retry-once relaunch (keeps the oneshot
 * degradation state intact). Called between the first failed pipe attempt and
 * the relaunched-worker retry.
 */
function resetPipeState(): void {
  _bridge = null;
  _bridgeProbed = false;
  _workerSpawned = false;
  _workerPidOk = false;
  _pipeDead = false;
}

// ---------------------------------------------------------------------------
// T19 pipe lane — persistent named-pipe worker (eshttp-cli.exe --worker) via
// the eshttp-ipc bridge DLL (lib:eshttp-ipc). PRIMARY cli path; the job-file
// one-shot below is the degradation lane (meta.path 'cli' vs 'cli-oneshot').
//
// Start/stop contract (native/BUILD.md §3a + coordinator decision):
//   1. ensureWorker(): pid-file check first (alive -> no spawn); if stale/
//      absent, write a MARKER job (ESHTTP_worker_<id>.job, header ESHTTP_CLI_1
//      + mode=worker) and File.execute() no-argv — the CLI's scan+claim path
//      detects mode=worker and enters worker_main() (deleting the marker).
//      Idempotent; one spawn per session.
//   2. Liveness: WaitNamedPipe happens inside the bridge (connect budget
//      1500 ms); the driver pings via eshttp_pipe_request("ping", "", t).
//   3. Request: one connection per request (worker disconnects after each);
//      the driver calls eshttp_pipe_request("request", <job body or
//      jobFile=<path>>, timeoutMs) and parses the normalized kTypeString report.
//   4. Stop: op=quit; fallback idle 120 s; last resort kill-by-pid (stale
//      worker must never block a new spawn).
// ---------------------------------------------------------------------------

/** True when the pipe lane is usable this session (not dead, worker or not
 *  yet failed). The bridge load + worker spawn are lazy (first request). */
function pipeUsable(): boolean {
  return !_pipeDead && !noNetwork() && findCliExe() !== null;
}

/** Worker pid-file path (%TEMP%\opencode\eshttp-worker.pid). */
function workerPidPath(): string {
  var work = cliWorkDir();
  var dir = work && work.parent && work.parent.fsName
    ? stripTrailingSlashes(work.parent.fsName) : "%TEMP%/opencode";
  return dir + "/eshttp-worker.pid";
}

/** True when the worker pid file exists with content (best-effort liveness). */
function workerPidAlive(): boolean {
  try {
    var pf = new File(workerPidPath());
    return !!(pf && pf.exists && pf.length > 0);
  } catch (e) { return false; }
}

/** Write the worker marker job; returns true on success. */
function writeWorkerMarker(id: string): boolean {
  var work = cliWorkDir();
  var dir = work && work.parent && work.parent.fsName
    ? stripTrailingSlashes(work.parent.fsName) : "%TEMP%/opencode";
  var jobPath = dir + "/ESHTTP_worker_" + id + ".job";
  try {
    var folder = new Folder(dir);
    if (folder && !folder.exists) { try { folder.create(); } catch (e0) {} }
    var jf = new File(jobPath);
    if (jf.exists) { jf.remove(); }
    jf.encoding = "ASCII";
    if (!jf.open("w")) { return false; }
    jf.write("ESHTTP_CLI_1\nmode=worker\n");   // mode=worker -> worker_main()
    jf.close();
    return true;
  } catch (e) {
    try { var jf2 = new File(jobPath); if (jf2 && jf2.exists) { jf2.remove(); } } catch (e2) {}
    return false;
  }
}

/**
 * Ensure the persistent worker is running. Idempotent: pid-file alive -> no
 * spawn; stale pid -> marker job + File.execute() no-argv (the firewall-escape
 * spawn). One spawn per session. Never throws.
 */
export function ensureWorker(): boolean {
  if (_workerSpawned && _workerPidOk) { return true; }
  if (!pipeUsable()) { return false; }
  var exe = findCliExe();
  if (!exe) { return false; }
  // 1. pid file alive -> worker up, no spawn
  if (workerPidAlive()) { _workerPidOk = true; _workerSpawned = true; return true; }
  // 2. stale pid (file exists but empty, or previous session) -> marker+spawn
  var id = cliInvocationId();
  if (!writeWorkerMarker(id)) { return false; }
  var launched = false;
  try { launched = exe.execute(); } catch (e) { launched = false; }
  if (!launched) {
    // remove the marker so it is not claimed by a stray oneshot
    try {
      var work = cliWorkDir();
      var dir = work && work.parent && work.parent.fsName
        ? stripTrailingSlashes(work.parent.fsName) : "%TEMP%/opencode";
      var jf = new File(dir + "/ESHTTP_worker_" + id + ".job");
      if (jf && jf.exists) { jf.remove(); }
    } catch (e2) {}
    return false;
  }
  _workerSpawned = true;
  _workerPidOk = true;   // best-effort; the bridge's connect budget handles races
  return true;
}

/** Load + probe the eshttp-ipc bridge DLL (lib:eshttp-ipc). Cached. */
function bridgeGet(): any {
  if (_bridgeProbed) { return _bridge; }
  _bridgeProbed = true;
  if (typeof ExternalObject === "undefined") { return null; }
  try {
    var b = new ExternalObject(_BRIDGE_LIB);
    if (!b) { return null; }
    if (typeof b.eshttp_pipe_request !== "function") { return null; }
    _bridge = b;
    return b;
  } catch (e) {
    _bridge = null;
    return null;
  }
}

/** Parse a normalized bridge report (key=value lines) into a field map. */
function parseReport(raw: string): any {
  var out: any = {};
  var lines = String(raw).split(/\r?\n/);
  var i: number;
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) { continue; }
    var eq = line.indexOf("=");
    if (eq <= 0) { continue; }
    var k = line.substring(0, eq);
    var v = line.substring(eq + 1);
    if (k === "payload") {
      // last payload wins; job bodies ride after an empty payload= marker
      out[k] = v;
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Read a pipe request result: the bridge report's payload is either the
 * inline envelope JSON (message=request-done / request-done-error) or a
 * result-file path (message=request-done-file / request-done-error-file).
 * Returns the envelope JSON string, or null on failure.
 */
function pipeEnvelope(report: any, ctx: RequestContext, startMs: number): string | null {
  var msg = report.message || "";
  var payload = report.payload || "";
  if (msg === "request-done" || msg === "request-done-error") {
    return payload;                       // inline envelope
  }
  if (msg === "request-done-file" || msg === "request-done-error-file") {
    // large envelope by file path
    if (!payload) { return null; }
    try {
      var rf = new File(payload);
      rf.encoding = "UTF-8";
      if (!rf.open("r")) { return null; }
      var raw = rf.read();
      rf.close();
      try { rf.remove(); } catch (e2) {}   // one-shot result file
      return raw;
    } catch (e) { return null; }
  }
  return null;   // unknown message -> not a request-done
}

/**
 * Perform one request via the named-pipe worker (primary cli lane).
 * Returns a Result with meta.path 'cli', or null when the pipe lane is
 * unusable/degraded (the caller falls back to the oneshot lane).
 */
function pipeRequest(ctx: RequestContext, startMs: number): Result | null {
  if (!pipeUsable()) { return null; }
  var bridge = bridgeGet();
  if (!bridge) { _pipeDead = true; return null; }
  if (!ensureWorker()) { _pipeDead = true; return null; }

  // Build the job body in the ESHTTP_CLI_1 key=value form the worker's
  // request op consumes (method/url/headers/opts; body stays out — v1 CLI).
  var opts: any = {
    timeoutMs: ctx.timeout,
    redirect: ctx.redirect,
    maxRedirects: ctx.maxRedirects,
    verifyTls: ctx.verifyTls,
    userAgent: ctx.userAgent,
    username: ctx.username,
    password: ctx.password,
    proxy: ctx.proxy,
    decompress: ctx.decompress,
    maxBodyBytes: ctx.maxBodyBytes,
    bodyIsBase64: ctx.bodyIsBase64 === true
  };
  var lines: string[] = [];
  lines.push("method=" + ctx.method);
  lines.push("url=" + ctx.url);
  lines.push("headers=" + jsonEncode(headersToJsonObject(ctx.headers)));
  lines.push("opts=" + jsonEncode(opts));
  var jobBody = lines.join("\n") + "\n";

  // Large payloads travel by file path (jobFile=<path>) — the bridge caps the
  // inline payload at ESHTTP_IPC_PAYLOAD_MAX+512 (~4608 B; eshttp-ipc.c L331).
  // Keep the inline lane under ~4000 B and spill larger bodies to a job file
  // (reusing the proven oneshot job-file machinery).
  var pipePayload = jobBody;
  var jobFileWritten = false;
  if (jobBody.length > 4000) {
    try {
      var work = cliWorkDir();
      var dir = work && work.parent && work.parent.fsName
        ? stripTrailingSlashes(work.parent.fsName) : "%TEMP%/opencode";
      var jobPath = dir + "/ESHTTP_pipe_" + cliInvocationId() + ".job";
      var jf = new File(jobPath);
      jf.encoding = "ASCII";
      if (jf.open("w")) {
        jf.write(jobBody);
        jf.close();
        pipePayload = "jobFile=" + jobPath;
        jobFileWritten = true;
      }
    } catch (e) { /* fall through: try the inline payload; bridge rejects oversize */ }
  }

  // Single-flight: a concurrent request would hit the bridge's busy guard;
  // the driver serializes by relying on the caller (request() is synchronous).
  var reportRaw: string = "";
  var timeoutMs = (ctx.timeout && ctx.timeout > 0) ? ctx.timeout : 3000;
  var attempt: number;
  var report: any = null;
  for (attempt = 0; attempt < 2; attempt++) {
    reportRaw = "";
    try {
      reportRaw = String(bridge.eshttp_pipe_request("request", pipePayload, timeoutMs));
    } catch (e) {
      // ExternalObject call failed — bridge unusable. Retry-once per
      // contract: relaunch the worker, retry the request, else degrade.
      if (attempt === 0) {
        resetPipeState();
        if (!ensureWorker()) { _pipeDead = true; return null; }
        continue;
      }
      _pipeDead = true;
      return null;
    }
    report = parseReport(reportRaw);
    if (report.protocol !== _BRIDGE_PROTO) {
      if (attempt === 0) { resetPipeState(); if (!ensureWorker()) { _pipeDead = true; return null; } continue; }
      _pipeDead = true;
      return null;
    }
    if (report.success !== "1") {
      // transport-level failure (worker-unavailable, timeout, crash, ...).
      // Retry once with a relaunched worker; then degrade to oneshot.
      if (attempt === 0) { resetPipeState(); if (!ensureWorker()) { _pipeDead = true; return null; } continue; }
      _pipeDead = true;
      return null;
    }
    break;   // success report
  }
  if (!report) { _pipeDead = true; return null; }
  var envelopeJson = pipeEnvelope(report, ctx, startMs);
  if (envelopeJson === null) {
    _pipeDead = true;
    return null;
  }
  var parsed: any = null;
  try { parsed = jsonParseStrict(envelopeJson); } catch (e5) { _pipeDead = true; return null; }
  if (parsed === null || typeof parsed !== "object" || parsed.abi !== _ABI) {
    _pipeDead = true;
    return null;
  }
  // handled http-v1 envelope (ok true or false) -> shared mapping, path 'cli'
  return envelopeToResult(parsed, ctx, startMs, "cli");
}

// ---------------------------------------------------------------------------
// Job-file write + spawn + done-poll
// ---------------------------------------------------------------------------

function cliInvocationId(): string {
  var hex = "0123456789abcdef";
  var seed = String((new Date()).getTime());
  var out = "";
  var i: number;
  for (i = 0; i < 16; i++) {
    var base = Math.floor(Math.random() * 16);
    var t = i < seed.length ? seed.charCodeAt(i) : 0;
    out += hex.charAt((base ^ (t & 15)) & 15);
  }
  return "cli" + out;
}

/** Write the job file. Returns { jobPath, donePath } or null on failure. */
function writeCliJob(ctx: RequestContext, id: string): any {
  var work = cliWorkDir();
  var dir = work ? work.parent : null;
  var dirPath = dir && dir.fsName ? stripTrailingSlashes(dir.fsName) : "%TEMP%/opencode";
  var jobPath = dirPath + "/ESHTTP_" + id + ".job";
  var donePath = dirPath + "/ESHTTP_" + id + ".done";
  try {
    // ensure the work dir exists
    var folder = new Folder(dirPath);
    if (folder && !folder.exists) {
      try { folder.create(); } catch (e0) {}
    }
    var opts: any = {
      timeoutMs: ctx.timeout,
      redirect: ctx.redirect,
      maxRedirects: ctx.maxRedirects,
      verifyTls: ctx.verifyTls,
      userAgent: ctx.userAgent,
      username: ctx.username,
      password: ctx.password,
      proxy: ctx.proxy,
      decompress: ctx.decompress,
      maxBodyBytes: ctx.maxBodyBytes,
      bodyIsBase64: ctx.bodyIsBase64 === true
    };
    var lines: string[] = [];
    lines.push("ESHTTP_CLI_1");
    lines.push("method=" + ctx.method);
    lines.push("url=" + ctx.url);
    lines.push("done=" + donePath);
    lines.push("headers=" + jsonEncode(headersToJsonObject(ctx.headers)));
    lines.push("opts=" + jsonEncode(opts));
    var content = lines.join("\n") + "\n";
    var jf = new File(jobPath);
    if (jf.exists) { jf.remove(); }
    jf.encoding = "ASCII";          // job keys/values are ASCII-safe (JSON escapes)
    if (!jf.open("w")) { return null; }
    jf.write(content);
    jf.close();
    return { jobPath: jobPath, donePath: donePath };
  } catch (e) {
    try { var jf2 = new File(jobPath); if (jf2 && jf2.exists) { jf2.remove(); } } catch (e2) {}
    return null;
  }
}

/** Chunked sleep helper (skill §11: $.sleep polls ~100ms; never tight-spin). */
function cliSleep(ms: number): void {
  if (typeof $ !== "undefined" && $.sleep) {
    try { $.sleep(ms); } catch (e) {}
  } else {
    var t = (new Date()).getTime() + ms;
    while ((new Date()).getTime() < t) { /* busy fallback for non-ES hosts */ }
  }
}

/**
 * Poll the done file until it exists with content, or the deadline passes.
 * Never throws; returns true on success.
 */
function waitForDone(donePath: string, timeoutMs: number, startMs: number): boolean {
  var deadline = (timeoutMs && timeoutMs > 0) ? startMs + timeoutMs : 0;
  var poll = _CLI_POLL_MS;
  for (;;) {
    if (deadline && now() > deadline) { return false; }
    try {
      var df = new File(donePath);
      if (df && df.exists && df.length > 0) { return true; }
    } catch (e) { return false; }
    cliSleep(poll);
  }
}

// ---------------------------------------------------------------------------
// Request entry
// ---------------------------------------------------------------------------

/**
 * Shared cli error-Result shape. `path` is 'cli' (pipe lane) or
 * 'cli-oneshot' (job-file degradation lane); zeroed fields otherwise.
 */
function cliErrorResult(error: EshttpError, ctx: RequestContext, startMs: number, path?: string): Result {
  var lane = path || "cli";
  return {
    ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
    error: error,
    meta: {
      path: lane, url: ctx.url, redirects: 0, timeMs: now() - startMs, bytes: 0,
      timeoutEnforced: false, tlsVersion: null, httpVersion: null, abi: _ABI, nativeVersion: null,
      encodingWasApplied: null, backend: null
    }
  };
}

/**
 * Perform one request via the cli transport. PRIMARY: named-pipe worker
 * (meta.path 'cli'). DEGRADATION: job-file one-shot (meta.path
 * 'cli-oneshot') when the pipe lane is unusable/dead. Never throws; every
 * failure becomes an error Result. GET/HEAD-only (the CLI job protocol has no
 * body key — v1).
 */
export function cliRequest(ctx: RequestContext, startMs: number): Result {
  // body unsupported in the v1 CLI protocol (eshttp-cli.c:184-188)
  if (ctx.body && ctx.body.length > 0) {
    return cliErrorResult(
      mkError("unsupported", "request body is not supported by the cli transport (eshttp-cli.exe v1 is GET/HEAD-only)"),
      ctx, startMs);
  }
  if (ctx.bodyIsBase64) {
    return cliErrorResult(
      mkError("unsupported", "bodyIsBase64 is not supported by the cli transport (eshttp-cli.exe v1 is GET/HEAD-only)"),
      ctx, startMs);
  }

  // PRIMARY: pipe lane
  var pr = pipeRequest(ctx, startMs);
  if (pr !== null) { return pr; }

  // DEGRADATION: job-file one-shot (meta.path 'cli-oneshot')
  return cliRequestOneshot(ctx, startMs);
}

/**
 * Job-file one-shot cli request (degradation lane, meta.path 'cli-oneshot').
 * The pre-T19 path, unchanged except the meta.path value.
 */
function cliRequestOneshot(ctx: RequestContext, startMs: number): Result {
  var exe = findCliExe();
  if (!exe) {
    return cliErrorResult(mkError("internal", "eshttp-cli.exe not found; cli transport unavailable"), ctx, startMs, "cli-oneshot");
  }
  if (_cliDead) {
    return cliErrorResult(mkError("internal", "eshttp-cli.exe marked dead (previous bad envelope)"), ctx, startMs, "cli-oneshot");
  }

  var id = cliInvocationId();
  var written = writeCliJob(ctx, id);
  if (!written) {
    return cliErrorResult(mkError("internal", "could not write cli job file"), ctx, startMs, "cli-oneshot");
  }
  var donePath = written.donePath;

  var launched = false;
  try {
    // delete any stale .done from a previous run BEFORE spawn (T9 edge case)
    var stale = new File(donePath);
    if (stale && stale.exists) { stale.remove(); }
    launched = exe.execute();      // no argv -> scan+claim mode
  } catch (e) {
    launched = false;
    _lastLaunchError = e;
  }
  if (!launched) {
    try { var jj = new File(written.jobPath); if (jj && jj.exists) { jj.remove(); } } catch (e2) {}
    return cliErrorResult(mkError("internal", "could not execute eshttp-cli.exe: " + errStr(_lastLaunchError)), ctx, startMs, "cli-oneshot");
  }

  if (!waitForDone(donePath, ctx.timeout, startMs)) {
    _cliDead = true;               // session-dead: no .done within timeout
    try { var jj2 = new File(written.jobPath); if (jj2 && jj2.exists) { jj2.remove(); } } catch (e3) {}
    return cliErrorResult(mkError("timeout", "cli transport timed out after " + ctx.timeout + "ms (no .done file)"), ctx, startMs, "cli-oneshot");
  }

  // read + parse the http-v1 envelope
  var raw = "";
  try {
    var df = new File(donePath);
    df.encoding = "UTF-8";
    if (!df.open("r")) {
      _cliDead = true;
      return cliErrorResult(mkError("internal", "could not read cli done file"), ctx, startMs, "cli-oneshot");
    }
    raw = df.read();
    df.close();
  } catch (e4) {
    _cliDead = true;
    return cliErrorResult(mkError("internal", "cli done file read failed: " + errStr(e4)), ctx, startMs, "cli-oneshot");
  }

  var parsed: any = null;
  try {
    parsed = jsonParseStrict(raw);
  } catch (e5) {
    _cliDead = true;
    return cliErrorResult(mkError("internal", "cli envelope unparseable: " + errStr(e5)), ctx, startMs, "cli-oneshot");
  }
  if (parsed === null || typeof parsed !== "object" || parsed.abi !== _ABI) {
    _cliDead = true;
    return cliErrorResult(mkError("internal", "cli marked dead: envelope ABI mismatch (expected '" + _ABI + "')"), ctx, startMs, "cli-oneshot");
  }
  if (parsed.error) {
    // transport error envelope from the CLI engine (timeout, dns, ...)
    var mapped = mapCliError(parsed.error);
    if (parsed.meta && parsed.meta.winhttpError !== undefined && parsed.meta.winhttpError !== null) {
      mapped.detail = mapped.detail || {};
      mapped.detail.winhttp = parsed.meta.winhttpError;
    }
    return { ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
             error: mapped, meta: cliTransportMeta(ctx, parsed.meta, startMs, true, "cli-oneshot") };
  }
  // success envelope -> shared mapping, meta.path forced to the oneshot lane
  return envelopeToResult(parsed, ctx, startMs, "cli-oneshot");
}

var _lastLaunchError: any = null;

/** Convert a CLI error envelope to our error object (same mapping as native). */
function mapCliError(envError: any): EshttpError {
  var code = envError && envError.code ? String(envError.code) : "internal";
  if (!_KNOWN_CODES[code]) { code = "internal"; }
  var err = mkError(code, envError && envError.message ? envError.message : code);
  if (envError && envError.category) { err.category = envError.category; }
  if (envError && typeof envError.retryable === "boolean") { err.retryable = envError.retryable; }
  return err;
}

var _KNOWN_CODES: any = {
  "invalid-args": 1, "bad-url": 1, "invalid-header": 1, "unsupported": 1,
  "dns": 1, "connect": 1, "network": 1, "tls": 1, "timeout": 1, "aborted": 1,
  "too-many-redirects": 1, "body-too-large": 1, "internal": 1
};

/** Meta for cli error results (path 'cli'). OBS-1 fields are native-only —
 *  null on the cli lane (api-spec §3), matching socket. */
function cliTransportMeta(ctx: RequestContext, meta: any, startMs: number, isError: boolean, path?: string): any {
  meta = meta || {};
  var lane = path || "cli";
  return {
    path: lane,
    url: meta.finalUrl || ctx.url,
    redirects: typeof meta.redirects === "number" ? meta.redirects : 0,
    timeMs: (typeof meta.timeMs === "number" ? meta.timeMs : (now() - startMs)),
    bytes: 0,
    timeoutEnforced: true,
    tlsVersion: meta.tlsVersion !== undefined ? meta.tlsVersion : null,
    httpVersion: meta.httpVersion !== undefined ? meta.httpVersion : null,
    abi: _ABI,
    nativeVersion: meta.nativeVersion || null,
    encodingWasApplied: null,   // native-only field (api-spec §3)
    backend: null               // native-only field (api-spec §3)
  };
}
