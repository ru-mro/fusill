import http from 'http';
import { assert } from 'chai';
import { runHttpFlood } from '../../src/runners/http-flood.js';

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function assertMetrics(metrics) {
  assert.isNumber(metrics.avgLatencyMs,      'avgLatencyMs must be a number');
  assert.isNumber(metrics.errorRateBps,      'errorRateBps must be a number');
  assert.isNumber(metrics.requestsCompleted, 'requestsCompleted must be a number');
  assert.ok(metrics.avgLatencyMs      >= 0,  'avgLatencyMs >= 0');
  assert.ok(metrics.errorRateBps      >= 0,  'errorRateBps >= 0');
  assert.ok(metrics.requestsCompleted >= 0,  'requestsCompleted >= 0');
}

describe('runner: httpFlood', () => {
  let server, port;

  before(async () => ({ server, port } = await startServer()));
  after(() => server.close());

  it('returns metrics with the correct shape', async () => {
    const m = await runHttpFlood(
      `http://127.0.0.1:${port}`,
      { method: 'GET', concurrent_connections: 3 },
      2,
    );
    assertMetrics(m);
    assert.ok(m.requestsCompleted > 0, 'must have sent at least one request');
  });

  it('POST flood also returns valid metrics', async () => {
    const m = await runHttpFlood(
      `http://127.0.0.1:${port}`,
      { method: 'POST', concurrent_connections: 2, body: 'data=test' },
      2,
    );
    assertMetrics(m);
  });

  it('handles a nonexistent target without throwing', async () => {
    const m = await runHttpFlood(
      'http://127.0.0.1:19999',
      { concurrent_connections: 2 },
      2,
    );
    assertMetrics(m);
    assert.equal(m.errorRateBps, 10000, 'all requests must be errors');
  });
});
