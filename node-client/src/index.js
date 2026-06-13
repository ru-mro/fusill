try { await import('dotenv/config'); } catch { /* env vars set externally in Docker */ }
import {
  initChain,
  registerNodeIfNeeded,
  fetchOpenJobs,
  claimJob,
  submitCommitment,
  revealResult,
  finalizeJob,
  waitForJobReady,
  waitForRevealPhase,
  waitForPendingFinalization,
} from './chain.js';
import { runAttack }        from './runner.js';
import { verifyOwnership }  from './verify.js';
import { measureBaseline }  from './baseline.js';
import { generateNonce, buildCommitment } from './commitment.js';

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_SECONDS) || 5) * 1000;

// Jobs this node has already processed or is processing — prevents double execution
const attemptedJobs = new Set();
let busy = false;

/**
 * Runs the full cycle for a job:
 * verify → claim → attack → commit → reveal → finalize
 *
 * @param {Program} program
 * @param {Keypair} keypair
 * @param {PublicKey} jobPubkey
 * @param {object} job  — JobAccount data
 * @param {object} deps — injectable dependencies (for tests)
 * @param {function} deps.runTest   — replaces runAttack
 * @param {function} deps.verify    — replaces verifyOwnership
 */
export async function processJob(program, keypair, jobPubkey, job, deps = {}) {
  const runTest  = deps.runTest  ?? runAttack;
  const verify   = deps.verify   ?? verifyOwnership;
  const baseline = deps.baseline ?? measureBaseline;

  const tag        = `[job ${jobPubkey.toString().slice(0, 8)}...]`;
  const runnerType = Object.keys(job.runnerType)[0];
  const runnerConfig = (() => {
    try { return JSON.parse(Buffer.from(job.runnerConfig).toString('utf8')); }
    catch { return {}; }
  })();

  console.log(`${tag} Processing — runner: ${runnerType}, payment: ${job.payment} lamports`);

  // 1. Verify ownership of the target server
  const isOwner = await verify(job.target, job.owner.toString());
  if (!isOwner) {
    console.log(`${tag} Invalid ownership — skipping`);
    return;
  }

  // 2. Claim the job on-chain
  console.log(`${tag} Claiming...`);
  await claimJob(program, keypair, jobPubkey);

  // 3. Wait for the job to reach Running (all nodes claimed + scheduled if applicable)
  console.log(`${tag} Waiting for job to be ready...`);
  const readyJob = await waitForJobReady(program, jobPubkey);

  // 4. For scheduled jobs, wait until the coordinated execution timestamp
  const scheduledAt = readyJob?.scheduledAt?.toNumber?.() ?? 0;
  if (scheduledAt > 0) {
    const delayMs = scheduledAt * 1000 - Date.now();
    if (delayMs > 0) {
      console.log(`${tag} Scheduled attack — waiting ${Math.round(delayMs / 1000)}s for coordinated execution...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // 5. Measure the target's baseline latency before firing the attack
  const baselineLatencyMs = await baseline(job.target);
  console.log(`${tag} Baseline latency: ${baselineLatencyMs}ms`);

  // 6. Run the corresponding runner
  console.log(`${tag} Running ${runnerType} for ${job.durationSeconds}s`);
  let metrics;
  try {
    metrics = await runTest(job.target, runnerType, runnerConfig, job.durationSeconds);
    console.log(`${tag} Test finished — latency: ${metrics.avgLatencyMs}ms (baseline ${baselineLatencyMs}ms), errors: ${metrics.errorRateBps / 100}%`);
  } catch (err) {
    console.error(`${tag} Runner failed (${err.message}) — revealing with errorRateBps: 10000`);
    metrics = { avgLatencyMs: 0, errorRateBps: 10000, requestsCompleted: 0 };
  }
  metrics.baselineLatencyMs = baselineLatencyMs;

  // 7. Commit the hash
  const nonce      = generateNonce();
  const commitment = buildCommitment(
    metrics.avgLatencyMs,
    metrics.errorRateBps,
    metrics.requestsCompleted,
    metrics.baselineLatencyMs,
    nonce,
  );
  console.log(`${tag} Committing hash...`);
  await submitCommitment(program, keypair, jobPubkey, commitment);

  // 7. Wait for RevealPhase
  console.log(`${tag} Waiting for all nodes to commit...`);
  await waitForRevealPhase(program, keypair, jobPubkey);

  // 8. Reveal actual results
  console.log(`${tag} Revealing results...`);
  await revealResult(program, keypair, jobPubkey, metrics, nonce);

  // 9. Wait for PendingFinalization
  console.log(`${tag} Waiting for all nodes to reveal...`);
  await waitForPendingFinalization(program, keypair, jobPubkey);

  // 10. Finalize — any node can call this first
  console.log(`${tag} Finalizing job...`);
  try {
    await finalizeJob(program, keypair, jobPubkey);
    console.log(`${tag} Job finalized — payment distributed`);
  } catch (err) {
    if (err.message?.includes('JobNotFinalizable') || err.message?.includes('Unknown action')) {
      console.log(`${tag} Another node already finalized the job`);
    } else {
      throw err;
    }
  }
}

async function loop(program, keypair) {
  if (busy) return;

  const openJobs = await fetchOpenJobs(program);

  if (openJobs.length === 0) {
    console.log('No jobs available — waiting...');
    return;
  }

  for (const { publicKey, account } of openJobs) {
    const jobKey = publicKey.toString();
    if (attemptedJobs.has(jobKey)) continue;
    attemptedJobs.add(jobKey);

    busy = true;
    processJob(program, keypair, publicKey, account)
      .catch(err => {
        console.error(`[job ${jobKey.slice(0, 8)}...] Error: ${err.message}`);
        attemptedJobs.delete(jobKey);
      })
      .finally(() => { busy = false; });
    break;
  }
}

async function main() {
  console.log('Fusill node client starting...');

  const { program, keypair } = await initChain();
  console.log(`Node: ${keypair.publicKey.toString()}`);

  await registerNodeIfNeeded(program, keypair);

  while (true) {
    try {
      await loop(program, keypair);
    } catch (err) {
      console.error(`Main loop error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Only starts the main loop when run directly (not in tests)
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) main();
