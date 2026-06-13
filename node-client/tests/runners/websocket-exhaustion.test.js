import http from 'http';
import crypto from 'crypto';
import { assert } from 'chai';
import { runWebsocketExhaustion } from '../../src/runners/websocket-exhaustion.js';

function wsAccept(key) {
  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function startWsServer() {
  const server = http.createServer();
  let upgrades = 0;

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      '\r\n',
    );
    upgrades++;
    socket.on('error', () => {});
    socket.on('data', () => {});  // absorb pings
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, getUpgrades: () => upgrades });
    });
  });
}

describe('runner: websocketExhaustion', () => {
  let server, port, getUpgrades;

  before(async () => ({ server, port, getUpgrades } = await startWsServer()));
  after(() => server.close());

  it('returns metrics with the correct shape', async () => {
    const m = await runWebsocketExhaustion(
      `ws://127.0.0.1:${port}`,
      { concurrent_connections: 5, message_interval_ms: 0 },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.equal(m.avgLatencyMs, 0, 'websocket exhaustion does not measure latency');
    assert.ok(m.requestsCompleted >= 0);
  });

  it('opens WebSocket connections (101 Upgrade)', async () => {
    const before = getUpgrades();
    const m = await runWebsocketExhaustion(
      `ws://127.0.0.1:${port}`,
      { concurrent_connections: 5, message_interval_ms: 0 },
      2,
    );
    const after = getUpgrades();
    assert.ok(after > before, `the server must have received upgrades — before: ${before}, after: ${after}`);
    assert.ok(m.requestsCompleted > 0, 'requestsCompleted must be > 0');
  });

  it('also accepts a target with http:// prefix instead of ws://', async () => {
    const m = await runWebsocketExhaustion(
      `http://127.0.0.1:${port}`,
      { concurrent_connections: 3, message_interval_ms: 0 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
  });

  it('handles a nonexistent target without throwing', async () => {
    const m = await runWebsocketExhaustion(
      'ws://127.0.0.1:19995',
      { concurrent_connections: 3, message_interval_ms: 0 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
    assert.equal(m.errorRateBps, 10_000, 'all attempts must fail');
  });
});
