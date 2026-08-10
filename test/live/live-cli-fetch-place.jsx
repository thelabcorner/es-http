// live-cli-fetch-place.jsx — T11 FINAL GATE: full end-to-end through the
// WRAPPER's cli transport inside a live Illustrator instance.
//   1. Load dist/eshttp.jsx (the shipping artifact with the cli tier)
//   2. forceTransport('cli') — the real eshttp-cli.exe is staged at
//      %LOCALAPPDATA%\eshttp\ (findCliExe first candidate)
//   3. eshttp.get(Wikipedia W SVG) -> the wrapper writes ESHTTP_*.job to
//      %TEMP%\opencode, File.execute() spawns the CLI (no argv, scan-claim),
//      polls the .done, maps the envelope with meta.path='cli'
//   4. Write the body (base64 or utf8) to a BINARY temp file
//   5. app.open(SVG) -> select all -> copy -> close -> paste into the target
//      doc (SVG as paths; placedItems rejects SVG)
// Checkpointed so a timeout mid-embed preserves the fetch+write evidence.
#target illustrator

(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-cli-gate.json";
    var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-cli-w.svg";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }
    function decodeB64(b64) {
        // ES3-safe base64 -> byte string (BINARY file write needs latin1)
        var alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        var outS = "";
        var i;
        for (i = 0; i + 3 < b64.length + 1; i += 4) {
            // minimal: strip padding, decode 4 chars -> 3 bytes
            var c0 = alpha.indexOf(b64.charAt(i));
            var c1 = alpha.indexOf(b64.charAt(i + 1));
            var c2 = alpha.indexOf(b64.charAt(i + 2));
            var c3 = alpha.indexOf(b64.charAt(i + 3));
            if (c2 < 0) { c2 = 0; }
            if (c3 < 0) { c3 = 0; }
            var n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
            outS += String.fromCharCode((n >> 16) & 255);
            if (b64.charAt(i + 2) !== "=") { outS += String.fromCharCode((n >> 8) & 255); }
            if (b64.charAt(i + 3) !== "=") { outS += String.fromCharCode(n & 255); }
            if (i + 4 >= b64.length) { break; }
        }
        return outS;
    }

    // 1. Load the shipping artifact
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp.jsx");
        out.loadOk = (typeof eshttp !== "undefined" && typeof eshttp.request === "function");
    } catch (e) { recErr("load", e); }
    if (!out.loadOk) { out.errors.push("eshttp not available"); checkpoint(); return "load-failed"; }

    // 2. Target doc
    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
    } catch (e) { recErr("doc", e); }

    // 3. Fetch via the cli transport
    try {
        eshttp.forceTransport("cli");
        eshttp.resetTransport();
        out.transportInfo = eshttp.transportInfo ? eshttp.transportInfo().transport : null;
        var url = "https://upload.wikimedia.org/wikipedia/commons/5/5a/Wikipedia%27s_W.svg";
        var r = eshttp.get(url, {
            timeout: 60000, maxBodyBytes: 5242880,
            headers: { "User-Agent": "eshttp/1.0.0 (Illustrator QA)" }
        });
        out.metaPath = r && r.meta ? r.meta.path : null;
        out.fetch = {
            ok: r && r.ok, status: r && r.status,
            errorCode: r && r.error ? r.error.code : null,
            bodyEncoding: r && r.bodyText !== undefined ? (r.body !== r.bodyText ? "base64" : "utf8") : "?",
            bodyLen: r && r.body ? r.body.length : -1,
            bodyIsSvg: r && r.body ? (r.body.indexOf("<svg") >= 0 || r.bodyText.indexOf("<svg") >= 0) : false,
            error: r && r.error ? r.error.message : null
        };
        out.transportIsCli = (out.metaPath === "cli");
        checkpoint();
        if (!r || !r.ok || r.status !== 200 || !r.body || r.body.length < 100) {
            out.errors.push("fetch failed: " + JSON.stringify(out.fetch));
            checkpoint();
            return "fetch-failed";
        }

        // 4. Write BINARY temp file (base64 body -> latin1 byte string)
        var raw = r.body;
        if (r.bodyText !== undefined && r.body !== r.bodyText) { raw = decodeB64(r.bodyText); }
        var f = new File(svgPath);
        f.encoding = "BINARY";
        if (!f.open("w")) { out.errors.push("cannot open " + svgPath); checkpoint(); return "write-failed"; }
        f.write(raw);
        f.close();
        out.wroteFile = true;
        out.fileBytes = new File(svgPath).length;
        checkpoint();
    } catch (e) { recErr("fetch", e); checkpoint(); return "fetch-threw"; }

    // 5. app.open + copy + paste (SVG -> paths; placedItems rejects SVG)
    try {
        var srcDoc = app.open(new File(svgPath));
        out.openedSvg = (srcDoc !== null);
        out.srcItems = srcDoc.pageItems.length;
        checkpoint();
        srcDoc.selection = null;
        var all = srcDoc.pageItems;
        var selArr = [];
        var k;
        for (k = 0; k < all.length; k++) { selArr.push(all[k]); }
        srcDoc.selection = selArr;
        out.selected = selArr.length;
        srcDoc.selection[0].duplicate();  // no-op guard? no — select then copy:
        // use copy via the edit menu is not scriptable directly; instead:
        // select -> copy() on the doc
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

    return "OK|" + (out.metaPath || "none") + "|" + out.fetch.status + "|delta=" + out.pageDelta;
})();
