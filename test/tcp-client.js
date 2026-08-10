/*
 * tcp-client.js — synchronous raw-TCP bridge for the QA harness.
 * ------------------------------------------------------------------
 * The ES3 Socket driver inside eshttp.jsxinc is synchronous: it calls
 * socket.open(host, port, timeoutSec), socket.write(str), socket.read(),
 * socket.eof, socket.close(). Node's net.Socket is async, so the harness
 * Socket stub (see harness.js) satisfies the driver by shelling out to THIS
 * helper with child_process.spawnSync. This helper:
 *
 *   1. reads the ENTIRE raw request (head + body) from stdin,
 *   2. connects to host:port,
 *   3. writes the request bytes as UTF-8 (matching ExtendScript Socket's
 *      default UTF-8 encoding),
 *   4. reads the response until the peer closes (Connection: close) or a
 *      wall-clock timeout fires,
 *   5. prints "OK:<base64 of response>" (or "ERR:<message>") to stdout and
 *      exits.
 *
 * Usage:  node tcp-client.js <host> <port> <timeoutMs>
 *
 * This file is QA infrastructure only — NOT part of the eshttp library.
 */
"use strict";

const net = require("net");

const host = process.argv[2];
const port = parseInt(process.argv[3], 10);
const timeoutMs = parseInt(process.argv[4], 10) || 30000;

let request = Buffer.alloc(0);
process.stdin.on("data", (d) => { request = Buffer.concat([request, d]); });
process.stdin.on("end", () => { doRequest(request); });

function doRequest(data) {
    const sock = new net.Socket();
    let out = Buffer.alloc(0);
    let done = false;

    const finish = (err) => {
        if (done) { return; }
        done = true;
        try { sock.destroy(); } catch (e) { /* ignore */ }
        if (err) {
            process.stdout.write("ERR:" + String((err && err.message) || err));
            process.exit(1);
        } else {
            process.stdout.write("OK:" + out.toString("base64"));
            process.exit(0);
        }
    };

    sock.setTimeout(timeoutMs);
    sock.on("connect", () => { if (data.length) { sock.write(data); } });
    sock.on("data", (d) => { out = Buffer.concat([out, d]); });
    sock.on("end", () => { finish(); });
    sock.on("close", () => { finish(); });
    sock.on("error", (e) => { finish(e); });
    sock.on("timeout", () => { finish(new Error("timeout")); });

    sock.connect({ host: host, port: port });
}
