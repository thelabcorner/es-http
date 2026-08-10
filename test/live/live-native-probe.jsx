// live-native-probe.jsx — isolate the WinHTTP connect failure: try several
// endpoints through the REAL v2 native transport and report each.
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
        "http://example.com/",
        "https://example.com/",
        "http://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg",
        "https://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg",
        "https://www.wikipedia.org/"
    ];
    eshttp.forceTransport("native");
    eshttp.resetTransport();
    for (var i = 0; i < urls.length; i++) {
        var u = urls[i];
        try {
            var r = eshttp.get(u, { timeout: 30000, maxBodyBytes: 1048576 });
            out.results.push({
                url: u,
                metaPath: r && r.meta ? r.meta.path : null,
                ok: r && r.ok,
                status: r && r.status,
                errorCode: r && r.error ? r.error.code : null,
                error: r && r.error ? r.error.message : null,
                bodyHead: r && r.body ? r.body.slice(0, 60) : null
            });
        } catch (e) { out.results.push({ url: u, threw: String(e) }); }
    }

    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-native-probe.json");
    try { f.open("w"); f.writeln(JSON.stringify(out)); f.close(); } catch (e) {}
    return JSON.stringify(out.results.map(function (r) { return r.status + "/" + (r.errorCode || "-") + ":" + (r.metaPath || "-"); }));
})();
