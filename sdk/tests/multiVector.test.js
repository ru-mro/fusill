import { Keypair, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { BN, Program } = anchorPkg;
import { BankrunProvider, startAnchor } from 'anchor-bankrun';
import { Clock } from 'solana-bankrun';
import { assert } from 'chai';
import { FusillClient } from '../src/FusillClient.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS  = join(__dirname, '../../contracts');
const IDL        = JSON.parse(readFileSync(join(CONTRACTS, 'target/idl/fusill.json'), 'utf8'));

// ─── shared helpers ───────────────────────────────────────────────────────────

async function newContext() {
  return startAnchor(CONTRACTS, [], []);
}

async function fund(context, keypair, sol = 5) {
  await context.setAccount(keypair.publicKey, {
    lamports:   BigInt(Math.floor(sol * LAMPORTS_PER_SOL)),
    data:       Buffer.alloc(0),
    owner:      SystemProgram.programId,
    executable: false,
  });
}

async function advanceTime(context, seconds) {
  const clock = await context.banksClient.getClock();
  await context.setClock(new Clock(
    clock.slot,
    clock.epochStartTimestamp,
    clock.epoch,
    clock.leaderScheduleEpoch,
    clock.unixTimestamp + BigInt(seconds),
  ));
}

async function getTimestamp(context) {
  const clock = await context.banksClient.getClock();
  return Number(clock.unixTimestamp);
}

async function lamportsOf(context, pubkey) {
  const acc = await context.banksClient.getAccount(pubkey);
  return acc ? BigInt(acc.lamports) : 0n;
}

function makeClient(keypair, context) {
  return new FusillClient(keypair, new BankrunProvider(context), IDL);
}

/** Registers a node on-chain and returns its PDA. */
async function registerNode(context, nodeKeypair) {
  await fund(context, nodeKeypair, 2);
  const program = new Program(IDL, new BankrunProvider(context));
  const [nodePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('node'), nodeKeypair.publicKey.toBuffer()],
    program.programId,
  );
  await program.methods
    .registerNode(new BN(500_000_000))
    .accounts({
      owner:         nodeKeypair.publicKey,
      nodeAccount:   nodePda,
      systemProgram: SystemProgram.programId,
    })
    .signers([nodeKeypair])
    .rpc();
  return nodePda;
}

/** Claims a job on behalf of the given node keypair. */
async function claimJobAsNode(context, nodeKeypair, jobPubkey) {
  const program = new Program(IDL, new BankrunProvider(context));
  const [nodePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('node'), nodeKeypair.publicKey.toBuffer()],
    program.programId,
  );
  await program.methods
    .claimJob()
    .accounts({
      nodeOwner:   nodeKeypair.publicKey,
      nodeAccount: nodePda,
      jobAccount:  jobPubkey,
    })
    .signers([nodeKeypair])
    .rpc();
}

const VECTORS = [
  { type: 'httpFlood', config: { method: 'GET', concurrent_connections: 50 } },
  { type: 'slowloris', config: { concurrent_connections: 150 } },
];

// ─── createMultiVectorJob ────────────────────────────────────────────────────

describe('createMultiVectorJob', () => {
  it('creates one job per vector, all with scheduledJob = true', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user, 5);
    const client  = makeClient(user, context);

    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        1,
      durationSeconds: 10,
      expiryMinutes:   15,
      paymentSol:      0.01,
    });

    assert.equal(jobPubkeys.length, 2);
    assert.ok(jobPubkeys.every(pk => pk instanceof PublicKey));

    for (const pk of jobPubkeys) {
      const job = await client.getJob(pk);
      assert.equal(job.status,       'open');
      assert.equal(job.scheduledJob, true);
      assert.equal(job.scheduledAt,  0);
    }
  });

  it('uses unique PDAs for each vector even within the same second', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user, 5);
    const client  = makeClient(user, context);

    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        1,
      durationSeconds: 10,
      expiryMinutes:   15,
      paymentSol:      0.01,
    });

    const unique = new Set(jobPubkeys.map(pk => pk.toString()));
    assert.equal(unique.size, 2, 'each job must have a distinct pubkey');
  });

  it('each job stores the correct runner type', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user, 5);
    const client  = makeClient(user, context);

    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        1,
      durationSeconds: 10,
      expiryMinutes:   15,
      paymentSol:      0.01,
    });

    const job0 = await client.getJob(jobPubkeys[0]);
    const job1 = await client.getJob(jobPubkeys[1]);

    assert.equal(job0.runnerType, 'httpFlood');
    assert.equal(job1.runnerType, 'slowloris');
  });
});

// ─── scheduleJob / scheduleMultiVectorJob ────────────────────────────────────

describe('scheduleMultiVectorJob', () => {
  it('transitions Filled jobs to Running with the correct scheduledAt', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    const node0   = Keypair.generate();
    const node1   = Keypair.generate();

    await fund(context, user, 5);
    await registerNode(context, node0);
    await registerNode(context, node1);

    const client     = makeClient(user, context);
    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        1,
      durationSeconds: 10,
      expiryMinutes:   15,
      paymentSol:      0.01,
    });

    // Each node claims one job
    await claimJobAsNode(context, node0, jobPubkeys[0]);
    await claimJobAsNode(context, node1, jobPubkeys[1]);

    // Both jobs should now be Filled (not yet Running)
    for (const pk of jobPubkeys) {
      const job = await client.getJob(pk);
      assert.equal(job.status, 'filled', `job ${pk} should be in Filled status`);
    }

    // Schedule both with a coordinated timestamp 10 s from now
    const now   = await getTimestamp(context);
    const runAt = now + 10;
    await client.scheduleMultiVectorJob(jobPubkeys, runAt);

    // Both should now be Running with the correct scheduledAt
    for (const pk of jobPubkeys) {
      const job = await client.getJob(pk);
      assert.equal(job.status,      'running');
      assert.equal(job.scheduledAt,  runAt);
    }
  });

  it('only the creator can call scheduleJob', async () => {
    const context    = await newContext();
    const creator    = Keypair.generate();
    const attacker   = Keypair.generate();
    const node       = Keypair.generate();

    await fund(context, creator,  5);
    await fund(context, attacker, 2);
    await registerNode(context, node);

    const creatorClient  = makeClient(creator,  context);
    const attackerClient = makeClient(attacker, context);

    const { jobPubkey } = await creatorClient.createJob({
      target:          'https://example.com',
      runnerType:      'httpFlood',
      runnerConfig:    { method: 'GET', concurrent_connections: 50 },
      durationSeconds: 10,
      minNodes:        1,
      expiryMinutes:   15,
      paymentSol:      0.01,
      scheduledJob:    true,
    });

    await claimJobAsNode(context, node, jobPubkey);

    const now = await getTimestamp(context);
    let threw = false;
    try {
      await attackerClient.scheduleJob(jobPubkey, now + 10);
    } catch (err) {
      threw = true;
      assert.include(err.toString(), 'Unauthorized');
    }
    assert.ok(threw, 'scheduleJob should reject a non-creator caller');
  });
});

// ─── waitForAllFilled ────────────────────────────────────────────────────────

describe('waitForAllFilled', () => {
  it('resolves immediately when all jobs are already Filled', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    const node0   = Keypair.generate();
    const node1   = Keypair.generate();

    await fund(context, user, 5);
    await registerNode(context, node0);
    await registerNode(context, node1);

    const client     = makeClient(user, context);
    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        1,
      durationSeconds: 10,
      expiryMinutes:   15,
      paymentSol:      0.01,
    });

    await claimJobAsNode(context, node0, jobPubkeys[0]);
    await claimJobAsNode(context, node1, jobPubkeys[1]);

    // Should not throw or timeout
    await client.waitForAllFilled(jobPubkeys, 5_000);
  });

  it('times out when jobs remain Open', async () => {
    const user = Keypair.generate();
    let calls  = 0;

    const mockProgram = {
      account: {
        jobAccount: {
          fetch: async () => {
            calls++;
            return { status: { open: {} } };
          },
        },
      },
    };

    const client = FusillClient._withProgram(user, mockProgram);
    let threw    = false;

    try {
      await client.waitForAllFilled([Keypair.generate().publicKey], 1_500);
    } catch (err) {
      threw = true;
      assert.include(err.message, 'Timeout');
    }

    assert.ok(threw,   'should throw on timeout');
    assert.ok(calls > 0, 'should have polled at least once');
  });
});

// ─── cancelMultiVectorJob — expiry scenario ──────────────────────────────────

describe('cancelMultiVectorJob', () => {
  it('cancels all jobs after expiry (mix of Open and Filled)', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    const node    = Keypair.generate();

    await fund(context, user, 5);
    await registerNode(context, node);

    const client     = makeClient(user, context);
    // minNodes = 1 per job — node claims job0 only
    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        1,
      durationSeconds: 10,
      expiryMinutes:   5,
      paymentSol:      0.01,
    });

    // Only job0 fills
    await claimJobAsNode(context, node, jobPubkeys[0]);

    assert.equal((await client.getJob(jobPubkeys[0])).status, 'filled');
    assert.equal((await client.getJob(jobPubkeys[1])).status, 'open');

    // Advance past expiry
    await advanceTime(context, 6 * 60);

    const balBefore = await lamportsOf(context, user.publicKey);
    await client.cancelMultiVectorJob(jobPubkeys);

    for (const pk of jobPubkeys) {
      const job = await client.getJob(pk);
      assert.equal(job.status, 'cancelled', `job ${pk} should be cancelled`);
    }

    const balAfter = await lamportsOf(context, user.publicKey);
    assert.ok(balAfter > balBefore, 'user should receive SOL refund from both jobs');
  });

  it('refunds both jobs when neither fills', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user, 5);

    const client     = makeClient(user, context);
    const jobPubkeys = await client.createMultiVectorJob({
      target:          'https://example.com',
      vectors:         VECTORS,
      minNodes:        2,
      durationSeconds: 10,
      expiryMinutes:   5,
      paymentSol:      0.01,
    });

    await advanceTime(context, 6 * 60);

    const balBefore = await lamportsOf(context, user.publicKey);
    await client.cancelMultiVectorJob(jobPubkeys);

    for (const pk of jobPubkeys) {
      assert.equal((await client.getJob(pk)).status, 'cancelled');
    }

    const balAfter = await lamportsOf(context, user.publicKey);
    assert.ok(balAfter > balBefore, 'user should receive full refund when no nodes claimed');
  });
});
