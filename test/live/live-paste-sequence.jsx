// live-paste-sequence.jsx — SVG open -> select -> copy -> paste sequencing probe
// =============================================================================
// T11 (core-porter lane, split with qa-validator): isolates the 6->6 paste
// quirk from the coordinator's combined fetch+place run. Hypothesis: the copy
// step must run with app.activeDocument === srcDoc (select + copy are
// active-doc-relative); switching to the target BEFORE copy copies from the
// wrong document (or an empty selection), so paste yields no new items.
//
// LIVE RESULT (Illustrator 30.6.0 via COM, 2026-08-10):
//   GOOD  sequence (src active during select+copy): delta=2  (both items land)
//   BUGGY sequence (switch to target BEFORE copy):  delta=0  (the 6->6 repro)
//   => CONFIRMED: app.copy() is active-doc-relative. The correct order is:
//      open src -> srcDoc.selection = all -> app.copy() (src STILL active)
//      -> app.activeDocument = target -> target.selection = null -> paste.
//
// Method: exercise the FULL transition table with a LOCALLY-generated SVG
// (no network, no cli exe — pure DOM sequencing) and report item counts at
// every step. Run inside Illustrator (ESTK or COM DoJavaScript); the result
// is returned as a JSON string via eshttp.json (the bundled parser — the
// engine has no JSON global).
//
// Expected good sequence (per the skill's active-doc discipline):
//   1. srcDoc = app.open(svgFile)          // srcDoc becomes active
//   2. srcDoc.selection = all pageItems    // select while src is ACTIVE
//   3. app.copy()                          // copies from src (active)
//   4. app.activeDocument = targetDoc      // switch BEFORE paste
//   5. targetDoc.selection = null
//   6. app.paste()                         // lands in target
//   7. count targetDoc.pageItems before/after -> delta > 0
//
// The BUGGY variant (what the combined run did): activeDocument switched to
// target between open and copy, so copy had no selection in the active doc.
// =============================================================================
#target illustrator
(function () {
    // Load the bundled eshttp for json.parse/stringify (no JSON global in ES3).
    var eshttpRoot = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp";
    try { $.evalFile(new File(eshttpRoot + "/dist/eshttp.jsx"), 30000); } catch (e) {}
    var json = (typeof eshttp !== "undefined" && eshttp.json) ? eshttp.json : null;

    var out = { steps: [], ok: false, error: null };
    function step(name, detail) { out.steps.push({ name: name, detail: detail || "" }); }
    function countItems(doc) {
        try { return doc.pageItems.length; } catch (e) { return -1; }
    }

    // A tiny local SVG (one rectangle + one circle = 2 items when opened).
    var svgSrc = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">\n' +
        '  <rect x="10" y="10" width="80" height="60" fill="red"/>\n' +
        '  <circle cx="150" cy="140" r="40" fill="blue"/>\n' +
        '</svg>\n';

    try {
        var temp = Folder.temp;
        var tmpRaw = String(temp.fsName || "%TEMP%");
        // strip trailing slashes without a regex (ES3 parser quirk avoidance)
        while (tmpRaw.length > 0 && (tmpRaw.charAt(tmpRaw.length - 1) === "/" || tmpRaw.charAt(tmpRaw.length - 1) === "\\")) {
            tmpRaw = tmpRaw.substring(0, tmpRaw.length - 1);
        }
        var tmpDir = tmpRaw;
        var svgFile = tmpDir + "/eshttp-paste-probe.svg";

        var sf = new File(svgFile);
        sf.encoding = "UTF-8";
        if (!sf.open("w")) { out.error = "cannot write probe svg"; return JSON.stringify(out); }
        sf.write(svgSrc);
        sf.close();
        step("write-svg", "len=" + sf.length + " exists=" + sf.exists);

        var targetDoc = app.documents.add();
        var targetBefore = countItems(targetDoc);
        step("target-created", "items=" + targetBefore);

        // ---- GOOD SEQUENCE: src active during select+copy ----
        var srcDoc = app.open(new File(sf.fsName));
        step("open-src", "items=" + countItems(srcDoc) + " active=" + (app.activeDocument === srcDoc));

        var srcItems = srcDoc.pageItems.length;
        var sel = [], i;
        for (i = 0; i < srcItems; i++) { sel.push(srcDoc.pageItems[i]); }
        srcDoc.selection = sel;
        step("select-src", "sel=" + srcDoc.selection.length + " active-is-src=" + (app.activeDocument === srcDoc));

        app.copy();
        step("copy", "active-is-src=" + (app.activeDocument === srcDoc));

        app.activeDocument = targetDoc;
        targetDoc.selection = null;
        var targetBeforePaste = countItems(targetDoc);
        app.paste();
        var targetAfter = countItems(targetDoc);
        step("paste", "before=" + targetBeforePaste + " after=" + targetAfter + " delta=" + (targetAfter - targetBeforePaste));

        out.ok = (targetAfter > targetBefore);
        out.goodDelta = targetAfter - targetBefore;
        out.goodSequence = true;

        // close the good-sequence docs BEFORE the buggy variant (a second
        // app.open on the same file while it is open can return a stale ref)
        try { srcDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
        try { targetDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}

        // ---- BUGGY VARIANT (the 6->6 repro): switch active-doc BEFORE copy.
        // The coordinator's combined run did fetch -> decode -> write -> open
        // -> select -> copy with the ACTIVE doc already switched to the target
        // (or a stale reference), so copy grabbed nothing -> paste delta 0.
        var svgFile2 = tmpDir + "/eshttp-paste-probe2.svg";
        var sf2 = new File(svgFile2);
        sf2.encoding = "UTF-8";
        if (sf2.open("w")) { sf2.write(svgSrc); sf2.close(); }
        var srcDoc2 = app.open(new File(sf2.fsName));
        var targetDoc2 = app.documents.add();
        var t2before = countItems(targetDoc2);
        step("buggy-open-src2", "items=" + countItems(srcDoc2));
        var src2items = srcDoc2.pageItems.length;
        var sel2 = [], j;
        for (j = 0; j < src2items; j++) { sel2.push(srcDoc2.pageItems[j]); }
        srcDoc2.selection = sel2;
        step("buggy-select-src2", "sel=" + srcDoc2.selection.length);
        // BUG: switch to target BEFORE copy (active-doc no longer src)
        app.activeDocument = targetDoc2;
        step("buggy-switch", "active-is-src=" + (app.activeDocument === srcDoc2) + " active-is-target=" + (app.activeDocument === targetDoc2));
        app.copy();
        targetDoc2.selection = null;
        app.paste();
        var t2after = countItems(targetDoc2);
        step("buggy-paste", "before=" + t2before + " after=" + t2after + " delta=" + (t2after - t2before));
        out.buggyDelta = t2after - t2before;
        out.buggyRepro = (t2after - t2before === 0);   // the 6->6 quirk

        // cleanup: close src + target without saving, remove probe svg
        try { srcDoc2.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
        try { targetDoc2.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
        try { sf.remove(); } catch (e) {}
        try { sf2.remove(); } catch (e) {}
    } catch (e) {
        out.error = String(e && e.message ? e.message : e);
    }

    // Return as JSON via the bundled parser, or a plain string if eshttp is
    // unavailable (the COM caller can parse either).
    if (json && json.stringify) { return json.stringify(out); }
    var flat = "eshttp-not-loaded steps=" + out.steps.length;
    var s;
    for (s = 0; s < out.steps.length; s++) { flat += " | " + out.steps[s].name + ":" + out.steps[s].detail; }
    flat += " | ok=" + out.ok + " goodDelta=" + out.goodDelta + " error=" + out.error;
    return flat;
}());
