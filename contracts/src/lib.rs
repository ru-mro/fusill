use anchor_lang::prelude::*;
use tiny_keccak::{Hasher, Keccak};

declare_id!("G6xojg6mCoin9HnQ1Nv1sXJyLTgjrNpY7M2CioW1Dy2c");

const INCINERATOR: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

const JOB_EXPIRY_MIN_MINUTES: i64      = 5;
const JOB_EXPIRY_MAX_MINUTES: i64      = 30;
const MIN_STAKE_LAMPORTS: u64          = 500_000_000; // 0.5 SOL
const CLAIM_COMPENSATION_LAMPORTS: u64 = 5_000;
const COMMIT_BUFFER_SECONDS: i64       = 2 * 60;
const REVEAL_DEADLINE_SECONDS: i64     = 2 * 60;
const PROTOCOL_FEE_BPS: u64           = 500; // 5% in basis points (500/10000)
const MAX_TARGET_LEN: usize            = 200;
const MAX_RUNNER_CONFIG_LEN: usize     = 500;

// ── Consensus ────────────────────────────────────────────────────────────────

enum ConsensusMetric { AvgLatencyMs, ErrorRateBps }

fn runner_consensus_metric(runner_type: &RunnerType) -> ConsensusMetric {
    match runner_type {
        RunnerType::HttpFlood     => ConsensusMetric::AvgLatencyMs,
        RunnerType::TlsExhaustion => ConsensusMetric::AvgLatencyMs,
        RunnerType::DnsFlood      => ConsensusMetric::AvgLatencyMs,
        _                         => ConsensusMetric::ErrorRateBps,
    }
}

fn extract_consensus_value(result: &ResultAccount, metric: &ConsensusMetric) -> u32 {
    match metric {
        ConsensusMetric::AvgLatencyMs => result.avg_latency_ms,
        ConsensusMetric::ErrorRateBps => result.error_rate_bps,
    }
}

fn consensus_tolerance(center: u32, metric: &ConsensusMetric) -> u32 {
    let relative = center / 5; // 20% relative
    match metric {
        ConsensusMetric::AvgLatencyMs => relative,
        // Minimum 500 bps (5 percentage points) to avoid penalizing network noise
        // when the error rate is low but legitimately variable.
        ConsensusMetric::ErrorRateBps => relative.max(500),
    }
}

/// Median of a set of values — the consensus center.
///
/// The median is robust to a manipulating majority or a single outlier dragging
/// the result: with the mean, a node (or a colluding group) reporting an extreme
/// value shifts the center and can push honest nodes outside the tolerance band.
/// Operates on a copy so the caller's per-node ordering is preserved.
fn median_u32(values: &[u32]) -> u32 {
    let n = values.len();
    if n == 0 {
        return 0;
    }
    let mut sorted: Vec<u32> = values.to_vec();
    sorted.sort_unstable();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        // Average of the two central elements (widened to u64 to avoid overflow).
        ((sorted[n / 2 - 1] as u64 + sorted[n / 2] as u64) / 2) as u32
    }
}

// ─────────────────────────────────────────────────────────────────────────────

const REPUTATION_PENALTY_ABSENT: u8    = 20;
const REPUTATION_PENALTY_DISHONEST: u8 = 10;
const REPUTATION_GAIN_HONEST: u8       = 5;

// Thresholds for withdraw_stake
const REP_FULL_REFUND: u8    = 80; // >= 80 → 100% stake refund
const REP_PARTIAL_REFUND: u8 = 50; // 50-79 → 50% refund, 50% burned
                                    // < 50  → loses all, burned

#[program]
pub mod fusill {
    use super::*;

    /// Initializes global program config.
    /// Can only be called once by the deployer.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.bump = ctx.bumps.config;

        emit!(ProgramInitialized { authority: config.authority });
        Ok(())
    }

    /// Node registers with minimum 0.5 SOL stake.
    pub fn register_node(ctx: Context<RegisterNode>, stake_amount: u64) -> Result<()> {
        require!(stake_amount >= MIN_STAKE_LAMPORTS, FusillError::StakeTooLow);

        anchor_lang::system_program::transfer(
            CpiContext::new(
                anchor_lang::system_program::ID,
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.node_account.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        let node = &mut ctx.accounts.node_account;
        node.owner = ctx.accounts.owner.key();
        node.stake = stake_amount;
        node.jobs_completed = 0;
        node.reputation = 100;
        node.is_active = true;

        emit!(NodeRegistered { node: node.owner, stake: stake_amount });
        Ok(())
    }

    /// Node withdraws stake. Amount depends on reputation.
    ///
    /// >= 80 reputation → 100% stake refund
    /// 50-79            → 50% refund, 50% burned
    /// < 50             → loses all, burned
    pub fn withdraw_stake(ctx: Context<WithdrawStake>) -> Result<()> {
        let node = &mut ctx.accounts.node_account;

        require!(node.is_active, FusillError::NodeNotActive);
        require!(node.owner == ctx.accounts.owner.key(), FusillError::Unauthorized);

        let stake = node.stake;
        let reputation = node.reputation;

        let (node_refund, burn_amount) = if reputation >= REP_FULL_REFUND {
            (stake, 0u64)
        } else if reputation >= REP_PARTIAL_REFUND {
            let half = stake / 2;
            (half, stake - half)
        } else {
            (0u64, stake)
        };

        node.is_active = false;
        node.stake = 0;

        if node_refund > 0 {
            **ctx.accounts.node_account.to_account_info().lamports.borrow_mut() -= node_refund;
            **ctx.accounts.owner.to_account_info().lamports.borrow_mut() += node_refund;
        }

        // Lost stake is burned by sending it to Solana's incinerator.
        // SOL sent there is unrecoverable — permanently removed from circulation.
        if burn_amount > 0 {
            **ctx.accounts.node_account.to_account_info().lamports.borrow_mut() -= burn_amount;
            **ctx.accounts.incinerator.lamports.borrow_mut() += burn_amount;
        }

        emit!(StakeWithdrawn {
            node: ctx.accounts.owner.key(),
            refund: node_refund,
            burned: burn_amount,
            reputation,
        });
        Ok(())
    }

    /// User creates a job and deposits payment for the nodes.
    ///
    /// When `scheduled_job` is true the job will not transition to Running when all nodes claim
    /// it — it stays in Filled until the creator calls `schedule_job` to set the coordinated
    /// execution timestamp.  This is the building block for multi-vector campaigns.
    pub fn create_job(
        ctx: Context<CreateJob>,
        created_at: i64,
        target: String,
        runner_type: RunnerType,
        runner_config: Vec<u8>,
        duration_seconds: u32,
        min_nodes: u8,
        expiry_minutes: u8,
        payment_lamports: u64,
        scheduled_job: bool,
    ) -> Result<()> {
        require!(target.len() <= MAX_TARGET_LEN, FusillError::TargetTooLong);
        require!(runner_config.len() <= MAX_RUNNER_CONFIG_LEN, FusillError::RunnerConfigTooLarge);
        require!(duration_seconds >= 10 && duration_seconds <= 3600, FusillError::InvalidParams);
        require!(min_nodes >= 1 && min_nodes <= 10, FusillError::InvalidParams);
        require!(
            (expiry_minutes as i64) >= JOB_EXPIRY_MIN_MINUTES && (expiry_minutes as i64) <= JOB_EXPIRY_MAX_MINUTES,
            FusillError::InvalidParams
        );
        require!(
            payment_lamports >= CLAIM_COMPENSATION_LAMPORTS * min_nodes as u64,
            FusillError::PaymentTooLow
        );

        anchor_lang::system_program::transfer(
            CpiContext::new(
                anchor_lang::system_program::ID,
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.job_account.to_account_info(),
                },
            ),
            payment_lamports,
        )?;

        let job_key = ctx.accounts.job_account.key();
        let job = &mut ctx.accounts.job_account;
        job.owner = ctx.accounts.user.key();
        job.target = target;
        job.runner_type = runner_type;
        job.runner_config = runner_config;
        job.duration_seconds = duration_seconds;
        job.min_nodes = min_nodes;
        job.nodes_claimed = 0;
        job.commits_submitted = 0;
        job.reveals_submitted = 0;
        job.payment = payment_lamports;
        job.status = JobStatus::Open;
        job.created_at = created_at;
        job.expires_at = created_at + (expiry_minutes as i64) * 60;
        job.commit_deadline = 0;
        job.reveal_deadline = 0;
        job.ownership_verified = false;
        job.claimed_nodes = [Pubkey::default(); 10];
        job.scheduled_job = scheduled_job;
        job.scheduled_at = 0;

        emit!(JobCreated {
            job: job_key,
            owner: job.owner,
            target: job.target.clone(),
            runner_type: job.runner_type.clone(),
            payment: payment_lamports,
            expires_at: job.expires_at,
        });
        Ok(())
    }

    /// Node claims the job and gets registered in it.
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        let job_key = ctx.accounts.job_account.key();
        let job = &mut ctx.accounts.job_account;
        let now = Clock::get()?.unix_timestamp;

        require!(job.status == JobStatus::Open, FusillError::JobNotOpen);
        require!(job.nodes_claimed < job.min_nodes, FusillError::JobAlreadyFull);
        require!(now < job.expires_at, FusillError::JobExpired);

        let node = &ctx.accounts.node_account;
        require!(node.is_active, FusillError::NodeNotActive);
        require!(node.owner == ctx.accounts.node_owner.key(), FusillError::Unauthorized);

        let slot = job.nodes_claimed as usize;
        job.claimed_nodes[slot] = ctx.accounts.node_owner.key();
        job.nodes_claimed += 1;

        if job.nodes_claimed == job.min_nodes {
            if job.scheduled_job {
                // Wait for the creator to call schedule_job before transitioning to Running
                job.status = JobStatus::Filled;
            } else {
                job.status = JobStatus::Running;
                job.commit_deadline = now + job.duration_seconds as i64 + COMMIT_BUFFER_SECONDS;
                emit!(JobReady {
                    job: job_key,
                    target: job.target.clone(),
                    runner_type: job.runner_type.clone(),
                    runner_config: job.runner_config.clone(),
                    duration_seconds: job.duration_seconds,
                });
            }
        }

        emit!(JobClaimed { job: job_key, node: node.owner });
        Ok(())
    }

    /// Sets the coordinated execution timestamp on a filled scheduled job.
    ///
    /// Only the job creator can call this.  All nodes polling the job will see the transition
    /// to Running and wait until `run_at` before firing the attack.
    pub fn schedule_job(ctx: Context<ScheduleJob>, run_at: i64) -> Result<()> {
        let job_key = ctx.accounts.job_account.key();
        let job     = &mut ctx.accounts.job_account;
        let now     = Clock::get()?.unix_timestamp;

        require!(job.owner == ctx.accounts.user.key(), FusillError::Unauthorized);
        require!(job.status == JobStatus::Filled, FusillError::JobNotFilled);
        require!(run_at > now, FusillError::InvalidParams);

        job.scheduled_at   = run_at;
        job.status         = JobStatus::Running;
        // Commit deadline starts from run_at, giving nodes time to execute first
        job.commit_deadline = run_at + job.duration_seconds as i64 + COMMIT_BUFFER_SECONDS;

        emit!(JobReady {
            job: job_key,
            target: job.target.clone(),
            runner_type: job.runner_type.clone(),
            runner_config: job.runner_config.clone(),
            duration_seconds: job.duration_seconds,
        });
        emit!(JobScheduled { job: job_key, run_at });
        Ok(())
    }

    /// PHASE 1 — Node commits the hash of its results without revealing them.
    pub fn submit_commitment(
        ctx: Context<SubmitCommitment>,
        commitment: [u8; 32],
    ) -> Result<()> {
        let job_key = ctx.accounts.job_account.key();
        let job = &mut ctx.accounts.job_account;
        let now = Clock::get()?.unix_timestamp;

        require!(job.status == JobStatus::Running, FusillError::JobNotRunning);
        require!(now < job.commit_deadline, FusillError::CommitDeadlinePassed);

        let result = &mut ctx.accounts.result_account;
        result.job = job_key;
        result.node = ctx.accounts.node_owner.key();
        result.commitment = commitment;
        result.committed_at = now;
        result.revealed = false;
        result.avg_latency_ms = 0;
        result.error_rate_bps = 0;
        result.requests_completed = 0;
        result.baseline_latency_ms = 0;
        result.revealed_at = 0;

        job.commits_submitted += 1;

        if job.commits_submitted == job.min_nodes {
            job.status = JobStatus::RevealPhase;
            job.reveal_deadline = now + REVEAL_DEADLINE_SECONDS;
        }

        emit!(CommitmentSubmitted { job: ctx.accounts.job_account.key(), node: result.node });
        Ok(())
    }

    /// PHASE 2 — Node reveals its actual results and nonce.
    pub fn reveal_result(
        ctx: Context<RevealResult>,
        avg_latency_ms: u32,
        error_rate_bps: u32,
        requests_completed: u64,
        baseline_latency_ms: u32,
        nonce: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job_key = ctx.accounts.job_account.key();

        // Check status BEFORE accessing result_account (which may not exist yet)
        require!(ctx.accounts.job_account.status == JobStatus::RevealPhase, FusillError::JobNotInRevealPhase);
        require!(now < ctx.accounts.job_account.reveal_deadline, FusillError::RevealDeadlinePassed);

        let node_pubkey;
        {
            let mut result_data = ctx.accounts.result_account.try_borrow_mut_data()?;
            let mut result = ResultAccount::try_deserialize(&mut &result_data[..])?;

            require!(!result.revealed, FusillError::AlreadyRevealed);
            require!(result.node == ctx.accounts.node_owner.key(), FusillError::Unauthorized);

            let mut hash_input = Vec::new();
            hash_input.extend_from_slice(&avg_latency_ms.to_le_bytes());
            hash_input.extend_from_slice(&error_rate_bps.to_le_bytes());
            hash_input.extend_from_slice(&requests_completed.to_le_bytes());
            hash_input.extend_from_slice(&baseline_latency_ms.to_le_bytes());
            hash_input.extend_from_slice(&nonce.to_le_bytes());

            let computed_hash = keccak256(&hash_input);
            require!(computed_hash == result.commitment, FusillError::CommitmentMismatch);

            result.avg_latency_ms = avg_latency_ms;
            result.error_rate_bps = error_rate_bps;
            result.requests_completed = requests_completed;
            result.baseline_latency_ms = baseline_latency_ms;
            result.revealed = true;
            result.revealed_at = now;
            node_pubkey = result.node;

            let mut cursor = std::io::Cursor::new(&mut result_data[..]);
            result.try_serialize(&mut cursor)?;
        }

        let job = &mut ctx.accounts.job_account;
        job.reveals_submitted += 1;

        if job.reveals_submitted == job.min_nodes {
            job.status = JobStatus::PendingFinalization;
        }

        emit!(ResultRevealed {
            job: job_key,
            node: node_pubkey,
            avg_latency_ms,
            baseline_latency_ms,
        });
        Ok(())
    }

    /// Advances the job when a deadline has passed and a node failed to participate.
    /// Can be called by anyone — rescue mechanism for the job.
    /// remaining_accounts = NodeAccounts of nodes that did not participate.
    pub fn force_advance(ctx: Context<ForceAdvance>) -> Result<()> {
        let job = &mut ctx.accounts.job_account;
        let now = Clock::get()?.unix_timestamp;

        match job.status.clone() {
            JobStatus::Running => {
                require!(now >= job.commit_deadline, FusillError::DeadlineNotReached);
                require!(job.commits_submitted > 0, FusillError::NoParticipantsYet);
                job.status = JobStatus::RevealPhase;
                job.reveal_deadline = now + REVEAL_DEADLINE_SECONDS;
            }
            JobStatus::RevealPhase => {
                require!(now >= job.reveal_deadline, FusillError::DeadlineNotReached);
                require!(job.reveals_submitted > 0, FusillError::NoParticipantsYet);
                job.status = JobStatus::PendingFinalization;
            }
            _ => return Err(FusillError::InvalidJobStatus.into()),
        }

        let claimed = job.claimed_nodes;
        let claimed_count = job.nodes_claimed as usize;

        for node_info in ctx.remaining_accounts.iter() {
            require!(node_info.owner == ctx.program_id, FusillError::InvalidAccount);

            let mut data = node_info.try_borrow_mut_data()?;
            let mut node = NodeAccount::try_deserialize(&mut &data[..])?;

            require!(
                claimed[..claimed_count].contains(&node.owner),
                FusillError::NodeNotInJob
            );

            node.reputation = node.reputation.saturating_sub(REPUTATION_PENALTY_ABSENT);

            let mut cursor = std::io::Cursor::new(&mut data[..]);
            node.try_serialize(&mut cursor)?;
        }

        emit!(JobForceAdvanced { job: ctx.accounts.job_account.key() });
        Ok(())
    }

    /// Finalizes the job, computes consensus, and distributes payment.
    ///
    /// Payment distribution:
    ///   5%  → deployer (protocol fee, via Config)
    ///   95% → split among nodes that passed consensus
    ///   Dishonest or absent nodes do not get paid — their share goes to honest nodes
    ///
    /// remaining_accounts layout — N = reveals_submitted:
    ///   [0..N]   → ResultAccounts of nodes that revealed
    ///   [N..2N]  → Wallets of those nodes
    ///   [2N..3N] → NodeAccounts of those nodes (to update reputation)
    pub fn finalize_job(ctx: Context<FinalizeJob>) -> Result<()> {
        require!(
            ctx.accounts.job_account.status == JobStatus::PendingFinalization,
            FusillError::JobNotFinalizable
        );

        let reveals_count = ctx.accounts.job_account.reveals_submitted as usize;
        let payment       = ctx.accounts.job_account.payment;
        let job_key       = ctx.accounts.job_account.key();

        require!(ctx.remaining_accounts.len() >= reveals_count * 3, FusillError::MissingAccounts);

        let result_infos  = &ctx.remaining_accounts[0..reveals_count];
        let node_wallets  = &ctx.remaining_accounts[reveals_count..reveals_count * 2];
        let node_accounts = &ctx.remaining_accounts[reveals_count * 2..reveals_count * 3];

        // Determine which metric to use based on runner type
        let metric = runner_consensus_metric(&ctx.accounts.job_account.runner_type);

        // Read revealed results, validate each ResultAccount is the canonical
        // program-owned PDA, and capture both the consensus value and the node
        // identity it is bound to. Because the PDA seeds include the node pubkey
        // and the account is program-owned, it could only have been created by
        // submit_commitment — so `result.node` is authentic once the PDA matches.
        let mut values: Vec<u32>    = Vec::new();
        let mut nodes:  Vec<Pubkey> = Vec::new();
        for result_info in result_infos.iter() {
            require!(result_info.owner == ctx.program_id, FusillError::InvalidAccount);

            let data = result_info.data.borrow();
            let result = ResultAccount::try_deserialize(&mut &data[..])?;
            require!(result.revealed, FusillError::ResultNotRevealed);
            require!(result.job == job_key, FusillError::InvalidAccount);

            let (expected, _) = Pubkey::find_program_address(
                &[b"result", job_key.as_ref(), result.node.as_ref()],
                ctx.program_id,
            );
            require!(result_info.key() == expected, FusillError::InvalidAccount);

            values.push(extract_consensus_value(&result, &metric));
            nodes.push(result.node);
        }

        // Use the median as the consensus center and derive the tolerance from it.
        let center    = median_u32(&values);
        let tolerance = consensus_tolerance(center, &metric);

        let mut honest_flags = vec![false; reveals_count];
        let mut honest_count: u64 = 0;

        for (i, &value) in values.iter().enumerate() {
            if value.abs_diff(center) <= tolerance {
                honest_flags[i] = true;
                honest_count += 1;
            }
        }

        // 5% to deployer as protocol fee
        let protocol_fee  = payment * PROTOCOL_FEE_BPS / 10_000;
        let distributable = payment - protocol_fee;

        **ctx.accounts.job_account.to_account_info().lamports.borrow_mut() -= protocol_fee;
        **ctx.accounts.authority.to_account_info().lamports.borrow_mut() += protocol_fee;

        // 95% split among honest nodes only.
        // Dividing by honest_count (not reveals_count) lets honest nodes absorb
        // the dishonest nodes' share automatically — nothing left over.
        // If nobody was honest, the distributable goes to deployer as fallback.
        let payment_per_honest = if honest_count > 0 {
            distributable / honest_count
        } else {
            0
        };

        for i in 0..reveals_count {
            // Bind the wallet being paid and the NodeAccount being updated to the
            // node that actually revealed (nodes[i]). Without this, any caller could
            // redirect the payout to arbitrary wallets.
            require!(node_wallets[i].key() == nodes[i], FusillError::InvalidAccount);
            require!(node_accounts[i].owner == ctx.program_id, FusillError::InvalidAccount);
            let (expected_node, _) = Pubkey::find_program_address(
                &[b"node", nodes[i].as_ref()],
                ctx.program_id,
            );
            require!(node_accounts[i].key() == expected_node, FusillError::InvalidAccount);

            let mut data = node_accounts[i].try_borrow_mut_data()?;
            let mut node = NodeAccount::try_deserialize(&mut &data[..])?;

            if honest_flags[i] {
                **ctx.accounts.job_account.to_account_info().lamports.borrow_mut() -= payment_per_honest;
                **node_wallets[i].lamports.borrow_mut() += payment_per_honest;
                node.reputation = node.reputation.saturating_add(REPUTATION_GAIN_HONEST).min(100);
                node.jobs_completed += 1;
            } else {
                node.reputation = node.reputation.saturating_sub(REPUTATION_PENALTY_DISHONEST);
            }

            let mut cursor = std::io::Cursor::new(&mut data[..]);
            node.try_serialize(&mut cursor)?;
        }

        // Integer rounding remainder (distributable % honest_count) goes to deployer.
        // If nobody was honest, all the distributable goes to deployer.
        let total_paid_to_nodes = payment_per_honest * honest_count;
        let remainder = distributable - total_paid_to_nodes;
        if remainder > 0 {
            **ctx.accounts.job_account.to_account_info().lamports.borrow_mut() -= remainder;
            **ctx.accounts.authority.to_account_info().lamports.borrow_mut() += remainder;
        }

        ctx.accounts.job_account.status = JobStatus::Completed;

        emit!(JobFinalized {
            job: ctx.accounts.job_account.key(),
            honest_nodes: honest_count as u8,
            payment_per_honest,
            protocol_fee,
        });
        Ok(())
    }

    /// User cancels the job if it expired without filling up.
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        require!(ctx.accounts.job_account.owner == ctx.accounts.user.key(), FusillError::Unauthorized);
        require!(
            ctx.accounts.job_account.status == JobStatus::Open
            || ctx.accounts.job_account.status == JobStatus::Filled,
            FusillError::JobNotCancellable
        );
        require!(now >= ctx.accounts.job_account.expires_at, FusillError::JobNotExpired);

        let nodes_claimed = ctx.accounts.job_account.nodes_claimed as usize;
        let payment       = ctx.accounts.job_account.payment;
        let claimed_nodes = ctx.accounts.job_account.claimed_nodes;

        ctx.accounts.job_account.status = JobStatus::Cancelled;

        let total_compensation = CLAIM_COMPENSATION_LAMPORTS * nodes_claimed as u64;

        for i in 0..nodes_claimed {
            let node_pubkey = claimed_nodes[i];
            if node_pubkey == Pubkey::default() { continue; }
            for remaining in ctx.remaining_accounts.iter() {
                if remaining.key() == node_pubkey {
                    **ctx.accounts.job_account.to_account_info().lamports.borrow_mut() -= CLAIM_COMPENSATION_LAMPORTS;
                    **remaining.lamports.borrow_mut() += CLAIM_COMPENSATION_LAMPORTS;
                    break;
                }
            }
        }

        let refund = payment.saturating_sub(total_compensation);
        **ctx.accounts.job_account.to_account_info().lamports.borrow_mut() -= refund;
        **ctx.accounts.user.to_account_info().lamports.borrow_mut() += refund;

        emit!(JobCancelled {
            job: ctx.accounts.job_account.key(),
            owner: ctx.accounts.job_account.owner,
            refund,
            nodes_compensated: nodes_claimed as u8,
        });
        Ok(())
    }
}

// ============================================================
// ACCOUNTS
// ============================================================

#[account]
pub struct Config {
    pub authority: Pubkey, // deployer wallet — receives the protocol fee
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 32 + 1;
}

#[account]
pub struct NodeAccount {
    pub owner: Pubkey,
    pub stake: u64,
    pub jobs_completed: u64,
    pub reputation: u8,
    pub is_active: bool,
}

impl NodeAccount {
    pub const LEN: usize = 32 + 8 + 8 + 1 + 1;
}

#[account]
pub struct JobAccount {
    pub owner: Pubkey,
    pub target: String,
    pub runner_type: RunnerType,
    pub runner_config: Vec<u8>,
    pub duration_seconds: u32,
    pub min_nodes: u8,
    pub nodes_claimed: u8,
    pub commits_submitted: u8,
    pub reveals_submitted: u8,
    pub payment: u64,
    pub status: JobStatus,
    pub created_at: i64,
    pub expires_at: i64,
    pub commit_deadline: i64,
    pub reveal_deadline: i64,
    pub ownership_verified: bool,
    pub claimed_nodes: [Pubkey; 10],
    pub scheduled_job: bool,    // if true, execution waits for schedule_job to set scheduled_at
    pub scheduled_at: i64,      // unix timestamp at which all nodes should fire; 0 = not yet set
}

impl JobAccount {
    pub const LEN: usize =
        8           // discriminator
        + 32        // owner
        + 4 + 200   // target (len prefix + max 200 bytes)
        + 1         // runner_type enum
        + 4 + 500   // runner_config (len prefix + max 500 bytes)
        + 4         // duration_seconds
        + 1         // min_nodes
        + 1         // nodes_claimed
        + 1         // commits_submitted
        + 1         // reveals_submitted
        + 8         // payment
        + 1         // status enum
        + 8         // created_at
        + 8         // expires_at
        + 8         // commit_deadline
        + 8         // reveal_deadline
        + 1         // ownership_verified
        + 320       // claimed_nodes [Pubkey; 10]
        + 1         // scheduled_job
        + 8;        // scheduled_at
}

#[account]
pub struct ResultAccount {
    pub job: Pubkey,
    pub node: Pubkey,
    pub commitment: [u8; 32],
    pub committed_at: i64,
    pub revealed: bool,
    pub avg_latency_ms: u32,        // latency under attack
    pub error_rate_bps: u32,
    pub requests_completed: u64,
    pub baseline_latency_ms: u32,   // latency measured before the attack started
    pub revealed_at: i64,
}

impl ResultAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1 + 4 + 4 + 8 + 4 + 8;
}

// ============================================================
// STATES
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum RunnerType {
    HttpFlood,
    Slowloris,
    Http2RapidReset,
    Http2Continuation,
    TlsExhaustion,
    WebsocketExhaustion,
    DnsFlood,
    SynFlood,
    UdpFlood,
    // Appended at the end to preserve the serialized index of existing variants.
    Rudy,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Filled,             // scheduled job: all nodes claimed, waiting for schedule_job call
    Running,
    RevealPhase,
    PendingFinalization,
    Completed,
    Cancelled,
}

// ============================================================
// CONTEXTS
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority,
        space = 8 + Config::LEN,
        seeds = [b"config"], bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterNode<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init, payer = owner,
        space = 8 + NodeAccount::LEN,
        seeds = [b"node", owner.key().as_ref()], bump
    )]
    pub node_account: Account<'info, NodeAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [b"node", owner.key().as_ref()], bump)]
    pub node_account: Account<'info, NodeAccount>,

    /// CHECK: Solana incinerator — SOL sent here is permanently burned
    #[account(mut, address = INCINERATOR)]
    pub incinerator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(created_at: i64)]
pub struct CreateJob<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init, payer = user,
        space = JobAccount::LEN,
        seeds = [b"job", user.key().as_ref(), &created_at.to_le_bytes()], bump
    )]
    pub job_account: Account<'info, JobAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ScheduleJob<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
}

#[derive(Accounts)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub node_owner: Signer<'info>,
    #[account(mut, seeds = [b"node", node_owner.key().as_ref()], bump)]
    pub node_account: Account<'info, NodeAccount>,
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
}

#[derive(Accounts)]
pub struct SubmitCommitment<'info> {
    #[account(mut)]
    pub node_owner: Signer<'info>,
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
    #[account(
        init, payer = node_owner,
        space = 8 + ResultAccount::LEN,
        seeds = [b"result", job_account.key().as_ref(), node_owner.key().as_ref()], bump
    )]
    pub result_account: Account<'info, ResultAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealResult<'info> {
    #[account(mut)]
    pub node_owner: Signer<'info>,
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
    /// CHECK: status checked in instruction before this account is accessed
    #[account(
        mut,
        seeds = [b"result", job_account.key().as_ref(), node_owner.key().as_ref()], bump
    )]
    pub result_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ForceAdvance<'info> {
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
    // remaining_accounts = NodeAccounts of absent nodes
}

#[derive(Accounts)]
pub struct FinalizeJob<'info> {
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: deployer wallet — receives the 5% protocol fee
    #[account(mut, constraint = authority.key() == config.authority @ FusillError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,

    // remaining_accounts: [ResultAccounts x N, wallets x N, NodeAccounts x N]
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
    // remaining_accounts = wallets of nodes that made a claim
}

// ============================================================
// EVENTS
// ============================================================

#[event] pub struct ProgramInitialized  { pub authority: Pubkey }
#[event] pub struct NodeRegistered      { pub node: Pubkey, pub stake: u64 }
#[event] pub struct StakeWithdrawn      { pub node: Pubkey, pub refund: u64, pub burned: u64, pub reputation: u8 }
#[event] pub struct JobCreated          { pub job: Pubkey, pub owner: Pubkey, pub target: String, pub runner_type: RunnerType, pub payment: u64, pub expires_at: i64 }
#[event] pub struct JobReady            { pub job: Pubkey, pub target: String, pub runner_type: RunnerType, pub runner_config: Vec<u8>, pub duration_seconds: u32 }
#[event] pub struct JobClaimed          { pub job: Pubkey, pub node: Pubkey }
#[event] pub struct CommitmentSubmitted { pub job: Pubkey, pub node: Pubkey }
#[event] pub struct ResultRevealed      { pub job: Pubkey, pub node: Pubkey, pub avg_latency_ms: u32, pub baseline_latency_ms: u32 }
#[event] pub struct JobForceAdvanced    { pub job: Pubkey }
#[event] pub struct JobFinalized        { pub job: Pubkey, pub honest_nodes: u8, pub payment_per_honest: u64, pub protocol_fee: u64 }
#[event] pub struct JobCancelled        { pub job: Pubkey, pub owner: Pubkey, pub refund: u64, pub nodes_compensated: u8 }
#[event] pub struct JobScheduled        { pub job: Pubkey, pub run_at: i64 }

// ============================================================
// ERRORS
// ============================================================

#[error_code]
pub enum FusillError {
    #[msg("Minimum stake required: 0.5 SOL")]
    StakeTooLow,
    #[msg("Target too long, maximum 200 characters")]
    TargetTooLong,
    #[msg("Runner config too large, maximum 500 bytes")]
    RunnerConfigTooLarge,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Payment is insufficient to cover minimum node compensation")]
    PaymentTooLow,
    #[msg("Job is not open for claims")]
    JobNotOpen,
    #[msg("Job is not in Filled state")]
    JobNotFilled,
    #[msg("Job cannot be cancelled in its current state")]
    JobNotCancellable,
    #[msg("Job is already full")]
    JobAlreadyFull,
    #[msg("Node is not active")]
    NodeNotActive,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Job is not in Running state")]
    JobNotRunning,
    #[msg("Job is not in reveal phase")]
    JobNotInRevealPhase,
    #[msg("Job expired without filling up")]
    JobExpired,
    #[msg("Job has not expired yet")]
    JobNotExpired,
    #[msg("Job is not ready to finalize")]
    JobNotFinalizable,
    #[msg("Missing accounts in remaining_accounts")]
    MissingAccounts,
    #[msg("Hash does not match the commitment")]
    CommitmentMismatch,
    #[msg("This node has already revealed its results")]
    AlreadyRevealed,
    #[msg("Result has not been revealed yet")]
    ResultNotRevealed,
    #[msg("Commit deadline has passed")]
    CommitDeadlinePassed,
    #[msg("Reveal deadline has passed")]
    RevealDeadlinePassed,
    #[msg("Deadline has not been reached yet")]
    DeadlineNotReached,
    #[msg("No nodes have participated yet")]
    NoParticipantsYet,
    #[msg("Invalid job status for this operation")]
    InvalidJobStatus,
    #[msg("Account does not belong to the program")]
    InvalidAccount,
    #[msg("Node is not registered in this job")]
    NodeNotInJob,
}

// ============================================================
// UNIT TESTS — pure logic (no Solana runtime required)
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ─── runner_consensus_metric ─────────────────────────────────────────────

    #[test]
    fn consensus_metric_latency_runners() {
        assert!(matches!(runner_consensus_metric(&RunnerType::HttpFlood),     ConsensusMetric::AvgLatencyMs));
        assert!(matches!(runner_consensus_metric(&RunnerType::TlsExhaustion), ConsensusMetric::AvgLatencyMs));
        assert!(matches!(runner_consensus_metric(&RunnerType::DnsFlood),      ConsensusMetric::AvgLatencyMs));
    }

    #[test]
    fn consensus_metric_error_rate_runners() {
        assert!(matches!(runner_consensus_metric(&RunnerType::Slowloris),           ConsensusMetric::ErrorRateBps));
        assert!(matches!(runner_consensus_metric(&RunnerType::Http2RapidReset),     ConsensusMetric::ErrorRateBps));
        assert!(matches!(runner_consensus_metric(&RunnerType::Http2Continuation),   ConsensusMetric::ErrorRateBps));
        assert!(matches!(runner_consensus_metric(&RunnerType::WebsocketExhaustion), ConsensusMetric::ErrorRateBps));
        assert!(matches!(runner_consensus_metric(&RunnerType::SynFlood),            ConsensusMetric::ErrorRateBps));
        assert!(matches!(runner_consensus_metric(&RunnerType::UdpFlood),            ConsensusMetric::ErrorRateBps));
        assert!(matches!(runner_consensus_metric(&RunnerType::Rudy),                ConsensusMetric::ErrorRateBps));
    }

    // ─── consensus_tolerance ─────────────────────────────────────────────────

    #[test]
    fn tolerance_latency_is_20_percent_relative() {
        // avgLatencyMs: tolerance = avg / 5 (20%)
        assert_eq!(consensus_tolerance(100, &ConsensusMetric::AvgLatencyMs),   20);
        assert_eq!(consensus_tolerance(500, &ConsensusMetric::AvgLatencyMs),  100);
        assert_eq!(consensus_tolerance(  0, &ConsensusMetric::AvgLatencyMs),    0);
        assert_eq!(consensus_tolerance( 99, &ConsensusMetric::AvgLatencyMs),   19); // integer division
    }

    #[test]
    fn tolerance_error_rate_has_floor_of_500() {
        // errorRateBps: tolerance = max(avg/5, 500)
        // Low values → the 500 floor dominates
        assert_eq!(consensus_tolerance(   0, &ConsensusMetric::ErrorRateBps), 500);
        assert_eq!(consensus_tolerance( 100, &ConsensusMetric::ErrorRateBps), 500); // 100/5=20 < 500
        assert_eq!(consensus_tolerance(2499, &ConsensusMetric::ErrorRateBps), 500); // 2499/5=499 < 500
        // High values → the 20% relative dominates
        assert_eq!(consensus_tolerance(2500, &ConsensusMetric::ErrorRateBps), 500); // 2500/5=500 == 500
        assert_eq!(consensus_tolerance(3000, &ConsensusMetric::ErrorRateBps), 600); // 3000/5=600 > 500
        assert_eq!(consensus_tolerance(10_000, &ConsensusMetric::ErrorRateBps), 2000);
    }

    // ─── median_u32 ──────────────────────────────────────────────────────────

    #[test]
    fn median_single_value() {
        assert_eq!(median_u32(&[42]), 42);
    }

    #[test]
    fn median_empty_is_zero() {
        assert_eq!(median_u32(&[]), 0);
    }

    #[test]
    fn median_odd_count_is_middle() {
        // unsorted input → sorts internally → [10, 20, 100] → 20
        assert_eq!(median_u32(&[100, 10, 20]), 20);
    }

    #[test]
    fn median_even_count_averages_two_central() {
        // [10, 20] → 15 ; [10, 20, 30, 40] → (20+30)/2 = 25
        assert_eq!(median_u32(&[20, 10]), 15);
        assert_eq!(median_u32(&[40, 10, 30, 20]), 25);
    }

    #[test]
    fn median_is_robust_to_outlier() {
        // Four nodes agree on ~100, one reports 5000.
        // Mean would be (100*4 + 5000)/5 = 1080, dragging the center far off and
        // potentially flipping honest nodes to dishonest. Median stays at 100.
        assert_eq!(median_u32(&[100, 100, 100, 100, 5000]), 100);
    }

    // ─── extract_consensus_value ─────────────────────────────────────────────

    fn make_result(avg_latency_ms: u32, error_rate_bps: u32) -> ResultAccount {
        ResultAccount {
            job:                Pubkey::default(),
            node:               Pubkey::default(),
            commitment:         [0u8; 32],
            committed_at:       0,
            revealed:           true,
            avg_latency_ms,
            error_rate_bps,
            requests_completed: 0,
            baseline_latency_ms: 0,
            revealed_at:        0,
        }
    }

    #[test]
    fn extract_latency_field() {
        let r = make_result(123, 456);
        assert_eq!(extract_consensus_value(&r, &ConsensusMetric::AvgLatencyMs), 123);
    }

    #[test]
    fn extract_error_rate_field() {
        let r = make_result(123, 456);
        assert_eq!(extract_consensus_value(&r, &ConsensusMetric::ErrorRateBps), 456);
    }

    // ─── keccak256 ───────────────────────────────────────────────────────────

    #[test]
    fn keccak256_produces_32_bytes() {
        let h = keccak256(b"test");
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn keccak256_is_deterministic() {
        assert_eq!(keccak256(b"hello"), keccak256(b"hello"));
    }

    #[test]
    fn keccak256_is_sensitive_to_input() {
        assert_ne!(keccak256(b"hello"), keccak256(b"Hello"));
    }

    // ─── Account size validation ──────────────────────────────────────────────

    #[test]
    fn result_account_len_covers_struct() {
        // ResultAccount::LEN must be >= the actual serialized size.
        // Validate that the enumerated fields sum to at least the expected size.
        let expected_min = 8  // discriminator
            + 32 // job
            + 32 // node
            + 32 // commitment
            + 8  // committed_at
            + 1  // revealed
            + 4  // avg_latency_ms
            + 4  // error_rate_bps
            + 8  // requests_completed
            + 4  // baseline_latency_ms
            + 8; // revealed_at
        assert!(ResultAccount::LEN >= expected_min,
            "ResultAccount::LEN={} must be >= {}", ResultAccount::LEN, expected_min);
    }

    #[test]
    fn job_account_len_covers_target_and_config() {
        // JobAccount::LEN must be >= 8 (disc) + 32 (owner) + max(target) + max(config)
        let expected_min = 8 + 32 + (4 + 200) + (4 + 500);
        assert!(JobAccount::LEN >= expected_min,
            "JobAccount::LEN={} must be >= {}", JobAccount::LEN, expected_min);
    }
}
