/*
 * live-test-transport.jsx — Test transportInfo
 */
#target illustrator

// Stage the DLL per ExternalObject resolution rules
var nativeDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/native";
ExternalObject.searchFolders = nativeDir + ";" + ExternalObject.searchFolders;

// Load eshttp.jsxinc
var eshttpPath = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/src/eshttp.jsxinc";
$.evalFile(new File(eshttpPath));

// Get eshttp from this (wrapper function in COM eval context)
var eshttp = this.eshttp;

var out = "";

if (typeof eshttp === "undefined") {
    out += "FAIL: eshttp is undefined\n";
} else {
    // Test transportInfo
    try {
        var info = eshttp.transportInfo();
        out += "transportInfo: " + JSON.stringify(info, null, 2) + "\n";
    } catch (e) {
        out += "transportInfo FAILED: " + (e.message || String(e)) + "\n";
    }
}

var outFile = new File(Folder.temp + "/eshttp-transport-test.txt");
outFile.open("w");
outFile.write(out);
outFile.close();

out;