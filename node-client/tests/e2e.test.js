/**
 * E2E test for the full node cycle — no devnet required.
 *
 * Uses bankrun (in-process Solana validator) to run the real contract.
 * The runner and verifyOwnership are mocked: no real runner or HTTP server.
 *
 * Flow:
 *   initialize → register_node → create_job → processJob (mock runner)
 *   → claim → commit → reveal → finalize → verify payment
 */

import { Keypair, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { BN, Program } = anchorPkg;
import { BankrunProvider, startAnchor } from 'anchor-bankrun';
import { assert }          from 'chai';
import { readFileSync }    from 'fs';
import { fileURLToPath }   from 'url';
import { dirname, join }   from 'path';

import { processJob }      from '../src/index.js';
import {
  getNodePda,
  getConfigPda,
}                          from '../src/chain.js';

// ─── paths ───────────────────────────────────────────────────────────────────

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CONTRACTS  = join(__dirname, '../../contracts');
const IDL_PATH   = process.env.FUSILL_IDL ?? join(CONTRACTS, 'target/idl/fusill.json');
const IDL        = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
const PROGRAM_ID = new PublicKey(IDL.address);
const MIN_STAKE  = 500_000_000n; // 0.5 SOL in lamports

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fund(context, keypair, sol = 5) {
  await context.setAccount(keypair.publicKey, {
    lamports:   BigInt(Math.floor(sol * LAMPORTS_PER_SOL)),
    data:       Buffer.alloc(0),
    owner:      SystemProgram.programId,
    executable: false,
  });
}

async function lamportsOf(context, pubkey) {
  const acc = await context.banksClient.getAccount(pubkey);
  return acc ? BigInt(acc.lamports) : 0n;
}

function jobPda(userPubkey, timestampSecs) {
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64LE(timestampSecs);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('job'), userPubkey.toBuffer(), tsBuf],
    PROGRAM_ID,
  );
  return pda;
}

// Fake runner: returns realistic metrics instantly without running a real attack
const MOCK_METRICS = { avgLatencyMs: 42, errorRateBps: 0, requestsCompleted: 600 };
const mockRunner   = async () => MOCK_METRICS;
const mockVerify   = async () => true;

// ─── test ────────────────────────────────────────────────────────────────────

describe('node-client E2E (bankrun)', () => {
  it('full cycle: claim → commit → reveal → finalize → node payment', async () => {
    // ── 1. Bankrun + provider ──────────────────────────────────────────────
    const context  = await startAnchor(CONTRACTS, [], []);
    const provider = new BankrunProvider(context);
    const program  = new Program(IDL, provider);

    // ── 2. Fund accounts ──────────────────────────────────────────────────
    const authority = Keypair.generate();
    const node      = Keypair.generate();
    const user      = Keypair.generate();

    await fund(context, authority, 10);
    await fund(context, node,      2);
    await fund(context, user,      5);

    // ── 3. initialize — creates the Config account (required by finalize_job)
    const configPda = getConfigPda(PROGRAM_ID);
    await program.methods
      .initialize()
      .accounts({ authority: authority.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .signers([authority])
      .rpc();

    // ── 4. register_node ─────────────────────────────────────────────────
    const nodePda = getNodePda(PROGRAM_ID, node.publicKey);
    await program.methods
      .registerNode(new BN(MIN_STAKE.toString()))
      .accounts({ owner: node.publicKey, nodeAccount: nodePda, systemProgram: SystemProgram.programId })
      .signers([node])
      .rpc();

    // ── 5. create_job (minNodes = 1 so the single node completes it) ─────
    const clock      = await context.banksClient.getClock();
    const ts         = clock.unixTimestamp;
    const jobPubkey  = jobPda(user.publicKey, ts);
    const PAYMENT    = 10_000_000n; // 0.01 SOL

    const runnerConfig = Buffer.from(JSON.stringify({ method: 'GET', concurrent_connections: 10 }));
    await program.methods
      .createJob(
        new BN(ts.toString()),
        'https://example.com',
        { httpFlood: {} },
        runnerConfig,
        10,      // durationSeconds
        1,       // minNodes
        15,      // expiryMinutes
        new BN(PAYMENT.toString()),
        false,   // scheduledJob
      )
      .accounts({ user: user.publicKey, jobAccount: jobPubkey, systemProgram: SystemProgram.programId })
      .signers([user])
      .rpc();

    // ── 6. Balances before the cycle ──────────────────────────────────────
    const nodeBefore = await lamportsOf(context, node.publicKey);

    // ── 7. processJob with mocks — full node cycle ────────────────────────
    const jobAccount = await program.account.jobAccount.fetch(jobPubkey);

    await processJob(program, node, jobPubkey, jobAccount, {
      runTest:  mockRunner,
      verify:   mockVerify,
      baseline: async () => 5, // skip the real network probe in tests
    });

    // ── 8. Verify final state and payment ─────────────────────────────────
    const finalJob    = await program.account.jobAccount.fetch(jobPubkey);
    const nodeAfter   = await lamportsOf(context, node.publicKey);
    const nodeAccount = await program.account.nodeAccount.fetch(nodePda);

    assert.deepEqual(finalJob.status, { completed: {} }, 'the job must end in Completed status');
    assert.ok(nodeAfter > nodeBefore, 'the node must have received payment');

    // 95% of payment goes to the node (minus transaction fees spent)
    const expectedMin = (PAYMENT * 90n) / 100n; // margin for tx fees
    const received    = nodeAfter - nodeBefore;
    assert.ok(received > 0n, `the node received: ${received} lamports`);

    // Reputation increased for completing the job honestly
    assert.ok(nodeAccount.reputation > 50, `node reputation: ${nodeAccount.reputation}`);
  });
});
