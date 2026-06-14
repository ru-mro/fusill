import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import { readFileSync } from 'fs';

// Job accounts whose on-chain layout no longer matches the IDL (leftovers from a
// previous program deploy). We warn once per pubkey instead of spamming the log.
const warnedStaleJobs = new Set();

export async function initChain() {
  const keypairBytes = process.env.NODE_KEYPAIR_PATH
    ? JSON.parse(readFileSync(process.env.NODE_KEYPAIR_PATH, 'utf8'))
    : JSON.parse(process.env.NODE_KEYPAIR);
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));

  const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const wallet     = new Wallet(keypair);
  const provider   = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

  const idlPath = process.env.IDL_PATH ?? './fusill-idl.json';
  const idl     = JSON.parse(readFileSync(idlPath, 'utf8'));
  const program = new Program(idl, provider);

  return { connection, keypair, program, provider };
}

export async function registerNodeIfNeeded(program, keypair) {
  const nodePda = getNodePda(program.programId, keypair.publicKey);
  try {
    await program.account.nodeAccount.fetch(nodePda);
    console.log(`Nodo ya registrado: ${nodePda.toString()}`);
  } catch {
    const stakeLamports = parseInt(process.env.STAKE_LAMPORTS) || 500_000_000;
    console.log(`Registrando nodo con ${stakeLamports / 1e9} SOL de stake...`);
    await program.methods
      .registerNode(new BN(stakeLamports))
      .accounts({
        owner:         keypair.publicKey,
        nodeAccount:   nodePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
    console.log(`Nodo registrado: ${nodePda.toString()}`);
  }
}

/**
 * Fetches all Open jobs sorted by payment descending.
 *
 * We decode each account individually instead of using `program.account.jobAccount.all()`
 * because that helper decodes the whole batch and throws on the first account it can't
 * deserialize. Stale jobs from a previous program deploy still match the account
 * discriminator (it's just hash("account:JobAccount")), so a single leftover account
 * with an outdated layout would otherwise crash the entire poll loop. Here we skip
 * undecodable accounts and keep going.
 *
 * We filter by status on the client side because the target URL is a variable-length
 * String, so the status field offset is not fixed and can't be matched with memcmp.
 */
export async function fetchOpenJobs(program) {
  const accountName = 'jobAccount';
  const discriminator = program.coder.accounts.memcmp(accountName).bytes;

  const rawAccounts = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: discriminator } }],
  });

  const jobs = [];
  for (const { pubkey, account } of rawAccounts) {
    try {
      const decoded = program.coder.accounts.decode(accountName, account.data);
      jobs.push({ publicKey: pubkey, account: decoded });
    } catch (err) {
      const key = pubkey.toString();
      if (!warnedStaleJobs.has(key)) {
        warnedStaleJobs.add(key);
        console.warn(`Skipping undecodable job account ${key.slice(0, 8)}... (stale layout: ${err.message})`);
      }
    }
  }

  return jobs
    .filter(j => j.account.status.open !== undefined)
    .sort((a, b) => b.account.payment.toNumber() - a.account.payment.toNumber());
}

export function getNodePda(programId, ownerPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('node'), ownerPubkey.toBuffer()],
    programId
  );
  return pda;
}

export function getResultPda(programId, jobPubkey, nodePubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('result'), jobPubkey.toBuffer(), nodePubkey.toBuffer()],
    programId
  );
  return pda;
}

export function getConfigPda(programId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    programId
  );
  return pda;
}

export async function claimJob(program, keypair, jobPubkey) {
  const nodePda = getNodePda(program.programId, keypair.publicKey);

  await program.methods
    .claimJob()
    .accounts({
      nodeOwner:   keypair.publicKey,
      nodeAccount: nodePda,
      jobAccount:  jobPubkey,
    })
    .signers([keypair])
    .rpc();
}

export async function submitCommitment(program, keypair, jobPubkey, commitmentBytes) {
  const resultPda = getResultPda(program.programId, jobPubkey, keypair.publicKey);

  await program.methods
    .submitCommitment(Array.from(commitmentBytes))
    .accounts({
      nodeOwner:     keypair.publicKey,
      jobAccount:    jobPubkey,
      resultAccount: resultPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();
}

export async function revealResult(program, keypair, jobPubkey, metrics, nonce) {
  const resultPda = getResultPda(program.programId, jobPubkey, keypair.publicKey);

  await program.methods
    .revealResult(
      metrics.avgLatencyMs,
      metrics.errorRateBps,
      new BN(metrics.requestsCompleted.toString()),
      metrics.baselineLatencyMs ?? 0,
      new BN(nonce.toString()),
    )
    .accounts({
      nodeOwner:     keypair.publicKey,
      jobAccount:    jobPubkey,
      resultAccount: resultPda,
    })
    .signers([keypair])
    .rpc();
}

/**
 * Identifies nodes that claimed but did not commit, then calls force_advance.
 */
export async function forceAdvance(program, keypair, jobPubkey) {
  const job = await program.account.jobAccount.fetch(jobPubkey);

  const absentNodePdas = [];
  for (const nodePubkey of job.claimedNodes) {
    if (nodePubkey.equals(PublicKey.default)) continue;

    const resultPda = getResultPda(program.programId, jobPubkey, nodePubkey);
    try {
      await program.account.resultAccount.fetch(resultPda);
    } catch {
      const nodePda = getNodePda(program.programId, nodePubkey);
      absentNodePdas.push({ pubkey: nodePda, isWritable: true, isSigner: false });
    }
  }

  await program.methods
    .forceAdvance()
    .accounts({ jobAccount: jobPubkey })
    .remainingAccounts(absentNodePdas)
    .rpc();
}

/**
 * Builds remaining_accounts for finalizeJob with the nodes that revealed.
 */
export async function finalizeJob(program, keypair, jobPubkey) {
  const job       = await program.account.jobAccount.fetch(jobPubkey);
  const configPda = getConfigPda(program.programId);
  const config    = await program.account.config.fetch(configPda);

  const resultAccounts = [];
  const walletAccounts = [];
  const nodeAccounts   = [];

  for (const nodePubkey of job.claimedNodes) {
    if (nodePubkey.equals(PublicKey.default)) continue;

    const resultPda = getResultPda(program.programId, jobPubkey, nodePubkey);
    try {
      const result = await program.account.resultAccount.fetch(resultPda);
      if (!result.revealed) continue;

      resultAccounts.push({ pubkey: resultPda,                                 isWritable: false, isSigner: false });
      walletAccounts.push({ pubkey: nodePubkey,                                isWritable: true,  isSigner: false });
      nodeAccounts.push(  { pubkey: getNodePda(program.programId, nodePubkey), isWritable: true,  isSigner: false });
    } catch {
      // Node did not commit — skip
    }
  }

  await program.methods
    .finalizeJob()
    .accounts({
      jobAccount: jobPubkey,
      config:     configPda,
      authority:  config.authority,
    })
    .remainingAccounts([...resultAccounts, ...walletAccounts, ...nodeAccounts])
    .rpc();
}

/**
 * Polls until the job transitions to Running.
 * Falls back to polling when the provider doesn't support WebSocket (e.g. bankrun).
 */
export function waitForJobReady(program, jobPubkey, timeoutMs = 300_000) {
  return _pollUntilRunning(program, jobPubkey, timeoutMs);
}

async function _pollUntilRunning(program, jobPubkey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await program.account.jobAccount.fetch(jobPubkey);
    if (job.status.running !== undefined) return job;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timeout esperando que el job pase a Running (polling)`);
}

/**
 * Polls until RevealPhase. Calls force_advance if the commit_deadline expires.
 */
export async function waitForRevealPhase(program, keypair, jobPubkey, timeoutMs = 300_000) {
  const start = Date.now();
  let forceAdvanceCalled = false;

  while (Date.now() - start < timeoutMs) {
    const job = await program.account.jobAccount.fetch(jobPubkey);

    if (job.status.revealPhase !== undefined) return job;

    const now = Math.floor(Date.now() / 1000);
    if (!forceAdvanceCalled && job.status.running !== undefined && now >= job.commitDeadline.toNumber()) {
      console.log(`[job ${jobPubkey.toString().slice(0, 8)}...] Deadline de commit vencido — llamando force_advance`);
      await forceAdvance(program, keypair, jobPubkey);
      forceAdvanceCalled = true;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Timeout esperando RevealPhase en job ${jobPubkey}`);
}

/**
 * Polls until PendingFinalization. Calls force_advance if the reveal_deadline expires.
 */
export async function waitForPendingFinalization(program, keypair, jobPubkey, timeoutMs = 300_000) {
  const start = Date.now();
  let forceAdvanceCalled = false;

  while (Date.now() - start < timeoutMs) {
    const job = await program.account.jobAccount.fetch(jobPubkey);

    if (job.status.pendingFinalization !== undefined) return job;

    const now = Math.floor(Date.now() / 1000);
    if (!forceAdvanceCalled && job.status.revealPhase !== undefined && now >= job.revealDeadline.toNumber()) {
      console.log(`[job ${jobPubkey.toString().slice(0, 8)}...] Deadline de reveal vencido — llamando force_advance`);
      await forceAdvance(program, keypair, jobPubkey);
      forceAdvanceCalled = true;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Timeout esperando PendingFinalization en job ${jobPubkey}`);
}
