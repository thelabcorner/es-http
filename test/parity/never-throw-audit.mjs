/*
 * never-throw-audit.mjs — t2-js: adversarial never-throw audit.
 *
 * api-spec §2/§3: EVERY public entry point returns a Result and NEVER throws,
 * no matter how hostile the input. This harness hammers the whole public
 * surface with a hostile-value matrix (getter bombs, toString bombs, circular
 * refs, poisoned prototypes, huge/degenerate strings, wrong types) and fails
 * on the FIRST escaping throw.
 *
 * It complements the suite in test/tests/: the suite asserts specific known
 * cases, this walks the cross product so a NEW throwing path cannot hide.
 *
 *   node test/parity/never-throw-audit.mjs
 *
 * Exit 0 = no public entry point threw. Exit 1 = a throw escaped (printed with
 * the entry point, the hostile input that triggered it, and the stack).
 */
import { loadCore } from "../load-core.mjs";

// ---------------------------------------------------------------------------
// 1. Load the core via the shared loader (same as test/harness.js)
// ---------------------------------------------------------------------------
const _core = await loadCore({ source: process.env.ESHTTP_CORE || "esm" });
const eshttp = _core.eshttp;

// Never touch the network: every request must fail as a Result, not hang.
eshttp.__noNetwork = false; // we WANT the real validation + transport path

let checks = 0;
let failures = 0;
const failed = [];

function record(entry, label, e) {
    failures++;
    if (failed.length < 25) {
        failed.push({ entry, label, err: (e && e.stack) ? e.stack : String(e) });
    }
}

// A public call must return SOMETHING and must not throw.
function mustNotThrow(entry, label, fn) {
    checks++;
    try {
        fn();
    } catch (e) {
        record(entry, label, e);
    }
}

// A public REQUEST call must additionally return a well-formed Result.
function mustBeResult(entry, label, fn) {
    checks++;
    let r;
    try {
        r = fn();
    } catch (e) {
        record(entry, label, e);
        return;
    }
    if (r === null || typeof r !== "object") {
        record(entry, label, new Error("did not return a Result object, got " + typeof r));
        return;
    }
    // Result shape per api-spec §3: these fields always exist.
    const missing = [];
    for (const k of ["ok", "status", "headers", "body", "bodyText", "error", "meta"]) {
        if (!(k in r)) { missing.push(k); }
    }
    if (missing.length) {
        record(entry, label, new Error("Result missing fields: " + missing.join(",")));
        return;
    }
    if (r.error === null && r.ok !== true) {
        record(entry, label, new Error("error===null but ok!==true"));
        return;
    }
    if (r.error !== null) {
        if (typeof r.error !== "object" || typeof r.error.code !== "string") {
            record(entry, label, new Error("error present but has no string .code"));
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Hostile value matrix
// ---------------------------------------------------------------------------
const throwingToString = { toString() { throw new Error("BOOM toString"); } };
const throwingValueOf = { valueOf() { throw new Error("BOOM valueOf"); }, toString() { throw new Error("BOOM toString2"); } };

const getterBomb = {};
Object.defineProperty(getterBomb, "url", { get() { throw new Error("BOOM url getter"); }, enumerable: true });

const methodBomb = {};
Object.defineProperty(methodBomb, "method", { get() { throw new Error("BOOM method getter"); }, enumerable: true });
methodBomb.url = "http://127.0.0.1:1/x";

const headersBomb = { url: "http://127.0.0.1:1/x", headers: {} };
Object.defineProperty(headersBomb.headers, "x-boom", { get() { throw new Error("BOOM header getter"); }, enumerable: true });

const queryBomb = { url: "http://127.0.0.1:1/x", query: {} };
Object.defineProperty(queryBomb.query, "q", { get() { throw new Error("BOOM query getter"); }, enumerable: true });

const bodyBomb = { url: "http://127.0.0.1:1/x", method: "POST", body: throwingToString };

const circular = { url: "http://127.0.0.1:1/x", method: "POST", body: {} };
circular.body.self = circular.body;

const deepNest = (() => {
    let o = {};
    const root = o;
    for (let i = 0; i < 5000; i++) { o.n = {}; o = o.n; }
    return { url: "http://127.0.0.1:1/x", method: "POST", body: root };
})();

const hugeString = new Array(200000).join("x");
const loneSurrogate = "\ud800 lone \udfff pair-less \u4e2d\u6587";

// Values that are hostile as a generic "any slot" argument.
const HOSTILE = [
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["true", true],
    ["false", false],
    ["emptyString", ""],
    ["string", "nonsense"],
    ["array", [1, 2, 3]],
    ["emptyArray", []],
    ["function", function () { throw new Error("BOOM fn"); }],
    ["throwingToString", throwingToString],
    ["throwingValueOf", throwingValueOf],
    ["date", new Date(0)],
    ["regexp", /x/g],
    ["hugeString", hugeString],
    ["loneSurrogate", loneSurrogate],
    ["objectNoProto", Object.create(null)],
    ["nested", { a: { b: { c: {} } } }]
];

// URL slot: malformed / hostile URLs that must degrade to a bad-url Result.
const HOSTILE_URLS = [
    "", " ", "\u0000", "http://", "http:///", "://x", "not a url",
    "ftp://example.com/x", "file:///C:/x", "javascript:alert(1)",
    "data:text/plain,hi", "mailto:a@b.c",
    "http://[::1", "http://exa mple.com/x", "http://example.com:notaport/x",
    "http://example.com:99999999/x", "http://user@:80/x", "http://@/x",
    "//example.com/x", "/relative", "?onlyquery", "#onlyfrag",
    "http://" + hugeString + "/x",
    "http://example.com/" + loneSurrogate,
    "HTTP://EXAMPLE.COM/UPPER",
    "http://127.0.0.1:1/\u0000null",
    "http://127.0.0.1:1/%zz%",
    "http://127.0.0.1:1/" + new Array(5000).join("a%"),
    loneSurrogate
];

// ---------------------------------------------------------------------------
// 3. Audit: eshttp.request with hostile opts (whole object)
// ---------------------------------------------------------------------------
// NOTE: __noNetwork must stay FALSE for the validation matrix. _request()
// checks eshttp.__noNetwork FIRST and returns immediately, so running the
// hostile matrix with it enabled tests a one-line early return and NOTHING
// else — every getter bomb below would go uninvoked (verified: 0 getter hits).
// Requests target 127.0.0.1:1 (closed port), so the ones that survive
// validation fail fast as a connection-error Result.
eshttp.__noNetwork = false;

for (const [label, v] of HOSTILE) {
    mustBeResult("request(opts)", "opts=" + label, () => eshttp.request(v));
}
mustBeResult("request(opts)", "opts=getterBomb", () => eshttp.request(getterBomb));
mustBeResult("request(opts)", "opts=methodBomb", () => eshttp.request(methodBomb));
mustBeResult("request(opts)", "opts=headersBomb", () => eshttp.request(headersBomb));
mustBeResult("request(opts)", "opts=queryBomb", () => eshttp.request(queryBomb));
mustBeResult("request(opts)", "opts=bodyBomb", () => eshttp.request(bodyBomb));
mustBeResult("request(opts)", "opts=circularBody", () => eshttp.request(circular));
mustBeResult("request(opts)", "opts=deepNestBody", () => eshttp.request(deepNest));
mustBeResult("request()", "no args", () => eshttp.request());

// Hostile URLs
for (const u of HOSTILE_URLS) {
    mustBeResult("request(url)", "url=" + JSON.stringify(u.slice(0, 60)),
        () => eshttp.request({ url: u }));
}

// Hostile value in EVERY known option slot, one slot at a time.
const SLOTS = [
    "method", "url", "headers", "body", "query", "timeout", "redirect",
    "maxRedirects", "verifyTls", "username", "password", "userAgent",
    "proxy", "decompress", "maxBodyBytes", "bodyIsBase64", "json"
];
for (const slot of SLOTS) {
    for (const [label, v] of HOSTILE) {
        mustBeResult("request(slot)", slot + "=" + label, () => {
            const o = { url: "http://127.0.0.1:1/x" };
            o[slot] = v;
            return eshttp.request(o);
        });
    }
}

// Hostile header NAMES and VALUES (header injection + type abuse).
const HOSTILE_HEADERS = [
    ["", "v"], [" ", "v"], ["a b", "v"], ["a:b", "v"], ["a\nb", "v"],
    ["a\r\nb", "v"], ["\u0000", "v"], ["x", "a\r\nInjected: 1"],
    ["x", "a\nInjected: 1"], ["x", "\u0000"], ["x", loneSurrogate],
    ["x", hugeString], [loneSurrogate, "v"], ["content-length", "-1"],
    ["host", "evil.example.com"], ["x", null], ["x", undefined],
    ["x", 42], ["x", true], ["x", {}], ["x", []], ["x", throwingToString]
];
for (const [hn, hv] of HOSTILE_HEADERS) {
    mustBeResult("request(headers)", "hdr " + JSON.stringify(String(hn).slice(0, 20)) + "=" + typeofLabel(hv),
        () => {
            const h = {};
            try { h[hn] = hv; } catch (ignore) { /* key coercion */ }
            return eshttp.request({ url: "http://127.0.0.1:1/x", headers: h });
        });
}
// headers as a non-object entirely
for (const [label, v] of HOSTILE) {
    mustBeResult("request(headers)", "headers=" + label,
        () => eshttp.request({ url: "http://127.0.0.1:1/x", headers: v }));
}

function typeofLabel(v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return "array";
    return typeof v;
}

// ---------------------------------------------------------------------------
// 4. Convenience verbs — same hostile matrix
// ---------------------------------------------------------------------------
for (const [label, v] of HOSTILE) {
    mustBeResult("get", "url=" + label, () => eshttp.get(v));
    mustBeResult("del", "url=" + label, () => eshttp.del(v));
    mustBeResult("get+opts", "opts=" + label, () => eshttp.get("http://127.0.0.1:1/x", v));
    mustBeResult("post", "body=" + label, () => eshttp.post("http://127.0.0.1:1/x", v));
    mustBeResult("put", "body=" + label, () => eshttp.put("http://127.0.0.1:1/x", v));
    mustBeResult("post+opts", "opts=" + label, () => eshttp.post("http://127.0.0.1:1/x", "b", v));
}
mustBeResult("get", "no args", () => eshttp.get());
mustBeResult("post", "no args", () => eshttp.post());
mustBeResult("put", "no args", () => eshttp.put());
mustBeResult("del", "no args", () => eshttp.del());
mustBeResult("post", "circular body", () => eshttp.post("http://127.0.0.1:1/x", circular.body));
mustBeResult("post", "getter-bomb body", () => eshttp.post("http://127.0.0.1:1/x", getterBomb));

// ---------------------------------------------------------------------------
// 5. Non-Result public surface: must not throw (return value is free-form)
// ---------------------------------------------------------------------------
for (const [label, v] of HOSTILE) {
    mustNotThrow("configure", "opts=" + label, () => eshttp.configure(v));
    mustNotThrow("forceTransport", "name=" + label, () => eshttp.forceTransport(v));
    mustNotThrow("json", "arg=" + label, () => eshttp.json(v));
    mustNotThrow("json.parse", "arg=" + label, () => eshttp.json.parse(v));
    mustNotThrow("json.stringify", "arg=" + label, () => eshttp.json.stringify(v));
}
mustNotThrow("configure", "getterBomb", () => eshttp.configure(getterBomb));
mustNotThrow("json.stringify", "circular", () => eshttp.json.stringify(circular.body));
mustNotThrow("json.stringify", "deepNest", () => eshttp.json.stringify(deepNest.body));
mustNotThrow("json.parse", "hugeString", () => eshttp.json.parse(hugeString));
mustNotThrow("transportInfo", "()", () => eshttp.transportInfo());
mustNotThrow("resetTransport", "()", () => eshttp.resetTransport());
mustNotThrow("forceTransport", "()", () => eshttp.forceTransport());
mustNotThrow("configure", "()", () => eshttp.configure());
mustNotThrow("defaults", "read", () => JSON.stringify(eshttp.defaults));
mustNotThrow("_selftest", "()", () => eshttp._selftest());

// Malformed JSON strings through the public json lane.
const BAD_JSON = [
    "", " ", "{", "}", "[", "]", "{,}", "[,]", '{"a"}', '{"a":}', '{a:1}',
    "'x'", "01", "1.", ".1", "+1", "-", "1e", "1e+", "NaN", "Infinity",
    "undefined", "tru", "nul", '"\\u12"', '"\\q"', '"unterminated',
    '{"a":1,}', '[1,]', "\u0000", '{"__proto__":{"x":1}}',
    '{"a":' + new Array(2000).join("[") , new Array(2000).join("[")
];
for (const s of BAD_JSON) {
    mustNotThrow("json.parse", "bad " + JSON.stringify(s.slice(0, 30)), () => eshttp.json.parse(s));
}

// ---------------------------------------------------------------------------
// 6. Transport-forced paths (native stub + socket) with hostile envelopes
// ---------------------------------------------------------------------------
eshttp.__noNetwork = false;

// Drive the NATIVE path via the driver hook with hostile driver returns.
const HOSTILE_DRIVER_RETURNS = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["number", () => 42],
    ["string", () => "garbage"],
    ["emptyObj", () => ({})],
    ["throws", () => { throw new Error("BOOM driver"); }],
    ["badAbi", () => ({ envelope: { abi: "nope", status: 200 } })],
    ["nullEnvelope", () => ({ envelope: null })],
    ["envNoStatus", () => ({ envelope: { abi: "http-v1" } })],
    ["envBadHeaders", () => ({ envelope: { abi: "http-v1", status: 200, headers: "nope" } })],
    ["envBadBody", () => ({ envelope: { abi: "http-v1", status: 200, body: 42 } })],
    ["envBadB64", () => ({ envelope: { abi: "http-v1", status: 200, body: "!!!bad!!!", bodyEncoding: "base64" } })],
    ["envGetterBomb", () => {
        const env = { abi: "http-v1", status: 200 };
        Object.defineProperty(env, "body", { get() { throw new Error("BOOM env body"); }, enumerable: true });
        return { envelope: env };
    }],
    ["envCircularMeta", () => {
        const m = {}; m.self = m;
        return { envelope: { abi: "http-v1", status: 200, body: "", meta: m } };
    }]
];

const savedNative = eshttp._drivers && eshttp._drivers.native;
const savedSocket = eshttp._drivers && eshttp._drivers.socket;

if (typeof eshttp._setDriver === "function") {
    for (const [label, fn] of HOSTILE_DRIVER_RETURNS) {
        mustBeResult("native driver", "returns " + label, () => {
            eshttp._setDriver("native", fn);
            eshttp.resetTransport();
            eshttp.forceTransport("native");
            return eshttp.request({ url: "http://127.0.0.1:1/x" });
        });
    }
    for (const [label, fn] of HOSTILE_DRIVER_RETURNS) {
        mustBeResult("socket driver", "returns " + label, () => {
            eshttp._setDriver("socket", fn);
            eshttp.resetTransport();
            eshttp.forceTransport("socket");
            return eshttp.request({ url: "http://127.0.0.1:1/x" });
        });
    }
    // restore
    if (savedNative) { eshttp._setDriver("native", savedNative); }
    if (savedSocket) { eshttp._setDriver("socket", savedSocket); }
    eshttp.resetTransport();
}

// ---------------------------------------------------------------------------
// 7. Report
// ---------------------------------------------------------------------------
if (failures > 0) {
    console.error("eshttp never-throw audit: " + failures + " FAILURE(S) of " + checks + " checks\n");
    for (const f of failed) {
        console.error("  [" + f.entry + "] " + f.label);
        console.error("      " + String(f.err).split("\n").slice(0, 4).join("\n      "));
    }
    if (failures > failed.length) {
        console.error("  ... and " + (failures - failed.length) + " more");
    }
    process.exit(1);
}
console.log("eshttp never-throw audit: all " + checks + " public-entry checks returned a Result (0 throws escaped)");
