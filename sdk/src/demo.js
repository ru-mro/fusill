// Demo script: creates a job on devnet and waits for finalization.
// Usage: docker compose --profile demo run --rm sdk-client

import { Keypair }     from '@solana/web3.js';
import { readFileSync } from 'fs';
import { FusillClient }  from './FusillClient.js';

const keypairPath  = process.env.USER_KEYPAIR_PATH ?? '/wallets/user.json';
const idlPath      = process.env.IDL_PATH           ?? '/shared/fusill-idl.json';
const rpcUrl       = process.env.SOLANA_RPC_URL      ?? 'https://api.devnet.solana.com';
const target       = process.env.TARGET_URL          ?? 'http://mock-target:3000';
const runnerType   = process.env.RUNNER_TYPE         ?? 'httpFlood';

const bytes  = JSON.parse(readFileSync(keypairPath, 'utf8'));
const userKp = Keypair.fromSecretKey(Uint8Array.from(bytes));

console.log(`User        : ${userKp.publicKey.toString()}`);
console.log(`Target      : ${target}`);
console.log(`Runner type : ${runnerType}`);
console.log(`RPC         : ${rpcUrl}`);

const client = new FusillClient(userKp, rpcUrl, idlPath);

const runnerConfigs = {
  httpFlood:         { method: 'GET', rps_per_node: 10, concurrent_connections: 10 },
  slowloris:         { concurrent_connections: 150, headers_interval_ms: 10000 },
  http2RapidReset:   { connections: 10, streams_per_connection: 100, reset_immediately: true },
  http2Continuation: { connections: 5, frames_per_connection: 1000 },
  tlsExhaustion:     { handshakes_per_second: 50, complete_handshake: false },
  websocketExhaustion: { concurrent_connections: 100, message_interval_ms: 0 },
  dnsFlood:          { dns_server_port: 53, query_type: 'A', randomize_subdomain: true },
  synFlood:          { target_port: 80, pps_per_node: 1000 },
  udpFlood:          { target_port: 0, pps_per_node: 1000, packet_size: 512 },
};

const { jobPubkey } = await client.createJob({
  target,
  runnerType,
  runnerConfig:    runnerConfigs[runnerType] ?? {},
  durationSeconds: 30,
  minNodes:        3,
  expiryMinutes:   15,
  paymentSol:      0.03,
});

console.log(`\nJob created : ${jobPubkey.toString()}`);
console.log('Waiting for finalization...\n');

const result = await client.waitForFinalization(jobPubkey);

console.log('Job finalized!');
console.log(`Honest nodes      : ${result.honestNodes}`);
console.log(`Payment per node  : ${result.paymentPerNodeSol} SOL`);
console.log(`Protocol fee      : ${result.protocolFeeSol} SOL`);
