import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import { createTestContext, jobPda, TestContext } from "./helpers";

const CLAIM_COMP   = 5_000;
const DEFAULT_TYPE = { httpFlood: {} };
const DEFAULT_CFG  = Buffer.from(JSON.stringify({ method: "GET", rps_per_node: 100 }));

describe("create_job", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  async function newUser(sol = 5): Promise<Keypair> {
    const user = Keypair.generate();
    await ctx.fund(user, sol);
    return user;
  }

  async function prepare(user: Keypair): Promise<{ ts: bigint; job: PublicKey }> {
    const ts = await ctx.getTimestamp();
    return { ts, job: jobPda(user.publicKey, ts) };
  }

  it("creates a job with valid params and checks the fields", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 60, 2, 15, new BN(100_000))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.target, "https://example.com");
    assert.deepEqual(data.runnerType, { httpFlood: {} });
    assert.equal(data.durationSeconds, 60);
    assert.equal(data.minNodes, 2);
    assert.equal(data.payment.toNumber(), 100_000);
    assert.equal(data.nodesClaimed, 0);
    assert.deepEqual(data.status, { open: {} });
  });

  it("stores the runnerConfig correctly", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    const cfg = Buffer.from(JSON.stringify({ concurrent_connections: 200 }));

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", { slowloris: {} }, cfg, 30, 1, 15, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.deepEqual(data.runnerType, { slowloris: {} });
    assert.deepEqual(Buffer.from(data.runnerConfig), cfg);
  });

  it("deposits the payment in the JobAccount", async () => {
    const user    = await newUser();
    const { ts, job } = await prepare(user);
    const PAYMENT = 500_000;
    const balBefore = await ctx.lamportsOf(job);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 15, new BN(PAYMENT))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const balAfter = await ctx.lamportsOf(job);
    assert.ok(balAfter - balBefore >= BigInt(PAYMENT));
  });

  it("accepts duration = 10 (lower bound)", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 10, 1, 15, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.durationSeconds, 10);
  });

  it("accepts duration = 3600 (upper bound)", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 3600, 1, 15, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.durationSeconds, 3600);
  });

  it("accepts minNodes = 1 (lower bound)", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 15, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.minNodes, 1);
  });

  it("accepts minNodes = 10 (upper bound)", async () => {
    const user    = await newUser();
    const { ts, job } = await prepare(user);
    const payment = CLAIM_COMP * 10;

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 10, 15, new BN(payment))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.minNodes, 10);
  });

  it("accepts expiryMinutes = 5 (lower bound)", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 5, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.expiresAt.toNumber(), Number(ts) + 5 * 60);
  });

  it("accepts expiryMinutes = 30 (upper bound)", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 30, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.expiresAt.toNumber(), Number(ts) + 30 * 60);
  });

  it("computes expires_at correctly from expiryMinutes", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);

    await ctx.program.methods
      .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 20, new BN(CLAIM_COMP))
      .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    const data = await ctx.program.account.jobAccount.fetch(job);
    assert.equal(data.expiresAt.toNumber(), Number(ts) + 20 * 60);
  });

  it("fails with InvalidParams if expiryMinutes < 5", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 4, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidParams");
    }
  });

  it("fails with InvalidParams if expiryMinutes > 30", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 1, 31, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidParams");
    }
  });

  it("fails with TargetTooLong if the target exceeds 200 characters", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://" + "a".repeat(200), DEFAULT_TYPE, DEFAULT_CFG, 60, 1, 15, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "TargetTooLong");
    }
  });

  it("fails with RunnerConfigTooLarge if runner_config exceeds 500 bytes", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    const bigConfig = Buffer.alloc(501);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, bigConfig, 30, 1, 15, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "RunnerConfigTooLarge");
    }
  });

  it("fails with InvalidParams if duration < 10", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 9, 1, 15, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidParams");
    }
  });

  it("fails with InvalidParams if duration > 3600", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 3601, 1, 15, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidParams");
    }
  });

  it("fails with InvalidParams if minNodes = 0", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 0, 15, new BN(CLAIM_COMP))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidParams");
    }
  });

  it("fails with InvalidParams if minNodes > 10", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 11, 15, new BN(CLAIM_COMP * 11))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "InvalidParams");
    }
  });

  it("fails with PaymentTooLow if the payment does not cover the minimum per-node compensation", async () => {
    const user = await newUser();
    const { ts, job } = await prepare(user);
    try {
      await ctx.program.methods
        .createJob(new BN(ts.toString()), "https://example.com", DEFAULT_TYPE, DEFAULT_CFG, 30, 3, 15, new BN(CLAIM_COMP * 3 - 1))
        .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
        .signers([user])
        .rpc();
      assert.fail();
    } catch (err: any) {
      assert.include(err.toString(), "PaymentTooLow");
    }
  });
});
