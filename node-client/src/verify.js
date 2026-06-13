import fetch from 'node-fetch';

const VERIFY_PATH = '/.well-known/fusill-verify';
const TIMEOUT_MS = 5000;

/**
 * Verifies that the job owner is also the owner of the target server.
 * The server must expose: GET /.well-known/fusill-verify
 * with response: { "owner": "WALLET_PUBKEY" }
 *
 * Returns true if ownership is valid, false otherwise.
 */
export async function verifyOwnership(targetUrl, jobOwnerPubkey) {
  try {
    const url = new URL(VERIFY_PATH, targetUrl).toString();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) return false;

    const body = await response.json();

    return body.owner === jobOwnerPubkey;
  } catch {
    return false;
  }
}
