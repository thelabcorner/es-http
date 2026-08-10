// live-fetch-place.jsx — T8b FINAL GATE live end-to-end:
// eshttp.get(Wikipedia W SVG) over the REAL NATIVE transport -> write the
// response BODY as a BINARY temp file -> placedItems.add + file -> embed
// into the active document (SVG placement renders as paths).
// Results are written to a temp JSON side-channel file (COM-skill pattern).
#target illustrator

(function () {
    var out = {
        loadOk: false, transport: null, metaPath: null, fetch: null,
        wroteFile: false, fileBytes: -1, placed: false, embedded: false,
        pageItemsBefore: -1, pageItemsAfter: -1, pathCountDelta: -1,
        errors: []
    };
    function recErr(where, e) {
        try { out.errors.push(where + ": " + (e && e.message ? e.message : String(e))); }
        catch (x) { out.errors.push(where + ": (unprintable)"); }
    }

    // 1. Load the shipping artifact
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx");
        out.loadOk = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("load", e); }
    if (!out.loadOk) { out.errors.push("eshttp facade not available"); writeOut(out); return "load-failed"; }

    // 1b. Make lib:eshttp resolvable: the v2 DLL lives in the repo native/
    //     dir (and repo root) — add both to ExternalObject.searchFolders so
    //     the canonical specifier resolves it (same pattern as
    //     test/live/live-test-dll-load.jsx).
    try {
        if (typeof ExternalObject !== "undefined" && ExternalObject.searchFolders) {
            var eshttpDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp";
            var nativeDir = eshttpDir + "/native";
            ExternalObject.searchFolders = nativeDir + ";" + eshttpDir + ";" + ExternalObject.searchFolders;
        }
        var found = (typeof ExternalObject !== "undefined" && ExternalObject.search)
            ? String(ExternalObject.search("lib:eshttp")) : "(no search)";
        out.searchResult = found;
    } catch (e) { recErr("searchFolders", e); }

    // 2. Ensure an active document exists (fresh instance has none)
    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
    } catch (e) { recErr("doc", e); }
    if (!doc) { out.errors.push("no active document"); writeOut(out); return "no-doc"; }

    // 3. Fetch the Wikipedia W SVG over the NATIVE transport
    try {
        // force native (eshttp.dll via ExternalObject) — the whole point of T6/T7/T8a
        eshttp.forceTransport("native");
        eshttp.resetTransport();
        out.transport = eshttp.transportInfo ? eshttp.transportInfo().transport : null;
        var url = "https://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg";
        var r = eshttp.get(url, { timeout: 45000, maxBodyBytes: 5242880 });
        out.metaPath = r && r.meta ? r.meta.path : null;
        out.fetch = {
            ok: r && r.ok,
            status: r && r.status,
            errorCode: r && r.error ? r.error.code : null,
            bodyLen: r && r.body ? r.body.length : -1,
            error: r && r.error ? r.error.message : null
        };
        if (!r || !r.ok || r.status !== 200 || !r.body || r.body.length < 100) {
            out.errors.push("fetch failed: " + JSON.stringify(out.fetch));
            writeOut(out);
            return "fetch-failed";
        }
        out.bodyIsSvg = (r.body.indexOf("<svg") >= 0);
        out.transportIsNative = (out.metaPath === "native");
        out.transportInfoTransport = out.transport;

        // 3. Write the SVG body to a BINARY temp file (latin1 byte string ->
        //    BINARY encoding preserves exact bytes)
        var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-wikipedia-w.svg";
        var f = new File(svgPath);
        f.encoding = "BINARY";
        var opened = f.open("w");
        if (!opened) { out.errors.push("cannot open temp file for writing"); writeOut(out); return "write-failed"; }
        f.write(r.body);
        f.close();
        out.wroteFile = true;
        out.fileBytes = new File(svgPath).length;

        // 4. Place + embed into the active document (SVG -> paths on embed)
        var placed = doc.placedItems.add();
        placed.file = new File(svgPath);
        out.placed = true;
        placed.embed();
        out.embedded = true;
        out.pageItemsAfter = doc.pageItems.length;
        out.pathCountDelta = out.pageItemsAfter - out.pageItemsBefore;
    } catch (e) { recErr("main", e); }

    writeOut(out);
    return (out.metaPath || "none") + "|" + out.fetch.status + "|" + out.pathCountDelta;

    function writeOut(o) {
        var f2 = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-live-fetch-place.json");
        try { f2.open("w"); f2.writeln(JSON.stringify(o)); f2.close(); } catch (e) {}
    }
})();
