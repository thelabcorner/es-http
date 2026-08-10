// live-place-control.jsx — control: place a HAND-WRITTEN minimal SVG (no
// fetch) to isolate whether the placement mechanics work in this COM context.
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-place-control.json";
    var ctrlPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-control-rect.svg";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }

    // write a minimal SVG directly (plain ES3 file I/O)
    try {
        var f = new File(ctrlPath);
        f.open("w");
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>');
        f.close();
        out.ctrlWritten = true;
        out.ctrlBytes = new File(ctrlPath).length;
    } catch (e) { recErr("write-ctrl", e); checkpoint(); return "write-threw"; }

    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.pageItemsBefore = doc.pageItems.length;
    } catch (e) { recErr("doc", e); checkpoint(); return "no-doc"; }

    try {
        var p = doc.placedItems.add();
        p.file = new File(ctrlPath);
        out.fileSet = true;
        p.embed();
        out.embedOk = true;
        out.pageItemsAfter = doc.pageItems.length;
        out.pageDelta = out.pageItemsAfter - out.pageItemsBefore;
    } catch (e) { recErr("place", e); }

    checkpoint();
    return (out.embedOk ? "OK" : "FAIL") + "|delta=" + out.pageDelta + "|" + out.errors.join(";");
})();
