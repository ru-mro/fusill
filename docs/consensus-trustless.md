# Trustless Consensus — How Fusill Verifies Results Without Trusting Anyone

## The Problem

In a decentralized pentesting network, the nodes that execute the attack
report their own results. How does the contract know they are not lying?

Fusill uses a **commit-reveal scheme** with **metric consensus**:
nodes make a cryptographic commitment to their results before revealing them,
and the contract only accepts results that converge on the same server metric.

---

## The Commit-Reveal Flow

```
Phase 1 — COMMIT
  node computes: commitment = keccak256(avgLatencyMs || errorRateBps || requestsCompleted || baselineLatencyMs || nonce)
                 (each field little-endian)
  node sends:    commitment (32 bytes) to the contract
  contract:      stores the hash, does not see the actual values

Phase 2 — REVEAL
  node sends:    (avgLatencyMs, errorRateBps, requestsCompleted, baselineLatencyMs, nonce)
  contract:      recomputes keccak256 and verifies == commitment
  if match:      accepts the values; if not → CommitmentMismatch

Phase 3 — FINALIZE
  contract:      selects the consensus metric based on runner type
  computes:      center = median of the metric across all nodes
  classifies:    |node_value - center| <= tolerance → honest, gets paid
                 |node_value - center| >  tolerance → dishonest, loses reputation
```

**Scheme guarantees:**
- A node cannot see other nodes' values before committing (hashes are opaque).
- It cannot change its values after committing (the hash locks them in).
- The nonce prevents copying another node's commitment that reports the same values.

---

## Consensus Metric Per Runner

The key design insight is distinguishing **server properties** from **node properties**:

| Type | Server property | Node property |
|------|----------------|---------------|
| Response time | Same for all (same server) | — |
| Rejection/reset rate | Same for all (same server) | — |
| Requests completed | — | Varies by node hardware/network |

`requestsCompleted` is always a node property — it is never used for consensus.
The contract stores it for auditing but does not compare it.

---

## Runner by Runner

### 1. HTTP Flood (`HttpFlood`) — Metric: `avgLatencyMs`

**What it does:** opens persistent TCP connections (keep-alive) and sends HTTP requests as fast as possible.

**How it measures:**
```js
// http-flood.js
const start = Date.now();
mod.request(opts, (res) => {
  latencySum += Date.now() - start;
  latencyCount++;
});
avgLatencyMs = Math.round(latencySum / latencyCount);
```
Measures time from `req.send()` to the first byte of the response.

**Why avgLatencyMs:** response latency is a property of the server under load.
If the server is saturated, all nodes see high latencies simultaneously.
A node reporting 50ms when others report 800ms is lying or has preferential connectivity.

**Tolerance:** `avg / 5` (20% relative).
With high latencies (>1000ms) network jitter is proportionally small;
with low latencies (<50ms) the absolute margin is tight but the attack is probably not working.

---

### 2. TLS Exhaustion (`TlsExhaustion`) — Metric: `avgLatencyMs`

**What it does:** initiates TLS handshakes without completing the HTTP layer. The server spends CPU on cryptographic negotiation (DH key exchange, certificates) without receiving any request.

**How it measures:**
```js
// tls-exhaustion.js
const start = Date.now();
tls.connect({ host, port, rejectUnauthorized: false }, () => {
  latencySum += Date.now() - start;  // RTT of the complete TLS handshake
  latencyCount++;
});
```
Measures TLS handshake RTT (ClientHello → Finished).

**Why avgLatencyMs:** handshake time reflects the server's CPU load.
A server saturated with handshakes takes longer to respond to new ones
(cryptographic negotiation is computationally expensive). It is an indicator
consistently observable by all nodes.

---

### 3. DNS Flood (`DnsFlood`) — Metric: `avgLatencyMs`

**What it does:** sends massive UDP DNS queries to the target server (or resolver),
optionally with random subdomains to invalidate caches.

**How it measures:**
```js
// dns-flood.js — correlation by transaction ID
const pending = new Map();  // id → sendTimestamp

socket.on('message', (msg) => {
  const id    = msg.readUInt16BE(0);  // first 2 bytes are the transaction ID
  const sentAt = pending.get(id);
  if (sentAt !== undefined) {
    latencySum += Date.now() - sentAt;  // UDP RTT = send → response
    latencyCount++;
    pending.delete(id);
  }
});
```
Correlates DNS responses with queries using the DNS protocol transaction ID (RFC 1035, section 4.1.1).
Waits an extra 200ms at the end to capture in-flight responses.

**Why avgLatencyMs:** the response time of a resolver under flood is the direct
stress metric. If the server is saturated, all queries take longer.
It is the only measurable metric in UDP: there are no "connection errors" in the strict sense,
only timeouts (queries without a response that simply never pass through the `on('message')` listener).

---

### 4. Slowloris (`Slowloris`) — Metric: `errorRateBps`

**What it does:** opens TCP connections and sends an incomplete HTTP request (missing the final `\r\n\r\n`),
then drips fake headers every N seconds to keep them alive indefinitely.
The server cannot release the socket because the request is "in progress".

**How it measures:**
```js
// slowloris.js
opened++;  // connection established (TCP handshake succeeded)
// ...
sock.on('error', () => closed++);
sock.on('close', () => closed++);

errorRateBps = Math.round((closed / opened) * 10000);
```
`closed/opened` = fraction of connections the server actively terminated.
If the server is exhausted, it closes connections. If it holds up, it keeps them open.

**Why errorRateBps (and not avgLatencyMs):** Slowloris has no concept of a "response"
(the request never completes). What the server does under pressure is close connections —
that is exactly what `errorRateBps` measures. A node reporting 10% closures
when all others see 80% probably doesn't have enough active connections.

---

### 5. HTTP/2 Rapid Reset (`Http2RapidReset`) — Metric: `errorRateBps`

**What it does:** opens HTTP/2 streams, optionally resetting them immediately with RST_STREAM.
Exploits CVE-2023-44487 — the server processes the stream before receiving the RST,
causing massive work amplification on the server.

**How it measures:**
```js
// http2-rapid-reset.js
totalStreams++;
const req = session.request({ ':method': 'GET', ':path': '/' });
if (reset_immediately) req.rstStream(8);  // CANCEL
req.on('error', () => errors++);

errorRateBps = Math.round((errors / totalStreams) * 10000);
```
`errors/totalStreams` = fraction of streams the server actively rejected
(GOAWAY, connection reset, etc.). When the server is saturated, it rejects more streams.

**Why errorRateBps:** the saturation indicator in HTTP/2 is the server sending
GOAWAY or closing the connection. The latency of streams that reset immediately
is zero (they don't wait for a response), so `avgLatencyMs` doesn't make sense here.

---

### 6. HTTP/2 Continuation Flood (`Http2Continuation`) — Metric: `errorRateBps`

**What it does:** sends HEADERS frames without `END_HEADERS` followed by indefinite CONTINUATION
frames (CVE-2024-27316). The server accumulates the header block in RAM
without being able to process the request, causing OOM.

**How it measures:**
```js
// http2-continuation.js
// totalFrames = CONTINUATION frames sent successfully
// connErrors  = connections that failed

errorRateBps = Math.round((connErrors / connections) * 10000);
```
`connErrors/connections` = fraction of connections the server rejected or closed
before completing the frame flood. A server that keeps accepting frames is vulnerable.

**Why errorRateBps:** there is no server response in this attack either (the request
never completes). The saturation indicator is whether the server closes the connection.

---

### 7. WebSocket Exhaustion (`WebsocketExhaustion`) — Metric: `errorRateBps`

**What it does:** establishes WebSocket connections (HTTP 101 upgrade) and keeps them open
without processing data, exhausting file descriptors and server memory.

**How it measures:**
```js
// websocket-exhaustion.js
req.on('upgrade', (_res, socket) => { opened++; });
req.on('error',    ()            => { errors++; });
req.on('response', ()            => { errors++; }); // non-101 response

errorRateBps = Math.round((errors / total) * 10000);
```
`errors/total` = fraction of upgrade attempts that failed.
A server under pressure rejects new WebSocket connections (responds with 503 or closes TCP).

**Why errorRateBps:** the success metric is whether the server accepts the upgrade.
There is no significant latency once the connection is established — connections
are deliberately kept alive. The observable and comparable metric across nodes
is the server's rejection rate.

---

### 8. SYN Flood (`SynFlood`) — No consensus metric (not implemented)

**What it does:** would send TCP SYN packets without completing the three-way handshake,
filling the target kernel's SYN backlog. Requires raw sockets (`CAP_NET_RAW`).

**Status:** throws `CAP_NET_RAW not available`. Does not participate in consensus jobs.
If implemented in the future, the natural metric would be `errorRateBps`
(fraction of SYNs without ACK, measurable by combining raw sockets with pcap).

---

### 9. UDP Flood (`UdpFlood`) — No consensus metric (not implemented)

**What it does:** would send UDP packets at high speed with source IP spoofing,
amplifying the required bandwidth. Requires raw sockets.

**Status:** throws `CAP_NET_RAW not available`. Does not participate in consensus jobs.
If implemented in the future, the natural metric would be `avgLatencyMs`
(similar to DnsFlood — UDP packets have RTT if the server responds with ICMP unreachable).

---

## Tolerance Formula

The contract computes tolerance in `consensus_tolerance()`:

```
avgLatencyMs  → tolerance = center / 5          (20% relative)
errorRateBps  → tolerance = max(center / 5, 500) (20% relative, minimum 500 bps = 5pp)

(center = median of the revealed values)
```

**Why the 500 floor in errorRateBps:**

If the server barely rejects connections (avg = 200 bps = 2%), a 20% tolerance
would be 40 bps. An honest node measuring 240 bps (normal network variation) would fail
consensus unfairly. The 500 bps floor guarantees ±5 percentage points of margin,
which is reasonable network noise even when the error rate is low.

With high values (avg > 2500 bps), the 20% relative dominates and the floor does not apply.

**Why there is no floor in avgLatencyMs:**

Latency has high correlation across nodes if they measure the same server.
The 20% relative is sufficient — with 100ms median latency, ±20ms is generous;
with 2000ms (saturated server), ±400ms is too.

---

## Payment Distribution

```
Total payment = 100%
  5%  → deployer (protocol fee)
  95% → split among honest nodes only

Dishonest node:
  - Gets no payment
  - Loses 10 reputation points
  - Its share is distributed to honest nodes (not burned)

If ALL nodes are dishonest:
  - The 95% goes to the deployer as fallback
  - No node gets paid

Honest node:
  - Gets 95% / N_honest
  - Gains 5 reputation points
  - jobs_completed++
```

---

## What Cannot Be Faked

| Fraud attempt | Why it fails |
|---------------|-------------|
| Reveal metrics different from commitment | `keccak256(new_values) ≠ commitment` → `CommitmentMismatch` |
| Copy another node's commitment | Different `nonce` makes the hash distinct |
| Report low latency when server is saturated | Diverges from median → exceeds tolerance → gets no payment |
| Report 0% error rate when server closes connections | Diverges from median → exceeds tolerance → gets no payment |
| Report 100% error rate to exaggerate the attack | Diverges from median (honest nodes report < 100%) → gets no payment |
| Not revealing after committing | `force_advance` advances the phase; node loses 20 reputation points |
