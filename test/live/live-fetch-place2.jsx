// live-fetch-place2.jsx — T8b FINAL GATE (hardened): fetch Wikipedia W SVG
// over the REAL NATIVE transport -> write BINARY temp -> placedItems.add +
// file -> embed as paths. Writes INTERMEDIATE checkpoints so a timeout during
// the (slow) COM embed still preserves fetch+write evidence.
#target illustrator

(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-fetch-place2.json";
    var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-wikipedia-w.svg";
    function recErr(where, e) {
        try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); }
        catch (x) { out.errors.push(where + ": (unprintable)"); }
    }
    function checkpoint() {
        try {
            var f2 = new File(probePath);
            f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close();
        } catch (e) {}
    }

    // 1. Load the shipping artifact
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx");
        out.loadOk = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("load", e); }
    if (!out.loadOk) { out.errors.push("eshttp facade not available"); checkpoint(); return "load-failed"; }

    // 1b. Make lib:eshttp resolvable (repo native/ dir)
    try {
        if (typeof ExternalObject !== "undefined" && ExternalObject.searchFolders) {
            var eshttpDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp";
            ExternalObject.searchFolders = eshttpDir + "/native;" + eshttpDir + ";" + ExternalObject.searchFolders;
        }
    } catch (e) { recErr("searchFolders", e); }

    // 2. Ensure an active document exists
    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
    } catch (e) { recErr("doc", e); }
    if (!doc) { out.errors.push("no active document"); checkpoint(); return "no-doc"; }

    // 3. Fetch over the NATIVE transport
    try {
        eshttp.forceTransport("native");
        eshttp.resetTransport();
        out.transportInfo = eshttp.transportInfo ? eshttp.transportInfo().transport : null;
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
        out.transportIsNative = (out.metaPath === "native");
        if (!r || !r.ok || r.status !== 200 || !r.body || r.body.length < 100) {
            out.errors.push("fetch failed: " + JSON.stringify(out.fetch));
            checkpoint();
            return "fetch-failed";
        }

        // 4. Write the SVG body to a BINARY temp file
        var f = new File(svgPath);
        f.encoding = "BINARY";
        if (!f.open("w")) { out.errors.push("cannot open temp file"); checkpoint(); return "write-failed"; }
        f.write(r.body);
        f.close();
        out.wroteFile = true;
        out.fileBytes = new File(svgPath).length;
        out.fileHead = r.body.slice(0, 40);
        checkpoint();
    } catch (e) { recErr("fetch", e); checkpoint(); return "fetch-threw"; }

    // 5. Place + embed (SVG -> paths on embed)
    try {
        out.placeStarted = true;
        var placed = doc.placedItems.add();
        placed.file = new File(svgPath);
        out.placed = true;
        checkpoint();
        placed.embed();
        out.embedded = true;
        out.pageItemsAfter = doc.pageItems.length;
        out.pathCountDelta = out.pageItemsAfter - out.pageItemsBefore;
        checkpoint();
    } catch (e) { recErr("embed", e); checkpoint(); return "embed-threw"; }

    return "OK|" + (out.metaPath || "none") + "|" + out.fetch.status + "|delta=" + out.pathCountDelta;
})();
