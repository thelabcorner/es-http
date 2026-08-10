// ESHTTP transport resolution (ported from src/eshttp.jsxinc L1931–1963;
// api-spec §9 / assignment tier rules; T9 cli tier; T24 pipe-primary).
//
// Resolves the active transport name: "native" | "cli" | "socket" | "none".
// Precedence: forced transport ("auto"|"native"|"cli"|"socket") -> defaults
// -> probe. `__noNetwork` short-circuits to "none". Updates the module
// state's _currentTransport (the live `eshttp.transport` getter reads it).
//
// TIER ORDER (auto) — cli(pipe) -> native -> socket -> none. Rationale
// (T24 sponsor decision, v1.0.1): the cli pipe is the firewall-escape
// PRIMARY — eshttp-cli.exe is a separate process image (not matched by the
// host firewall), https-capable (same engine as the DLL), and keeps a warm
// persistent worker (no per-request spawn). The in-process WinHTTP DLL
// (native) becomes an OPT-IN tier: auto reaches it only when the pipe is
// unavailable/dead AND the separate native accel/DLL is staged (probe
// succeeds). forceTransport("native") remains the explicit opt-in that
// forces native even when the pipe is fine. socket is the pure-ES3
// cleartext fallback. When a tier is unavailable (cli: exe missing /
// session-dead; native: DLL not staged / probe fail / dead; socket: no
// Socket object) auto skips it.
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
  // auto: cli(pipe) -> native (opt-in, DLL staged) -> socket -> none
  // (T24: pipe-primary — the cli tier wins whenever the exe is available;
  // native is reached only when cli is unavailable/dead AND the separate
  // native accel/DLL is staged. forceTransport('native') bypasses all this.)
  var t: string;
  if (cliAvailable()) {
    t = "cli";
  } else {
    var cache = probeNative();
    if (cache.accel && cache.available && !cache.dead) {
      t = "native";
    } else if (socketAvailable()) {
      t = "socket";
    } else {
      t = "none";
    }
  }
  setCurrentTransport(t);
  return t;
}
