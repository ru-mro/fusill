import dgram from 'dgram';
import { URL } from 'url';
import { performance } from 'perf_hooks';

const QUERY_TYPES = { A: 1, AAAA: 28, MX: 15, TXT: 16, NS: 2, ANY: 255 };

function buildDnsQuery(id, domain, qtype = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id,     0); // ID
  header.writeUInt16BE(0x0100, 2); // flags: recursion desired
  header.writeUInt16BE(1,      4); // QDCOUNT = 1

  const labels = domain.split('.');
  const name   = Buffer.concat([
    ...labels.map(l => { const b = Buffer.alloc(1 + l.length); b.writeUInt8(l.length, 0); Buffer.from(l).copy(b, 1); return b; }),
    Buffer.from([0x00]),
  ]);

  const question = Buffer.alloc(4);
  question.writeUInt16BE(qtype, 0); // QTYPE
  question.writeUInt16BE(1,     2); // QCLASS: IN

  return Buffer.concat([header, name, question]);
}

export async function runDnsFlood(target, config, durationSeconds) {
  const {
    query_type          = 'A',
    queries_per_second  = 1000,
    qps_per_node        = queries_per_second,
    randomize_subdomain = true,
    query_domain,
  } = config;

  const rawTarget  = target.startsWith('http') ? new URL(target).host : target;
  const [dnsServer, portStr] = rawTarget.split(':');
  const dnsPort    = portStr ? parseInt(portStr) : 53;
  const baseDomain = query_domain ?? dnsServer;
  const qtype      = QUERY_TYPES[query_type] ?? 1;
  const intervalMs = Math.max(1, 1000 / qps_per_node);
  const endTime    = performance.now() + durationSeconds * 1000;

  let sent = 0, errors = 0;
  let latencySum = 0, latencyCount = 0;
  let nextId = 1;

  // id → send timestamp, for RTT correlation
  const pending = new Map();

  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});

  // Listen for DNS responses and correlate by transaction ID
  socket.on('message', (msg) => {
    if (msg.length < 2) return;
    const id        = msg.readUInt16BE(0);
    const sentAt    = pending.get(id);
    if (sentAt !== undefined) {
      latencySum += performance.now() - sentAt;
      latencyCount++;
      pending.delete(id);
    }
  });

  await new Promise((resolve) => {
    const ticker = setInterval(() => {
      if (performance.now() >= endTime) { clearInterval(ticker); resolve(); return; }

      const id     = (nextId++ & 0xFFFF) || 1; // 1–65535
      const domain = randomize_subdomain
        ? `${Math.random().toString(36).slice(2, 9)}.${baseDomain}`
        : baseDomain;
      const packet = buildDnsQuery(id, domain, qtype);

      pending.set(id, performance.now());
      socket.send(packet, dnsPort, dnsServer, (err) => {
        if (err) { errors++; pending.delete(id); }
        else sent++;
      });
    }, intervalMs);
  });

  // Give in-flight responses a short window to arrive
  await new Promise(r => setTimeout(r, 200));
  socket.close();

  const total = sent + errors;
  return {
    avgLatencyMs      : latencyCount > 0 ? Math.ceil(latencySum / latencyCount) : 0,
    errorRateBps      : total > 0 ? Math.round((errors / total) * 10000) : 10_000,
    requestsCompleted : sent,
  };
}
