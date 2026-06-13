import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'syn_flood');

export async function runSynFlood(target, config, durationSeconds) {
  const {
    packets_per_second = 5000,
  } = config;

  const host = target.replace(/^.*:\/\//, '').split(':')[0];
  const port = target.includes(':') ? target.split(':').pop() : '80';

  return new Promise((resolve, reject) => {
    const proc = spawn(HELPER, [host, port, String(packets_per_second), String(durationSeconds)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => process.stderr.write(d));

    proc.on('error', (err) => {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        reject(new Error('SYN Flood requires CAP_NET_RAW. Run: sudo setcap cap_net_raw+eip $(which node)  — or run with sudo.'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`syn_flood exited with code ${code} — missing CAP_NET_RAW?`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve({
          avgLatencyMs      : 0,
          errorRateBps      : 0,
          requestsCompleted : result.requestsCompleted ?? 0,
        });
      } catch {
        resolve({ avgLatencyMs: 0, errorRateBps: 0, requestsCompleted: 0 });
      }
    });
  });
}
