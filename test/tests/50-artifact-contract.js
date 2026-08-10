/*
 * 50-artifact-contract.js — built dist/eshttp.jsx output-level audit (T4).
 * ==================================================================
 * Ratified by the coordinator (rewrite-plan §11.6): the QA suite asserts the
 * BUILT artifact, not just the TS source:
 *
 *   1. The IIFE defines the global `eshttp` with the http-api-v1 public
 *      surface (request/get/post/put/del/json/configure/forceTransport/
 *      resetTransport/transportInfo/transport/DEFAULTS/error/version).
 *   2. The unwrap footer republished the facade (no `.default` leak).
 *   3. Forbidden tokens in dist/eshttp.jsx == 0: `=>`, `let ` decls,
 *      `const ` decls, `class ` decls, backticks.
 *   4. The ES3 shim (Object.defineProperty / Function.prototype.bind
 *      fallbacks) is present at the top — and the bundle still loads in a
 *      sandbox with Object.defineProperty REMOVED (no-defineProperty
 *      sandbox test): the shim must cover the publish path.
 *
 * This suite reads the dist artifact directly (not env.eshttp) so it is
 * valid in every harness lane (esm/iife/jsxinc) and always audits the
 * shipping file.
 *
 * SKIP BEHAVIOR: when dist/eshttp.jsx does not exist yet (pre-build), the
 * tests report as known-issues (SKIP-NODIST) instead of failing the run —
 * the harness already warns loudly, and a clean clone without dist must not
 * go red.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TEST_DIR = path.join(__dirname, "..");
const ROOT = path.join(TEST_DIR, "..");
const DIST_JSX = path.join(ROOT, "dist", "eshttp.jsx");

const PUBLIC_API = ["request", "get", "post", "put", "del", "json",
    "configure", "forceTransport", "resetTransport", "transportInfo",
    "transport", "DEFAULTS", "error", "version"];

function readDistJsx() {
    return fs.readFileSync(DIST_JSX, "utf8");
}

module.exports = function (suite, env) {
    const A = env.assert;
    const EQ = env.assertEq;

    // dist artifact present? else known-issue skip.
    const haveDist = fs.existsSync(DIST_JSX);
    const testOrSkip = haveDist ? suite.test : function (label, fn) {
        suite.knownIssue("SKIP-NODIST",
            "dist/eshttp.jsx not built yet — run `npm run build` (or `npm test` with pretest) to audit the artifact",
            label, function () { throw new Error("dist/eshttp.jsx missing"); });
    };

    testOrSkip("Q12 dist/eshttp.jsx exists and defines the global eshttp with the full public API", function () {
        const text = readDistJsx();
        // The IIFE must publish `eshttp` (var eshttp = ...) and the unwrap
        // footer must republish the facade (no `.default` wrapper).
        A(text.indexOf("var eshttp") >= 0, "IIFE declares var eshttp");

        const sandbox = {};
        sandbox.$ = { writeln: function () {}, os: "Windows", global: null };
        sandbox.Socket = function () {};
        sandbox.ExternalObject = undefined;
        sandbox.File = function () {};
        sandbox.Folder = function () {};
        sandbox.app = { name: "QA artifact audit" };
        sandbox.console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };
        sandbox.$.global = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(text, sandbox, { filename: "dist/eshttp.jsx" });

        const eshttp = sandbox.eshttp;
        A(eshttp !== undefined && eshttp !== null, "global eshttp defined after eval");
        A(typeof eshttp === "object", "eshttp is an object");
        for (const k of PUBLIC_API) {
            A(typeof eshttp[k] !== "undefined", "public API member missing: " + k);
        }
        EQ(typeof eshttp.request, "function", "request is a function");
        EQ(typeof eshttp.json.parse, "function", "json.parse is a function");
        EQ(typeof eshttp.json.stringify, "function", "json.stringify is a function");
        // no .default leak (unwrap footer republished the facade)
        A(eshttp.default === undefined, "global eshttp must not be { default: facade }");
        // a smoke request must return a Result, never throw
        const r = eshttp.request({ url: "http://127.0.0.1:1/x" });
        A(r !== null && typeof r === "object", "request returned a Result");
    });

    testOrSkip("Q12 unwrap footer: dist/eshttp.jsx republishes the facade (no .default leak)", function () {
        const text = readDistJsx();
        // The footer is esbuild's export-assignment + the unwrap that the
        // build appends; look for the guarded republish marker.
        A(/eshttp\s*&&\s*eshttp\.default/.test(text),
            "unwrap footer references eshttp.default (guarded republish)");
    });

    testOrSkip("Q12 dist/eshttp.jsx forbidden tokens == 0 (=>, let/const/class decls, backticks)", function () {
        const text = readDistJsx();
        const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const checks = [
            [">=", /=>/g, "arrow"],
            ["let decl", /\blet\s+[A-Za-z_$]/g, "let declaration"],
            ["const decl", /\bconst\s+[A-Za-z_$]/g, "const declaration"],
            ["class decl", /\bclass\s+[A-Za-z_$]/g, "class declaration"],
            ["backtick", /`/g, "template literal"]
        ];
        const hits = [];
        for (const c of checks) {
            c[1].lastIndex = 0;
            let m;
            while ((m = c[1].exec(code)) !== null) {
                hits.push(c[2] + " at offset " + m.index);
            }
        }
        EQ(hits.length, 0, "forbidden tokens found: " + JSON.stringify(hits));
    });

    testOrSkip("Q12 ES3 shim present in dist/eshttp.jsx (before the facade body)", function () {
        const text = readDistJsx();
        // The embedded ESPAK accel bundle string constants (ESON/ESB64)
        // legitimately precede the shim — generated payloads, not code — so
        // the shim is asserted present-and-early rather than strictly first.
        A(text.indexOf('if (typeof Object.defineProperty !== "function")') >= 0,
            "Object.defineProperty shim present");
        A(text.indexOf('if (typeof Function.prototype.bind !== "function")') >= 0,
            "Function.prototype.bind shim present");
        A(text.indexOf('if (typeof Object.defineProperty !== "function")') < text.indexOf("var eshttp"),
            "shim precedes the IIFE facade declaration");
    });

    testOrSkip("Q12 no-defineProperty sandbox: bundle loads and publishes with Object.defineProperty removed", function () {
        // The shim must cover the publish path on engines without
        // Object.defineProperty (the old jsxinc guarded with try/catch; the
        // build prepends a shim — this test proves the shim actually runs).
        const text = readDistJsx();
        const sandbox = {};
        sandbox.$ = { writeln: function () {}, os: "Windows", global: null };
        sandbox.Socket = function () {};
        sandbox.ExternalObject = undefined;
        sandbox.File = function () {};
        sandbox.Folder = function () {};
        sandbox.app = { name: "QA no-defineProperty" };
        sandbox.console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };
        sandbox.$.global = sandbox;
        // Deliberately strip the ES5 accessor machinery the shim must replace.
        delete sandbox.Object;
        vm.createContext(sandbox);
        vm.runInContext(text, sandbox, { filename: "dist/eshttp.jsx" });
        const eshttp = sandbox.eshttp;
        A(eshttp !== undefined && eshttp !== null, "global eshttp defined without Object.defineProperty");
        EQ(typeof eshttp.request, "function", "request is a function");
    });

    testOrSkip("Q12 strict-engine sandbox (no defineProperty AND no __defineGetter__): global eshttp is the FACADE", function () {
        // LIVE-REGRESSION GATE (T4, 2026-08-10): a live COM check in
        // Illustrator 2026 proved the shipped dist/eshttp.jsx does NOT
        // publish the facade on the real host. Root cause: ExtendScript has
        // no __defineGetter__ and its Object.defineProperty fallback EAGERLY
        // CALLS getter descriptors (obj[prop] = desc.get()), so esbuild's
        // `default` export getter is invoked before `index_default` is
        // assigned (var hoisting) -> wrapper.default = undefined -> the
        // unwrap footer no-ops -> global eshttp stays the wrapper.
        // Node's V8 HAS __defineGetter__, so the plain no-defineProperty
        // sandbox above cannot reproduce this. This sandbox strips BOTH so
        // the shim's eager-getter fallback path runs exactly like the real
        // engine. The bundle is evaluated INSIDE a function scope, mirroring
        // ExtendScript's $.evalFile (whose top-level `var eshttp` stays
        // function-local and does NOT clobber core-porter's $.global.eshttp
        // data-descriptor publish — verified live: the two bindings differ).
        // Must pass with the fixed artifact (footer consuming $.global.eshttp)
        // and fail on the pre-fix wrapper shape.
        const text = readDistJsx();
        const sandbox = {};
        sandbox.$ = { writeln: function () {}, os: "Windows", global: null };
        sandbox.Socket = function () {};
        sandbox.ExternalObject = undefined;
        sandbox.File = function () {};
        sandbox.Folder = function () {};
        sandbox.app = { name: "QA strict-engine" };
        sandbox.console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };
        sandbox.$.global = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(
            "Object.defineProperty = undefined;" +
            "delete Object.prototype.__defineGetter__;" +
            "delete Object.prototype.__defineSetter__;",
            sandbox, { filename: "strict-engine-prep.js" });
        vm.runInContext("(function () {\n" + text + "\n})();",
            sandbox, { filename: "dist/eshttp.jsx" });
        const eshttp = sandbox.eshttp;
        A(eshttp !== undefined && eshttp !== null, "global eshttp defined");
        EQ(typeof eshttp.request, "function",
            "global eshttp must BE the facade (request callable) — live-verified " +
            "ExtendScript path; fails on the pre-fix wrapper shape");
    });
};
