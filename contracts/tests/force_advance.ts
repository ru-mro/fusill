import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  createTestContext, registerNode, createJob, fillJob,
  submitAllCommitments, TestContext,
} from "./helpers";

describe("force_advance", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("advances Running → RevealPhase when commit_deadline has expired and at least one commit exists", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 10 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);

    // Only node1 commits — node2 does not
    await submitAllCommitments(ctx, jobKey, [node1], 100, 1n);

    // Advance past the commit_deadline (10s + 120s buffer = 130s)
    await ctx.advanceTime(200);

    await ctx.program.methods.forceAdvance()
      .accounts({ jobAccount: jobKey })
      .remainingAccounts([
        { pubkey: node2.nodeKey, isSigner: false, isWritable: true },
      ])
      .rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { revealPhase: {} });
    assert.ok(job.revealDeadline.toNumber() > 0);
  });

  it("penalizes the absent node's reputation on force_advance", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 10 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);

    await submitAllCommitments(ctx, jobKey, [node1], 100, 10n);
    await ctx.advanceTime(200);

    const repBefore = (await ctx.program.account.nodeAccount.fetch(node2.nodeKey)).reputation;

    await ctx.program.methods.forceAdvance()
      .accounts({ jobAccount: jobKey })
      .remainingAccounts([{ pubkey: node2.nodeKey, isSigner: false, isWritable: true }])
      .rpc();

    const repAfter = (await ctx.program.account.nodeAccount.fetch(node2.nodeKey)).reputation;
    // REPUTATION_PENALTY_ABSENT = 20
    assert.equal(repAfter, repBefore - 20);
  });

  it("advances RevealPhase → PendingFinalization when the reveal_deadline has expired", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 10 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);
    const nodeResults    = await submitAllCommitments(ctx, jobKey, [node1, node2], 100, 20n);

    // Only node1 reveals
    await ctx.program.methods
      .revealResult(100, 0, new BN(3_000), new BN(nodeResults[0].nonce.toString()))
      .accounts({ nodeOwner: nodeResults[0].owner.publicKey, jobAccount: jobKey, resultAccount: nodeResults[0].resultKey })
      .signers([nodeResults[0].owner]).rpc();

    // Advance past the reveal_deadline (2 min)
    await ctx.advanceTime(200);

    await ctx.program.methods.forceAdvance()
      .accounts({ jobAccount: jobKey })
      .remainingAccounts([])
      .rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { pendingFinalization: {} });
  });

  it("fails with DeadlineNotReached when the deadline has not yet expired", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 60 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);

    await submitAllCommitments(ctx, jobKey, [node1], 100, 30n);
    // Do not advance time — deadline has not expired yet

    try {
      await ctx.program.methods.forceAdvance()
        .accounts({ jobAccount: jobKey })
        .remainingAccounts([{ pubkey: node2.nodeKey, isSigner: false, isWritable: true }])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "DeadlineNotReached");
    }
  });

  it("fails with NoParticipantsYet when no node committed before the deadline expired", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 10 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);

    // Nobody commits — advance anyway
    await ctx.advanceTime(200);

    try {
      await ctx.program.methods.forceAdvance()
        .accounts({ jobAccount: jobKey })
        .remainingAccounts([
          { pubkey: node1.nodeKey, isSigner: false, isWritable: true },
          { pubkey: node2.nodeKey, isSigner: false, isWritable: true },
        ])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "NoParticipantsYet");
    }
  });

  it("fails with InvalidJobStatus when the job is not in Running or RevealPhase", async () => {
    const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    // Job is in Open → invalid status for force_advance

    try {
      await ctx.program.methods.forceAdvance()
        .accounts({ jobAccount: jobKey })
        .remainingAccounts([])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidJobStatus");
    }
  });
});
