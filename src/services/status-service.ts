import * as fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition } from '../agents';
import { loadPluginConfig } from '../config/loader';
import { MemoryConfigSchema } from '../config/schema';
import { countConsensusReportFiles } from '../consensus/store';
import {
	type FullAutoRunState,
	loadFullAutoRunState,
} from '../full-auto/state';
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
	computeMemoryCohortFingerprint,
} from '../memory/redaction';
import { loadPlan } from '../plan/manager';
import {
	getActiveFullAutoSessionID,
	hasActiveFullAuto,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	swarmState,
} from '../state';
import { listRecoveryRecords } from '../turbo/lean/recovery';
import { loadLeanTurboRunState } from '../turbo/lean/state';
import { getCompactionMetrics } from './compaction-service';
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from './context-budget-service';

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
};

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
 * Get status data from the swarm directory.
 * Returns structured data that can be used by GUI, background flows, or commands.
 */
export async function getStatusData(
	directory: string,
	agents: Record<string, AgentDefinition>,
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
			contextBudgetPct:
				swarmState.lastBudgetPct > 0 ? swarmState.lastBudgetPct : null,
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
				contextBudgetPct:
					swarmState.lastBudgetPct > 0 ? swarmState.lastBudgetPct : null,
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
				contextBudgetPct:
					swarmState.lastBudgetPct > 0 ? swarmState.lastBudgetPct : null,
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
					) as { fingerprint?: string };
					// #1850 (final-critic dedup): shared fingerprint helper.
					const expected = computeMemoryCohortFingerprint(
						buildMemoryCohortFingerprintInput(memoryConfig),
					);
					configFingerprintMatch = stored.fingerprint === expected;
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

	// Enrich with Lean Turbo data if active
	return enrichWithLeanTurbo(status, directory);
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

	// Issue #853 Layer C: spec drift surfacing in /swarm status output.
	if (status.specStale) {
		const reason = status.specStaleReason ?? 'spec.md changed since plan saved';
		const stored = status.specStaleStoredHash ?? 'unknown';
		const current = status.specStaleCurrentHash ?? '(spec.md missing)';
		lines.push(
			'',
			`**Spec drift detected**: ${reason} (stored: ${stored}, current: ${current})`,
			'Run `/swarm clarify` to update the spec or `/swarm acknowledge-spec-drift` to dismiss.',
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
		const budgetTokens = DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens;
		const est = Math.round((status.contextBudgetPct / 100) * budgetTokens);
		lines.push(
			'',
			`**Context**: ${pct}% used (est. ${est.toLocaleString()} / ${budgetTokens.toLocaleString()} tokens)`,
		);
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

	return lines.join('\n');
}

/**
 * Handle status command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleStatusCommand(
	directory: string,
	agents: Record<string, AgentDefinition>,
): Promise<string> {
	const statusData = await getStatusData(directory, agents);

	if (!statusData.hasPlan) {
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
				'Run `/swarm clarify` to update the spec or `/swarm acknowledge-spec-drift` to dismiss.',
			].join('\n');
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
