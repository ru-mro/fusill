import http from 'http';
import { assert } from 'chai';
import { runSlowloris } from '../../src/runners/slowloris.js';

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

describe('runner: slowloris', () => {
  let server, port;

  before(async () => ({ server, port } = await startServer()));
  after(() => server.close());

  it('returns metrics with the correct shape', async () => {
    const m = await runSlowloris(
      `http://127.0.0.1:${port}`,
      { concurrent_connections: 5, headers_interval_ms: 500 },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.equal(m.avgLatencyMs, 0, 'slowloris does not measure response latency');
  });

  it('reports open connections in requestsCompleted', async () => {
    const m = await runSlowloris(
      `http://127.0.0.1:${port}`,
      { concurrent_connections: 5, headers_interval_ms: 500 },
      2,
    );
    assert.ok(m.requestsCompleted > 0, 'must have opened at least one connection');
  });

  it('handles a nonexistent target without throwing', async () => {
    const m = await runSlowloris(
      'http://127.0.0.1:19999',
      { concurrent_connections: 3, headers_interval_ms: 200 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
  });
});
