import { assert } from 'chai';
import { runSynFlood } from '../../src/runners/syn-flood.js';

describe('runner: synFlood', () => {
  // SYN flood needs raw sockets (CAP_NET_RAW). Whether the helper binary has the
  // capability is environment-dependent, so accept either outcome:
  //   - granted   → returns valid metrics
  //   - not granted → rejects with a CAP_NET_RAW error
  it('returns metrics or fails indicating it requires CAP_NET_RAW', async () => {
    let metrics, err;
    try {
      metrics = await runSynFlood('127.0.0.1:80', { packets_per_second: 500 }, 1);
    } catch (e) {
      err = e;
    }

    if (err) {
      assert.include(err.message, 'CAP_NET_RAW');
    } else {
      assert.isNumber(metrics.requestsCompleted);
      assert.ok(metrics.requestsCompleted >= 0);
    }
  });
});
