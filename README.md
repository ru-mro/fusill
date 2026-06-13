# Fusill

**Decentralized DDoS pentesting on Solana.** Development teams can test the
resilience of their own infrastructure against real, distributed attacks — with
verifiable, tamper-proof results recorded on-chain.

> ⚠️ Fusill is a pentesting tool. Its use is restricted to your own
> infrastructure or to targets with the owner's explicit authorization. Every
> node independently verifies target ownership before sending any traffic — see
> [Target ownership verification](./docs/ownership-verification.md). Unauthorized
> use is illegal; the authors accept no liability for misuse — read the full
> [legal notice & acceptable use](./DISCLAIMER.md).

Program (devnet): `G6xojg6mCoin9HnQ1Nv1sXJyLTgjrNpY7M2CioW1Dy2c`

## Why decentralized

A tool running from a single machine has a single IP — any firewall or CDN
blocks it in seconds. Fusill distributes each attack across many nodes in
different ASNs and geographic locations, reproducing the real threat model:
traffic from many origins that is far harder to mitigate.

On top of that, recording the test on-chain produces a **verifiable, tamper-proof
result**: who ordered the test, how many nodes took part, and what they reported
— with no trusted intermediary.

## How it works

```
1. A client creates a job on-chain: target, runner type + config, duration,
   required nodes, and SOL payment.
2. Registered nodes see the job and claim it.
3. When the node quota fills, the contract emits JobReady with the attack params.
4. Each node verifies the client owns the target, then all nodes run the attack
   simultaneously from their own IPs.
5. Each node commits keccak256(metrics ‖ nonce) — results stay hidden.
6. Once everyone has committed, each node reveals its real metrics and nonce;
   the contract checks the hash matches.
7. The contract computes consensus (median of the metric, per-metric tolerance)
   and flags the honest nodes.
8. Payment is distributed: 5% protocol fee, 95% split among the honest nodes.
```

The full state machine is in [`docs/job-lifecycle.md`](./docs/job-lifecycle.md);
the result-verification scheme in
[`docs/consensus-trustless.md`](./docs/consensus-trustless.md).

## Supported attack runners

| Runner | Description | Exhausts |
|--------|-------------|----------|
| `httpFlood` | High-concurrency HTTP GET/POST | Server CPU / DB |
| `slowloris` | HTTP connections sending headers very slowly | Connection pool |
| `http2RapidReset` | CVE-2023-44487 — HTTP/2 streams reset immediately | Server CPU |
| `http2Continuation` | CVE-2024-27316 — CONTINUATION frames without END_HEADERS | Server RAM (OOM) |
| `tlsExhaustion` | TLS handshakes left incomplete | Crypto CPU |
| `websocketExhaustion` | WebSocket connections held open | Memory / file descriptors |
| `dnsFlood` | DNS queries with randomized subdomains | DNS server CPU |
| `rudy` | R-U-Dead-Yet — POST with a body dripped byte by byte | Connection pool (thread-per-conn) |
| `synFlood` *(needs CAP_NET_RAW)* | Raw TCP SYN packets | Kernel connection table |
| `udpFlood` *(needs CAP_NET_RAW)* | Raw UDP packets | Bandwidth |

Per-runner config fields are documented in the
[SDK README](./sdk/README.md#runner-types) and the design rationale in
[`docs/ddos-attack-types.md`](./docs/ddos-attack-types.md).

## Multi-vector campaigns

Real DDoS events combine vectors to exhaust different resources at once. A
**campaign** is a set of jobs — one per vector — all scheduled to fire at the
same on-chain timestamp, so the target is hit by everything simultaneously from
independent nodes.

```
Campaign: httpFlood + slowloris + tlsExhaustion

  node1 ── httpFlood     ──┐
  node2 ── httpFlood     ──┤
  node3 ── slowloris     ──┼──▶  target.com   (all fire at T=run_at)
  node4 ── tlsExhaustion ──┘
```

Driven by the SDK (`createMultiVectorJob → waitForAllFilled →
scheduleMultiVectorJob`). The coordination mechanism is explained in
[`docs/multi-vector-campaigns.md`](./docs/multi-vector-campaigns.md) and the API
in the [SDK README](./sdk/README.md#multi-vector-campaigns).

## Documentation

| Area | Document |
|------|----------|
| Job state machine & deadlines | [`docs/job-lifecycle.md`](./docs/job-lifecycle.md) |
| Trustless result consensus (commit-reveal) | [`docs/consensus-trustless.md`](./docs/consensus-trustless.md) |
| Multi-vector campaign coordination | [`docs/multi-vector-campaigns.md`](./docs/multi-vector-campaigns.md) |
| Target ownership verification | [`docs/ownership-verification.md`](./docs/ownership-verification.md) |
| Staking, reputation & payouts | [`docs/staking-and-reputation.md`](./docs/staking-and-reputation.md) |
| Threat model & security guarantees | [`docs/threat-model.md`](./docs/threat-model.md) |
| On-chain reference (accounts, instructions, events, errors) | [`docs/protocol-reference.md`](./docs/protocol-reference.md) |
| All protocol parameters | [`docs/parameters.md`](./docs/parameters.md) |
| Attack-type research | [`docs/ddos-attack-types.md`](./docs/ddos-attack-types.md) |
| Devnet deploy runbook | [`docs/DEPLOY.md`](./docs/DEPLOY.md) |
| Running a node (operators) | [`node-client/README.md`](./node-client/README.md) |
| Creating jobs (SDK) | [`sdk/README.md`](./sdk/README.md) |

## Quick start

```bash
# Deploy the contract to devnet
docker compose --profile deploy run --rm deployer

# Start 3 nodes
docker compose up node1 node2 node3

# Create a test job (HTTP flood, 30s, 3 nodes)
RUNNER_TYPE=httpFlood docker compose --profile demo run --rm sdk-client
```

Full walkthrough in [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Project structure

```
fusill/
├── contracts/      — Anchor program (Rust) — deployed on devnet
│   ├── src/lib.rs
│   └── tests/      — anchor-bankrun tests (no devnet needed)
├── node-client/    — Node software (Node.js); one runner file per attack type
├── sdk/            — Client library to create and monitor jobs
├── docs/           — Cross-cutting protocol documentation
├── shared/         — Generated IDL consumed by the SDK and node client
└── docker-compose.yml
```

## Stack

| Layer | Technology |
|-------|------------|
| Blockchain | Solana (devnet / mainnet) |
| Contract | Rust + Anchor |
| Node | Node.js (native modules: http, http2, tls, net, dgram) |
| Tests | anchor-bankrun, Mocha, Chai |

## Roadmap

**Next**

- **Job-relative stake** — a node must hold stake ≥ the job's payment to claim it.
- **Dynamic minimum payment** — `create_job` validates the payment covers real
  cost given attack type and duration.
- **On-chain capabilities** — nodes publish ASN / country / privileges at
  registration; the contract filters by capability when assigning jobs, making
  the geographic-distribution claim verifiable on-chain.

**Later**

- **Native token** — replace SOL with a native token to capture value in the
  ecosystem.
- **Governance-configurable fee** — staked nodes vote to adjust the fee and the
  per-second rate.
- **Automatic recommendation** — analyze the target (CDN? direct IP?) before job
  creation and suggest the most effective vector.
- **On-chain dashboard** — public history of verified tests, useful for audits
  and security certifications.

---

> The Cloudflare [DDoS Threat Report Q4 2025](https://blog.cloudflare.com/ddos-threat-report-2025-q4/)
> reports record growth in multi-vector and hyper-volumetric attacks —
> reinforcing why a distributed, verifiable pentesting tool matters for any team
> that needs to validate its DDoS defenses before an incident.
