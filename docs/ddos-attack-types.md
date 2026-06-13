# DDoS Attack Types — Technical Report for Fusill

> **Context:** This document investigates the most effective DDoS attacks today with the goal of designing Fusill's runners — a decentralized pentesting tool that lets teams test the resilience of their own infrastructure.

---

## Index

1. [General Taxonomy](#1-general-taxonomy)
2. [Layer 3/4 Attacks (Volumetric)](#2-layer-34-attacks-volumetric)
3. [Layer 7 Attacks (Application)](#3-layer-7-attacks-application)
4. [Amplification/Reflection Attacks](#4-amplificationreflection-attacks)
5. [Modern Attacks (2023–2025)](#5-modern-attacks-20232025)
6. [Applicability in Fusill](#6-applicability-in-fusill)
7. [Runner Design and On-Chain Inputs](#7-runner-design-and-on-chain-inputs)
8. [Recommended Prioritization](#8-recommended-prioritization)

---

## 1. General Taxonomy

DDoS attacks are classified by the OSI layer they target and the exhaustion mechanism:

| Type | OSI Layer | Exhaustion target | Example |
|------|-----------|------------------|---------|
| Volumetric | 3 / 4 | Bandwidth | UDP Flood |
| Protocol | 3 / 4 | Network / firewall resources | SYN Flood |
| Application | 7 | Server CPU / memory | HTTP Flood |
| Amplification | 3 / 4 | Bandwidth (amplified) | DNS Amplification |
| Slowloris / Slow | 7 | Concurrent connections | Slowloris |

---

## 2. Layer 3/4 Attacks (Volumetric)

### 2.1 UDP Flood

**Description:** Massive sending of UDP packets to random ports. The server
attempts to process each packet, check whether an application is listening on
that port, and reply with ICMP "Port Unreachable". Exhausts bandwidth and
network CPU.

**Effectiveness:** Very high for saturating pipes. Still one of the most used vectors at scale.

**Typical volume:** 100 Gbps – 1+ Tbps in real attacks (Mirai botnet).

**Required inputs:**
- `target_ip` / `target_host`
- `target_port` (or `0` for random port)
- `duration_seconds`
- `pps` (packets per second) or `bandwidth_mbps`
- `packet_size` (bytes, default 512–1400)

---

### 2.2 ICMP Flood (Ping Flood)

**Description:** Massive sending of ICMP Echo Request packets. Similar impact to UDP flood. Easy to filter with modern firewalls, so effectiveness has dropped against enterprise infrastructure.

**Effectiveness:** Medium-low against modern infrastructure. Useful for testing basic firewalls.

**Required inputs:**
- `target_ip`
- `duration_seconds`
- `pps` or `bandwidth_mbps`

---

### 2.3 SYN Flood

**Description:** Massive sending of TCP SYN packets with spoofed source IPs. The server responds with SYN-ACK and maintains "half-open" connections until the timeout expires. Exhausts the kernel's connection table (backlog).

**Effectiveness:** High against servers without SYN Cookies enabled. Very common in real attacks.

**Typical volume:** ~1M pps is enough to saturate a typical server.

**Required inputs:**
- `target_ip`
- `target_port`
- `duration_seconds`
- `pps`
- `spoof_source_ip` (boolean — requires network privileges)

> **Implementation note:** IP spoofing requires raw sockets (root/CAP_NET_RAW privileges). In containerized runners this is configurable.

---

### 2.4 TCP ACK / RST Flood

**Description:** Massive sending of TCP packets with ACK or RST flags. The server must process each packet even if it doesn't correspond to any active connection. Less common than SYN flood but effective against certain load balancers.

**Effectiveness:** Medium. More useful for testing stateful firewalls.

**Required inputs:**
- `target_ip`
- `target_port`
- `duration_seconds`
- `pps` (packets per second)
- `tcp_flag` (`ACK` / `RST` / `ACK+RST`)
- `spoof_source_ip` (boolean — same caveat as SYN flood: requires raw sockets and likely blocked by BCP38 on VPS)

---

## 3. Layer 7 Attacks (Application)

These are the hardest to mitigate because traffic is indistinguishable from legitimate traffic.

### 3.1 HTTP GET Flood

**Description:** Massive sending of valid HTTP GET requests, typically to endpoints that generate server load (DB queries, page renders, etc.). Each request is individually legitimate — saturation comes from volume.

**Effectiveness:** Very high. No spoofing required. Can saturate CPU/DB before bandwidth.

**Typical metrics:** 100K–500K requests/second from a medium botnet.

**Required inputs:**
- `target_url`
- `http_method` (GET / POST / PUT)
- `duration_seconds`
- `rps` (requests per second, per node)
- `concurrent_connections`
- `headers` (JSON — to simulate real browsers, basic WAF bypass)
- `path` (endpoint to attack)
- `follow_redirects` (boolean)

---

### 3.2 HTTP POST Flood

**Description:** Similar to GET flood but with a body. More expensive for the server because it must read and process the body. Effective against login, upload, or form processing endpoints.

**Additional inputs vs GET:**
- `body_template` (JSON/form-data)
- `body_size_bytes`
- `content_type`

---

### 3.3 Slowloris

**Description:** Opens many HTTP connections and keeps them alive by sending HTTP headers very slowly, never completing the request. The server keeps each connection open waiting for it to finish. Exhausts the pool of available connections (default: 150–1000 in Apache).

**Effectiveness:** Devastating against Apache, nginx with low worker_connections. Requires very little bandwidth (literally Kbps).

**Unique characteristic:** A single node with 150–300 connections can bring down an unconfigured Apache.

**Required inputs:**
- `target_url`
- `duration_seconds`
- `concurrent_connections`
- `headers_send_interval_ms` (how long to wait between partial headers, default: 10000ms)

---

### 3.4 RUDY (R-U-Dead-Yet)

**Description:** Slowloris variant for POST requests. Sends the body of a POST extremely slowly, byte by byte. The server waits to receive the full Content-Length.

**Effectiveness:** High against servers without a body-read timeout configured.

**Required inputs:**
- `target_url`
- `duration_seconds`
- `concurrent_connections`
- `content_length` (announces a large body)
- `byte_send_interval_ms`

---

### 3.5 HTTP/2 Rapid Reset (CVE-2023-44487)

**Description:** Exploits an HTTP/2 feature where the client can send
`RST_STREAM` immediately after opening a stream, before the server processes
the request. Allows creating and canceling thousands of requests per second
without concurrency limits.

**Effectiveness:** Extreme. In October 2023 it broke all records: Google
reported 398M rps, Cloudflare 201M rps, AWS 155M rps — all historical records.
Unpatched HTTP/2 servers are highly vulnerable.

**Current status:** Most popular servers (nginx, Apache, H2O, nghttp2) already
have patches. However, custom or outdated servers are still vulnerable.
Excellent test case to verify that the server has the patches applied.

**Required inputs:**
- `target_url` (must be HTTPS/HTTP2)
- `duration_seconds`
- `streams_per_connection`
- `connections`
- `reset_immediately` (boolean)

---

### 3.6 WebSocket Exhaustion

**Description:** Opens thousands of simultaneous WebSocket connections without
closing them. If the server has per-connection memory limits, it can be
exhausted quickly. Very relevant for modern apps (chats, real-time dashboards).

**Required inputs:**
- `target_ws_url` (ws:// or wss://)
- `duration_seconds`
- `concurrent_connections`
- `message_interval_ms` (0 = just keep connection open)
- `message_payload`

---

### 3.7 DNS Query Flood

**Description:** Massive sending of valid DNS queries to a DNS server. Can
target non-existent records (NXDOMAIN flood) to force recursion, or real
records to saturate cache and CPU.

**Effectiveness:** Very high against own DNS servers. Useful for testing resolvers and authoritative DNS servers.

**Required inputs:**
- `target_dns_server_ip`
- `target_dns_server_port` (default: 53)
- `query_type` (A, AAAA, MX, TXT, ANY)
- `query_domain`
- `duration_seconds`
- `qps` (queries per second)
- `randomize_subdomain` (boolean — to bypass cache)

---

## 4. Amplification/Reflection Attacks

Use third-party servers as amplifiers. **Not directly applicable** in Fusill
because they involve using foreign infrastructure as a weapon — only relevant
for tests in completely isolated environments where the client controls all
reflectors.

### 4.1 DNS Amplification

- Amplification ratio: **28×–54×** (40-byte query → ~1700-byte response with ANY record)
- Most common vector in large volumetric attacks from 2020–2024

### 4.2 NTP Amplification (Monlist)

- Ratio: **206×** (historically the highest)
- Less relevant today: modern NTP servers disable `monlist` by default

### 4.3 Memcached Amplification

- Ratio: **50,000×** (historical record)
- The 2018 GitHub attack (1.35 Tbps) used this vector
- Memcached should not be publicly exposed — test whether your own server has it exposed

### 4.4 SSDP Amplification (UPnP)

- Ratio: **~30×**
- Relevant for testing IoT devices and internal networks

---

## 5. Modern Attacks (2023–2025)

### 5.1 HTTP/2 Continuation Frame Flood (CVE-2024-27316)

**Description (2024):** Sending CONTINUATION frames without the END_HEADERS
flag, forcing the server to maintain state in memory indefinitely. Affects
multiple implementations: Apache, Go net/http, Node.js HTTP/2.

**Effectiveness:** Causes OOM (Out of Memory) on unpatched servers. More effective than Rapid Reset against servers that patched CVE-2023-44487.

**Required inputs:**
- `target_url`
- `duration_seconds`
- `connections`
- `frames_per_connection`

---

### 5.2 QUIC Flood / HTTP/3

**Description:** HTTP/3 uses QUIC (UDP-based). HTTP/3 servers are harder to
protect with traditional firewalls (QUIC uses UDP). Volumetric attacks via UDP
against port 443 affect both HTTP/3 and can degrade the handshake.

**Status:** Emerging vector. Cloudflare, Google, and others already support
HTTP/3 — own infrastructure with HTTP/3 enabled should be tested.

**Required inputs:**
- `target_url` (must be HTTP/3 capable)
- `duration_seconds`
- `rps`
- `connections`

---

### 5.3 TLS Exhaustion (Handshake Flood)

**Description:** Initiates multiple simultaneous TLS handshakes without
completing them or completing and discarding the connection. The TLS handshake
is asymmetrically expensive: the server does more cryptographic work than the
client. TLS 1.3 reduces this but does not eliminate it.

**Effectiveness:** High against HTTPS servers without TLS session tickets or
without rate-limiting on new connections.

**Required inputs:**
- `target_host`
- `target_port` (default: 443)
- `duration_seconds`
- `handshakes_per_second`
- `complete_handshake` (boolean — complete or abort)
- `tls_version` (TLS 1.2 / 1.3)

---

### 5.4 BGP Hijacking + DDoS (2024)

Out of Fusill's scope as it requires BGP infrastructure control. Mentioned for
completeness.

---

## 6. Applicability in Fusill

| Attack | Applicable | Reason | Priority |
|--------|-----------|--------|----------|
| HTTP GET Flood | ✅ Yes | Core use case — similar to current load testing | High |
| HTTP POST Flood | ✅ Yes | Natural extension of GET flood | High |
| Slowloris | ✅ Yes | Low bandwidth, easy to implement | High |
| HTTP/2 Rapid Reset | ✅ Yes | Critical for detecting unpatched servers | High |
| TLS Handshake Flood | ✅ Yes | Implementable with OpenSSL/Node TLS | Medium |
| SYN Flood | ⚠️ Partial | Requires raw sockets — possible in runners with CAP_NET_RAW | Medium |
| UDP Flood | ⚠️ Partial | Raw sockets, useful for testing DNS/UDP services | Medium |
| WebSocket Exhaustion | ✅ Yes | Relevant for modern apps | Medium |
| DNS Query Flood | ✅ Yes | For testing own DNS servers | Medium |
| HTTP/2 Continuation Flood | ✅ Yes | Critical — CVE 2024, many servers unpatched | High |
| RUDY | ✅ Yes | Slowloris extension | Low |
| ICMP Flood | ❌ No | Requires raw sockets + little modern educational value | Low |
| DNS Amplification | ❌ No | Uses foreign infrastructure as a weapon | Not applicable |
| NTP Amplification | ❌ No | Same | Not applicable |
| Memcached Amplification | ❌ No | Same (unless client has own memcached) | Not applicable |

---

## 7. Runner Design and On-Chain Inputs

Each runner is an attack type. The inputs the client specifies when creating the job on the blockchain must cover all required parameters.

### On-Chain Job Structure (proposal)

```
job {
    target: string,          // URL or IP:port of the target
    runner_type: RunnerType, // enum of the attack type
    duration_secs: u32,      // total attack duration
    intensity: Intensity,    // LOW / MEDIUM / HIGH / CUSTOM
    runner_config: bytes,    // JSON-serialized runner-specific parameters
    nodes_required: u8,      // how many nodes must participate
    payment: u64,            // total lamports (distributed among nodes)
}
```

### Runner Configs by Type

#### `HTTP_FLOOD`
```json
{
    "method": "GET" | "POST" | "PUT",
    "path": "/api/endpoint",
    "headers": {"User-Agent": "...", "Cookie": "..."},
    "body": "...",
    "rps_per_node": 1000,
    "concurrent_connections": 100,
    "follow_redirects": false,
    "http_version": "1.1" | "2"
}
```

#### `SLOWLORIS`
```json
{
    "concurrent_connections": 200,
    "headers_interval_ms": 10000,
    "variant": "slowloris" | "rudy",
    "rudy_content_length": 1048576
}
```

#### `HTTP2_RAPID_RESET`
```json
{
    "connections": 50,
    "streams_per_connection": 100,
    "reset_immediately": true
}
```

#### `HTTP2_CONTINUATION`
```json
{
    "connections": 20,
    "frames_per_connection": 10000,
    "frame_size_bytes": 16384
}
```

#### `TLS_EXHAUSTION`
```json
{
    "handshakes_per_second": 500,
    "complete_handshake": false,
    "tls_version": "1.3"
}
```

#### `WEBSOCKET_EXHAUSTION`
```json
{
    "concurrent_connections": 500,
    "message_interval_ms": 0,
    "protocol": "chat" | null
}
```

#### `DNS_FLOOD`
```json
{
    "dns_server_ip": "192.168.1.1",
    "dns_server_port": 53,
    "query_type": "A",
    "query_domain": "example.com",
    "qps_per_node": 5000,
    "randomize_subdomain": true
}
```

#### `SYN_FLOOD` (requires privileges)
```json
{
    "target_port": 80,
    "pps_per_node": 100000,
    "spoof_ips": true,
    "spoof_range": "0.0.0.0/0"
}
```

---

## 8. Recommended Prioritization

### Phase 1 — No raw sockets, maximum impact, easy implementation

1. **HTTP Flood (GET/POST)** — Direct extension of the current runner
2. **Slowloris / RUDY** — Low bandwidth, very destructive, easy with Node.js
3. **HTTP/2 Rapid Reset** — The most relevant attack of the last 2 years
4. **HTTP/2 Continuation Flood** — CVE 2024, many servers unpatched

### Phase 2 — Require more privileges or dependencies

5. **TLS Handshake Exhaustion** — With Node's `tls` module or OpenSSL
6. **WebSocket Exhaustion** — With `ws` library
7. **DNS Flood** — With `dns2` or raw UDP sockets

### Phase 3 — Require raw sockets (CAP_NET_RAW in containers)

8. **SYN Flood** — With `raw-socket` npm package or external tool (hping3)
9. **UDP Flood** — Similar, raw UDP

---

## References

- [HTTP/2 Rapid Reset Attack (Google Security Blog, Oct 2023)](https://cloud.google.com/blog/products/identity-security/how-it-works-the-novel-http2-rapid-reset-ddos-attack)
- [CVE-2024-27316 — HTTP/2 CONTINUATION Flood](https://nowotarski.info/http2-continuation-flood/)
- [Cloudflare DDoS Threat Report Q1 2025](https://blog.cloudflare.com/ddos-threat-report-for-2025-q1/)
- [CISA DDoS Quick Guide](https://www.cisa.gov/sites/default/files/publications/understanding-and-responding-to-ddos-attacks_508c.pdf)
- [OWASP Testing Guide — Denial of Service](https://owasp.org/www-community/attacks/Denial_of_Service)
