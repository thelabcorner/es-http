// live-place-embed2.jsx — retry place+embed using relink(fileSpec) which takes
// a path STRING (more reliable than assigning .file on a fresh PlacedItem).
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-place-embed2.json";
    var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-wikipedia-w.svg";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }

    try {
        var svgFile = new File(svgPath);
        out.svgExists = svgFile.exists;
        out.svgBytes = svgFile.length;
        out.svgFsName = svgFile.fsName;
        if (!svgFile.exists) { out.errors.push("svg missing"); checkpoint(); return "no-svg"; }
    } catch (e) { recErr("pre", e); checkpoint(); return "pre-threw"; }

    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
        out.pathItemsBefore = doc.pathItems.length;
    } catch (e) { recErr("doc", e); checkpoint(); return "no-doc"; }

    // Attempt 1: placedItems.add() + .file (fsName)
    try {
        var placed = doc.placedItems.add();
        placed.file = svgFile;
        out.mode = "file-assign";
        out.fileSet = true;
        out.embedded = true;
        placed.embed();
        out.embedOk = true;
    } catch (e) {
        out.errors.push("file-assign failed: " + (e.message || String(e)));
        // Attempt 2: fresh placed item + relink(pathString)
        try {
            var placed2 = doc.placedItems.add();
            placed2.relink(svgFile.fsName);
            out.mode = "relink";
            out.relinked = true;
            placed2.embed();
            out.embedOk = true;
            out.placed = placed2;
        } catch (e2) {
            out.errors.push("relink failed: " + (e2.message || String(e2)));
            // Attempt 3: relink with forward-slash URI path
            try {
                var placed3 = doc.placedItems.add();
                placed3.relink(svgPath);
                out.mode = "relink-uri";
                out.relinked = true;
                placed3.embed();
                out.embedOk = true;
                out.placed = placed3;
            } catch (e3) {
                out.errors.push("relink-uri failed: " + (e3.message || String(e3)));
            }
        }
    }

    out.pageItemsAfter = doc.pageItems.length;
    out.pathItemsAfter = doc.pathItems.length;
    out.pageDelta = out.pageItemsAfter - out.pageItemsBefore;
    out.pathDelta = out.pathItemsAfter - out.pathItemsBefore;
    checkpoint();
    return (out.embedOk ? "OK" : "FAIL") + "|" + (out.mode || "none") + "|pageDelta=" + out.pageDelta + "|pathDelta=" + out.pathDelta;
})();
