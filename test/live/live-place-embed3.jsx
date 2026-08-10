// live-place-embed3.jsx — place+embed using the DOCUMENTED string forms:
// placed.file = <path string> (reference: PlacedItem.file: string read/write).
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-place-embed3.json";
    var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-wikipedia-w.svg";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }

    var svgFile = null;
    try {
        svgFile = new File(svgPath);
        out.svgExists = svgFile.exists;
        out.svgBytes = svgFile.length;
        out.svgFsName = svgFile.fsName;
        out.svgUri = svgFile.fullName;  // URI form /c/...
    } catch (e) { recErr("pre", e); }

    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
        out.pathItemsBefore = doc.pathItems.length;
    } catch (e) { recErr("doc", e); checkpoint(); return "no-doc"; }

    var attempts = [];
    // A. placed.file = fsName string (Windows path)
    try {
        var p1 = doc.placedItems.add();
        p1.file = svgFile.fsName;
        p1.embed();
        attempts.push({ mode: "file=fsName", ok: true });
        out.embedOk = true; out.mode = "file=fsName"; out.placed = p1;
    } catch (e) { attempts.push({ mode: "file=fsName", err: String(e.message || e) }); }
    if (!out.embedOk) {
        // B. placed.file = fullName URI
        try {
            var p2 = doc.placedItems.add();
            p2.file = svgFile.fullName;
            p2.embed();
            attempts.push({ mode: "file=fullName", ok: true });
            out.embedOk = true; out.mode = "file=fullName"; out.placed = p2;
        } catch (e) { attempts.push({ mode: "file=fullName", err: String(e.message || e) }); }
    }
    if (!out.embedOk) {
        // C. relink with File object (runtime said File/Folder expected)
        try {
            var p3 = doc.placedItems.add();
            p3.relink(svgFile);
            p3.embed();
            attempts.push({ mode: "relink(File)", ok: true });
            out.embedOk = true; out.mode = "relink(File)"; out.placed = p3;
        } catch (e) { attempts.push({ mode: "relink(File)", err: String(e.message || e) }); }
    }
    out.attempts = attempts;

    out.pageItemsAfter = doc.pageItems.length;
    out.pathItemsAfter = doc.pathItems.length;
    out.pageDelta = out.pageItemsAfter - out.pageItemsBefore;
    out.pathDelta = out.pathItemsAfter - out.pathItemsBefore;
    checkpoint();
    return (out.embedOk ? "OK" : "FAIL") + "|" + (out.mode || "none") + "|pathDelta=" + out.pathDelta;
})();
