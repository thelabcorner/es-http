// live-estc-gate.jsx — minimal deterministic real-engine gate for the
// ESTC-built eshttp artifact. Run via test/live/run-live-gate.mjs, which
// substitutes __RESULT__ / __ARTIFACT__ / __BASE_URL__ and starts the local
// mock server. No external network is touched.
//
//   1. eval the canonical artifact ($.evalFile) after clearing stale globals;
//   2. assert the http-api-v1 facade surface + DEFAULTS/transport shape;
//   3. run the facade's pure in-engine _selftest() and a JSON round-trip;
//   4. verify the __noNetwork hook returns the documented `unsupported` error;
//   5. ONE localhost request through the normally-resolved transport and
//      verify status/body (parsed JSON) — the same path a caller would use.
#target illustrator
(function () {
    var RESULT = "__RESULT__";
    var ARTIFACT = "__ARTIFACT__";
    var BASE = "__BASE_URL__";
    var out = { steps: [], errors: [], selftest: null, facade: {}, local: null };

    function rec(where, e) {
        try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); }
        catch (x) { out.errors.push(where + ": (unprintable)"); }
    }
    function writeOut() {
        try {
            var f = new File(RESULT);
            f.encoding = "UTF-8";
            if (f.open("w")) { f.write(JSON.stringify(out)); f.close(); }
        } catch (e) {}
    }

    // 1. clear any stale ESHTTP state inherited from earlier evals in this
    // engine (live-parse/accel probes publish facades + session caches), then
    // eval the canonical artifact fresh. The gate must be idempotent across
    // repeated runs in the same Illustrator process.
    try { delete eshttp; } catch (e1) {}
    try { if ($.global) { delete $.global.eshttp; } } catch (e2) {}
    try { if ($.global) { delete $.global.__eshttp_native_v1; } } catch (e2b) {}
    try { if ($.global) { delete $.global.ESPAK; } } catch (e2c) {}
    try { if ($.global) { delete $.global.ESON; } } catch (e2d) {}
    try { if ($.global) { delete $.global.ESB64; } } catch (e2e) {}
    try { $.evalFile(ARTIFACT); out.steps.push("evalFile"); }
    catch (e) { rec("evalFile", e); writeOut(); return "EVALFAIL"; }

    // 2. facade surface (http-api-v1 public contract).
    try {
        out.facade.typeofGlobal = typeof eshttp;
        out.facade.isObject = (typeof eshttp === "object" && eshttp !== null);
        out.facade.request = typeof eshttp.request;
        out.facade.get = typeof eshttp.get;
        out.facade.post = typeof eshttp.post;
        out.facade.put = typeof eshttp.put;
        out.facade.del = typeof eshttp.del;
        out.facade.jsonParse = typeof eshttp.json.parse;
        out.facade.jsonStringify = typeof eshttp.json.stringify;
        out.facade.helpersB64 = typeof eshttp.helpers.base64Encode;
        out.facade.transportType = typeof eshttp.transport;
        out.facade.transportValue = String(eshttp.transport);
        out.facade.defaultsTimeout = eshttp.DEFAULTS && eshttp.DEFAULTS.timeout;
        out.facade.version = String(eshttp.version);
        out.steps.push("facade");
    } catch (e) { rec("facade", e); }

    // 3. pure in-engine selftest + codec round-trip.
    if (typeof eshttp !== "undefined" && eshttp && typeof eshttp._selftest === "function") {
        try {
            var st = eshttp._selftest();
            out.selftest = { pass: st.pass === true, count: st.tests ? st.tests.length : -1 };
        } catch (e) { rec("selftest", e); }
    }
    if (typeof eshttp !== "undefined" && eshttp && eshttp.json) {
        try {
            out.facade.jsonRoundtrip = (eshttp.json.stringify(eshttp.json.parse('{"a":1}')) === '{"a":1}');
            out.facade.b64 = (eshttp.helpers.base64Encode("f") === "Zg==");
        } catch (e) { rec("codec", e); }
    }

    // 4. __noNetwork hook (deterministic, touches no I/O).
    if (typeof eshttp !== "undefined" && eshttp && typeof eshttp.request === "function") {
        try {
            eshttp.__noNetwork = true;
            var nr = eshttp.request({ url: BASE + "/json" });
            out.facade.noNetwork = !!(nr && nr.error && nr.error.code === "unsupported");
            eshttp.__noNetwork = false;
        } catch (e) { rec("noNetwork", e); }
    }

    // 5. ONE localhost request through the normally-resolved transport.
    if (typeof eshttp !== "undefined" && eshttp && typeof eshttp.request === "function") {
        try {
            var ti = eshttp.transportInfo();
            out.transport = {
                transport: ti.transport,
                externalObjectAvailable: ti.externalObjectAvailable,
                socketAvailable: ti.socketAvailable
            };
            var r = eshttp.get(BASE + "/json", { timeout: 15000, maxBodyBytes: 1048576 });
            var bodyOk = false;
            try {
                var parsed = eshttp.json.parse(r.body);
                bodyOk = !!(parsed && parsed.ok === true);
            } catch (e3) {}
            out.local = {
                ok: !!(r && r.ok),
                status: r && r.status,
                path: r && r.meta ? r.meta.path : null,
                bodyLen: r && r.body ? r.body.length : -1,
                bodyParsedOk: bodyOk,
                errorCode: r && r.error ? r.error.code : null,
                error: r && r.error ? r.error.message : null
            };
            out.steps.push("local-request");
        } catch (e) { rec("local", e); }
    }

    writeOut();
    return "OK|" + (out.selftest && out.selftest.pass ? "selftest" : "noselftest") +
        "|" + (out.local ? (out.local.status + "/" + (out.local.path || "-")) : "no-local");
})();
