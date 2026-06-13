# Job Lifecycle — State Machine

A job moves through a fixed set of states from creation to payout. Every
transition is driven by a specific on-chain instruction, gated by who may call
it and by time-based deadlines. This is the backbone that ties the rest of the
protocol together; the consensus math is in
[`consensus-trustless.md`](./consensus-trustless.md) and the economic rules in
[`staking-and-reputation.md`](./staking-and-reputation.md).

## States

```
                         claim_job (last node, immediate job)
   create_job            ┌─────────────────────────────────────────┐
  ──────────► Open ──────┤                                         ▼
                │        └── claim_job (last node, scheduled) ──► Filled
                │                                                  │
                │                                       schedule_job│ (creator)
                │                                                  ▼
                │                              ┌────────────► Running
                │ cancel_job                  │                   │
                │ (after expiry)              │      submit_commitment (all)
                ▼                             │   / force_advance (commit deadline)
            Cancelled                         │                   ▼
                ▲                             │              RevealPhase
                │ cancel_job                  │                   │
                └──── Filled ◄────────────────┘      reveal_result (all)
                                                 / force_advance (reveal deadline)
                                                                  ▼
                                                        PendingFinalization
                                                                  │
                                                       finalize_job│ (anyone)
                                                                  ▼
                                                             Completed
```

## Transitions

| From | Instruction | To | Who can call | Key guards |
|------|-------------|----|--------------|------------|
| — | `create_job` | **Open** | Job creator | Validates params, deposits `payment` |
| Open | `claim_job` | **Open** (until full) | Any active, registered node | `now < expires_at`, not already full |
| Open | `claim_job` (last node, normal job) | **Running** | Active node | Sets `commit_deadline` |
| Open | `claim_job` (last node, scheduled job) | **Filled** | Active node | Waits for the creator to schedule |
| Filled | `schedule_job` | **Running** | Job creator | `run_at > now`; sets `scheduled_at` + `commit_deadline` |
| Running | `submit_commitment` (all nodes) | **RevealPhase** | A node that claimed | `now < commit_deadline`; sets `reveal_deadline` |
| Running | `force_advance` | **RevealPhase** | Anyone | `now >= commit_deadline` and at least one commit |
| RevealPhase | `reveal_result` (all nodes) | **PendingFinalization** | The committing node | `now < reveal_deadline`; hash must match |
| RevealPhase | `force_advance` | **PendingFinalization** | Anyone | `now >= reveal_deadline` and at least one reveal |
| PendingFinalization | `finalize_job` | **Completed** | Anyone | Computes consensus, distributes payment |
| Open / Filled | `cancel_job` | **Cancelled** | Job creator | `now >= expires_at`; refunds creator |

## Deadlines

The protocol uses three time windows, all in `contracts/src/lib.rs`:

| Window | Value | Set when | Meaning |
|--------|-------|----------|---------|
| **Expiry** | `expiry_minutes` × 60 (5–30 min) | At `create_job` (`expires_at = created_at + …`) | Until this passes, nodes may claim; after it, an unfilled job can be cancelled |
| **Commit deadline** | run-start + `duration_seconds` + `COMMIT_BUFFER_SECONDS` (120 s) | When the job enters Running | Nodes must `submit_commitment` before it; after it, anyone can `force_advance` |
| **Reveal deadline** | entry-to-RevealPhase + `REVEAL_DEADLINE_SECONDS` (120 s) | When the job enters RevealPhase | Nodes must `reveal_result` before it; after it, anyone can `force_advance` |

"Run-start" is `now` for a normal job (it starts the moment the last node
claims) or `scheduled_at` for a scheduled job (so all nodes fire at the same
coordinated timestamp — the basis for multi-vector campaigns).

## Why `force_advance` exists

Without it, one node that claims a job and then disappears would freeze the job
forever in Running or RevealPhase, locking up everyone's payment. `force_advance`
lets *any* party push the job past a missed deadline once at least one node has
participated — the absent nodes are passed in `remaining_accounts` and take the
−20 reputation penalty. The job then proceeds and honest nodes still get paid.

## Terminal states

- **Completed** — consensus computed, 5% protocol fee taken, 95% split among
  honest nodes. Final.
- **Cancelled** — job expired without filling; creator refunded minus a small
  per-node claim compensation. Final.
