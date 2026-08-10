/*
 * 36-pipe-transport.js — pipe lane (named-pipe worker) transport tests (T19 QA).
 * ==================================================================
 * The pipe lane is the PRIMARY cli transport: a persistent eshttp-cli.exe
 * --worker (named pipe \\\\.\pipe\EshttpBridge) services requests via the
 * eshttp-ipc.dll bridge (lib:eshttp-ipc, pure pipe client inside the host).
 * The job-file one-shot path is the DEGRADATION lane.
 *
 * Contract (eshttp-ipc.h + driver-cli.ts + eshttp-ipc.c report_emit):
 *   - Worker marker: ESHTTP_worker_<16hex>.job in %TEMP%\opencode, header
 *     ESHTTP_CLI_1 + mode=worker; the CLI two-pass claim consumes markers
 *     first (worker_main), then request jobs with ESHTTP_worker_* excluded.
 *   - Bridge report: key=value lines (protocol=ESHTTP_IPC_1, success,
 *     op, requestId, errClass, message, winerr, protoMajor/Minor, workerAbi,
 *     buildId, pid, uptimeMs, requests, [payload]).
 *   - op=request: success=1 + message=request-done(-error) + payload =
 *     http-v1 envelope JSON (inline) or request-done-file(-error) + payload=
 *     path; envelope mapped via envelopeToResult(...,'cli').
 *   - Transport failure: success=0 + errClass + no payload -> pipe marked
 *     dead, degrade to oneshot (meta.path 'cli-oneshot').
 *   - meta.path: 'cli' (pipe) / 'cli-oneshot' (job-file degradation).
 *     transportInfo().transport stays 'cli' (tier-level).
 *
 * The harness fake (test/fake-bridge.mjs + load-core.mjs setBridgeAvailable)
 * drives the real job/marker file protocol headlessly.
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const A = env.assert;
    const EQ = env.assertEq;

    function setupPipe() {
        env.controls.setExternalObjectAvailable(false); // no native DLL
        env.controls.setBridgeAvailable(false);          // reset bridge staging
        // clear worker pid + spawn state so each test starts fresh
        if (env.controls.clearWorkerPid) { env.controls.clearWorkerPid(); }
        if (env.controls.bridgeState) {
            env.controls.bridgeState.workerSpawns = 0;
            env.controls.bridgeState.pipeCalls.length = 0;
        }
        env.controls.setBridgeAvailable(true);           // fake eshttp-ipc.dll
        env.controls.setCliAvailable(true);              // real File stub + exe
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
    }
    function teardown() {
        // CRITICAL: restore the NATIVE ExternalObject stub — setBridgeAvailable
        // staged the bridge ctor as the global ExternalObject; leaving it poisons
        // later suites (40-codec's native base64 tests call accel.eshttp_request
        // which the bridge lacks -> empty bodies). setBridgeAvailable(false)
        // restores the native ctor, then setExternalObjectAvailable(true) is the
        // harness's canonical native-on state.
        env.controls.setBridgeAvailable(false);
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("auto");
    }

    // =====================================================================
    // Q10 — pipe lane tier + transportInfo observability
    // =====================================================================
    suite.test("Q10 pipe lane: transportInfo stays 7 keys, transport 'cli'", function () {
        setupPipe();
        const ti = eshttp.transportInfo();
        const keys = Object.keys(ti).sort();
        EQ(JSON.stringify(keys), JSON.stringify(["abi", "externalObjectAvailable", "host", "nativeVersion", "platform", "socketAvailable", "transport"]),
            "transportInfo keys (7, unchanged)");
        EQ(ti.transport, "cli", "transport value cli (tier-level)");
        teardown();
    });

    // =====================================================================
    // Q3 — pipe request success: envelope mapped, meta.path 'cli'
    // =====================================================================
    suite.test("Q3 pipe request: success envelope -> meta.path 'cli', worker spawned once", function () {
        setupPipe();
        env.controls.setBridgeResponder(function (op, payload, t) {
            if (op === "request") {
                // payload is the inline job body (method=/url=/headers=/opts=)
                A(String(payload).indexOf("method=") === 0, "job body inline starts with method=");
                A(String(payload).indexOf("url=") >= 0, "job body has url=");
                A(String(payload).indexOf("opts=") >= 0, "job body has opts=");
                return { envelopeJson: JSON.stringify({
                    abi: "http-v1", ok: true, status: 200, statusText: "OK",
                    headers: { "content-type": "application/json; charset=utf-8" },
                    body: "{\"ok\":true}", bodyEncoding: "utf8", error: null,
                    meta: { path: "native", method: "GET", finalUrl: null, redirects: 0,
                            timeMs: 1, bytes: 10, httpVersion: "1.1", tlsVersion: "1.2",
                            encodingWasApplied: false, nativeVersion: "1.0.0",
                            winhttpError: null, backend: "winhttp" } }) };
            }
            return null;
        });
        env.controls.bridgeState.pipeCalls.length = 0;
        const r = eshttp.request({ url: "http://127.0.0.1:1/pipeok" });
        EQ(r.status, 200, "status 200");
        EQ(r.ok, true, "ok");
        EQ(r.meta.path, "cli", "meta.path cli (pipe lane)");
        A(r.error === null, "no error");
        EQ(env.controls.bridgeState.pipeCalls.length, 1, "bridge called once");
        EQ(env.controls.bridgeState.pipeCalls[0].op, "request", "op=request");
        EQ(env.controls.bridgeState.workerSpawns, 1, "worker spawned once");
        A(env.controls.bridgeState.workerAlive, "pid file present (worker alive)");
        teardown();
    });

    // =====================================================================
    // Q3 — pipe transport failure -> degrade to oneshot (meta.path cli-oneshot)
    // =====================================================================
    suite.test("Q3 pipe transport failure -> oneshot degrade, meta.path 'cli-oneshot'", function () {
        setupPipe();
        // the degraded oneshot lane is served by the FAKE CLI — set its
        // responder so the oneshot request returns a 200 envelope.
        env.controls.setCliResponder(function () {
            return {
                abi: "http-v1", ok: true, status: 200, statusText: "OK",
                headers: { "content-type": "application/json; charset=utf-8" },
                body: "{\"ok\":true}", bodyEncoding: "utf8", error: null,
                meta: { path: "native", method: "GET", finalUrl: null, redirects: 0,
                        timeMs: 1, bytes: 10, httpVersion: "1.1", tlsVersion: "1.2",
                        encodingWasApplied: false, nativeVersion: "1.0.0",
                        winhttpError: null, backend: "winhttp" }
            };
        });
        env.controls.setBridgeResponder(function (op) {
            if (op === "request") {
                return { transportFailure: true, errClass: "worker-unavailable", message: "worker gone" };
            }
            return null;
        });
        const r = eshttp.request({ url: "http://127.0.0.1:1/pipefail" });
        // pipe dead -> oneshot lane serves it (fake cli responder 200)
        EQ(r.meta.path, "cli-oneshot", "degraded request meta.path cli-oneshot, got " + r.meta.path);
        A(r.status === 200, "oneshot lane returned a result (status " + r.status + ")");
        // next request still degrades (pipe marked dead for session)
        const r2 = eshttp.request({ url: "http://127.0.0.1:1/pipefail2" });
        EQ(r2.meta.path, "cli-oneshot", "second request still oneshot (pipe dead)");
        env.controls.setCliResponder(null);
        teardown();
    });

    // =====================================================================
    // Q3 — worker marker convention: ESHTTP_worker_ prefix + mode=worker
    // =====================================================================
    suite.test("Q3 worker marker: ESHTTP_worker_<id>.job with mode=worker, claimed+deleted", function () {
        setupPipe();
        // force a fresh worker spawn by clearing the pid state
        env.controls.setBridgeAvailable(false);
        env.controls.setBridgeAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
        env.controls.bridgeState.workerSpawns = 0;
        env.controls.bridgeState.pipeCalls.length = 0;
        env.controls.setBridgeResponder(function (op) {
            if (op === "request") {
                return { envelopeJson: JSON.stringify({
                    abi: "http-v1", ok: true, status: 204, statusText: "No Content",
                    headers: {}, body: "", bodyEncoding: "utf8", error: null,
                    meta: { path: "native", method: "GET", finalUrl: null, redirects: 0,
                            timeMs: 1, bytes: 0, httpVersion: "1.1", tlsVersion: "1.2",
                            encodingWasApplied: false, nativeVersion: "1.0.0",
                            winhttpError: null, backend: "winhttp" } }) };
            }
            return null;
        });
        const r = eshttp.request({ url: "http://127.0.0.1:1/marker" });
        EQ(r.meta.path, "cli", "pipe lane used");
        EQ(env.controls.bridgeState.workerSpawns, 1, "worker marker claimed exactly once");
        // assert no worker marker jobs remain in the scan dir (claimed+deleted)
        if (typeof require === "function") {
            const fs = require("fs");
            const os = require("os");
            const path = require("path");
            const dir = path.join(os.tmpdir(), "opencode");
            let markers = [];
            try { markers = fs.readdirSync(dir).filter((n) => /^ESHTTP_worker_.*\.job$/.test(n)); } catch (e) {}
            EQ(markers.length, 0, "no worker markers left (claimed+deleted), found " + markers.length);
        }
        teardown();
    });

    // =====================================================================
    // Q3 — pipe deadline / protocol mismatch -> degrade (never throw)
    // =====================================================================
    suite.test("Q3 pipe protocol mismatch -> pipe dead, degrade, never throw", function () {
        setupPipe();
        env.controls.setBridgeResponder(function (op) {
            if (op === "request") {
                return { transportFailure: true, errClass: "timeout", message: "deadline exceeded" };
            }
            return null;
        });
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/pipebad", timeout: 50 }); },
            "pipe timeout must not throw");
        A(r && r.error, "returns an error Result");
        // degraded to oneshot which also fails on closed port -> network/connect
        A(r.meta.path === "cli-oneshot" || r.meta.path === "socket", "degraded path, got " + r.meta.path);
        teardown();
    });

    // =====================================================================
    // Q10 — pipe lane https fallback when native dead (https-capable)
    // =====================================================================
    suite.test("Q10 pipe lane is the https-capable fallback when native is dead", function () {
        env.controls.setExternalObjectAvailable(true);
        env.controls.setBridgeAvailable(true);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        env.controls.setNativeResponder(function () { return { abi: "tampered", status: 200 }; });
        const r1 = eshttp.request({ url: "https://127.0.0.1:1/x" });
        A(["cli", "cli-oneshot", "socket", "none"].indexOf(r1.meta.path) >= 0,
            "degraded away from native, got " + r1.meta.path);
        env.controls.setNativeResponder(null);
        env.controls.setBridgeResponder(null);
        env.controls.setBridgeAvailable(false);   // restore native ExternalObject ctor
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("auto");
    });
};
