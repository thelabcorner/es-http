/*
 * live-test-load.jsx — Test loading eshttp.jsxinc
 */
#target illustrator

// Stage the DLL per ExternalObject resolution rules
var nativeDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/native";
ExternalObject.searchFolders = nativeDir + ";" + ExternalObject.searchFolders;

// Load eshttp.jsxinc
var eshttpPath = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/src/eshttp.jsxinc";
var result = $.evalFile(new File(eshttpPath));

var out = "evalFile result: " + result + "\n";
out += "typeof eshttp: " + (typeof eshttp) + "\n";
out += "typeof $.global.eshttp: " + (typeof $.global.eshttp) + "\n";

var outFile = new File(Folder.temp + "/eshttp-load-test.txt");
outFile.open("w");
outFile.write(out);
outFile.close();

out;