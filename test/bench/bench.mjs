/**
 * eshttp benchmark harness — baseline capture for perf/baseline blackboard key.
 * Loads the core via the shared test/load-core.mjs (same source selection
 * Runs >=5 warm iterations, reports median + variance (ns/op).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadCore } from "../load-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

// ============================================================================
// 2. (stubs removed — supplied by test/load-core.mjs: Socket/File/Folder/
//    ExternalObject shapes + vm-sandbox/globalThis staging are shared with
//    the QA harness so the benchmark runs the exact same core the suite does)
// ============================================================================


// ============================================================================
// 3. Benchmark utilities
// ============================================================================
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 10;

function hrtimeNs() {
    const [sec, ns] = process.hrtime();
    return sec * 1e9 + ns;
}

function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function variance(arr, med) {
    if (arr.length < 2) return 0;
    const sumSq = arr.reduce((acc, v) => acc + (v - med) ** 2, 0);
    return sumSq / (arr.length - 1);
}

function stdDev(arr, med) {
    return Math.sqrt(variance(arr, med));
}

function formatNs(ns) {
    if (ns < 1000) return `${ns.toFixed(2)} ns`;
    if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
    if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
    return `${(ns / 1e9).toFixed(3)} s`;
}

function runBenchmark(name, fn, iterations = MEASURED_ITERATIONS) {
    // Warmup
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        fn();
    }
    // Measured
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const start = hrtimeNs();
        fn();
        const end = hrtimeNs();
        times.push(end - start);
    }
    const med = median(times);
    const var_ = variance(times, med);
    const sd = stdDev(times, med);
    const cv = med > 0 ? (sd / med) * 100 : 0; // coefficient of variation %
    return { name, times, median: med, variance: var_, stdDev: sd, cv };
}

// ============================================================================
// 4. Main benchmark runner
// ============================================================================
async function main() {
    // Load the core via the shared loader (test/load-core.mjs) — same source
    // selection as the QA harness: ESHTTP_CORE env or --core, defaulting to
    // the built ESM core (dist/eshttp-core.esm.mjs) with jsxinc fallback.
    const coreSource = process.env.ESHTTP_CORE || "esm";
    const loaded = await loadCore({ source: coreSource });
    const eshttp = loaded.eshttp;
    console.log("[bench] loaded core from " + loaded.file + " (source=" + loaded.source + ")");

    // Disable network for pure headless benchmarks
    eshttp.__noNetwork = false; // We want the native path to work via fake ExternalObject
    // Force native transport for native-path benchmarks
    eshttp.forceTransport("native");

    const results = [];

    // -------------------------------------------------------------------------
    // Benchmark 1: eshttp.json.parse + eshttp.json.stringify on a representative object
    // -------------------------------------------------------------------------
    const testObj = {
        string: "hello world",
        number: 42,
        float: 3.14159,
        boolean: true,
        nullValue: null,
        array: [1, 2, 3, "four", "five"],
        nested: {
            a: 1,
            b: "two",
            c: [true, false],
            d: { deep: "value" }
        },
        unicode: "café 🎉 naïve résumé",
        emptyObj: {},
        emptyArr: []
    };
    const testObjStr = eshttp.json.stringify(testObj);

    results.push(runBenchmark("json.stringify", () => {
        eshttp.json.stringify(testObj);
    }));

    results.push(runBenchmark("json.parse", () => {
        eshttp.json.parse(testObjStr);
    }));

    // Round-trip
    results.push(runBenchmark("json.parse+stringify (round-trip)", () => {
        const s = eshttp.json.stringify(testObj);
        eshttp.json.parse(s);
    }));

    // -------------------------------------------------------------------------
    // Benchmark 2: eshttp.helpers.base64Encode / base64Decode on a few hundred bytes
    // -------------------------------------------------------------------------
    const plainText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10); // ~560 bytes
    const b64Encoded = eshttp.helpers.base64Encode(plainText);

    results.push(runBenchmark("helpers.base64Encode (~560 bytes)", () => {
        eshttp.helpers.base64Encode(plainText);
    }));

    results.push(runBenchmark("helpers.base64Decode (~560 bytes)", () => {
        eshttp.helpers.base64Decode(b64Encoded);
    }));

    // Round-trip
    results.push(runBenchmark("helpers.base64Encode+Decode (round-trip)", () => {
        const enc = eshttp.helpers.base64Encode(plainText);
        eshttp.helpers.base64Decode(enc);
    }));

    // Also test with binary data (including null bytes)
    const binaryData = "a\u0000b\u0001c\u0002d\u00FFe".repeat(50); // ~350 bytes with high bytes
    const b64Binary = eshttp.helpers.base64Encode(binaryData);

    results.push(runBenchmark("helpers.base64Encode (binary ~350 bytes)", () => {
        eshttp.helpers.base64Encode(binaryData);
    }));

    results.push(runBenchmark("helpers.base64Decode (binary ~350 bytes)", () => {
        eshttp.helpers.base64Decode(b64Binary);
    }));

    // -------------------------------------------------------------------------
    // Benchmark 3: eshttp.request() dispatch through fake-ExternalObject native path
    // -------------------------------------------------------------------------
    // Configure the native responder to be fast (no I/O)
    loaded.controls.setNativeResponder(function () {
        return {
            abi: "http-v1", ok: true, status: 200, statusText: "OK",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: "{\"ok\":true,\"data\":[1,2,3]}", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: "GET", finalUrl: "http://example.com/", redirects: 0,
                    timeMs: 1, bytes: 25, httpVersion: "1.1", tlsVersion: "1.2",
                    encodingWasApplied: false, nativeVersion: "1.0.0",
                    winhttpError: null, backend: "winhttp" }
        };
    });

    // Force native transport
    eshttp.forceTransport("native");
    eshttp.resetTransport(); // Clear cache

    // Warmup native path
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        eshttp.request({ url: "http://example.com/api", method: "GET" });
    }

    results.push(runBenchmark("request() native path (GET, JSON response)", () => {
        eshttp.request({ url: "http://example.com/api", method: "GET" });
    }, 1000)); // More iterations for request dispatch

    // POST with body
    results.push(runBenchmark("request() native path (POST, JSON body)", () => {
        eshttp.request({
            url: "http://example.com/api",
            method: "POST",
            body: JSON.stringify({ foo: "bar", baz: [1, 2, 3] }),
            headers: { "Content-Type": "application/json" }
        });
    }, 1000));

    // With custom headers
    results.push(runBenchmark("request() native path (GET, custom headers)", () => {
        eshttp.request({
            url: "http://example.com/api",
            method: "GET",
            headers: { "Authorization": "Bearer token123", "X-Custom": "value" }
        });
    }, 1000));

    // -------------------------------------------------------------------------
    // Benchmark 4: eshttp.request() through Socket-stub path (if feasible)
    // -------------------------------------------------------------------------
    // Force socket transport and enable network
    eshttp.forceTransport("socket");
    eshttp.__noNetwork = false;

    // The socket stub will try to connect to a real server, which we don't have.
    // But we can measure the dispatch overhead up to the point where it would connect.
    // We'll use a mock responder that returns immediately (simulating a local server).
    // Actually, the SocketStub spawns a child process - let's just measure the
    // request setup overhead by using a responder that returns an error quickly.

    // For socket path, we need to handle the fact that it will try to connect.
    // Let's create a special responder that makes the socket path return fast.
    // Actually, the socket path doesn't use ExternalObject - it uses the Socket global.
    // The SocketStub will spawn tcp-client.js which will fail to connect.
    // We can measure the overhead anyway - it will fail fast with a timeout/error.

    // Let's just run a few iterations to measure the dispatch overhead
    // (the socket path will return an error result quickly since no server is running)
    results.push(runBenchmark("request() socket path (GET, no server - error path)", () => {
        eshttp.request({ url: "http://127.0.0.1:9999/", method: "GET", timeout: 100 });
    }, 100));

    // -------------------------------------------------------------------------
    // Output results
    // -------------------------------------------------------------------------
    console.log("\n================ BENCHMARK RESULTS ================\n");

    const tableLines = [];
    tableLines.push("| Benchmark | Median | StdDev | Variance | CV% |");
    tableLines.push("|-----------|--------|--------|----------|-----|");

    for (const r of results) {
        tableLines.push(`| ${r.name} | ${formatNs(r.median)} | ${formatNs(r.stdDev)} | ${formatNs(r.variance)} | ${r.cv.toFixed(2)}% |`);
        console.log(`${r.name}: median=${formatNs(r.median)}, stdDev=${formatNs(r.stdDev)}, cv=${r.cv.toFixed(2)}%`);
    }

    // Write results.md
    const resultsMd = [
        "# eshttp Baseline Benchmark Results",
        "",
        `_Generated: ${new Date().toISOString()}_`,
        `_Node: ${process.version} on ${process.platform}_`,
        `_Iterations: ${WARMUP_ITERATIONS} warmup + ${MEASURED_ITERATIONS} measured (request dispatch: 1000/100)_`,
        "",
        "## Results",
        "",
        ...tableLines,
        "",
        "## Raw Data (nanoseconds)",
        "",
        "```json",
        JSON.stringify(results.map(r => ({
            name: r.name,
            median: r.median,
            stdDev: r.stdDev,
            variance: r.variance,
            cv: r.cv,
            times: r.times
        })), null, 2),
        "```"
    ].join("\n");

    const outPath = path.join(__dirname, "results.md");
    fs.writeFileSync(outPath, resultsMd, "utf8");
    console.log(`\n[bench] Results written to ${outPath}`);

    // Publish to blackboard
    const baselineData = {
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
        results: results.map(r => ({
            name: r.name,
            medianNs: r.median,
            stdDevNs: r.stdDev,
            varianceNs: r.variance,
            cvPercent: r.cv
        }))
    };

    // Write to a JSON file that can be read by the swarm_memory tool
    const baselinePath = path.join(__dirname, "baseline.json");
    fs.writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2), "utf8");
    console.log(`[bench] Baseline data written to ${baselinePath}`);

    // Print headline medians for broadcast
    const headline = results
        .filter(r => r.name.includes("json.stringify") || r.name.includes("json.parse") ||
                     r.name.includes("base64Encode") || r.name.includes("base64Decode") ||
                     r.name.includes("request() native"))
        .map(r => `${r.name}: ${formatNs(r.median)}`)
        .join(" | ");

    console.log(`\n[bench] BASELINE CAPTURED: ${headline}`);

    return { results, baselineData };
}

main().catch(e => {
    console.error("[bench] FAILED:", e);
    process.exit(1);
});
