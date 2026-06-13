import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';

export async function runWebsocketExhaustion(target, config, durationSeconds) {
  const {
    connections,
    concurrent_connections = connections ?? 100,
    message_interval_ms    = 0,
    protocol               = null,
  } = config;

  // Support both ws:// and http:// style targets
  const httpTarget = target.replace(/^wss?/, (m) => m === 'wss' ? 'https' : 'http');
  const url     = new URL(httpTarget);
  const isHttps = url.protocol === 'https:';
  const mod     = isHttps ? https : http;
  const port    = parseInt(url.port) || (isHttps ? 443 : 80);

  const endTime = Date.now() + durationSeconds * 1000;
  let opened = 0, errors = 0;

  function openSocket() {
    return new Promise((resolve) => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      const reqHeaders = {
        Host                  : url.host,
        Upgrade               : 'websocket',
        Connection            : 'Upgrade',
        'Sec-WebSocket-Key'   : wsKey,
        'Sec-WebSocket-Version': '13',
      };
      if (protocol) reqHeaders['Sec-WebSocket-Protocol'] = protocol;

      const req = mod.request(
        { hostname: url.hostname, port, path: url.pathname || '/', method: 'GET',
          headers: reqHeaders, rejectUnauthorized: false },
      );

      req.on('upgrade', (_res, socket) => {
        opened++;
        let msgTimer;
        if (message_interval_ms > 0) {
          // WebSocket ping frame: FIN=1, opcode=0x9, no mask, no payload
          msgTimer = setInterval(() => {
            if (socket.writable) socket.write(Buffer.from([0x89, 0x00]));
          }, message_interval_ms);
        }
        const cleanup = () => {
          if (msgTimer) clearInterval(msgTimer);
          socket.destroy();
          resolve();
        };
        socket.on('error', cleanup);
        socket.on('close', cleanup);
        // Keep alive until duration expires
        setTimeout(cleanup, Math.max(0, endTime - Date.now() + 100));
      });

      req.on('error',    () => { errors++; resolve(); });
      req.on('response', () => { errors++; resolve(); }); // non-101 → no upgrade
      req.setTimeout(5000, () => { req.destroy(); errors++; resolve(); });
      req.end();
    });
  }

  await Promise.all(Array.from({ length: concurrent_connections }, openSocket));

  const total = opened + errors;
  return {
    avgLatencyMs      : 0,
    errorRateBps      : total > 0 ? Math.round((errors / total) * 10000) : 10_000,
    requestsCompleted : total,
  };
}
