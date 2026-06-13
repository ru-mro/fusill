# Threat Model & Security Guarantees

What each attack against the protocol is, and the mechanism that defends against
it. Each defense is detailed in its own document; this is the consolidated map.

## Adversaries & defenses

| # | Threat | Who | Defense | Reference |
|---|--------|-----|---------|-----------|
| 1 | **Lying about results** — a node reports fake metrics to get paid without doing the work | Malicious node | Commit-reveal + median consensus: results are hashed before reveal, then only values within tolerance of the median are paid | [consensus-trustless](./consensus-trustless.md) |
| 2 | **Result manipulation by a colluding majority** — a group reports an extreme value to drag the consensus center | Colluding nodes | The center is the **median**, not the mean — robust to outliers and to a minority of manipulators | [consensus-trustless](./consensus-trustless.md) |
| 3 | **Abandoning a job** — a node claims then disappears, freezing everyone's payment | Unreliable/malicious node | `force_advance` rescues the job past the deadline; the absent node is slashed −20 reputation | [job-lifecycle](./job-lifecycle.md) |
| 4 | **Attacking a third party** — pointing the network at a server the creator does not own | Malicious job creator | Off-chain ownership verification: each node refuses targets that don't publish the creator's pubkey | [ownership-verification](./ownership-verification.md) |
| 5 | **Sybil / spam nodes** — flooding the network with fake nodes to capture payouts | Sybil attacker | 0.5 SOL stake per node; dishonest behavior burns it on withdrawal | [staking-and-reputation](./staking-and-reputation.md) |
| 6 | **Payout redirection** — a finalizer tries to send a node's payment to an arbitrary wallet | Malicious finalizer | `finalize_job` binds each payout wallet and NodeAccount to the pubkey inside the canonical result PDA; mismatches abort | this doc, §Payout integrity |
| 7 | **Forged result accounts** — feeding fake `ResultAccount`s into finalization | Malicious finalizer | Each result account must be program-owned and match the PDA `["result", job, node]`; only `submit_commitment` can create it | this doc, §Payout integrity |
| 8 | **Griefing the creator's funds** — locking deposited payment so it can't be recovered | Any party | Unfilled jobs are refundable via `cancel_job` after expiry; filled jobs always reach a terminal state | [job-lifecycle](./job-lifecycle.md) |

## Core guarantees

### Result integrity (commit-reveal)

A node commits `keccak256(metrics ‖ nonce)` before anyone reveals, so it cannot
adapt its reported numbers after seeing others'. At reveal, the contract
recomputes the hash and rejects any mismatch (`CommitmentMismatch`). Honesty is
then judged by proximity to the **median** of revealed values, within a
per-metric tolerance band.

### Payout integrity

`finalize_job` accepts the result/wallet/node accounts as `remaining_accounts`,
which an untrusted caller supplies. To prevent abuse, for every entry the
contract enforces:

- the `ResultAccount` is **program-owned** and revealed, and its address equals
  the PDA derived from `["result", job, node]` — so `result.node` is authentic
  and could only have come from that node's own `submit_commitment`;
- the wallet being paid equals `result.node`;
- the `NodeAccount` being credited equals the PDA `["node", node]`.

Any deviation throws `InvalidAccount` and the whole transaction reverts. This is
what lets *anyone* safely call `finalize_job` without being able to steal or
misroute funds.

### Economic finality

Every job ends in exactly one terminal state with all lamports accounted for:

- **Completed:** `payment = protocol_fee (5%) + Σ honest payouts + rounding
  remainder`. The remainder and the no-honest-nodes fallback both go to the
  protocol authority — nothing is ever stranded in the job account.
- **Cancelled:** creator refunded `payment − claim_compensation × claimed_nodes`;
  each node that had claimed receives the small compensation.

## Known limitations

- **Off-chain ownership enforcement.** The contract cannot perform the HTTP
  verification fetch; the guarantee relies on honest, staked nodes. A network of
  fully-colluding nodes could ignore verification — the stake/reputation system
  is the economic deterrent, not a cryptographic impossibility.
- **Liveness depends on `force_advance` being called.** It is permissionless
  (anyone, including the creator or remaining nodes, can call it), but it is not
  automatic — a job past a deadline waits until someone submits the transaction.
- **Reputation is per-node-account.** A slashed node can register a fresh
  NodeAccount with a new wallet and a new 0.5 SOL stake; the stake cost, not
  identity, is the Sybil barrier.
