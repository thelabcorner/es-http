// T21 live release-accel spot-check probe (build-engineer):
// eval dist/eshttp.accel.jsx -> accel adapter extracts the 3 binaries to
// %LOCALAPPDATA%\eshttp -> force cli transport -> pipe fetch of the Wikipedia
// W SVG through the REAL worker (own process image -> firewall-free) ->
// write result to a temp JSON side-channel.
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-t21-live.json";
    function ck() { try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {} }
    function recErr(where, e) { try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }

    // 1. Eval the release accel bundle (self-extracting: ESPAK + facade + staging adapter)
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.accel.jsx");
        out.accelLoaded = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
        out.espackPresent = (typeof ESPAK !== "undefined");
    } catch (e) { recErr("accel-eval", e); }
    if (!out.accelLoaded) { out.errors.push("accel facade unavailable"); ck(); return "accel-failed"; }

    // 2. Verify the staged binaries exist (the adapter extracted them at eval)
    try {
        var base = "C:/Users/slooshied/AppData/Local/eshttp";
        out.staged = {
            cli: new File(base + "/eshttp-cli.exe").exists,
            ipc: new File(base + "/eshttp-ipc.dll").exists,
            dll: new File(base + "/eshttp.dll").exists
        };
    } catch (e) { recErr("staged-check", e); }
    ck();

    // 3. Force the cli transport (pipe lane) + fetch the W SVG through the worker
    try {
        eshttp.forceTransport("cli");
        eshttp.resetTransport();
        out.transport = eshttp.transportInfo ? eshttp.transportInfo().transport : null;
        var url = "https://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg";
        var r = eshttp.get(url, { timeout: 60000, maxBodyBytes: 5242880 });
        out.metaPath = r && r.meta ? r.meta.path : null;
        out.fetch = {
            ok: r && r.ok, status: r && r.status,
            errorCode: r && r.error ? r.error.code : null,
            bodyLen: r && r.body ? r.body.length : -1,
            bodyIsSvg: r && r.body ? r.body.indexOf("<svg") >= 0 : false,
            error: r && r.error ? r.error.message : null
        };
        out.pipeUsed = (out.metaPath === "cli");
    } catch (e) { recErr("fetch", e); }
    ck();
    return "OK|" + (out.metaPath || "none") + "|" + (out.fetch ? out.fetch.status : 0) + "|" + (out.fetch ? out.fetch.bodyLen : -1);
})();
