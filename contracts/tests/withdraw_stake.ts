import { assert } from "chai";
import { createTestContext, registerNode, MIN_STAKE, INCINERATOR, TestContext } from "./helpers";

describe("withdraw_stake", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("refunds 100% when reputation is >= 80 (exact boundary: 80)", async () => {
    const { owner, nodeKey } = await registerNode(ctx);
    await ctx.setNodeReputation(nodeKey, 80);
    const balBefore = await ctx.lamportsOf(owner.publicKey);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    const balAfter = await ctx.lamportsOf(owner.publicKey);
    assert.ok(balAfter > balBefore, "should have received the stake back");

    const node = await ctx.program.account.nodeAccount.fetch(nodeKey);
    assert.isFalse(node.isActive);
    assert.equal(node.stake.toNumber(), 0);
  });

  it("refunds 100% when reputation is 100 (normal exit case)", async () => {
    const { owner, nodeKey } = await registerNode(ctx);
    // reputation = 100 by default after registration
    const balBefore = await ctx.lamportsOf(owner.publicKey);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    const balAfter = await ctx.lamportsOf(owner.publicKey);
    assert.ok(balAfter > balBefore);
  });

  it("refunds 50% and burns 50% when reputation is 50-79 (exact boundary: 79)", async () => {
    const { owner, nodeKey } = await registerNode(ctx);
    await ctx.setNodeReputation(nodeKey, 79);
    const balBefore = await ctx.lamportsOf(owner.publicKey);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    const balAfter = await ctx.lamportsOf(owner.publicKey);
    // Received something but less than the full stake
    assert.ok(balAfter > balBefore, "should have received at least 50%");
    // Did not receive the full stake
    assert.ok(balAfter < balBefore + BigInt(MIN_STAKE), "should not have received 100%");
  });

  it("refunds 50% when reputation is exactly 50", async () => {
    const { owner, nodeKey } = await registerNode(ctx);
    await ctx.setNodeReputation(nodeKey, 50);
    const balBefore = await ctx.lamportsOf(owner.publicKey);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    const balAfter = await ctx.lamportsOf(owner.publicKey);
    assert.ok(balAfter > balBefore);
    assert.ok(balAfter < balBefore + BigInt(MIN_STAKE));
  });

  it("burns 100% when reputation is < 50 (exact boundary: 49)", async () => {
    const { owner, nodeKey } = await registerNode(ctx);
    await ctx.setNodeReputation(nodeKey, 49);
    const balBefore = await ctx.lamportsOf(owner.publicKey);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    // The node received no stake (the difference would be negative or zero ignoring fees)
    const balAfter = await ctx.lamportsOf(owner.publicKey);
    const gained   = balAfter > balBefore ? balAfter - balBefore : 0n;
    assert.ok(gained < BigInt(MIN_STAKE / 2), "should not have received stake with rep 49");

    const node = await ctx.program.account.nodeAccount.fetch(nodeKey);
    assert.isFalse(node.isActive);
    assert.equal(node.stake.toNumber(), 0);
  });

  it("burns 100% when reputation is 0", async () => {
    const { owner, nodeKey } = await registerNode(ctx);
    await ctx.setNodeReputation(nodeKey, 0);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    const node = await ctx.program.account.nodeAccount.fetch(nodeKey);
    assert.isFalse(node.isActive);
    assert.equal(node.stake.toNumber(), 0);
  });

  it("fails if the node is no longer active (double withdraw)", async () => {
    const { owner, nodeKey } = await registerNode(ctx);

    await ctx.program.methods.withdrawStake()
      .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
      .signers([owner])
      .rpc();

    // Advance slot so the second tx has a different blockhash (avoids duplicate-tx rejection)
    await ctx.context.warpToSlot(await ctx.context.banksClient.getSlot() + 1n);

    try {
      await ctx.program.methods.withdrawStake()
        .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, incinerator: INCINERATOR })
        .signers([owner])
        .rpc();
      assert.fail("should have failed");
    } catch (err: any) {
      assert.include(err.toString(), "NodeNotActive");
    }
  });
});
