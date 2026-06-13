# Staking, Reputation & Payment Distribution

Protocol-level rules enforced by the Fusill contract for nodes. This is the
authoritative reference — operator-facing setup lives in
[`node-client/README.md`](../node-client/README.md); the result-verification
mechanism is described in [`consensus-trustless.md`](./consensus-trustless.md).

All constants below are defined in `contracts/src/lib.rs`.

## Registration stake

To participate, a node registers on-chain and deposits a fixed stake:

| Constant | Value |
|----------|-------|
| `MIN_STAKE_LAMPORTS` | `500_000_000` (0.5 SOL) |

A freshly registered node starts at **reputation 100**. The stake is the
node's collateral for honest behavior — it is at risk if the node cheats or
abandons jobs.

## Reputation

Reputation is a `u8` (0–100) updated at job finalization. It never exceeds 100
(`saturating_add` capped at 100) and never underflows below 0
(`saturating_sub`).

| Event | Reputation change | Constant |
|-------|-------------------|----------|
| Completed a job within consensus (honest) | **+5** | `REPUTATION_GAIN_HONEST` |
| Revealed results outside consensus (dishonest) | **−10** | `REPUTATION_PENALTY_DISHONEST` |
| Claimed a job but failed to commit/reveal (absent) | **−20** | `REPUTATION_PENALTY_ABSENT` |

## Stake withdrawal

When a node leaves via `withdraw_stake`, the refund depends on reputation. The
non-refunded remainder is **burned** — sent to Solana's incinerator and
permanently removed from circulation (it is not redistributed).

| Reputation at exit | Stake refunded | Burned | Constant |
|--------------------|----------------|--------|----------|
| ≥ 80 | 100% | 0% | `REP_FULL_REFUND` |
| 50 – 79 | 50% | 50% | `REP_PARTIAL_REFUND` |
| < 50 | 0% | 100% | — |

## Payment distribution

When a job finalizes, the deposited payment is split as follows:

- **Protocol fee:** 5% of the total payment goes to the fee recipient.
- **Honest nodes:** the remaining 95% is split equally among the nodes whose
  results landed within consensus.

Per-honest-node payout:

```
payment_per_node = (payment_total * 0.95) / honest_node_count
```

Because the split is over *honest* nodes (not `min_nodes`), dishonest or absent
nodes forfeit their share and the honest participants each receive a larger
slice.

## Deadlines & `force_advance`

Each phase (commit, reveal, finalize) has an on-chain deadline. If a node in a
job stalls — goes offline mid-execution or never commits/reveals — any
participant can call `force_advance` once the deadline passes. This rescues the
job: it advances with the nodes that did participate, the absent node takes the
−20 reputation penalty, and the honest nodes still get paid.

## Job selection

Nodes are free to choose which jobs to claim. The reference client prioritizes
the **highest-paying** available job; low-payment jobs may go unclaimed while
the network is busy. This is client policy, not a contract rule — the contract
accepts a claim from any registered, sufficiently-staked node.
