import { Keypair, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import { createTestContext, registerNode, createJob, fillJob, TestContext } from "./helpers";

// CLAIM_COMPENSATION_LAMPORTS = 5_000 (defined in the contract)
const CLAIM_COMP = 5_000;

describe("cancel_job", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("returns the full payment to the user if it expired with no nodes", async () => {
    const { user, jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 1_000_000 });
    await ctx.advanceTime(16 * 60); // 15 min expiry

    const balBefore = await ctx.lamportsOf(user.publicKey);

    await ctx.program.methods.cancelJob()
      .accounts({ user: user.publicKey, jobAccount: jobKey })
      .remainingAccounts([])
      .signers([user]).rpc();

    const job      = await ctx.program.account.jobAccount.fetch(jobKey);
    const balAfter = await ctx.lamportsOf(user.publicKey);

    assert.deepEqual(job.status, { cancelled: {} });
    assert.ok(balAfter > balBefore, "the user should recover the payment");
  });

  it("compensates nodes that claimed and refunds the rest to the user", async () => {
    const { user, jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 1_000_000 });
    const node             = await registerNode(ctx);

    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node.owner.publicKey, nodeAccount: node.nodeKey, jobAccount: jobKey })
      .signers([node.owner]).rpc();

    await ctx.advanceTime(16 * 60);

    const nodeBefore = await ctx.lamportsOf(node.owner.publicKey);
    const userBefore = await ctx.lamportsOf(user.publicKey);

    await ctx.program.methods.cancelJob()
      .accounts({ user: user.publicKey, jobAccount: jobKey })
      .remainingAccounts([
        { pubkey: node.owner.publicKey, isSigner: false, isWritable: true },
      ])
      .signers([user]).rpc();

    const nodeAfter = await ctx.lamportsOf(node.owner.publicKey);
    const userAfter = await ctx.lamportsOf(user.publicKey);

    // The node received exactly CLAIM_COMPENSATION_LAMPORTS
    assert.equal(Number(nodeAfter - nodeBefore), CLAIM_COMP);
    // The user recovered the rest
    assert.ok(userAfter > userBefore);
  });

  it("the user refund is payment minus compensations when there are nodes", async () => {
    const { user, jobKey } = await createJob(ctx, { minNodes: 3, paymentLamports: 1_000_000 });
    const node1 = await registerNode(ctx);
    const node2 = await registerNode(ctx);

    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node1.owner.publicKey, nodeAccount: node1.nodeKey, jobAccount: jobKey })
      .signers([node1.owner]).rpc();
    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node2.owner.publicKey, nodeAccount: node2.nodeKey, jobAccount: jobKey })
      .signers([node2.owner]).rpc();

    await ctx.advanceTime(16 * 60);

    const userBefore = await ctx.lamportsOf(user.publicKey);

    await ctx.program.methods.cancelJob()
      .accounts({ user: user.publicKey, jobAccount: jobKey })
      .remainingAccounts([
        { pubkey: node1.owner.publicKey, isSigner: false, isWritable: true },
        { pubkey: node2.owner.publicKey, isSigner: false, isWritable: true },
      ])
      .signers([user]).rpc();

    const userAfter = await ctx.lamportsOf(user.publicKey);
    // Expected refund = 1_000_000 - 2 * 5_000 = 990_000
    const expectedRefund = 1_000_000 - CLAIM_COMP * 2;
    const actualRefund   = Number(userAfter - userBefore);
    assert.ok(actualRefund >= expectedRefund, `expected refund >= ${expectedRefund}, got ${actualRefund}`);
  });

  it("fails with JobNotExpired if the job has not expired yet", async () => {
    const { user, jobKey } = await createJob(ctx, { minNodes: 2, paymentLamports: 1_000_000 });
    try {
      await ctx.program.methods.cancelJob()
        .accounts({ user: user.publicKey, jobAccount: jobKey })
        .remainingAccounts([])
        .signers([user]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "JobNotExpired");
    }
  });

  it("fails with Unauthorized if not the job owner", async () => {
    const { jobKey }  = await createJob(ctx, { minNodes: 2, paymentLamports: 1_000_000 });
    const intruder    = Keypair.generate();
    await ctx.fund(intruder, 1);
    await ctx.advanceTime(16 * 60);

    try {
      await ctx.program.methods.cancelJob()
        .accounts({ user: intruder.publicKey, jobAccount: jobKey })
        .remainingAccounts([])
        .signers([intruder]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  it("fails with JobNotOpen if the job is already Running", async () => {
    const { user, jobKey } = await createJob(ctx, { minNodes: 1, paymentLamports: 10_000 });
    await fillJob(ctx, jobKey, 1); // → Running

    await ctx.advanceTime(16 * 60);

    try {
      await ctx.program.methods.cancelJob()
        .accounts({ user: user.publicKey, jobAccount: jobKey })
        .remainingAccounts([])
        .signers([user]).rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "JobNotOpen");
    }
  });
});
