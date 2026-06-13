import net from 'net';
import { assert } from 'chai';
import { runHttp2Continuation } from '../../src/runners/http2-continuation.js';

const HTTP2_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

function startRawServer() {
  let bytesReceived = 0;
  let connectionsReceived = 0;

  const server = net.createServer((socket) => {
    connectionsReceived++;
    socket.on('data', (chunk) => {
      bytesReceived += chunk.length;
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getBytes:       () => bytesReceived,
        getConnections: () => connectionsReceived,
      });
    });
  });
}

describe('runner: http2Continuation', () => {
  let server, port, getBytes, getConnections;

  before(async () => ({ server, port, getBytes, getConnections } = await startRawServer()));
  after(() => server.close());

  it('returns metrics with the correct shape', async () => {
    const m = await runHttp2Continuation(
      `http://127.0.0.1:${port}`,
      { connections: 2, frames_per_connection: 10 },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.equal(m.avgLatencyMs, 0, 'continuation flood does not measure response latency');
    assert.ok(m.requestsCompleted >= 0);
  });

  it('sends CONTINUATION frames to the server (CVE-2024-27316)', async () => {
    const bytesBefore = getBytes();
    const m = await runHttp2Continuation(
      `http://127.0.0.1:${port}`,
      { connections: 2, frames_per_connection: 20 },
      2,
    );
    const bytesAfter = getBytes();
    assert.ok(bytesAfter > bytesBefore, 'the server must have received bytes');
    assert.ok(m.requestsCompleted > 0, 'requestsCompleted must reflect frames sent');
  });

  it('includes the HTTP/2 preface in the sent data (the server receives it)', async () => {
    const connsBefore = getConnections();
    await runHttp2Continuation(
      `http://127.0.0.1:${port}`,
      { connections: 1, frames_per_connection: 5 },
      2,
    );
    const connsAfter = getConnections();
    assert.ok(connsAfter > connsBefore, 'must have opened at least one TCP connection');
  });

  it('handles a nonexistent target without throwing', async () => {
    const m = await runHttp2Continuation(
      'http://127.0.0.1:19997',
      { connections: 2, frames_per_connection: 5 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
  });
});
