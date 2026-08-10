/*
 * 00-selftest.js — Q2: eshttp._selftest() runs green.
 * The jsxinc ships 30+ pure-helper checks (JSON, URL, query, headers, HTTP
 * parse, base64, UTF-8, error consts). The harness headless-runs them with
 * __noNetwork semantics (the helpers are pure — no I/O at all).
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;

    suite.test("Q2 _selftest() returns {pass:true} with 30+ checks", function () {
        const r = eshttp._selftest();
        env.assert(r, "_selftest returned a result");
        env.assertEq(r.pass, true, "_selftest must pass");
        env.assert(r.tests.length >= 30, "expected >= 30 checks, got " + r.tests.length);
    });

    suite.test("Q2 every individual selftest check is ok", function () {
        const r = eshttp._selftest();
        const bad = [];
        for (let i = 0; i < r.tests.length; i++) {
            if (!r.tests[i].ok) { bad.push(r.tests[i].name); }
        }
        env.assertEq(bad.length, 0, "failing checks: " + JSON.stringify(bad));
    });

    suite.test("Q2 helper surface exposed for the headless harness", function () {
        const h = eshttp.helpers;
        const expected = ["jsonParse", "jsonStringify", "base64Encode", "base64Decode",
            "utf8Encode", "utf8Decode", "utf8ByteLength", "parseUrl", "urlString",
            "buildQuery", "encComponent", "normalizeRequestHeaders", "parseResponseHeaders",
            "parseHttpResponse", "dechunk", "resolveUrl", "mkError"];
        for (const k of expected) {
            env.assert(typeof h[k] === "function", "helper missing: " + k);
        }
    });

    suite.test("Q2 _selftest is deterministic across runs", function () {
        const a = eshttp._selftest();
        const b = eshttp._selftest();
        env.assertEq(a.pass, b.pass, "selftest must be deterministic");
        env.assertEq(a.tests.length, b.tests.length, "selftest count must be stable");
    });
};
