import { Keypair, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  createTestContext, registerNode, createJob, fillJob,
  MIN_STAKE, INCINERATOR, nodePda, TestContext,
} from "./helpers";

describe("claim_job", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("node1 claims → job stays Open with nodes_claimed=1", async () => {
    const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const node1      = await registerNode(ctx);

    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node1.owner.publicKey, nodeAccount: node1.nodeKey, jobAccount: jobKey })
      .signers([node1.owner])
      .rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.equal(job.nodesClaimed, 1);
    assert.deepEqual(job.status, { open: {} });
    assert.ok(job.claimedNodes[0].equals(node1.owner.publicKey));
  });

  it("last node fills the quota → job moves to Running and sets commit_deadline", async () => {
    const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const node1      = await registerNode(ctx);
    const node2      = await registerNode(ctx);

    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node1.owner.publicKey, nodeAccount: node1.nodeKey, jobAccount: jobKey })
      .signers([node1.owner]).rpc();

    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node2.owner.publicKey, nodeAccount: node2.nodeKey, jobAccount: jobKey })
      .signers([node2.owner]).rpc();

    const job = await ctx.program.account.jobAccount.fetch(jobKey);
    assert.deepEqual(job.status, { running: {} });
    assert.equal(job.nodesClaimed, 2);
    assert.ok(job.commitDeadline.toNumber() > 0);
  });

  it("fails with JobNotOpen if the job is already Running (quota already full)", async () => {
    // Create a job with minNodes=1 → the first claim already moves it to Running
    const { jobKey } = await createJob(ctx, { minNodes: 1, paymentLamports: 10_000 });
    const node1      = await registerNode(ctx);
    const node2      = await registerNode(ctx);

    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node1.owner.publicKey, nodeAccount: node1.nodeKey, jobAccount: jobKey })
      .signers([node1.owner]).rpc();

    // Job is now Running → attempt by a second node
    try {
      await ctx.program.methods.claimJob()
        .accounts({ nodeOwner: node2.owner.publicKey, nodeAccount: node2.nodeKey, jobAccount: jobKey })
        .signers([node2.owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "JobNotOpen");
    }
  });

  it("fails with JobExpired if the job expired before filling", async () => {
    const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const node       = await registerNode(ctx);

    // Advance past the 15-minute expiry
    await ctx.advanceTime(16 * 60);

    try {
      await ctx.program.methods.claimJob()
        .accounts({ nodeOwner: node.owner.publicKey, nodeAccount: node.nodeKey, jobAccount: jobKey })
        .signers([node.owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "JobExpired");
    }
  });

  it("fails with NodeNotActive if the node deregistered before claiming", async () => {
    const { jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 100_000 });
    const node       = await registerNode(ctx);

    // Withdraw the stake → node becomes inactive
    await ctx.program.methods.withdrawStake()
      .accounts({ owner: node.owner.publicKey, nodeAccount: node.nodeKey, incinerator: INCINERATOR })
      .signers([node.owner]).rpc();

    try {
      await ctx.program.methods.claimJob()
        .accounts({ nodeOwner: node.owner.publicKey, nodeAccount: node.nodeKey, jobAccount: jobKey })
        .signers([node.owner]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "NodeNotActive");
    }
  });
});
