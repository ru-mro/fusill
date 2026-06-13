import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';
import { performance } from 'perf_hooks';

const PROBE_TIMEOUT_MS = 3000;

/**
 * Measures the target's response latency BEFORE the attack starts, so the
 * revealed result carries a "before vs under attack" comparison the client can
 * act on. Returns milliseconds (rounded up), or 0 if the probe fails.
 *
 * - http(s):// → HTTP GET round-trip
 * - everything else (ws://, host:port for dns/syn/udp) → TCP connect time
 */
export async function measureBaseline(target) {
  try {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      return await httpProbe(target);
    }
    return await tcpProbe(target);
  } catch {
    return 0;
  }
}

function httpProbe(target) {
  const url = new URL(target);
  const mod = url.protocol === 'https:' ? https : http;
  const opts = {
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
    path:     url.pathname + url.search,
    method:   'GET',
    rejectUnauthorized: false,
    timeout:  PROBE_TIMEOUT_MS,
  };

  return new Promise((resolve) => {
    const start = performance.now();
    const req = mod.request(opts, (res) => {
      res.resume();
      res.on('end', () => resolve(Math.ceil(performance.now() - start)));
    });
    req.on('error',   () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function tcpProbe(target) {
  // Accept ws://host:port, host:port, or host (default port 80)
  const clean = target.replace(/^\w+:\/\//, '');
  const [host, portStr] = clean.split(':');
  const port = parseInt(portStr) || 80;

  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.connect({ host, port, timeout: PROBE_TIMEOUT_MS }, () => {
      const ms = Math.ceil(performance.now() - start);
      sock.destroy();
      resolve(ms);
    });
    sock.on('error',   () => resolve(0));
    sock.on('timeout', () => { sock.destroy(); resolve(0); });
  });
}
