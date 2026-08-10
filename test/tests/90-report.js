/*
 * 90-report.js — Q12: the suite is self-documenting and reproducible.
 * ==================================================================
 * Q12 requires "results documented with pass/fail per file; a single
 * runnable command produces the report". These tests assert that the
 * reporting contract itself holds, so Q12 can never be claimed green by
 * assertion alone:
 *
 *   - the single documented command exists and is wired (package.json)
 *   - the QA infrastructure files the report depends on are all present
 *   - test/REPORT.md is produced by a run and is FRESH (not a stale
 *     artifact committed by hand)
 *   - the report contains a per-suite pass/fail breakdown and the full
 *     Q1-Q12 matrix
 *
 * The freshness check reads the report left by the PREVIOUS run (the
 * current run writes its own copy after all suites finish), so on a first
 * ever run the file may be absent — that is reported as an explicit,
 * actionable failure rather than a silent pass.
 *
 * This file is QA infrastructure only — NOT part of the eshttp library.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const TEST_DIR = path.join(__dirname, "..");
const ROOT = path.join(TEST_DIR, "..");
const REPORT = path.join(TEST_DIR, "REPORT.md");

module.exports = function (suite, env) {
    const A = env.assert;
    const EQ = env.assertEq;

    suite.test("Q12 single runnable command is declared in package.json", function () {
        const pkgPath = path.join(ROOT, "package.json");
        A(fs.existsSync(pkgPath),
            "eshttp/package.json must exist — it also pins \"type\":\"commonjs\" so the " +
            "Node harness boots under a workspace root that declares \"type\":\"module\"");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        EQ(pkg.type, "commonjs", "harness requires CommonJS module resolution");
        A(pkg.scripts && pkg.scripts.test, "a `test` script must exist");
        A(pkg.scripts.test.indexOf("harness.js") >= 0, "test script runs the harness: " + pkg.scripts.test);
        A(pkg.scripts.test.indexOf("--all") >= 0,
            "the documented command must be the self-contained --all mode: " + pkg.scripts.test);
    });

    suite.test("Q12 QA infrastructure files are all present", function () {
        const required = [
            "harness.js",        // Q1 headless ES3 runner
            "mock-server.js",    // Q4/Q8 local cleartext HTTP
            "tcp-client.js",     // synchronous TCP bridge for the ES3 Socket stub
            "README.md",         // Q12 human-facing documentation
            path.join("tests", "00-selftest.js"),
            path.join("tests", "10-headless.js"),
            path.join("tests", "20-native-abi.js"),
            path.join("tests", "30-socket-wire.js"),
            path.join("tests", "50-artifact-contract.js")
        ];
        for (const f of required) {
            A(fs.existsSync(path.join(TEST_DIR, f)), "missing QA file: test/" + f.replace(/\\/g, "/"));
        }
    });

    suite.test("Q12 library source is untouched by the QA suite (no test shims in src/)", function () {
        // QA must never patch the library to make itself pass. After the TS
        // rewrite the real source is src/*.ts (ES3 is enforced on the BUILT
        // dist/eshttp.jsx artifact — see 50-artifact-contract.js); the old
        // src/eshttp.jsxinc, when present, is a generated include-compat copy.
        const srcDir = path.join(ROOT, "src");
        const tsFiles = fs.readdirSync(srcDir).filter((f) => /\.ts$/.test(f));
        A(tsFiles.length > 0, "src/ must contain TypeScript modules (src/*.ts)");
        const jsxinc = path.join(srcDir, "eshttp.jsxinc");
        if (fs.existsSync(jsxinc)) {
            const src = fs.readFileSync(jsxinc, "utf8");
            A(src.indexOf("require(") < 0, "jsxinc must not require() anything (ES3 / no Node)");
            A(src.indexOf("module.exports") < 0, "jsxinc must not use CommonJS exports");
        }
        for (const f of tsFiles) {
            const src = fs.readFileSync(path.join(srcDir, f), "utf8");
            A(src.indexOf("require(") < 0, f + " must not require() anything (no Node deps)");
            A(src.indexOf("module.exports") < 0, f + " must not use CommonJS exports");
        }
    });

    // The report artifact is produced by the full acceptance run. A headless
    // run deliberately leaves it untouched (it cannot cover Q4/Q8), so the
    // report assertions below only apply when the network suites ran.
    const reportChecks = env.net ? suite.test : function (label, fn) {
        suite.knownIssue("SKIP-NONET",
            "report validation needs the full run: `node test/harness.js --all`",
            label, function () {
                throw new Error("headless mode does not regenerate REPORT.md");
            });
    };

    reportChecks("Q12 report artifact exists and documents per-suite pass/fail", function () {
        A(fs.existsSync(REPORT),
            "test/REPORT.md not found — run `node test/harness.js --all` once to generate it");
        const md = fs.readFileSync(REPORT, "utf8");
        A(md.indexOf("# eshttp QA — Test Report") === 0, "report has the expected title");
        A(md.indexOf("## Per-suite results") > 0, "report has a per-suite section");
        A(md.indexOf("## Q1–Q12 acceptance matrix") > 0, "report has the acceptance matrix");
        A(md.indexOf("00-selftest.js") > 0, "selftest suite appears in the report");
        A(md.indexOf("30-socket-wire.js") > 0, "socket wire suite appears in the report");
        A(md.indexOf("node test/harness.js --all") > 0, "report documents the reproduction command");
    });

    reportChecks("Q12 report matrix covers every acceptance item Q1-Q12", function () {
        A(fs.existsSync(REPORT), "test/REPORT.md not found — run the harness once");
        const md = fs.readFileSync(REPORT, "utf8");
        // Q1-Q11 must already show real coverage. Q12 is THIS suite, whose
        // results are only known after it finishes, so the report being
        // validated here still has it pending — assert the row exists and let
        // the final write record its verdict.
        for (let i = 1; i <= 11; i++) {
            const q = "Q" + i;
            const row = new RegExp("^\\| " + q + " \\| ([A-Z ]+?) \\|", "m").exec(md);
            A(row, "acceptance matrix is missing a row for " + q);
            EQ(row[1].trim(), "PASS", q + " must be PASS in the report, found: " + row[1].trim());
        }
        A(/^\| Q12 \| /m.test(md), "acceptance matrix is missing the Q12 row");
    });

    reportChecks("Q12 report is regenerated by the run (freshness, not a stale artifact)", function () {
        A(fs.existsSync(REPORT), "test/REPORT.md not found — run the harness once");
        const ageMs = Date.now() - fs.statSync(REPORT).mtimeMs;
        const TWO_DAYS = 48 * 60 * 60 * 1000;
        A(ageMs < TWO_DAYS,
            "test/REPORT.md is stale (" + Math.round(ageMs / 3600000) + "h old). It must be " +
            "regenerated by `node test/harness.js --all`, never hand-maintained.");
    });

    suite.test("Q12 harness exposes the documented run modes", function () {
        const h = fs.readFileSync(path.join(TEST_DIR, "harness.js"), "utf8");
        A(h.indexOf("--all") > 0, "--all mode documented");
        A(h.indexOf("--net") > 0, "--net mode documented");
        A(h.indexOf("--base") > 0, "--base override documented");
        A(h.indexOf("--cross") > 0, "--cross override documented");
        A(h.indexOf("writeReportFile") > 0, "harness writes the report artifact");
    });

    suite.test("Q12 test/README.md documents the command, layout and Q-mapping", function () {
        const readme = fs.readFileSync(path.join(TEST_DIR, "README.md"), "utf8");
        A(readme.indexOf("node test/harness.js --all") > 0, "documents the single command");
        A(readme.indexOf("REPORT.md") > 0, "documents the report artifact");
        for (const f of ["00-selftest.js", "10-headless.js", "20-native-abi.js", "30-socket-wire.js", "90-report.js"]) {
            A(readme.indexOf(f) > 0, "README documents the suite file " + f);
        }
        for (let i = 1; i <= 12; i++) {
            A(readme.indexOf("Q" + i) > 0, "README maps acceptance item Q" + i);
        }
    });
};
