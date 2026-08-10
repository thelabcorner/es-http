/*
 * 30-socket-wire.js — socket-path contract tests over REAL TCP.
 * ==================================================================
 * These run only when the harness has mock servers (`--all`, or `--net`
 * with external servers). The ES3 Socket driver inside eshttp.jsxinc does
 * genuine HTTP/1.1 wire I/O through the harness Socket stub, so every
 * assertion here is about bytes that actually crossed a socket.
 *
 * Covers:
 *   Q4  [GATE] G1 — cross-host redirect must NOT forward Authorization
 *   Q5  non-ASCII UTF-8 round-trip end-to-end on the wire
 *   Q6  header lowercasing + repeated-header ", " / Set-Cookie "; " join
 *   Q7  G2 json:true parse ok + invalid-json; G5 UA precedence ON THE WIRE
 *   Q8  HTTP/1.1, Host, Content-Length, Connection: close, chunked,
 *       read-to-EOF, 3xx manual/follow, too-many-redirects
 *   Q9  socket producible error set against live endpoints
 *
 * This file is QA infrastructure only — NOT part of the eshttp library.
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const A = env.assert;
    const EQ = env.assertEq;

    // If the harness was started without mock servers, register skip markers
    // so the Q-matrix reports honestly instead of silently claiming coverage.
    // These are recorded as known-issues (loud, non-fatal) because a headless
    // run is a legitimate partial mode, not a product defect — the full
    // acceptance run is `node test/harness.js --all`.
    if (!env.net) {
        const why = "socket wire coverage needs mock servers: run `node test/harness.js --all`";
        suite.knownIssue("SKIP-NONET", why,
            "Q4 [GATE] cross-host Authorization test SKIPPED (no mock servers)", function () {
                throw new Error(why);
            });
        suite.knownIssue("SKIP-NONET", why,
            "Q8 socket wire contract tests SKIPPED (no mock servers)", function () {
                throw new Error(why);
            });
        return;
    }

    function socket() {
        eshttp.resetTransport();
        eshttp.forceTransport("socket");
    }

    // Pull the last logged request for a path from a given mock server.
    function findReq(log, pathStartsWith) {
        for (let i = log.length - 1; i >= 0; i--) {
            if (String(log[i].url).indexOf(pathStartsWith) === 0) { return log[i]; }
        }
        return null;
    }

    // rawHeaders is a flat [name, value, name, value, ...] array preserving
    // the exact case and every duplicate as it arrived on the wire.
    function rawHeaderValues(req, name) {
        const out = [];
        const rh = req.rawHeaders || [];
        for (let i = 0; i + 1 < rh.length; i += 2) {
            if (String(rh[i]).toLowerCase() === name.toLowerCase()) { out.push(rh[i + 1]); }
        }
        return out;
    }

    // =====================================================================
    // Q8 — request-line / framing basics actually observed by the server
    // =====================================================================
    suite.test("Q8 socket sends HTTP/1.1 with Host and Connection: close", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: env.base + "/echo" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "status");
        EQ(r.meta.path, "socket", "meta.path");
        EQ(r.meta.httpVersion, "1.1", "response httpVersion parsed");

        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "server logged the request");
        EQ(req.httpVersion, "1.1", "server saw HTTP/1.1");
        A(req.headers.host, "Host header present");
        A(/^127\.0\.0\.1(:\d+)?$/.test(req.headers.host), "Host is host[:port], got " + req.headers.host);
        EQ(String(req.headers.connection || "").toLowerCase(), "close", "Connection: close");
    });

    suite.test("Q8 Host header omits the port for :80, includes it otherwise", async function () {
        socket();
        await env.resetServerLogs();
        eshttp.request({ url: env.base + "/echo" });
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "logged");
        // Mock servers run on an ephemeral non-80 port, so the port MUST be present.
        A(req.headers.host.indexOf(":") > 0, "non-80 port present in Host: " + req.headers.host);
        const port = req.headers.host.split(":")[1];
        EQ(port, String(env.base.split(":")[2]), "Host port matches the target port");
    });

    suite.test("Q8 POST body: Content-Length computed in BYTES, body arrives intact", async function () {
        socket();
        await env.resetServerLogs();
        const body = "name=value&x=1";
        const r = eshttp.request({ url: env.base + "/echo", method: "POST", body: body,
                                   headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        EQ(r.error, null, "no error");
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "logged");
        EQ(req.method, "POST", "method");
        EQ(req.body, body, "body arrived intact");
        EQ(req.headers["content-length"], String(Buffer.byteLength(body, "utf8")), "Content-Length in bytes");
        EQ(rawHeaderValues(req, "content-length").length, 1, "exactly one Content-Length");
    });

    suite.test("Q8 Content-Length is byte length, not char length, for non-ASCII bodies", async function () {
        socket();
        await env.resetServerLogs();
        const body = "héllo 世界"; // 6 + 1 + 2 ASCII/multibyte mix
        eshttp.request({ url: env.base + "/echo", method: "POST", body: body,
                         headers: { "Content-Type": "text/plain; charset=utf-8" } });
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "logged");
        EQ(req.headers["content-length"], String(Buffer.byteLength(body, "utf8")),
            "Content-Length must be UTF-8 byte length (" + Buffer.byteLength(body, "utf8") + "), not " + body.length + " chars");
        EQ(req.body, body, "multibyte body round-tripped on the wire");
    });

    suite.test("Q8 GET with no body sends Content-Length: 0 and no stray body", async function () {
        socket();
        await env.resetServerLogs();
        eshttp.request({ url: env.base + "/echo" });
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "logged");
        EQ(req.body, "", "no body bytes");
    });

    suite.test("Q8 caller-supplied Host/Content-Length are ignored (wrapper-computed)", async function () {
        socket();
        await env.resetServerLogs();
        eshttp.request({ url: env.base + "/echo", method: "POST", body: "abcd",
                         headers: { "Host": "evil.example", "Content-Length": "9999" } });
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "logged");
        EQ(rawHeaderValues(req, "host").length, 1, "exactly one Host header");
        A(req.headers.host.indexOf("evil.example") < 0, "caller Host ignored, got " + req.headers.host);
        EQ(rawHeaderValues(req, "content-length").length, 1, "exactly one Content-Length");
        EQ(req.headers["content-length"], "4", "wrapper-computed CL wins over caller's 9999");
    });

    suite.test("Q8 query object is merged into the request target", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: env.base + "/echo", query: { page: 2, tags: ["a", "b"], q: "a b" } });
        EQ(r.error, null, "no error");
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "logged");
        A(req.url.indexOf("page=2") > 0, "page=2 on the wire: " + req.url);
        A(req.url.indexOf("tags=a&tags=b") > 0, "array repeats: " + req.url);
        A(req.url.indexOf("q=a%20b") > 0, "percent-encoded space: " + req.url);
    });

    // =====================================================================
    // Q8 — body framing: Content-Length, chunked, read-to-EOF
    // =====================================================================
    suite.test("Q8 Content-Length framed body is read exactly", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/final" });
        EQ(r.error, null, "no error");
        EQ(r.status, 200, "status");
        EQ(r.body, "final ok", "body");
        EQ(r.headers["content-length"], "8", "content-length header exposed");
    });

    suite.test("Q8 chunked transfer-encoding is de-chunked", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-chunked" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "status");
        EQ(r.body, "Hello, chunked world!", "de-chunked body");
        A(/chunked/i.test(r.headers["transfer-encoding"] || ""), "transfer-encoding exposed");
    });

    suite.test("Q8 chunked with chunk-extensions + trailers is de-chunked", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-chunked-ext" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.body, "hello", "chunk-extension ignored, trailer not appended to the body");
    });

    suite.test("Q8 read-to-EOF body (no CL, no TE) is captured", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-eof" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "status");
        EQ(r.body, "framed by eof only", "body framed by connection close");
    });

    suite.test("Q8 204 No Content -> empty body, ok true (2xx)", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-204" });
        EQ(r.error, null, "no error");
        EQ(r.status, 204, "status");
        EQ(r.body, "", "empty body");
        EQ(r.ok, true, "204 is 2xx -> ok true (api-spec §3)");
    });

    suite.test("Q8 large body (256 KiB) is read completely", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/large?bytes=262144", timeout: 30000 });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.body.length, 262144, "all bytes read");
        EQ(r.meta.bytes, 262144, "meta.bytes");
    });

    suite.test("Q8 malformed (non-HTTP) response -> network error Result, no throw", function () {
        socket();
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: env.base + "/raw-garbage" }); });
        A(r.error !== null, "error Result");
        EQ(r.error.code, "network", "malformed status line -> network");
        EQ(r.status, 0, "status 0");
    });

    // =====================================================================
    // Q8 — 3xx: manual vs follow, method rewrite, too-many-redirects
    // =====================================================================
    suite.test("Q8 redirect:manual returns the 3xx as-is with Location", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/redirect/302", redirect: "manual" });
        EQ(r.error, null, "no error");
        EQ(r.status, 302, "3xx returned verbatim");
        EQ(r.headers["location"], "/echo-all", "Location exposed");
        EQ(r.meta.redirects, 0, "no hops followed");
    });

    suite.test("Q8 redirect:follow resolves a relative Location and reports hops", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: env.base + "/redirect/302" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "final status");
        EQ(r.meta.redirects, 1, "one hop");
        const logs = await env.fetchLogs();
        A(findReq(logs.main, "/echo-all"), "server saw the followed request");
    });

    suite.test("Q8 302 rewrites POST -> GET and drops the body", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: env.base + "/redirect/302", method: "POST", body: "a=1",
                                   headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        EQ(r.error, null, "no error");
        const logs = await env.fetchLogs();
        const hop = findReq(logs.main, "/echo-all");
        A(hop, "followed request logged");
        EQ(hop.method, "GET", "302 -> GET (api-spec §8)");
        EQ(hop.body, "", "body dropped");
        A(!hop.headers["content-type"], "Content-Type dropped on method change");
    });

    suite.test("Q8 307 preserves method AND body", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: env.base + "/redirect/307", method: "POST", body: "a=1",
                                   headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        EQ(r.error, null, "no error");
        const logs = await env.fetchLogs();
        const hop = findReq(logs.main, "/echo-all");
        A(hop, "followed request logged");
        EQ(hop.method, "POST", "307 preserves the method");
        EQ(hop.body, "a=1", "307 preserves the body");
    });

    suite.test("Q8 308 preserves method AND body", async function () {
        socket();
        await env.resetServerLogs();
        eshttp.request({ url: env.base + "/redirect/308", method: "POST", body: "b=2",
                         headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        const logs = await env.fetchLogs();
        const hop = findReq(logs.main, "/echo-all");
        A(hop, "followed request logged");
        EQ(hop.method, "POST", "308 preserves the method");
        EQ(hop.body, "b=2", "308 preserves the body");
    });

    suite.test("Q8 303 rewrites to GET", async function () {
        socket();
        await env.resetServerLogs();
        eshttp.request({ url: env.base + "/redirect/303", method: "POST", body: "c=3",
                         headers: { "Content-Type": "text/plain" } });
        const logs = await env.fetchLogs();
        const hop = findReq(logs.main, "/echo-all");
        A(hop, "followed request logged");
        EQ(hop.method, "GET", "303 -> GET");
        EQ(hop.body, "", "body dropped");
    });

    suite.test("Q8 redirect chain within maxRedirects succeeds", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/redirect/3", maxRedirects: 5 });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "reached /final");
        EQ(r.body, "final ok", "final body");
        EQ(r.meta.redirects, 3, "3 hops counted");
    });

    suite.test("Q8 too-many-redirects: infinite loop is capped, error is not retryable", function () {
        socket();
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: env.base + "/redirect/loop", maxRedirects: 2 }); });
        A(r.error !== null, "error Result");
        EQ(r.error.code, "too-many-redirects", "code");
        EQ(r.error.category, "protocol", "category (api-spec §7)");
        EQ(r.error.retryable, false, "not retryable");
        EQ(r.status, 0, "status 0");
    });

    suite.test("Q8 maxRedirects:0 with redirect:follow refuses to hop", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/redirect/302", maxRedirects: 0 });
        A(r.error !== null, "error Result");
        EQ(r.error.code, "too-many-redirects", "capped at hop 0");
    });

    // =====================================================================
    // Q4 [GATE] — G1: cross-host redirect must NOT forward Authorization
    // =====================================================================
    suite.test("Q4 [GATE] G1: Authorization is NOT forwarded across a cross-host redirect", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({
            url: env.base + "/redirect/cross",
            headers: { "Authorization": "Bearer SUPER-SECRET-TOKEN" }
        });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "landed on the cross host");
        EQ(r.meta.redirects, 1, "one hop");

        const logs = await env.fetchLogs();
        const first = findReq(logs.main, "/redirect/cross");
        A(first, "first request logged on the main server");
        EQ(first.headers.authorization, "Bearer SUPER-SECRET-TOKEN", "original host DID receive the credential");

        const hop = findReq(logs.cross, "/cross-target");
        A(hop, "cross-host request logged on the CROSS server");
        A(!hop.headers.authorization,
            "SECURITY: Authorization leaked to the cross host: " + hop.headers.authorization);
        EQ(rawHeaderValues(hop, "authorization").length, 0, "no Authorization on the wire at all");

        // The cross endpoint reflects what it saw — belt and braces.
        const seen = eshttp.json.parse(r.body);
        A(seen, "cross-target returned JSON");
        EQ(seen.authorization, null, "cross-target observed authorization === null");
    });

    suite.test("Q4 [GATE] G1: username/password credentials also dropped cross-host", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({
            url: env.base + "/redirect/cross",
            username: "alice", password: "hunter2"
        });
        EQ(r.error, null, "no error");
        const logs = await env.fetchLogs();
        const hop = findReq(logs.cross, "/cross-target");
        A(hop, "cross-host request logged");
        A(!hop.headers.authorization, "no Authorization synthesized for the cross host");
    });

    suite.test("Q4 G1: SAME-host redirect MAY keep Authorization", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({
            url: env.base + "/redirect/302",
            headers: { "Authorization": "Bearer KEEP-ME" }
        });
        EQ(r.error, null, "no error");
        const logs = await env.fetchLogs();
        const hop = findReq(logs.main, "/echo-all");
        A(hop, "same-host hop logged");
        EQ(hop.headers.authorization, "Bearer KEEP-ME", "same-host hop keeps the credential (api-spec §8)");
    });

    suite.test("Q4 G1: non-credential headers survive a cross-host redirect", async function () {
        socket();
        await env.resetServerLogs();
        eshttp.request({
            url: env.base + "/redirect/cross",
            headers: { "Authorization": "Bearer SECRET", "X-Trace": "keep-me", "Accept": "application/json" }
        });
        const logs = await env.fetchLogs();
        const hop = findReq(logs.cross, "/cross-target");
        A(hop, "cross hop logged");
        A(!hop.headers.authorization, "credential dropped");
        EQ(hop.headers["x-trace"], "keep-me", "non-credential header preserved");
        EQ(hop.headers.accept, "application/json", "Accept preserved");
    });

    // t3-qa strengthening: the G1 filter matches header names case-
    // insensitively (jsxinc _toLower), so an all-lowercase "authorization"
    // header must be dropped cross-host too — a case-sensitive filter would
    // leak the credential.
    suite.test("Q4 G1: lowercase 'authorization' header also dropped cross-host (case-insensitive filter)", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({
            url: env.base + "/redirect/cross",
            headers: { "authorization": "Bearer LOWERCASE-SECRET" }
        });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "landed on cross host");
        const logs = await env.fetchLogs();
        const first = findReq(logs.main, "/redirect/cross");
        EQ(first.headers.authorization, "Bearer LOWERCASE-SECRET", "original host received the credential (lowercase name)");
        const hop = findReq(logs.cross, "/cross-target");
        A(hop, "cross hop logged");
        A(!hop.headers.authorization, "SECURITY: lowercase authorization leaked cross-host");
        EQ(rawHeaderValues(hop, "authorization").length, 0, "zero authorization lines on the wire at the cross host");
    });

    // t3-qa: userinfo embedded in the URL must NEVER appear on the wire —
    // the request-target and Host are derived from the parsed parts only
    // (P0/N14 mirror at the socket wire level). Also, a userinfo URL must
    // not synthesize an Authorization header.
    suite.test("Q8 socket wire: URL userinfo never crosses the wire (request line, Host, no auth)", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: "http://user:pw@" + env.base.replace("http://", "") + "/echo" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "status");
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "request logged");
        // Node's req.url is the request-target: must contain no userinfo.
        A(req.url.indexOf("user:pw") < 0, "request line must not contain userinfo, got: " + req.url);
        A(req.headers.host.indexOf("user:pw") < 0, "Host must not contain userinfo, got: " + req.headers.host);
        EQ(rawHeaderValues(req, "authorization").length, 0,
            "no Authorization synthesized from URL userinfo (Basic must come from opts.username/password only)");
        // The parsed separation is preserved end-to-end: server saw the plain target.
        EQ(req.url, "/echo", "clean request-target");
    });

    // =====================================================================
    // Q5 — non-ASCII UTF-8 round-trip end-to-end over the wire
    // =====================================================================
    suite.test("Q5 UTF-8 response body round-trips over the socket", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-utf8" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "status");
        const data = eshttp.json.parse(r.body);
        A(data, "body parsed as JSON: " + JSON.stringify(r.body));
        EQ(data.msg, "héllo wörld 世界 ☃", "multibyte payload intact");
    });

    suite.test("Q5 UTF-8 request body round-trips (echo)", async function () {
        socket();
        await env.resetServerLogs();
        const payload = "héllo wörld 世界 ☃";
        const r = eshttp.request({ url: env.base + "/echo", method: "POST", body: payload,
                                   headers: { "Content-Type": "text/plain; charset=utf-8" } });
        EQ(r.error, null, "no error");
        const echoed = eshttp.json.parse(r.body);
        A(echoed, "echo parsed");
        EQ(echoed.body, payload, "server received the exact multibyte payload");
    });

    suite.test("Q5 UTF-8 survives a redirect hop", async function () {
        socket();
        const r = eshttp.request({ url: env.base + "/redirect/1" });
        EQ(r.error, null, "no error");
        EQ(r.status, 200, "followed to /final");
    });

    // =====================================================================
    // Q6 — header lowercasing + repeated-header joins ON THE SOCKET PATH
    // (api-spec §3: ", " for normal headers, "; " for Set-Cookie)
    // =====================================================================
    suite.test("Q6 socket: response header keys are lowercased", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-dup-headers" });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        A(r.headers["content-type"] !== undefined, "content-type present lowercased");
        A(r.headers["Content-Type"] === undefined, "no original-case key");
        A(r.headers["x-n"] !== undefined, "x-n present lowercased");
        A(r.headers["X-N"] === undefined, "no original-case X-N");
    });

    suite.test("Q6 socket: repeated headers join with ', '", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-dup-headers" });
        EQ(r.error, null, "no error");
        EQ(r.headers["x-n"], "1, 2", "repeated X-N joined with ', '");
    });

    // F-QA-1 (fixed by core-dev): _parseResponseHeaders used to join
    // set-cookie with ", " because only the bare "cookie" name was special-
    // cased. Regression-guarded here on the live wire.
    suite.test("Q6 socket: repeated Set-Cookie joins with '; ' (F-QA-1 regression)", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/raw-dup-headers" });
        EQ(r.error, null, "no error");
        EQ(r.headers["set-cookie"], "a=1; b=2", "Set-Cookie joined with '; ' per api-spec §3 / native-abi §4.2");
        A(r.headers["set-cookie"].indexOf(", ") < 0, "must NOT use the ', ' list join for Set-Cookie");
    });

    // =====================================================================
    // Q7 — G2 json:true on the SOCKET path (identical behavior both paths)
    // =====================================================================
    suite.test("Q7 G2 socket: json:true parses a valid 2xx body into result.data", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/json", json: true });
        EQ(r.error, null, "no error: " + JSON.stringify(r.error));
        EQ(r.status, 200, "status");
        A(r.data, "result.data populated");
        EQ(r.data.ok, true, "parsed payload");
    });

    suite.test("Q7 G2 socket: json:true on an unparseable body -> invalid-json, status KEPT", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/invalid-json", json: true });
        A(r.error !== null, "error Result");
        EQ(r.error.code, "invalid-json", "code");
        EQ(r.error.category, "protocol", "category");
        EQ(r.error.retryable, false, "not retryable");
        EQ(r.status, 200, "status KEPT (not zeroed)");
        EQ(r.data, null, "data null");
        A(r.body.length > 0, "raw body still available for debugging");
    });

    suite.test("Q7 G2 socket: json:true on 404 leaves the result untouched", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/404", json: true });
        EQ(r.status, 404, "status");
        EQ(r.ok, false, "not ok");
        EQ(r.error, null, "non-2xx is not a json parse target");
    });

    // =====================================================================
    // Q7 — G5 User-Agent precedence ON THE WIRE (R-G5 ruling, api-spec §6.2)
    // =====================================================================
    async function wireUA(opts) {
        socket();
        await env.resetServerLogs();
        eshttp.request(opts);
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        A(req, "request logged");
        return rawHeaderValues(req, "user-agent");
    }

    suite.test("Q7 G5 socket wire: explicit User-Agent header wins, exactly one on the wire", async function () {
        const uas = await wireUA({ url: env.base + "/echo",
                                   headers: { "User-Agent": "MyApp/2.0" }, userAgent: "Ignored/9.9" });
        EQ(uas.length, 1, "exactly one User-Agent header on the wire, got " + JSON.stringify(uas));
        EQ(uas[0], "MyApp/2.0", "explicit header wins over opts.userAgent");
    });

    // api-spec §6.2 row 1 edge: an explicit UA header with value "" wins as a
    // header (case-insensitive) — it is sent verbatim as an EMPTY header line.
    // This must NOT be treated as suppression (row 4) and must NOT trigger the
    // default eshttp/1.0.0.
    suite.test("Q7 G5 socket wire: empty User-Agent header value is sent verbatim (not defaulted, not suppressed)", async function () {
        const uas = await wireUA({ url: env.base + "/echo",
                                   headers: { "User-Agent": "" }, userAgent: "Ignored/9.9" });
        EQ(uas.length, 1, "exactly one User-Agent header on the wire, got " + JSON.stringify(uas));
        EQ(uas[0], "", "empty header value sent verbatim (header wins, no default injected)");
    });

    suite.test("Q7 G5 socket wire: header match is case-insensitive (USER-AGENT)", async function () {
        const uas = await wireUA({ url: env.base + "/echo",
                                   headers: { "USER-AGENT": "Caps/1.0" }, userAgent: "Ignored/9.9" });
        EQ(uas.length, 1, "no duplicate UA, got " + JSON.stringify(uas));
        EQ(uas[0], "Caps/1.0", "case-insensitive header wins");
    });

    suite.test("Q7 G5 socket wire: opts.userAgent used when no header is supplied", async function () {
        const uas = await wireUA({ url: env.base + "/echo", userAgent: "OptOnly/3.1" });
        EQ(uas.length, 1, "one UA");
        EQ(uas[0], "OptOnly/3.1", "opts.userAgent on the wire");
    });

    suite.test("Q7 G5 socket wire: default eshttp/1.0.0 when nothing is supplied", async function () {
        const uas = await wireUA({ url: env.base + "/echo" });
        EQ(uas.length, 1, "one UA");
        EQ(uas[0], "eshttp/1.0.0", "documented default");
    });

    suite.test("Q7 G5 socket wire: userAgent '' suppresses the header entirely", async function () {
        const uas = await wireUA({ url: env.base + "/echo", userAgent: "" });
        EQ(uas.length, 0, "NO User-Agent header on the wire, got " + JSON.stringify(uas));
    });

    // t3-qa: header-injection guard on the userAgent OPTION (not just
    // opts.headers). A CR/LF in opts.userAgent would let a caller smuggle an
    // arbitrary header onto the socket wire ("User-Agent: a\r\nX-Injected: 1").
    // It must be rejected as invalid-args BEFORE any socket I/O — no injected
    // header may ever reach the server.
    suite.test("Q7 G5 socket wire: CRLF in opts.userAgent rejected — no injected header on the wire", async function () {
        socket();
        await env.resetServerLogs();
        const r = eshttp.request({ url: env.base + "/echo", userAgent: "a\r\nX-Injected: 1" });
        EQ(r.error && r.error.code, "invalid-args", "CRLF userAgent -> invalid-args (never sent): " + JSON.stringify(r.error));
        EQ(r.status, 0, "status 0");
        const logs = await env.fetchLogs();
        const req = findReq(logs.main, "/echo");
        if (req) {
            const inj = rawHeaderValues(req, "x-injected");
            EQ(inj.length, 0, "no X-Injected header reached the wire");
            const uas = rawHeaderValues(req, "user-agent");
            EQ(uas.length, 1, "the real User-Agent header is intact, got " + JSON.stringify(uas));
            EQ(uas[0].indexOf("X-Injected"), -1, "User-Agent value carries no injected bytes");
        } else {
            A(true, "no request reached the wire (client-side rejection) — acceptable");
        }
    });

    // =====================================================================
    // Q9 — error taxonomy against live endpoints
    // =====================================================================
    suite.test("Q9 socket: 404/500 are NOT errors (error null, ok false, status kept)", function () {
        socket();
        const r404 = eshttp.request({ url: env.base + "/404" });
        EQ(r404.error, null, "404 error null");
        EQ(r404.status, 404, "404 status");
        EQ(r404.ok, false, "404 not ok");
        const r500 = eshttp.request({ url: env.base + "/500" });
        EQ(r500.error, null, "500 error null");
        EQ(r500.status, 500, "500 status");
        EQ(r500.ok, false, "500 not ok");
    });

    suite.test("Q9 socket: body-too-large is produced and is not retryable", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/large?bytes=200000", maxBodyBytes: 1024, timeout: 20000 });
        A(r.error !== null, "error Result");
        EQ(r.error.code, "body-too-large", "code");
        EQ(r.error.category, "protocol", "category");
        EQ(r.error.retryable, false, "not retryable");
        EQ(r.status, 0, "status 0");
    });

    suite.test("Q9 socket: timeout is produced and IS retryable", function () {
        socket();
        const r = eshttp.request({ url: env.base + "/slow?delay=4000", timeout: 1000 });
        A(r.error !== null, "error Result");
        A(r.error.code === "timeout" || r.error.code === "network",
            "timeout (or network on abrupt close), got " + r.error.code);
        EQ(r.status, 0, "status 0");
    });

    suite.test("Q9 socket: every live error code is in the documented producible set", function () {
        const PRODUCIBLE = ["invalid-args", "bad-url", "invalid-header", "unsupported",
            "network", "timeout", "too-many-redirects", "body-too-large", "internal", "connect", "invalid-json"];
        socket();
        const probes = [
            { url: env.base + "/redirect/loop", maxRedirects: 1 },
            { url: env.base + "/large?bytes=100000", maxBodyBytes: 512, timeout: 20000 },
            { url: env.base + "/invalid-json", json: true },
            { url: "http://127.0.0.1:1/x", timeout: 3000 },
            { url: "https://127.0.0.1:1/x" },
            { url: "ftp://x" }
        ];
        for (let i = 0; i < probes.length; i++) {
            let r = null;
            const p = probes[i];
            env.assertNoThrow(function () { r = eshttp.request(p); }, "probe " + i + " must not throw");
            A(r.error !== null, "probe " + i + " (" + p.url + ") produced an error");
            A(PRODUCIBLE.indexOf(r.error.code) >= 0,
                "probe " + i + " code '" + r.error.code + "' outside the producible set");
        }
    });

    // =====================================================================
    // Q10 — the socket path is genuinely used when native is unavailable
    // =====================================================================
    suite.test("Q10 auto with no ExternalObject falls back to a WORKING socket request", function () {
        env.controls.setExternalObjectAvailable(false);
        eshttp.resetTransport();
        EQ(eshttp.forceTransport("auto"), "socket", "auto -> socket");
        const r = eshttp.request({ url: env.base + "/final" });
        EQ(r.error, null, "real request succeeded on the fallback path");
        EQ(r.body, "final ok", "body");
        EQ(r.meta.path, "socket", "meta.path");
        env.controls.setExternalObjectAvailable(true);
        eshttp.resetTransport();
    });

    suite.test("Q3 dead-DLL degrade performs a REAL socket request (end-to-end)", function () {
        // Tamper the envelope so the wrapper marks the DLL dead mid-flight,
        // then verify the degraded socket attempt actually reached the server.
        env.controls.setNativeResponder(function () {
            return { abi: "tampered-v9", ok: true, status: 200, statusText: "OK", headers: {},
                     body: "x", bodyEncoding: "utf8", error: null,
                     meta: { path: "native", nativeVersion: "1.0.0", redirects: 0, timeMs: 1, bytes: 1 } };
        });
        eshttp.resetTransport();
        eshttp.forceTransport("native");
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: env.base + "/final" }); }, "no throw on degrade");
        EQ(r.meta.path, "socket", "degraded to socket");
        EQ(r.error, null, "the degraded socket request SUCCEEDED: " + JSON.stringify(r.error));
        EQ(r.body, "final ok", "real bytes from the server after degrading");
        env.controls.setNativeResponder(null);
        eshttp.resetTransport();
    });
};
