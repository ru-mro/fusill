// Minimal HTTP server for the Docker demo flow.
// Responds to the verify endpoint with the user's pubkey
// and accepts any request (load test).

import { createServer } from 'http';
import { readFileSync }  from 'fs';
import { Keypair }       from '@solana/web3.js';

const keypairPath = process.env.USER_KEYPAIR_PATH ?? '/wallets/user.json';
const bytes       = JSON.parse(readFileSync(keypairPath, 'utf8'));
const owner       = Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toString();

let reqCount = 0;
let lastLogTime = Date.now();

createServer((req, res) => {
  const now = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

  if (req.url === '/.well-known/fusill-verify') {
    console.log(`[${now}] VERIFY  ${req.socket.remoteAddress}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ owner }));
    return;
  }

  reqCount++;
  const elapsed = Date.now() - lastLogTime;

  // Log each individual request + a throughput summary every 5s
  console.log(`[${now}] ${req.method.padEnd(4)} ${req.url}  — total: ${reqCount} reqs`);

  if (elapsed >= 5000) {
    const rps = Math.round((reqCount / (elapsed / 1000)));
    console.log(`[${now}] ── throughput: ~${rps} req/s ──`);
    reqCount = 0;
    lastLogTime = Date.now();
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(3000, () => {
  console.log(`mock-target corriendo en :3000  owner=${owner}`);
});
