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
/**
 * Waits until a job account satisfies `predicate`, using a websocket account
 * subscription as the fast path plus a low-frequency poll as a safety net.
 *
 * Why not just poll: a tight fetch loop hammers `getAccountInfo` (hundreds of
 * calls per job) and gets rate-limited (429). `onAccountChange` pushes the full
 * decoded state on every change, so we react instantly without polling.
 *
 * Why still poll (slowly): websocket notifications are best-effort — a dropped
 * connection or missed notification would otherwise hang us forever. The fallback
 * fetch (every `fallbackMs`) reconciles missed updates and keeps deadline-based
 * `onState` logic (e.g. force_advance) ticking even when no account change fires.
 *
 * The initial fetch covers the case where the job is already in the target state,
 * and the gap between subscribing and the first notification.
 *
 * @param {Program}   program
 * @param {PublicKey} jobPubkey
 * @param {(job: object) => boolean} predicate  — resolve when this returns true
 * @param {object}    [opts]
 * @param {number}    [opts.timeoutMs=300000]
 * @param {number}    [opts.fallbackMs=10000]   — safety-net poll interval
 * @param {(job: object) => Promise<void>|void} [opts.onState] — run on every observed state
 * @returns {Promise<object>} the decoded job once the predicate holds
 */
function waitForJobStatus(program, jobPubkey, predicate, { timeoutMs = 300_000, fallbackMs = 10_000, onState } = {}) {
  const connection = program.provider.connection;

  return new Promise((resolve, reject) => {
    let done   = false;
    let subId  = null;
    let poller = null;
    let timer  = null;

    const cleanup = () => {
      if (subId !== null) connection.removeAccountChangeListener(subId).catch(() => {});
      if (poller)         clearInterval(poller);
      if (timer)          clearTimeout(timer);
    };
    const settle = (fn, arg) => { if (done) return; done = true; cleanup(); fn(arg); };

    const handle = async (data) => {
      if (done || !data) return;
      let job;
      try {
        job = program.coder.accounts.decode('jobAccount', data);
      } catch {
        return; // stale layout from a previous deploy — ignore
      }
      if (predicate(job)) { settle(resolve, job); return; }
      if (onState) {
        try { await onState(job); } catch (err) { settle(reject, err); }
      }
    };

    // Some providers (e.g. BankrunProvider in tests) have no websocket, so
    // onAccountChange is unavailable — fall back to pure polling in that case.
    const canSubscribe = typeof connection.onAccountChange === 'function';

    // fast path: push the new state on every account change
    if (canSubscribe) {
      subId = connection.onAccountChange(jobPubkey, info => { handle(info.data); }, 'confirmed');
    }

    // With a subscription this is just a slow safety net; without one it IS the
    // mechanism, so poll tightly.
    const pollMs = canSubscribe ? fallbackMs : 400;
    poller = setInterval(async () => {
      try {
        const info = await connection.getAccountInfo(jobPubkey, 'confirmed');
        if (info) handle(info.data);
      } catch { /* transient 429 — the next tick retries */ }
    }, pollMs);

    timer = setTimeout(
      () => settle(reject, new Error(`Timeout esperando estado en job ${jobPubkey}`)),
      timeoutMs,
    );

    // initial fetch: covers an already-satisfied state and the subscribe gap
    connection.getAccountInfo(jobPubkey, 'confirmed')
      .then(info => info && handle(info.data))
      .catch(() => {});
  });
}

export function waitForJobReady(program, jobPubkey, timeoutMs = 300_000) {
  return waitForJobStatus(program, jobPubkey, j => j.status.running !== undefined, { timeoutMs });
}

/**
 * Waits until RevealPhase. Calls force_advance once if the commit_deadline expires.
 */
export function waitForRevealPhase(program, keypair, jobPubkey, timeoutMs = 300_000) {
  let forceAdvanceCalled = false;

  return waitForJobStatus(program, jobPubkey, j => j.status.revealPhase !== undefined, {
    timeoutMs,
    onState: async (job) => {
      const now = Math.floor(Date.now() / 1000);
      if (!forceAdvanceCalled && job.status.running !== undefined && now >= job.commitDeadline.toNumber()) {
        forceAdvanceCalled = true; // set before await — guards against concurrent ticks
        console.log(`[job ${jobPubkey.toString().slice(0, 8)}...] Deadline de commit vencido — llamando force_advance`);
        await forceAdvance(program, keypair, jobPubkey);
      }
    },
  });
}

/**
 * Waits until PendingFinalization. Calls force_advance once if the reveal_deadline expires.
 */
export function waitForPendingFinalization(program, keypair, jobPubkey, timeoutMs = 300_000) {
  let forceAdvanceCalled = false;

  return waitForJobStatus(program, jobPubkey, j => j.status.pendingFinalization !== undefined, {
    timeoutMs,
    onState: async (job) => {
      const now = Math.floor(Date.now() / 1000);
      if (!forceAdvanceCalled && job.status.revealPhase !== undefined && now >= job.revealDeadline.toNumber()) {
        forceAdvanceCalled = true; // set before await — guards against concurrent ticks
        console.log(`[job ${jobPubkey.toString().slice(0, 8)}...] Deadline de reveal vencido — llamando force_advance`);
        await forceAdvance(program, keypair, jobPubkey);
      }
    },
  });
}
