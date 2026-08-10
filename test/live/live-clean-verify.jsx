// live-clean-verify.jsx — CLEAN verification: reset the eshttp global, load
// the quoted-default fixed artifact, then check facade members in-script.
#target illustrator

(function () {
    var out = { step: "", errors: [] };
    function recErr(where, e) {
        try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); }
        catch (x) { out.errors.push(where + ": (unprintable)"); }
    }
    // 1. clear any stale global
    try { delete eshttp; } catch (e) {}
    try { delete $.global.eshttp; } catch (e) {}

    // 2. load the fixed artifact
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx");
        out.step = "loaded";
    } catch (e) { out.step = "load-failed"; recErr("evalFile", e); }

    // 3. inspect global shape + members in THIS script
    try {
        out.typeofGlobal = typeof eshttp;
        out.isObject = (typeof eshttp === "object" && eshttp !== null);
        if (out.isObject) {
            out.requestType = typeof eshttp.request;
            out.hasDefault = ("default" in eshttp);
            out.version = eshttp.version;
            out.selftestType = typeof eshttp._selftest;
            out.helpersType = typeof eshttp.helpers;
        }
    } catch (e) { recErr("inspect", e); }

    // 4. smoke: selftest + json + b64 + noNetwork
    if (out.isObject && typeof eshttp._selftest === "function") {
        try { var st = eshttp._selftest(); out.selftestPass = st && st.pass === true; }
        catch (e) { recErr("selftest", e); }
    }
    if (out.isObject && eshttp.json) {
        try { var jr = eshttp.json.parse('{"ok":true}'); out.jsonParse = jr && jr.ok === true; }
        catch (e) { recErr("json.parse", e); }
        try { out.jsonStringify = eshttp.json.stringify({ a: 1 }) === '{"a":1}'; }
        catch (e) { recErr("json.stringify", e); }
    }
    if (out.isObject && eshttp.helpers) {
        try { out.b64 = eshttp.helpers.base64Encode("f") === "Zg=="; }
        catch (e) { recErr("base64", e); }
    }
    if (out.isObject && typeof eshttp.request === "function") {
        try {
            eshttp.__noNetwork = true;
            var nr = eshttp.request({ url: "http://127.0.0.1:1/x" });
            out.noNetwork = (nr && nr.error && nr.error.code === "unsupported");
            eshttp.__noNetwork = false;
        } catch (e) { recErr("noNetwork", e); }
    }

    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-clean-verify.json");
    try { f.open("w"); f.writeln(JSON.stringify(out)); f.close(); }
    catch (e) { try { f.close(); } catch (x) {} recErr("write", e); }
    return out.step + "|" + out.typeofGlobal + "|" + out.requestType;
})();


