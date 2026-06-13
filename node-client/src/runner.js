import { runHttpFlood }           from './runners/http-flood.js';
import { runSlowloris }           from './runners/slowloris.js';
import { runRudy }                from './runners/rudy.js';
import { runHttp2RapidReset }     from './runners/http2-rapid-reset.js';
import { runHttp2Continuation }   from './runners/http2-continuation.js';
import { runTlsExhaustion }       from './runners/tls-exhaustion.js';
import { runWebsocketExhaustion } from './runners/websocket-exhaustion.js';
import { runDnsFlood }            from './runners/dns-flood.js';
import { runSynFlood }            from './runners/syn-flood.js';
import { runUdpFlood }            from './runners/udp-flood.js';

const RUNNERS = {
  httpFlood           : runHttpFlood,
  slowloris           : runSlowloris,
  rudy                : runRudy,
  http2RapidReset     : runHttp2RapidReset,
  http2Continuation   : runHttp2Continuation,
  tlsExhaustion       : runTlsExhaustion,
  websocketExhaustion : runWebsocketExhaustion,
  dnsFlood            : runDnsFlood,
  synFlood            : runSynFlood,
  udpFlood            : runUdpFlood,
};

/**
 * Main dispatcher: runs the runner matching the given attack type.
 *
 * @param {string} target         — URL or IP:port of the target
 * @param {string} runnerType     — camelCase key (e.g. 'httpFlood')
 * @param {object} runnerConfig   — runner-specific parameters
 * @param {number} durationSecs   — duration in seconds
 * @returns {Promise<{ avgLatencyMs, errorRateBps, requestsCompleted }>}
 */
export async function runAttack(target, runnerType, runnerConfig, durationSecs) {
  const runner = RUNNERS[runnerType];
  if (!runner) throw new Error(`Unknown runner: ${runnerType}`);
  return runner(target, runnerConfig, durationSecs);
}
