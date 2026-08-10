/*
 * mock-server.js — local cleartext HTTP mock for the eshttp QA suite.
 * ------------------------------------------------------------------
 * Serves the endpoints the eshttp socket-path tests need: JSON endpoints,
 * redirect chains (same-host and CROSS-host), 404/500, large bodies,
 * chunked responses, duplicate headers, UTF-8 payloads, slow responses.
 *
 * Every request (except the /__* test-infra routes) is recorded in an
 * in-memory log that tests inspect via GET /__requests. This is how the
 * G1 cross-host test proves Authorization was NOT forwarded to the second
 * host: the cross server's log shows no authorization header.
 *
 * Two servers are expected on different ports (a "main" one and a "cross"
 * one); the main server's /redirect/cross endpoint points at the cross
 * server via --crossPort. In-process harness usage:
 *
 *   const m = require('./mock-server.js');
 *   const cross = await m.start({ name: 'cross', port: 0 });
 *   const main  = await m.start({ name: 'main', port: 0, crossPort: cross.port });
 *
 * CLI (for external / --net runs):
 *   node test/mock-server.js --name main --port 18080 --crossPort 18081
 *   node test/mock-server.js --name cross --port 18081
 *
 * This file is QA infrastructure only — NOT part of the eshttp library.
 */
"use strict";

const http = require("http");

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------
const requests = []; // { server, ts, method, url, httpVersion, headers, rawHeaders, body }

function record(serverName, req, bodyBuf) {
    requests.push({
        server: serverName,
        ts: Date.now(),
        method: req.method,
        url: req.url,
        httpVersion: req.httpVersion,
        headers: req.headers,          // lowercased map, duplicates joined ", " by Node
        rawHeaders: req.rawHeaders,    // flat [name, value, ...] preserving case + duplicates
        body: bodyBuf.toString("utf8"),
        bodyB64: bodyBuf.toString("base64")
    });
}

function json(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    const headers = Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extraHeaders || {});
    headers["Content-Length"] = Buffer.byteLength(body);
    res.writeHead(status, headers);
    res.end(body);
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------
function makeHandler(name, options) {
    const crossPort = options.crossPort || 18081;

    return function handle(req, res) {
        const url = req.url;
        const pathname = url.split("?")[0];
        const query = parseQuery(url);

        // ---- test infrastructure (never logged) ---------------------------
        if (pathname === "/__requests") {
            json(res, 200, { server: name, count: requests.length, requests: requests });
            return;
        }
        if (pathname === "/__reset") {
            requests.length = 0;
            json(res, 200, { reset: true });
            return;
        }

        // ---- collect body, then route -------------------------------------
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const bodyBuf = Buffer.concat(chunks);
            record(name, req, bodyBuf);

            const info = {
                method: req.method,
                url: req.url,
                httpVersion: req.httpVersion,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                body: bodyBuf.toString("utf8")
            };

            if (pathname === "/json") {
                json(res, 200, { ok: true, received: info });
                return;
            }
            if (pathname === "/invalid-json") {
                // Claims JSON but the body is not parseable (G2 test).
                const body = "this is {not valid json";
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
                                     "Content-Length": Buffer.byteLength(body) });
                res.end(body);
                return;
            }
            if (pathname === "/echo" || pathname === "/echo-all" || pathname === "/echo-method") {
                json(res, 200, info);
                return;
            }
            if (pathname === "/utf8") {
                const body = JSON.stringify({ msg: "héllo wörld 世界 ☃" });
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
                                     "Content-Length": Buffer.byteLength(body) });
                res.end(body);
                return;
            }
            if (pathname === "/dup-headers") {
                // Sends repeated headers for the lowercasing/join test (OBS-2).
                res.writeHead(200, {
                    "Content-Type": "text/plain; charset=utf-8",
                    "X-N": ["1", "2"],
                    "Set-Cookie": ["a=1", "b=2"],
                    "Content-Length": 3
                });
                res.end("dup");
                return;
            }
            if (pathname === "/headers") {
                json(res, 200, { headers: req.headers, rawHeaders: req.rawHeaders });
                return;
            }
            if (pathname === "/404") {
                const body = "not found";
                res.writeHead(404, { "Content-Type": "text/plain", "Content-Length": body.length });
                res.end(body);
                return;
            }
            if (pathname === "/500") {
                const body = "boom";
                res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": body.length });
                res.end(body);
                return;
            }
            if (pathname === "/large") {
                const bytes = Math.max(0, parseInt(query.bytes, 10) || 1000000);
                res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": bytes });
                res.end(Buffer.alloc(bytes, 0x78)); // 'x'
                return;
            }
            if (pathname === "/chunked") {
                res.writeHead(200, { "Content-Type": "text/plain" }); // no CL -> chunked
                res.write("Hello, ");
                setTimeout(() => { res.write("chunked "); res.write("world!"); res.end(); }, 20);
                return;
            }

            // ---- RAW-WIRE routes -------------------------------------------
            // eshttp always sends "Connection: close", so Node's own framing
            // collapses to read-to-EOF and we can never observe a real
            // Transfer-Encoding: chunked body through res.write(). These
            // routes bypass Node's HTTP writer and emit exact bytes so the QA
            // suite can test the ES3 socket driver's framing paths (Q8).
            if (pathname === "/raw-chunked") {
                rawRespond(res,
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: text/plain; charset=utf-8\r\n" +
                    "Transfer-Encoding: chunked\r\n" +
                    "Connection: close\r\n" +
                    "\r\n" +
                    "7\r\nHello, \r\n" +
                    "8\r\nchunked \r\n" +
                    "6\r\nworld!\r\n" +
                    "0\r\n\r\n");
                return;
            }
            if (pathname === "/raw-chunked-ext") {
                // chunk-size with a chunk-extension + trailer section.
                rawRespond(res,
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: text/plain\r\n" +
                    "Transfer-Encoding: chunked\r\n" +
                    "Connection: close\r\n" +
                    "\r\n" +
                    "5;foo=bar\r\nhello\r\n" +
                    "0\r\nX-Trailer: t\r\n\r\n");
                return;
            }
            if (pathname === "/raw-eof") {
                // No Content-Length, no Transfer-Encoding: body is framed
                // purely by the connection close (read-to-EOF).
                rawRespond(res,
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: text/plain; charset=utf-8\r\n" +
                    "Connection: close\r\n" +
                    "\r\n" +
                    "framed by eof only");
                return;
            }
            if (pathname === "/raw-dup-headers") {
                // Exact repeated header lines: ", " join for normal headers,
                // "; " join for Set-Cookie (api-spec §3 / native-abi §4.2).
                rawRespond(res,
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: text/plain; charset=utf-8\r\n" +
                    "X-N: 1\r\n" +
                    "X-N: 2\r\n" +
                    "Set-Cookie: a=1\r\n" +
                    "Set-Cookie: b=2\r\n" +
                    "Content-Length: 3\r\n" +
                    "Connection: close\r\n" +
                    "\r\n" +
                    "dup");
                return;
            }
            if (pathname === "/raw-utf8") {
                // UTF-8 bytes with a byte-accurate Content-Length (Q5).
                const payload = Buffer.from(JSON.stringify({ msg: "héllo wörld 世界 ☃" }), "utf8");
                rawRespond(res, Buffer.concat([
                    Buffer.from(
                        "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: application/json; charset=utf-8\r\n" +
                        "Content-Length: " + payload.length + "\r\n" +
                        "Connection: close\r\n" +
                        "\r\n", "utf8"),
                    payload
                ]));
                return;
            }
            if (pathname === "/raw-204") {
                rawRespond(res, "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                return;
            }
            if (pathname === "/raw-garbage") {
                rawRespond(res, "!!! this is not an HTTP response at all\r\n\r\nnope");
                return;
            }
            if (pathname === "/slow") {
                const delay = Math.max(0, parseInt(query.delay, 10) || 1000);
                setTimeout(() => {
                    const body = "slow response";
                    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": body.length });
                    res.end(body);
                }, delay);
                return;
            }
            if (pathname === "/final") {
                const body = "final ok";
                res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": body.length });
                res.end(body);
                return;
            }
            if (/^\/redirect\/cross$/.test(pathname)) {
                redirect(res, 302, "http://127.0.0.1:" + crossPort + "/cross-target");
                return;
            }
            if (/^\/redirect\/loop$/.test(pathname)) {
                redirect(res, 302, "/redirect/loop");
                return;
            }
            if (/^\/redirect\/301$/.test(pathname)) { redirect(res, 301, "/echo-method"); return; }
            if (/^\/redirect\/302$/.test(pathname)) { redirect(res, 302, "/echo-all"); return; }
            if (/^\/redirect\/303$/.test(pathname)) { redirect(res, 303, "/echo-all"); return; }
            if (/^\/redirect\/307$/.test(pathname)) { redirect(res, 307, "/echo-all"); return; }
            if (/^\/redirect\/308$/.test(pathname)) { redirect(res, 308, "/echo-all"); return; }
            const rm = /^\/redirect\/(\d+)$/.exec(pathname);
            if (rm) {
                const n = parseInt(rm[1], 10);
                const next = n > 1 ? "/redirect/" + (n - 1) : "/final";
                redirect(res, 302, next);
                return;
            }
            if (pathname === "/cross-target") {
                // Cross server: report exactly what authorization (if any)
                // arrived — this is the G1 assertion point.
                json(res, 200, {
                    authorization: req.headers.authorization || null,
                    received: info
                });
                return;
            }

            const body = "no such route: " + pathname;
            res.writeHead(404, { "Content-Type": "text/plain", "Content-Length": body.length });
            res.end(body);
        });
    };

    function redirect(res, status, location) {
        res.writeHead(status, { Location: location, "Content-Length": 0 });
        res.end();
    }

    // Write exact bytes onto the socket, bypassing Node's HTTP response
    // writer entirely, then close (so the ES3 read-to-EOF loop terminates).
    function rawRespond(res, bytes) {
        const sock = res.socket;
        res.detachSocket ? res.detachSocket(sock) : null;
        sock.end(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"));
    }
}

function parseQuery(url) {
    const q = {};
    const idx = url.indexOf("?");
    if (idx < 0) { return q; }
    url.slice(idx + 1).split("&").forEach((kv) => {
        const eq = kv.indexOf("=");
        if (eq < 0) { q[kv] = ""; } else { q[kv.slice(0, eq)] = kv.slice(eq + 1); }
    });
    return q;
}

// ---------------------------------------------------------------------------
// start() — programmatic API
// ---------------------------------------------------------------------------
function start(options) {
    options = options || {};
    const name = options.name || "main";
    const port = options.port === undefined ? 0 : options.port;
    const crossPort = options.crossPort || 18081;

    return new Promise((resolve, reject) => {
        const server = http.createServer(makeHandler(name, { crossPort: crossPort }));
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
            const actualPort = server.address().port;
            console.log("ESHTTP_MOCK_LISTENING name=" + name + " port=" + actualPort);
            resolve({
                name: name,
                port: actualPort,
                url: "http://127.0.0.1:" + actualPort,
                server: server,
                requests: requests,
                stop: () => new Promise((res2) => server.close(res2))
            });
        });
    });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
    const args = {};
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a.indexOf("--") === 0) {
            const key = a.slice(2);
            const val = process.argv[i + 1];
            args[key] = val !== undefined && val.indexOf("--") !== 0 ? val : true;
        }
    }
    start({
        name: args.name || "main",
        port: args.port !== undefined ? parseInt(args.port, 10) : 18080,
        crossPort: args.crossPort !== undefined ? parseInt(args.crossPort, 10) : 18081
    }).catch((e) => {
        console.error("mock-server failed: " + e.message);
        process.exit(1);
    });
}

module.exports = { start: start };
