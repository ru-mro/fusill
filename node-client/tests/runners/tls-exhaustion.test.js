import tls from 'tls';
import net from 'net';
import { assert } from 'chai';
import { runTlsExhaustion } from '../../src/runners/tls-exhaustion.js';

// Starts a plain TCP server that immediately closes — simulates TLS refused
function startRefusingServer() {
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

describe('runner: tlsExhaustion', () => {
  let server, port;

  before(async () => ({ server, port } = await startRefusingServer()));
  after(() => server.close());

  it('returns metrics with the correct shape (target that refuses TLS)', async () => {
    const m = await runTlsExhaustion(
      `https://127.0.0.1:${port}`,
      { handshakes_per_second: 10 },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.ok(m.avgLatencyMs >= 0);
    assert.ok(m.errorRateBps >= 0 && m.errorRateBps <= 10_000);
    assert.ok(m.requestsCompleted >= 0);
  });

  it('reports errors when the server refuses the TLS connection', async () => {
    const m = await runTlsExhaustion(
      `https://127.0.0.1:${port}`,
      { handshakes_per_second: 10 },
      2,
    );
    assert.ok(m.requestsCompleted > 0, 'must have attempted at least one handshake');
  });

  it('handles a completely nonexistent target without throwing', async () => {
    const m = await runTlsExhaustion(
      'https://127.0.0.1:19996',
      { handshakes_per_second: 5 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
    assert.equal(m.errorRateBps, 10_000, 'all attempts must fail with ECONNREFUSED');
  });
});
