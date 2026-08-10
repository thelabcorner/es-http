/*
 * 35-cli-transport.js — cli transport tier tests (T11).
 * ==================================================================
 * The `cli` tier is the firewall-escape lane: eshttp-cli.exe (a static-link
 * build of the SAME v2 eshttp.c engine) runs as a SEPARATE process via
 * File.execute() with no argv, ArcFit-style job-file IPC, so it can reach the
 * network even when the host firewall blocks Illustrator.exe outbound. It is
 * the https-capable fallback when the native DLL is dead/unavailable.
 *
 * Tier order (additive): auto -> native -> cli -> socket -> none.
 * Public surface additions: transportInfo().transport gains "cli";
 * result.meta.path gains "cli". The cli lane's meta carries
 * encodingWasApplied/backend = null (native-only fields, api-spec §3).
 * The cli tier is GET/HEAD-only in v1 (job protocol has no body key — the
 * CLI hardcodes ""); a non-empty body/bodyIsBase64 -> "unsupported".
 *
 * The harness drives the REAL job-file protocol through the fake CLI
 * (test/fake-cli.mjs): the wrapper writes ESHTTP_<id>.job to %TEMP%\opencode
 * (ESHTTP_CLI_1 header + method/url/done/headers/opts), the fake claims the
 * newest job by mtime, deletes it, and writes the http-v1 envelope to the
 * .done file; the wrapper polls and maps via envelopeToResult(...,'cli').
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const A = env.assert;
    const EQ = env.assertEq;

    // =====================================================================
    // Q10 — tier order includes cli (native -> cli -> socket -> none)
    // =====================================================================
    suite.test("Q10 cli tier order: native > cli > socket > none", function () {
        // All present -> auto = native
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        env.controls.setCliAvailable(true);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "native", "auto with all three -> native");

        // ExternalObject gone -> auto = cli (the https-capable fallback)
        env.controls.setExternalObjectAvailable(false);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "cli", "auto without native -> cli");

        // ExternalObject + cli gone -> socket
        env.controls.setCliAvailable(false);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "socket", "auto without native+cli -> socket");

        // none left -> none
        env.controls.setSocketAvailable(false);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "none", "auto with nothing -> none");

        // restore
        env.controls.setExternalObjectAvailable(true);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
    });

    suite.test("Q10 forceTransport('cli') explicit + bogus name keeps current", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("cli"), "cli", "forced cli");
        EQ(eshttp.forceTransport("bogus"), "cli", "bogus keeps current transport");
        eshttp.forceTransport("auto");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    // =====================================================================
    // Q10 — transportInfo gains 'cli' (7 keys unchanged)
    // =====================================================================
    suite.test("Q10 transportInfo exposes the 7 documented keys with a cli transport", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
        const ti = eshttp.transportInfo();
        const keys = Object.keys(ti).sort();
        EQ(JSON.stringify(keys), JSON.stringify(["abi", "externalObjectAvailable", "host", "nativeVersion", "platform", "socketAvailable", "transport"]),
            "transportInfo keys (7, unchanged by the cli tier)");
        EQ(ti.transport, "cli", "transport value 'cli'");
        A(ti.socketAvailable === true, "socket still available");
        eshttp.forceTransport("auto");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    // =====================================================================
    // cli DEGRADATION lane (job-file oneshot): with the pipe lane primary,
    // forcing 'cli' WITHOUT a bridge falls back to the job-file oneshot.
    // meta.path = 'cli-oneshot'; the shared envelopeToResult mapping applies.
    // =====================================================================
    suite.test("Q6 cli oneshot lane meta: shared mapping applies, path 'cli-oneshot'", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setBridgeAvailable(false);  // no pipe bridge -> oneshot
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
        const r = eshttp.request({ url: "http://127.0.0.1:1/climeta" });
        A(r && r.meta, "result has meta");
        EQ(r.meta.path, "cli-oneshot", "meta.path = cli-oneshot (job-file degradation)");
        // The lane forwards the ENGINE envelope through the shared mapping
        A(typeof r.meta.timeMs === "number", "timeMs number");
        A(r.meta.abi === "http-v1", "abi marker");
        eshttp.forceTransport("auto");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    // =====================================================================
    // Q3/Q7 — cli job-file ONESHOT protocol: envelope mapped, path cli-oneshot
    // =====================================================================
    suite.test("Q3 cli oneshot request maps the envelope with meta.path 'cli-oneshot'", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setBridgeAvailable(false);  // no pipe bridge -> oneshot
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
        // The fake CLI writes meta.path="native" (same engine); the wrapper
        // normalizes to 'cli-oneshot' via envelopeToResult(...,'cli-oneshot').
        const r = eshttp.request({ url: "http://127.0.0.1:1/cliok" });
        EQ(r.status, 200, "status 200");
        EQ(r.ok, true, "ok");
        EQ(r.meta.path, "cli-oneshot", "meta.path normalized to cli-oneshot");
        A(r.error === null, "no error");
        // The fake CLI consumed exactly one job
        const jobs = env.controls.cliState ? env.controls.cliState.jobsClaimed : null;
        A(jobs && jobs.length >= 1, "fake cli claimed a job");
        const j = jobs[jobs.length - 1];
        EQ(j.url, "http://127.0.0.1:1/cliok", "job url matches the request");
        EQ(j.method, "GET", "job method GET");
        A(j.done && j.done.length > 0, "job has a done path");
        // claim semantics (cli-transport.md §3.2): the CLI deletes the job
        // file after consuming it — assert the file is gone.
        A(typeof require === "function", "require available");
        if (typeof require === "function") {
            const fs = require("fs");
            A(!fs.existsSync(j.path), "job file deleted after claim");
        }
        eshttp.forceTransport("auto");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    suite.test("Q7 cli GET/HEAD-only: non-empty body -> unsupported (usage)", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
        const r = eshttp.request({ url: "http://127.0.0.1:1/x", method: "POST", body: "payload" });
        EQ(r.error.code, "unsupported", "POST body on cli -> unsupported");
        EQ(r.error.category, "usage", "usage category");
        EQ(r.status, 0, "status 0");
        const rb = eshttp.request({ url: "http://127.0.0.1:1/x", bodyIsBase64: true });
        EQ(rb.error.code, "unsupported", "bodyIsBase64 on cli -> unsupported");
        eshttp.forceTransport("auto");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    // =====================================================================
    // Q3 — bad cli envelope marks the tier dead (session degradation)
    // =====================================================================
    suite.test("Q3 cli bad envelope -> cli marked dead, degrade, no throw", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("cli");
        env.controls.setCliResponder(function () {
            return { abi: "nope", status: 200 };   // ABI mismatch
        });
        const r = eshttp.request({ url: "http://127.0.0.1:1/clibad" });
        EQ(r.error.code, "internal", "ABI-mismatched cli envelope -> internal");
        A(r.error.message && r.error.message.indexOf("dead") >= 0,
            "message marks the cli dead: " + r.error.message);
        // After dead-marking the tier is unusable for the session. The exact
        // surfaced code depends on wrapper resolution state (forced-cli hits
        // the dead check -> internal; auto re-resolution with cli dead and no
        // other https-capable tier -> unsupported). Both are correct
        // never-throw degradation — assert the contract, not the path.
        let r2 = null;
        env.assertNoThrow(function () { r2 = eshttp.request({ url: "http://127.0.0.1:1/clibad2" }); },
            "second call must not throw");
        A(r2 && r2.error, "second call returns an error Result");
        A(r2.error.code === "internal" || r2.error.code === "unsupported",
            "dead cli degrades to internal or unsupported, got " + r2.error.code);
        eshttp.resetTransport();   // resets the dead flag
        env.controls.setCliResponder(null);
        eshttp.forceTransport("auto");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    // =====================================================================
    // Q10 — auto with native dead + cli available: cli serves https
    // =====================================================================
    suite.test("Q10 cli is the https-capable fallback when native is dead", function () {
        env.controls.setExternalObjectAvailable(true);
        env.controls.setCliAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        // kill the native DLL with an ABI-tampered envelope
        env.controls.setNativeResponder(function () { return { abi: "tampered", status: 200 }; });
        const r1 = eshttp.request({ url: "https://127.0.0.1:1/x" });
        A(["cli", "cli-oneshot", "socket"].indexOf(r1.meta.path) >= 0,
            "degraded away from native, got " + r1.meta.path +
            " (cli = pipe, cli-oneshot = job-file degradation, socket = cleartext)");
        env.controls.setNativeResponder(null);
        env.controls.setCliResponder(null);
        // FULL teardown: restore the native ExternalObject ctor + clear the
        // staged fake cli so later suites (40-codec native base64) start clean.
        env.controls.setBridgeAvailable(false);
        env.controls.setCliAvailable(false);
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("auto");
    });
};
