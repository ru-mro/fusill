# Protocol Parameters

Every tunable constant the protocol enforces, in one place. All values are
defined in `contracts/src/lib.rs` — this table is a reference, not a second
source of truth.

## Economic

| Parameter | Constant | Value | Meaning |
|-----------|----------|-------|---------|
| Minimum node stake | `MIN_STAKE_LAMPORTS` | `500_000_000` (0.5 SOL) | Collateral deposited at `register_node` |
| Protocol fee | `PROTOCOL_FEE_BPS` | `500` (5%) | Cut of each job's payment sent to the deployer authority |
| Claim compensation | `CLAIM_COMPENSATION_LAMPORTS` | `5_000` | Paid to each node that had claimed, when a job is cancelled |
| Minimum payment | (derived) | `CLAIM_COMPENSATION_LAMPORTS × min_nodes` | Floor enforced by `create_job` (`PaymentTooLow` otherwise) |

## Reputation

| Parameter | Constant | Value |
|-----------|----------|-------|
| Honest completion gain | `REPUTATION_GAIN_HONEST` | `+5` |
| Dishonest (out-of-consensus) penalty | `REPUTATION_PENALTY_DISHONEST` | `−10` |
| Absent (no commit/reveal) penalty | `REPUTATION_PENALTY_ABSENT` | `−20` |
| Starting reputation | — | `100` (set at registration) |
| Range | — | `0`–`100` (saturating) |

### Stake refund tiers (`withdraw_stake`)

| Reputation | Constant | Refund | Burned |
|------------|----------|--------|--------|
| ≥ 80 | `REP_FULL_REFUND` | 100% | 0% |
| 50–79 | `REP_PARTIAL_REFUND` | 50% | 50% |
| < 50 | — | 0% | 100% |

Burned stake is sent to the Solana incinerator
(`1nc1nerator11111111111111111111111111111111`) and permanently removed from
circulation.

## Timing

| Parameter | Constant | Value | Meaning |
|-----------|----------|-------|---------|
| Job expiry (min) | `JOB_EXPIRY_MIN_MINUTES` | `5` | Lower bound for `expiry_minutes` |
| Job expiry (max) | `JOB_EXPIRY_MAX_MINUTES` | `30` | Upper bound for `expiry_minutes` |
| Commit buffer | `COMMIT_BUFFER_SECONDS` | `120` | Added after `duration_seconds` for the commit deadline |
| Reveal deadline | `REVEAL_DEADLINE_SECONDS` | `120` | Window to reveal after RevealPhase begins |

## Job bounds (validated in `create_job`)

| Parameter | Range |
|-----------|-------|
| `duration_seconds` | 10 – 3600 |
| `min_nodes` | 1 – 10 |
| `expiry_minutes` | 5 – 30 |
| `target` length | ≤ 200 chars (`MAX_TARGET_LEN`) |
| `runner_config` length | ≤ 500 bytes (`MAX_RUNNER_CONFIG_LEN`) |

## Consensus

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Consensus center | median of revealed values | Robust to outliers/colluding minority |
| Latency tolerance | 20% relative (`center / 5`) | Band for `avgLatencyMs`-based runners |
| Error-rate tolerance | `max(20% relative, 500 bps)` | 500 bps (5 pp) floor absorbs low-rate noise |
| Latency-metric runners | `HttpFlood`, `TlsExhaustion`, `DnsFlood` | Judged on `avg_latency_ms` |
| Error-rate-metric runners | all others | Judged on `error_rate_bps` |

See [`consensus-trustless.md`](./consensus-trustless.md) for the full method.
