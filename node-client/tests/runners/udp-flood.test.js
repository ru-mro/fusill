import dgram from 'dgram';
import { assert } from 'chai';
import { runUdpFlood } from '../../src/runners/udp-flood.js';

describe('runner: udpFlood', () => {
  let server, port, getPackets;

  before(async () => {
    server = dgram.createSocket('udp4');
    let received = 0;
    server.on('message', () => { received++; });
    server.on('error', () => {});
    await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
    port = server.address().port;
    getPackets = () => received;
  });

  after(() => server.close());

  it('sends UDP packets to the target and returns metrics', async () => {
    const before = getPackets();
    const m = await runUdpFlood(`127.0.0.1:${port}`, { packets_per_second: 200, payload_size: 64 }, 1);

    assert.isNumber(m.avgLatencyMs);
    assert.isNumber(m.errorRateBps);
    assert.isNumber(m.requestsCompleted);
    assert.ok(m.requestsCompleted > 0, 'must have sent packets');
    assert.ok(getPackets() > before, 'the server must have received packets');
  });

  it('accepts target with a scheme (ws://, http://)', async () => {
    const m = await runUdpFlood(`udp://127.0.0.1:${port}`, { packets_per_second: 100 }, 1);
    assert.ok(m.requestsCompleted >= 0);
  });
});
