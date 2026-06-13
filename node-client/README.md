# Fusill Node Client

Guide for operators who want to run a node on the Fusill network, execute load
testing jobs, and earn payment for the work.

> The economic rules behind staking, reputation, and payouts are **protocol
> logic** — see [`docs/staking-and-reputation.md`](../docs/staking-and-reputation.md).
> How results are verified is in [`docs/consensus-trustless.md`](../docs/consensus-trustless.md).
> This README only covers running a node.

## What a node does

A node is a process that runs on your server and participates in the network. On
each loop it:

1. Detects available jobs on-chain
2. Verifies the job creator owns the target server (ownership verification)
3. Claims the job and waits for the node slot to fill
4. Measures a baseline, then runs the load-test runner
5. Reports metrics via commit-reveal so results can't be faked
6. Collects SOL when the job finalizes, if its results passed consensus

## Requirements

**Hardware (minimum):**
- 1 CPU
- 512 MB RAM
- Stable internet connection (bandwidth determines how hard you can push tests)

**Software:**
- Docker and Docker Compose (or Node.js 20+ to run without Docker)

**Funds:**
- A Solana wallet with at least **0.5 SOL** for the registration stake
- ~0.01 SOL extra to cover transaction fees

## Setup

### 1. Clone and enter the node client

```bash
git clone https://github.com/youruser/fusill
cd fusill/node-client
```

### 2. Generate the node keypair

Each node needs its own wallet:

```bash
solana-keygen new --outfile keypair.json
solana-keygen pubkey keypair.json   # your node's address
```

**Never commit or share `keypair.json`** — it holds your private key.

### 3. Configure the environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=<deployed program id>
NODE_KEYPAIR=[12,34,56,...]      # the byte array from keypair.json
STAKE_LAMPORTS=500000000         # 0.5 SOL
POLL_INTERVAL_SECONDS=5
```

`NODE_KEYPAIR` is the raw array of numbers inside `keypair.json` (`cat keypair.json`).

### 4. Fund the wallet

```bash
# devnet
solana airdrop 1 YOUR_PUBKEY --url devnet
# mainnet: transfer real SOL to the node wallet
```

### 5. Register on-chain

Before taking jobs the node must register and deposit the stake. Currently done
via the SDK or the Anchor CLI; a dedicated command is planned.

## Running the node

### With Docker (recommended)

The compose file ships three example node services — `node1`, `node2`, `node3`.
From the project root:

```bash
docker compose up node1            # foreground
docker compose up -d node1         # background
docker compose logs -f node1       # tail logs
```

### Without Docker

```bash
cd node-client
npm install
npm start
```

## What you'll see in the logs

```
Fusill node client starting...
Node: ABC123...XYZ
No jobs available — waiting...
[job A1B2C3D4...] Processing — runner: httpFlood, payment: 30000000 lamports
[job A1B2C3D4...] Claiming...
[job A1B2C3D4...] Waiting for job to be ready...
[job A1B2C3D4...] Baseline latency: 18ms
[job A1B2C3D4...] Running httpFlood for 60s
[job A1B2C3D4...] Test finished — latency: 142ms (baseline 18ms), errors: 0.00%
[job A1B2C3D4...] Committing hash...
[job A1B2C3D4...] Waiting for all nodes to commit...
[job A1B2C3D4...] Revealing results...
[job A1B2C3D4...] Finalizing job...
[job A1B2C3D4...] Job finalized — payment distributed
```

The runner is one of the built-in native runners (`httpFlood`, `slowloris`,
`tlsExhaustion`, `http2RapidReset`, `http2Continuation`, `dnsFlood`,
`websocketExhaustion`, `rudy`, `synFlood`, `udpFlood`) — chosen per job by the
creator. No external load-testing tool is required.

## Operating notes

- **Keep your node online for the whole job.** If you go offline after claiming,
  you miss the payout and take a reputation penalty; the remaining nodes recover
  the job via `force_advance`. See [staking & reputation](../docs/staking-and-reputation.md).
- **Higher-paying jobs are claimed first** by the reference client, so you earn
  more when creators offer more.
- **Run multiple nodes** if you like — each needs its own wallet and its own
  0.5 SOL stake.
- **Withdraw your stake** any time with `withdraw_stake`; the amount you recover
  depends on your reputation (full rules in the protocol doc).

## Security

- The private key never leaves your `.env` — the process reads it at startup and
  signs transactions locally.
- The node only attacks targets whose ownership the job creator has proven
  (ownership verification), so you can't be pointed at a third party.
- Your stake is the guarantee of honest behavior: false results earn no payment
  and cost reputation.

## FAQ

**Can I run more than one node?**
Yes — each needs its own wallet and its own 0.5 SOL stake.

**What happens if my server goes down during a job?**
You don't report results and lose 20 reputation points; the other nodes advance
the job with `force_advance`.

**When can I withdraw my stake?**
Any time via `withdraw_stake`. How much you recover depends on reputation — see
[`docs/staking-and-reputation.md`](../docs/staking-and-reputation.md).

**How much will I earn per job?**
Roughly `(payment_total * 0.95) / honest_nodes`. Fewer honest nodes means a
bigger slice for each — full formula in the protocol doc.
