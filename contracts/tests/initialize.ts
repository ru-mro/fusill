import { SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { createTestContext, configPda, TestContext } from "./helpers";

describe("initialize", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  it("creates the Config account with the correct authority", async () => {
    const cfg = configPda();

    await ctx.program.methods.initialize()
      .accounts({ authority: ctx.authority.publicKey, config: cfg, systemProgram: SystemProgram.programId })
      .signers([ctx.authority])
      .rpc();

    const data = await ctx.program.account.config.fetch(cfg);
    assert.ok(data.authority.equals(ctx.authority.publicKey));
  });
});
