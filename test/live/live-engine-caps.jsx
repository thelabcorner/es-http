// live-engine-caps.jsx — engine capability fingerprint BEFORE any artifact
// shim could have replaced natives (fresh session check).
#target illustrator
(function () {
    var out = {};
    out.dpType = typeof Object.defineProperty;
    out.gopdType = typeof Object.getOwnPropertyDescriptor;
    out.gopnType = typeof Object.getOwnPropertyNames;
    out.bindType = typeof Function.prototype.bind;
    out.defineGetterType = typeof ({}).__defineGetter__;
    out.defineSetterType = typeof ({}).__defineSetter__;
    // if defineProperty exists, is it native-looking?
    if (typeof Object.defineProperty === "function") {
        try { out.dpSrc = String(Object.defineProperty).slice(0, 80); } catch (e) { out.dpSrc = "(unreadable)"; }
    }
    // fresh accessor test on a bare object
    var t = {};
    try {
        Object.defineProperty(t, "x", { get: function () { return 99; }, enumerable: true });
        out.accessorX = t.x;
        var d = Object.getOwnPropertyDescriptor(t, "x");
        out.xDesc = d ? { hasGet: typeof d.get, hasValue: ("value" in d), enumerable: d.enumerable, configurable: d.configurable, writable: d.writable } : null;
    } catch (e) { out.accessorErr = String(e); }
    var f = new File("C:/Users/slooshied/AppData/Local/Temp/eshttp-caps.json");
    try { f.open("w"); f.writeln(JSON.stringify(out)); f.close(); } catch (e) { try { f.close(); } catch (x) {} }
    return JSON.stringify(out);
})();
