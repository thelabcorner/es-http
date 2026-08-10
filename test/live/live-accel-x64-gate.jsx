// live-accel-x64-gate.jsx — T25 v1.0.1 per-bitness accel smoke (qa-validator).
// Evals dist/eshttp.accel-x64.jsx (pipe-primary per-bitness artifact), verifies
// the cli + ipc binaries extract, and does a live pipe fetch of the W SVG.
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-accel-x64-gate.json";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }

    // 1. Eval the per-bitness accel-x64
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.accel-x64.jsx");
        out.accelLoaded = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("accel-x64-eval", e); }
    if (!out.accelLoaded) { out.errors.push("accel-x64 eval failed"); checkpoint(); return "accel-failed"; }

    // 2. Verify the pipe binaries (cli + ipc) extracted to %LOCALAPPDATA%\eshttp
    var base = "C:/Users/slooshied/AppData/Local/eshttp";
    function fileOk(name, minLen) {
        try { var f = new File(base + "/" + name); return !!(f && f.exists && f.length >= minLen); }
        catch (e) { return false; }
    }
    out.stagedCli = fileOk("eshttp-cli.exe", 100000);   // worker ~213KB
    out.stagedIpc = fileOk("eshttp-ipc.dll", 10000);    // bridge ~16KB
    out.pipeBinariesExtracted = out.stagedCli && out.stagedIpc;
    checkpoint();

    // 3. Live pipe fetch (worker + bridge are the pipe lane)
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

    return "OK|" + (out.metaPath || "none") + "|" + out.status + "|" + out.bodyLen;
})();
