/*
 * 20-native-abi.js — native (eshttp.dll) envelope contract tests.
 * The real DLL (espark-dev t1) is not built yet, so these drive the REAL
 * wrapper pipeline through the harness ExternalObject stub: the stub is the
 * fake eshttp.dll and returns envelopes exactly per native-abi.md §4.
 * Covers: Q3 (meta.abi http-v1 + tamper-degrade), Q5 (UTF-8 round trip),
 * Q6 (header passthrough, OBS-2), OBS-1 (encodingWasApplied/backend),
 * G2 (opts.json on native), G5 (UA precedence capture), request-ABI params.
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const A = env.assert;
    const EQ = env.assertEq;
    const controls = env.controls;

    function goodEnvelope(over) {
        const e = {
            abi: "http-v1", ok: true, status: 200, statusText: "OK",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: "{\"ok\":true}", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: "GET", finalUrl: null, redirects: 0,
                    timeMs: 1, bytes: 11, httpVersion: "1.1", tlsVersion: "1.2",
                    encodingWasApplied: false, nativeVersion: "1.0.0",
                    winhttpError: null, backend: "winhttp" }
        };
        for (const k in over) { e[k] = over[k]; }
        return e;
    }

    function resetNative() {
        eshttp.resetTransport();
        eshttp.forceTransport("native");
    }

    // =====================================================================
    // Q3 — meta.abi === "http-v1" on every native response
    // =====================================================================
    suite.test("Q3 native 200: result.meta.abi === 'http-v1', path native", function () {
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/json" });
        EQ(r.error, null, "no error on success envelope");
        EQ(r.status, 200, "status");
        EQ(r.ok, true, "ok");
        EQ(r.meta.path, "native", "meta.path");
        EQ(r.meta.abi, "http-v1", "meta.abi");
        EQ(r.meta.nativeVersion, "1.0.0", "meta.nativeVersion");
        EQ(eshttp.transportInfo().abi, "http-v1", "transportInfo().abi");
    });

    suite.test("Q3 native 404-shaped envelope: ok false, error null, meta.abi http-v1", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" }, body: "nf" });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/nf" });
        EQ(r.status, 404, "status kept");
        EQ(r.ok, false, "ok reflects 2xx only");
        EQ(r.error, null, "4xx is NOT an error envelope (error null)");
        EQ(r.meta.abi, "http-v1", "meta.abi on 404");
    });

    suite.test("Q3 native transport error envelope: status 0, error mapped, meta.abi http-v1", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({
                ok: false, status: 0, statusText: "", headers: {}, body: "",
                error: { code: "timeout", message: "timed out", category: "timeout", retryable: true },
                meta: { path: "native", method: "GET", finalUrl: "http://127.0.0.1:1/x", redirects: 0,
                        timeMs: 5000, bytes: 0, httpVersion: null, tlsVersion: null,
                        encodingWasApplied: false, nativeVersion: "1.0.0", winhttpError: 12002, backend: "winhttp" }
            });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/x" });
        EQ(r.status, 0, "status 0");
        EQ(r.error.code, "timeout", "error.code");
        EQ(r.error.category, "timeout", "error.category");
        EQ(r.error.retryable, true, "error.retryable");
        A(r.error.detail && r.error.detail.winhttp === 12002,
            "winhttpError copied to error.detail.winhttp (got " + JSON.stringify(r.error.detail) + ")");
        EQ(r.meta.path, "native", "meta.path");
        EQ(r.meta.abi, "http-v1", "meta.abi on error result");
    });

    suite.test("Q3 unknown DLL error code maps to internal", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ ok: false, status: 0, body: "", error: { code: "alien-code", message: "?" },
                meta: { path: "native", finalUrl: null, nativeVersion: "1.0.0", winhttpError: 999, redirects: 0, timeMs: 1, bytes: 0 } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/x" });
        EQ(r.error.code, "internal", "unknown DLL code -> internal");
    });

    // =====================================================================
    // Q3 — tampered envelope abi degrades to socket (native-abi §7.1)
    // =====================================================================
    suite.test("Q3 tampered envelope abi -> degrade to socket (meta.path socket)", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ abi: "tampered-v9", body: "x" });
        });
        resetNative();
        let r = null;
        env.assertNoThrow(function () {
            r = eshttp.request({ url: "http://127.0.0.1:1/tamper", timeout: 3000 });
        }, "tamper must not throw");
        EQ(r.meta.path, "socket", "degraded to socket (observable via meta.path)");
        A(r.error !== null, "socket fallback produced an error Result (no server on port 1)");
        EQ(r.status, 0, "status 0");
    });

    suite.test("Q3 after tamper the DLL is marked dead: forceTransport('native') -> none", function () {
        // State carries over from the previous test: cache.dead === true.
        EQ(eshttp.forceTransport("native"), "none", "native marked dead after ABI mismatch");
        EQ(eshttp.transportInfo().transport, "none", "transportInfo agrees");
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("native"), "native", "resetTransport re-enables native");
        eshttp.forceTransport("auto");
    });

    suite.test("Q3 https tamper cannot degrade to cleartext socket -> unsupported", function () {
        controls.setNativeResponder(function () { return goodEnvelope({ abi: "bad" }); });
        resetNative();
        const r = eshttp.request({ url: "https://127.0.0.1:1/x" });
        EQ(r.error.code, "unsupported", "https + dead DLL -> unsupported");
        EQ(r.meta.path, "none", "no transport for https fallback");
        eshttp.resetTransport();
    });

    suite.test("Q3 unparseable envelope (garbage) -> internal + degrade", function () {
        controls.setNativeResponder(function () { return { __rawString: "this is not json {" }; });
        resetNative();
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/x", timeout: 3000 }); });
        A(r.error !== null, "error Result");
        EQ(r.meta.path, "socket", "degraded to socket");
        eshttp.resetTransport();
    });

    suite.test("Q3 eshttp_request throwing -> DLL marked dead, degrade, no throw", function () {
        controls.setNativeResponder(function () { return { __throw: "boom" }; });
        resetNative();
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/x", timeout: 3000 }); }, "no throw");
        A(r.error !== null, "error Result");
        EQ(r.meta.path, "socket", "degraded to socket");
        EQ(eshttp.forceTransport("native"), "none", "DLL dead after throw");
        eshttp.resetTransport();
    });

    // =====================================================================
    // Request ABI params — _nativeRequest sends the 11 optsJson keys with
    // the exact 5-arg call shape (native-abi §3.3 / baseline check 4)
    // =====================================================================
    suite.test("Q3 native call shape: 5 args + 11 optsJson keys", function () {
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        controls.nativeState.calls.length = 0;
        resetNative();
        eshttp.request({
            url: "http://a.example/b", method: "POST", body: { k: 1 },
            timeout: 1234, redirect: "manual", maxRedirects: 3, verifyTls: false,
            userAgent: "u/1", username: "u", password: "p", proxy: "direct",
            decompress: false, maxBodyBytes: 100, bodyIsBase64: false
        });
        const c = controls.nativeState.calls[0];
        A(c, "native driver was called");
        EQ(c.method, "POST", "method arg");
        EQ(c.url, "http://a.example/b", "url arg");
        const headers = eshttp.helpers.jsonParse(c.headersJson);
        const opts = eshttp.helpers.jsonParse(c.optsJson);
        A(headers && typeof headers === "object", "headersJson is a JSON object");
        A(opts && typeof opts === "object", "optsJson is a JSON object");
        const keys = Object.keys(opts).sort();
        EQ(JSON.stringify(keys), JSON.stringify(["bodyIsBase64", "decompress", "maxBodyBytes", "maxRedirects",
            "password", "proxy", "redirect", "timeoutMs", "userAgent", "username", "verifyTls"]),
            "all 11 optsJson keys present");
        EQ(opts.timeoutMs, 1234, "timeoutMs");
        EQ(opts.redirect, "manual", "redirect");
        EQ(opts.maxRedirects, 3, "maxRedirects");
        EQ(opts.verifyTls, false, "verifyTls");
        EQ(opts.userAgent, "u/1", "userAgent");
        EQ(opts.username, "u", "username");
        EQ(opts.password, "p", "password");
        EQ(opts.proxy, "direct", "proxy");
        EQ(opts.decompress, false, "decompress");
        EQ(opts.maxBodyBytes, 100, "maxBodyBytes");
        EQ(opts.bodyIsBase64, false, "bodyIsBase64");
        A(typeof c.body === "string", "body is a string");
    });

    // =====================================================================
    // native-abi-v2 (T6/T7): eshttp_free REMOVED — the host frees kTypeString
    // returns via ESFreeMem. The wrapper must NEVER call a free (v1 caller-
    // frees was the double-free flaw). The stub records any (nonexistent)
    // free invocations in nativeState.freeCalls and has NO eshttp_free
    // prototype (a call would TypeError -> DLL marked dead).
    // =====================================================================
    suite.test("Q3 v2: wrapper never calls eshttp_free (double-free fix, native-abi-v2)", function () {
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        controls.nativeState.freeCalls = 0;
        controls.nativeState.calls.length = 0;
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/v2free" });
        EQ(r.error, null, "request still succeeds without any free call");
        EQ(r.status, 200, "status");
        EQ(controls.nativeState.freeCalls, 0, "eshttp_free never invoked (host frees via ESFreeMem)");
        EQ(controls.nativeState.hasFreeExport, false, "v2 DLL has no eshttp_free export");
    });

    suite.test("Q3 v2: no-arg methods are called with _f dummy arg (version/available/last_error)", function () {
        // The v2 ESInitialize signature declares _f for the no-arg methods;
        // the wrapper passes a dummy 0. Exercise each by forcing a native
        // request (probe calls version(0)+available(0)) and a NULL-return
        // envelope (last_error(0)). The stub tolerates any args; the assert
        // is that these paths complete without a throw (a bare-name binding
        // or missing arg would throw on the real DLL).
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        resetNative();
        const ok = eshttp.request({ url: "http://127.0.0.1:1/v2dummy" });
        EQ(ok.error, null, "probe path (version(0)/available(0)) completes");
        controls.setNativeResponder(function () { return { __returnNull: true }; });
        const nul = eshttp.request({ url: "http://127.0.0.1:1/v2dummy" });
        // NULL envelope -> dllDead path: consults last_error(0), marks the
        // DLL dead, then degrades to the socket driver (available in the
        // harness). The Result must never throw and carries an error.
        A(nul.error !== null, "NULL envelope -> error Result (last_error(0) consulted)");
        EQ(nul.status, 0, "no response received");
        controls.setNativeResponder(function () { return goodEnvelope({}); });
    });

    // =====================================================================
    // Q5 — non-ASCII UTF-8 round trip (native-abi §6)
    // =====================================================================
    suite.test("Q5 native envelope body: UTF-8 string survives to result.body", function () {
        const unicodeBody = "héllo wörld 世界 ☃";
        controls.setNativeResponder(function () {
            return goodEnvelope({ body: unicodeBody, bodyEncoding: "utf8", headers: { "content-type": "text/plain; charset=utf-8" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/u" });
        EQ(r.body, unicodeBody, "result.body unchanged");
        EQ(r.bodyText, unicodeBody, "bodyText == body for utf8");
    });

    suite.test("Q5 native request body: raw string body sent UTF-8-encoded, round-trips", function () {
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        controls.nativeState.calls.length = 0;
        resetNative();
        eshttp.request({ url: "http://a.example/u", method: "POST", body: "héllo 世界",
                         headers: { "Content-Type": "text/plain" } });
        const c = controls.nativeState.calls[0];
        A(c, "native driver called");
        EQ(eshttp.helpers.utf8Decode(c.body), "héllo 世界", "body crossed the boundary as UTF-8 bytes");
    });

    suite.test("Q5 native base64 body: bodyEncoding base64 -> body decoded, bodyText = base64 form", function () {
        const b64 = eshttp.helpers.base64Encode("a\u0000b\u00e9"); // binary-safe content
        controls.setNativeResponder(function () {
            return goodEnvelope({ body: b64, bodyEncoding: "base64", headers: { "content-type": "application/octet-stream" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/bin" });
        EQ(r.body, "a\u0000b\u00e9", "body base64-decoded to raw binary string");
        EQ(r.bodyText, b64, "bodyText is the display-safe base64 form");
    });

    // =====================================================================
    // Q6 — header lowercasing + repeated join on the native envelope path
    // (OBS-2): the wrapper passes the DLL's (already normalized) headers
    // through untouched.
    // =====================================================================
    suite.test("Q6 native envelope headers passthrough: lowercased keys + joined repeats", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({
                headers: { "content-type": "application/json", "x-n": "1, 2", "set-cookie": "a=1; b=2" },
                body: "{}"
            });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/h" });
        EQ(r.headers["content-type"], "application/json", "content-type");
        EQ(r.headers["x-n"], "1, 2", "repeated header joined with ', '");
        EQ(r.headers["set-cookie"], "a=1; b=2", "Set-Cookie joined with '; '");
        A(r.headers["X-N"] === undefined, "keys stay lowercased (no original case key)");
    });

    // =====================================================================
    // Q6 OBS-2 — result.headers is a raw DLL passthrough (native-abi §4.2):
    // the DLL owns lowercasing + repeat-join; the wrapper must pass the
    // normalized envelope headers through VERBATIM and never corrupt them,
    // re-case them, or re-join them (src/eshttp.jsxinc:1008/1019).
    // =====================================================================
    suite.test("Q6 OBS-2 native: passthrough is byte-faithful (no re-case, no re-join, no extra keys)", function () {
        const envHeaders = { "content-type": "text/plain", "x-n": "1, 2", "set-cookie": "a=1; b=2",
                             "x-original-case": "kept-as-is" };
        controls.setNativeResponder(function () {
            return goodEnvelope({ headers: envHeaders, body: "ok" });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/h2" });
        EQ(JSON.stringify(r.headers), JSON.stringify(envHeaders),
            "result.headers deep-equals the envelope headers verbatim (wrapper must not normalize)");
        let keyCount = 0;
        for (const k in r.headers) { keyCount++; }
        EQ(keyCount, 4, "no keys added or dropped by the wrapper");
        EQ(r.headers["x-original-case"], "kept-as-is", "odd-case key passes through untouched (DLL's job, not wrapper's)");
    });

    suite.test("Q6 OBS-2 native: envelope headers null -> result.headers {} and no throw (jsxinc:1008 guard)", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ headers: null, body: "ok" });
        });
        resetNative();
        let r = null;
        env.assertNoThrow(function () {
            r = eshttp.request({ url: "http://127.0.0.1:1/hnull" });
        }, "headers:null envelope must never throw");
        EQ(r.status, 200, "status survives");
        EQ(JSON.stringify(r.headers), "{}", "headers:null degrades to empty object");
    });

    suite.test("Q6 OBS-2 native: envelope headers undefined + array (non-conforming DLL) -> {} and no throw", function () {
        const cases = [
            { label: "headers:undefined", over: { headers: undefined } },
            { label: "headers:array (weird DLL)", over: { headers: [["x-n", "1, 2"]] } },
            { label: "headers:string (weird DLL)", over: { headers: "content-type: text/plain" } }
        ];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            controls.setNativeResponder(function () { return goodEnvelope(c.over); });
            resetNative();
            let r = null;
            env.assertNoThrow(function () {
                r = eshttp.request({ url: "http://127.0.0.1:1/hbad" });
            }, c.label + " must never throw");
            EQ(JSON.stringify(r.headers), "{}", c.label + " degrades to empty object");
            EQ(r.status, 200, c.label + " status survives");
        }
    });

    // =====================================================================
    // OBS-1 (resolved): meta.encodingWasApplied + meta.backend passthrough
    // =====================================================================
    suite.test("Q6 native meta passthrough: encodingWasApplied + backend (OBS-1)", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ meta: { path: "native", finalUrl: "http://127.0.0.1:1/g", redirects: 0, timeMs: 1, bytes: 2,
                httpVersion: "1.1", tlsVersion: "1.2", encodingWasApplied: true, nativeVersion: "1.0.0",
                winhttpError: null, backend: "winhttp" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/g", decompress: true });
        EQ(r.meta.encodingWasApplied, true, "encodingWasApplied passthrough");
        EQ(r.meta.backend, "winhttp", "backend passthrough");
        EQ(r.meta.httpVersion, "1.1", "httpVersion");
        EQ(r.meta.tlsVersion, "1.2", "tlsVersion");
    });

    // =====================================================================
    // G2 — opts.json on the native path (identical behavior both paths, §11)
    // =====================================================================
    suite.test("Q7 G2 native: json:true on 2xx valid body -> result.data parsed, error null", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ body: "{\"items\":[1,2,3]}", headers: { "content-type": "application/json" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/j", json: true });
        A(r.data !== undefined && r.data !== null, "result.data populated");
        EQ(r.data.items.length, 3, "data parsed");
        EQ(r.error, null, "no error");
    });

    suite.test("Q7 G2 native: json:true on invalid JSON body -> invalid-json, status KEPT, data null", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ body: "not { json", headers: { "content-type": "application/json" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/jbad", json: true });
        EQ(r.error.code, "invalid-json", "invalid-json");
        EQ(r.error.category, "protocol", "category protocol");
        EQ(r.status, 200, "status kept (not 0)");
        EQ(r.data, null, "data null on parse failure");
    });

    // =====================================================================
    // G5 — User-Agent precedence on the native path (header wins; opt
    // forwarded when no header; "" = none; unset = default)
    // =====================================================================
    function nativeUACapture(opts) {
        controls.nativeState.calls.length = 0;
        resetNative();
        eshttp.request(opts);
        const c = controls.nativeState.calls[0];
        const headers = eshttp.helpers.jsonParse(c.headersJson);
        const o = eshttp.helpers.jsonParse(c.optsJson);
        let uaKeys = 0;
        let uaValue = null;
        for (const k in headers) {
            if (k.toLowerCase() === "user-agent") { uaKeys++; uaValue = headers[k]; }
        }
        return { uaKeys: uaKeys, uaValue: uaValue, optUA: o.userAgent };
    }

    suite.test("Q7 G5 native: explicit UA header (case-insensitive) wins, exactly one in headersJson", function () {
        const cap = nativeUACapture({ url: "http://a.example/x", headers: { "USER-AGENT": "MyApp/2.0" } });
        EQ(cap.uaKeys, 1, "exactly one UA key in headersJson");
        EQ(cap.uaValue, "MyApp/2.0", "header value verbatim");
    });

    suite.test("Q7 G5 native: no header + userAgent opt -> opt forwarded in optsJson, no header", function () {
        const cap = nativeUACapture({ url: "http://a.example/x", userAgent: "MyApp/9.9" });
        EQ(cap.uaKeys, 0, "no UA header");
        EQ(cap.optUA, "MyApp/9.9", "optsJson.userAgent = opt");
    });

    suite.test("Q7 G5 native: no header + unset -> default eshttp/1.0.0", function () {
        const cap = nativeUACapture({ url: "http://a.example/x" });
        EQ(cap.uaKeys, 0, "no UA header");
        EQ(cap.optUA, "eshttp/1.0.0", "default userAgent");
    });

    // R-G5 ruling + native-abi §3.3: optsJson.userAgent is "string | null";
    // null means "a UA header already won in headersJson, OR the caller
    // suppressed the UA" — in both cases the DLL must send NO User-Agent.
    // (Original QA assertion expected ""; corrected to null per the contract.)
    suite.test("Q7 G5 native: no header + userAgent '' -> optsJson.userAgent null (DLL sends none)", function () {
        const cap = nativeUACapture({ url: "http://a.example/x", userAgent: "" });
        EQ(cap.optUA, null, "suppressed userAgent is null per native-abi §3.3");
        EQ(cap.uaKeys, 0, "no UA header");
    });

    suite.test("Q7 G5 native: UA header wins -> optsJson.userAgent null (no DLL dedup needed)", function () {
        const cap = nativeUACapture({ url: "http://a.example/x", headers: { "User-Agent": "Hdr/1" }, userAgent: "Opt/2" });
        EQ(cap.uaKeys, 1, "exactly one UA key in headersJson");
        EQ(cap.uaValue, "Hdr/1", "header wins over opts.userAgent");
        EQ(cap.optUA, null, "optsJson.userAgent nulled so the DLL never duplicates");
    });

    // api-spec §6.2 row 1 edge: an explicit User-Agent header with value ""
    // is a WINNING header (case-insensitive match) — it is forwarded verbatim
    // as an empty value and the DLL must NOT substitute any default. This is
    // distinct from opts.userAgent === "" (row 4, full suppression).
    suite.test("Q7 G5 native: empty UA header value wins verbatim, optsJson.userAgent null", function () {
        const cap = nativeUACapture({ url: "http://a.example/x", headers: { "User-Agent": "" } });
        EQ(cap.uaKeys, 1, "exactly one UA key in headersJson");
        EQ(cap.uaValue, "", "empty header value forwarded verbatim");
        EQ(cap.optUA, null, "optsJson.userAgent null — DLL must send the empty header as-is, no default");
    });

    // =====================================================================
    // R-OBS1 — meta.encodingWasApplied / meta.backend are observable on the
    // native path and NULL on socket + error results (architect ruling).
    // =====================================================================
    suite.test("Q6 R-OBS1 native success: encodingWasApplied boolean + backend string", function () {
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/o" });
        EQ(typeof r.meta.encodingWasApplied, "boolean", "encodingWasApplied is a boolean on native success");
        EQ(typeof r.meta.backend, "string", "backend is a string on native success");
        A(r.meta.backend === "winhttp" || r.meta.backend === "wininet",
            "backend must be winhttp|wininet, got " + r.meta.backend);
    });

    suite.test("Q6 R-OBS1 native decompress degraded: encodingWasApplied false is preserved (not coerced)", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ meta: { path: "native", finalUrl: null, redirects: 0, timeMs: 1, bytes: 2,
                httpVersion: "1.1", tlsVersion: null, encodingWasApplied: false, nativeVersion: "1.0.0",
                winhttpError: null, backend: "wininet" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/o", decompress: true });
        EQ(r.meta.encodingWasApplied, false, "false survives (silent identity fallback is observable)");
        EQ(r.meta.backend, "wininet", "alternate backend value passes through");
    });

    // Architect ruling v2 (from docs F1): eshttp.c env_build emits
    // encodingWasApplied + backend UNCONDITIONALLY, so a native TIMEOUT/DNS
    // error result carries encodingWasApplied:false / backend:"winhttp" —
    // NOT null. Null is reserved for socket results and no-envelope errors.
    suite.test("Q6 R-OBS1 native ERROR result forwards encodingWasApplied + backend (not null)", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ ok: false, status: 0, statusText: "", headers: {}, body: "",
                error: { code: "timeout", message: "timed out", category: "timeout", retryable: true },
                meta: { path: "native", finalUrl: null, redirects: 0, timeMs: 5000, bytes: 0,
                        httpVersion: null, tlsVersion: null, encodingWasApplied: false,
                        nativeVersion: "1.0.0", winhttpError: 12002, backend: "winhttp" } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/e" });
        EQ(r.error.code, "timeout", "error mapped");
        EQ(typeof r.meta.encodingWasApplied, "boolean", "boolean on native error results (N4: emitted in EVERY envelope)");
        EQ(r.meta.encodingWasApplied, false, "value forwarded verbatim");
        EQ(typeof r.meta.backend, "string", "string on native error results");
        EQ(r.meta.backend, "winhttp", "backend forwarded verbatim");
        eshttp.resetTransport();
    });

    // Defensive tolerance: a non-conforming DLL that omits the keys must not
    // crash the wrapper — it degrades them to null rather than undefined.
    suite.test("Q6 R-OBS1 wrapper tolerates a DLL that omits the OBS-1 keys (degrades to null)", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({ ok: false, status: 0, statusText: "", headers: {}, body: "",
                error: { code: "connect", message: "refused", category: "transport", retryable: true },
                meta: { path: "native", finalUrl: null, redirects: 0, timeMs: 3, bytes: 0,
                        httpVersion: null, tlsVersion: null, nativeVersion: "1.0.0", winhttpError: 12029 } });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/e" });
        EQ(r.error.code, "connect", "error mapped");
        A("encodingWasApplied" in r.meta, "encodingWasApplied key always present");
        A("backend" in r.meta, "backend key always present");
        EQ(r.meta.encodingWasApplied, null, "degraded to null, never undefined");
        EQ(r.meta.backend, null, "degraded to null, never undefined");
        eshttp.resetTransport();
    });

    // R-G5-E1 gate (wrapper half): when the UA is suppressed or a header won,
    // optsJson.userAgent MUST be null so the DLL has an unambiguous
    // "send NO User-Agent" signal. espark-dev owns the eshttp.c half
    // (WinHttpOpen must not default the agent to "eshttp/1.0.0" on null).
    suite.test("Q7 G5 native R-G5-E1: suppressed UA sends null (DLL must emit no UA header)", function () {
        const suppressed = nativeUACapture({ url: "http://a.example/x", userAgent: "" });
        EQ(suppressed.optUA, null, "userAgent:'' -> optsJson.userAgent null");
        EQ(suppressed.uaKeys, 0, "and no UA in headersJson");
        const headerWon = nativeUACapture({ url: "http://a.example/x", headers: { "user-agent": "H/1" } });
        EQ(headerWon.optUA, null, "header won -> optsJson.userAgent null");
        EQ(headerWon.uaKeys, 1, "the single UA lives in headersJson only");
        A(suppressed.optUA === null && headerWon.optUA === null,
            "null is the ONLY 'no default UA' signal the DLL receives");
    });

    // R-G5-E1 (boundary observation): the native responder itself — the fake
    // eshttp.dll boundary in the harness — must OBSERVE optsJson.userAgent
    // === null for BOTH the suppressed case and the header-won case. This is
    // the exact signal eshttp.c's WinHttpOpen must translate into "no User-Agent
    // on the wire" (eshttp.c currently substitutes L"eshttp/1.0.0" at
    // lines 1525-1526 — wire-side fix is espark-dev t1). Asserting at the
    // responder boundary (not just post-call state) makes the contract
    // structural: if the wrapper ever regresses to forwarding "" or a default
    // string, this fails at the DLL interface.
    suite.test("Q7 G5 native R-G5-E1: responder boundary observes null (suppressed + header-won)", function () {
        const observed = [];
        controls.setNativeResponder(function (method, url, headersJson, body, optsJson) {
            observed.push(eshttp.helpers.jsonParse(optsJson).userAgent);
            return goodEnvelope({});
        });
        resetNative();
        eshttp.request({ url: "http://a.example/x", userAgent: "" });
        eshttp.request({ url: "http://a.example/x", headers: { "user-agent": "H/1" } });
        EQ(observed.length, 2, "both requests reached the native responder");
        EQ(JSON.stringify(observed), JSON.stringify([null, null]),
            "responder observed userAgent null for BOTH suppression and header-won (no default substitution)");
        controls.setNativeResponder(function () { return goodEnvelope({}); });
        eshttp.resetTransport();
    });

    suite.test("Q6 R-OBS1 socket path: encodingWasApplied and backend are both null", function () {
        eshttp.resetTransport();
        eshttp.forceTransport("socket");
        const r = eshttp.request({ url: "http://127.0.0.1:1/x", timeout: 3000 });
        A("encodingWasApplied" in r.meta, "key present on socket result");
        A("backend" in r.meta, "key present on socket result");
        EQ(r.meta.encodingWasApplied, null, "socket never decompresses -> null");
        EQ(r.meta.backend, null, "socket has no native backend -> null");
        eshttp.resetTransport();
    });

    // cleanup: restore defaults
    suite.test("Q3 cleanup restores default responder", function () {
        controls.setNativeResponder(null);
        eshttp.resetTransport();
        A(true, "restored");
    });

    // =====================================================================
    // Regression tests for opt-native optimizations (C native / WinHTTP)
    // =====================================================================
    // ABI envelope: envelope with minimal meta (missing optional keys) must not crash
    suite.test("Q3 regression: envelope with minimal meta (missing optional keys) degrades gracefully", function () {
        controls.setNativeResponder(function () {
            return {
                abi: "http-v1", ok: true, status: 200, statusText: "OK",
                headers: { "content-type": "text/plain" },
                body: "ok", bodyEncoding: "utf8", error: null,
                meta: { path: "native", method: "GET" } // minimal meta
            };
        });
        resetNative();
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/min" }); });
        EQ(r.status, 200, "status");
        EQ(r.body, "ok", "body");
        A("encodingWasApplied" in r.meta, "encodingWasApplied key present (degraded to null)");
        A("backend" in r.meta, "backend key present (degraded to null)");
        EQ(r.meta.encodingWasApplied, null, "missing encodingWasApplied -> null");
        EQ(r.meta.backend, null, "missing backend -> null");
        EQ(r.meta.httpVersion, null, "missing httpVersion -> null");
        EQ(r.meta.tlsVersion, null, "missing tlsVersion -> null");
        EQ(r.meta.nativeVersion, null, "missing nativeVersion -> null");
        EQ(r.meta.winhttpError, undefined, "missing winhttpError -> undefined (not in result meta)");
        EQ(r.meta.redirects, 0, "missing redirects -> 0");
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // ABI envelope: envelope with null headers must not crash (OBS-2 guard)
    suite.test("Q6 OBS-2 regression: envelope headers null/undefined/array/string all degrade to {}", function () {
        const cases = [
            { label: "headers:null", over: { headers: null } },
            { label: "headers:undefined", over: { headers: undefined } },
            { label: "headers:array (non-conforming)", over: { headers: [["x", "y"]] } },
            { label: "headers:string (non-conforming)", over: { headers: "content-type: text/plain" } },
            { label: "headers:number (non-conforming)", over: { headers: 42 } },
            { label: "headers:boolean (non-conforming)", over: { headers: true } }
        ];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            controls.setNativeResponder(function () {
                return goodEnvelope(c.over);
            });
            resetNative();
            let r = null;
            env.assertNoThrow(function () {
                r = eshttp.request({ url: "http://127.0.0.1:1/hbad" });
            }, c.label + " must never throw");
            EQ(JSON.stringify(r.headers), "{}", c.label + " degrades to empty object");
            EQ(r.status, 200, c.label + " status survives");
        }
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // ABI envelope: bodyEncoding base64 with malformed base64 must degrade, not throw
    suite.test("Q5 regression: native base64 envelope with corrupt body degrades, never throws", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({
                body: "!!!not-base64!!!", // invalid base64
                bodyEncoding: "base64",
                headers: { "content-type": "application/octet-stream" }
            });
        });
        resetNative();
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/bin" }); });
        // _base64DecodeLenient never throws - it falls back to lenient decode
        // which skips invalid chars. Result body will be empty/garbage but no error.
        EQ(r.error, null, "no error - lenient decode never throws");
        EQ(r.status, 200, "status 200");
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // ABI envelope: valid base64 envelope still decodes exactly
    suite.test("Q5 regression: valid native base64 envelope still decodes exactly", function () {
        const b64 = eshttp.helpers.base64Encode("a\u0000b\u00e9");
        controls.setNativeResponder(function () {
            return goodEnvelope({
                body: b64,
                bodyEncoding: "base64",
                headers: { "content-type": "application/octet-stream" }
            });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/bin" });
        EQ(r.body, "a\u0000b\u00e9", "body base64-decoded to raw binary string");
        EQ(r.bodyText, b64, "bodyText is the display-safe base64 form");
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // WinHTTP error mapping: unknown error code maps to internal
    suite.test("Q3 regression: unknown WinHTTP error code maps to internal", function () {
        controls.setNativeResponder(function () {
            return goodEnvelope({
                ok: false, status: 0, statusText: "", headers: {}, body: "",
                error: { code: "alien-code", message: "?", category: "internal", retryable: false },
                meta: { path: "native", finalUrl: null, nativeVersion: "1.0.0", winhttpError: 99999, redirects: 0, timeMs: 1, bytes: 0 }
            });
        });
        resetNative();
        const r = eshttp.request({ url: "http://127.0.0.1:1/x" });
        EQ(r.error.code, "internal", "unknown DLL code -> internal");
        EQ(r.error.detail.winhttp, 99999, "winhttpError preserved in detail");
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // Request body: bodyIsBase64 with valid base64 round-trips
    suite.test("Q5 regression: native request bodyIsBase64 round-trips binary", function () {
        controls.setNativeResponder(function (method, url, headersJson, body, optsJson) {
            const opts = eshttp.helpers.jsonParse(optsJson);
            EQ(opts.bodyIsBase64, true, "bodyIsBase64 passed to DLL");
            // Simulate DLL: decode base64 request body, echo it back as response body
            const decoded = eshttp.helpers.base64Decode(body);
            return goodEnvelope({
                body: decoded, // DLL would send decoded binary
                bodyEncoding: "utf8",
                headers: { "content-type": "text/plain" }
            });
        });
        resetNative();
        const binary = "a\u0000b\u00e9";
        const b64 = eshttp.helpers.base64Encode(binary);
        const r = eshttp.request({
            url: "http://127.0.0.1:1/echo",
            method: "POST",
            body: b64,
            bodyIsBase64: true,
            headers: { "Content-Type": "application/octet-stream" }
        });
        EQ(r.body, binary, "binary request body round-tripped via base64");
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });

    // User-Agent: explicit header with empty value wins verbatim (not suppressed)
    suite.test("Q7 G5 regression: explicit empty UA header wins verbatim, optsJson.userAgent null", function () {
        controls.nativeState.calls.length = 0;
        resetNative();
        eshttp.request({
            url: "http://a.example/x",
            headers: { "User-Agent": "" }
        });
        const c = controls.nativeState.calls[0];
        const headers = eshttp.helpers.jsonParse(c.headersJson);
        const opts = eshttp.helpers.jsonParse(c.optsJson);
        let uaKeys = 0;
        for (const k in headers) { if (k.toLowerCase() === "user-agent") { uaKeys++; } }
        EQ(uaKeys, 1, "exactly one UA key in headersJson");
        EQ(headers["User-Agent"], "", "empty header value forwarded verbatim");
        EQ(opts.userAgent, null, "optsJson.userAgent null (DLL must send empty header, no default)");
        controls.setNativeResponder(null);
        eshttp.resetTransport();
    });
};
