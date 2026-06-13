import { Keypair, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import { createTestContext, MIN_STAKE, nodePda, TestContext } from "./helpers";

describe("register_node", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("registers a node with the exact minimum stake", async () => {
    const owner = Keypair.generate();
    await ctx.fund(owner, 2);
    const nodeKey = nodePda(owner.publicKey);

    await ctx.program.methods.registerNode(new BN(MIN_STAKE))
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, systemProgram: SystemProgram.programId })
      .signers([owner])
      .rpc();

    const node = await ctx.program.account.nodeAccount.fetch(nodeKey);
    assert.ok(node.owner.equals(owner.publicKey));
    assert.equal(node.stake.toNumber(), MIN_STAKE);
    assert.equal(node.reputation, 100);
    assert.isTrue(node.isActive);
    assert.equal(node.jobsCompleted.toNumber(), 0);
  });

  it("registers a node with stake above the minimum", async () => {
    const owner = Keypair.generate();
    await ctx.fund(owner, 5);
    const nodeKey = nodePda(owner.publicKey);
    const stake   = MIN_STAKE * 2;

    await ctx.program.methods.registerNode(new BN(stake))
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, systemProgram: SystemProgram.programId })
      .signers([owner])
      .rpc();

    const node = await ctx.program.account.nodeAccount.fetch(nodeKey);
    assert.equal(node.stake.toNumber(), stake);
  });

  it("transfers the stake to the NodeAccount", async () => {
    const owner = Keypair.generate();
    await ctx.fund(owner, 2);
    const nodeKey     = nodePda(owner.publicKey);
    const balBefore   = await ctx.lamportsOf(nodeKey);

    await ctx.program.methods.registerNode(new BN(MIN_STAKE))
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, systemProgram: SystemProgram.programId })
      .signers([owner])
      .rpc();

    const balAfter = await ctx.lamportsOf(nodeKey);
    // account receives at least MIN_STAKE (plus rent paid by Anchor)
    assert.ok(balAfter - balBefore >= BigInt(MIN_STAKE));
  });

  it("fails with StakeTooLow when stake is below the minimum", async () => {
    const owner = Keypair.generate();
    await ctx.fund(owner, 2);
    try {
      await ctx.program.methods.registerNode(new BN(MIN_STAKE - 1))
        .accounts({ owner: owner.publicKey, nodeAccount: nodePda(owner.publicKey), systemProgram: SystemProgram.programId })
        .signers([owner])
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "StakeTooLow");
    }
  });
});
