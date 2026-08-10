// live-load-eshttp.jsx — load dist/eshttp.jsx in a live Illustrator instance
// and exercise the http-api-v1 surface. Results are written to a temp JSON
// file (side-channel pattern per the COM skill). QA infrastructure only.
#target illustrator

(function () {
    var out = {
        loaded: false,
        globalDefined: false,
        api: {},
        smoke: {},
        errors: []
    };
    function recErr(where, e) {
        try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); }
        catch (x) { out.errors.push(where + ": (unprintable)"); }
    }
    try {
        var JSX = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx";
        // The IIFE artifact defines the global `eshttp` when evaled. $.evalFile
        // returns the last expression; the global side-effect is what we need.
        $.evalFile(JSX);
        out.loaded = true;
    } catch (e) { recErr("evalFile", e); }

    try {
        out.globalDefined = (typeof eshttp !== "undefined" && eshttp !== null);
    } catch (e) { recErr("global probe", e); }

    if (out.globalDefined) {
        var es = eshttp;
        out.api = {
            request: typeof es.request,
            get: typeof es.get,
            post: typeof es.post,
            put: typeof es.put,
            del: typeof es.del,
            json: typeof es.json,
            jsonParse: es.json ? typeof es.json.parse : "n/a",
            jsonStringify: es.json ? typeof es.json.stringify : "n/a",
            configure: typeof es.configure,
            forceTransport: typeof es.forceTransport,
            resetTransport: typeof es.resetTransport,
            transportInfo: typeof es.transportInfo,
            transport: typeof es.transport,
            DEFAULTS: typeof es.DEFAULTS,
            error: typeof es.error,
            version: es.version,
            helpers: typeof es.helpers,
            selftest: typeof es._selftest
        };
        try {
            var st = es._selftest();
            out.smoke.selftest = st && st.pass === true;
        } catch (e) { recErr("selftest", e); }
        try {
            var jr = es.json.parse('{"ok":true,"n":42}');
            out.smoke.jsonParse = jr && jr.ok === true && jr.n === 42;
        } catch (e) { recErr("json.parse", e); }
        try {
            out.smoke.jsonStringify = es.json.stringify({ a: 1 }) === '{"a":1}';
        } catch (e) { recErr("json.stringify", e); }
        try {
            out.smoke.b64 = es.helpers.base64Encode("f") === "Zg==";
        } catch (e) { recErr("base64", e); }
        try {
            var ti = es.transportInfo();
            out.smoke.transportInfo = (ti && typeof ti.transport === "string");
        } catch (e) { recErr("transportInfo", e); }
        try {
            es.__noNetwork = true;
            var nr = es.request({ url: "http://127.0.0.1:1/x" });
            out.smoke.noNetwork = (nr && nr.error && nr.error.code === "unsupported");
            es.__noNetwork = false;
        } catch (e) { recErr("request noNetwork", e); }
        try {
            var d = es.DEFAULTS;
            out.smoke.defaults8 = (d && typeof d.timeout === "number" && typeof d.userAgent === "string");
        } catch (e) { recErr("DEFAULTS", e); }
    }

    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-live-probe.json");
    try {
        f.open("w");
        f.writeln(JSON.stringify(out));
        f.close();
    } catch (e) {
        try { f.close(); } catch (x) {}
        recErr("write probe file", e);
    }
    return out.loaded + "|" + out.globalDefined;
})();
