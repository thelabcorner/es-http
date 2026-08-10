/*
 * 10-headless.js — headless contract tests (no network I/O required).
 * Covers: Q7 (G3 never-throw invalid-args), Q9 (error taxonomy + socket
 * producible set), Q10 (transport tiers + transportInfo), Q11 (never-throw
 * sweep), api-spec §5 json helper, §2.1 DEFAULTS/configure.
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const A = env.assert;
    const EQ = env.assertEq;

    // =====================================================================
    // Q7 — G3: request(null)/request()/request(42) return invalid-args
    // Results and NEVER throw (api-spec §2/§3). FAILS on the current draft:
    // _buildContext touches opts.method without a non-object guard.
    // =====================================================================
    suite.test("Q7 G3: request(null) returns invalid-args Result, never throws", function () {
        let result = null;
        env.assertNoThrow(function () { result = eshttp.request(null); }, "request(null) must not throw");
        A(result !== null && result.error !== null, "must return an error Result");
        EQ(result.error.code, "invalid-args", "code");
        EQ(result.status, 0, "status");
    });

    suite.test("Q7 G3: request() returns invalid-args Result, never throws", function () {
        let result = null;
        env.assertNoThrow(function () { result = eshttp.request(); }, "request() must not throw");
        A(result !== null && result.error !== null, "must return an error Result");
        EQ(result.error.code, "invalid-args", "code");
    });

    suite.test("Q7 G3: request(42) returns invalid-args Result, never throws", function () {
        let result = null;
        env.assertNoThrow(function () { result = eshttp.request(42); }, "request(42) must not throw");
        A(result !== null && result.error !== null, "must return an error Result");
        EQ(result.error.code, "invalid-args", "code");
    });

    // =====================================================================
    // Q9 — error taxonomy: constants, categories, retryable (api-spec §7)
    // =====================================================================
    suite.test("Q9 eshttp.error constants equal their code strings", function () {
        const codes = ["invalid-args", "bad-url", "invalid-header", "unsupported", "dns",
            "connect", "network", "tls", "timeout", "aborted", "too-many-redirects",
            "body-too-large", "invalid-json", "internal"];
        for (const c of codes) {
            EQ(eshttp.error[c], c, "eshttp.error." + c);
        }
    });

    suite.test("Q9 helpers.mkError emits category + retryable per api-spec §7", function () {
        const mk = eshttp.helpers.mkError;
        const cases = [
            ["invalid-args", "usage", false],
            ["bad-url", "usage", false],
            ["invalid-header", "usage", false],
            ["unsupported", "usage", false],
            ["dns", "transport", true],
            ["connect", "transport", true],
            ["network", "transport", true],
            ["tls", "tls", false],
            ["timeout", "timeout", true],
            ["aborted", "abort", false],
            ["too-many-redirects", "protocol", false],
            ["body-too-large", "protocol", false],
            ["invalid-json", "protocol", false],
            ["internal", "internal", false]
        ];
        for (const c of cases) {
            const e = mk(c[0], "x");
            EQ(e.code, c[0], "code");
            EQ(e.category, c[1], "category of " + c[0]);
            EQ(e.retryable, c[2], "retryable of " + c[0]);
        }
    });

    suite.test("Q9 unknown mkError code degrades to internal", function () {
        const e = eshttp.helpers.mkError("no-such-code", "x");
        EQ(e.code, "no-such-code", "code kept (wrapper maps unknown DLL codes to internal, not mkError)");
        EQ(e.category, "internal", "category falls back to internal");
        EQ(e.retryable, false, "internal is not retryable");
    });

    // =====================================================================
    // Q9 — socket producible set (headless; closed port for the network case)
    // =====================================================================
    const SOCKET_PRODUCIBLE = ["invalid-args", "bad-url", "invalid-header", "unsupported",
        "network", "timeout", "too-many-redirects", "body-too-large", "internal"];

    suite.test("Q9 socket: https URL -> unsupported (usage), no throw", function () {
        eshttp.forceTransport("socket");
        const r = eshttp.request({ url: "https://127.0.0.1:1/x" });
        EQ(r.error.code, "unsupported", "https on socket");
        EQ(r.error.category, "usage", "category");
        EQ(r.status, 0, "status");
        A(r.meta.path === "socket", "meta.path");
    });

    suite.test("Q9 socket: bodyIsBase64 -> unsupported (usage), no throw", function () {
        eshttp.forceTransport("socket");
        const r = eshttp.request({ url: "http://127.0.0.1:1/x", bodyIsBase64: true });
        EQ(r.error.code, "unsupported", "bodyIsBase64 on socket");
        EQ(r.status, 0, "status");
    });

    suite.test("Q9 socket: closed port -> error in producible set, status 0", function () {
        eshttp.forceTransport("socket");
        const r = eshttp.request({ url: "http://127.0.0.1:1/x", timeout: 3000 });
        A(r.error !== null, "must be an error Result");
        EQ(r.status, 0, "status 0 (no response)");
        A(SOCKET_PRODUCIBLE.indexOf(r.error.code) >= 0,
            "error.code '" + r.error.code + "' must be in the socket producible set");
    });

    suite.test("Q9 socket: bad-url / invalid-header / invalid-args are pre-I/O (no network)", function () {
        eshttp.forceTransport("socket");
        EQ(eshttp.request({ url: "ftp://x" }).error.code, "bad-url", "ftp scheme");
        EQ(eshttp.request({ url: "http://x", headers: { "X": "a\r\nb" } }).error.code, "invalid-header", "CR/LF header");
        EQ(eshttp.request({ url: "http://x", timeout: "x" }).error.code, "invalid-args", "bad timeout type");
    });

    // =====================================================================
    // Q8 — custom method token (RFC 7230) accepted post-fix.
    // Current draft /^[A-Z]+$/ rejects M-SEARCH -> FAILS until core-dev's
    // method-token fix lands.
    // =====================================================================
    suite.test("Q8 custom method token (M-SEARCH) accepted, not invalid-args", function () {
        eshttp.forceTransport("socket");
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/x", method: "M-SEARCH", timeout: 3000 }); });
        A(r !== null, "returned a result");
        EQ(r.error.code !== "invalid-args", true, "M-SEARCH must not be invalid-args (RFC 7230 token)");
    });

    // =====================================================================
    // Q10 — transport tiers, forceTransport/resetTransport, transportInfo
    // =====================================================================
    suite.test("Q10 auto tier order: native > socket > none", function () {
        // both stubs present -> auto = native
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "native", "auto with both available -> native");

        // no ExternalObject -> auto = socket
        env.controls.setExternalObjectAvailable(false);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "socket", "auto without native -> socket");

        // neither -> auto = none
        env.controls.setSocketAvailable(false);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "none", "auto with neither -> none");

        // restore
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
    });

    suite.test("Q10 forceTransport explicit native/socket + bogus name ignored", function () {
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("native"), "native", "forced native");
        EQ(eshttp.forceTransport("socket"), "socket", "forced socket");
        EQ(eshttp.forceTransport("bogus"), "socket", "bogus name keeps current transport");
        eshttp.forceTransport("auto");
    });

    suite.test("Q10 request with no transport -> unsupported Result (never throws)", function () {
        env.controls.setExternalObjectAvailable(false);
        env.controls.setSocketAvailable(false);
        eshttp.resetTransport();
        const r = eshttp.request({ url: "http://x/y" });
        EQ(r.error.code, "unsupported", "no transport");
        EQ(r.status, 0, "status");
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
    });

    suite.test("Q10 transportInfo exposes the 7 documented keys", function () {
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        const ti = eshttp.transportInfo();
        const keys = Object.keys(ti).sort();
        EQ(JSON.stringify(keys), JSON.stringify(["abi", "externalObjectAvailable", "host", "nativeVersion", "platform", "socketAvailable", "transport"]),
            "transportInfo keys");
        EQ(ti.transport, "native", "transport");
        EQ(ti.abi, "http-v1", "abi marker");
        EQ(ti.nativeVersion, "1.0.0", "nativeVersion");
        EQ(ti.externalObjectAvailable, true, "externalObjectAvailable");
        EQ(ti.socketAvailable, true, "socketAvailable");
        EQ(ti.platform, "Windows", "platform from $.os");
        EQ(ti.host, "QA Headless", "host from app.name");
        eshttp.forceTransport("auto");
    });

    suite.test("Q10 eshttp.transport property mirrors the active transport", function () {
        eshttp.forceTransport("socket");
        EQ(eshttp.transport, "socket", "transport property");
        eshttp.forceTransport("auto");
    });

    // =====================================================================
    // Q11 — never-throw sweep: malformed inputs all return error Results
    // =====================================================================
    suite.test("Q11 never-throw sweep (44 malformed inputs)", function () {
        const sweep = [
            [null, "invalid-args"],                          // request(null) — G3
            [undefined, "invalid-args"],                     // request()
            [42, "invalid-args"],                            // request(42)
            ["http://x", "invalid-args"],                    // non-object opts
            [{}, "invalid-args"],                            // missing url
            [{ url: 42 }, "invalid-args"],
            [{ url: "" }, "bad-url"],
            [{ url: "ftp://x" }, "bad-url"],
            [{ url: "wss://x" }, "bad-url"],
            [{ url: "not a url" }, "bad-url"],
            [{ url: "http://x", method: 42 }, "invalid-args"],
            [{ url: "http://x", method: "BAD METHOD" }, "invalid-args"],
            [{ url: "http://x", method: "bad\r\ninject" }, "invalid-args"],
            [{ url: "http://x", headers: "nope" }, "invalid-header"],
            [{ url: "http://x", headers: { "X": "a\r\nb" } }, "invalid-header"],
            [{ url: "http://x", headers: { "X:Y": "v" } }, "invalid-header"],
            [{ url: "http://x", timeout: "x" }, "invalid-args"],
            [{ url: "http://x", timeout: -1 }, "invalid-args"],
            [{ url: "http://x", maxBodyBytes: "x" }, "invalid-args"],
            [{ url: "http://x", maxBodyBytes: -5 }, "invalid-args"],
            [{ url: "http://x", maxRedirects: "x" }, "invalid-args"],
            [{ url: "http://x", maxRedirects: -1 }, "invalid-args"],
            [{ url: "http://x", verifyTls: "yes" }, "invalid-args"],
            [{ url: "http://x", redirect: "sometimes" }, "invalid-args"],
            [{ url: "http://x", query: "x" }, "invalid-args"],
            [{ url: "http://x", body: 42 }, "invalid-args"],
            [{ url: "http://x", bodyIsBase64: "yes" }, "invalid-args"],
            [{ url: "http://x", json: "yes" }, "invalid-args"],
            [{ url: "http://x", userAgent: 42 }, "invalid-args"],
            [{ url: "http://x", username: 42 }, "invalid-args"],
            [{ url: "http://x", password: 42 }, "invalid-args"],
            [{ url: "http://x", proxy: 42 }, "invalid-args"],
            [{ url: "http://x", decompress: "no" }, "invalid-args"],
            // ---- t3-qa regression extensions (R-G5-E1 / P0 / t2-js) ----
            // CR/LF injection vectors (header smuggling guards):
            [{ url: "http://x", headers: { "X": ["a", "b\r\nc"] } }, "invalid-header"], // CRLF inside an array value
            [{ url: "http://x", headers: { "X\r\nY": "v" } }, "invalid-header"],        // CRLF in the header NAME
            [{ url: "http://x", headers: { "X": "a\r\nSet-Cookie: evil=1" } }, "invalid-header"], // header injection
            [{ url: "http://x", headers: [] }, "invalid-header"],                       // array headers object
            [{ url: "http://x", headers: 42 }, "invalid-header"],                       // numeric headers object
            [{ url: "http://x", userAgent: "a\r\nX-Injected: 1" }, "invalid-args"],     // CRLF in userAgent (socket header-injection guard)
            [{ url: "http://x", userAgent: "a\rb" }, "invalid-args"],                   // lone CR in userAgent
            [{ url: "http://x", method: "" }, "invalid-args"],                          // empty method token
            [{ url: "http://x", method: "A B" }, "invalid-args"],                       // space in method token
            [{ url: "http://x", verifyTls: 1 }, "invalid-args"],                        // verifyTls number
            [{ url: "http://x", decompress: "yes" }, "invalid-args"]                    // decompress string
        ];
        for (let i = 0; i < sweep.length; i++) {
            const input = sweep[i][0];
            const expected = sweep[i][1];
            let result = null;
            let threw = null;
            try { result = eshttp.request(input); } catch (e) { threw = e; }
            A(threw === null, "case " + i + " must not throw: " + (threw ? threw.message : ""));
            A(result !== null && result.error !== null, "case " + i + " must return an error Result");
            EQ(result.error.code, expected, "case " + i + " (" + String(input && input.url) + ")");
            EQ(result.status, 0, "case " + i + " status 0");
        }
    });

    suite.test("Q11 validation-error Results carry the full Result shape", function () {
        const r = eshttp.request({ url: "ftp://x" });
        A(typeof r.status === "number" && typeof r.ok === "boolean", "status/ok present");
        A(r.headers && typeof r.headers === "object", "headers present");
        A(typeof r.body === "string" && typeof r.bodyText === "string", "body/bodyText present");
        A(r.meta && typeof r.meta.path === "string", "meta present");
        A(r.error && r.error.code === "bad-url" && r.error.category === "usage", "error taxonomy");
    });

    // t2-js audit: hostile opts must never throw out of ANY public entry
    // point — including the convenience wrappers, whose _extend runs BEFORE
    // _request's try/catch. An enumerable throwing getter (the real
    // adversarial case — defineProperty getters are non-enumerable by default,
    // so for..in skips them; enumerable:true is what actually triggers the
    // unguarded read) must degrade to a Result, never propagate.
    suite.test("Q11 hostile opts (enumerable throwing getters) never throw from any entry point", function () {
        function hostile(key) {
            const o = {};
            Object.defineProperty(o, key, {
                get: function () { throw new Error("hostile getter on " + key); },
                enumerable: true, configurable: true
            });
            return o;
        }
        const cases = [
            ["request(url getter)", function () { return eshttp.request(hostile("url")); }],
            ["get(url getter)", function () { return eshttp.get("http://x", hostile("url")); }],
            ["post(url getter)", function () { return eshttp.post("http://x", "b", hostile("url")); }],
            ["put(url getter)", function () { return eshttp.put("http://x", "b", hostile("url")); }],
            ["del(url getter)", function () { return eshttp.del("http://x", hostile("url")); }],
            ["get(headers getter)", function () { return eshttp.get("http://x", hostile("headers")); }],
            ["post(body getter)", function () { return eshttp.post("http://x", "b", hostile("body")); }],
            ["get(query getter)", function () { return eshttp.get("http://x", hostile("query")); }],
            ["request(body getter)", function () { return eshttp.request({ url: "http://x", body: hostile("body") }); }]
        ];
        // __noNetwork short-circuits with a deterministic unsupported Result,
        // so every case yields a well-formed error Result no matter which
        // transports the harness has — and the hostile getter is still
        // exercised (get/post/put/del read opts via _extend before _request).
        eshttp.__noNetwork = true;
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            let result = null;
            env.assertNoThrow(function () { result = c[1](); }, c[0] + " must never throw");
            A(result !== null && typeof result === "object", c[0] + " returned a Result");
            A(result.error !== null && typeof result.error === "object", c[0] + " returned an error Result");
        }
        eshttp.__noNetwork = false;
        // get() with a hostile url getter must still honor the POSITIONAL url
        // (base survives; hostile extra key skipped) — validated pre-I/O, so
        // the invalid positional scheme yields bad-url regardless of transport.
        let r = null;
        env.assertNoThrow(function () { r = eshttp.get("ftp://x", hostile("url")); });
        EQ(r.error.code, "bad-url", "positional url still used (hostile extra skipped), got " + r.error.code);
    });

    suite.test("Q11 helpers.encComponent never throws on hostile toString (fallback re-entry guard)", function () {
        const o = {};
        Object.defineProperty(o, "toString", { value: function () { throw new Error("toStr boom"); } });
        let out = "UNSET";
        env.assertNoThrow(function () { out = eshttp.helpers.encComponent(o); }, "encComponent must not throw");
        EQ(out, "", "hostile toString degrades to empty string, got " + JSON.stringify(out));
        EQ(eshttp.helpers.encComponent("a b"), "a%20b", "normal input still percent-encoded");
        EQ(eshttp.helpers.encComponent("héllo"), "h%C3%A9llo", "utf8 percent-encoding unchanged");
    });

    // =====================================================================
    // R-G5-E1 / P0 — URL scheme regression (native-dev t1 fix, eshttp.c:692-698)
    // The C url_parse used ci_eq (FULL-string equality) where it needed
    // ci_starts (prefix) — so EVERY http:// URL was rejected as "unsupported
    // scheme". The JS _parseUrl is the mirror contract the wrapper enforces
    // pre-ABI; guard the acceptance of http:// AND https:// AND userinfo URLs
    // here so a wrapper-side regression cannot re-introduce the P0.
    // =====================================================================
    suite.test("Q7 url parse P0 regression: http:// AND https:// URLs both parse (scheme prefix)", function () {
        const http = eshttp.helpers.parseUrl("http://Example.com:8080/path?q=1#frag");
        A(http.valid, "http:// must parse");
        EQ(http.scheme, "http", "scheme http");
        EQ(http.host, "Example.com", "host preserved (case kept on JS side; C lowercases)");
        EQ(http.port, 8080, "port 8080");
        EQ(http.path, "/path", "path");
        EQ(http.query, "q=1", "query");
        EQ(http.hash, "frag", "hash");
        EQ(http.http, true, "http flag");
        EQ(http.https, false, "not https");

        const https = eshttp.helpers.parseUrl("https://Example.com/x");
        A(https.valid, "https:// must parse");
        EQ(https.scheme, "https", "scheme https");
        EQ(https.port, 443, "https default port 443");
        EQ(https.https, true, "https flag");
        EQ(https.http, false, "not http");
    });

    suite.test("Q7 url parse P0 regression: userinfo URLs parse and separate credentials from host", function () {
        const p = eshttp.helpers.parseUrl("http://user:pw@Example.com:8080/path?q=1#frag");
        A(p.valid, "userinfo URL must parse");
        EQ(p.userinfo, "user:pw", "userinfo captured separately");
        EQ(p.host, "Example.com", "host does NOT contain the userinfo");
        EQ(p.port, 8080, "port survives userinfo");
        EQ(p.path, "/path", "path survives userinfo");
        // http:// and https:// with userinfo both parse (P0 wire shape)
        A(eshttp.helpers.parseUrl("http://u@h/x").valid, "http userinfo");
        A(eshttp.helpers.parseUrl("https://u:p@h/x").valid, "https userinfo");
    });

    suite.test("Q7 url parse P0 regression: unsupported schemes still rejected (no over-accept)", function () {
        EQ(eshttp.helpers.parseUrl("ftp://x").valid, false, "ftp rejected");
        EQ(eshttp.helpers.parseUrl("wss://x").valid, false, "wss rejected");
        EQ(eshttp.helpers.parseUrl("httpss://x").valid, false, "httpss (5+1) rejected — scheme must be exact http/https");
        EQ(eshttp.helpers.parseUrl("http://").valid, false, "no host rejected");
        const r = eshttp.request({ url: "httpss://x" });
        EQ(r.error.code, "bad-url", "httpss:// request -> bad-url (scheme prefix must not over-match)");
    });

    // URL userinfo must never leak: on the SOCKET path the request-target and
    // Host are derived from parsed parts only, so a userinfo URL sends no
    // credentials on the wire (wire-level assertion lives in 30-socket-wire).
    // Here we pin the PARSED separation (the contract N14 mirror).
    suite.test("Q7 url parse: userinfo is never folded into host or path by the wrapper", function () {
        // request() with a userinfo URL must not build a request target or
        // host that contains the credentials (checked via native call shape).
        env.controls.setNativeResponder(function () { return {
            abi: "http-v1", ok: true, status: 200, statusText: "OK", headers: {},
            body: "", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: "GET", finalUrl: null, redirects: 0, timeMs: 1, bytes: 0,
                    httpVersion: "1.1", tlsVersion: "1.2", encodingWasApplied: false,
                    nativeVersion: "1.0.0", winhttpError: null, backend: "winhttp" } };
        });
        env.controls.nativeState.calls.length = 0;
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        const r = eshttp.request({ url: "http://user:pw@a.example:8080/path?q=1" });
        EQ(r.status, 200, "request succeeded");
        const c = env.controls.nativeState.calls[0];
        A(c, "native driver called");
        // The wrapper forwards the FULL URL to the DLL — the DLL strips
        // userinfo (N14). The JS side must not reject or mangle it.
        EQ(c.url, "http://user:pw@a.example:8080/path?q=1", "full userinfo URL forwarded verbatim to the DLL");
        EQ(c.url.indexOf("a.example") >= 0, true, "host intact in forwarded URL");
        env.controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // =====================================================================
    // api-spec §5 — eshttp.json helper contract
    // =====================================================================
    suite.test("Q7 eshttp.json parse/stringify/callable per §5", function () {
        EQ(eshttp.json.parse('{"a":1}').a, 1, "parse object");
        EQ(eshttp.json.parse("not json"), null, "invalid -> null, never throws");
        EQ(eshttp.json.parse(42), null, "non-string -> null");
        EQ(eshttp.json.stringify({ a: 1 }), '{"a":1}', "stringify");
        EQ(eshttp.json('{"a":1}').a, 1, "callable form == parse");
        EQ(eshttp.json.stringify({ s: "\u00e9" }).indexOf("\\u00e9") >= 0, true, "7-bit clean \\uXXXX");
        EQ(eshttp.json.stringify({ a: undefined, b: 1 }), '{"b":1}', "undefined omitted");
        EQ(eshttp.json.stringify([undefined]), "[null]", "undefined -> null in arrays");
    });

    // =====================================================================
    // api-spec §2.1 — DEFAULTS / configure
    // =====================================================================
    suite.test("Q10 DEFAULTS snapshot is replacement-safe + has 8 keys", function () {        const d = eshttp.DEFAULTS;
        EQ(d.timeout, 30000, "timeout default");
        EQ(d.redirect, "follow", "redirect default");
        EQ(d.maxRedirects, 5, "maxRedirects default");
        EQ(d.verifyTls, true, "verifyTls default");
        EQ(d.userAgent, "eshttp/1.0.0", "userAgent default");
        EQ(d.decompress, true, "decompress default");
        EQ(d.maxBodyBytes, 52428800, "maxBodyBytes default");
        EQ(d.transport, "auto", "transport default");
        const keys = Object.keys(d).length;
        EQ(keys, 8, "8 keys");
        // replacement-safe: mutating the snapshot must not touch internals
        d.timeout = 1;
        EQ(eshttp.DEFAULTS.timeout, 30000, "snapshot mutation does not leak");
    });

    suite.test("Q10 configure() shallow-merges and returns previous defaults", function () {
        const prev = eshttp.configure({ timeout: 15000, userAgent: "my/1.0" });
        EQ(prev.timeout, 30000, "previous timeout returned");
        EQ(prev.userAgent, "eshttp/1.0.0", "previous userAgent returned");
        EQ(eshttp.DEFAULTS.timeout, 15000, "timeout merged");
        EQ(eshttp.DEFAULTS.userAgent, "my/1.0", "userAgent merged");
        eshttp.configure({ timeout: 30000, userAgent: "eshttp/1.0.0" });
    });

    // =====================================================================
    // Dynamic default User-Agent (sponsor-requested): when no explicit UA
    // header/opt is supplied AND the host exposes name+version, the default
    // UA is "eshttp/<v> (<host name> <host version>; <platform>)" — the
    // TYPICAL fleshed-out RFC 7231 product/version (comment) format, e.g.
    //   "eshttp/1.0.0 (Adobe Illustrator 30.6; Windows NT 10.0; Win64; x64)"
    // The harness `app` has no version, so the fallback "eshttp/1.0.0"
    // applies here (api-spec §6.2 row 3); the dynamic form is asserted by
    // setting a version-bearing app global for the duration of the test.
    // =====================================================================
    suite.test("Q7 dynamic default User-Agent: host-aware in typical product/version (comment) format", function () {
        // Assert via the native call shape: force native, capture optsJson.
        // (No pre-flight request — with native ALIVE the default responder
        // returns 200, so there is no guaranteed error Result to assert.)
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        env.controls.setNativeResponder(function () { return {
            abi: "http-v1", ok: true, status: 200, statusText: "OK", headers: {},
            body: "{}", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: "GET", finalUrl: null, redirects: 0, timeMs: 1, bytes: 2,
                    httpVersion: "1.1", tlsVersion: "1.2", encodingWasApplied: false,
                    nativeVersion: "1.0.0", winhttpError: null, backend: "winhttp" } };
        });
        env.controls.nativeState.calls.length = 0;
        // (a) harness app (name only, no version) -> fallback eshttp/1.0.0
        eshttp.request({ url: "http://127.0.0.1:1/uadef" });
        let opts1 = JSON.parse(env.controls.nativeState.calls[env.controls.nativeState.calls.length - 1].optsJson);
        EQ(opts1.userAgent, "eshttp/1.0.0", "no host version -> static fallback");
        // (b) version-bearing app -> fleshed-out dynamic UA with OS + arch
        const savedApp = env.sandbox ? env.sandbox.app : null;
        const targetApp = { name: "Adobe Illustrator", version: "30.6" };
        if (env.sandbox) { env.sandbox.app = targetApp; } else { globalThis.app = targetApp; }
        try {
            eshttp.request({ url: "http://127.0.0.1:1/uadef2" });
            const opts2 = JSON.parse(env.controls.nativeState.calls[env.controls.nativeState.calls.length - 1].optsJson);
            // The harness stages $.os="Windows" and real env vars; on an AMD64
            // host the arch token is readable -> the classic NT/Win64/x64 form.
            // On hosts without PROCESSOR_ARCHITECTURE, the platform collapses
            // to "Windows". Assert the common prefix + one of the two forms.
            const ua2 = opts2.userAgent;
            A(typeof ua2 === "string" && ua2.indexOf("eshttp/1.0.0 (Adobe Illustrator 30.6; ") === 0,
                "dynamic UA in typical product/version (comment) format, got " + ua2);
            A(ua2.indexOf("Windows") >= 0, "platform present in UA comment: " + ua2);
        } finally {
            if (env.sandbox) { env.sandbox.app = savedApp; } else { globalThis.app = savedApp; }
        }
        env.controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // =====================================================================
    // __noNetwork test hook short-circuit
    // =====================================================================
    suite.test("Q1 __noNetwork=true makes request() fail fast with unsupported", function () {
        eshttp.__noNetwork = true;
        const r = eshttp.request({ url: "http://127.0.0.1:1/x" });
        EQ(r.error.code, "unsupported", "noNetwork short-circuit");
        eshttp.__noNetwork = false;
    });

    suite.test("Q1 helpers pure-layer works with __noNetwork=true", function () {
        eshttp.__noNetwork = true;
        EQ(eshttp.helpers.utf8Decode(eshttp.helpers.utf8Encode("\u00e9\u4e2d")), "\u00e9\u4e2d", "utf8 roundtrip");
        EQ(eshttp.helpers.buildQuery({ page: 2, tags: ["a", "b"] }), "page=2&tags=a&tags=b", "query build");
        eshttp.__noNetwork = false;
    });

    // =====================================================================
    // Regression tests for opt-js optimizations (ES3 hot-path)
    // =====================================================================
    // Cache invalidation: parseUrl results must not be incorrectly cached
    // across different URLs with similar structure.
    suite.test("Q11 regression: parseUrl cache isolation - different URLs produce independent results", function () {
        const u1 = eshttp.helpers.parseUrl("http://a.example.com:8080/path1?q=1");
        const u2 = eshttp.helpers.parseUrl("http://b.example.com:9090/path2?q=2");
        A(u1.valid && u2.valid, "both URLs valid");
        EQ(u1.host, "a.example.com", "first host");
        EQ(u2.host, "b.example.com", "second host");
        EQ(u1.port, 8080, "first port");
        EQ(u2.port, 9090, "second port");
        EQ(u1.path, "/path1", "first path");
        EQ(u2.path, "/path2", "second path");
        EQ(u1.query, "q=1", "first query");
        EQ(u2.query, "q=2", "second query");
        // Mutating one result must not affect the other (no shared mutable state)
        u1.host = "mutated";
        EQ(u2.host, "b.example.com", "second result isolated from first mutation");
    });

    // State isolation: transport state must not leak across resetTransport()
    suite.test("Q11 regression: resetTransport isolates native cache state", function () {
        env.controls.setExternalObjectAvailable(true);
        env.controls.setSocketAvailable(true);
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        const t1 = eshttp.transportInfo();
        EQ(t1.transport, "native", "native selected");
        EQ(t1.nativeVersion, "1.0.0", "native version present");

        // Force a native call to populate cache
        env.controls.setNativeResponder(function () { return {
            abi: "http-v1", ok: true, status: 200, statusText: "OK", headers: {},
            body: "{}", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: "GET", finalUrl: null, redirects: 0, timeMs: 1, bytes: 2,
                    httpVersion: "1.1", tlsVersion: "1.2", encodingWasApplied: false,
                    nativeVersion: "1.0.0", winhttpError: null, backend: "winhttp" } };
        });
        eshttp.request({ url: "http://127.0.0.1:1/x" });

        // Reset transport - should clear native cache
        eshttp.resetTransport();
        const t2 = eshttp.transportInfo();
        EQ(t2.transport, "native", "native still available after reset");
        EQ(t2.nativeVersion, "1.0.0", "native version still present after reset");

        // Force socket and verify native cache doesn't interfere
        eshttp.forceTransport("socket");
        const t3 = eshttp.transportInfo();
        EQ(t3.transport, "socket", "socket selected");
        EQ(t3.nativeVersion, null, "nativeVersion null when socket forced");

        eshttp.resetTransport();
        env.controls.setNativeResponder(null);
    });

    // Never-throw: hostile opts with Symbol keys (ES6 feature that may exist in host)
    suite.test("Q11 regression: hostile opts with Symbol-keyed properties never throw", function () {
        const sym = typeof Symbol === "function" ? Symbol("evil") : "evil";
        const o = { url: "http://x" };
        o[sym] = { toString: function () { throw new Error("symbol boom"); } };
        let result = null;
        eshttp.__noNetwork = true;
        env.assertNoThrow(function () { result = eshttp.request(o); }, "Symbol-keyed hostile prop must not throw");
        eshttp.__noNetwork = false;
        A(result !== null && result.error !== null, "returns error Result");
        EQ(result.error.code, "unsupported", "__noNetwork -> unsupported");
    });

    // Never-throw: deeply nested hostile getters in opts.headers
    suite.test("Q11 regression: deeply nested hostile getters in headers never throw", function () {
        const headers = {};
        Object.defineProperty(headers, "X-Custom", {
            get: function () {
                const nested = {};
                Object.defineProperty(nested, "toString", {
                    get: function () { throw new Error("nested boom"); }
                });
                return nested;
            },
            enumerable: true
        });
        let result = null;
        env.assertNoThrow(function () { result = eshttp.request({ url: "http://x", headers: headers }); });
        A(result !== null && result.error !== null, "returns error Result");
        // Hostile getter during String(v) in _normalizeRequestHeaders throws plain Error
        // which _request catches and degrades to "internal" (no eshttp.code attached)
        EQ(result.error.code, "internal", "hostile header value -> internal (degraded)");
    });

    // JSON parse/stringify: large object round-trip (stress internal buffers)
    suite.test("Q7 regression: json stringify/parse large object round-trip", function () {
        const large = { items: [] };
        for (let i = 0; i < 500; i++) {
            large.items.push({ id: i, name: "item-" + i, data: "x".repeat(50) });
        }
        const str = eshttp.json.stringify(large);
        A(typeof str === "string" && str.length > 10000, "stringified large object");
        const parsed = eshttp.json.parse(str);
        A(parsed && parsed.items && parsed.items.length === 500, "parsed back correctly");
        EQ(parsed.items[0].id, 0, "first item");
        EQ(parsed.items[499].id, 499, "last item");
    });

    // URL parse: IPv6 with userinfo and port (edge case for scheme/host parsing)
    suite.test("Q7 regression: IPv6 URL with userinfo and port parses correctly", function () {
        const u = eshttp.helpers.parseUrl("http://user:pw@[::1]:8080/path?q=1");
        A(u.valid, "IPv6 with userinfo+port valid");
        EQ(u.scheme, "http", "scheme");
        EQ(u.userinfo, "user:pw", "userinfo");
        EQ(u.host, "::1", "IPv6 host (brackets stripped)");
        EQ(u.port, 8080, "port");
        EQ(u.path, "/path", "path");
        EQ(u.query, "q=1", "query");
    });

    // URL parse: scheme case insensitivity (http vs HTTP vs Http)
    suite.test("Q7 regression: scheme case insensitivity (HTTP, Http, hTtP)", function () {
        A(eshttp.helpers.parseUrl("HTTP://example.com/x").valid, "HTTP uppercase");
        A(eshttp.helpers.parseUrl("Http://example.com/x").valid, "Http mixed");
        A(eshttp.helpers.parseUrl("hTtP://example.com/x").valid, "hTtP mixed");
        A(eshttp.helpers.parseUrl("HTTPS://example.com/x").valid, "HTTPS uppercase");
        A(eshttp.helpers.parseUrl("Https://example.com/x").valid, "Https mixed");
        EQ(eshttp.helpers.parseUrl("HTTP://example.com/x").scheme, "http", "normalized to lowercase");
        EQ(eshttp.helpers.parseUrl("HTTPS://example.com/x").scheme, "https", "normalized to lowercase");
    });
};
