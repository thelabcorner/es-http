// ESHTTP transport resolution (ported from src/eshttp.jsxinc L1931–1963;
// api-spec §9 / assignment tier rules; T9 cli tier).
//
// Resolves the active transport name: "native" | "cli" | "socket" | "none".
// Precedence: forced transport ("auto"|"native"|"cli"|"socket") -> defaults
// -> probe. `__noNetwork` short-circuits to "none". Updates the module
// state's _currentTransport (the live `eshttp.transport` getter reads it).
//
// TIER ORDER (auto) — native -> cli -> socket -> none. Rationale (T9
// decision): native (eshttp.dll, in-process) is the canonical fast path when
// it works. cli (eshttp-cli.exe, separate process) is the firewall-escape
// native-equivalent AND the only https-capable fallback when native is dead
// (socket is cleartext-only — the old dllDead+https path returned
// "unsupported"; cli now fills that gap). socket is the pure-ES3 cleartext
// fallback. When a tier is unavailable (native: DLL probe fail; cli: exe
// missing / session-dead; socket: no Socket object) auto skips it.
import { _forcedTransport, _defaults, noNetwork, setCurrentTransport } from './state';
import { probeNative } from './driver-native';
import { cliAvailable, cliPresent } from './driver-cli';
import { socketAvailable } from './driver-socket';

/**
 * Resolve + record the active transport. Returns the transport name and
 * updates `_currentTransport` (the `eshttp.transport` live getter).
 */
export function resolveTransport(forceName?: string): string {
  var name = (forceName === undefined || forceName === null)
    ? (_forcedTransport || _defaults.transport || "auto")
    : forceName;
  if (noNetwork()) {
    setCurrentTransport("none");
    return "none";
  }
  if (name === "native") {
    var nat = probeNative();
    var tNative = (nat.accel && nat.available && !nat.dead) ? "native" : "none";
    setCurrentTransport(tNative);
    return tNative;
  }
  if (name === "cli") {
    // Forced 'cli': route to the driver whenever the exe is PRESENT so a
    // session-dead tier reports the dead marker (internal, message "dead")
    // instead of "unsupported" (T9/35-cli-transport Q3). Only a fully absent
    // exe (or __noNetwork) yields "none".
    var tCli = cliPresent() ? "cli" : "none";
    setCurrentTransport(tCli);
    return tCli;
  }
  if (name === "socket") {
    var tSocket = socketAvailable() ? "socket" : "none";
    setCurrentTransport(tSocket);
    return tSocket;
  }
  // auto: native -> cli -> socket -> none
  var cache = probeNative();
  var t: string;
  if (cache.accel && cache.available && !cache.dead) {
    t = "native";
  } else if (cliAvailable()) {
    t = "cli";
  } else if (socketAvailable()) {
    t = "socket";
  } else {
    t = "none";
  }
  setCurrentTransport(t);
  return t;
}
