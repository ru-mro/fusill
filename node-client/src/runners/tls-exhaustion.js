import tls from 'tls';
import { URL } from 'url';

export async function runTlsExhaustion(target, config, durationSeconds) {
  const {
    handshakes_per_second = 50,
    complete_handshake    = false,
  } = config;

  const url  = new URL(target);
  const host = url.hostname;
  const port = parseInt(url.port) || 443;

  const endTime    = Date.now() + durationSeconds * 1000;
  const intervalMs = Math.max(1, 1000 / handshakes_per_second);

  let attempts = 0, errors = 0, latencySum = 0, latencyCount = 0;
  const pending = new Set();

  function doHandshake() {
    attempts++;
    const start = Date.now();
    const p = new Promise((resolve) => {
      const sock = tls.connect(
        { host, port, rejectUnauthorized: false, timeout: 5000 },
        () => {
          latencySum += Date.now() - start;
          latencyCount++;
          if (complete_handshake) sock.end();
          else sock.destroy();
          resolve();
        }
      );
      sock.on('error',   () => { errors++; resolve(); });
      sock.on('timeout', () => { sock.destroy(); errors++; resolve(); });
    }).finally(() => pending.delete(p));
    pending.add(p);
  }

  // Fire handshakes at the configured rate until duration expires
  await new Promise((resolve) => {
    const ticker = setInterval(() => {
      if (Date.now() >= endTime) {
        clearInterval(ticker);
        resolve();
        return;
      }
      doHandshake();
    }, intervalMs);
  });

  // Wait for all in-flight handshakes to complete
  await Promise.allSettled([...pending]);

  return {
    avgLatencyMs      : latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
    errorRateBps      : attempts > 0 ? Math.round((errors / attempts) * 10000) : 10_000,
    requestsCompleted : attempts,
  };
}
