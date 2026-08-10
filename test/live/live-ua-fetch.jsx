// live-ua-fetch.jsx — LIVE GATE: fetch the Wikipedia W SVG through the REAL
// eshttp-cli.exe (cli transport, firewall escape) inside a live Illustrator.
// Assert: transport=cli, status 200, body decodes to the W SVG, written
// BINARY to temp. (The dynamic UA string is asserted headlessly; this probe
// is the end-to-end live fetch.)
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-ua-gate.json";
    var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-ua-w.svg";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }
    function isB64(text) { return text.indexOf("=") >= 0 && text.indexOf("<") < 0; }

    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx");
        out.loadOk = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("load", e); }
    if (!out.loadOk) { out.errors.push("eshttp not available"); checkpoint(); return "load-failed"; }

    try {
        eshttp.forceTransport("cli");
        eshttp.resetTransport();
        out.transportInfo = eshttp.transportInfo ? eshttp.transportInfo().transport : null;
        var r = eshttp.get("https://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg", {
            timeout: 60000, maxBodyBytes: 5242880
        });
        if (r && r.meta) { out.metaPath = r.meta.path; }
        if (r) { out.fetchStatus = r.status; }
        if (r) { out.fetchOk = r.ok; }
        if (r && r.error) {
            out.fetchErr = r.error.code;
            out.fetchErrMsg = r.error.message;
        }
        if (r && r.body) { out.bodyLen = r.body.length; }
        var bodyIsSvg = false;
        if (r && r.body) {
            if (r.body.indexOf("<svg") >= 0) { bodyIsSvg = true; }
            else if (r.bodyText && r.bodyText.indexOf("<svg") >= 0) { bodyIsSvg = true; }
        }
        out.bodyIsSvg = bodyIsSvg;
        if (out.metaPath === "cli") { out.transportIsCli = true; }
        checkpoint();
        if (!r || !r.ok || r.status !== 200 || !r.body || r.body.length < 100) {
            out.errors.push("fetch failed: " + JSON.stringify(out.fetchStatus) + "/" + out.fetchErr);
            checkpoint();
            return "fetch-failed";
        }
        // Write the SVG body BINARY. The CLI returns the body base64-encoded
        // (bodyEncoding base64) when non-ASCII; for pure-ASCII SVG it may be
        // raw. Write whichever is present.
        var raw = r.body;
        if (r.bodyText !== undefined && r.body !== r.bodyText) {
            // body was decoded to bytes by the wrapper -> write bodyText raw?
            // The wrapper's envelopeToResult decodes base64 into r.body, so
            // r.body IS the decoded byte string here (latin1). Write it.
            raw = r.body;
        }
        var f = new File(svgPath);
        f.encoding = "BINARY";
        if (!f.open("w")) { out.errors.push("cannot open " + svgPath); checkpoint(); return "write-failed"; }
        f.write(raw);
        f.close();
        out.wroteFile = true;
        out.fileBytes = new File(svgPath).length;
        checkpoint();
    } catch (e) { recErr("fetch", e); checkpoint(); return "fetch-threw"; }

    // 5. app.open + copy + paste (SVG -> paths; placedItems rejects SVG).
    //    PASTE-QUIRK FIX (core-porter live-verified): app.copy() is
    //    ACTIVE-DOC-RELATIVE — keep srcDoc active through select+copy, THEN
    //    switch to the target, THEN paste.
    try {
        // Target doc: reuse an open one or create fresh.
        var doc = null;
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
        var srcDoc = app.open(new File(svgPath));
        out.openedSvg = (srcDoc !== null);
        out.srcItems = srcDoc.pageItems.length;
        checkpoint();
        app.activeDocument = srcDoc;
        srcDoc.selection = null;
        var all = srcDoc.pageItems;
        var selArr = [];
        var k;
        for (k = 0; k < all.length; k++) { selArr.push(all[k]); }
        srcDoc.selection = selArr;
        out.selected = selArr.length;
        app.copy();
        out.copied = true;
        checkpoint();
        srcDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = doc;
        doc.selection = null;
        app.paste();
        out.pasted = true;
        out.pageItemsAfter = doc.pageItems.length;
        out.pageDelta = out.pageItemsAfter - out.pageItemsBefore;
        checkpoint();
    } catch (e) { recErr("place", e); checkpoint(); return "place-threw"; }

    return "OK|" + (out.metaPath || "none") + "|" + out.fetchStatus + "|delta=" + out.pageDelta;
})();
