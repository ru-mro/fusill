# Dev Deploy — Devnet

End-to-end walkthrough to deploy the contract to devnet and run a full job locally with 3 nodes.

## Prerequisites

- Docker running
- A local wallet (`~/.config/solana/id.json`) funded with ~5 SOL on devnet
- `solana` CLI installed locally

## Step 1 — Build images

```bash
docker compose build
```

## Step 2 — Generate wallets (node1, node2, node3, user)

```bash
chmod +x scripts/generate-wallets.sh
./scripts/generate-wallets.sh
# → prints the pubkeys and the exact airdrop commands
```

## Step 3 — Airdrop

Copy and run the commands printed by the previous step. Something like:

```bash
solana airdrop 2 <node1_pubkey> --url devnet
solana airdrop 2 <node2_pubkey> --url devnet
solana airdrop 2 <node3_pubkey> --url devnet
solana airdrop 1 <user_pubkey>  --url devnet
```

## Step 4 — Deploy the contract

Uses your local wallet as deployer and fee recipient (5% of each job).

```bash
docker compose --profile deploy run --rm deployer
# → compiles the contract, deploys to devnet, initializes Config, writes the IDL to ./shared/
```

## Step 5 — Start nodes + mock-target

```bash
docker compose up node1 node2 node3 mock-target
# → each node self-registers by depositing 0.5 SOL of stake
# → they stay listening for available jobs
```

## Step 6 — Create a job (in another terminal)

```bash
docker compose --profile demo run --rm sdk-client
# → creates a 30s job with 10 rps, minNodes=3, payment=0.03 SOL
# → waits for finalization and prints the result
```

## What to watch

- **node1/2/3 logs:** claim → commit → reveal → finalize
- **mock-target logs:** burst of simultaneous requests from the 3 nodes
- **sdk-client:** `Job finalized! Honest nodes: 3, Payment per node: X SOL`
