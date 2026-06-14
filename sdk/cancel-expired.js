// Cancels every expired job (status Open or Filled) owned by the configured wallet
// and refunds the SOL. Only the job owner can cancel, and only after expires_at.
//
// Usage (from the sdk/ directory):
//   USER_KEYPAIR_PATH=../wallets/deployer.json node cancel-expired.js
//   node cancel-expired.js --dry-run        # list what would be cancelled, do nothing
//
// Env (all optional, with defaults):
//   USER_KEYPAIR_PATH  path to the owner keypair json   (default ../wallets/deployer.json)
//   SOLANA_RPC_URL     rpc endpoint                      (default https://api.devnet.solana.com)
//   IDL_PATH           anchor idl json                   (default ../shared/fusill-idl.json)

import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { FusillClient } from './src/FusillClient.js';

const KEYPAIR_PATH = process.env.USER_KEYPAIR_PATH || '../wallets/deployer.json';
const RPC_URL      = process.env.SOLANA_RPC_URL     || 'https://api.devnet.solana.com';
const IDL_PATH     = process.env.IDL_PATH           || '../shared/fusill-idl.json';
const DRY_RUN      = process.argv.includes('--dry-run');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))),
  );
  const client = new FusillClient(keypair, RPC_URL, IDL_PATH);
  console.log(`Owner: ${keypair.publicKey.toString()}`);

  const now  = Date.now();
  const jobs = await client.listJobs(); // already filtered to this wallet's jobs

  const expired = jobs.filter(
    j => (j.status === 'open' || j.status === 'filled') && j.expiresAt.getTime() <= now,
  );

  if (expired.length === 0) {
    console.log('No hay jobs expirados (open/filled) para cancelar.');
    return;
  }

  console.log(`Encontrados ${expired.length} jobs expirados:`);
  for (const j of expired) {
    console.log(`  ${j.pubkey}  [${j.status}]  ${j.runnerType}  exp ${j.expiresAt.toISOString()}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no se canceló nada.');
    return;
  }

  let ok = 0, fail = 0;
  for (const j of expired) {
    try {
      const sig = await client.cancelJob(j.pubkey);
      console.log(`✓ cancelado ${j.pubkey}  (${sig.slice(0, 16)}…)`);
      ok++;
    } catch (err) {
      console.error(`✗ falló ${j.pubkey}: ${err.message}`);
      fail++;
    }
    await sleep(1500); // espaciar las llamadas para no gatillar 429 en el RPC público
  }

  console.log(`\nListo. Cancelados: ${ok}, fallidos: ${fail}.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
