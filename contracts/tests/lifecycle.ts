/**
 * Integration tests — end-to-end flows chaining multiple instructions.
 * Require initialize() to have run so that finalize_job can be called.
 */

import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import {
  createTestContext, initializeProgram, registerNode, createJob,
  fillJob, submitAllCommitments, configPda, resultPda, makeCommitment,
  TestContext,
} from "./helpers";

describe("lifecycle", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
    await initializeProgram(ctx);
  });

  // ─── Full cycle with all honest nodes ────────────────────────────────────

  describe("full cycle: 2 honest nodes", () => {
    it("distributes 95% among nodes and 5% to the deployer", async () => {
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: Number(PAYMENT) });
      const nodes      = await fillJob(ctx, jobKey, 2);
      const results    = await submitAllCommitments(ctx, jobKey, nodes, 150, 100n);

      for (const r of results) {
        await ctx.program.methods
          .revealResult(150, 0, new BN(3_000), new BN(r.nonce.toString()))
          .accounts({ nodeOwner: r.owner.publicKey, jobAccount: jobKey, resultAccount: r.resultKey })
          .signers([r.owner]).rpc();
      }

      const authorityBefore = await ctx.lamportsOf(ctx.authority.publicKey);
      const node0Before     = await ctx.lamportsOf(nodes[0].owner.publicKey);
      const node1Before     = await ctx.lamportsOf(nodes[1].owner.publicKey);

      await ctx.program.methods.finalizeJob()
        .accounts({ jobAccount: jobKey, config: configPda(), authority: ctx.authority.publicKey })
        .remainingAccounts([
          { pubkey: results[0].resultKey,     isSigner: false, isWritable: false },
          { pubkey: results[1].resultKey,     isSigner: false, isWritable: false },
          { pubkey: nodes[0].owner.publicKey, isSigner: false, isWritable: true  },
          { pubkey: nodes[1].owner.publicKey, isSigner: false, isWritable: true  },
          { pubkey: nodes[0].nodeKey,         isSigner: false, isWritable: true  },
          { pubkey: nodes[1].nodeKey,         isSigner: false, isWritable: true  },
        ])
        .rpc();

      const job = await ctx.program.account.jobAccount.fetch(jobKey);
      assert.deepEqual(job.status, { completed: {} });

      const authorityGained = await ctx.lamportsOf(ctx.authority.publicKey) - authorityBefore;
      const node0Gained     = await ctx.lamportsOf(nodes[0].owner.publicKey) - node0Before;
      const node1Gained     = await ctx.lamportsOf(nodes[1].owner.publicKey) - node1Before;

      const protocolFee   = Number(PAYMENT) * 500 / 10_000; // 5%
      const distributable = Number(PAYMENT) - protocolFee;
      const perNode       = Math.floor(distributable / 2);

      // authority received at least the fee (may receive more due to rounding remainder)
      assert.ok(Number(authorityGained) >= protocolFee);
      // each node received its share
      assert.ok(Number(node0Gained) >= perNode);
      assert.ok(Number(node1Gained) >= perNode);

      // reputation increased (+5 for honest job, capped at 100)
      const n0 = await ctx.program.account.nodeAccount.fetch(nodes[0].nodeKey);
      const n1 = await ctx.program.account.nodeAccount.fetch(nodes[1].nodeKey);
      assert.equal(n0.reputation, 100);
      assert.equal(n1.reputation, 100);
      assert.equal(n0.jobsCompleted.toNumber(), 1);
      assert.equal(n1.jobsCompleted.toNumber(), 1);
    });
  });

  // ─── One dishonest node ───────────────────────────────────────────────────
  //
  // With 3 nodes: h1=h2=100ms, cheat=150ms
  //   avg = (100+100+150)/3 ≈ 116ms, tolerance ≈ 23ms
  //   |100-116| = 16 < 23 → honest   ✓
  //   |150-116| = 34 > 23 → dishonest ✓

  describe("cycle with 1 dishonest node (latency outside consensus)", () => {
    it("dishonest node earns nothing and loses reputation; honest nodes absorb its share", async () => {
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, { minNodes: 3, paymentLamports: Number(PAYMENT) });
      const [h1, h2, cheat] = await fillJob(ctx, jobKey, 3);

      const rH1    = resultPda(jobKey, h1.owner.publicKey);
      const rH2    = resultPda(jobKey, h2.owner.publicKey);
      const rCheat = resultPda(jobKey, cheat.owner.publicKey);

      // Honest: 100ms, Dishonest: 150ms
      await ctx.program.methods.submitCommitment(makeCommitment(100, 0, 3_000n, 200n))
        .accounts({ nodeOwner: h1.owner.publicKey, jobAccount: jobKey, resultAccount: rH1, systemProgram: SystemProgram.programId })
        .signers([h1.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(100, 0, 3_000n, 201n))
        .accounts({ nodeOwner: h2.owner.publicKey, jobAccount: jobKey, resultAccount: rH2, systemProgram: SystemProgram.programId })
        .signers([h2.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(150, 0, 3_000n, 202n))
        .accounts({ nodeOwner: cheat.owner.publicKey, jobAccount: jobKey, resultAccount: rCheat, systemProgram: SystemProgram.programId })
        .signers([cheat.owner]).rpc();

      await ctx.program.methods.revealResult(100, 0, new BN(3_000), new BN(200))
        .accounts({ nodeOwner: h1.owner.publicKey, jobAccount: jobKey, resultAccount: rH1 })
        .signers([h1.owner]).rpc();
      await ctx.program.methods.revealResult(100, 0, new BN(3_000), new BN(201))
        .accounts({ nodeOwner: h2.owner.publicKey, jobAccount: jobKey, resultAccount: rH2 })
        .signers([h2.owner]).rpc();
      await ctx.program.methods.revealResult(150, 0, new BN(3_000), new BN(202))
        .accounts({ nodeOwner: cheat.owner.publicKey, jobAccount: jobKey, resultAccount: rCheat })
        .signers([cheat.owner]).rpc();

      const h1Before    = await ctx.lamportsOf(h1.owner.publicKey);
      const h2Before    = await ctx.lamportsOf(h2.owner.publicKey);
      const cheatBefore = await ctx.lamportsOf(cheat.owner.publicKey);

      await ctx.program.methods.finalizeJob()
        .accounts({ jobAccount: jobKey, config: configPda(), authority: ctx.authority.publicKey })
        .remainingAccounts([
          { pubkey: rH1,                   isSigner: false, isWritable: false },
          { pubkey: rH2,                   isSigner: false, isWritable: false },
          { pubkey: rCheat,                isSigner: false, isWritable: false },
          { pubkey: h1.owner.publicKey,    isSigner: false, isWritable: true  },
          { pubkey: h2.owner.publicKey,    isSigner: false, isWritable: true  },
          { pubkey: cheat.owner.publicKey, isSigner: false, isWritable: true  },
          { pubkey: h1.nodeKey,            isSigner: false, isWritable: true  },
          { pubkey: h2.nodeKey,            isSigner: false, isWritable: true  },
          { pubkey: cheat.nodeKey,         isSigner: false, isWritable: true  },
        ])
        .rpc();

      const h1Gained    = await ctx.lamportsOf(h1.owner.publicKey)    - h1Before;
      const h2Gained    = await ctx.lamportsOf(h2.owner.publicKey)    - h2Before;
      const cheatGained = await ctx.lamportsOf(cheat.owner.publicKey) - cheatBefore;

      // 2 honest nodes → each receives half of the distributable
      const protocolFee   = Number(PAYMENT) * 500 / 10_000; // 5%
      const distributable = Number(PAYMENT) - protocolFee;
      const perHonest     = Math.floor(distributable / 2);

      assert.ok(Number(h1Gained) >= perHonest, "h1 should earn its share");
      assert.ok(Number(h2Gained) >= perHonest, "h2 should earn its share");
      assert.ok(Number(cheatGained) <= 0, "dishonest node should earn nothing");

      // Reputations
      const h1Data   = await ctx.program.account.nodeAccount.fetch(h1.nodeKey);
      const h2Data   = await ctx.program.account.nodeAccount.fetch(h2.nodeKey);
      const cheatData = await ctx.program.account.nodeAccount.fetch(cheat.nodeKey);
      assert.equal(h1Data.reputation, 100);              // 100 + 5, capped
      assert.equal(h2Data.reputation, 100);              // 100 + 5, capped
      assert.equal(cheatData.reputation, 90);            // 100 - 10 (REPUTATION_PENALTY_DISHONEST)
      assert.equal(h1Data.jobsCompleted.toNumber(), 1);
      assert.equal(h2Data.jobsCompleted.toNumber(), 1);
      assert.equal(cheatData.jobsCompleted.toNumber(), 0);
    });
  });

  // ─── Consensus by errorRateBps (slowloris runner) ────────────────────────
  //
  // Runners without latency (slowloris, http2RapidReset, etc.) use errorRateBps
  // as the consensus metric. avgLatencyMs = 0 for all and is ignored.
  //
  // Scenario: 3 nodes, errorRateBps = [3000, 3200, 8000]
  //   avg = (3000+3200+8000)/3 ≈ 4733
  //   tolerance = max(4733/5, 500) = max(946, 500) = 946
  //   |3000-4733| = 1733 > 946  → dishonest ✗
  //   |3200-4733| = 1533 > 946  → dishonest ✗
  //   |8000-4733| = 3267 > 946  → dishonest ✗
  //   All out → fallback to deployer
  //
  // For nodes to pass, use [3000, 3100, 3200]:
  //   avg = (3000+3100+3200)/3 ≈ 3100
  //   tolerance = max(3100/5, 500) = max(620, 500) = 620
  //   |3000-3100| = 100 <= 620 → honest ✓
  //   |3100-3100| = 0   <= 620 → honest ✓
  //   |3200-3100| = 100 <= 620 → honest ✓

  describe("consensus by errorRateBps (slowloris — 3 honest nodes)", () => {
    it("all 3 nodes pass consensus even when avgLatencyMs differs", async () => {
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, {
        minNodes: 3,
        paymentLamports: Number(PAYMENT),
        runnerType: { slowloris: {} },
      });
      const [n1, n2, n3] = await fillJob(ctx, jobKey, 3);

      const r1 = resultPda(jobKey, n1.owner.publicKey);
      const r2 = resultPda(jobKey, n2.owner.publicKey);
      const r3 = resultPda(jobKey, n3.owner.publicKey);

      // similar errorRateBps (within 20%+floor), different avgLatencyMs (ignored)
      await ctx.program.methods.submitCommitment(makeCommitment(0, 3000, 50n, 400n))
        .accounts({ nodeOwner: n1.owner.publicKey, jobAccount: jobKey, resultAccount: r1, systemProgram: SystemProgram.programId })
        .signers([n1.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(999, 3100, 50n, 401n))
        .accounts({ nodeOwner: n2.owner.publicKey, jobAccount: jobKey, resultAccount: r2, systemProgram: SystemProgram.programId })
        .signers([n2.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(9999, 3200, 50n, 402n))
        .accounts({ nodeOwner: n3.owner.publicKey, jobAccount: jobKey, resultAccount: r3, systemProgram: SystemProgram.programId })
        .signers([n3.owner]).rpc();

      await ctx.program.methods.revealResult(0,    3000, new BN(50), new BN(400))
        .accounts({ nodeOwner: n1.owner.publicKey, jobAccount: jobKey, resultAccount: r1 })
        .signers([n1.owner]).rpc();
      await ctx.program.methods.revealResult(999,  3100, new BN(50), new BN(401))
        .accounts({ nodeOwner: n2.owner.publicKey, jobAccount: jobKey, resultAccount: r2 })
        .signers([n2.owner]).rpc();
      await ctx.program.methods.revealResult(9999, 3200, new BN(50), new BN(402))
        .accounts({ nodeOwner: n3.owner.publicKey, jobAccount: jobKey, resultAccount: r3 })
        .signers([n3.owner]).rpc();

      const n1Before = await ctx.lamportsOf(n1.owner.publicKey);
      const n2Before = await ctx.lamportsOf(n2.owner.publicKey);
      const n3Before = await ctx.lamportsOf(n3.owner.publicKey);

      await ctx.program.methods.finalizeJob()
        .accounts({ jobAccount: jobKey, config: configPda(), authority: ctx.authority.publicKey })
        .remainingAccounts([
          { pubkey: r1, isSigner: false, isWritable: false },
          { pubkey: r2, isSigner: false, isWritable: false },
          { pubkey: r3, isSigner: false, isWritable: false },
          { pubkey: n1.owner.publicKey, isSigner: false, isWritable: true },
          { pubkey: n2.owner.publicKey, isSigner: false, isWritable: true },
          { pubkey: n3.owner.publicKey, isSigner: false, isWritable: true },
          { pubkey: n1.nodeKey, isSigner: false, isWritable: true },
          { pubkey: n2.nodeKey, isSigner: false, isWritable: true },
          { pubkey: n3.nodeKey, isSigner: false, isWritable: true },
        ])
        .rpc();

      const n1Gained = await ctx.lamportsOf(n1.owner.publicKey) - n1Before;
      const n2Gained = await ctx.lamportsOf(n2.owner.publicKey) - n2Before;
      const n3Gained = await ctx.lamportsOf(n3.owner.publicKey) - n3Before;

      // all 3 should earn — their errorRateBps converge even though avgLatencyMs differs
      assert.ok(Number(n1Gained) > 0, "n1 should earn (errorRateBps 3000 within consensus)");
      assert.ok(Number(n2Gained) > 0, "n2 should earn (errorRateBps 3100 within consensus)");
      assert.ok(Number(n3Gained) > 0, "n3 should earn (errorRateBps 3200 within consensus)");
    });
  });

  describe("consensus by errorRateBps (slowloris — 1 node with false errorRateBps)", () => {
    it("node with out-of-range errorRateBps earns nothing even if avgLatencyMs matches", async () => {
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, {
        minNodes: 3,
        paymentLamports: Number(PAYMENT),
        runnerType: { slowloris: {} },
      });
      const [h1, h2, cheat] = await fillJob(ctx, jobKey, 3);

      const rH1    = resultPda(jobKey, h1.owner.publicKey);
      const rH2    = resultPda(jobKey, h2.owner.publicKey);
      const rCheat = resultPda(jobKey, cheat.owner.publicKey);

      // h1, h2: errorRateBps ~3000. cheat: errorRateBps=9000 (server "down"), avgLatencyMs=0 (same as avg)
      await ctx.program.methods.submitCommitment(makeCommitment(0, 3000, 50n, 500n))
        .accounts({ nodeOwner: h1.owner.publicKey, jobAccount: jobKey, resultAccount: rH1, systemProgram: SystemProgram.programId })
        .signers([h1.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(0, 3100, 50n, 501n))
        .accounts({ nodeOwner: h2.owner.publicKey, jobAccount: jobKey, resultAccount: rH2, systemProgram: SystemProgram.programId })
        .signers([h2.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(0, 9000, 50n, 502n))
        .accounts({ nodeOwner: cheat.owner.publicKey, jobAccount: jobKey, resultAccount: rCheat, systemProgram: SystemProgram.programId })
        .signers([cheat.owner]).rpc();

      await ctx.program.methods.revealResult(0, 3000, new BN(50), new BN(500))
        .accounts({ nodeOwner: h1.owner.publicKey, jobAccount: jobKey, resultAccount: rH1 })
        .signers([h1.owner]).rpc();
      await ctx.program.methods.revealResult(0, 3100, new BN(50), new BN(501))
        .accounts({ nodeOwner: h2.owner.publicKey, jobAccount: jobKey, resultAccount: rH2 })
        .signers([h2.owner]).rpc();
      await ctx.program.methods.revealResult(0, 9000, new BN(50), new BN(502))
        .accounts({ nodeOwner: cheat.owner.publicKey, jobAccount: jobKey, resultAccount: rCheat })
        .signers([cheat.owner]).rpc();

      const h1Before    = await ctx.lamportsOf(h1.owner.publicKey);
      const h2Before    = await ctx.lamportsOf(h2.owner.publicKey);
      const cheatBefore = await ctx.lamportsOf(cheat.owner.publicKey);

      await ctx.program.methods.finalizeJob()
        .accounts({ jobAccount: jobKey, config: configPda(), authority: ctx.authority.publicKey })
        .remainingAccounts([
          { pubkey: rH1,                   isSigner: false, isWritable: false },
          { pubkey: rH2,                   isSigner: false, isWritable: false },
          { pubkey: rCheat,                isSigner: false, isWritable: false },
          { pubkey: h1.owner.publicKey,    isSigner: false, isWritable: true  },
          { pubkey: h2.owner.publicKey,    isSigner: false, isWritable: true  },
          { pubkey: cheat.owner.publicKey, isSigner: false, isWritable: true  },
          { pubkey: h1.nodeKey,            isSigner: false, isWritable: true  },
          { pubkey: h2.nodeKey,            isSigner: false, isWritable: true  },
          { pubkey: cheat.nodeKey,         isSigner: false, isWritable: true  },
        ])
        .rpc();

      const h1Gained    = await ctx.lamportsOf(h1.owner.publicKey)    - h1Before;
      const h2Gained    = await ctx.lamportsOf(h2.owner.publicKey)    - h2Before;
      const cheatGained = await ctx.lamportsOf(cheat.owner.publicKey) - cheatBefore;

      // avg = (3000+3100+9000)/3 = 5033, tolerance = max(5033/5, 500) = 1006
      // |3000-5033| = 2033 > 1006 → ✗   |3100-5033| = 1933 > 1006 → ✗   |9000-5033| = 3967 > 1006 → ✗
      // All out — cheat has the biggest impact but honest nodes also fall out.
      // Fallback goes to deployer.
      // What we verify: cheat cannot report the same avgLatencyMs=0 as everyone
      // and escape — consensus evaluates errorRateBps.
      const cheatData = await ctx.program.account.nodeAccount.fetch(cheat.nodeKey);
      assert.ok(Number(cheatGained) <= 0, "node with errorRateBps 9000 must not earn");
      assert.ok(cheatData.reputation < 100, "cheat must lose reputation");
    });
  });

  // ─── All nodes dishonest ──────────────────────────────────────────────────

  describe("cycle where all nodes are dishonest", () => {
    it("nobody earns — the 95% goes to the deployer as fallback", async () => {
      // If honest_count = 0, payment_per_honest = 0 and distributable goes to authority
      const PAYMENT = 10_000_000n;
      const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: Number(PAYMENT) });
      const [n1, n2]   = await fillJob(ctx, jobKey, 2);

      // Completely divergent latencies → none pass the 20% consensus
      const r1 = resultPda(jobKey, n1.owner.publicKey);
      const r2 = resultPda(jobKey, n2.owner.publicKey);

      await ctx.program.methods.submitCommitment(makeCommitment(100, 0, 3_000n, 300n))
        .accounts({ nodeOwner: n1.owner.publicKey, jobAccount: jobKey, resultAccount: r1, systemProgram: SystemProgram.programId })
        .signers([n1.owner]).rpc();
      await ctx.program.methods.submitCommitment(makeCommitment(9_000, 0, 3_000n, 301n))
        .accounts({ nodeOwner: n2.owner.publicKey, jobAccount: jobKey, resultAccount: r2, systemProgram: SystemProgram.programId })
        .signers([n2.owner]).rpc();

      await ctx.program.methods.revealResult(100, 0, new BN(3_000), new BN(300))
        .accounts({ nodeOwner: n1.owner.publicKey, jobAccount: jobKey, resultAccount: r1 })
        .signers([n1.owner]).rpc();
      await ctx.program.methods.revealResult(9_000, 0, new BN(3_000), new BN(301))
        .accounts({ nodeOwner: n2.owner.publicKey, jobAccount: jobKey, resultAccount: r2 })
        .signers([n2.owner]).rpc();

      const authorityBefore = await ctx.lamportsOf(ctx.authority.publicKey);

      await ctx.program.methods.finalizeJob()
        .accounts({ jobAccount: jobKey, config: configPda(), authority: ctx.authority.publicKey })
        .remainingAccounts([
          { pubkey: r1, isSigner: false, isWritable: false },
          { pubkey: r2, isSigner: false, isWritable: false },
          { pubkey: n1.owner.publicKey, isSigner: false, isWritable: true },
          { pubkey: n2.owner.publicKey, isSigner: false, isWritable: true },
          { pubkey: n1.nodeKey,         isSigner: false, isWritable: true },
          { pubkey: n2.nodeKey,         isSigner: false, isWritable: true },
        ])
        .rpc();

      // authority receives the full payment (5% fee + 95% fallback)
      const authorityGained = await ctx.lamportsOf(ctx.authority.publicKey) - authorityBefore;
      assert.ok(Number(authorityGained) >= Number(PAYMENT) * 0.99, "deployer should receive the full payment");
    });
  });
});
