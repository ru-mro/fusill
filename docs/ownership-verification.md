# Target Ownership Verification

The single property that keeps Fusill a *pentesting* tool and not a
weapon-for-hire: **a load test can only run against a server whose operator
authorized it.** This document describes the trust model. The operator-side and
client-side setup snippets live in the node and SDK READMEs respectively.

## The problem

A job specifies a `target` (URL or IP) to stress. If nodes blindly attacked any
target a job named, anyone could pay the network to hammer a third party's
server. The protocol must guarantee the job creator controls the target before
any traffic is sent.

## The mechanism

Fusill uses a **proof-of-control challenge** over HTTP. Every node verifies it
independently, off-chain, immediately before claiming/executing — there is no
central authority to trust.

```
1. The target operator publishes, on the server under test:
     GET /.well-known/fusill-verify
     → 200 { "owner": "<creator-wallet-pubkey>" }

2. For a job with creator C targeting server S, each node independently:
     - fetches  https://S/.well-known/fusill-verify
     - checks   response.owner === C

3. If it matches → the node proceeds to claim and attack.
   If it is missing, errors, times out, or mismatches → the node refuses the job.
```

The check is implemented in `node-client/src/verify.js` (`verifyOwnership`),
with a 5-second timeout; any failure (non-200, bad JSON, network error, wrong
pubkey) returns `false` and the node skips the job.

## Why this is trustworthy

- **Binds attacker-intent to server-control.** Publishing the creator's pubkey at
  a well-known path on the target is something only someone with write access to
  that server can do. It proves the job creator and the server operator are the
  same party (or coordinating).
- **Independently checked by every node.** Verification is not a single on-chain
  flag set by one trusted party — each node re-runs it, so no node has to trust
  another's word, and the job creator can't forge it on-chain.
- **Fail-closed.** Anything other than an explicit, matching `200` response means
  no attack. The default is always "do not fire."

## Limitations & notes

- The on-chain `JobAccount` has an `ownership_verified` flag, but enforcement is
  done **off-chain by each node** at execution time — the contract does not (and
  cannot, without an oracle) perform the HTTP fetch. The security guarantee comes
  from honest nodes refusing unverified targets, backed by their stake.
- Verification is point-in-time. An operator who removes the endpoint after a job
  fills does not retroactively un-authorize an already-running test.
- For non-HTTP targets (e.g. raw `synFlood`/`udpFlood` against an IP), the
  verification endpoint must still be reachable over HTTP on that host.

## Relation to staking

Ownership verification is the *gate*; the *deterrent* is the stake. A node that
chose to attack an unverified target would be acting dishonestly and risks its
0.5 SOL stake and reputation — see [`threat-model.md`](./threat-model.md).
