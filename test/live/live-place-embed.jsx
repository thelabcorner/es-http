// live-place-embed.jsx — T8b network-free half: place + embed the ALREADY-
// FETCHED Wikipedia W SVG into the active doc as paths. No network needed.
#target illustrator
(function () {
    var out = { errors: [] };
    var probePath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-place-embed.json";
    var svgPath = "C:/Users/slooshied/AppData/Local/Temp/eshttp-live-wikipedia-w.svg";
    function recErr(w, e) { try { out.errors.push(w + ": " + (e && e.message ? e.message : String(e))); } catch (x) {} }
    function checkpoint() {
        try { var f2 = new File(probePath); f2.open("w"); f2.writeln(JSON.stringify(out)); f2.close(); } catch (e) {}
    }

    // 0. Preconditions
    try {
        out.svgExists = new File(svgPath).exists;
        out.svgBytes = new File(svgPath).length;
        if (!out.svgExists) { out.errors.push("svg file missing"); checkpoint(); return "no-svg"; }
    } catch (e) { recErr("pre", e); checkpoint(); return "pre-threw"; }

    // 1. Active doc (create if none)
    var doc = null;
    try {
        if (app.documents.length > 0) { doc = app.activeDocument; }
        else { doc = app.documents.add(); }
        out.docOk = (doc !== null);
        out.pageItemsBefore = doc.pageItems.length;
        out.pathItemsBefore = doc.pathItems.length;
        out.groupItemsBefore = doc.groupItems.length;
        out.pageItemsBeforeNames = doc.pageItems.length;
    } catch (e) { recErr("doc", e); checkpoint(); return "no-doc"; }

    // 2. Place + embed (SVG -> paths)
    try {
        out.placeStarted = true;
        var placed = doc.placedItems.add();
        placed.file = new File(svgPath);
        out.placed = true;
        out.placedName = placed.name;
        checkpoint();
        placed.embed();
        out.embedded = true;
        out.pageItemsAfter = doc.pageItems.length;
        out.pathItemsAfter = doc.pathItems.length;
        out.groupItemsAfter = doc.groupItems.length;
        out.pathCountDelta = out.pathItemsAfter - out.pathItemsBefore;
        out.pageDelta = out.pageItemsAfter - out.pageItemsBefore;
        out.groupDelta = out.groupItemsAfter - out.groupItemsBefore;
        checkpoint();
    } catch (e) { recErr("embed", e); checkpoint(); return "embed-threw"; }

    return "OK|pageDelta=" + out.pageDelta + "|pathDelta=" + out.pathCountDelta + "|groupDelta=" + out.groupDelta;
})();
