/**
 * Consensus tests for the node-client:
 *
 * 1. buildCommitment — determinism, sensitivity, size
 * 2. generateNonce   — entropy, uniqueness
 * 3. Cross-layer     — the hash from buildCommitment is accepted by the Rust
 *                      contract in bankrun (verifies that JS and Rust use the same
 *                      algorithm and the same byte order)
 */

import { Keypair, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { BN, Program } = anchorPkg;
import { BankrunProvider, startAnchor } from 'anchor-bankrun';
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildCommitment, generateNonce } from '../src/commitment.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CONTRACTS  = join(__dirname, '../../contracts');
// FUSILL_IDL lets local runs point at a freshly built IDL when target/ is not writable.
const IDL_PATH   = process.env.FUSILL_IDL ?? join(CONTRACTS, 'target/idl/fusill.json');
const IDL        = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
const PROGRAM_ID = new PublicKey(IDL.address);

// ─── PDAs ─────────────────────────────────────────────────────────────────────

function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];
}
function nodePda(owner) {
  return PublicKey.findProgramAddressSync([Buffer.from('node'), owner.toBuffer()], PROGRAM_ID)[0];
}
function jobPda(user, ts) {
  const b = Buffer.alloc(8); b.writeBigInt64LE(ts);
  return PublicKey.findProgramAddressSync([Buffer.from('job'), user.toBuffer(), b], PROGRAM_ID)[0];
}
function resultPda(job, nodeOwner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('result'), job.toBuffer(), nodeOwner.toBuffer()], PROGRAM_ID
  )[0];
}

// ─── Tests: buildCommitment ───────────────────────────────────────────────────

describe('buildCommitment', () => {
  // signature: buildCommitment(avgLatencyMs, errorRateBps, requestsCompleted, baselineLatencyMs, nonce)
  it('is deterministic: same input → same hash', () => {
    const h1 = buildCommitment(100, 500, 3000n, 5, 42n);
    const h2 = buildCommitment(100, 500, 3000n, 5, 42n);
    assert.ok(h1.equals(h2), 'hash must be identical for the same inputs');
  });

  it('returns a 32-byte Buffer (keccak256)', () => {
    const h = buildCommitment(0, 0, 0n, 0, 0n);
    assert.ok(Buffer.isBuffer(h), 'must be a Buffer');
    assert.equal(h.length, 32, 'keccak256 produces 32 bytes');
  });

  it('is sensitive to avgLatencyMs — a 1ms change produces a different hash', () => {
    const h1 = buildCommitment(100, 500, 3000n, 5, 42n);
    const h2 = buildCommitment(101, 500, 3000n, 5, 42n);
    assert.ok(!h1.equals(h2), 'changing avgLatencyMs must change the hash');
  });

  it('is sensitive to errorRateBps — the error rate cannot be faked', () => {
    const h1 = buildCommitment(100, 500,  3000n, 5, 42n);
    const h2 = buildCommitment(100, 5000, 3000n, 5, 42n);
    assert.ok(!h1.equals(h2), 'changing errorRateBps must change the hash');
  });

  it('is sensitive to requestsCompleted — the request count cannot be faked', () => {
    const h1 = buildCommitment(100, 500, 3000n, 5, 42n);
    const h2 = buildCommitment(100, 500, 9999n, 5, 42n);
    assert.ok(!h1.equals(h2), 'changing requestsCompleted must change the hash');
  });

  it('is sensitive to baselineLatencyMs — the baseline cannot be faked', () => {
    const h1 = buildCommitment(100, 500, 3000n, 5,  42n);
    const h2 = buildCommitment(100, 500, 3000n, 50, 42n);
    assert.ok(!h1.equals(h2), 'changing baselineLatencyMs must change the hash');
  });

  it('is sensitive to nonce — the nonce prevents copying commitments from other nodes', () => {
    const h1 = buildCommitment(100, 500, 3000n, 5, 42n);
    const h2 = buildCommitment(100, 500, 3000n, 5, 43n);
    assert.ok(!h1.equals(h2), 'changing the nonce must change the hash');
  });

  it('all fields at 0 produces a valid hash (does not throw)', () => {
    const h = buildCommitment(0, 0, 0n, 0, 0n);
    assert.equal(h.length, 32);
    // keccak(zeros) is known — verify it is not all zeros
    assert.ok(!h.equals(Buffer.alloc(32)), 'keccak of zeros is not zeros');
  });
});

// ─── Tests: generateNonce ────────────────────────────────────────────────────

describe('generateNonce', () => {
  it('returns a BigInt', () => {
    const n = generateNonce();
    assert.equal(typeof n, 'bigint');
  });

  it('is in the range [0, 2^64)', () => {
    const n = generateNonce();
    assert.ok(n >= 0n,          'must be >= 0');
    assert.ok(n < 2n ** 64n,    'must fit in u64');
  });

  it('generates distinct values on successive calls', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => generateNonce().toString()));
    assert.ok(nonces.size > 15, 'must have high entropy — unexpected collisions');
  });
});

// ─── Tests: cross-layer (JS ↔ Rust) ─────────────────────────────────────────

describe('cross-layer: buildCommitment verifies in the Rust contract (bankrun)', () => {
  let context, program, authority, node, user;

  before(async () => {
    // Bankrun in-process
    authority = Keypair.generate();
    node      = Keypair.generate();
    user      = Keypair.generate();

    context = await startAnchor(CONTRACTS, [], []);
    const provider = new BankrunProvider(context);
    program = new Program(IDL, provider);

    // Fund accounts
    const fund = async (kp, sol = 5) => {
      await context.setAccount(kp.publicKey, {
        lamports: BigInt(Math.floor(sol * LAMPORTS_PER_SOL)),
        data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false,
      });
    };
    await fund(authority, 10);
    await fund(node, 2);
    await fund(user, 5);

    // initialize
    await program.methods.initialize()
      .accounts({ authority: authority.publicKey, config: configPda(), systemProgram: SystemProgram.programId })
      .signers([authority]).rpc();

    // register_node
    await program.methods.registerNode(new BN(500_000_000))
      .accounts({ owner: node.publicKey, nodeAccount: nodePda(node.publicKey), systemProgram: SystemProgram.programId })
      .signers([node]).rpc();
  });

  it('reveal with correct metrics and nonce is accepted by the contract', async () => {
    const clock = await context.banksClient.getClock();
    const ts    = clock.unixTimestamp;
    const job   = jobPda(user.publicKey, ts);
    const cfg   = Buffer.from(JSON.stringify({ method: 'GET', concurrent_connections: 10 }));

    await program.methods.createJob(
      new BN(ts.toString()), 'https://example.com', { httpFlood: {} }, cfg, 10, 1, 15, new BN(5_000_000), false
    ).accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
      .signers([user]).rpc();

    await program.methods.claimJob()
      .accounts({ nodeOwner: node.publicKey, nodeAccount: nodePda(node.publicKey), jobAccount: job })
      .signers([node]).rpc();

    // Build the commitment in JS exactly as the node-client would
    const avgLatencyMs       = 123;
    const errorRateBps       = 456;
    const requestsCompleted  = 7890n;
    const baselineLatencyMs  = 7;
    const nonce              = generateNonce();

    const commitment = buildCommitment(avgLatencyMs, errorRateBps, requestsCompleted, baselineLatencyMs, nonce);
    const resultKey  = resultPda(job, node.publicKey);

    // submit_commitment — the JS hash reaches the contract
    await program.methods.submitCommitment(Array.from(commitment))
      .accounts({ nodeOwner: node.publicKey, jobAccount: job, resultAccount: resultKey, systemProgram: SystemProgram.programId })
      .signers([node]).rpc();

    // reveal_result — the contract verifies keccak(metrics||baseline||nonce) == commitment
    // If JS and Rust use the same algorithm, this does not throw CommitmentMismatch
    await program.methods.revealResult(
      avgLatencyMs,
      errorRateBps,
      new BN(requestsCompleted.toString()),
      baselineLatencyMs,
      new BN(nonce.toString()),
    ).accounts({ nodeOwner: node.publicKey, jobAccount: job, resultAccount: resultKey })
      .signers([node]).rpc();

    const result = await program.account.resultAccount.fetch(resultKey);
    assert.ok(result.revealed, 'result must be marked as revealed');
    assert.equal(result.avgLatencyMs, avgLatencyMs);
    assert.equal(result.errorRateBps, errorRateBps);
    assert.equal(result.baselineLatencyMs, baselineLatencyMs, 'baseline persisted on-chain');
  });

  it('reveal with metrics different from the commitment fails with CommitmentMismatch', async () => {
    // Fresh keypairs to avoid PDA collision with the previous test
    const user2 = Keypair.generate();
    const node2 = Keypair.generate();

    await context.setAccount(user2.publicKey, {
      lamports: BigInt(5 * LAMPORTS_PER_SOL), data: Buffer.alloc(0),
      owner: SystemProgram.programId, executable: false,
    });
    await context.setAccount(node2.publicKey, {
      lamports: BigInt(2 * LAMPORTS_PER_SOL), data: Buffer.alloc(0),
      owner: SystemProgram.programId, executable: false,
    });

    const clock = await context.banksClient.getClock();
    const ts    = clock.unixTimestamp;
    const job2  = jobPda(user2.publicKey, ts);
    const cfg   = Buffer.from(JSON.stringify({ method: 'GET', concurrent_connections: 10 }));

    await program.methods.registerNode(new BN(500_000_000))
      .accounts({ owner: node2.publicKey, nodeAccount: nodePda(node2.publicKey), systemProgram: SystemProgram.programId })
      .signers([node2]).rpc();

    await program.methods.createJob(
      new BN(ts.toString()), 'https://example.com', { httpFlood: {} }, cfg, 10, 1, 15, new BN(5_000_000), false
    ).accounts({ user: user2.publicKey, jobAccount: job2, systemProgram: SystemProgram.programId })
      .signers([user2]).rpc();

    await program.methods.claimJob()
      .accounts({ nodeOwner: node2.publicKey, nodeAccount: nodePda(node2.publicKey), jobAccount: job2 })
      .signers([node2]).rpc();

    const nonce      = generateNonce();
    const commitment = buildCommitment(100, 0, 1000n, 5, nonce);
    const resultKey2 = resultPda(job2, node2.publicKey);

    await program.methods.submitCommitment(Array.from(commitment))
      .accounts({ nodeOwner: node2.publicKey, jobAccount: job2, resultAccount: resultKey2, systemProgram: SystemProgram.programId })
      .signers([node2]).rpc();

    // Attempt to reveal with metrics DIFFERENT from those committed
    let err;
    try {
      await program.methods.revealResult(
        999,            // avgLatencyMs different from committed (100)
        0,
        new BN(1000),
        5,
        new BN(nonce.toString()),
      ).accounts({ nodeOwner: node2.publicKey, jobAccount: job2, resultAccount: resultKey2 })
        .signers([node2]).rpc();
    } catch (e) {
      err = e;
    }

    assert.ok(err, 'must throw an error');
    assert.ok(err.toString().includes('CommitmentMismatch'),
      `must be CommitmentMismatch, received: ${err.toString().slice(0, 200)}`);
  });
});
