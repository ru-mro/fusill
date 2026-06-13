import http from 'http';
import { assert } from 'chai';
import { runAttack } from '../../src/runner.js';

function startServer() {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

describe('runner dispatcher (runAttack)', () => {
  let server, port;

  before(async () => ({ server, port } = await startServer()));
  after(() => server.close());

  it('throws an error for an unknown runnerType', async () => {
    let err;
    try {
      await runAttack('http://127.0.0.1', 'unknownRunner', {}, 1);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must throw');
    assert.include(err.message, 'Unknown runner');
    assert.include(err.message, 'unknownRunner');
  });

  it('dispatches httpFlood correctly', async () => {
    const m = await runAttack(
      `http://127.0.0.1:${port}`,
      'httpFlood',
      { concurrent_connections: 2 },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
  });

  it('dispatches slowloris correctly', async () => {
    const m = await runAttack(
      `http://127.0.0.1:${port}`,
      'slowloris',
      { concurrent_connections: 3, headers_interval_ms: 500 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
  });

  it('dispatches synFlood — returns metrics or a CAP_NET_RAW error', async () => {
    let metrics, err;
    try {
      metrics = await runAttack('127.0.0.1:80', 'synFlood', { packets_per_second: 500 }, 1);
    } catch (e) {
      err = e;
    }
    if (err) assert.include(err.message, 'CAP_NET_RAW');
    else     assert.isNumber(metrics.requestsCompleted);
  });

  it('dispatches udpFlood — sends packets without requiring raw sockets', async () => {
    const m = await runAttack('127.0.0.1:9', 'udpFlood', { packets_per_second: 100 }, 1);
    assert.isNumber(m.requestsCompleted);
    assert.ok(m.requestsCompleted >= 0);
  });
});
