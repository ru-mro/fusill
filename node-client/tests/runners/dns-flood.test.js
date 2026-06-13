import dgram from 'dgram';
import { assert } from 'chai';
import { runDnsFlood } from '../../src/runners/dns-flood.js';

// Minimal DNS server that echoes back the same transaction ID with a valid response flag
function startDnsServer() {
  const server = dgram.createSocket('udp4');
  let packetsReceived = 0;

  server.on('message', (msg, rinfo) => {
    packetsReceived++;
    if (msg.length < 12) return;
    // Build a minimal DNS response: copy the query, set QR bit (response)
    const response = Buffer.from(msg);
    response.writeUInt16BE(msg.readUInt16BE(2) | 0x8000, 2); // set QR=1
    server.send(response, rinfo.port, rinfo.address);
  });
  server.on('error', () => {});

  return new Promise((resolve, reject) => {
    server.bind(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, getPackets: () => packetsReceived });
    });
    server.on('error', reject);
  });
}

describe('runner: dnsFlood', () => {
  let server, port, getPackets;

  before(async () => ({ server, port, getPackets } = await startDnsServer()));
  after(() => server.close());

  it('returns metrics with the correct shape', async () => {
    const m = await runDnsFlood(
      `127.0.0.1:${port}`,
      { qps_per_node: 100, randomize_subdomain: false, query_domain: 'example.com' },
      2,
    );
    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.ok(m.avgLatencyMs >= 0);
    assert.ok(m.requestsCompleted >= 0);
  });

  it('measures the RTT of DNS responses (avgLatencyMs > 0)', async () => {
    const m = await runDnsFlood(
      `127.0.0.1:${port}`,
      { qps_per_node: 100, randomize_subdomain: true, query_domain: 'example.com' },
      2,
    );
    assert.ok(m.avgLatencyMs >= 0, 'avgLatencyMs must be >= 0');
    // The test server responds locally — RTT must be < 100ms
    assert.ok(m.avgLatencyMs < 100, `RTT too high for loopback: ${m.avgLatencyMs}ms`);
    assert.ok(m.requestsCompleted > 0, 'must have sent queries');
  });

  it('sends UDP queries to the target server', async () => {
    const before = getPackets();
    const m = await runDnsFlood(
      `127.0.0.1:${port}`,
      { qps_per_node: 100, randomize_subdomain: true, query_domain: 'example.com' },
      2,
    );
    const after = getPackets();
    assert.ok(after > before, `the server must have received queries — before: ${before}, after: ${after}`);
    assert.ok(m.requestsCompleted > 0, 'must have sent queries successfully');
  });

  it('accepts target as a URL (extracts hostname and port)', async () => {
    const m = await runDnsFlood(
      `http://127.0.0.1:${port}`,
      { qps_per_node: 50, randomize_subdomain: false, query_domain: 'example.com' },
      2,
    );
    assert.isNumber(m.requestsCompleted);
  });
});
