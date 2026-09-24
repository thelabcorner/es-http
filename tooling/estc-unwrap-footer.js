// ESTC unwrap/publish footer for the ESHTTP JSX artifact.
//
// The library (src/index.ts) publishes the facade itself: a guarded
// data-descriptor Object.defineProperty when the engine provides it, else a
// plain assignment onto the session global. This footer only binds the
// eval-scope `eshttp` global from that publish, mirroring the jsxinc global
// binding that #include / $.evalFile consumers rely on. It never patches
// Object, Function.prototype, or any other persistent built-in.
var eshttp = (function () {
  var g = null;
  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}
  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }
  if (g && g.eshttp && typeof g.eshttp.request === "function") { return g.eshttp; }
  return null;
}());
