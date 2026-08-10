/*
 * live-test-dll-load.jsx — Test DLL loading directly
 */
#target illustrator

(function () {
    var out = "";
    
    // Stage the DLL per ExternalObject resolution rules
    var nativeDir = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/native";
    ExternalObject.searchFolders = nativeDir + ";" + ExternalObject.searchFolders;
    ExternalObject.log = true;
    out += "Search folders: " + ExternalObject.searchFolders + "\n";
    
    // Search for the DLL first
    var found = ExternalObject.search("lib:eshttp");
    out += "ExternalObject.search('lib:eshttp'): " + found + "\n";
    
    // Try to create ExternalObject
    var lib = null;
    try {
        lib = new ExternalObject("lib:eshttp");
        out += "new ExternalObject('lib:eshttp') succeeded: " + (lib !== null) + "\n";
        if (lib) {
            out += "Object created successfully\n";
        }
    } catch (e) {
        out += "new ExternalObject('lib:eshttp') FAILED: " + (e.message || String(e)) + "\n";
    }
    
    var outFile = new File(Folder.temp + "/eshttp-dll-test.txt");
    outFile.open("w");
    outFile.write(out);
    outFile.close();
    
    return out;
})();