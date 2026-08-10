// live-descriptor.jsx — inspect the wrapper's "default" property descriptor.
#target illustrator
(function () {
    var out = {};
    try { delete eshttp; } catch (e) {}
    try { delete $.global.eshttp; } catch (e) {}
    try {
        $.evalFile("C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/dist/eshttp-fixed-test.jsx");
        out.loaded = true;
    } catch (e) { out.loaded = false; out.loadErr = String(e); }

    try {
        var d = Object.getOwnPropertyDescriptor(eshttp, "default");
        out.desc = d ? {
            hasGet: typeof d.get,
            hasValue: ("value" in d),
            enumerable: d.enumerable,
            configurable: d.configurable,
            writable: d.writable
        } : null;
    } catch (e) { out.descErr = String(e); }

    // invoke the getter directly if present
    if (out.desc && out.desc.hasGet === "function") {
        try {
            var r = eshttp["default"];
            out.readResult = typeof r;
            out.readKeys = (function () { var a = [], k; if (r && typeof r === "object") { for (k in r) { a.push(k); } } return a; })();
        } catch (e) { out.readErr = String(e); }
    }

    // try Object.getOwnPropertyNames on the wrapper
    try { out.ownNames = Object.getOwnPropertyNames(eshttp); } catch (e) { out.ownNamesErr = String(e); }

    // is bare eshttp === $.global.eshttp?
    out.sameAsGlobal = ($.global.eshttp === eshttp);
    out.globalRequestType = $.global.eshttp ? typeof $.global.eshttp.request : "n/a";

    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-desc.json");
    try { f.open("w"); f.writeln(JSON.stringify(out)); f.close(); } catch (e) { try { f.close(); } catch (x) {} }
    return out.loaded + "|" + (out.desc ? (out.desc.hasGet + "/" + out.readResult) : "nodesc") + "|" + out.sameAsGlobal;
})();
