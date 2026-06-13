import http2 from 'http2';
import { assert } from 'chai';
import { runHttp2RapidReset } from '../../src/runners/http2-rapid-reset.js';

function startH2Server() {
  const server = http2.createServer();
  let streamsReceived = 0;

  server.on('stream', (stream) => {
    streamsReceived++;
    stream.respond({ ':status': 200 });
    stream.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, getStreams: () => streamsReceived });
    });
  });
}

describe('runner: http2RapidReset', () => {
  let server, port, getStreams;

  before(async () => ({ server, port, getStreams } = await startH2Server()));
  after(() => server.close());

  it('returns metrics with the correct shape', async () => {
    const m = await runHttp2RapidReset(
      `http://127.0.0.1:${port}`,
      { connections: 2, streams_per_connection: 10, reset_immediately: true },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.ok(m.requestsCompleted >= 0);
    assert.ok(m.errorRateBps >= 0 && m.errorRateBps <= 10_000);
  });

  it('counts sent streams in requestsCompleted (CVE-2023-44487)', async () => {
    // With reset_immediately=true the RST arrives before the server processes the stream,
    // but the runner increments totalStreams before the RST — the runner counter is what matters.
    const m = await runHttp2RapidReset(
      `http://127.0.0.1:${port}`,
      { connections: 2, streams_per_connection: 5, reset_immediately: true },
      2,
    );
    assert.ok(m.requestsCompleted > 0, `requestsCompleted must reflect sent streams: ${m.requestsCompleted}`);
  });

  it('handles a non-existent target without throwing', async () => {
    const m = await runHttp2RapidReset(
      'http://127.0.0.1:19998',
      { connections: 2, streams_per_connection: 5 },
      2,
    );
    assert.isNumber(m.requestsCompleted);
    assert.equal(m.errorRateBps, 10_000, 'errorRateBps must be maximum when there are no streams');
  });
});
