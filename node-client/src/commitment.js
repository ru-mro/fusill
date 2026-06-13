import jsSha3 from 'js-sha3';
const { keccak256 } = jsSha3;
import { randomBytes } from 'crypto';

/**
 * Generates a random 8-byte nonce (u64).
 * The node stores it locally and uses it during the reveal phase.
 */
export function generateNonce() {
  return randomBytes(8).readBigUInt64LE(0);
}

/**
 * Computes the commitment (hash) of the results.
 * Must match exactly the keccak verified by the Rust contract in reveal_result:
 *   keccak(avg_latency_ms || error_rate_bps || requests_completed || baseline_latency_ms || nonce)
 * All values are serialized as little-endian, same as in Rust.
 */
export function buildCommitment(avgLatencyMs, errorRateBps, requestsCompleted, baselineLatencyMs, nonce) {
  const buffer = Buffer.alloc(28); // 4 + 4 + 8 + 4 + 8 bytes

  buffer.writeUInt32LE(avgLatencyMs, 0);
  buffer.writeUInt32LE(errorRateBps, 4);
  buffer.writeBigUInt64LE(BigInt(requestsCompleted), 8);
  buffer.writeUInt32LE(baselineLatencyMs, 16);
  buffer.writeBigUInt64LE(BigInt(nonce), 20);

  const hash = keccak256.arrayBuffer(buffer);
  return Buffer.from(hash);
}
