/**
 * Shared utilities for all test files.
 * Contains no tests — only helpers, PDAs, and the bankrun context factory.
 */

import { BN, Program } from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Clock } from "solana-bankrun";
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "fs";
import type { Fusill } from "../target/types/fusill";
const idl = JSON.parse(readFileSync("target/idl/fusill.json", "utf8"));

// ─── Contract constants ───────────────────────────────────────────────────────

export const PROGRAM_ID  = new PublicKey("G6xojg6mCoin9HnQ1Nv1sXJyLTgjrNpY7M2CioW1Dy2c");
export const MIN_STAKE   = 500_000_000; // 0.5 SOL
export const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

// ─── PDAs ─────────────────────────────────────────────────────────────────────

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
}

export function nodePda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("node"), owner.toBuffer()],
    PROGRAM_ID
  )[0];
}

/**
 * The job seed includes the i64 LE timestamp at creation time.
 * Read the timestamp BEFORE sending the tx — bankrun's clock does not advance
 * unless setClock is called explicitly.
 */
export function jobPda(user: PublicKey, timestampSecs: bigint): PublicKey {
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64LE(timestampSecs);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("job"), user.toBuffer(), tsBuf],
    PROGRAM_ID
  )[0];
}

export function resultPda(job: PublicKey, nodeOwner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("result"), job.toBuffer(), nodeOwner.toBuffer()],
    PROGRAM_ID
  )[0];
}

// ─── Cryptography ─────────────────────────────────────────────────────────────

/**
 * Replicates the hash computed by the contract in reveal_result:
 *   keccak256(latency_le4 || error_rate_le4 || requests_le8 || nonce_le8)
 */
export function makeCommitment(
  avgLatencyMs: number,
  errorRateBps: number,
  requestsCompleted: bigint,
  nonce: bigint
): number[] {
  const buf = Buffer.alloc(4 + 4 + 8 + 8);
  buf.writeUInt32LE(avgLatencyMs,  0);
  buf.writeUInt32LE(errorRateBps,  4);
  buf.writeBigUInt64LE(requestsCompleted,  8);
  buf.writeBigUInt64LE(nonce, 16);
  return Array.from(keccak_256(buf));
}

// ─── Test context ─────────────────────────────────────────────────────────────

export type TestContext = {
  context:   Awaited<ReturnType<typeof startAnchor>>;
  program:   Program<Fusill>;
  authority: Keypair;
  fund(kp: Keypair, sol: number): Promise<void>;
  getTimestamp(): Promise<bigint>;
  advanceTime(seconds: number): Promise<void>;
  lamportsOf(pk: PublicKey): Promise<bigint>;
  setNodeReputation(nodeKey: PublicKey, rep: number): Promise<void>;
};

/** Creates a clean bankrun context for each test file. */
export async function createTestContext(): Promise<TestContext> {
  const authority = Keypair.generate();

  const context = await startAnchor(".", [], [
    {
      address: authority.publicKey,
      info: {
        lamports:   BigInt(10 * LAMPORTS_PER_SOL),
        data:       Buffer.alloc(0),
        owner:      SystemProgram.programId,
        executable: false,
      },
    },
  ]);

  const provider = new BankrunProvider(context);
  const program = new Program<Fusill>(idl, provider);

  async function fund(kp: Keypair, sol: number) {
    await context.setAccount(kp.publicKey, {
      lamports:   BigInt(sol * LAMPORTS_PER_SOL),
      data:       Buffer.alloc(0),
      owner:      SystemProgram.programId,
      executable: false,
    });
  }

  async function getTimestamp(): Promise<bigint> {
    const clock = await context.banksClient.getClock();
    return clock.unixTimestamp;
  }

  async function advanceTime(seconds: number) {
    const clock = await context.banksClient.getClock();
    await context.setClock(new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      clock.unixTimestamp + BigInt(seconds)
    ));
  }

  async function lamportsOf(pk: PublicKey): Promise<bigint> {
    const acc = await context.banksClient.getAccount(pk);
    return acc ? BigInt(acc.lamports) : 0n;
  }

  async function setNodeReputation(nodeKey: PublicKey, rep: number) {
    const raw = await context.banksClient.getAccount(nodeKey);
    if (!raw) throw new Error("NodeAccount not found");
    const data = Buffer.from(raw.data);
    // Layout after discriminator (8 bytes):
    //   owner:32, stake:8, jobs_completed:8, reputation:1
    data.writeUInt8(rep, 8 + 32 + 8 + 8);
    await context.setAccount(nodeKey, {
      lamports:   raw.lamports,
      data,
      owner:      PROGRAM_ID,
      executable: false,
    });
  }

  return { context, program, authority, fund, getTimestamp, advanceTime, lamportsOf, setNodeReputation };
}

// ─── Reusable setup flows ─────────────────────────────────────────────────────

/** Calls initialize and returns the config PDA. */
export async function initializeProgram(ctx: TestContext): Promise<PublicKey> {
  const cfg = configPda();
  await ctx.program.methods.initialize()
    .accounts({ authority: ctx.authority.publicKey, config: cfg, systemProgram: SystemProgram.programId })
    .signers([ctx.authority])
    .rpc();
  return cfg;
}

/** Registers a new node and returns the owner keypair and its PDA. */
export async function registerNode(
  ctx: TestContext,
  solFund = 2
): Promise<{ owner: Keypair; nodeKey: PublicKey }> {
  const owner = Keypair.generate();
  await ctx.fund(owner, solFund);
  const nodeKey = nodePda(owner.publicKey);
  await ctx.program.methods.registerNode(new BN(MIN_STAKE))
    .accounts({ owner: owner.publicKey, nodeAccount: nodeKey, systemProgram: SystemProgram.programId })
    .signers([owner])
    .rpc();
  return { owner, nodeKey };
}

/** Creates a job and returns the user keypair and its PDA. */
export async function createJob(
  ctx: TestContext,
  opts: {
    minNodes?:        number;
    paymentLamports?: number;
    target?:          string;
    runnerType?:      Record<string, Record<string, never>>;
    runnerConfig?:    Buffer;
    duration?:        number;
    expiryMinutes?:   number;
  } = {}
): Promise<{ user: Keypair; jobKey: PublicKey }> {
  const {
    minNodes        = 1,
    paymentLamports = 1_000_000,
    target          = "https://test.fusill.io",
    runnerType      = { httpFlood: {} },
    runnerConfig    = Buffer.from(JSON.stringify({ method: "GET", rps_per_node: 100 })),
    duration        = 30,
    expiryMinutes   = 15,
  } = opts;

  const user = Keypair.generate();
  await ctx.fund(user, 5);
  const ts  = await ctx.getTimestamp();
  const job = jobPda(user.publicKey, ts);

  await ctx.program.methods
    .createJob(new BN(ts.toString()), target, runnerType, runnerConfig, duration, minNodes, expiryMinutes, new BN(paymentLamports))
    .accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
    .signers([user])
    .rpc();

  return { user, jobKey: job };
}

/**
 * Brings the job to Running state:
 * creates N nodes, all of which claim the given job.
 */
export async function fillJob(
  ctx: TestContext,
  jobKey: PublicKey,
  minNodes: number
): Promise<{ owner: Keypair; nodeKey: PublicKey }[]> {
  const nodes: { owner: Keypair; nodeKey: PublicKey }[] = [];
  for (let i = 0; i < minNodes; i++) {
    const node = await registerNode(ctx);
    await ctx.program.methods.claimJob()
      .accounts({ nodeOwner: node.owner.publicKey, nodeAccount: node.nodeKey, jobAccount: jobKey })
      .signers([node.owner])
      .rpc();
    nodes.push(node);
  }
  return nodes;
}

/**
 * Brings the job to RevealPhase:
 * all nodes submit their commitment.
 * Returns the nodes with their reveal parameters.
 */
export async function submitAllCommitments(
  ctx: TestContext,
  jobKey: PublicKey,
  nodes: { owner: Keypair; nodeKey: PublicKey }[],
  latency = 100,
  nonce   = 42n
): Promise<{ owner: Keypair; nodeKey: PublicKey; resultKey: PublicKey; latency: number; nonce: bigint }[]> {
  const results = [];
  for (const node of nodes) {
    const resultKey = resultPda(jobKey, node.owner.publicKey);
    const commitment = makeCommitment(latency, 0, 3_000n, nonce);
    await ctx.program.methods.submitCommitment(commitment)
      .accounts({ nodeOwner: node.owner.publicKey, jobAccount: jobKey, resultAccount: resultKey, systemProgram: SystemProgram.programId })
      .signers([node.owner])
      .rpc();
    results.push({ ...node, resultKey, latency, nonce });
    nonce++;
  }
  return results;
}
