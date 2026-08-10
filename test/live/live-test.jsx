/*
 * live-test.jsx — Live test of eshttp inside Illustrator via COM
 * Run via: python comtool/ILLUSTRATOR_COM_TOOL.py eval --file test/live/live-test.jsx
 */
#target illustrator

(function () {
    // Load eshttp.jsxinc - use absolute path
    var eshttpPath = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/src/eshttp.jsxinc";
    var f = new File(eshttpPath);
    $.writeln("File exists: " + f.exists);
    $.writeln("File path: " + f.fsName);
    var loadResult = $.evalFile(f);
    $.writeln("Load result: " + loadResult);
    $.writeln("eshttp defined: " + (typeof eshttp !== "undefined"));
    if (typeof eshttp === "undefined") {
        // Try to get from global
        $.writeln("Checking $.global.eshttp: " + (typeof $.global.eshttp !== "undefined"));
        $.writeln("Checking this.eshttp: " + (typeof this.eshttp !== "undefined"));
    }
    // Force eshttp into local scope
    if (typeof eshttp === "undefined" && typeof $.global.eshttp !== "undefined") {
        eshttp = $.global.eshttp;
    } else if (typeof eshttp === "undefined" && typeof this.eshttp !== "undefined") {
        eshttp = this.eshttp;
    }
    $.writeln("After fix, eshttp defined: " + (typeof eshttp !== "undefined"));

    var results = {
        dllLoad: { success: false, error: null, transport: null, nativeVersion: null },
        httpRequest: { success: false, error: null, status: 0, body: null, meta: null },
        socketFallback: { success: false, error: null, status: 0, body: null, meta: null },
        httpsProbe: { success: false, error: null, timeMs: 0, status: 0, tlsVersion: null, meta: null }
    };

    // ============================================================
    // Test 1: ExternalObject("lib:eshttp") load + transportInfo
    // ============================================================
    try {
        var info = eshttp.transportInfo();
        results.dllLoad.success = true;
        results.dllLoad.transport = info.transport;
        results.dllLoad.nativeVersion = info.nativeVersion;
        results.dllLoad.externalObjectAvailable = info.externalObjectAvailable;
        results.dllLoad.socketAvailable = info.socketAvailable;
    } catch (e) {
        results.dllLoad.success = false;
        results.dllLoad.error = e.message || String(e);
    }

    // ============================================================
    // Test 2: Live HTTP GET against mock server (native transport)
    // ============================================================
    try {
        var r = eshttp.get("http://127.0.0.1:18080/json", { timeout: 10000 });
        results.httpRequest.success = r.ok;
        results.httpRequest.status = r.status;
        results.httpRequest.body = r.body;
        results.httpRequest.meta = r.meta;
        if (r.error) {
            results.httpRequest.error = r.error.message || JSON.stringify(r.error);
        }
    } catch (e) {
        results.httpRequest.success = false;
        results.httpRequest.error = e.message || String(e);
    }

    // ============================================================
    // Test 3: ES3 Socket fallback (forceTransport "socket")
    // ============================================================
    try {
        var forced = eshttp.forceTransport("socket");
        var r = eshttp.get("http://127.0.0.1:18080/json", { timeout: 10000 });
        results.socketFallback.success = r.ok;
        results.socketFallback.status = r.status;
        results.socketFallback.body = r.body;
        results.socketFallback.meta = r.meta;
        results.socketFallback.forcedTransport = forced;
        if (r.error) {
            results.socketFallback.error = r.error.message || JSON.stringify(r.error);
        }
        // Reset to auto
        eshttp.resetTransport();
    } catch (e) {
        results.socketFallback.success = false;
        results.socketFallback.error = e.message || String(e);
        eshttp.resetTransport();
    }

    // ============================================================
    // Test 4: Native HTTPS/TLS probe (real https endpoint)
    // ============================================================
    try {
        var start = new Date().getTime();
        // Use a reliable HTTPS endpoint - httpbin.org or similar
        var r = eshttp.get("https://httpbin.org/get", { timeout: 15000 });
        var elapsed = new Date().getTime() - start;
        results.httpsProbe.success = r.ok;
        results.httpsProbe.timeMs = elapsed;
        results.httpsProbe.status = r.status;
        results.httpsProbe.tlsVersion = r.meta && r.meta.tlsVersion ? r.meta.tlsVersion : null;
        results.httpsProbe.meta = r.meta;
        if (r.error) {
            results.httpsProbe.error = r.error.message || JSON.stringify(r.error);
        }
    } catch (e) {
        results.httpsProbe.success = false;
        results.httpsProbe.error = e.message || String(e);
        results.httpsProbe.timeMs = new Date().getTime() - start;
    }

    // Output results as JSON
    var out = JSON.stringify(results, null, 2);
    $.writeln("=== ESHTTP LIVE TEST RESULTS ===");
    $.writeln(out);
    $.writeln("=== END RESULTS ===");

    // Also write to a file for retrieval
    var outFile = new File(Folder.temp + "/eshttp-live-results.json");
    outFile.open("w");
    outFile.write(out);
    outFile.close();

    // Return the results for COM transport
    out;