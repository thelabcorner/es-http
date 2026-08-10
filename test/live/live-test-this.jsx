/*
 * live-test-this.jsx — Check this context
 */
#target illustrator

var out = "";
out += "typeof this: " + (typeof this) + "\n";
out += "this === $.global: " + (this === $.global) + "\n";
out += "typeof $.global: " + (typeof $.global) + "\n";

// Load eshttp.jsxinc
var eshttpPath = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/eshttp/src/eshttp.jsxinc";
$.evalFile(new File(eshttpPath));

out += "After evalFile:\n";
out += "typeof this.eshttp: " + (typeof this.eshttp) + "\n";
out += "typeof $.global.eshttp: " + (typeof $.global.eshttp) + "\n";

var outFile = new File(Folder.temp + "/eshttp-this-test.txt");
outFile.open("w");
outFile.write(out);
outFile.close();

out;