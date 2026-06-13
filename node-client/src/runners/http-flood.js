import http from 'http';
import https from 'https';
import { URL } from 'url';
import { performance } from 'perf_hooks';

export async function runHttpFlood(target, config, durationSeconds) {
  const {
    method               = 'GET',
    headers              = {},
    body                 = null,
    path                 = null,
    concurrent_connections = 50,
  } = config;

  const url      = new URL(target);
  const isHttps  = url.protocol === 'https:';
  const mod      = isHttps ? https : http;
  const agent    = new mod.Agent({ keepAlive: true, maxSockets: concurrent_connections });

  const endTime  = performance.now() + durationSeconds * 1000;
  let requests = 0, errors = 0, latencySum = 0, latencyCount = 0;

  const bodyBuf  = body ? Buffer.from(body) : null;
  const autoHeaders = bodyBuf ? {
    'Content-Type'   : 'application/json',
    'Content-Length' : bodyBuf.length,
  } : {};

  const reqOpts = {
    hostname : url.hostname,
    port     : url.port || (isHttps ? 443 : 80),
    path     : path ?? (url.pathname + url.search),
    method,
    headers  : { 'User-Agent': 'Fusill/1.0', ...autoHeaders, ...headers },
    agent,
    timeout  : 10_000,
  };

  function sendOne() {
    const start = performance.now();
    return new Promise((resolve) => {
      const req = mod.request(reqOpts, (res) => {
        res.resume();
        latencySum += performance.now() - start;
        latencyCount++;
        if (res.statusCode >= 500) errors++;
        resolve();
      });
      req.on('error',   () => { errors++; resolve(); });
      req.on('timeout', () => { req.destroy(); errors++; resolve(); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  async function worker() {
    while (performance.now() < endTime) {
      requests++;
      await sendOne();
    }
  }

  await Promise.all(Array.from({ length: concurrent_connections }, worker));
  agent.destroy();

  return {
    avgLatencyMs      : latencyCount > 0 ? Math.ceil(latencySum / latencyCount) : 0,
    errorRateBps      : requests > 0 ? Math.round((errors / requests) * 10000) : 0,
    requestsCompleted : requests,
  };
}
