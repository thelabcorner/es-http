/*
 * live-test-simple.jsx — Simple live test of eshttp inside Illustrator via COM
 */
#target illustrator

(function () {
    // Stage the DLL per ExternalObject resolution rules
    var nativeDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/native";
    ExternalObject.searchFolders = nativeDir + ";" + ExternalObject.searchFolders;
    $.writeln("Search folders: " + ExternalObject.searchFolders);
    
    // Load eshttp.jsxinc - use absolute path
    var eshttpPath = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/src/eshttp.jsxinc";
    var f = new File(eshttpPath);
    $.writeln("File exists: " + f.exists);
    var loadResult = $.evalFile(f);
    $.writeln("Load result: " + loadResult);
    
    // Get eshttp from global
    var eshttp = $.global.eshttp;
    $.writeln("eshttp defined: " + (typeof eshttp !== "undefined"));
    
    if (typeof eshttp === "undefined") {
        var err = "FAIL: eshttp not loaded";
        $.writeln(err);
        var outFile = new File(Folder.temp + "/eshttp-test-result.txt");
        outFile.open("w");
        outFile.write(err);
        outFile.close();
        return err;
    }
    
    // Test 1: transportInfo
    try {
        var info = eshttp.transportInfo();
        var out = JSON.stringify(info, null, 2);
        $.writeln("transportInfo: " + out);
        
        var outFile = new File(Folder.temp + "/eshttp-test-result.txt");
        outFile.open("w");
        outFile.write(out);
        outFile.close();
        
        return out;
    } catch (e) {
        var err = "FAIL transportInfo: " + (e.message || String(e));
        $.writeln(err);
        var outFile = new File(Folder.temp + "/eshttp-test-result.txt");
        outFile.open("w");
        outFile.write(err);
        outFile.close();
        return err;
    }
})();