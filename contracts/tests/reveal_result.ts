import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  createTestContext, registerNode, createJob, fillJob,
  submitAllCommitments, resultPda, makeCommitment, TestContext,
} from "./helpers";

describe("reveal_result", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("the first reveal does not change the job status (second still pending)", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const nodes          = await fillJob(ctx, jobKey, 2);
    const nodeResults    = await submitAllCommitments(ctx, jobKey, nodes, 150, 10n);

    await ctx.program.methods
      .revealResult(150, 0, new BN(3_000), new BN(10))
      .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
      .signers([nodeResults[0].owner]).rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { revealPhase: {} });
    assert.equal(job.revealsSubmitted, 1);
  });

  it("when everyone reveals → job moves to PendingFinalization", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const nodes       = await fillJob(ctx, jobKey, 2);
    const nodeResults = await submitAllCommitments(ctx, jobKey, nodes, 150, 20n);

    for (const r of nodeResults) {
      await ctx.program.methods
        .revealResult(150, 0, new BN(3_000), new BN(r.nonce.toString()))
        .accounts({ nodeOwner: r.owner.publicKey, jobAccount: jobKey, resultAccount: r.resultKey })
        .signers([r.owner]).rpc();
    }

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { pendingFinalization: {} });
    assert.equal(job.revealsSubmitted, 2);
  });

  it("fails with CommitmentMismatch if the nonce is wrong", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const nodes       = await fillJob(ctx, jobKey, 2);
    const nodeResults = await submitAllCommitments(ctx, jobKey, nodes, 150, 30n);

    try {
      // Reveal with a nonce different from the commitment
      await ctx.program.methods
        .revealResult(150, 0, new BN(3_000), new BN(99999))
        .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
        .signers([nodeResults[0].owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "CommitmentMismatch");
    }
  });

  it("fails with CommitmentMismatch if the latency is wrong", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const nodes       = await fillJob(ctx, jobKey, 2);
    const nodeResults = await submitAllCommitments(ctx, jobKey, nodes, 150, 40n);

    try {
      // The commitment was for latency=150 but reveals with 999
      await ctx.program.methods
        .revealResult(999, 0, new BN(3_000), new BN(nodeResults[0].nonce.toString()))
        .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
        .signers([nodeResults[0].owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "CommitmentMismatch");
    }
  });

  it("fails with AlreadyRevealed if the same node tries to reveal twice", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const nodes       = await fillJob(ctx, jobKey, 2);
    const nodeResults = await submitAllCommitments(ctx, jobKey, nodes, 150, 50n);

    await ctx.program.methods
      .revealResult(150, 0, new BN(3_000), new BN(nodeResults[0].nonce.toString()))
      .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
      .signers([nodeResults[0].owner]).rpc();

    // Advance slot so the second tx has a different blockhash (avoids duplicate-tx rejection)
    await ctx.context.warpToSlot(await ctx.context.banksClient.getSlot() + 1n);

    try {
      await ctx.program.methods
        .revealResult(150, 0, new BN(3_000), new BN(nodeResults[0].nonce.toString()))
        .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
        .signers([nodeResults[0].owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "AlreadyRevealed");
    }
  });

  it("fails with JobNotInRevealPhase if the job is still Running", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const nodes       = await fillJob(ctx, jobKey, 2);
    // We don't submit commitments → job stays Running
    const fakeResultKey = resultPda(jobKey, nodes[0].owner.publicKey);

    try {
      await ctx.program.methods
        .revealResult(150, 0, new BN(3_000), new BN(1))
        .accounts({ nodeOwner: nodes[0].owner.publicKey, jobAccount: jobKey, resultAccount: fakeResultKey })
        .signers([nodes[0].owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "JobNotInRevealPhase");
    }
  });

  it("fails with RevealDeadlinePassed if the reveal is sent late", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 10 });
    const nodes       = await fillJob(ctx, jobKey, 2);
    const nodeResults = await submitAllCommitments(ctx, jobKey, nodes, 150, 60n);
    // Job now in RevealPhase. Advance past the reveal_deadline (2 min)
    await ctx.advanceTime(200);

    try {
      await ctx.program.methods
        .revealResult(150, 0, new BN(3_000), new BN(nodeResults[0].nonce.toString()))
        .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
        .signers([nodeResults[0].owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "RevealDeadlinePassed");
    }
  });
});
