import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
// Namespace import works in both Node (CJS interop → .default) and the browser
// ESM build (named exports, no default).
import * as anchorNS from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorNS.default ?? anchorNS;
// Namespace import: the `fs.readFileSync` property is only accessed when the
// string-path branch runs (Node usage). In the browser we pass the IDL object,
// so the externalized `fs` stub is never touched at module load or runtime.
import * as nodeFs from 'fs';

export class FusillClient {
  // Underscore prefix: privacy convention (not truly private)
  // to allow injection in tests without breaking the public API.
  _program;
  _keypair;

  /**
   * Normal usage:  new FusillClient(keypair, rpcUrl, idlPath)
   * Tests/advanced: new FusillClient(keypair, provider, idl)
   *   where provider is an AnchorProvider/BankrunProvider and idl is the parsed JSON object
   *
   * @param {import('@solana/web3.js').Keypair} keypair
   * @param {string | import('@coral-xyz/anchor').AnchorProvider} rpcUrlOrProvider
   * @param {string | object} idlPathOrIdl
   */
  constructor(keypair, rpcUrlOrProvider, idlPathOrIdl) {
    this._keypair = keypair;

    if (typeof rpcUrlOrProvider === 'string') {
      const connection = new Connection(rpcUrlOrProvider, 'confirmed');
      const provider   = new AnchorProvider(connection, new Wallet(keypair), { commitment: 'confirmed' });
      const idl        = JSON.parse(nodeFs.readFileSync(idlPathOrIdl, 'utf8'));
      this._program    = new Program(idl, provider);
    } else {
      // rpcUrlOrProvider is an AnchorProvider (e.g. BankrunProvider in tests)
      // idlPathOrIdl is the already-parsed IDL object
      this._program = new Program(idlPathOrIdl, rpcUrlOrProvider);
    }
  }

  /**
   * The acting user's public key. Resolves from the injected keypair (Node usage)
   * or, when none is given, from the connected provider wallet (browser usage).
   */
  get _user() {
    return this._keypair?.publicKey ?? this._program.provider.wallet.publicKey;
  }

  /**
   * Extra signers for a transaction. With a Keypair we sign explicitly; with a
   * wallet-adapter provider the wallet signs automatically on .rpc().
   */
  get _extraSigners() {
    return this._keypair ? [this._keypair] : [];
  }

  // ─────────────────────────────────────────────
  // JOBS
  // ─────────────────────────────────────────────

  /**
   * Creates a pentesting job and deposits payment.
   *
   * @param {object}  opts
   * @param {string}  opts.target          — URL or IP:port of the server to test
   * @param {string}  opts.runnerType      — attack type: 'httpFlood' | 'slowloris' |
   *                                         'http2RapidReset' | 'http2Continuation' |
   *                                         'tlsExhaustion' | 'websocketExhaustion' |
   *                                         'dnsFlood' | 'rudy' | 'synFlood' | 'udpFlood'
   * @param {object}  opts.runnerConfig    — runner-specific parameters (JS object)
   * @param {number}  opts.durationSeconds — attack duration (10-3600)
   * @param {number}  opts.minNodes        — minimum number of nodes (1-10)
   * @param {number}  opts.expiryMinutes   — minutes before expiry if not filled (5-30, default 15)
   * @param {number}  opts.paymentSol      — payment in SOL (e.g. 0.03)
   * @param {boolean} opts.scheduledJob    — if true, job waits for scheduleJob() before executing (default false)
   * @param {number}  [opts._createdAt]    — internal: override the created_at timestamp (used by createMultiVectorJob)
   *
   * @returns {Promise<{ jobPubkey: PublicKey, tx: string }>}
   */
  async createJob({ target, runnerType, runnerConfig, durationSeconds, minNodes, expiryMinutes = 15, paymentSol, scheduledJob = false, _createdAt = null }) {
    const paymentLamports  = Math.floor(paymentSol * LAMPORTS_PER_SOL);
    const timestamp        = _createdAt !== null ? BigInt(_createdAt) : BigInt(Math.floor(Date.now() / 1000));
    const runnerTypeAnchor = { [runnerType]: {} };
    const runnerConfigBuf  = Buffer.from(JSON.stringify(runnerConfig));

    const [jobPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('job'),
        this._user.toBuffer(),
        this._toBytesI64LE(timestamp),
      ],
      this._program.programId
    );

    const tx = await this._program.methods
      .createJob(
        new BN(timestamp.toString()),
        target,
        runnerTypeAnchor,
        runnerConfigBuf,
        durationSeconds,
        minNodes,
        expiryMinutes,
        new BN(paymentLamports),
        scheduledJob,
      )
      .accounts({
        user:          this._user,
        jobAccount:    jobPda,
        systemProgram: SystemProgram.programId,
      })
      .signers(this._extraSigners)
      .rpc();

    return { jobPubkey: jobPda, tx };
  }

  /**
   * Sets the coordinated execution timestamp on a filled scheduled job.
   * Transitions the job from Filled → Running; nodes will wait until runAt before firing.
   * Only callable by the job creator.
   *
   * @param {PublicKey} jobPubkey
   * @param {number}    runAt — unix timestamp (seconds) when nodes should execute
   * @returns {Promise<string>} tx signature
   */
  async scheduleJob(jobPubkey, runAt) {
    return this._program.methods
      .scheduleJob(new BN(runAt.toString()))
      .accounts({
        user:       this._user,
        jobAccount: jobPubkey,
      })
      .signers(this._extraSigners)
      .rpc();
  }

  // ─────────────────────────────────────────────
  // MULTI-VECTOR CAMPAIGNS
  // ─────────────────────────────────────────────

  /**
   * Creates a multi-vector campaign: one scheduled job per vector, all sharing the
   * same target, duration, and expiry.  Jobs use offset timestamps so their PDAs
   * are always unique even when called within the same second.
   *
   * Each vector may override `minNodes` and `paymentSol`; otherwise the top-level
   * values act as defaults.
   *
   * @param {object}   opts
   * @param {string}   opts.target          — URL or IP:port of the server to test
   * @param {Array}    opts.vectors         — [{ type, config, minNodes?, paymentSol? }, ...]
   * @param {number}   opts.minNodes        — default nodes required per vector
   * @param {number}   opts.durationSeconds — attack duration (10-3600)
   * @param {number}   opts.expiryMinutes   — minutes before expiry (5-30, default 15)
   * @param {number}   opts.paymentSol      — default payment per job in SOL
   *
   * @returns {Promise<PublicKey[]>} one pubkey per vector, in order
   */
  async createMultiVectorJob({ target, vectors, minNodes, durationSeconds, expiryMinutes = 15, paymentSol }) {
    const baseTimestamp = Math.floor(Date.now() / 1000);
    const jobPubkeys    = [];

    for (let i = 0; i < vectors.length; i++) {
      const { jobPubkey } = await this.createJob({
        target,
        runnerType:      vectors[i].type,
        runnerConfig:    vectors[i].config,
        durationSeconds,
        minNodes:        vectors[i].minNodes ?? minNodes,
        expiryMinutes,
        paymentSol:      vectors[i].paymentSol ?? paymentSol,
        scheduledJob:    true,
        _createdAt:      baseTimestamp + i,
      });
      jobPubkeys.push(jobPubkey);
    }

    return jobPubkeys;
  }

  /**
   * Polls until every job in the list reaches Filled status (all nodes claimed).
   *
   * @param {PublicKey[]} jobPubkeys
   * @param {number}      timeoutMs — default 120 s
   * @returns {Promise<void>}
   */
  async waitForAllFilled(jobPubkeys, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const accounts = await Promise.all(
        jobPubkeys.map(pk => this._program.account.jobAccount.fetch(pk)),
      );
      if (accounts.every(j => j.status.filled !== undefined)) return;
      await new Promise(r => setTimeout(r, 1_000));
    }

    throw new Error('Timeout waiting for all campaign jobs to reach Filled status');
  }

  /**
   * Sets the same execution timestamp on every job in the campaign.
   * Call this after waitForAllFilled to coordinate simultaneous execution.
   *
   * @param {PublicKey[]} jobPubkeys
   * @param {number}      runAt — unix timestamp (seconds)
   * @returns {Promise<void>}
   */
  async scheduleMultiVectorJob(jobPubkeys, runAt) {
    for (const pubkey of jobPubkeys) {
      await this.scheduleJob(pubkey, runAt);
    }
  }

  /**
   * Cancels every job in the campaign and refunds the creator.
   * All jobs must be expired and in Open or Filled status.
   *
   * @param {PublicKey[]} jobPubkeys
   * @returns {Promise<void>}
   */
  async cancelMultiVectorJob(jobPubkeys) {
    for (const pubkey of jobPubkeys) {
      await this.cancelJob(pubkey);
    }
  }

  /**
   * Cancels a job that expired without filling up and recovers the SOL.
   * Can only be called by the job owner.
   *
   * @param {PublicKey} jobPubkey
   * @returns {Promise<string>} tx signature
   */
  async cancelJob(jobPubkey) {
    const job = await this._program.account.jobAccount.fetch(jobPubkey);

    const claimedWallets = job.claimedNodes
      .filter(pk => !pk.equals(PublicKey.default))
      .map(pk => ({ pubkey: pk, isWritable: true, isSigner: false }));

    return this._program.methods
      .cancelJob()
      .accounts({
        user:       this._user,
        jobAccount: jobPubkey,
      })
      .remainingAccounts(claimedWallets)
      .signers(this._extraSigners)
      .rpc();
  }

  // ─────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────

  /**
   * Returns the current state of a job.
   *
   * @param {PublicKey} jobPubkey
   * @returns {Promise<JobInfo>}
   */
  async getJob(jobPubkey) {
    const raw = await this._program.account.jobAccount.fetch(jobPubkey);
    return this._formatJob(jobPubkey, raw);
  }

  /**
   * Fetches the revealed per-node results for a job: baseline vs under-attack
   * latency, error rate, request volume, and the resulting degradation factor.
   *
   * @param {PublicKey} jobPubkey
   * @returns {Promise<Array<{ node, baselineLatencyMs, avgLatencyMs, degradation, errorRatePct, requestsCompleted }>>}
   */
  async getJobResults(jobPubkey) {
    const pk  = new PublicKey(jobPubkey);
    const job = await this._program.account.jobAccount.fetch(pk);

    const results = [];
    for (const node of job.claimedNodes) {
      if (node.equals(PublicKey.default)) continue;

      const [resultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('result'), pk.toBuffer(), node.toBuffer()],
        this._program.programId,
      );

      try {
        const r = await this._program.account.resultAccount.fetch(resultPda);
        if (!r.revealed) continue;

        const baseline = r.baselineLatencyMs;
        const under    = r.avgLatencyMs;
        results.push({
          node:              node.toString(),
          baselineLatencyMs: baseline,
          avgLatencyMs:      under,
          degradation:       baseline > 0 ? Number((under / baseline).toFixed(2)) : null,
          errorRatePct:      r.errorRateBps / 100,
          requestsCompleted: Number(r.requestsCompleted),
        });
      } catch {
        // node claimed but never revealed — skip
      }
    }
    return results;
  }

  /**
   * Fetches and decodes every job account, skipping any whose on-chain layout no
   * longer matches the IDL (leftovers from a previous program deploy still match
   * the account discriminator, which is just hash("account:JobAccount")).
   *
   * We decode each account individually rather than using
   * `program.account.jobAccount.all()` because that helper decodes the whole batch
   * and throws on the first undecodable account, which would break the listing.
   *
   * @returns {Promise<Array<{ publicKey: PublicKey, account: object }>>}
   */
  async _fetchAllJobsResilient() {
    const accountName   = 'jobAccount';
    const discriminator = this._program.coder.accounts.memcmp(accountName).bytes;

    const rawAccounts = await this._program.provider.connection.getProgramAccounts(
      this._program.programId,
      { filters: [{ memcmp: { offset: 0, bytes: discriminator } }] },
    );

    const jobs = [];
    for (const { pubkey, account } of rawAccounts) {
      try {
        const decoded = this._program.coder.accounts.decode(accountName, account.data);
        jobs.push({ publicKey: pubkey, account: decoded });
      } catch {
        // Stale account from a previous program layout — skip it.
      }
    }
    return jobs;
  }

  /**
   * Lists all jobs for this user, sorted by creation date descending.
   *
   * @returns {Promise<JobInfo[]>}
   */
  async listJobs() {
    const all = await this._fetchAllJobsResilient();

    return all
      .filter(j => j.account.owner.equals(this._user))
      .map(j => this._formatJob(j.publicKey, j.account))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Lists all jobs on the network, sorted by payment descending.
   *
   * @returns {Promise<JobInfo[]>}
   */
  async listAllJobs() {
    const all = await this._fetchAllJobsResilient();

    return all
      .map(j => this._formatJob(j.publicKey, j.account))
      .sort((a, b) => b.paymentSol - a.paymentSol);
  }

  // ─────────────────────────────────────────────
  // EVENTS
  // ─────────────────────────────────────────────

  /**
   * Subscribes to the finalization event of a specific job.
   *
   * @param {PublicKey} jobPubkey
   * @param {function}  callback  — receives { honestNodes, paymentPerNodeSol, protocolFeeSol }
   * @returns {function} unsubscribe
   */
  onJobFinalized(jobPubkey, callback) {
    // Event name must match the IDL (PascalCase)
    const listenerId = this._program.addEventListener('JobFinalized', (event) => {
      if (!event.job.equals(jobPubkey)) return;

      callback({
        honestNodes:       event.honestNodes,
        paymentPerNodeSol: event.paymentPerHonest.toNumber() / LAMPORTS_PER_SOL,
        protocolFeeSol:    event.protocolFee.toNumber() / LAMPORTS_PER_SOL,
      });
    });

    return () => this._program.removeEventListener(listenerId);
  }

  /**
   * Waits for a job to finish and returns the results.
   * Promise-based alternative to onJobFinalized.
   *
   * @param {PublicKey} jobPubkey
   * @param {number}    timeoutMs
   * @returns {Promise<{ honestNodes, paymentPerNodeSol, protocolFeeSol }>}
   */
  waitForFinalization(jobPubkey, timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for finalization of job ${jobPubkey}`));
      }, timeoutMs);

      const unsubscribe = this.onJobFinalized(jobPubkey, (result) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      });
    });
  }

  // ─────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────

  _formatJob(pubkey, raw) {
    const status     = Object.keys(raw.status)[0];
    const runnerType = Object.keys(raw.runnerType)[0];
    let   runnerConfig;
    try {
      runnerConfig = JSON.parse(Buffer.from(raw.runnerConfig).toString('utf8'));
    } catch {
      runnerConfig = raw.runnerConfig;
    }

    return {
      pubkey:          pubkey.toString(),
      target:          raw.target,
      runnerType,
      runnerConfig,
      durationSeconds: raw.durationSeconds,
      minNodes:        raw.minNodes,
      nodesClaimed:    raw.nodesClaimed,
      paymentSol:      raw.payment.toNumber() / LAMPORTS_PER_SOL,
      status,
      createdAt:       new Date(raw.createdAt.toNumber() * 1000),
      expiresAt:       new Date(raw.expiresAt.toNumber() * 1000),
      scheduledJob:    raw.scheduledJob ?? false,
      scheduledAt:     raw.scheduledAt?.toNumber() ?? 0,
    };
  }

  // i64 little-endian — matches the PDA seed in the contract
  _toBytesI64LE(value) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value);
    return buf;
  }

  // Test factory: injects a mock program bypassing the normal constructor
  static _withProgram(keypair, program) {
    const instance = Object.create(FusillClient.prototype);
    instance._keypair = keypair;
    instance._program = program;
    return instance;
  }
}
