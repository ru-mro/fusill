/**
 * Security regression: finalize_job must bind each payout wallet and NodeAccount
 * to the node that actually revealed. Before the fix, any caller could pass their
 * own wallet in the node_wallets slots and drain the job payment.
 */
import { Keypair, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { BN, Program } = anchorPkg;
import { BankrunProvider, startAnchor } from 'anchor-bankrun';
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildCommitment } from '../../node-client/src/commitment.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CONTRACTS  = join(__dirname, '../../contracts');
// FUSILL_IDL lets local runs point at a freshly built IDL when target/ is not writable.
const IDL_PATH   = process.env.FUSILL_IDL ?? join(CONTRACTS, 'target/idl/fusill.json');
const IDL        = JSON.parse(readFileSync(IDL_PATH, 'utf8'));

// ─── helpers ────────────────────────────────────────────────────────────────

async function fund(context, pubkey, sol = 5) {
  await context.setAccount(pubkey, {
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

async function getTimestamp(context) {
  const clock = await context.banksClient.getClock();
  return Number(clock.unixTimestamp);
}

const configPda  = (pid)            => PublicKey.findProgramAddressSync([Buffer.from('config')], pid)[0];
const nodePda    = (pid, owner)     => PublicKey.findProgramAddressSync([Buffer.from('node'), owner.toBuffer()], pid)[0];
const resultPda  = (pid, job, node) => PublicKey.findProgramAddressSync([Buffer.from('result'), job.toBuffer(), node.toBuffer()], pid)[0];

function i64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

/**
 * Brings a fresh job to PendingFinalization with a single honest node.
 * Returns everything the finalize call needs.
 */
async function setupRevealedJob(context) {
  const program  = new Program(IDL, new BankrunProvider(context));
  const pid      = program.programId;

  // Authority initializes the program config (receives the protocol fee).
  const authority = Keypair.generate();
  await fund(context, authority.publicKey, 10);
  await program.methods.initialize()
    .accounts({ authority: authority.publicKey, config: configPda(pid), systemProgram: SystemProgram.programId })
    .signers([authority]).rpc();

  // User creates a non-scheduled job (min_nodes = 1 → Running on claim).
  const user = Keypair.generate();
  await fund(context, user.publicKey, 5);
  const ts  = await getTimestamp(context);
  const job = PublicKey.findProgramAddressSync(
    [Buffer.from('job'), user.publicKey.toBuffer(), i64le(ts)], pid,
  )[0];
  const paymentLamports = 0.01 * LAMPORTS_PER_SOL;

  await program.methods.createJob(
    new BN(ts), 'https://example.com', { httpFlood: {} },
    Buffer.from(JSON.stringify({ concurrent_connections: 50 })),
    30, 1, 15, new BN(paymentLamports), false,
  ).accounts({ user: user.publicKey, jobAccount: job, systemProgram: SystemProgram.programId })
   .signers([user]).rpc();

  // Node registers and claims → job goes Running.
  const node    = Keypair.generate();
  await fund(context, node.publicKey, 2);
  const nodeAcc = nodePda(pid, node.publicKey);
  await program.methods.registerNode(new BN(500_000_000))
    .accounts({ owner: node.publicKey, nodeAccount: nodeAcc, systemProgram: SystemProgram.programId })
    .signers([node]).rpc();
  await program.methods.claimJob()
    .accounts({ nodeOwner: node.publicKey, nodeAccount: nodeAcc, jobAccount: job })
    .signers([node]).rpc();

  // Commit + reveal.
  const metrics = { avgLatencyMs: 100, errorRateBps: 0, requestsCompleted: 3000n, baselineLatencyMs: 5, nonce: 42n };
  const result  = resultPda(pid, job, node.publicKey);
  const commitment = buildCommitment(
    metrics.avgLatencyMs, metrics.errorRateBps, metrics.requestsCompleted, metrics.baselineLatencyMs, metrics.nonce,
  );

  await program.methods.submitCommitment([...commitment])
    .accounts({ nodeOwner: node.publicKey, jobAccount: job, resultAccount: result, systemProgram: SystemProgram.programId })
    .signers([node]).rpc();
  await program.methods.revealResult(
    metrics.avgLatencyMs, metrics.errorRateBps, new BN(metrics.requestsCompleted.toString()),
    metrics.baselineLatencyMs, new BN(metrics.nonce.toString()),
  ).accounts({ nodeOwner: node.publicKey, jobAccount: job, resultAccount: result })
   .signers([node]).rpc();

  return { program, pid, authority, user, node, nodeAcc, job, result, paymentLamports };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('finalize_job — payment redirection', () => {
  it('rejects a finalize that points the payout wallet at an attacker', async () => {
    const context = await startAnchor(CONTRACTS, [], []);
    const { program, authority, node, nodeAcc, job, result } = await setupRevealedJob(context);

    const attacker = Keypair.generate();
    await fund(context, attacker.publicKey, 1);

    let threw = false;
    try {
      // Same result + NodeAccount, but the wallet slot is swapped for the attacker's.
      await program.methods.finalizeJob()
        .accounts({ jobAccount: job, config: configPda(program.programId), authority: authority.publicKey })
        .remainingAccounts([
          { pubkey: result,             isSigner: false, isWritable: false },
          { pubkey: attacker.publicKey, isSigner: false, isWritable: true  }, // ← redirected
          { pubkey: nodeAcc,            isSigner: false, isWritable: true  },
        ])
        .rpc();
    } catch (err) {
      threw = true;
      assert.include(err.toString(), 'InvalidAccount');
    }
    assert.ok(threw, 'finalize must reject a mismatched payout wallet');

    // The attacker received nothing.
    assert.equal(await lamportsOf(context, attacker.publicKey), BigInt(1 * LAMPORTS_PER_SOL));
  });

  it('pays the real node when accounts are honest', async () => {
    const context = await startAnchor(CONTRACTS, [], []);
    const { program, authority, node, nodeAcc, job, result, paymentLamports } = await setupRevealedJob(context);

    // Baseline was committed and revealed on-chain, visible to the client.
    const revealed = await program.account.resultAccount.fetch(result);
    assert.equal(revealed.baselineLatencyMs, 5, 'baseline latency is persisted on-chain');
    assert.equal(revealed.avgLatencyMs, 100, 'under-attack latency is persisted');

    const before = await lamportsOf(context, node.publicKey);

    await program.methods.finalizeJob()
      .accounts({ jobAccount: job, config: configPda(program.programId), authority: authority.publicKey })
      .remainingAccounts([
        { pubkey: result,            isSigner: false, isWritable: false },
        { pubkey: node.publicKey,    isSigner: false, isWritable: true  },
        { pubkey: nodeAcc,           isSigner: false, isWritable: true  },
      ])
      .rpc();

    const after = await lamportsOf(context, node.publicKey);
    const expected = BigInt(paymentLamports) - BigInt(paymentLamports) * 500n / 10_000n; // minus 5% fee
    assert.equal(after - before, expected, 'honest node receives 95% of payment');

    const jobAcc = await program.account.jobAccount.fetch(job);
    assert.equal(Object.keys(jobAcc.status)[0], 'completed');
  });
});
