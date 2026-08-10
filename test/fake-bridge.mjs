/*
 * fake-bridge.mjs — harness fake of the eshttp-ipc.dll bridge (T19 QA half).
 * ============================================================================
 * Mirrors the REAL eshttp-ipc.dll pipe-client contract (native/eshttp-ipc.c
 * report_emit L684-718 + driver-cli.ts parseReport/pipeRequest) so the "cli"
 * pipe lane is headlessly testable:
 *
 *   - The fake is an ExternalObject-shaped bridge: `eshttp_pipe_request(op,
 *     payload, timeoutMs)` returns a kTypeString report with the EXACT
 *     key=value fields the driver parses (protocol/success/op/requestId/
 *     errClass/message/winerr/protoMajor/protoMinor/workerAbi/buildId/pid/
 *     uptimeMs/requests/[payload]).
 *   - op=request SUCCESS envelope -> success=1, errClass=ok,
 *     message=request-done, payload=<http-v1 envelope JSON> (inline when
 *     small) or message=request-done-file + payload=<path> (large envelope
 *     by file path — the fake writes a temp file).
 *   - op=request handled-error envelope -> success=0, errClass=worker-error,
 *     message=request-done-error, payload=<envelope JSON>.
 *   - op=request TRANSPORT failure -> success=0, errClass=<class>, message=
 *     <text>, NO payload (driver marks pipe dead + degrades to oneshot).
 *   - op=ping -> success=1, errClass=ok, message="ok" (no payload).
 *   - op=quit -> success=1, errClass=ok, message="ok".
 *
 * The fake's CLI-side spawn hook (used via load-core.mjs RealFileStub
 * .execute()): claims the newest ESHTTP_worker_<id>.job (mode=worker),
 * deletes it, records a worker-spawn event, and writes the pid file
 * (%TEMP%\opencode\eshttp-worker.pid = decimal PID) so ensureWorker()'s
 * alive heuristic passes.
 *
 * QA infrastructure only — NOT part of the eshttp library.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCAN_DIR = path.join(os.tmpdir(), 'opencode');

export function makeFakeBridge() {
  const state = {
    // pipe-lane observability
    pipeCalls: [],             // { op, payload, timeoutMs }
    responder: null,           // (op, payload) -> { success, errClass, message, payload? } override
    workerSpawns: 0,           // worker marker claims (File.execute hook)
    workerAlive: false,
    pid: null,
    requests: 0
  };

  // --- report emitter (matches eshttp-ipc.c report_emit) ------------------
  function report(op, fields) {
    const lines = [];
    lines.push('protocol=ESHTTP_IPC_1');
    lines.push('success=' + (fields.success === false ? '0' : '1'));
    lines.push('op=' + op);
    lines.push('requestId=' + (fields.requestId || '0000000000000000'));
    lines.push('errClass=' + (fields.errClass || 'ok'));
    lines.push('message=' + (fields.message || 'ok'));
    lines.push('winerr=' + (fields.winerr !== undefined ? fields.winerr : '0'));
    lines.push('protoMajor=1');
    lines.push('protoMinor=0');
    lines.push('workerAbi=1');
    lines.push('buildId=' + (fields.buildId || '-'));
    lines.push('pid=' + (state.pid !== null ? state.pid : '0'));
    lines.push('uptimeMs=1');
    lines.push('requests=' + state.requests);
    if (fields.payload !== undefined && fields.payload !== null && fields.payload !== '') {
      lines.push('payload=' + fields.payload);
    }
    return lines.join('\n') + '\n';
  }

  // --- bridge method (ExternalObject surface) ------------------------------
  function eshttp_pipe_request(op, payload, timeoutMs) {
    state.pipeCalls.push({ op: String(op), payload: payload !== undefined && payload !== null ? String(payload) : '', timeoutMs: timeoutMs });
    if (op === 'ping') {
      return report('ping', { success: true, errClass: 'ok', message: 'ok' });
    }
    if (op === 'quit') {
      state.workerAlive = false;
      return report('quit', { success: true, errClass: 'ok', message: 'ok' });
    }
    if (op === 'request') {
      state.requests++;
      if (state.responder) {
        const r = state.responder('request', payload, timeoutMs);
        if (r) {
          if (r.transportFailure) {
            // success=0 + errClass + message, NO payload -> driver degrades
            return report('request', { success: false, errClass: r.errClass || 'worker-unavailable', message: r.message || 'worker unavailable', winerr: r.winerr });
          }
          if (r.handledError) {
            return report('request', { success: false, errClass: 'worker-error', message: 'request-done-error', payload: r.envelopeJson });
          }
          if (r.largeByFile) {
            // write the envelope to a temp file, return request-done-file
            const p = path.join(os.tmpdir(), 'eshttp-resp_' + Date.now() + '.json');
            fs.writeFileSync(p, r.envelopeJson, 'utf8');
            return report('request', { success: true, errClass: 'ok', message: 'request-done-file', payload: p });
          }
          // success envelope inline
          return report('request', { success: true, errClass: 'ok', message: 'request-done', payload: r.envelopeJson });
        }
      }
      // default: good envelope (like the real worker after a fetch)
      const env = JSON.stringify({
        abi: 'http-v1', ok: true, status: 200, statusText: 'OK',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{"ok":true}', bodyEncoding: 'utf8', error: null,
        meta: { path: 'native', method: 'GET', finalUrl: null, redirects: 0, timeMs: 1,
                bytes: 10, httpVersion: '1.1', tlsVersion: '1.2',
                encodingWasApplied: false, nativeVersion: '1.0.0',
                winhttpError: null, backend: 'winhttp' }
      });
      return report('request', { success: true, errClass: 'ok', message: 'request-done', payload: env });
    }
    return report(op, { success: false, errClass: 'unknown-op', message: 'unknown op: ' + op });
  }

  // --- worker spawn hook (RealFileStub.execute for the marker job) --------
  function claimWorkerMarker() {
    let best = null, bestMtime = -1;
    let entries = [];
    try { entries = fs.readdirSync(SCAN_DIR); } catch (e) { return false; }
    for (const name of entries) {
      if (!/^ESHTTP_worker_.*\.job$/.test(name)) { continue; }
      const p = path.join(SCAN_DIR, name);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; }
    }
    if (!best) { return false; }
    try {
      const text = fs.readFileSync(best, 'utf8');
      if (text.indexOf('mode=worker') < 0) { return false; }  // not a worker marker
      fs.unlinkSync(best);                                     // claimed + deleted
      state.workerSpawns++;
      state.workerAlive = true;
      state.pid = Math.floor(10000 + Math.random() * 89999);
      // write the pid file (driver's alive heuristic: exists && length > 0)
      try { fs.mkdirSync(SCAN_DIR, { recursive: true }); } catch (e) {}
      fs.writeFileSync(path.join(SCAN_DIR, 'eshttp-worker.pid'), String(state.pid), 'utf8');
      return true;
    } catch (e) { return false; }
  }

  function clearPid() {
    try { fs.unlinkSync(path.join(SCAN_DIR, 'eshttp-worker.pid')); } catch (e) {}
    state.workerAlive = false;
  }

  return { state, eshttp_pipe_request, claimWorkerMarker, clearPid };
}
