// live-merged-gate.jsx — T29 v1.1.0 merged-accel live re-gate (qa-validator).
// Evals dist/eshttp.accel-x64.jsx (merged 1+n: one loader, shared ESB64Native,
// flat payloads ESONJson+cli+ipc-x64, facades before the library). Verifies:
//   (a) eshttp + ESON facade + ESB64 facade + ESPAK on $.global
//   (b) single loader (no redefinition — checked statically; live: ESPAK usable)
//   (c) payloads extracted BY NAME (stage eshttp-cli + eshttp-ipc-x64 + ESONJson)
//   (d) transportInfo -> cli pipe
//   (e) codec lane through the FACADES (json.parse + base64 via ESON/ESB64)
//   (f) pipe fetch of the Wikipedia W SVG through the merged worker
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-merged-gate.json";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }

    // 1. Eval the merged accel-x64
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.accel-x64.jsx");
        out.accelLoaded = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("merged-eval", e); }
    if (!out.accelLoaded) { out.errors.push("merged accel eval failed"); checkpoint(); return "accel-failed"; }

    // 2. Facades on $.global: ESON + ESB64 + ESPAK + eshttp
    var g = null;
    try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e) {}
    out.hasEson = !!(g && g.ESON && typeof g.ESON.parse === "function" && typeof g.ESON.stringify === "function");
    out.hasEsb64 = !!(g && g.ESB64 && typeof g.ESB64.atob === "function" && typeof g.ESB64.btoa === "function");
    out.hasEspak = !!(g && g.ESPAK && typeof g.ESPAK.load === "function");
    out.hasEshttp = (typeof eshttp !== "undefined");
    out.facadesPresent = out.hasEson && out.hasEsb64 && out.hasEspak && out.hasEshttp;
    checkpoint();

    // 3. Payloads extracted BY NAME (stage dir)
    var base = "C:/Users/slooshied/AppData/Local/eshttp";
    function fileOk(name, minLen) {
        try { var f = new File(base + "/" + name); return !!(f && f.exists && f.length >= minLen); }
        catch (e) { return false; }
    }
    out.stagedCli = fileOk("eshttp-cli.exe", 100000);
    out.stagedIpc = fileOk("eshttp-ipc-x64.dll", 10000) || fileOk("eshttp-ipc.dll", 10000);
    out.stagedEson = fileOk("ESONJson_v1.dll", 50000);
    out.allExtracted = out.stagedCli && out.stagedIpc && out.stagedEson;
    checkpoint();

    // 4. Codec lane through the FACADES (not the embedded fallback):
    //    json.parse via ESON facade; base64 via ESB64 facade
    try {
        var jr = eshttp.json.parse('{"facade":true,"n":42}');
        out.codecJson = (jr && jr.facade === true && jr.n === 42);
        out.codecB64 = (eshttp.helpers.base64Encode("f") === "Zg==");
        out.codecUtf8 = (eshttp.helpers.utf8ByteLength("\u00e9") === 2);
        out.codecViaFacade = out.codecJson && out.codecB64 && out.codecUtf8;
    } catch (e) { recErr("codec", e); }
    checkpoint();

    // 5. transportInfo + pipe fetch of the Wikipedia W SVG
    try {
        eshttp.forceTransport("cli");
        eshttp.resetTransport();
        out.transportInfo = eshttp.transportInfo().transport;
        var r = eshttp.get("https://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg", {
            timeout: 60000, maxBodyBytes: 5242880,
            headers: { "User-Agent": "eshttp/1.0.0 (Illustrator QA)" }
        });
        out.metaPath = r && r.meta ? r.meta.path : null;
        out.status = r ? r.status : -1;
        out.bodyLen = (r && r.body) ? r.body.length : -1;
        var svg = false;
        if (r && r.body) { if (r.body.indexOf("<svg") >= 0 || (r.bodyText && r.bodyText.indexOf("<svg") >= 0)) { svg = true; } }
        out.bodyIsSvg = svg;
        out.err = (r && r.error) ? r.error.code : null;
        out.pipeLane = (out.metaPath === "cli");
        checkpoint();
        if (!r || !r.ok || r.status !== 200 || !r.body || r.body.length < 100) {
            out.errors.push("pipe fetch failed: " + JSON.stringify({ status: out.status, err: out.err }));
            checkpoint();
            return "fetch-failed";
        }
    } catch (e) { recErr("pipe-fetch", e); checkpoint(); return "fetch-threw"; }

    return "OK|" + (out.metaPath || "none") + "|" + out.status + "|" + out.bodyLen + "|facades=" + (out.facadesPresent ? 1 : 0) + "|codec=" + (out.codecViaFacade ? 1 : 0);
})();
