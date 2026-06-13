# Multi-Vector Campaigns

A multi-vector campaign fires several different attack types at the same target
**simultaneously**, from independent nodes. This document covers the protocol
mechanism that makes the coordination possible; the client API to drive it lives
in the [SDK README](../sdk/README.md). The underlying state machine is in
[`job-lifecycle.md`](./job-lifecycle.md).

## Why coordinate vectors

Real-world DDoS events are rarely a single technique — they combine vectors to
exhaust *different* resources at once: an HTTP flood saturates CPU/DB while a
slowloris pins the connection pool and a TLS-exhaustion attack burns crypto CPU.
A defense that holds against any one of them in isolation may still collapse when
all three land together.

To test that honestly, the vectors must hit the target **within the same window**
— not one after another. A campaign is the protocol's way of guaranteeing that
several independent jobs, claimed by different nodes, all fire at one agreed
timestamp.

## The mechanism

A campaign is **not** a special on-chain object. It is N ordinary jobs, each with
`scheduled_job = true`, tied together by a shared execution timestamp. The
`scheduled_job` flag changes one thing in the lifecycle: when all nodes have
claimed a job, it does **not** start immediately.

```
Per vector (one job each):

  create_job(scheduled_job = true)
        │
        ▼
      Open ──── all nodes claim ────► Filled        ← waits here, does NOT run
        │                              │
        │                  schedule_job(run_at)      ← creator sets shared timestamp
        │                              ▼
        │                           Running          ← scheduled_at = run_at
        │                              │
        │            nodes poll, see Running, then SLEEP until run_at
        │                              ▼
        └──────────── all vectors fire at run_at ────────────►
```

Step by step:

1. **Create** one scheduled job per vector (`createMultiVectorJob` builds them
   with per-job timestamps so the PDAs are unique even within the same second).
2. **Fill** — nodes claim each job. Because `scheduled_job` is true, a fully
   claimed job lands in **Filled** instead of Running (see `claim_job` in the
   contract) and waits.
3. **Schedule** — once every vector is Filled, the creator calls
   `schedule_job(run_at)` on each. This is the only caller-gated step: the
   contract requires the caller to be the job creator and `run_at > now`. It sets
   `scheduled_at = run_at`, moves the job to **Running**, and starts the commit
   deadline from `run_at` (not from now) so nodes have the full execution window.
4. **Fire** — nodes that claimed the job poll for the Running status, read
   `scheduled_at`, and sleep until that timestamp before launching the attack.
   All vectors therefore start within milliseconds of each other.

## Why a single `scheduled_at` gives simultaneity

The coordination point is one shared unix timestamp written on-chain. Every node,
regardless of which vector or which physical machine it runs on, reads the same
`scheduled_at` and waits for it. No node has to trust another's clock beyond
Solana's — they all anchor to the same value. The result is a coordinated barrage
from nodes in different networks/ASNs, which is what makes the test resemble a
real distributed attack rather than a single-source burst.

## Independence & cancellation

Because each vector is a standalone job:

- **Funding and consensus are per-vector.** Each job has its own payment, its own
  `min_nodes`, and is finalized independently — one vector failing consensus does
  not void the others.
- **Cancellation is per-vector.** If the campaign does not fully fill before
  expiry, each job can be cancelled to recover its deposit
  (`cancelMultiVectorJob` loops over them). A campaign that never reaches the
  all-Filled state simply never gets scheduled, and the SOL is recoverable.

## Relation to the contract

The only contract-level primitives involved are the `scheduled_job` flag on
`create_job` and the `schedule_job` instruction — there is no campaign account.
Everything above the single-job level (grouping vectors, waiting for all to fill,
scheduling them together) is **client-side orchestration** in the SDK. This keeps
the on-chain surface minimal while still guaranteeing on-chain-anchored
simultaneity. See [`protocol-reference.md`](./protocol-reference.md) for the
`schedule_job` signature and the `JobScheduled` event.
