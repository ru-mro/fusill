import { assert } from "chai";
import {
  createTestContext, registerNode, createJob, fillJob,
  resultPda, makeCommitment, TestContext,
} from "./helpers";

describe("submit_commitment", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("the first commit does not change the job status (second still pending)", async () => {
    const { jobKey }    = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);
    const resultKey     = resultPda(jobKey, node1.owner.publicKey);
    const commitment    = makeCommitment(100, 0, 3_000n, 1n);

    await ctx.program.methods.submitCommitment(commitment)
      .accounts({ nodeOwner: node1.owner.publicKey, jobAccount: jobKey, resultAccount: resultKey, systemProgram: ctx.program.provider.connection.rpcEndpoint as any })
      .signers([node1.owner])
      .rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { running: {} });
    assert.equal(job.commitsSubmitted, 1);
  });

  it("when all nodes commit → job moves to RevealPhase with reveal_deadline set", async () => {
    const { jobKey }    = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);

    await ctx.program.methods.submitCommitment(makeCommitment(100, 0, 3_000n, 1n))
      .accounts({ nodeOwner: node1.owner.publicKey, jobAccount: jobKey, resultAccount: resultPda(jobKey, node1.owner.publicKey), systemProgram: ctx.program.provider.connection.rpcEndpoint as any })
      .signers([node1.owner]).rpc();

    await ctx.program.methods.submitCommitment(makeCommitment(110, 0, 3_000n, 2n))
      .accounts({ nodeOwner: node2.owner.publicKey, jobAccount: jobKey, resultAccount: resultPda(jobKey, node2.owner.publicKey), systemProgram: ctx.program.provider.connection.rpcEndpoint as any })
      .signers([node2.owner]).rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { revealPhase: {} });
    assert.equal(job.commitsSubmitted, 2);
    assert.ok(job.revealDeadline.toNumber() > 0);
  });

  it("fails with JobNotRunning if the job is in Open state (no nodes yet)", async () => {
    const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const node       = await registerNode(ctx);
    const resultKey  = resultPda(jobKey, node.owner.publicKey);

    try {
      await ctx.program.methods.submitCommitment(makeCommitment(100, 0, 3_000n, 1n))
        .accounts({ nodeOwner: node.owner.publicKey, jobAccount: jobKey, resultAccount: resultKey, systemProgram: ctx.program.provider.connection.rpcEndpoint as any })
        .signers([node.owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "JobNotRunning");
    }
  });

  it("fails with CommitDeadlinePassed if the commit is sent late", async () => {
    const { jobKey }     = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000, duration: 10 });
    const [node1, node2] = await fillJob(ctx, jobKey, 2);
    const resultKey      = resultPda(jobKey, node1.owner.publicKey);

    // commit_deadline = created_at + 10s (duration) + 120s (buffer) ≈ 130s
    await ctx.advanceTime(200);

    try {
      await ctx.program.methods.submitCommitment(makeCommitment(100, 0, 3_000n, 1n))
        .accounts({ nodeOwner: node1.owner.publicKey, jobAccount: jobKey, resultAccount: resultKey, systemProgram: ctx.program.provider.connection.rpcEndpoint as any })
        .signers([node1.owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "CommitDeadlinePassed");
    }
  });
});
