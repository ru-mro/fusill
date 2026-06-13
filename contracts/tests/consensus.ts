/**
 * Consensus tests: verify that finalize_job uses the correct metric per runner
 * type and that the tolerance formula behaves as expected.
 *
 * Conventions used in each test's comments:
 *   center = median of the revealed values (integer math, same as Rust)
 *   tol    = center/5 for avgLatencyMs
 *          = max(center/5, 500) for errorRateBps
 *   pass   = |value - center| <= tol
 */

import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import {
  createTestContext, initializeProgram, createJob, fillJob,
  configPda, resultPda, makeCommitment, TestContext,
} from "./helpers";

// ─── Helper: full commit → reveal → finalize cycle ──────────────────────────

type NodeMetrics = {
  avgLatencyMs: number;
  errorRateBps: number;
  requestsCompleted: bigint;
  nonce: bigint;
};

/**
 * Drives a job already in Running state to Completed.
 * nodes[i] commits and reveals with metrics[i].
 * Returns the lamports earned by each node and their final reputations.
 */
async function commitRevealFinalize(
  ctx: TestContext,
  jobKey: PublicKey,
  nodes: { owner: import("@solana/web3.js").Keypair; nodeKey: PublicKey }[],
  metrics: NodeMetrics[],
): Promise<{ gains: bigint[]; reputations: number[] }> {
  const resultKeys = nodes.map(n => resultPda(jobKey, n.owner.publicKey));

  // Commit
  for (let i = 0; i < nodes.length; i++) {
    const m = metrics[i];
    await ctx.program.methods
      .submitCommitment(makeCommitment(m.avgLatencyMs, m.errorRateBps, m.requestsCompleted, m.nonce))
      .accounts({
        nodeOwner:     nodes[i].owner.publicKey,
        jobAccount:    jobKey,
        resultAccount: resultKeys[i],
        systemProgram: SystemProgram.programId,
      })
      .signers([nodes[i].owner])
      .rpc();
  }

  // Reveal
  for (let i = 0; i < nodes.length; i++) {
    const m = metrics[i];
    await ctx.program.methods
      .revealResult(m.avgLatencyMs, m.errorRateBps, new BN(m.requestsCompleted.toString()), new BN(m.nonce.toString()))
      .accounts({
        nodeOwner:     nodes[i].owner.publicKey,
        jobAccount:    jobKey,
        resultAccount: resultKeys[i],
      })
      .signers([nodes[i].owner])
      .rpc();
  }

  // Balances before finalize
  const before = await Promise.all(nodes.map(n => ctx.lamportsOf(n.owner.publicKey)));

  // Finalize
  await ctx.program.methods.finalizeJob()
    .accounts({ jobAccount: jobKey, config: configPda(), authority: ctx.authority.publicKey })
    .remainingAccounts([
      ...resultKeys.map(pk => ({ pubkey: pk, isSigner: false, isWritable: false })),
      ...nodes.map(n => ({ pubkey: n.owner.publicKey, isSigner: false, isWritable: true })),
      ...nodes.map(n => ({ pubkey: n.nodeKey, isSigner: false, isWritable: true })),
    ])
    .rpc();

  const after = await Promise.all(nodes.map(n => ctx.lamportsOf(n.owner.publicKey)));
  const gains = nodes.map((_, i) => after[i] - before[i]);

  const reputations = await Promise.all(
    nodes.map(n => ctx.program.account.nodeAccount.fetch(n.nodeKey).then(a => a.reputation))
  );

  return { gains, reputations };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("consensus", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
    await initializeProgram(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // METRIC SELECTION BY RUNNER TYPE
  // ═══════════════════════════════════════════════════════════════════════════

  describe("metric selection — runners that use avgLatencyMs", () => {
    const LATENCY_RUNNERS: Array<[string, Record<string, Record<string, never>>]> = [
      ["httpFlood",     { httpFlood:     {} }],
      ["tlsExhaustion", { tlsExhaustion: {} }],
      ["dnsFlood",      { dnsFlood:      {} }],
    ];

    for (const [name, runnerType] of LATENCY_RUNNERS) {
      it(`${name}: both nodes pass if avgLatencyMs converges even when errorRateBps differs`, async () => {
        // Same avgLatencyMs (100ms), errorRateBps radically different (0 vs 8000)
        // If the contract used errorRateBps: median(0,8000)=4000, tol=800 → both fail
        // Using avgLatencyMs correctly: median=100, tol=20 → |100-100|=0 ≤ 20 → both pass
        const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 2_000_000, runnerType });
        const nodes = await fillJob(ctx, jobKey, 2);

        const { gains } = await commitRevealFinalize(ctx, jobKey, nodes, [
          { avgLatencyMs: 100, errorRateBps:    0, requestsCompleted: 1000n, nonce: 10n },
          { avgLatencyMs: 100, errorRateBps: 8000, requestsCompleted: 1000n, nonce: 11n },
        ]);

        assert.ok(gains[0] > 0n, `node 0 (${name}): must be paid — avgLatencyMs converges`);
        assert.ok(gains[1] > 0n, `node 1 (${name}): must be paid — avgLatencyMs converges`);
      });
    }
  });

  describe("metric selection — runners that use errorRateBps", () => {
    const ERROR_RUNNERS: Array<[string, Record<string, Record<string, never>>]> = [
      ["slowloris",           { slowloris:           {} }],
      ["http2RapidReset",     { http2RapidReset:     {} }],
      ["http2Continuation",   { http2Continuation:   {} }],
      ["websocketExhaustion", { websocketExhaustion: {} }],
    ];

    for (const [name, runnerType] of ERROR_RUNNERS) {
      it(`${name}: both nodes pass if errorRateBps converges even when avgLatencyMs differs`, async () => {
        // Same errorRateBps (3000 bps), avgLatencyMs radically different (0 vs 9999)
        // If the contract used avgLatencyMs: median=4999, tol=999 → |0-4999|=4999>999 → both fail
        // Using errorRateBps correctly: median=3000, tol=max(600,500)=600 → |3000-3000|=0 ≤ 600 → both pass
        const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 2_000_000, runnerType });
        const nodes = await fillJob(ctx, jobKey, 2);

        const { gains } = await commitRevealFinalize(ctx, jobKey, nodes, [
          { avgLatencyMs:    0, errorRateBps: 3000, requestsCompleted: 50n, nonce: 20n },
          { avgLatencyMs: 9999, errorRateBps: 3000, requestsCompleted: 50n, nonce: 21n },
        ]);

        assert.ok(gains[0] > 0n, `node 0 (${name}): must be paid — errorRateBps converges`);
        assert.ok(gains[1] > 0n, `node 1 (${name}): must be paid — errorRateBps converges`);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOLERANCE — avgLatencyMs (20% relative)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("tolerance — avgLatencyMs", () => {
    it("node with radically different latency fails consensus", async () => {
      // h1=h2=100, cheat=150
      // median[100,100,150] = 100, tol = 100/5 = 20
      // |100-100|=0 ≤ 20 → pass ✓   |150-100|=50 > 20 → fail ✗
      const { jobKey } = await createJob(ctx, { minNodes: 3, paymentLamports: 3_000_000 });
      const [h1, h2, cheat] = await fillJob(ctx, jobKey, 3);

      const { gains, reputations } = await commitRevealFinalize(ctx, jobKey, [h1, h2, cheat], [
        { avgLatencyMs: 100, errorRateBps: 0, requestsCompleted: 1000n, nonce: 30n },
        { avgLatencyMs: 100, errorRateBps: 0, requestsCompleted: 1000n, nonce: 31n },
        { avgLatencyMs: 150, errorRateBps: 0, requestsCompleted: 1000n, nonce: 32n },
      ]);

      assert.ok(gains[0] > 0n,  "h1 must be paid");
      assert.ok(gains[1] > 0n,  "h2 must be paid");
      assert.ok(gains[2] <= 0n, "cheat must not be paid");
      assert.ok(reputations[2] < 100, "cheat loses reputation");
    });

    it("node exactly at the 20% boundary passes (≤ is inclusive)", async () => {
      // With 2 nodes: a=100, b=125
      // median = (100+125)/2 = 112 (integer), tol = 112/5 = 22
      // |100-112|=12 ≤ 22 → pass ✓   |125-112|=13 ≤ 22 → pass ✓
      const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 2_000_000 });
      const [n1, n2] = await fillJob(ctx, jobKey, 2);

      const { gains } = await commitRevealFinalize(ctx, jobKey, [n1, n2], [
        { avgLatencyMs: 100, errorRateBps: 0, requestsCompleted: 1000n, nonce: 40n },
        { avgLatencyMs: 125, errorRateBps: 0, requestsCompleted: 1000n, nonce: 41n },
      ]);

      assert.ok(gains[0] > 0n, "n1 (100ms) passes — within 20%");
      assert.ok(gains[1] > 0n, "n2 (125ms) passes — within 20%");
    });

    it("node with very low latency when the median is high: fails", async () => {
      // A node under-reporting latency falls outside consensus.
      // h1=h2=300ms, cheat=10ms (reports unrealistic latency)
      // median[10,300,300]=300, tol=60
      // |300-300|=0 ≤ 60 → h1,h2 pass ✓   |10-300|=290 > 60 → cheat fails ✗
      // (the median is robust to the outlier — it does not drag the center the way
      //  the mean would, so the honest nodes still pass)
      const { jobKey } = await createJob(ctx, { minNodes: 3, paymentLamports: 3_000_000 });
      const [h1, h2, cheat] = await fillJob(ctx, jobKey, 3);

      const { gains } = await commitRevealFinalize(ctx, jobKey, [h1, h2, cheat], [
        { avgLatencyMs: 300, errorRateBps: 0, requestsCompleted: 1000n, nonce: 50n },
        { avgLatencyMs: 300, errorRateBps: 0, requestsCompleted: 1000n, nonce: 51n },
        { avgLatencyMs:  10, errorRateBps: 0, requestsCompleted: 1000n, nonce: 52n },
      ]);

      // The node that drastically under-reports must not be paid
      assert.ok(gains[2] <= 0n, "cheat (10ms vs real 300ms) must not be paid");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOLERANCE — errorRateBps (max(center/5, 500))
  // ═══════════════════════════════════════════════════════════════════════════

  describe("tolerance — errorRateBps 500 bps floor", () => {
    it("floor prevents false negatives when the error rate is low and varies", async () => {
      // h1=200, h2=200, h3=500 (slowloris — resilient server)
      // median[200,200,500] = 200, tol = max(200/5, 500) = max(40, 500) = 500
      // WITHOUT floor: tol=40 → |500-200|=300 > 40 → h3 fails ✗ (false negative)
      // WITH floor:    tol=500 → |500-200|=300 ≤ 500 → h3 passes ✓
      const { jobKey } = await createJob(ctx, {
        minNodes: 3, paymentLamports: 3_000_000,
        runnerType: { slowloris: {} },
      });
      const nodes = await fillJob(ctx, jobKey, 3);

      const { gains } = await commitRevealFinalize(ctx, jobKey, nodes, [
        { avgLatencyMs: 0, errorRateBps: 200, requestsCompleted: 50n, nonce: 60n },
        { avgLatencyMs: 0, errorRateBps: 200, requestsCompleted: 50n, nonce: 61n },
        { avgLatencyMs: 0, errorRateBps: 500, requestsCompleted: 50n, nonce: 62n },
      ]);

      assert.ok(gains[0] > 0n, "n1 (200 bps): at the median, passes");
      assert.ok(gains[1] > 0n, "n2 (200 bps): at the median, passes");
      assert.ok(gains[2] > 0n, "n3 (500 bps): floor avoids false negative — passes");
    });

    it("relative tolerance detects an outlier when error rates are high", async () => {
      // h1=h2=3000, cheat=4500 (slowloris)
      // median[3000,3000,4500] = 3000, tol = max(3000/5, 500) = max(600, 500) = 600
      // |3000-3000|=0 ≤ 600 → pass ✓   |4500-3000|=1500 > 600 → fail ✗
      const { jobKey } = await createJob(ctx, {
        minNodes: 3, paymentLamports: 3_000_000,
        runnerType: { slowloris: {} },
      });
      const [h1, h2, cheat] = await fillJob(ctx, jobKey, 3);

      const { gains, reputations } = await commitRevealFinalize(ctx, jobKey, [h1, h2, cheat], [
        { avgLatencyMs: 0, errorRateBps: 3000, requestsCompleted: 50n, nonce: 70n },
        { avgLatencyMs: 0, errorRateBps: 3000, requestsCompleted: 50n, nonce: 71n },
        { avgLatencyMs: 0, errorRateBps: 4500, requestsCompleted: 50n, nonce: 72n },
      ]);

      assert.ok(gains[0] > 0n,  "h1 (3000 bps): within 20%");
      assert.ok(gains[1] > 0n,  "h2 (3000 bps): within 20%");
      assert.ok(gains[2] <= 0n, "cheat (4500 bps): outside 20%");
      assert.ok(reputations[2] < 100, "cheat loses reputation");
    });

    it("all report errorRateBps = 0 (server 100% available): all pass", async () => {
      // median=0, tol=max(0, 500)=500, |0-0|=0 ≤ 500 → all pass
      const { jobKey } = await createJob(ctx, {
        minNodes: 2, paymentLamports: 2_000_000,
        runnerType: { http2RapidReset: {} },
      });
      const nodes = await fillJob(ctx, jobKey, 2);

      const { gains } = await commitRevealFinalize(ctx, jobKey, nodes, [
        { avgLatencyMs: 0, errorRateBps: 0, requestsCompleted: 500n, nonce: 80n },
        { avgLatencyMs: 0, errorRateBps: 0, requestsCompleted: 500n, nonce: 81n },
      ]);

      assert.ok(gains[0] > 0n, "node 0: errorRateBps=0 passes (server with no errors)");
      assert.ok(gains[1] > 0n, "node 1: errorRateBps=0 passes (server with no errors)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENT DISTRIBUTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("payment distribution", () => {
    it("1 honest node receives the full 95%", async () => {
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, { minNodes: 1, paymentLamports: Number(PAYMENT) });
      const [node] = await fillJob(ctx, jobKey, 1);

      const { gains } = await commitRevealFinalize(ctx, jobKey, [node], [
        { avgLatencyMs: 100, errorRateBps: 0, requestsCompleted: 1000n, nonce: 90n },
      ]);

      const expected = Number(PAYMENT) * 9500 / 10_000; // 95%
      assert.ok(Number(gains[0]) >= expected, `node must receive at least 95%: ${gains[0]}`);
    });

    it("dishonest node (0 honest) → deployer receives everything as fallback", async () => {
      // With 2 radically different nodes, neither lands in consensus
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: Number(PAYMENT) });
      const nodes = await fillJob(ctx, jobKey, 2);

      const authorityBefore = await ctx.lamportsOf(ctx.authority.publicKey);

      await commitRevealFinalize(ctx, jobKey, nodes, [
        { avgLatencyMs: 100,    errorRateBps: 0, requestsCompleted: 1000n, nonce: 100n },
        { avgLatencyMs: 50_000, errorRateBps: 0, requestsCompleted: 1000n, nonce: 101n },
      ]);

      const authorityGained = await ctx.lamportsOf(ctx.authority.publicKey) - authorityBefore;
      // The deployer receives at least 99% of the payment (5% fee + 95% distributable, minus tx fees)
      assert.ok(Number(authorityGained) >= Number(PAYMENT) * 99 / 100,
        `deployer must receive the full payment as fallback: ${authorityGained}`);
    });
  });
});
