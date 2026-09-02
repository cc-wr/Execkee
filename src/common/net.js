import net from 'node:net';

// Is something accepting TCP connections on this port right now?
//
// Used for the machine-local LLM gateway, which is a SINGLETON per machine: the
// controller and a workhorse can both run on one box, and each supervisor would
// otherwise spawn its own agentgateway. The second one dies on bind ("Only one
// usage of each socket address", os error 10048 — it collides on the readiness /
// stats ports even before the data port). So every would-be owner probes first and
// shares whatever is already listening; loopback makes sharing free.
//
// Resolves false on any error/timeout — "not reachable" is the safe answer for both
// callers (start one / don't route through it).
export function portInUse(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}
