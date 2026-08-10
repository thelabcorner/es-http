// T27/T29 live merged-accel eval: dist/eshttp.accel-x64.jsx in Illustrator ->
// facades publish ESON/ESB64 -> the library's codec adapters consume them ->
// pipe fetch through the real worker.
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-t27-live.json";
    function ck() { try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {} }
    function recErr(where, e) { try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }

    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.accel-x64.jsx");
        out.accelLoaded = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("accel-eval", e); }
    if (!out.accelLoaded) { out.errors.push("accel facade unavailable"); ck(); return "accel-failed"; }

    // The merged facades + ESPAK
    try {
        out.globals = {
            ESON: typeof ESON === "object" && typeof ESON.parse === "function",
            ESB64: typeof ESB64 === "object" && typeof ESB64.atob === "function",
            ESPAK: typeof ESPAK === "object"
        };
    } catch (e) { recErr("globals", e); }
    // The library's codec lane must now use the facades (T28):
    try {
        out.codecViaFacade = {
            jsonParse: eshttp.json.parse('{"a":1}') && eshttp.json.parse('{"a":1}').a === 1,
            b64: eshttp.helpers.base64Encode("hi") === "aGk=",
            utf8: eshttp.helpers.utf8Encode("é") === "\u00c3\u00a9"
        };
    } catch (e) { recErr("codec", e); }
    ck();

    // Pipe fetch through the real worker
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
