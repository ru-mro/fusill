import { Keypair, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { BN } = anchorPkg;
import { BankrunProvider, startAnchor } from 'anchor-bankrun';
import { Clock } from 'solana-bankrun';
import { assert } from 'chai';
import { FusillClient } from '../src/FusillClient.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CONTRACTS  = join(__dirname, '../../contracts');
const IDL        = JSON.parse(readFileSync(join(CONTRACTS, 'target/idl/fusill.json'), 'utf8'));

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  return clock.unixTimestamp;
}

async function lamportsOf(context, pubkey) {
  const acc = await context.banksClient.getAccount(pubkey);
  return acc ? BigInt(acc.lamports) : 0n;
}

function makeClient(keypair, context) {
  return new FusillClient(keypair, new BankrunProvider(context), IDL);
}

const DEFAULT_RUNNER_TYPE   = 'httpFlood';
const DEFAULT_RUNNER_CONFIG = { method: 'GET', rps_per_node: 10 };

// Creates a job and returns { client, context, user, jobPubkey }
// Each call uses a fresh context and user to avoid PDA collisions.
async function freshJob(opts = {}) {
  const context = await newContext();
  const user    = Keypair.generate();
  await fund(context, user, 10);
  const client  = makeClient(user, context);

  const { jobPubkey } = await client.createJob({
    target:        'https://example.com',
    runnerType:    DEFAULT_RUNNER_TYPE,
    runnerConfig:  DEFAULT_RUNNER_CONFIG,
    durationSeconds: 10,
    minNodes:      opts.minNodes ?? 1,
    expiryMinutes: opts.expiryMinutes ?? 15,
    paymentSol:    opts.paymentSol ?? 0.01,
  });

  return { client, context, user, jobPubkey };
}

// ─── createJob ───────────────────────────────────────────────────────────────

describe('createJob', () => {
  it('returns jobPubkey and tx, and creates the on-chain account', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user);
    const client  = makeClient(user, context);

    const { jobPubkey, tx } = await client.createJob({
      target:        'https://example.com',
      runnerType:    'httpFlood',
      runnerConfig:  { method: 'GET', rps_per_node: 100 },
      durationSeconds: 30,
      minNodes:      1,
      expiryMinutes: 15,
      paymentSol:    0.01,
    });

    assert.ok(jobPubkey instanceof PublicKey);
    assert.ok(typeof tx === 'string' && tx.length > 0);

    const acc = await context.banksClient.getAccount(jobPubkey);
    assert.ok(acc, 'the job account must exist on-chain');
  });

  it('the job fields match the params sent', async () => {
    const { client, jobPubkey } = await freshJob({
      minNodes: 2, expiryMinutes: 20, paymentSol: 0.05,
    });
    const job = await client.getJob(jobPubkey);

    assert.equal(job.target,       'https://example.com');
    assert.equal(job.runnerType,   'httpFlood');
    assert.equal(job.minNodes,     2);
    assert.equal(job.status,       'open');
    assert.equal(job.nodesClaimed, 0);
    assert.closeTo(job.paymentSol, 0.05, 0.0001);
  });

  it('expiryMinutes = 5 sets expires_at to 5 minutes from createdAt', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user);
    const client  = makeClient(user, context);
    const ts      = Number(await getTimestamp(context));

    const { jobPubkey } = await client.createJob({
      target:        'https://example.com',
      runnerType:    'slowloris',
      runnerConfig:  { concurrent_connections: 150 },
      durationSeconds: 10,
      minNodes:      1,
      expiryMinutes: 5,
      paymentSol:    0.001,
    });

    const job = await client.getJob(jobPubkey);
    assert.equal(job.expiresAt.getTime(), new Date((ts + 5 * 60) * 1000).getTime());
  });

  it('expiryMinutes defaults to 15 when not specified', async () => {
    const context = await newContext();
    const user    = Keypair.generate();
    await fund(context, user);
    const client  = makeClient(user, context);
    const ts      = Number(await getTimestamp(context));

    const { jobPubkey } = await client.createJob({
      target:        'https://example.com',
      runnerType:    'httpFlood',
      runnerConfig:  { method: 'GET', rps_per_node: 10 },
      durationSeconds: 10,
      minNodes:      1,
      paymentSol:    0.001,
    });

    const job = await client.getJob(jobPubkey);
    assert.equal(job.expiresAt.getTime(), new Date((ts + 15 * 60) * 1000).getTime());
  });
});

// ─── getJob ──────────────────────────────────────────────────────────────────

describe('getJob', () => {
  it('returns an object with all expected fields', async () => {
    const { client, jobPubkey } = await freshJob();
    const job = await client.getJob(jobPubkey);

    assert.equal(typeof job.pubkey,          'string');
    assert.equal(typeof job.target,          'string');
    assert.equal(typeof job.runnerType,      'string');
    assert.equal(typeof job.durationSeconds, 'number');
    assert.equal(typeof job.minNodes,        'number');
    assert.equal(typeof job.nodesClaimed,    'number');
    assert.equal(typeof job.paymentSol,      'number');
    assert.equal(typeof job.status,          'string');
    assert.ok(job.createdAt instanceof Date);
    assert.ok(job.expiresAt instanceof Date);
    assert.ok(job.runnerConfig !== null && typeof job.runnerConfig === 'object');
    assert.equal(job.pubkey, jobPubkey.toString());
    assert.equal(typeof job.scheduledJob, 'boolean');
    assert.equal(typeof job.scheduledAt,  'number');
    assert.equal(job.scheduledJob, false, 'regular jobs are not scheduled');
    assert.equal(job.scheduledAt,  0,     'regular jobs have no scheduled_at');
  });
});

// ─── cancelJob ───────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  it('cancels the job after expiry and refunds the user', async () => {
    const { client, context, user, jobPubkey } = await freshJob({ minNodes: 2, paymentSol: 0.05 });

    const balBefore = await lamportsOf(context, user.publicKey);
    await advanceTime(context, 16 * 60);

    await client.cancelJob(jobPubkey);

    const job      = await client.getJob(jobPubkey);
    const balAfter = await lamportsOf(context, user.publicKey);

    assert.equal(job.status, 'cancelled');
    assert.ok(balAfter > balBefore, 'the user must recover SOL');
  });

  it('fails with JobNotExpired if the job has not expired yet', async () => {
    const { client, jobPubkey } = await freshJob();

    let threw = false;
    try {
      await client.cancelJob(jobPubkey);
    } catch (err) {
      threw = true;
      assert.include(err.toString(), 'JobNotExpired');
    }
    assert.ok(threw, 'cancelJob should have thrown JobNotExpired');
  });
});

// ─── listJobs ────────────────────────────────────────────────────────────────
// BankrunProvider does not implement getProgramAccounts (RPC method not available
// in BanksClient). These tests use a mock program to cover the SDK's filtering
// and sorting logic without depending on the network.

// Builds a mock program whose surface matches what _fetchAllJobsResilient uses:
// it fetches raw accounts via getProgramAccounts and decodes them with the coder.
// We pass the already-built account object through `data` and have decode return it.
function makeJobsMock(allAccounts) {
  return {
    programId: PublicKey.default,
    provider: {
      connection: {
        getProgramAccounts: async () =>
          allAccounts.map(a => ({ pubkey: a.publicKey, account: { data: a.account } })),
      },
    },
    coder: {
      accounts: {
        memcmp: () => ({ offset: 0, bytes: '' }),
        decode: (_name, data) => data,
      },
    },
  };
}

describe('listJobs', () => {
  function makeJobRaw(owner, target, createdAtSec, paymentSol = 0.01) {
    return {
      owner:            new PublicKey(owner.publicKey),
      target,
      runnerType:       { httpFlood: {} },
      runnerConfig:     Buffer.from(JSON.stringify({ method: 'GET' })),
      durationSeconds:  30,
      minNodes:         1,
      nodesClaimed:     0,
      commitsSubmitted: 0,
      revealsSubmitted: 0,
      payment:          { toNumber: () => Math.floor(paymentSol * LAMPORTS_PER_SOL) },
      status:           { open: {} },
      createdAt:        { toNumber: () => createdAtSec },
      expiresAt:        { toNumber: () => createdAtSec + 900 },
      claimedNodes:     [],
    };
  }

  it('returns only jobs owned by the current user', async () => {
    const userA = Keypair.generate();
    const userB = Keypair.generate();
    const pk1   = Keypair.generate().publicKey;
    const pk2   = Keypair.generate().publicKey;
    const pk3   = Keypair.generate().publicKey;

    const allAccounts = [
      { publicKey: pk1, account: makeJobRaw(userA, 'https://a.com', 1000) },
      { publicKey: pk2, account: makeJobRaw(userA, 'https://b.com', 2000) },
      { publicKey: pk3, account: makeJobRaw(userB, 'https://c.com', 3000) },
    ];

    const mockProgram = makeJobsMock(allAccounts);

    const clientA = FusillClient._withProgram(userA, mockProgram);
    const clientB = FusillClient._withProgram(userB, mockProgram);

    const jobsA = await clientA.listJobs();
    const jobsB = await clientB.listJobs();

    assert.equal(jobsA.length, 2);
    assert.equal(jobsB.length, 1);
    assert.ok(jobsA.every(j => j.target === 'https://a.com' || j.target === 'https://b.com'));
    assert.equal(jobsB[0].target, 'https://c.com');
  });

  it('returns jobs sorted by createdAt descending', async () => {
    const user = Keypair.generate();
    const pk1  = Keypair.generate().publicKey;
    const pk2  = Keypair.generate().publicKey;

    const mockProgram = makeJobsMock([
      { publicKey: pk1, account: makeJobRaw(user, 'https://first.com',  1000) },
      { publicKey: pk2, account: makeJobRaw(user, 'https://second.com', 2000) },
    ]);

    const client = FusillClient._withProgram(user, mockProgram);
    const jobs   = await client.listJobs();

    assert.equal(jobs.length, 2);
    assert.ok(jobs[0].createdAt >= jobs[1].createdAt, 'the most recent must be first');
    assert.equal(jobs[0].target, 'https://second.com');
  });
});

// ─── listAllJobs ──────────────────────────────────────────────────────────────

describe('listAllJobs', () => {
  it('returns jobs from all users sorted by payment descending', async () => {
    const userA = Keypair.generate();
    const userB = Keypair.generate();
    const pk1   = Keypair.generate().publicKey;
    const pk2   = Keypair.generate().publicKey;

    const makeRaw = (owner, target, paymentSol) => ({
      owner:            owner.publicKey,
      target,
      runnerType:       { slowloris: {} },
      runnerConfig:     Buffer.from(JSON.stringify({ concurrent_connections: 150 })),
      durationSeconds:  30,
      minNodes:         1,
      nodesClaimed:     0,
      commitsSubmitted: 0,
      revealsSubmitted: 0,
      payment:          { toNumber: () => Math.floor(paymentSol * LAMPORTS_PER_SOL) },
      status:           { open: {} },
      createdAt:        { toNumber: () => 1000 },
      expiresAt:        { toNumber: () => 1900 },
      claimedNodes:     [],
    });

    const mockProgram = makeJobsMock([
      { publicKey: pk1, account: makeRaw(userA, 'https://cheap.com',     0.01) },
      { publicKey: pk2, account: makeRaw(userB, 'https://expensive.com', 0.1)  },
    ]);

    const client = FusillClient._withProgram(userA, mockProgram);
    const all    = await client.listAllJobs();

    assert.equal(all.length, 2);
    assert.ok(all[0].paymentSol >= all[1].paymentSol, 'the highest payment must be first');
    assert.equal(all[0].target, 'https://expensive.com');
  });
});

// ─── onJobFinalized ───────────────────────────────────────────────────────────

describe('onJobFinalized', () => {
  it('subscribes to the JobFinalized event (PascalCase) and returns unsubscribe', async () => {
    const user      = Keypair.generate();
    const jobPubkey = Keypair.generate().publicKey;

    let capturedName, capturedId;
    const mockProgram = {
      addEventListener(name, _cb) {
        capturedName = name;
        return 42;
      },
      removeEventListener(id) {
        capturedId = id;
      },
    };

    const client      = FusillClient._withProgram(user, mockProgram);
    const unsubscribe = client.onJobFinalized(jobPubkey, () => {});

    assert.equal(capturedName, 'JobFinalized', 'must subscribe with the exact IDL name');
    assert.equal(typeof unsubscribe, 'function');

    unsubscribe();
    assert.equal(capturedId, 42, 'unsubscribe must call removeEventListener with the correct id');
  });

  it('the callback receives correctly formatted data', () => {
    const user      = Keypair.generate();
    const jobPubkey = Keypair.generate().publicKey;
    const otherJob  = Keypair.generate().publicKey;

    let fired = 0;
    let received;

    const mockProgram = {
      addEventListener(_name, cb) {
        // Fire an event for a different job (must be ignored)
        cb({ job: otherJob, honestNodes: 1, paymentPerHonest: { toNumber: () => 500000 }, protocolFee: { toNumber: () => 25000 } });
        // Fire the event for the correct job
        cb({ job: jobPubkey, honestNodes: 3, paymentPerHonest: { toNumber: () => 1000000 }, protocolFee: { toNumber: () => 50000 } });
        fired++;
        return 1;
      },
      removeEventListener() {},
    };

    const client = FusillClient._withProgram(user, mockProgram);
    client.onJobFinalized(jobPubkey, (result) => { received = result; });

    assert.equal(fired, 1, 'addEventListener must have been called');
    assert.ok(received, 'the callback must have received data');
    assert.equal(received.honestNodes,        3);
    assert.closeTo(received.paymentPerNodeSol, 0.001, 0.000001);
    assert.closeTo(received.protocolFeeSol,    0.00005, 0.000001);
  });
});
