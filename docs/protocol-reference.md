# On-Chain Protocol Reference

Reference for the Fusill Anchor program — accounts, PDAs, instructions, events,
and errors. Source of truth: `contracts/src/lib.rs`. For the flow that ties these
together see [`job-lifecycle.md`](./job-lifecycle.md).

**Program ID:** `G6xojg6mCoin9HnQ1Nv1sXJyLTgjrNpY7M2CioW1Dy2c`

## Accounts & PDAs

| Account | PDA seeds | Purpose |
|---------|-----------|---------|
| `Config` | `["config"]` | Global config; stores the `authority` (deployer) that receives the protocol fee |
| `NodeAccount` | `["node", owner]` | A registered node: stake, reputation, jobs completed, active flag |
| `JobAccount` | `["job", creator, created_at_le]` | A load-test job and its full state |
| `ResultAccount` | `["result", job, node]` | One node's commitment and revealed metrics for a job |

`created_at_le` is the i64 creation timestamp as little-endian bytes — the same
value passed to `create_job`, which makes each job PDA unique per creator+second.

### Field summary

**NodeAccount:** `owner`, `stake`, `jobs_completed`, `reputation` (u8, 0–100),
`is_active`.

**JobAccount:** `owner`, `target` (≤200 chars), `runner_type`, `runner_config`
(≤500 bytes), `duration_seconds`, `min_nodes`, `nodes_claimed`,
`commits_submitted`, `reveals_submitted`, `payment`, `status`, `created_at`,
`expires_at`, `commit_deadline`, `reveal_deadline`, `ownership_verified`,
`claimed_nodes[10]`, `scheduled_job`, `scheduled_at`.

**ResultAccount:** `job`, `node`, `commitment` ([u8;32]), `committed_at`,
`revealed`, `avg_latency_ms`, `error_rate_bps`, `requests_completed`,
`baseline_latency_ms`, `revealed_at`.

## Instructions

| Instruction | Signer | Other accounts | Args | Effect |
|-------------|--------|----------------|------|--------|
| `initialize` | authority | `config` (init) | — | Creates `Config`, sets authority. One-time. |
| `register_node` | owner | `node_account` (init) | `stake_amount` | Deposits ≥ 0.5 SOL stake, reputation = 100 |
| `withdraw_stake` | owner | `node_account`, `incinerator` | — | Refunds stake by reputation tier; burns the rest |
| `create_job` | user | `job_account` (init) | `created_at`, `target`, `runner_type`, `runner_config`, `duration_seconds`, `min_nodes`, `expiry_minutes`, `payment_lamports`, `scheduled_job` | Deposits payment, status = Open |
| `claim_job` | node_owner | `node_account`, `job_account` | — | Registers node in job; last claim → Running or Filled |
| `schedule_job` | user (creator) | `job_account` | `run_at` | Filled → Running with coordinated `scheduled_at` |
| `submit_commitment` | node_owner | `job_account`, `result_account` (init) | `commitment` [u8;32] | Phase 1: stores hash; last commit → RevealPhase |
| `reveal_result` | node_owner | `job_account`, `result_account` | `avg_latency_ms`, `error_rate_bps`, `requests_completed`, `baseline_latency_ms`, `nonce` | Phase 2: verifies hash, stores metrics |
| `force_advance` | anyone | `job_account`, +absent `NodeAccount`s | — | Past a deadline: advances state, slashes absent nodes |
| `finalize_job` | anyone | `job_account`, `config`, `authority`, +`[results, wallets, nodes]` | — | Computes consensus, pays out, status = Completed |
| `cancel_job` | user (creator) | `job_account`, +claimed wallets | — | Expired Open/Filled job: refunds creator |

### `finalize_job` remaining_accounts layout

With `N = reveals_submitted`, in order:

```
[0   .. N)    ResultAccounts of nodes that revealed
[N   .. 2N)   Wallets of those nodes (payout destinations)
[2N  .. 3N)   NodeAccounts of those nodes (reputation update)
```

Each is validated against the canonical PDA before any lamports move (see
[threat-model](./threat-model.md) §Payout integrity).

## Enums

**RunnerType** (serialized index order — do not reorder): `HttpFlood`,
`Slowloris`, `Http2RapidReset`, `Http2Continuation`, `TlsExhaustion`,
`WebsocketExhaustion`, `DnsFlood`, `SynFlood`, `UdpFlood`, `Rudy`.

**JobStatus:** `Open`, `Filled`, `Running`, `RevealPhase`, `PendingFinalization`,
`Completed`, `Cancelled`.

## Events

| Event | Fields |
|-------|--------|
| `ProgramInitialized` | `authority` |
| `NodeRegistered` | `node`, `stake` |
| `StakeWithdrawn` | `node`, `refund`, `burned`, `reputation` |
| `JobCreated` | `job`, `owner`, `target`, `runner_type`, `payment`, `expires_at` |
| `JobReady` | `job`, `target`, `runner_type`, `runner_config`, `duration_seconds` |
| `JobScheduled` | `job`, `run_at` |
| `JobClaimed` | `job`, `node` |
| `CommitmentSubmitted` | `job`, `node` |
| `ResultRevealed` | `job`, `node`, `avg_latency_ms`, `baseline_latency_ms` |
| `JobForceAdvanced` | `job` |
| `JobFinalized` | `job`, `honest_nodes`, `payment_per_honest`, `protocol_fee` |
| `JobCancelled` | `job`, `owner`, `refund`, `nodes_compensated` |

## Errors

| Error | Meaning |
|-------|---------|
| `StakeTooLow` | Stake below 0.5 SOL |
| `TargetTooLong` | Target > 200 chars |
| `RunnerConfigTooLarge` | Config > 500 bytes |
| `InvalidParams` | Duration/min_nodes/expiry/run_at out of range |
| `PaymentTooLow` | Payment < claim compensation × min_nodes |
| `JobNotOpen` | Claim on a non-Open job |
| `JobNotFilled` | `schedule_job` on a non-Filled job |
| `JobNotCancellable` | Cancel on a job not in Open/Filled |
| `JobAlreadyFull` | Claim on a full job |
| `NodeNotActive` | Node not registered/active |
| `Unauthorized` | Caller is not the required signer/owner |
| `JobNotRunning` | Commit on a non-Running job |
| `JobNotInRevealPhase` | Reveal outside RevealPhase |
| `JobExpired` | Claim after expiry |
| `JobNotExpired` | Cancel before expiry |
| `JobNotFinalizable` | Finalize on a non-PendingFinalization job |
| `MissingAccounts` | Too few `remaining_accounts` for finalize |
| `CommitmentMismatch` | Revealed values don't match the commitment hash |
| `AlreadyRevealed` | Node already revealed |
| `ResultNotRevealed` | Result account not yet revealed |
| `CommitDeadlinePassed` | Commit after the commit deadline |
| `RevealDeadlinePassed` | Reveal after the reveal deadline |
| `DeadlineNotReached` | `force_advance` before the deadline |
| `NoParticipantsYet` | `force_advance` with zero commits/reveals |
| `InvalidJobStatus` | `force_advance` from an invalid state |
| `InvalidAccount` | Account not program-owned or PDA mismatch |
| `NodeNotInJob` | Node passed to `force_advance` never claimed the job |
