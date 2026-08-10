// probe-global-shape.jsx — what IS the global eshttp in live Illustrator?
#target illustrator

(function () {
    var out = { typeofGlobal: typeof eshttp, keys: [], hasDefault: false, defaultType: "", defaultKeys: [], hasRequest: false, requestType: "" };
    try {
        if (typeof eshttp !== "undefined" && eshttp !== null) {
            try { out.keys = (function () { var a = [], k; for (k in eshttp) { a.push(k); } return a; })(); } catch (e) { out.keys = ["(enum err) " + e.message]; }
            try {
                out.hasDefault = ("default" in eshttp);
                out.defaultType = typeof eshttp["default"];
                if (out.defaultType === "object" && eshttp["default"]) {
                    out.defaultKeys = (function () { var a = [], k; for (k in eshttp["default"]) { a.push(k); } return a; })();
                }
            } catch (e) { out.hasDefault = "err:" + e.message; }
            out.hasRequest = typeof eshttp.request;
            out.requestType = typeof eshttp.request;
        }
    } catch (e) {
        out.err = String(e);
    }
    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-global-shape.json");
    try { f.open("w"); f.writeln(JSON.stringify(out)); f.close(); } catch (e) { try { f.close(); } catch (x) {} }
    return out.typeofGlobal + "|" + out.keys.length;
})();
