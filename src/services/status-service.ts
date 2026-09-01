import * as fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition } from '../agents';
import {
	collectDelegationLedgerHealth,
	type DelegationHealthMaintenanceSection,
	type DelegationLedgerHealth,
	readDelegationHealthArtifact,
} from '../background/delegation-health';
import {
	DELEGATION_COMPACTION_HIGH_WATER_BYTES,
	DELEGATION_COMPACTION_LOW_WATER_BYTES,
	MAX_RECOVERY_LEDGER_BYTES,
	maintainBackgroundDelegations,
	scanBackgroundCoderReservationsForAdmission,
	scanDelegationsForRecovery,
} from '../background/pending-delegations';
import { loadPluginConfig } from '../config/loader';
import { MemoryConfigSchema } from '../config/schema';
import { countConsensusReportFiles } from '../consensus/store';
import {
	type FullAutoRunState,
	loadFullAutoRunState,
} from '../full-auto/state';
import { readLearningHealth } from '../health/learning-health';
import {
	extractCurrentPhase,
	extractCurrentPhaseFromPlan,
} from '../hooks/extractors';
import {
	type RecentEscalation,
	readRecentEscalations,
} from '../hooks/knowledge-escalator';
import { readLinkPointer, resolveLinkDir } from '../hooks/knowledge-link';
import { resolveUnactionablePath } from '../hooks/knowledge-validator';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { readMemoryLinkPointer } from '../memory/memory-link';
import {
	buildMemoryCohortFingerprintInput,
	classifyStoredFingerprintAlgorithmVersion,
	computeMemoryCohortFingerprint,
} from '../memory/redaction';
import { loadPlan } from '../plan/manager';
import {
	getActiveFullAutoSessionID,
	getDisplayBudget,
	getDisplayFinalPromptPressure,
	hasActiveFullAuto,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	swarmState,
} from '../state';
import { getLastHeartbeat } from '../telemetry';
import { listRecoveryRecords } from '../turbo/lean/recovery';
import { loadLeanTurboRunState } from '../turbo/lean/state';
import { getCompactionMetrics } from './compaction-service';
import {
	type CostSummary,
	summarizeTelemetryCosts,
} from './cost-accounting.js';

/**
 * Dependency-injection seam for status-service.
 * Allows tests to intercept Lean Turbo state queries without mock.module leakage.
 */
export const _internals = {
	loadLeanTurboRunState,
	hasActiveLeanTurbo,
	hasActiveFullAuto,
	getActiveFullAutoSessionID,
	loadFullAutoRunState,
	summarizeTelemetryCosts,
};

const MAX_TRACKED_TELEMETRY_COST_SUMMARIES = 32;
const telemetryCostSummaryCache = new Map<
	string,
	{ stamp: string; summary: CostSummary }
>();

function getTelemetryCostSummary(directory: string): CostSummary {
	const stamp = readTelemetryCostStamp(directory);
	const cached = telemetryCostSummaryCache.get(directory);
	if (cached && cached.stamp === stamp) return cached.summary;
	const summary = _internals.summarizeTelemetryCosts(directory);
	telemetryCostSummaryCache.set(directory, { stamp, summary });
	while (
		telemetryCostSummaryCache.size > MAX_TRACKED_TELEMETRY_COST_SUMMARIES
	) {
		const oldest = telemetryCostSummaryCache.keys().next().value;
		if (oldest === undefined) break;
		telemetryCostSummaryCache.delete(oldest);
	}
	return summary;
}

function readTelemetryCostStamp(directory: string): string {
	const swarmDir = path.join(directory, '.swarm');
	const files = [
		path.join(swarmDir, 'telemetry.jsonl.1'),
		path.join(swarmDir, 'telemetry.jsonl'),
	];
	return files
		.map((file) => {
			try {
				const stat = fsSync.statSync(file);
				return stat.isFile()
					? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
					: 'missing';
			} catch {
				return 'missing';
			}
		})
		.join('|');
}

/**
 * Structured status data returned by the status service.
 * This can be used by GUI, background flows, or command adapters.
 */
export interface StatusData {
	hasPlan: boolean;
	currentPhase: string;
	completedTasks: number;
	totalTasks: number;
	agentCount: number;
	isLegacy: boolean;
	turboMode: boolean;
	/** Lean Turbo strategy: 'lean', 'standard', or 'off' */
	turboStrategy?: 'standard' | 'lean' | 'off';
	/** Lean Turbo phase number, if Lean Turbo is active */
	leanTurboPhase?: number;
	/** Number of lanes currently in 'running' status */
	leanActiveLaneCount?: number;
	/** Max parallel coders configured for Lean Turbo */
	leanMaxParallelCoders?: number;
	/** Number of lanes completed */
	leanCompletedLanes?: number;
	/** Number of tasks marked as degraded */
	leanDegradedTasks?: number;
	/** Human-readable degradation summary */
	leanDegradationSummary?: string;
	/**
	 * #1657: merge-back conflict recovery worktrees preserved for manual
	 * recovery (durable records under `.swarm/recovery/`). Surfaced so the
	 * architect/operator can see pending recovery work in `/swarm status`
	 * rather than having to re-read a prior tool result. `undefined`/empty when
	 * no lanes are preserved.
	 */
	leanPreservedRecoveryWorktrees?: Array<{
		laneId: string;
		status: string;
		worktreePath: string;
		reason: string;
		replayHint: string;
	}>;
	/** Whether Full-Auto mode is currently active */
	fullAutoActive?: boolean;
	/**
	 * Issue #1781 E2: latest oversight-escalation detail, surfaced when
	 * Full-Auto is active so an operator can see why oversight escalated and
	 * how close the run is to a deadlock/human handoff. `undefined` when
	 * Full-Auto is inactive or no escalation has occurred.
	 */
	fullAutoEscalation?: {
		reason: string;
		interactionCount: number;
		deadlockCount: number;
		phase?: number;
	};
	/** Reason for pause if Lean Turbo is paused */
	leanPauseReason?: string;
	/** Last known context budget percentage (0-100), or null if not yet measured */
	contextBudgetPct: number | null;
	/**
	 * The DENOMINATOR `contextBudgetPct` was measured against, in tokens, or
	 * null when no budget report has run. Carried alongside the percentage
	 * because the denominator is now derived per-model (`model.limit.context`)
	 * rather than being a constant this renderer could assume. The renderer
	 * previously back-computed the estimate from
	 * `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens`, which was **40000** (not
	 * 128000 — that was the schema default for `model_limits.default`, a
	 * different constant on a different path). So the status line printed a
	 * figure that did not match the percentage beside it for any user whose
	 * warnings fired against anything other than 40000 — i.e. every user with a
	 * `model_limits` override, and now everyone, since the live window is used.
	 */
	contextBudgetTokens?: number | null;
	/** Number of context compaction events triggered this session */
	compactionCount: number;
	/** ISO timestamp of last compaction snapshot, or null if none */
	lastSnapshotAt: string | null;
	/** Issue #853 Layer C: true if spec drift was detected for this plan */
	specStale?: boolean;
	/** Reason text from .swarm/spec-staleness.json (or RuntimePlan._specStaleReason) */
	specStaleReason?: string;
	/** Stored spec hash from when the plan was last saved */
	specStaleStoredHash?: string;
	/** Current spec.md hash on disk (null when spec.md is missing) */
	specStaleCurrentHash?: string | null;
	/** Directives auto-escalated in the last 7 days (Change 3). */
	recentEscalations?: RecentEscalation[];
	/** #1234 Part 3: pending skill/motif proposals in .swarm/skills/proposals/ */
	pendingProposals?: number;
	/** #1234 Part 3: entries in the unactionable-knowledge queue */
	unactionableQueueDepth?: number;
	/** #1234 Part 3: pending insight candidates awaiting phase boundary consumption */
	insightCandidatesPending?: number;
	/**
	 * #1821 AC22: consensus report FILES stored under
	 * `.swarm/evolution/consensus/`.
	 *
	 * The reader half of the consensus store. Without it the miner's reports were
	 * a write-only directory — nothing in the product enumerated them, so a user
	 * had no way to learn they existed. A file count, deliberately: it is one
	 * `readdir` with no JSON parse and no integrity recomputation, so it costs the
	 * same whether the store holds one report or fifty. It therefore includes any
	 * corrupt report, because what it counts is files whose name is a well-formed
	 * report id.
	 */
	consensusReports?: number;
	/**
	 * Learning/operations health (issue #2044): the bounded-window alarm
	 * snapshot from the learning-health registry (active alarms + transition
	 * count). `undefined` when the read failed (fail-open) — never blocks
	 * status rendering.
	 */
	learningHealth?: {
		activeAlarms: readonly {
			alarm: string;
			severity: string;
			scopeClass: string;
			scopeRef: string;
			ageMs: number;
			coverageFacts: number;
			transitionCount: number;
		}[];
		totalTransitions: number;
	};
	/**
	 * Cohort/link status (issue #1846). Makes the linked knowledge store and its
	 * health obvious in `/swarm status`. `undefined` when link state is absent.
	 */
	cohort?: {
		linked: boolean;
		linkId?: string;
		cohortId?: string;
		identitySource?: 'remote' | 'git-common-dir' | 'path';
		degraded?: boolean;
		sharedRoot?: string;
		generation?: number;
	};
	/** FR-010: last heartbeat activity for the session */
	lastActivity?: {
		sessionId: string;
		/** epoch ms from getLastHeartbeat */
		timestamp: number;
		/** null when no heartbeat recorded */
		agoMs: number | null;
		/** human-readable: "5s ago", "12m ago", "2h ago", "never" */
		agoLabel: string;
	};
	/**
	 * #1850: memory cohort link status. Distinct from `cohort` (knowledge link)
	 * so status can distinguish knowledge-linked from memory-linked (acceptance
	 * #2). Carries provider/config/privacy health fields.
	 */
	memoryCohort?: {
		linked: boolean;
		linkId?: string;
		cohortId?: string;
		identitySource?: 'remote' | 'git-common-dir' | 'path';
		degraded?: boolean;
		sharedRoot?: string;
		generation?: number;
		provider?: string;
		configFingerprintMatch?: boolean;
	};
	/**
	 * #2034 / #1659: background-delegation ledger health — tail bytes vs the
	 * 4 MiB recovery bound, checkpoint state, the most recent durable
	 * uncertainty, and live-set counts. Populated fold-free from the durable
	 * health artifact + statSync; `undefined` when no ledger and no artifact
	 * exist (clean repos keep their previous byte-identical output).
	 */
	delegationLedgerHealth?: DelegationLedgerHealth;
	/**
	 * Issue #2104: opt-in background-work status. Populated ONLY when
	 * `hooks.background_subagents` is enabled — a disabled (default) feature
	 * adds no section and no output. All reads are bounded (recovery scan +
	 * bounded reservation store + health artifact); over-bound or corrupt
	 * stores surface as typed uncertainty, never partially-trusted counts.
	 */
	backgroundWork?: BackgroundWorkStatus;
	/** Issue #2043: compatibility total plus provenance completeness. */
	costs?: {
		totalCostUsd: number;
		delegations: number;
		unavailableDelegations: number;
		evidenceStatus: 'complete' | 'inconclusive';
		conflictCount: number;
		joinMissCount: number;
		telemetryErrorCount: number;
	};
}

/** Issue #2104: opt-in background-work status snapshot for /swarm status. */
export interface BackgroundWorkStatus {
	/** Live-set counts by delegation status (bounded recovery scan). */
	counts: {
		pending: number;
		running: number;
		completed: number;
		consumed: number;
		stale: number;
		cancelled: number;
		error: number;
		ingestion_error: number;
	};
	/** Active coder reservations with their lease state. */
	reservations: Array<{
		reservationId: string;
		planTaskId: string | null;
		generation: number;
		state: 'reserved' | 'bound';
		leaseState: 'active' | 'expired' | 'protected-legacy';
		leaseExpiresAt?: number;
	}>;
	/** Durable maintenance state from the health artifact (null when absent). */
	maintenance: DelegationHealthMaintenanceSection | null;
	/**
	 * Provenance: 'validated-recovery' when the bounded recovery scan and
	 * reservation scan both validated; 'uncertain' when either store is
	 * corrupt/over-bound — in that case counts/reservations are NOT presented
	 * (never a partial record set as authoritative) and `uncertainty` carries
	 * the typed reason.
	 */
	source: 'validated-recovery' | 'uncertain';
	/** Typed uncertainty reason when source is 'uncertain'. */
	uncertainty?: string;
}

/**
 * Issue #2104: collect the opt-in background-work snapshot. Runs maintenance
 * point P4 (bounded, tight lock) and reads only bounded surfaces: the
 * recovery scan (checkpoint + ≤4 MiB tail, never a full ledger read), the
 * bounded reservation store, and the small health artifact. Any corrupt or
 * over-bound store yields typed uncertainty — never partially-trusted counts.
 * Never throws: a status command must not fail because a store is unreadable.
 */
async function collectBackgroundWorkStatus(
	directory: string,
): Promise<BackgroundWorkStatus> {
	// Maintenance point P4 (issue #2104), awaited: bounded by the tight 2 s
	// lock so a contended store still returns promptly, and the rendered
	// facts reflect this run. Never fatal to the status path.
	try {
		await maintainBackgroundDelegations(directory, {
			lockTimeoutMs: 2_000,
			reason: 'status',
		});
	} catch {
		// observation only; the facts ring records the failure
	}
	const counts = {
		pending: 0,
		running: 0,
		completed: 0,
		consumed: 0,
		stale: 0,
		cancelled: 0,
		error: 0,
		ingestion_error: 0,
	};
	const maintenance =
		readDelegationHealthArtifact(directory)?.maintenance ?? null;
	const empty: BackgroundWorkStatus = {
		counts,
		reservations: [],
		maintenance,
		source: 'uncertain',
	};
	let scan: ReturnType<typeof scanDelegationsForRecovery>;
	try {
		scan = scanDelegationsForRecovery(directory);
	} catch (error) {
		return {
			...empty,
			uncertainty: `delegation recovery scan failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (scan.status === 'uncertain') {
		return {
			...empty,
			uncertainty: `delegation ledger over its recovery bound or corrupt: ${scan.reason}`,
		};
	}
	const reservationScan =
		scanBackgroundCoderReservationsForAdmission(directory);
	if (reservationScan.status === 'uncertain') {
		return {
			...empty,
			uncertainty: `coder reservation store unreadable: ${reservationScan.reason}`,
		};
	}
	for (const record of scan.owners) {
		if (record.status in counts) {
			counts[record.status as keyof typeof counts] += 1;
		}
	}
	const now = Date.now();
	const reservations = reservationScan.reservations.map((reservation) => ({
		reservationId: reservation.reservationId,
		planTaskId: reservation.planTaskId,
		generation: reservation.generation ?? 1,
		state: reservation.state,
		leaseState:
			reservation.leaseExpiresAt === undefined
				? ('protected-legacy' as const)
				: reservation.leaseExpiresAt > now
					? ('active' as const)
					: ('expired' as const),
		...(reservation.leaseExpiresAt !== undefined
			? { leaseExpiresAt: reservation.leaseExpiresAt }
			: {}),
	}));
	return {
		counts,
		reservations,
		maintenance,
		source: 'validated-recovery',
	};
}

/** #2034: compact human-readable byte figure for the delegation-health block. */
function formatLedgerBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
	}
	if (bytes >= 1024) {
		return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
	}
	return `${bytes} B`;
}

/**
 * Issue #853 Layer C: read .swarm/spec-staleness.json so /swarm status can
 * surface drift information directly (independent of the in-memory plan).
 * Returns `{ stale: false }` when the file is absent or malformed.
 */
function readSpecStalenessSnapshot(directory: string): {
	stale: boolean;
	reason?: string;
	storedHash?: string;
	currentHash?: string | null;
} {
	try {
		const p = path.join(directory, '.swarm', 'spec-staleness.json');
		if (!fsSync.existsSync(p)) return { stale: false };
		const raw = fsSync.readFileSync(p, 'utf-8');
		const parsed = JSON.parse(raw);
		return {
			stale: true,
			reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined,
			storedHash:
				typeof parsed?.specHash_plan === 'string'
					? parsed.specHash_plan
					: undefined,
			currentHash:
				typeof parsed?.specHash_current === 'string' ||
				parsed?.specHash_current === null
					? parsed.specHash_current
					: undefined,
		};
	} catch {
		return { stale: false };
	}
}

/**
 * Format a millisecond duration as a human-readable ago label.
 */
function formatAgo(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Get status data from the swarm directory.
 * Returns structured data that can be used by GUI, background flows, or commands.
 */
export async function getStatusData(
	directory: string,
	agents: Record<string, AgentDefinition>,
	sessionId?: string,
	options?: {
		/**
		 * Explicit `hooks.background_subagents` value (issue #2104). When
		 * omitted, the service resolves it from the same config loader it
		 * already uses for the memory section (fail-open to disabled).
		 */
		backgroundSubagents?: boolean;
	},
): Promise<StatusData> {
	// Try structured plan first
	const plan = await loadPlan(directory);

	let status: StatusData;

	if (plan && plan.migration_status !== 'migration_failed') {
		const currentPhase = extractCurrentPhaseFromPlan(plan) || 'Unknown';

		// Count tasks across all phases
		let completedTasks = 0;
		let totalTasks = 0;
		for (const phase of plan.phases) {
			for (const task of phase.tasks) {
				totalTasks++;
				if (task.status === 'completed') completedTasks++;
			}
		}

		const agentCount = Object.keys(agents).length;
		const metrics = getCompactionMetrics();

		status = {
			hasPlan: true,
			currentPhase,
			completedTasks,
			totalTasks,
			agentCount,
			isLegacy: false,
			turboMode: hasActiveTurboMode(),
			contextBudgetPct: getDisplayBudget()?.pct ?? null,
			contextBudgetTokens: getDisplayBudget()?.tokens ?? null,
			compactionCount: metrics.compactionCount,
			lastSnapshotAt: metrics.lastSnapshotAt,
		};
	} else {
		// Legacy fallback (existing code)
		const planContent = await readSwarmFileAsync(directory, 'plan.md');
		if (!planContent) {
			const metrics = getCompactionMetrics();
			status = {
				hasPlan: false,
				currentPhase: 'Unknown',
				completedTasks: 0,
				totalTasks: 0,
				agentCount: Object.keys(agents).length,
				isLegacy: true,
				turboMode: hasActiveTurboMode(),
				contextBudgetPct: getDisplayBudget()?.pct ?? null,
				contextBudgetTokens: getDisplayBudget()?.tokens ?? null,
				compactionCount: metrics.compactionCount,
				lastSnapshotAt: metrics.lastSnapshotAt,
			};
		} else {
			const currentPhase = extractCurrentPhase(planContent) || 'Unknown';
			const completedTasks = (planContent.match(/^- \[x\]/gm) || []).length;
			const incompleteTasks = (planContent.match(/^- \[ \]/gm) || []).length;
			const totalTasks = completedTasks + incompleteTasks;
			const agentCount = Object.keys(agents).length;
			const metrics = getCompactionMetrics();

			status = {
				hasPlan: true,
				currentPhase,
				completedTasks,
				totalTasks,
				agentCount,
				isLegacy: true,
				turboMode: hasActiveTurboMode(),
				contextBudgetPct: getDisplayBudget()?.pct ?? null,
				contextBudgetTokens: getDisplayBudget()?.tokens ?? null,
				compactionCount: metrics.compactionCount,
				lastSnapshotAt: metrics.lastSnapshotAt,
			};
		}
	}

	// Issue #853 Layer C: surface spec drift in /swarm status output.
	const drift = readSpecStalenessSnapshot(directory);
	if (drift.stale) {
		status.specStale = true;
		status.specStaleReason = drift.reason;
		status.specStaleStoredHash = drift.storedHash;
		status.specStaleCurrentHash = drift.currentHash;
	} else if (plan && (plan as { _specStale?: boolean })._specStale) {
		status.specStale = true;
		status.specStaleReason = (
			plan as { _specStaleReason?: string }
		)._specStaleReason;
	}

	// Surface recently-escalated directives (Change 3).
	status.recentEscalations = await readRecentEscalations(directory);

	// #1234 Part 3: surface learning-loop queue depths in /swarm status.
	status.pendingProposals = await countProposals(directory);
	// Link-aware: when this worktree shares a knowledge store, report the shared
	// unactionable queue depth (resolveUnactionablePath redirects when linked).
	status.unactionableQueueDepth = await safeLineCount(
		resolveUnactionablePath(directory),
	);
	status.insightCandidatesPending = await safeLineCount(
		validateSwarmPath(directory, 'insight-candidates.jsonl'),
	);
	// #1821 AC22: make the consensus store reachable. Best-effort like every
	// other counter in this block — a status command must never fail because an
	// optional artifact directory is unreadable.
	try {
		status.consensusReports = await countConsensusReportFiles(directory);
	} catch {
		status.consensusReports = 0;
	}

	// #2034 / #1659: surface background-delegation ledger health. Fold-free by
	// design (artifact + statSync), best-effort like every other optional
	// artifact — a status command must never fail because the store is unreadable.
	try {
		status.delegationLedgerHealth =
			collectDelegationLedgerHealth(directory, {
				ledgerLimitBytes: MAX_RECOVERY_LEDGER_BYTES,
				lowWaterBytes: DELEGATION_COMPACTION_LOW_WATER_BYTES,
				highWaterBytes: DELEGATION_COMPACTION_HIGH_WATER_BYTES,
			}) ?? undefined;
	} catch {
		status.delegationLedgerHealth = undefined;
	}

	// #2044: learning/operations health — bounded-window alarm snapshot from the
	// learning-health registry. Fail-open: an unreadable artifact yields no
	// section rather than a failed status command.
	try {
		const snapshot = await readLearningHealth(directory);
		status.learningHealth = {
			activeAlarms: snapshot.activeAlarms.map((alarm) => ({
				alarm: alarm.alarm,
				severity: alarm.severity,
				scopeClass: alarm.scopeClass,
				scopeRef: alarm.scopeRef,
				ageMs: alarm.ageMs,
				coverageFacts: alarm.coverageFacts,
				transitionCount: alarm.transitionCount,
			})),
			totalTransitions: snapshot.totalTransitions,
		};
	} catch {
		status.learningHealth = undefined;
	}

	// Issue #2104: opt-in background-work section. Gated on
	// hooks.background_subagents — when the feature is disabled (the default)
	// this adds no section and no output. The maintenance pass is maintenance
	// point P4: bounded with a tight lock so status stays fast even when the
	// stores are contended.
	const backgroundSubagentsEnabled =
		options?.backgroundSubagents ??
		(() => {
			try {
				return (
					(loadPluginConfig(directory) as { hooks?: Record<string, unknown> })
						?.hooks?.background_subagents === true
				);
			} catch {
				return false;
			}
		})();
	if (backgroundSubagentsEnabled) {
		status.backgroundWork = await collectBackgroundWorkStatus(directory);
	}

	// Issue #1846: surface cohort/link status so `/swarm status` makes the
	// linked knowledge store and its health obvious. Best-effort: a missing or
	// corrupt pointer reports the unlinked shape.
	try {
		const pointer = readLinkPointer(directory);
		if (pointer) {
			status.cohort = {
				linked: true,
				linkId: pointer.linkId,
				cohortId: pointer.cohortId,
				identitySource: pointer.identitySource,
				degraded: pointer.degraded,
				sharedRoot: resolveLinkDir(pointer.linkId),
				generation: pointer.generation,
			};
		} else {
			status.cohort = { linked: false };
		}
	} catch {
		status.cohort = { linked: false };
	}

	// #1850: surface the memory link status SEPARATELY from the knowledge link
	// (acceptance #2). Best-effort: a missing or corrupt memory pointer reports
	// the unlinked shape. Provider/config/privacy health is populated when
	// available so operators can detect cohort divergence.
	try {
		const memoryPointer = readMemoryLinkPointer(directory);
		// #1850 (reviewer nit): populate provider + configFingerprintMatch so
		// status surfaces cohort divergence (acceptance #2). Best-effort.
		let provider: string | undefined;
		let configFingerprintMatch: boolean | undefined;
		try {
			const memoryConfig = MemoryConfigSchema.parse(
				(loadPluginConfig(directory) as { memory?: unknown }).memory ?? {},
			);
			provider = memoryConfig.provider;
			if (memoryPointer) {
				const cohortConfigPath = path.join(
					resolveLinkDir(memoryPointer.linkId),
					'memory',
					'memory-cohort-config.json',
				);
				if (fsSync.existsSync(cohortConfigPath)) {
					const stored = JSON.parse(
						fsSync.readFileSync(cohortConfigPath, 'utf-8'),
					) as { fingerprint?: unknown; algorithm_version?: unknown };
					// #2062 F-012 (R3 fix): mirror the provider version-aware pattern.
					// An ABSENT `algorithm_version` means the file predates the field,
					// i.e. algorithm version 1 — not "the current version", which would
					// make legacy files silently byte-compare across algorithms after a
					// bump. When the stored version is not comparable (a different
					// version, or present but non-numeric) leave configFingerprintMatch
					// unset (unknown) rather than reporting a false mismatch. This is a
					// read-only reporting surface, so stay silent rather than warn.
					const versionCheck = classifyStoredFingerprintAlgorithmVersion(
						stored.algorithm_version,
					);
					if (
						versionCheck.status === 'comparable' &&
						typeof stored.fingerprint === 'string'
					) {
						// #1850 (final-critic dedup): shared fingerprint helper.
						const expected = computeMemoryCohortFingerprint(
							buildMemoryCohortFingerprintInput(memoryConfig),
						);
						configFingerprintMatch = stored.fingerprint === expected;
					}
				}
			}
		} catch {
			/* best-effort config read */
		}
		if (memoryPointer) {
			status.memoryCohort = {
				linked: true,
				linkId: memoryPointer.linkId,
				cohortId: memoryPointer.cohortId,
				identitySource: memoryPointer.identitySource,
				degraded: memoryPointer.degraded,
				sharedRoot: resolveLinkDir(memoryPointer.linkId),
				generation: memoryPointer.generation,
				provider,
				configFingerprintMatch,
			};
		} else {
			status.memoryCohort = { linked: false, provider };
		}
	} catch {
		status.memoryCohort = { linked: false };
	}

	// Check Full-Auto status (issue #1781 E2: this was previously nested
	// inside `enrichWithLeanTurbo`, past its `if (!leanActive) return status`
	// early-exit, so it only ran when Lean Turbo was active. Hoisted here so
	// `fullAutoActive` and the escalation detail surface regardless of turbo.
	status.fullAutoActive = _internals.hasActiveFullAuto();
	if (status.fullAutoActive) {
		const sid = _internals.getActiveFullAutoSessionID();
		if (sid) {
			const runState: FullAutoRunState | undefined =
				_internals.loadFullAutoRunState(directory, sid);
			if (runState?.lastEscalation) {
				status.fullAutoEscalation = {
					reason: runState.lastEscalation.reason,
					interactionCount: runState.lastEscalation.interactionCount,
					deadlockCount: runState.lastEscalation.deadlockCount,
					phase: runState.lastEscalation.phase,
				};
			}
		}
	}

	// FR-010: populate lastActivity when sessionId is provided.
	if (sessionId) {
		const timestamp = getLastHeartbeat(sessionId);
		if (timestamp !== undefined) {
			const agoMs = Date.now() - timestamp;
			status.lastActivity = {
				sessionId,
				timestamp,
				agoMs,
				agoLabel: formatAgo(agoMs),
			};
		} else {
			status.lastActivity = {
				sessionId,
				timestamp: 0,
				agoMs: null,
				agoLabel: 'never',
			};
		}
	}

	// Enrich with Lean Turbo data if active.
	status = enrichWithLeanTurbo(status, directory);
	try {
		const costs = getTelemetryCostSummary(directory);
		status.costs = {
			totalCostUsd: costs.total_cost_usd,
			delegations: costs.delegations,
			unavailableDelegations: costs.unavailable_delegations,
			evidenceStatus: costs.evidence_status,
			conflictCount: costs.conflict_count,
			joinMissCount: costs.join_miss_count,
			telemetryErrorCount: costs.telemetry_error_count,
		};
	} catch {
		// Status remains fail-open when optional telemetry is unreadable.
	}
	return status;
}

/**
 * Enrich status data with Lean Turbo information if Lean Turbo is active.
 */
function enrichWithLeanTurbo(
	status: StatusData,
	directory: string,
): StatusData {
	const turboMode = hasActiveTurboMode();
	const leanActive = _internals.hasActiveLeanTurbo();

	// Determine turbo strategy
	let turboStrategy: 'standard' | 'lean' | 'off' = 'off';
	if (leanActive) {
		turboStrategy = 'lean';
	} else if (turboMode) {
		turboStrategy = 'standard';
	}

	status.turboStrategy = turboStrategy;

	// #1657: surface durable merge-back recovery records (preserved worktrees)
	// from `.swarm/recovery/`. This runs BEFORE the `!leanActive` early return
	// because recovery records persist across sessions and are relevant whenever
	// any lane's merge-back has failed — even if Lean Turbo is not currently
	// active (e.g. the session ended, or the user is inspecting past recovery).
	try {
		const recoveryRecords = listRecoveryRecords(directory);
		if (recoveryRecords.length > 0) {
			status.leanPreservedRecoveryWorktrees = recoveryRecords.map((r) => ({
				laneId: r.laneId,
				status: r.status,
				worktreePath: r.worktreePath,
				reason: r.reason,
				replayHint: r.replayHint,
			}));
		}
	} catch {
		// Non-fatal: status is best-effort. Missing the recovery section does
		// not invalidate the rest of the status output.
	}

	if (!leanActive) {
		return status;
	}

	// Find the session ID with Lean Turbo active
	let leanSessionID: string | null = null;
	for (const [sessionId, session] of swarmState.agentSessions) {
		if (session.turboStrategy === 'lean' && session.leanTurboActive === true) {
			leanSessionID = sessionId;
			break;
		}
	}

	// Load Lean Turbo run state if we found an active session
	if (leanSessionID) {
		const runState = _internals.loadLeanTurboRunState(directory, leanSessionID);

		if (runState) {
			status.leanTurboPhase = runState.phase;
			status.leanMaxParallelCoders = runState.maxParallelCoders;
			status.leanPauseReason = runState.pauseReason;

			// Count active and completed lanes
			if (!Array.isArray(runState.lanes)) {
				runState.lanes = [];
			}
			let activeLanes = 0;
			let completedLanes = 0;
			for (const lane of runState.lanes) {
				if (lane.status === 'running') activeLanes++;
				if (lane.status === 'completed') completedLanes++;
			}
			status.leanActiveLaneCount = activeLanes;
			status.leanCompletedLanes = completedLanes;

			// Track degraded tasks
			if (!Array.isArray(runState.degradedTasks)) {
				runState.degradedTasks = [];
				status.leanDegradedTasks = 0;
			}
			if (runState.degradedTasks.length > 0) {
				status.leanDegradedTasks = runState.degradedTasks.length;
				// Build degradation summary
				const summaryParts: string[] = [];
				for (const dt of runState.degradedTasks) {
					summaryParts.push(`${dt.taskId} (${dt.reason})`);
				}
				status.leanDegradationSummary = summaryParts.join('; ');
			}
		}
	}

	return status;
}

/**
 * Format status data as markdown for command output.
 * This is the thin adapter that delegates to the service.
 */
export function formatStatusMarkdown(status: StatusData): string {
	const lines = [
		'## Swarm Status',
		'',
		`**Current Phase**: ${status.currentPhase}`,
		`**Tasks**: ${status.completedTasks}/${status.totalTasks} complete`,
		`**Agents**: ${status.agentCount} registered`,
	];
	if (status.costs && status.costs.delegations > 0) {
		const evidence =
			status.costs.evidenceStatus === 'complete'
				? 'complete evidence'
				: `inconclusive evidence (${status.costs.unavailableDelegations} unavailable, ${status.costs.conflictCount} conflicts, ${status.costs.joinMissCount} join misses, ${status.costs.telemetryErrorCount} telemetry errors)`;
		lines.push(
			'',
			`**Cost**: $${status.costs.totalCostUsd.toFixed(6)} across ${status.costs.delegations} delegations — ${evidence}`,
		);
	}

	// FR-010/FR-011: render last activity
	if (status.lastActivity) {
		const label = status.lastActivity.agoLabel;
		// 'never' means no heartbeat was ever recorded — cannot be stalled
		const annotation =
			status.lastActivity.agoLabel !== 'never' &&
			status.lastActivity.agoMs !== null &&
			status.lastActivity.agoMs > 120 * 1000
				? ' \u26a0\ufe0f possibly stalled'
				: '';
		lines.push('');
		lines.push(`**Last activity:** ${label}${annotation}`);
	}

	// Issue #853 Layer C: spec drift surfacing in /swarm status output.
	if (status.specStale) {
		const reason = status.specStaleReason ?? 'spec.md changed since plan saved';
		const stored = status.specStaleStoredHash ?? 'unknown';
		const current = status.specStaleCurrentHash ?? '(spec.md missing)';
		lines.push(
			'',
			`**Spec drift detected**: ${reason} (stored: ${stored}, current: ${current})`,
			'Run `/swarm clarify` to enter spec repair mode. Clarify alone does not clear drift: rewrite the spec so recovery can reconcile it, or run `/swarm acknowledge-spec-drift` to dismiss.',
		);
	}

	// Turbo status display - strategy-specific
	if (status.turboStrategy && status.turboStrategy !== 'off') {
		lines.push('');
		if (status.turboStrategy === 'lean') {
			const parts: string[] = ['lean'];
			if (status.leanTurboPhase !== undefined) {
				parts.push(`Phase ${status.leanTurboPhase}`);
			}
			if (status.leanActiveLaneCount !== undefined) {
				const totalLanes =
					(status.leanActiveLaneCount ?? 0) + (status.leanCompletedLanes ?? 0);
				parts.push(`${status.leanActiveLaneCount}/${totalLanes} lanes active`);
			}
			if (
				status.leanDegradedTasks !== undefined &&
				status.leanDegradedTasks > 0
			) {
				parts.push(`${status.leanDegradedTasks} degraded`);
			}
			lines.push(`**Turbo**: ${parts.join(', ')}`);

			if (status.leanDegradationSummary) {
				lines.push(`  - ${status.leanDegradationSummary}`);
			}

			// Show pause reason if paused
			if (status.leanPauseReason) {
				lines.push(`**Lean paused**: ${status.leanPauseReason}`);
			}
		} else {
			lines.push(`**Turbo**: standard`);
		}
	} else if (status.turboStrategy === undefined && status.turboMode === true) {
		// Backward-compatibility: callers that only set turboMode (no turboStrategy) get the old format
		lines.push('');
		lines.push('**TURBO MODE**: active');
	}

	// #1657: preserved merge-back recovery worktrees. Rendered as its own block
	// because recovery records persist across sessions and are relevant even
	// when Lean Turbo is not currently active.
	if (
		status.leanPreservedRecoveryWorktrees &&
		status.leanPreservedRecoveryWorktrees.length > 0
	) {
		lines.push('');
		lines.push(
			`**Preserved recovery worktrees**: ${status.leanPreservedRecoveryWorktrees.length} lane(s) preserved for manual merge-back recovery`,
		);
		for (const w of status.leanPreservedRecoveryWorktrees) {
			lines.push(
				`  - ${w.laneId} (${w.status}): ${w.reason} — \`${w.replayHint}\``,
			);
		}
	}

	// Issue #1781 E2: Full-Auto status is rendered as its own block, OUTSIDE
	// the turbo block, so escalation detail surfaces even when Full-Auto runs
	// WITHOUT turbo (the common escalation scenario). Previously this was
	// nested inside the `turboStrategy !== 'off'` branch and was invisible
	// whenever Full-Auto ran alone.
	if (status.fullAutoActive) {
		lines.push('');
		lines.push('**Full-Auto**: active');
		if (status.fullAutoEscalation) {
			const e = status.fullAutoEscalation;
			const phaseStr = e.phase !== undefined ? ` | Phase ${e.phase}` : '';
			lines.push(
				`  - Escalation: ${e.reason} (interactions=${e.interactionCount}, deadlocks=${e.deadlockCount}${phaseStr})`,
			);
		}
	}

	if (status.contextBudgetPct !== null && status.contextBudgetPct > 0) {
		const pct = status.contextBudgetPct.toFixed(1);
		// Render the token estimate ONLY against the denominator the percentage
		// was actually measured with (the per-session budget record, written by
		// system-enhancer on the same statement as the pct). This used to
		// back-compute from the hardcoded default, so a user on a 200k/1M model —
		// or any user with a `model_limits` override — was shown a token figure
		// and a window size that contradicted the percentage printed beside them.
		// When the denominator is unknown (a synthetic snapshot; unreachable in
		// production, where the pct and the denominator are written together) the
		// percentage is shown alone rather than fabricated against a constant.
		const budgetTokens = status.contextBudgetTokens;
		if (
			budgetTokens !== undefined &&
			budgetTokens !== null &&
			budgetTokens > 0
		) {
			const est = Math.round((status.contextBudgetPct / 100) * budgetTokens);
			lines.push(
				'',
				`**Swarm injection footprint**: ${pct}% of model window (intermediate measurement; est. ${est.toLocaleString()} / ${budgetTokens.toLocaleString()} tokens)`,
			);
		} else {
			lines.push(
				'',
				`**Swarm injection footprint**: ${pct}% of model window (intermediate measurement)`,
			);
		}
		// #2107 §3: the truthful FINAL pressure line. Measured after every
		// injector ran, against the same model window physical pruning uses.
		const finalPressure = getDisplayFinalPromptPressure();
		if (finalPressure && finalPressure.pct > 0) {
			lines.push(
				`**Prompt pressure (final)**: ${finalPressure.pct.toFixed(1)}% estimated (est. ${finalPressure.usedTokens.toLocaleString()} / ${finalPressure.limitTokens.toLocaleString()} tokens; ${finalPressure.estimatorSource}${finalPressure.providerReported ? '; provider-reported' : ''})`,
			);
		}
		if (status.compactionCount > 0) {
			lines.push(`**Compaction events**: ${status.compactionCount} triggered`);
		}
		if (status.lastSnapshotAt) {
			lines.push(`**Last snapshot**: ${status.lastSnapshotAt}`);
		}
	}

	// Recently-escalated directives (Change 3).
	if (status.recentEscalations && status.recentEscalations.length > 0) {
		lines.push('', '**Recently Escalated (last 7 days)**:');
		for (const e of status.recentEscalations) {
			lines.push(`  - ${e.entry_id} (${e.from}→${e.to}) reason=${e.reason}`);
		}
	}

	// #1234 Part 3: learning-loop queue depths.
	const proposals = status.pendingProposals ?? 0;
	const unactionable = status.unactionableQueueDepth ?? 0;
	const insights = status.insightCandidatesPending ?? 0;
	const consensusReports = status.consensusReports ?? 0;
	if (
		proposals > 0 ||
		unactionable > 0 ||
		insights > 0 ||
		consensusReports > 0
	) {
		lines.push('', '**Learning Queues**:');
		if (proposals > 0)
			lines.push(
				`  - Pending proposals: ${proposals} (review with \`/swarm skill list\`)`,
			);
		if (unactionable > 0)
			lines.push(
				`  - Unactionable queue: ${unactionable} (inspect with \`/swarm knowledge unactionable\`)`,
			);
		if (insights > 0)
			lines.push(`  - Insight candidates: ${insights} (consumed at phase end)`);
		// #1821 AC22. The pointer is the directory, not a command: there is no
		// list command for consensus reports, and naming one that does not exist
		// would be worse than naming the path a reader can actually open.
		if (consensusReports > 0)
			lines.push(
				`  - Consensus reports: ${consensusReports} (read under \`.swarm/evolution/consensus/\`; each holds proposals-only recommendations)`,
			);
	}

	// #2044: learning/operations health — bounded-window alarm families. Only
	// rendered when the snapshot is available; redaction discipline matches the
	// telemetry payload (16-hex refs, counts, enums — never raw session ids).
	if (status.learningHealth) {
		lines.push('', '**Learning Health**:');
		const active = status.learningHealth.activeAlarms;
		if (active.length === 0) {
			lines.push(
				`  - ✅ no active learning-health alarms (${status.learningHealth.totalTransitions} transitions recorded)`,
			);
		} else {
			for (const alarm of active) {
				const ageMinutes = Math.floor(alarm.ageMs / 60_000);
				lines.push(
					`  - ⚠ ${alarm.severity}: ${alarm.alarm} [${alarm.scopeClass} ${alarm.scopeRef}] age ${ageMinutes}m, coverage ${alarm.coverageFacts} facts (${alarm.transitionCount} transitions)`,
				);
			}
			lines.push(
				`  - run \`/swarm diagnose\` for the learning-health check detail`,
			);
		}
	}

	// Issue #1846: cohort/link status — make the shared knowledge store visible.
	if (status.cohort?.linked) {
		lines.push('', '**Knowledge Cohort**:');
		lines.push(`  - 🔗 Linked to shared store "${status.cohort.linkId}"`);
		if (status.cohort.cohortId)
			lines.push(`    cohort: ${status.cohort.cohortId}`);
		if (status.cohort.identitySource)
			lines.push(`    identity: ${status.cohort.identitySource}`);
		if (status.cohort.degraded)
			lines.push(
				'    ⚠ degraded (machine-local, not portable across machines)',
			);
		if (status.cohort.sharedRoot)
			lines.push(`    shared at: ${status.cohort.sharedRoot}`);
		if (status.cohort.generation !== undefined)
			lines.push(`    generation: ${status.cohort.generation}`);
	} else {
		lines.push(
			'',
			'**Knowledge Cohort**: local (not linked — run `/swarm link` to share across worktrees)',
		);
	}

	// #1850: memory cohort status — rendered separately so users can tell
	// knowledge-link and memory-link apart (acceptance #2). No record text is
	// emitted here (diagnostics-no-leakage discipline, acceptance #13).
	if (status.memoryCohort?.linked) {
		lines.push('', '**Memory Cohort**:');
		lines.push(
			`  - 🔗 Memory shared across linked worktrees "${status.memoryCohort.linkId}"`,
		);
		if (status.memoryCohort.cohortId)
			lines.push(`    cohort: ${status.memoryCohort.cohortId}`);
		if (status.memoryCohort.identitySource)
			lines.push(`    identity: ${status.memoryCohort.identitySource}`);
		if (status.memoryCohort.degraded)
			lines.push(
				'    ⚠ degraded (machine-local, not portable across machines)',
			);
		if (status.memoryCohort.sharedRoot)
			lines.push(`    shared at: ${status.memoryCohort.sharedRoot}/memory`);
		if (status.memoryCohort.generation !== undefined)
			lines.push(`    generation: ${status.memoryCohort.generation}`);
		// #1850 (final-critic #2 fix): render provider + config fingerprint
		// health so operators can detect cohort divergence (acceptance #2).
		if (status.memoryCohort.provider)
			lines.push(`    provider: ${status.memoryCohort.provider}`);
		if (status.memoryCohort.configFingerprintMatch === false) {
			lines.push(
				'    ⚠ config fingerprint mismatch — provider/embedding/redaction config differs across cohort members',
			);
		} else if (status.memoryCohort.configFingerprintMatch === true) {
			lines.push('    config: ✅ fingerprint matches cohort');
		}
	} else {
		lines.push(
			'',
			'**Memory Cohort**: local (not linked — run `/swarm memory link` to share memory across worktrees; requires `memory.link.enabled: true`)',
		);
	}

	// #2034 / #1659: background-delegation ledger health. Rendered whenever the
	// section exists (a ledger or health artifact is present); a clean repo
	// without background delegations never enters this branch.
	const delegationHealth = status.delegationLedgerHealth;
	if (delegationHealth) {
		lines.push('', '**Background Delegations**:');
		lines.push(
			`  - Ledger tail: ${formatLedgerBytes(delegationHealth.ledger.bytes)} / ${formatLedgerBytes(
				delegationHealth.ledger.limitBytes,
			)} recovery bound (${delegationHealth.ledger.pressurePct}% — ${delegationHealth.ledger.band})`,
		);
		if (delegationHealth.checkpoint) {
			const checkpoint = delegationHealth.checkpoint;
			lines.push(
				`  - Checkpoint #${checkpoint.sequence}: ${checkpoint.liveRecords} live records, ${checkpoint.closedSummaries} archived summaries (${formatLedgerBytes(
					checkpoint.bytes,
				)}, ${new Date(checkpoint.createdAt).toISOString()})`,
			);
		} else {
			lines.push('  - Checkpoint: none (full-history recovery)');
		}
		if (delegationHealth.recovery) {
			const recovery = delegationHealth.recovery;
			lines.push(
				`  - Recovery: ${recovery.source} (${recovery.ok ? 'ok' : `FAILED: ${recovery.reason ?? 'uncertain'}`})`,
			);
		}
		if (delegationHealth.lastUncertainty) {
			const uncertainty = delegationHealth.lastUncertainty;
			lines.push(
				`  - ⚠ Last uncertainty (${new Date(uncertainty.at).toISOString()}, ${uncertainty.source}): ${uncertainty.reason}`,
			);
			if (uncertainty.repairHint) {
				lines.push(`    repair: ${uncertainty.repairHint}`);
			}
		}
		const counts = delegationHealth.counts;
		if (
			counts.activeOwners > 0 ||
			counts.pendingAdvisories > 0 ||
			counts.lateTerminals > 0 ||
			counts.orphanWorktreeOwners > 0
		) {
			lines.push(
				`  - Live set: ${counts.activeOwners} active owners, ${counts.pendingAdvisories} pending advisories, ${counts.lateTerminals} late terminals, ${counts.orphanWorktreeOwners} unsettled worktree owners`,
			);
		}
	}

	// Issue #2104: opt-in background-work section. Present ONLY when
	// hooks.background_subagents is enabled — the collector is config-gated,
	// so a disabled (default) feature renders nothing here.
	const backgroundWork = status.backgroundWork;
	if (backgroundWork) {
		lines.push(...renderBackgroundWorkLines(backgroundWork));
	}

	return lines.join('\n');
}

/** Issue #2104: render the opt-in background-work section. */
function renderBackgroundWorkLines(
	backgroundWork: BackgroundWorkStatus,
): string[] {
	const lines: string[] = ['', '**Background Work** (opt-in):'];
	if (backgroundWork.source === 'uncertain') {
		lines.push(
			`  - ⚠ State uncertain: ${backgroundWork.uncertainty ?? 'unknown reason'} — counts and reservations are not shown rather than partially trusted`,
		);
	} else {
		const counts = backgroundWork.counts;
		lines.push(
			`  - Delegations: ${counts.pending} pending, ${counts.running} running, ${counts.completed} completed (unconsumed), ${counts.consumed} consumed, ${counts.stale} stale, ${counts.cancelled} cancelled, ${counts.error} error, ${counts.ingestion_error} ingestion_error`,
		);
		if (backgroundWork.reservations.length > 0) {
			lines.push(
				`  - Reservations (${backgroundWork.reservations.length} active):`,
			);
			for (const reservation of backgroundWork.reservations) {
				const lease =
					reservation.leaseState === 'active' && reservation.leaseExpiresAt
						? `active until ${new Date(reservation.leaseExpiresAt).toISOString()}`
						: reservation.leaseState;
				lines.push(
					`    - ${reservation.reservationId.slice(0, 12)}… ${reservation.state} gen ${reservation.generation} task ${reservation.planTaskId ?? '(call-scoped)'} — lease ${lease}`,
				);
			}
		} else {
			lines.push('  - Reservations: none');
		}
		lines.push('  - Source: validated recovery (bounded scan)');
	}
	const maintenance = backgroundWork.maintenance;
	if (maintenance) {
		if (maintenance.lastOkAt !== null) {
			const summary = maintenance.lastSummary;
			lines.push(
				`  - Maintenance: last ok ${new Date(maintenance.lastOkAt).toISOString()} (swept ${summary.sweptStale}, released ${summary.released}, renewed ${summary.renewed}, retained ${summary.retained})`,
			);
		} else {
			lines.push('  - Maintenance: no successful run recorded');
		}
		if (maintenance.lastFailure) {
			lines.push(
				`  - ⚠ Last maintenance failure (${new Date(maintenance.lastFailure.at).toISOString()}): ${maintenance.lastFailure.reason}`,
			);
		}
		if (maintenance.lastContentionAt !== null) {
			lines.push(
				`  - ⚠ Last maintenance lock contention: ${new Date(maintenance.lastContentionAt).toISOString()}`,
			);
		}
		// The bounded facts ring is the durable record of every release,
		// retained ambiguity, renewal, and failure — render it so operators
		// can see WHY a reservation disappeared or stayed (issue #2104's
		// durable rejection/uncertainty reasons). Bounded by the ring (≤20).
		if (maintenance.facts.length > 0) {
			lines.push(`  - Recent maintenance facts (${maintenance.facts.length}):`);
			for (const fact of maintenance.facts.slice(-5).reverse()) {
				const target = fact.reservationId
					? ` ${fact.reservationId.slice(0, 12)}…`
					: fact.correlationId
						? ` ${fact.correlationId.slice(0, 12)}…`
						: '';
				lines.push(
					`    - ${new Date(fact.at).toISOString()} ${fact.kind}${target} — ${fact.reason}`,
				);
			}
		}
	}
	return lines;
}

/**
 * Handle status command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleStatusCommand(
	directory: string,
	agents: Record<string, AgentDefinition>,
	sessionId?: string,
	options?: { backgroundSubagents?: boolean },
): Promise<string> {
	const statusData = await getStatusData(directory, agents, sessionId, options);

	if (!statusData.hasPlan) {
		// Issue #2104: the opt-in background-work section stays visible without
		// a plan — an orphaned reservation is most interesting exactly then.
		if (statusData.backgroundWork) {
			const lines = ['No active swarm plan found.'];
			lines.push(...renderBackgroundWorkLines(statusData.backgroundWork));
			return lines.join('\n');
		}
		// Issue #853 Layer C: surface spec drift even with no active plan, so
		// /swarm status never hides the staleness signal that gates writes.
		if (statusData.specStale) {
			const reason =
				statusData.specStaleReason ?? 'spec.md changed since plan saved';
			const stored = statusData.specStaleStoredHash ?? 'unknown';
			const current = statusData.specStaleCurrentHash ?? '(spec.md missing)';
			return [
				'No active swarm plan found.',
				'',
				`**Spec drift detected**: ${reason} (stored: ${stored}, current: ${current})`,
				'Run `/swarm clarify` to enter spec repair mode. Clarify alone does not clear drift: rewrite the spec so recovery can reconcile it, or run `/swarm acknowledge-spec-drift` to dismiss.',
			].join('\n');
		}
		// #2034 / #1659: a delegation-ledger incident must stay visible even
		// without an active plan — but only when there is something to say, so
		// the clean-repo output stays byte-identical (pinned by existing tests).
		const delegationHealth = statusData.delegationLedgerHealth;
		if (
			delegationHealth &&
			(delegationHealth.checkpoint ||
				delegationHealth.recovery ||
				delegationHealth.lastUncertainty ||
				delegationHealth.ledger.band !== 'ok' ||
				delegationHealth.counts.activeOwners > 0 ||
				delegationHealth.counts.pendingAdvisories > 0 ||
				delegationHealth.counts.lateTerminals > 0 ||
				delegationHealth.counts.orphanWorktreeOwners > 0)
		) {
			const lines = [
				'No active swarm plan found.',
				'',
				'**Background Delegations**:',
			];
			lines.push(
				`  - Ledger tail: ${formatLedgerBytes(delegationHealth.ledger.bytes)} / ${formatLedgerBytes(
					delegationHealth.ledger.limitBytes,
				)} recovery bound (${delegationHealth.ledger.pressurePct}% — ${delegationHealth.ledger.band})`,
			);
			if (delegationHealth.checkpoint) {
				lines.push(
					`  - Checkpoint #${delegationHealth.checkpoint.sequence} (${delegationHealth.checkpoint.liveRecords} live, ${delegationHealth.checkpoint.closedSummaries} archived)`,
				);
			}
			if (delegationHealth.recovery) {
				lines.push(
					`  - Recovery: ${delegationHealth.recovery.source} (${delegationHealth.recovery.ok ? 'ok' : `FAILED: ${delegationHealth.recovery.reason ?? 'uncertain'}`})`,
				);
			}
			const compactCounts = delegationHealth.counts;
			if (
				compactCounts.activeOwners > 0 ||
				compactCounts.pendingAdvisories > 0 ||
				compactCounts.lateTerminals > 0 ||
				compactCounts.orphanWorktreeOwners > 0
			) {
				lines.push(
					`  - Live set: ${compactCounts.activeOwners} active owners, ${compactCounts.pendingAdvisories} pending advisories, ${compactCounts.lateTerminals} late terminals, ${compactCounts.orphanWorktreeOwners} unsettled worktree owners`,
				);
			}
			if (delegationHealth.lastUncertainty) {
				lines.push(
					`  - ⚠ Last uncertainty (${new Date(delegationHealth.lastUncertainty.at).toISOString()}): ${delegationHealth.lastUncertainty.reason}`,
				);
				if (delegationHealth.lastUncertainty.repairHint) {
					lines.push(
						`    repair: ${delegationHealth.lastUncertainty.repairHint}`,
					);
				}
			}
			return lines.join('\n');
		}
		return 'No active swarm plan found.';
	}

	return formatStatusMarkdown(statusData);
}

async function safeLineCount(filePath: string): Promise<number> {
	try {
		if (!fsSync.existsSync(filePath)) return 0;
		const content = await readFile(filePath, 'utf-8');
		let n = 0;
		for (const line of content.split('\n')) {
			if (line.trim()) n++;
		}
		return n;
	} catch {
		return 0;
	}
}

async function countProposals(directory: string): Promise<number> {
	try {
		const proposalsDir = validateSwarmPath(directory, 'skills/proposals');
		if (!fsSync.existsSync(proposalsDir)) return 0;
		const { readdir } = await import('node:fs/promises');
		const entries = await readdir(proposalsDir);
		return entries.filter((f) => f.endsWith('.md')).length;
	} catch {
		return 0;
	}
}
