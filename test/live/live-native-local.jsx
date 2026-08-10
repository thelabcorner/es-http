// live-native-local.jsx — fetch from a LOCAL server via the real v2 native
// transport, to isolate WinHTTP-connect (DLL logic) vs outbound-network.
#target illustrator
(function () {
    var out = { results: [], errors: [] };
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx");
        if (typeof ExternalObject !== "undefined" && ExternalObject.searchFolders) {
            var eshttpDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp";
            ExternalObject.searchFolders = eshttpDir + "/native;" + eshttpDir + ";" + ExternalObject.searchFolders;
        }
    } catch (e) { recErr("load", e); }

    var urls = [
        "http://127.0.0.1:64886/test.svg",
        "http://localhost:64886/test.svg",
        "http://127.0.0.1:1/x"        // closed port control
    ];
    eshttp.forceTransport("native");
    eshttp.resetTransport();
    for (var i = 0; i < urls.length; i++) {
        var r = eshttp.get(urls[i], { timeout: 15000, maxBodyBytes: 1048576 });
        out.results.push({
            url: urls[i],
            metaPath: r && r.meta ? r.meta.path : null,
            ok: r && r.ok,
            status: r && r.status,
            errorCode: r && r.error ? r.error.code : null,
            error: r && r.error ? r.error.message : null,
            bodyHasSvg: r && r.body ? r.body.indexOf("<svg") >= 0 : false,
            bodyLen: r && r.body ? r.body.length : -1
        });
    }
    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-native-local.json");
    try { f.open("w"); f.writeln(JSON.stringify(out)); f.close(); } catch (e) {}
    return JSON.stringify(out.results.map(function (r) { return r.status + "/" + (r.errorCode || "-"); }));
})();
