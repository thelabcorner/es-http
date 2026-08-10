/*
 * harness.js — headless ES3 runner for the eshttp QA suite.
 * ==================================================================
 * Loads the eshttp core (TypeScript build, esb64-style) inside a Node
 * sandbox that provides the ExtendScript globals the library needs, so
 * the ENTIRE library runs unmodified without any Adobe host. The core is
 * loaded by test/load-core.mjs from one of three sources:
 *
 *   - "esm"    dist/eshttp-core.esm.mjs   (ESM core bundle — the primary
 *              suite target after the TS rewrite; facade is the module's
 *              default export, staged on globalThis)
 *   - "iife"   dist/eshttp.jsx            (the built IIFE artifact — vm
 *              sandbox verification lane for the shipping file)
 *   - "jsxinc" src/eshttp.jsxinc          (ORIGINAL pre-rewrite baseline)
 *
 * Selection: ESHTTP_CORE env var, --core <esm|iife|jsxinc>, or default
 * (esm when dist/eshttp-core.esm.mjs exists, jsxinc otherwise).
 *
 * The sandbox provides: $ (writeln/os/global), Socket (sync TCP stub backed
 * by test/tcp-client.js — REAL HTTP/1.1 wire I/O), ExternalObject
 * (configurable fake eshttp.dll: version/available/request/free/last_error
 * — drives the native path), File/Folder (shape stubs), app (host name).
 *
 * The test hooks are exercised directly: eshttp.__noNetwork, eshttp.helpers,
 * eshttp._drivers, eshttp._setDriver, eshttp._selftest().
 *
 * RUN IT
 *   node test/harness.js            # headless suites only
 *   node test/harness.js --net      # + socket suites against external mock
 *                                   #   servers (--base/--cross, default
 *                                   #   http://127.0.0.1:18080 / :18081)
 *   node test/harness.js --all      # spawn both mock servers, run EVERYTHING
 *                                   #   (single command, recommended for CI)
 *   node test/harness.js --all --core jsxinc   # baseline vs old source
 *
 * Exit code 0 = all tests pass (known-issue findings do not fail the run,
 * but are listed loudly). Exit code 1 = at least one unexpected failure.
 *
 * This file is QA infrastructure only — NOT part of the eshttp library.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTS_DIR = path.join(__dirname, "tests");
const loadCoreModule = require("./load-core.mjs");

// ===========================================================================
// 1. Core loader (shared with test/parity/*.mjs)
// ===========================================================================
// loadCore({ source }) loads the suite-under-test core and returns
// { eshttp, controls, source, file, cleanup? }:
//   - eshttp    the facade object (public API + test hooks)
//   - controls  nativeState / setNativeResponder / setExternalObjectAvailable
//               / setSocketAvailable (fake eshttp.dll + transport toggling)
//   - source    "esm" | "iife" | "jsxinc" (what was actually loaded)
// The vm-sandbox and globalThis staging live in load-core.mjs; the harness
// only consumes the loaded facade, so test/tests/*.js stay source-agnostic.
// ===========================================================================
async function loadCore(options) {
    return loadCoreModule.loadCore(options);
}


// ===========================================================================
// 3. Minimal test framework
// ===========================================================================
function assert(cond, msg) {
    if (!cond) { throw new Error(msg || "assertion failed"); }
}
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error((msg || "equality failed") + " — expected " +
            JSON.stringify(expected) + ", got " + JSON.stringify(actual));
    }
}
function assertNoThrow(fn, msg) {
    try { fn(); } catch (e) {
        throw new Error((msg || "unexpected throw") + ": " + (e && e.stack ? e.stack : e));
    }
}
function assertThrows(fn, msg) {
    try { fn(); } catch (e) { return e; }
    throw new Error((msg || "expected a throw") + " — nothing was thrown");
}

function createSuite(name) {
    const tests = [];
    const suite = {
        name: name,
        test: function (label, fn) { tests.push({ label: label, fn: fn }); },
        knownIssue: function (ref, reason, label, fn) {
            tests.push({ label: label, fn: fn, knownIssue: ref, reason: reason });
        },
        getTests: function () { return tests; }
    };
    return suite;
}

async function runSuite(suite, env) {
    const results = [];
    for (const t of suite.getTests()) {
        let ok = false;
        let error = null;
        try {
            await t.fn(env);
            ok = true;
        } catch (e) {
            error = e && e.message ? e.message : String(e);
        }
        results.push({ label: t.label, ok: ok, error: error, knownIssue: t.knownIssue || null, reason: t.reason || null });
    }
    return { name: suite.name, results: results };
}

// ===========================================================================
// 4. Suite loading
// ===========================================================================
function loadSuites() {
    const files = fs.readdirSync(TESTS_DIR)
        .filter((f) => /\.js$/.test(f))
        .sort();
    return files.map((f) => ({ file: f, module: require(path.join(TESTS_DIR, f)) }));
}

// ===========================================================================
// 5. Mock server lifecycle (--all mode)
// ===========================================================================
function waitForListening(child, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error("mock server '" + name + "' did not report listening in time")); }, 15000);
        let buf = "";
        child.stdout.on("data", (d) => {
            buf += d.toString("utf8");
            const idx = buf.indexOf("\n");
            if (idx >= 0) {
                const line = buf.slice(0, idx).trim();
                if (line.indexOf("ESHTTP_MOCK_LISTENING") === 0) {
                    clearTimeout(timer);
                    const port = parseInt(/port=(\d+)/.exec(line)[1], 10);
                    resolve({ child: child, port: port, url: "http://127.0.0.1:" + port });
                }
            }
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error("mock server '" + name + "' exited early (code " + code + ")"));
        });
    });
}

async function spawnMockServers() {
    const crossChild = spawn(process.execPath, [path.join(__dirname, "mock-server.js"), "--name", "cross", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const cross = await waitForListening(crossChild, "cross");
    const mainChild = spawn(process.execPath, [path.join(__dirname, "mock-server.js"), "--name", "main", "--port", "0", "--crossPort", String(cross.port)], { stdio: ["ignore", "pipe", "inherit"] });
    const main = await waitForListening(mainChild, "main");
    return { main: main, cross: cross };
}

// ===========================================================================
// 6. HTTP helpers for inspecting the server request log (Q4 assertions)
// ===========================================================================
function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const http = require("http");
        http.get(url, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
                catch (e) { reject(new Error("bad JSON from " + url)); }
            });
        }).on("error", reject);
    });
}
function httpPost(url) {
    return new Promise((resolve, reject) => {
        const http = require("http");
        const req = http.request(url, { method: "POST" }, (res) => {
            res.resume();
            res.on("end", resolve);
        });
        req.on("error", reject);
        req.end();
    });
}
async function resetServerLogs(mainUrl, crossUrl) {
    await httpPost(mainUrl + "/__reset");
    await httpPost(crossUrl + "/__reset");
}
async function fetchLogs(mainUrl, crossUrl) {
    const main = await httpGetJson(mainUrl + "/__requests");
    const cross = await httpGetJson(crossUrl + "/__requests");
    return { main: main.requests, cross: cross.requests };
}

// ===========================================================================
// 7. Main
// ===========================================================================
// Pick the suite-under-test source: --core flag wins, then ESHTTP_CORE env,
// then "auto" (loader default: esm when dist exists, jsxinc otherwise).
function pickCoreSource(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--core" && args[i + 1]) {
            const v = String(args[i + 1]).toLowerCase();
            if (v === "esm" || v === "iife" || v === "jsxinc") { return v; }
            process.stdout.write("[harness] WARNING: unknown --core '" + v + "' (esm|iife|jsxinc); using auto\n");
            return "auto";
        }
    }
    if (process.env.ESHTTP_CORE) {
        const v = String(process.env.ESHTTP_CORE).toLowerCase();
        if (v === "esm" || v === "iife" || v === "jsxinc") { return v; }
    }
    return "auto";
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args.indexOf("--all") >= 0 ? "all"
               : args.indexOf("--net") >= 0 ? "net"
               : "headless";

    let baseUrl = "http://127.0.0.1:18080";
    let crossUrl = "http://127.0.0.1:18081";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--base") { baseUrl = args[i + 1]; }
        if (args[i] === "--cross") { crossUrl = args[i + 1]; }
    }

    let spawned = null;
    if (mode === "all") {
        process.stdout.write("[harness] spawning mock servers (main+cross)\n");
        spawned = await spawnMockServers();
        baseUrl = spawned.main.url;
        crossUrl = spawned.cross.url;
    }
    process.stdout.write("[harness] mode=" + mode + " base=" + baseUrl + " cross=" + crossUrl + "\n");

    // --- build the sandbox + load the core --------------------------------
    const coreSource = pickCoreSource(args);
    process.stdout.write("[harness] core source: " + coreSource + "\n");
    const loaded = await loadCore({ source: coreSource === "auto" ? undefined : coreSource });
    const eshttp = loaded.eshttp;
    const controls = loaded.controls;
    const sandbox = loaded.sandbox || null;
    eshttp.__noNetwork = false;

    const env = {
        eshttp: eshttp,
        sandbox: sandbox,
        coreSource: loaded.source,
        controls: controls,
        base: baseUrl,
        cross: crossUrl,
        net: mode === "all" || mode === "net",
        assert: assert,
        assertEq: assertEq,
        assertNoThrow: assertNoThrow,
        assertThrows: assertThrows,
        httpGetJson: httpGetJson,
        resetServerLogs: function () { return resetServerLogs(baseUrl, crossUrl); },
        fetchLogs: function () { return fetchLogs(baseUrl, crossUrl); }
    };

    // --- run all suites ---------------------------------------------------
    const suiteFiles = loadSuites();
    const reports = [];
    for (const sf of suiteFiles) {
        // Fresh transport state per suite: no forced transport, no native
        // cache, network enabled. Also reset the ExternalObject staging to
        // the canonical NATIVE ctor (bridge/cli tests stage the eshttp-ipc
        // bridge or fake exe; a suite must not inherit another suite's
        // ExternalObject — otherwise native-lane suites (40-codec) see a
        // bridge lacking eshttp_request and break).
        eshttp.resetTransport();
        if (controls && typeof controls.resetNativeCache === "function") {
            controls.resetNativeCache();
        }
        if (controls && typeof controls.setBridgeAvailable === "function") {
            controls.setBridgeAvailable(false);
        }
        if (controls && typeof controls.setCliAvailable === "function") {
            controls.setCliAvailable(false);
        }
        if (controls && typeof controls.setExternalObjectAvailable === "function") {
            controls.setExternalObjectAvailable(true);
        }
        eshttp.__noNetwork = false;
        const suite = createSuite(sf.file);
        try {
            sf.module(suite, env);
        } catch (e) {
            suite.test("suite load error", function () { throw new Error("failed to define suite: " + e.message); });
        }
        reports.push(await runSuite(suite, env));
        // Write an interim report after every suite so that the Q12
        // reporting meta-suite (which runs last) always has a FRESH report
        // from THIS run to validate — the suite is green on a clean clone,
        // with no committed artifact and no throwaway warm-up run. The
        // final, complete report is written again once every suite is done.
        // Headless mode cannot cover the network items, so it must never
        // overwrite a full report with a partial one.
        if (mode !== "headless") { writeReportFile(reports, mode, null); }
    }

    if (spawned) {
        spawned.main.child.kill();
        spawned.cross.child.kill();
        process.stdout.write("[harness] mock servers stopped\n");
    }

    // Post-run cli restore (T10/T11 contract): the cli suite leaves the fake
    // eshttp-cli.exe staged at %LOCALAPPDATA%\eshttp\ with the real binary in
    // .harness-bak. Restore the real artifact so the staged runtime path is
    // left as the pipeline staged it — never the harness shim.
    try {
        if (controls && typeof controls.setCliAvailable === "function") {
            controls.setCliAvailable(false);
            process.stdout.write("[harness] cli transport: real eshttp-cli.exe restored (harness shim removed)\n");
        }
    } catch (e) {
        process.stdout.write("[harness] WARNING: cli restore failed: " + (e && e.message ? e.message : e) + "\n");
    }

    // --- report -----------------------------------------------------------
    const rc = printReport(reports, mode);
    if (mode === "headless") {
        // Partial run: the network-backed acceptance items (Q4/Q8 wire tests)
        // cannot execute, so publishing this as THE report would understate
        // coverage. Keep the last full report intact.
        process.stdout.write("[harness] headless mode: REPORT.md left untouched " +
            "(run `node test/harness.js --all` for the full acceptance report)\n");
    } else {
        writeReportFile(reports, mode, rc);
    }
    return rc;
}

// ===========================================================================
// 7b. Q12 — durable pass/fail report artifact (test/REPORT.md)
// ===========================================================================
function writeReportFile(reports, mode, rc) {
    const interim = (rc === null);
    const stamp = new Date().toISOString();
    const qmap = collectQMap(reports);
    let total = 0, pass = 0, fail = 0, known = 0;
    for (const rep of reports) {
        for (const r of rep.results) {
            total++;
            if (r.ok) { pass++; } else if (r.knownIssue) { known++; } else { fail++; }
        }
    }

    const L = [];
    L.push("# eshttp QA — Test Report");
    L.push("");
    L.push("_Generated by `node test/harness.js --all` — do not edit by hand._");
    L.push("");
    L.push("- Generated: `" + stamp + "`");
    L.push("- Mode: `" + mode + "`");
    L.push("- Node: `" + process.version + "` on `" + process.platform + "`");
    L.push("- Result: **" + (interim ? "IN PROGRESS" : (rc === 0 ? "PASS" : "FAIL")) +
        "**" + (interim ? " (run did not finish — rerun `node test/harness.js --all`)" : " (exit code " + rc + ")"));
    L.push("- Totals: **" + pass + " pass**, **" + fail + " fail**, **" + known + " known-issue** of " + total + " assertions across " + reports.length + " suites");
    L.push("");
    L.push("## Q1–Q12 acceptance matrix (review/integration-checklist.md t3)");
    L.push("");
    L.push("| Item | Status | Pass | Fail | Known-issue |");
    L.push("|------|--------|------|------|-------------|");
    for (const q of Q_ORDER) {
        const e = qmap[q];
        if (!e) { L.push("| " + q + " | NO TESTS | 0 | 0 | 0 |"); continue; }
        const st = e.fail > 0 ? "FAIL" : (e.pass > 0 ? "PASS" : "NO-PASS");
        L.push("| " + q + " | " + st + " | " + e.pass + " | " + e.fail + " | " + e.known + " |");
    }
    L.push("");
    L.push("## Per-suite results");
    L.push("");
    for (const rep of reports) {
        let p = 0, f = 0, k = 0;
        for (const r of rep.results) {
            if (r.ok) { p++; } else if (r.knownIssue) { k++; } else { f++; }
        }
        const st = f > 0 ? "FAIL" : (k > 0 ? "KNOWN-ISSUES" : "PASS");
        L.push("### `" + rep.name + "` — " + st + " (" + p + " pass, " + f + " fail, " + k + " known-issue)");
        L.push("");
        for (const r of rep.results) {
            const mark = r.ok ? "PASS" : (r.knownIssue ? "KNOWN" : "FAIL");
            L.push("- **" + mark + "** " + r.label +
                (r.ok ? "" : (r.knownIssue ? "  \n  _known issue " + r.knownIssue + ": " + r.reason + "_" : "") +
                    (r.error ? "  \n  `" + String(r.error).replace(/`/g, "'").split("\n")[0] + "`" : "")));
        }
        L.push("");
    }
    if (known > 0) {
        L.push("## Open known issues");
        L.push("");
        for (const rep of reports) {
            for (const r of rep.results) {
                if (r.knownIssue && !r.ok) {
                    L.push("- **" + r.knownIssue + "** — " + r.reason + "  \n  _test:_ `" + r.label + "` (`" + rep.name + "`)");
                }
            }
        }
        L.push("");
    }
    L.push("## How to reproduce");
    L.push("");
    L.push("```");
    L.push("cd eshttp");
    L.push("node test/harness.js --all      # spawns both mock servers, runs everything, writes this file");
    L.push("```");
    L.push("");
    L.push("Exit code `0` = every acceptance item green. Known issues are listed");
    L.push("loudly but do not fail the run; an unexpected failure or a Q-item with");
    L.push("no coverage returns `1`.");
    L.push("");

    const out = path.join(__dirname, "REPORT.md");
    try {
        fs.writeFileSync(out, L.join("\n"), "utf8");
        if (!interim) { process.stdout.write("[harness] report written: " + out + "\n"); }
    } catch (e) {
        process.stdout.write("[harness] WARNING: could not write report: " + e.message + "\n");
    }
}

const Q_ORDER = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10", "Q11", "Q12"];

function collectQMap(reports) {
    const qmap = {};
    for (const rep of reports) {
        for (const r of rep.results) {
            const q = /^(Q\d+)\s/.exec(r.label);
            if (!q) { continue; }
            qmap[q[1]] = qmap[q[1]] || { pass: 0, fail: 0, known: 0, labels: [] };
            const qe = qmap[q[1]];
            if (r.ok) { qe.pass++; } else if (r.knownIssue) { qe.known++; } else { qe.fail++; }
            qe.labels.push(r.label);
        }
    }
    return qmap;
}

function printReport(reports, mode) {
    let pass = 0, fail = 0, known = 0;
    const qmap = collectQMap(reports);
    process.stdout.write("\n================ eshttp QA — per-suite results ================\n");
    for (const rep of reports) {
        let p = 0, f = 0, k = 0;
        const lines = [];
        for (const r of rep.results) {
            if (r.ok) { p++; pass++; }
            else if (r.knownIssue) { k++; known++; }
            else { f++; fail++; }
            if (!r.ok) {
                lines.push("  FAIL " + r.label + (r.knownIssue ? "  [KNOWN-ISSUE " + r.knownIssue + ": " + r.reason + "]" : "") + (r.error ? "  -> " + r.error : ""));
            }
        }
        process.stdout.write("[" + rep.name + "] " + p + " pass, " + f + " fail, " + k + " known-issue\n");
        for (const l of lines) { process.stdout.write(l + "\n"); }
    }

    process.stdout.write("\n================ eshttp QA — Q1-Q12 checklist matrix ================\n");
    const qOrder = Q_ORDER;
    let qGateFail = 0;
    for (const q of qOrder) {
        const e = qmap[q];
        if (!e) {
            process.stdout.write(q + "  NO TESTS\n");
            qGateFail++;
            continue;
        }
        const status = e.fail > 0 ? "FAIL" : e.pass > 0 ? "PASS" : "NO-PASS";
        if (e.fail > 0) { qGateFail++; }
        process.stdout.write(q + "  " + status + "  (" + e.pass + " pass, " + e.fail + " fail, " + e.known + " known-issue)\n");
    }

    process.stdout.write("\n================ eshttp QA — summary ================\n");
    process.stdout.write("mode: " + mode + " | suites: " + reports.length + " | PASS " + pass + " | FAIL " + fail + " | KNOWN-ISSUE " + known + "\n");
    if (known > 0) {
        process.stdout.write("KNOWN-ISSUES (open findings, do not fail the run):\n");
        for (const rep of reports) {
            for (const r of rep.results) {
                if (r.knownIssue && !r.ok) {
                    process.stdout.write("  " + r.knownIssue + ": " + r.label + " — " + r.reason + "\n");
                }
            }
        }
    }
    const rc = (fail > 0 || qGateFail > 0) ? 1 : 0;
    process.stdout.write("EXIT=" + rc + "\n");
    return rc;
}

main().then((rc) => { process.exit(rc); }).catch((e) => {
    process.stdout.write("harness crashed: " + (e && e.stack ? e.stack : e) + "\n");
    process.exit(2);
});
