# @fusill/sdk

Client SDK for [Fusill](https://github.com/) — decentralized server resilience testing on Solana. Create and manage on-chain load-test jobs, run multi-vector campaigns, and read consensus-verified results (baseline vs. latency under load) — no Solana internals required.

## Install

```bash
npm install @fusill/sdk
```

Peer requirements: `@solana/web3.js` and `@coral-xyz/anchor` (installed automatically).

## Prerequisites

1. A Solana wallet with enough SOL to cover the job payment and transaction fees
2. The contract IDL file (`fusill-idl.json`), generated with `anchor build`
3. An ownership verification endpoint on the target server (see below)

## Usage

### Node.js (with a Keypair)

```js
import { FusillClient } from '@fusill/sdk'
import { Keypair } from '@solana/web3.js'

const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.WALLET_KEYPAIR))
)
const client = new FusillClient(
  keypair,
  'https://api.devnet.solana.com', // or mainnet-beta RPC URL
  './fusill-idl.json',
)

const { jobPubkey } = await client.createJob({
  target:          'https://your-server.com',
  runnerType:      'httpFlood',
  runnerConfig:    { concurrent_connections: 100 },
  durationSeconds: 30,
  minNodes:        3,
  paymentSol:      0.03,
})

const result = await client.waitForFinalization(jobPubkey)
```

### Browser (with a wallet adapter)

Pass an `AnchorProvider` built from the connected wallet and the IDL object — no Keypair needed; the wallet signs.

```js
import { FusillClient } from '@fusill/sdk'
import { AnchorProvider } from '@coral-xyz/anchor'
import IDL from './fusill-idl.json'

const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
const client   = new FusillClient(undefined, provider, IDL)
```

## Ownership verification

Before executing any attack, every node verifies that the job creator owns the target server.
Expose this endpoint on your server:

```
GET /.well-known/fusill-verify
→ { "owner": "YOUR_WALLET_PUBKEY" }
```

Example with Express:

```js
app.get('/.well-known/fusill-verify', (req, res) => {
  res.json({ owner: process.env.WALLET_PUBKEY });
});
```

If the endpoint is missing or the pubkey does not match, nodes reject the job.

---

## Method reference

### `createJob(opts)`

Creates a single-vector pentesting job and deposits payment in the contract.

```js
const { jobPubkey, tx } = await client.createJob({
  target:          'https://myapp.com',
  runnerType:      'httpFlood',
  runnerConfig:    { method: 'GET', concurrent_connections: 100 },
  durationSeconds: 60,
  minNodes:        3,
  expiryMinutes:   15,
  paymentSol:      0.09,
});
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | string | — | URL or IP:port of the server to test (max 200 chars) |
| `runnerType` | string | — | Attack type — see [runner types](#runner-types) |
| `runnerConfig` | object | — | Runner-specific parameters — see [runner types](#runner-types) |
| `durationSeconds` | number | — | Attack duration in seconds (10–3600) |
| `minNodes` | number | — | Nodes required to start (1–10) |
| `expiryMinutes` | number | `15` | Minutes before the job expires if not filled (5–30) |
| `paymentSol` | number | — | Total payment in SOL distributed to honest nodes |
| `scheduledJob` | boolean | `false` | If `true`, the job waits for `scheduleJob()` before executing (used internally by `createMultiVectorJob`) |

**Returns:** `{ jobPubkey: PublicKey, tx: string }`

---

### `cancelJob(jobPubkey)`

Cancels a job after it has expired. Returns the SOL to the creator, minus a small compensation (5000 lamports) for any node that already claimed the job.

```js
await client.cancelJob(jobPubkey);
```

**Requirements:**
- Job is in `open` or `filled` status
- `expires_at` has passed

---

### `getJob(jobPubkey)`

Returns the current state of a job.

```js
const job = await client.getJob(jobPubkey);
```

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `pubkey` | string | Job address |
| `target` | string | Target URL/IP |
| `runnerType` | string | Attack type |
| `runnerConfig` | object | Runner parameters |
| `durationSeconds` | number | Configured duration |
| `minNodes` | number | Required nodes |
| `nodesClaimed` | number | Nodes that have claimed |
| `paymentSol` | number | Total payment in SOL |
| `status` | string | Current status — see [job statuses](#job-statuses) |
| `createdAt` | Date | Creation timestamp |
| `expiresAt` | Date | Expiry timestamp |
| `scheduledJob` | boolean | Whether this is a scheduled (multi-vector) job |
| `scheduledAt` | number | Unix timestamp when nodes fire; `0` if not yet scheduled |

---

### `listJobs()`

Lists the caller's jobs sorted by creation date descending.

```js
const jobs = await client.listJobs();
for (const job of jobs) {
  console.log(`${job.pubkey.slice(0, 8)}... → ${job.status} — ${job.paymentSol} SOL`);
}
```

---

### `listAllJobs()`

Lists all jobs on the network sorted by payment descending.

```js
const jobs = await client.listAllJobs();
```

---

### `getJobResults(jobPubkey)`

Returns the revealed results for each node that participated, comparing baseline vs. under-attack behavior. Nodes that claimed but never revealed are skipped.

```js
const results = await client.getJobResults(jobPubkey);
```

**Each entry:**

| Field | Type | Description |
|-------|------|-------------|
| `node` | string | Node pubkey |
| `baselineLatencyMs` | number | Latency measured before the attack |
| `avgLatencyMs` | number | Average latency under attack |
| `degradation` | number \| null | `avgLatencyMs / baselineLatencyMs` (e.g. `7.9` = 7.9× slower); `null` if baseline was 0 |
| `errorRatePct` | number | Error rate as a percentage |
| `requestsCompleted` | number | Total requests completed |

---

### `onJobFinalized(jobPubkey, callback)`

Subscribes to the finalization event of a specific job.

```js
const unsubscribe = client.onJobFinalized(jobPubkey, (result) => {
  console.log(`Honest nodes: ${result.honestNodes}`);
  console.log(`Each node earned: ${result.paymentPerNodeSol} SOL`);
  console.log(`Protocol fee: ${result.protocolFeeSol} SOL`);
});

// Cancel subscription:
unsubscribe();
```

**Callback receives:**

| Field | Type | Description |
|-------|------|-------------|
| `honestNodes` | number | Nodes that passed consensus |
| `paymentPerNodeSol` | number | SOL earned by each honest node |
| `protocolFeeSol` | number | Protocol fee (5%) |

---

### `waitForFinalization(jobPubkey, timeoutMs?)`

Promise-based alternative to `onJobFinalized`. Default timeout: 10 minutes.

```js
const result = await client.waitForFinalization(jobPubkey, 20 * 60 * 1000);
```

---

## Multi-vector campaigns

A multi-vector campaign runs several attack types simultaneously against the same target, from independent nodes in different ASNs. Each vector is a separate on-chain job; all jobs are scheduled to fire at the same unix timestamp.

### `createMultiVectorJob(opts)`

Creates one scheduled job per vector.

```js
const jobPubkeys = await client.createMultiVectorJob({
  target:          'https://myapp.com',
  vectors: [
    { type: 'httpFlood',     config: { method: 'GET', concurrent_connections: 100 } },
    { type: 'slowloris',     config: { concurrent_connections: 500 } },
    { type: 'tlsExhaustion', config: { handshakes_per_second: 100, complete_handshake: false } },
  ],
  minNodes:        2,       // required per vector
  durationSeconds: 60,
  expiryMinutes:   15,
  paymentSol:      0.03,    // per job
});
// Returns PublicKey[] — one per vector, in order
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | string | — | URL or IP:port shared by all vectors |
| `vectors` | `{ type, config }[]` | — | List of attack vectors |
| `minNodes` | number | — | Nodes required per vector (1–10) |
| `durationSeconds` | number | — | Duration shared by all vectors (10–3600) |
| `expiryMinutes` | number | `15` | Expiry shared by all vectors (5–30) |
| `paymentSol` | number | — | Payment per job in SOL |

---

### `waitForAllFilled(jobPubkeys, timeoutMs?)`

Polls until every job in the campaign reaches `filled` status (all nodes have claimed). Default timeout: 120 seconds.

```js
await client.waitForAllFilled(jobPubkeys);
```

---

### `scheduleMultiVectorJob(jobPubkeys, runAt)`

Sets the coordinated execution timestamp on all filled jobs. Transitions each job from `filled` → `running`. Nodes will wait until `runAt` before firing.

```js
const runAt = Math.floor(Date.now() / 1000) + 30; // 30 s from now
await client.scheduleMultiVectorJob(jobPubkeys, runAt);
```

---

### `scheduleJob(jobPubkey, runAt)`

Single-job version of `scheduleMultiVectorJob`. Only the job creator can call this.

```js
await client.scheduleJob(jobPubkey, runAt);
```

---

### `cancelMultiVectorJob(jobPubkeys)`

Cancels all jobs in the campaign after expiry.

```js
await client.cancelMultiVectorJob(jobPubkeys);
```

---

### Full multi-vector example

```js
const client = new FusillClient(keypair, rpcUrl, idlPath);

// 1. Create the campaign
const jobPubkeys = await client.createMultiVectorJob({
  target:          'https://myapp.com',
  vectors: [
    { type: 'httpFlood', config: { method: 'GET', concurrent_connections: 100 } },
    { type: 'slowloris', config: { concurrent_connections: 500 } },
  ],
  minNodes:        2,
  durationSeconds: 60,
  expiryMinutes:   15,
  paymentSol:      0.03,
});

console.log(`Campaign created: ${jobPubkeys.length} vectors`);

// 2. Wait for all vectors to fill
try {
  await client.waitForAllFilled(jobPubkeys, 10 * 60 * 1000);
} catch {
  // Not enough nodes — cancel and recover SOL
  await client.cancelMultiVectorJob(jobPubkeys);
  console.log('Campaign cancelled — SOL recovered');
  process.exit(0);
}

// 3. Schedule coordinated execution 30 s from now
const runAt = Math.floor(Date.now() / 1000) + 30;
await client.scheduleMultiVectorJob(jobPubkeys, runAt);
console.log(`Campaign scheduled — all vectors fire at T=${runAt}`);

// 4. Collect results
for (const pk of jobPubkeys) {
  const result = await client.waitForFinalization(pk);
  console.log(`${pk.toString().slice(0, 8)}... — ${result.honestNodes} honest nodes, ${result.paymentPerNodeSol} SOL each`);
}
```

---

## Job statuses

| Status | Description |
|--------|-------------|
| `open` | Accepting node claims |
| `filled` | All nodes claimed (scheduled job only) — waiting for `scheduleJob` |
| `running` | Nodes executing the attack and committing hashes |
| `revealPhase` | Nodes revealing actual metrics |
| `pendingFinalization` | Consensus pending — any account can call `finalize` |
| `completed` | Finalized, payments distributed |
| `cancelled` | Cancelled by the creator |

---

## Runner types

| Runner | Key config fields | What it exhausts |
|--------|------------------|-----------------|
| `httpFlood` | `method`, `concurrent_connections` | CPU / DB |
| `slowloris` | `concurrent_connections`, `headers_interval_ms` | Connection pool |
| `http2RapidReset` | `connections`, `streams_per_connection` | HTTP/2 CPU |
| `http2Continuation` | `connections`, `frames_per_connection` | RAM (OOM) |
| `tlsExhaustion` | `handshakes_per_second`, `complete_handshake` | Crypto CPU |
| `websocketExhaustion` | `concurrent_connections`, `message_interval_ms` | Memory / FDs |
| `dnsFlood` | `dns_server_port`, `qps_per_node`, `randomize_subdomain` | DNS CPU |
| `rudy` | `concurrent_connections` | Thread-per-conn servers |
| `synFlood` *(CAP_NET_RAW)* | `target_port`, `pps_per_node` | Kernel conn table |
| `udpFlood` *(CAP_NET_RAW)* | `target_port`, `pps_per_node`, `packet_size` | Bandwidth |

## License

MIT
