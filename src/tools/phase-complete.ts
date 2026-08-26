/**
 * Phase completion tool for tracking and validating phase completion.
 * Core implementation - gathers data, enforces policy, writes event, resets state.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import type { EvidenceBundle } from '../config/evidence-schema';
import type { RuntimePlan } from '../config/plan-schema';
import {
	CuratorConfigSchema,
	KnowledgeConfigSchema,
	type PhaseCompleteConfig,
	PhaseCompleteConfigSchema,
	SkillImproverConfigSchema,
	stripKnownSwarmPrefix,
} from '../config/schema';
import { appendCoreEventSync } from '../events/core-events.js';
import { listEvidenceTaskIds, loadEvidence } from '../evidence/manager';
import {
	type ParticipationReadResult,
	readPhaseParticipation,
} from '../evidence/phase-participation.js';
import { verifyFullAutoPhaseApproval } from '../full-auto/phase-approval';
import { hasPassedAllGates } from '../gate-evidence';
import {
	applyCuratorKnowledgeUpdates,
	runCuratorPhase,
} from '../hooks/curator';
import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory.js';
import { extractCurrentPhaseFromPlan } from '../hooks/extractors.js';
import { curateAndStoreSwarm } from '../hooks/knowledge-curator.js';
import { updateRetrievalOutcome } from '../hooks/knowledge-reader.js';
import {
	commitPhaseClosed,
	recordPhaseCloseIntent,
} from '../hooks/knowledge-receipt-ledger.js';
import type { ConfidenceFloorOptions } from '../hooks/knowledge-store.js';
import {
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	sweepAgedEntries,
	sweepStaleTodos,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeConfig,
	KnowledgeEntryBase,
} from '../hooks/knowledge-types.js';
import {
	evaluatePhaseCriticalDirectives,
	formatDirectiveBlockMessage,
} from '../hooks/phase-complete-directive-gate.js';

import {
	buildApprovedReceipt,
	buildRejectedReceipt,
	persistReviewReceipt,
} from '../hooks/review-receipt.js';
import {
	applySkillUsageFeedback,
	pruneSkillUsageLog,
} from '../hooks/skill-usage-log.js';
import { validateSwarmPath } from '../hooks/utils';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { writeCheckpoint } from '../plan/checkpoint';
import {
	computePlanStructureHash,
	ledgerExists,
	replayFromLedger,
	takeSnapshotEvent,
} from '../plan/ledger';
import { loadPlan, savePlan } from '../plan/manager';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import { runMemoryConsolidationFireAndForget } from '../services/memory-consolidation.js';
import { runSkillConsolidationFireAndForget } from '../services/skill-consolidation.js';
import { flushPendingSnapshot } from '../session/snapshot-writer';
import {
	ensureAgentSession,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	swarmState,
} from '../state';
import { telemetry } from '../telemetry';
import { isEpicModeActiveForProject } from '../turbo/epic/state';
import { _internals as leanPhaseInternals } from '../turbo/lean/phase-ready';
import { pushAdvisory } from '../utils/advisory-queue';
import * as logger from '../utils/logger';
import { createSwarmTool } from './create-tool';
import {
	type GateContext,
	runArchitectureSupervisorGate,
	runCompletionVerifyGate,
	runDriftGate,
	runFinalCouncilGate,
	runFinalReviewGate,
	runHallucinationGate,
	runMutationGate,
	runPhaseCouncilGate,
} from './phase-complete/gates/index.js';
import {
	collectPhaseGateReport,
	formatPhaseGateCompatibility,
	type PhaseGateCheck,
	type PhaseGateReport,
} from './phase-complete/preflight-report.js';
import { computePhaseEvidenceSnapshot } from './phase-complete/snapshot-identity.js';
import { resolveWorkingDirectory } from './resolve-working-directory';

/** Narrow seam for receipt/plan ordering tests. */
export const phaseCompleteReceiptInternals = {
	recordPhaseCloseIntent,
	commitPhaseClosed,
};

/** Narrow seam for guarded-plan commit tests. */
export const phaseCompleteCommitInternals = {
	savePlan: (...args: Parameters<typeof savePlan>) => savePlan(...args),
};

/** Injectable observational gates for aggregate-preflight regression tests. */
export const phaseCompletePreflightInternals = {
	runCompletionVerifyGate,
	runDriftGate,
	runHallucinationGate,
	runMutationGate,
	runPhaseCouncilGate,
	runArchitectureSupervisorGate,
	runFinalReviewGate,
	runFinalCouncilGate,
};

/**
 * Arguments for the phase_complete tool
 */
export interface PhaseCompleteArgs {
	/** The phase number being completed */
	phase: number;
	/** Optional summary of the phase */
	summary?: string;
	/** Session ID to track state (optional, defaults to current session context) */
	sessionID?: string;
	/**
	 * Architect-only (Change 2, Task 2.4): explicitly accept these unresolved
	 * critical directive IDs. Requires acceptViolationsJustification. Each
	 * accepted id is logged as an `override` knowledge event.
	 */
	acceptViolations?: string[];
	/** Written justification required to use acceptViolations. */
	acceptViolationsJustification?: string;
	/** Calling agent identity (from tool ctx) — gates the override to the architect. */
	callerAgent?: string;
}

export interface PhaseCompleteRuntime {
	reviewModelDispatcher?: ReviewModelDispatcher;
	generatedAgentNames?: readonly string[];
	reviewAgentModelRegistry?: ReviewAgentModelRegistry;
	getActiveAgentName?: (sessionID: string) => string | undefined;
}

function resolvePhaseReviewAgentNames(
	runtime: PhaseCompleteRuntime,
): Iterable<string> {
	return runtime.generatedAgentNames ?? swarmState.generatedAgentNames;
}

/**
 * Baseline success response shape for phase_complete tool
 * Policy enforcement and events will be added in later tasks
 */
interface PhaseCompleteResult {
	success: boolean;
	phase: number;
	message: string;
	agentsDispatched: string[];
	agentsMissing: string[];
	status: 'success' | 'incomplete' | 'warned' | 'disabled';
	warnings: string[];
	gate_report?: PhaseGateReport;
	recovery_guidance?: string;
	phase_council_required?: boolean;
	final_council_required?: boolean;
}

function buildMissingAgentRecoveryGuidance(input: {
	missing: string[];
	docsAddedByConfig: boolean;
	docsEvidenceStatus: ParticipationReadResult['status'] | null;
	docsPlanReadable: boolean;
	policy: PhaseCompleteConfig['policy'];
}): string | undefined {
	if (input.missing.length === 0) return undefined;
	const steps = [
		`Dispatch the missing required role${input.missing.length === 1 ? '' : 's'} (${input.missing.join(', ')}) and retry phase_complete after each Task returns a successful, non-empty result.`,
	];
	if (input.docsAddedByConfig && input.missing.includes('docs')) {
		steps.push(
			'If this phase genuinely has no documentation obligation, set phase_complete.require_docs to false in opencode-swarm configuration; that setting is independent of the QA gate profile.',
		);
	}
	if (!input.docsPlanReadable && input.missing.includes('docs')) {
		steps.push(
			'A readable plan is required to bind durable docs participation. Restore or rebuild .swarm/plan.json/.swarm/plan.md (or recover from .swarm/plan-export/) before re-dispatching docs, then retry phase_complete.',
		);
	}
	if (input.docsEvidenceStatus === 'corrupt') {
		steps.push(
			'The readable docs-participation projection is corrupt; a genuine docs re-dispatch will quarantine the original bytes and rebuild it safely.',
		);
	} else if (
		input.docsEvidenceStatus === 'unreadable' ||
		input.docsEvidenceStatus === 'oversized'
	) {
		steps.push(
			'The docs-participation projection needs operator repair or archival before a re-dispatch can persist new proof.',
		);
	}
	if (
		input.missing.includes('docs') &&
		input.docsEvidenceStatus === 'missing'
	) {
		steps.push(
			'No prior durable docs-participation receipt was found (this can happen after a plugin upgrade or a cleared evidence store). A fresh docs Task dispatch writes a new durable completion receipt and is the canonical recovery path.',
		);
	}
	if (input.policy === 'warn') {
		steps.push(
			'The configured warn policy allows closure with a warning, but it does not create participation proof.',
		);
	} else {
		steps.push(
			'Last resort: if the missing role obligation genuinely cannot be satisfied in this environment, set phase_complete.policy to "warn" in opencode-swarm configuration. This weakens enforcement for every missing role and does NOT create durable participation proof, so only use it when the obligation cannot be met.',
		);
	}
	return steps.join(' ');
}

/**
 * Result from cross-session agent aggregation helper
 */
interface CrossSessionAgentsResult {
	/** Aggregated normalized agent names from all contributor sessions */
	agents: Set<string>;
	/** Session IDs that contributed to this aggregation (including caller session) */
	contributorSessionIds: string[];
}

function safeWarn(message: string, error: unknown): void {
	try {
		logger.warn(
			message,
			error instanceof Error ? error.message : String(error),
		);
	} catch {
		// Ignore logger failures to keep phase_complete non-blocking
	}
}

/** @tool-opt-out Output-size constant, not a tool definition. */
export const MAX_OUTPUT_BYTES = 512_000; // 512KB max output (FR-007, DD-013)

const TASK_GATE_INFERABLE_AGENTS = new Set([
	'coder',
	'reviewer',
	'test_engineer',
]);

function canInferMissingAgentsFromTaskGates(agentsMissing: string[]): boolean {
	return agentsMissing.every((agent) => TASK_GATE_INFERABLE_AGENTS.has(agent));
}

async function allCompletedTasksHavePassedGateEvidence(
	directory: string,
	tasks: Array<{ id: string; status: string }>,
): Promise<boolean> {
	for (const task of tasks) {
		if (task.status !== 'completed') return false;
		if (!(await hasPassedAllGates(directory, task.id))) return false;
	}
	return tasks.length > 0;
}

/**
 * Collect dispatched agents across contributor sessions.
 * Contributor sessions are defined as those with activity since a phase reference timestamp,
 * plus the caller session.
 *
 * @param phaseReferenceTimestamp - Filter sessions with activity after this timestamp (in ms)
 * @param callerSessionId - The caller's session ID (always included)
 * @returns Object containing aggregated agents and contributor session IDs
 */
function collectCrossSessionDispatchedAgents(
	phaseReferenceTimestamp: number,
	callerSessionId: string,
): CrossSessionAgentsResult {
	const agents = new Set<string>();
	const contributorSessionIds: string[] = [];

	// Always include the caller session
	const callerSession = swarmState.agentSessions.get(callerSessionId);
	if (callerSession) {
		contributorSessionIds.push(callerSessionId);

		// Collect agents from caller's phaseAgentsDispatched
		if (callerSession.phaseAgentsDispatched) {
			for (const agent of callerSession.phaseAgentsDispatched) {
				agents.add(agent);
			}
		}

		// Collect only caller delegation chains from the current phase window.
		// The caller session itself is always a contributor, but old delegations from
		// before the phase boundary must not satisfy this phase's required agents.
		for (const delegation of _getDelegationsSince(
			callerSessionId,
			phaseReferenceTimestamp,
		)) {
			agents.add(stripKnownSwarmPrefix(delegation.from));
			agents.add(stripKnownSwarmPrefix(delegation.to));
		}
	}

	// Find all other sessions with activity since the reference timestamp
	for (const [sessionId, session] of swarmState.agentSessions) {
		// Skip the caller session (already processed)
		if (sessionId === callerSessionId) {
			continue;
		}

		// Check if session has phase-relevant execution evidence since the reference timestamp.
		// This requires EITHER:
		// 1. Recent tool call activity (primary evidence of work)
		// 2. Recent delegation activity (shows coordination/agent dispatch)
		// Note: lastAgentEventTime alone is insufficient as it can be fresh without actual execution

		const hasRecentToolCalls =
			session.lastToolCallTime >= phaseReferenceTimestamp;

		// Check for recent delegation activity
		const delegations = swarmState.delegationChains.get(sessionId);
		const hasRecentDelegations =
			delegations?.some((d) => d.timestamp >= phaseReferenceTimestamp) ?? false;

		// Check for restored session with dispatched agents from same phase lifecycle.
		// After close/reopen, snapshot-restored sessions retain phaseAgentsDispatched
		// but fail the timestamp freshness check. If the session has agents AND its
		// lastPhaseCompleteTimestamp matches the caller's reference (both came from
		// the same phase boundary), it's a valid contributor.
		const hasRestoredAgents =
			(session.phaseAgentsDispatched?.size ?? 0) > 0 &&
			session.lastPhaseCompleteTimestamp === phaseReferenceTimestamp;

		const hasActivity =
			hasRecentToolCalls || hasRecentDelegations || hasRestoredAgents;

		if (hasActivity) {
			contributorSessionIds.push(sessionId);

			// Collect agents from this session's phaseAgentsDispatched
			if (session.phaseAgentsDispatched) {
				for (const agent of session.phaseAgentsDispatched) {
					agents.add(agent);
				}
			}

			// Collect only delegation chains from this phase window. A session can
			// have recent activity and still carry old chain entries from a previous
			// phase; those older entries must not satisfy this phase's required agents.
			for (const delegation of _getDelegationsSince(
				sessionId,
				phaseReferenceTimestamp,
			)) {
				agents.add(stripKnownSwarmPrefix(delegation.from));
				agents.add(stripKnownSwarmPrefix(delegation.to));
			}
		}
	}

	return { agents, contributorSessionIds };
}

/**
 * Event written to .swarm/events.jsonl on phase completion
 */
interface PhaseCompleteEvent {
	event: 'phase_complete';
	phase: number;
	timestamp: string;
	agents_dispatched: string[];
	agents_missing: string[];
	status: PhaseCompleteResult['status'];
	summary: string | null;
}

/**
 * Filter delegation chains since the last completion timestamp
 * @param sessionID - The session identifier
 * @param sinceTimestamp - Filter entries after this timestamp (0 means all entries)
 * @returns Array of delegation entries
 */
function _getDelegationsSince(
	sessionID: string,
	sinceTimestamp: number,
): Array<{ from: string; to: string; timestamp: number }> {
	const chain = swarmState.delegationChains.get(sessionID);
	if (!chain) {
		return [];
	}

	if (sinceTimestamp === 0) {
		// Return all entries if no previous completion
		return chain;
	}

	// Filter entries after the timestamp
	return chain.filter((entry) => entry.timestamp > sinceTimestamp);
}

/**
 * Normalize agent names from delegation entries
 * @param delegations - Array of delegation entries
 * @returns Set of normalized agent names
 */
function _normalizeAgentsFromDelegations(
	delegations: Array<{ from: string; to: string; timestamp: number }>,
): Set<string> {
	const agents = new Set<string>();

	for (const delegation of delegations) {
		const normalizedFrom = stripKnownSwarmPrefix(delegation.from);
		const normalizedTo = stripKnownSwarmPrefix(delegation.to);
		agents.add(normalizedFrom);
		agents.add(normalizedTo);
	}

	return agents;
}

/**
 * Type guard for valid retrospective entries matching a specific phase
 */
function isValidRetroEntry(
	entry: { type: string; [key: string]: unknown },
	phase: number,
): boolean {
	return (
		entry.type === 'retrospective' &&
		'phase_number' in entry &&
		(entry as { phase_number?: unknown }).phase_number === phase &&
		'verdict' in entry &&
		((entry as { verdict?: unknown }).verdict === 'pass' ||
			(entry as { verdict?: unknown }).verdict === 'fail')
	);
}

/**
 * Execute the phase_complete tool
 * Gathers data, enforces policy, writes event, resets state
 */
export async function executePhaseComplete(
	args: PhaseCompleteArgs,
	workingDirectory?: string,
	directory?: string,
	_runtime: PhaseCompleteRuntime = {},
): Promise<string> {
	// Extract arguments
	const phase = Number(args.phase);
	const summary = args.summary;
	const sessionID = args.sessionID;

	// Validate phase number — must be a positive integer
	if (
		Number.isNaN(phase) ||
		phase < 1 ||
		!Number.isFinite(phase) ||
		!Number.isInteger(phase)
	) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				status: 'blocked',
				message: 'Invalid phase number',
				agentsDispatched: [],
				warnings: ['Phase must be a positive number'],
			},
			null,
			2,
		);
	}

	// Get session state
	// If no sessionID provided, we can't track state - return error
	if (!sessionID) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Session ID is required',
				agentsDispatched: [],
				warnings: [
					'sessionID parameter is required for phase completion tracking',
				],
			},
			null,
			2,
		);
	}

	// Ensure session exists and get current state
	const session = ensureAgentSession(sessionID);

	// Get phase reference timestamp from session state (derived from last phase complete)
	const phaseReferenceTimestamp = session.lastPhaseCompleteTimestamp ?? 0;

	// Build warnings list early so it is available to both the drift gate and post-gate logic
	const warnings: string[] = [];
	if (hasActiveTurboMode(sessionID)) {
		warnings.push(
			`Turbo mode active — skipped completion-verify, drift-verifier, hallucination-guard, mutation-gate, and phase-council gates for phase ${phase}.`,
		);
	}

	// Use aggregated cross-session agents for required-agent evaluation
	const crossSessionResult = collectCrossSessionDispatchedAgents(
		phaseReferenceTimestamp,
		sessionID,
	);
	const agentsDispatched = Array.from(crossSessionResult.agents).sort();

	// Load plugin config for policy enforcement
	const dir = workingDirectory || directory!;
	const { config } = loadPluginConfigWithMeta(dir);
	let phaseCompleteConfig: PhaseCompleteConfig;
	try {
		phaseCompleteConfig = PhaseCompleteConfigSchema.parse(
			config.phase_complete ?? {},
		);
	} catch (parseError) {
		return JSON.stringify(
			{
				success: false,
				phase,
				status: 'incomplete' as const,
				message: `Invalid phase_complete configuration: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
				agentsDispatched,
				agentsMissing: [],
				warnings: ['Configuration validation failed'],
			},
			null,
			2,
		);
	}

	// If enforcement is disabled, return early with success
	if (phaseCompleteConfig.enabled === false) {
		const disabledReport = await collectPhaseGateReport({
			phase,
			checks: [
				'critical_directives',
				'retrospective',
				'completion_verify',
				'drift',
				'hallucination',
				'mutation',
				'phase_council',
				'architecture_supervisor',
				'final_review',
				'final_council',
				'full_auto_approval',
				'lean_turbo_readiness',
				'required_agents',
				'snapshot_identity',
			].map((id) => ({
				id,
				responsibleActor: 'architect',
				applicable: false,
				notApplicableDetail: 'phase completion enforcement is disabled',
				run: async () => ({
					blocked: false,
					agentsDispatched: [],
					agentsMissing: [],
					warnings: [],
				}),
			})),
		});
		return JSON.stringify(
			{
				success: true,
				phase,
				status: 'disabled',
				message: `Phase ${phase} complete (enforcement disabled)`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [],
				gate_report: disabledReport,
			},
			null,
			2,
		);
	}

	// Phase closure starts with one observational pass. Nothing below this
	// boundary may dispatch agents or write phase evidence until the complete
	// report has passed.
	const receiptPlan = await loadPlan(dir).catch(() => null);
	const receiptPhaseLabel = receiptPlan
		? (extractCurrentPhaseFromPlan(receiptPlan) ??
			`Phase ${receiptPlan.current_phase ?? phase}`)
		: `Phase ${phase}`;
	const knowledgeEnabled =
		(config.knowledge as { enabled?: boolean } | undefined)?.enabled !== false;
	let retroFound = false;
	let retroEntry: {
		lessons_learned?: string[];
		verdict?: 'pass' | 'fail';
	} | null = null;
	const invalidSchemaErrors: string[] = [];
	let loadedRetroTaskId: string | null = null;
	let loadedRetroBundle: EvidenceBundle | null = null;
	let retrospectiveGate: {
		schema_valid: boolean;
		gate_pass: boolean;
		verdict?: 'pass' | 'fail';
	} = {
		schema_valid: false,
		gate_pass: false,
	};
	const primaryRetroTaskId = `retro-${phase}`;
	// One captured clock for the whole aggregate preflight (issue #2102
	// contract D): every freshness-sensitive gate evaluates against this
	// single timestamp so gates cannot disagree across an age boundary mid-run.
	const preflightNowMs = Date.now();
	const gateCtx: GateContext = {
		phase,
		dir,
		sessionID,
		pluginConfig: config,
		agentsDispatched,
		safeWarn,
		loadedRetroBundle,
		loadedRetroTaskId,
		preflightNowMs,
	};
	const passGate = (extra: Record<string, unknown> = {}) => ({
		blocked: false,
		agentsDispatched,
		agentsMissing: [] as string[],
		warnings: [] as string[],
		...extra,
	});
	const preflightChecks: PhaseGateCheck[] = [];

	preflightChecks.push({
		id: 'critical_directives',
		responsibleActor: 'architect',
		applicable: knowledgeEnabled,
		notApplicableDetail: 'knowledge directives are disabled',
		run: async () => {
			const requestedAccept = Array.isArray(args.acceptViolations)
				? args.acceptViolations.filter(
						(value): value is string =>
							typeof value === 'string' && value.length > 0,
					)
				: [];
			if (requestedAccept.length > 0) {
				const callerAgent =
					args.callerAgent ??
					swarmState.activeAgent.get(sessionID) ??
					'architect';
				if (stripKnownSwarmPrefix(callerAgent).toLowerCase() !== 'architect') {
					return {
						...passGate(),
						blocked: true,
						reason: 'OVERRIDE_DENIED_NON_ARCHITECT',
						message:
							'accept_violations is architect-only and cannot be committed by this caller.',
					};
				}
				const justification =
					typeof args.acceptViolationsJustification === 'string'
						? args.acceptViolationsJustification.trim()
						: '';
				return {
					...passGate(),
					blocked: true,
					reason:
						justification.length >= 10
							? 'DIRECTIVE_OVERRIDE_SEPARATE_ACTION_REQUIRED'
							: 'OVERRIDE_REQUIRES_JUSTIFICATION',
					message:
						justification.length >= 10
							? 'Directive overrides are separate audited evidence writes. Record the override, then retry phase_complete without accept_violations.'
							: 'accept_violations requires at least 10 characters of substantive justification.',
					recovery: {
						kind: 'tool',
						action: 'record_directive_override',
						args: {
							directive_ids: requestedAccept,
							justification,
							phase,
						},
					},
				};
			}
			const directiveGate = await evaluatePhaseCriticalDirectives({
				directory: dir,
				sessionId: sessionID,
				phaseLabel: receiptPhaseLabel,
			});
			if (!directiveGate.blocked) return passGate();
			return {
				...passGate(),
				blocked: true,
				reason: directiveGate.failedClosed
					? 'DIRECTIVE_GATE_FAILED_CLOSED'
					: 'UNRESOLVED_CRITICAL_DIRECTIVES',
				message: directiveGate.failedClosed
					? 'Critical-directive gate could not read authoritative receipt state; failing closed.'
					: formatDirectiveBlockMessage(directiveGate.unresolved),
				unresolved_directives: directiveGate.unresolved,
				...('recovery' in directiveGate &&
				directiveGate.recovery &&
				typeof directiveGate.recovery === 'object'
					? { recovery: directiveGate.recovery }
					: {}),
			};
		},
	});

	preflightChecks.push({
		id: 'retrospective',
		responsibleActor: 'architect',
		run: async () => {
			const retroResult = await loadEvidence(dir, primaryRetroTaskId, {
				migrate: false,
			});
			const candidates: Array<{
				taskId: string;
				bundle: EvidenceBundle;
			}> = [];
			if (retroResult.status === 'found') {
				candidates.push({
					taskId: primaryRetroTaskId,
					bundle: retroResult.bundle,
				});
			} else if (retroResult.status === 'invalid_schema') {
				invalidSchemaErrors.push(...retroResult.errors);
			}
			if (candidates.length === 0) {
				const taskIds = (await listEvidenceTaskIds(dir))
					.filter((id) => /^retro-\d+$/.test(id))
					.sort();
				for (const taskId of taskIds) {
					const candidate = await loadEvidence(dir, taskId, { migrate: false });
					if (candidate.status === 'found') {
						candidates.push({ taskId, bundle: candidate.bundle });
					} else if (candidate.status === 'invalid_schema') {
						invalidSchemaErrors.push(...candidate.errors);
					}
				}
			}
			for (const candidate of candidates) {
				const entry = candidate.bundle.entries?.find((item) =>
					isValidRetroEntry(item, phase),
				) as
					| {
							lessons_learned?: string[];
							verdict?: 'pass' | 'fail';
					  }
					| undefined;
				if (!entry) continue;
				retroFound = true;
				retroEntry = entry;
				loadedRetroTaskId = candidate.taskId;
				loadedRetroBundle = candidate.bundle;
				retrospectiveGate = {
					schema_valid: true,
					gate_pass: entry.verdict === 'pass',
					verdict: entry.verdict,
				};
				gateCtx.loadedRetroTaskId = candidate.taskId;
				gateCtx.loadedRetroBundle = candidate.bundle;
				if (entry.verdict === 'fail') {
					return {
						...passGate(),
						blocked: true,
						reason: 'RETROSPECTIVE_FAILED',
						message:
							'The retrospective is schema-valid and truthfully records verdict "fail". Resolve the phase findings and write a new explicit verdict before retrying.',
						retrospective_gate: retrospectiveGate,
						recovery: { kind: 'tool', action: 'write_retro' },
					};
				}
				return passGate({ retrospective_gate: retrospectiveGate });
			}
			const schemaDetail =
				invalidSchemaErrors.length > 0
					? ` Schema validation failed: ${invalidSchemaErrors
							.slice(0, 8)
							.join('; ')}.`
					: '';
			return {
				...passGate(),
				blocked: true,
				reason:
					invalidSchemaErrors.length > 0
						? 'RETROSPECTIVE_SCHEMA_INVALID'
						: 'RETROSPECTIVE_MISSING',
				message: `Phase ${phase} cannot be completed without an explicit retrospective verdict.${schemaDetail}`,
				retrospective_gate: retrospectiveGate,
				recovery: {
					kind: 'tool',
					action: 'write_retro',
					args: { phase },
				},
			};
		},
	});

	const turboActive = hasActiveTurboMode(sessionID);
	const standardGateSpecs: Array<{
		id: string;
		actor: string;
		run: () => Promise<import('./phase-complete/gates/types.js').GateResult>;
	}> = [
		{
			id: 'completion_verify',
			actor: 'test_engineer',
			run: () =>
				phaseCompletePreflightInternals.runCompletionVerifyGate(gateCtx),
		},
		{
			id: 'drift',
			actor: 'critic',
			run: () => phaseCompletePreflightInternals.runDriftGate(gateCtx),
		},
		{
			id: 'hallucination',
			actor: 'reviewer',
			run: () => phaseCompletePreflightInternals.runHallucinationGate(gateCtx),
		},
		{
			id: 'mutation',
			actor: 'test_engineer',
			run: () => phaseCompletePreflightInternals.runMutationGate(gateCtx),
		},
		{
			id: 'phase_council',
			actor: 'architect',
			run: () => phaseCompletePreflightInternals.runPhaseCouncilGate(gateCtx),
		},
	];
	for (const spec of standardGateSpecs) {
		preflightChecks.push({
			id: spec.id,
			responsibleActor: spec.actor,
			applicable: !turboActive,
			notApplicableDetail: 'standard gate bypassed by active Turbo policy',
			run: spec.run,
		});
	}
	preflightChecks.push({
		id: 'architecture_supervisor',
		responsibleActor: 'architecture_supervisor',
		applicable:
			config.architectural_supervision?.enabled === true &&
			config.architectural_supervision.mode === 'gate',
		notApplicableDetail: 'architecture supervision gate is not enabled',
		run: () =>
			phaseCompletePreflightInternals.runArchitectureSupervisorGate(gateCtx),
	});
	preflightChecks.push({
		id: 'final_review',
		responsibleActor: 'reviewer',
		run: () => phaseCompletePreflightInternals.runFinalReviewGate(gateCtx),
	});
	preflightChecks.push({
		id: 'final_council',
		responsibleActor: 'architect',
		run: () => phaseCompletePreflightInternals.runFinalCouncilGate(gateCtx),
	});
	preflightChecks.push({
		id: 'full_auto_approval',
		responsibleActor: 'critic',
		run: async () => {
			const approval = verifyFullAutoPhaseApproval(
				dir,
				sessionID,
				phase,
				config,
			);
			return approval.ok
				? passGate()
				: {
						...passGate(),
						blocked: true,
						reason: 'FULL_AUTO_APPROVAL_REQUIRED',
						message: `Phase ${phase} cannot be completed: ${approval.reason ?? 'Full-Auto v2 approval missing'}`,
						recovery: {
							kind: 'user_action',
							action: 'Task',
							args: {
								subagent_type: 'critic_oversight',
								trigger_source: 'phase_boundary',
								phase,
							},
						},
					};
		},
	});
	const epicActiveForProject = isEpicModeActiveForProject(dir);
	preflightChecks.push({
		id: 'lean_turbo_readiness',
		responsibleActor: 'architect',
		applicable: hasActiveLeanTurbo(sessionID) && !epicActiveForProject,
		notApplicableDetail: 'Lean Turbo is inactive or Epic Mode owns readiness',
		run: async () => {
			const leanConfig = config?.turbo?.lean;
			const check = leanPhaseInternals.verifyLeanTurboPhaseReady(
				dir,
				phase,
				sessionID,
				leanConfig
					? {
							phase_reviewer: leanConfig.phase_reviewer,
							phase_critic: leanConfig.phase_critic,
							integrated_diff_required: leanConfig.integrated_diff_required,
						}
					: undefined,
			);
			return check.ok
				? passGate()
				: {
						...passGate(),
						blocked: true,
						reason: 'LEAN_TURBO_PHASE_NOT_READY',
						message: `Phase ${phase} cannot be completed: ${check.reason}`,
					};
		},
	});

	preflightChecks.push({
		id: 'required_agents',
		responsibleActor: 'architect',
		run: async () => {
			let participationPlan: RuntimePlan | null = null;
			let phaseRequiredAgents: string[] | undefined;
			try {
				participationPlan = await loadPlan(dir);
				phaseRequiredAgents = participationPlan?.phases.find(
					(item) => item.id === phase,
				)?.required_agents;
			} catch {
				participationPlan = null;
			}
			const configured = [
				...(phaseRequiredAgents ?? phaseCompleteConfig.required_agents),
			];
			const required = [...configured];
			if (phaseCompleteConfig.require_docs && !required.includes('docs')) {
				required.push('docs');
			}
			let docsStatus: ParticipationReadResult['status'] | null = null;
			let durableDocsFound = false;
			if (required.includes('docs')) {
				crossSessionResult.agents.delete('docs');
				if (participationPlan) {
					const receipt = readPhaseParticipation(
						dir,
						participationPlan,
						phase,
						'docs',
					);
					docsStatus = receipt.status;
					if (receipt.found) {
						durableDocsFound = true;
						crossSessionResult.agents.add('docs');
					}
				}
			}
			let missing = required.filter(
				(role) => !crossSessionResult.agents.has(role),
			);
			let inferredFromTaskGates: string[] = [];
			if (missing.length > 0) {
				try {
					const planRaw = fs.readFileSync(
						validateSwarmPath(dir, 'plan.json'),
						'utf8',
					);
					const plan = JSON.parse(planRaw) as {
						phases: Array<{
							id: number;
							tasks: Array<{ id: string; status: string }>;
						}>;
					};
					const target = plan.phases.find((item) => item.id === phase);
					if (
						target &&
						target.tasks.length > 0 &&
						canInferMissingAgentsFromTaskGates(missing) &&
						(await allCompletedTasksHavePassedGateEvidence(dir, target.tasks))
					) {
						inferredFromTaskGates = [...missing];
						missing = [];
					}
				} catch {
					// Fail closed through the unresolved missing set.
				}
			}
			const recoveryGuidance = buildMissingAgentRecoveryGuidance({
				missing,
				docsAddedByConfig:
					phaseCompleteConfig.require_docs && !configured.includes('docs'),
				docsEvidenceStatus: docsStatus,
				docsPlanReadable: participationPlan !== null,
				policy: phaseCompleteConfig.policy,
			});
			const authoritativeAgents = [...crossSessionResult.agents].sort();
			return missing.length > 0 && phaseCompleteConfig.policy === 'enforce'
				? {
						...passGate(),
						blocked: true,
						reason: 'REQUIRED_AGENTS_MISSING',
						message: `Phase ${phase} is missing required agents: ${missing.join(', ')}. ${recoveryGuidance}`,
						agentsMissing: missing,
						agentsDispatched: authoritativeAgents,
						recovery_guidance: recoveryGuidance,
						recovery: {
							kind: 'user_action',
							action: 'Task',
							args: { agents: missing },
						},
					}
				: passGate({
						agentsDispatched: durableDocsFound
							? [...new Set([...authoritativeAgents, 'docs'])].sort()
							: authoritativeAgents,
						recovery_guidance: recoveryGuidance,
						agentsMissing: missing,
						warnings: [
							...(durableDocsFound
								? [
										`Recovered durable docs participation proof for phase ${phase}.`,
									]
								: []),
							...(inferredFromTaskGates.length > 0
								? [
										`Agent dispatch fallback: all completed tasks in phase ${phase} have durable passing gate evidence. Clearing missing agents: ${inferredFromTaskGates.join(', ')}.`,
									]
								: []),
							...(missing.length > 0
								? [
										`Warning: phase ${phase} missing required agents: ${missing.join(', ')} (advisory because phase_complete.policy=warn).`,
									]
								: []),
						],
					});
		},
	});

	preflightChecks.push({
		id: 'snapshot_identity',
		responsibleActor: 'architect',
		run: async () => {
			const plan = await loadPlan(dir);
			const structureHash = plan ? computePlanStructureHash(plan) : 'plan:none';
			const policyHash = createHash('sha256')
				.update(JSON.stringify(config))
				.digest('hex');
			const evidenceHash = computePhaseEvidenceSnapshot(dir);
			return passGate({
				evidenceRefs: [
					`plan-structure:${structureHash}`,
					`policy:${policyHash}`,
					`phase-evidence:${evidenceHash}`,
				],
			});
		},
	});

	const preflightReport = await collectPhaseGateReport({
		phase,
		checks: preflightChecks,
	});
	if (preflightReport.outcome === 'block') {
		return JSON.stringify(
			formatPhaseGateCompatibility(preflightReport),
			null,
			2,
		);
	}
	for (const entry of preflightReport.entries) {
		warnings.push(...entry.warnings);
	}
	// The retrospective check populates these values inside an async closure.
	// Capture its accepted state explicitly because control-flow analysis cannot
	// infer those closure assignments.
	const acceptedRetro = {
		found: retroFound as boolean,
		entry: retroEntry as {
			lessons_learned?: string[];
			verdict?: 'pass' | 'fail';
		} | null,
		taskId: loadedRetroTaskId as string | null,
		bundle: loadedRetroBundle as EvidenceBundle | null,
	};
	const phaseRecoveryGuidance = preflightReport.entries.find(
		(entry) => entry.id === 'required_agents' && entry.recoveryGuidance,
	)?.recoveryGuidance;

	// Guard the single authoritative plan transition before any advisory,
	// curation, event, session-reset, or knowledge-feedback side effect.
	let phaseCommitAgent = 'phase-complete';
	for (const [, activeAgent] of swarmState.activeAgent) {
		phaseCommitAgent = activeAgent;
		break;
	}
	const planLockTaskId = `phase-complete-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	let phasePlanLock: Awaited<ReturnType<typeof tryAcquireLock>> | undefined;
	try {
		phasePlanLock = await tryAcquireLock(
			dir,
			'plan.json',
			phaseCommitAgent,
			planLockTaskId,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return JSON.stringify({
			success: false,
			phase,
			status: 'incomplete' as const,
			reason: 'PHASE_COMMIT_LOCK_ERROR',
			message: `Failed to acquire the guarded phase commit lock: ${detail}`,
			agentsDispatched,
			agentsMissing: [],
			warnings,
			gate_report: preflightReport,
			errors: [`Phase commit lock acquisition failed: ${detail}`],
			recovery_guidance:
				'Resolve the filesystem or lock-directory error, then retry phase_complete. No phase transition or completion event was committed.',
			recovery: { kind: 'retry', action: 'phase_complete' },
		});
	}
	if (!phasePlanLock.acquired) {
		const lockOwner = phasePlanLock.existing?.agent ?? 'another agent';
		return JSON.stringify({
			success: false,
			phase,
			status: 'incomplete' as const,
			reason: 'PHASE_COMMIT_LOCKED',
			message: `Plan write is locked by ${lockOwner}.`,
			agentsDispatched,
			agentsMissing: [],
			warnings,
			gate_report: preflightReport,
			errors: [`Concurrent plan write detected; lock is held by ${lockOwner}.`],
			recovery_guidance:
				'Wait for the current plan writer to finish, then retry phase_complete. No phase transition or completion event was committed.',
			recovery: { kind: 'retry', action: 'phase_complete' },
		});
	}
	try {
		const lockedPreflight = await collectPhaseGateReport({
			phase,
			checks: preflightChecks,
		});
		if (
			lockedPreflight.outcome !== 'pass' ||
			lockedPreflight.reportHash !== preflightReport.reportHash
		) {
			return JSON.stringify({
				success: false,
				phase,
				status: 'blocked' as const,
				reason: 'PHASE_PREFLIGHT_STALE',
				message:
					'Phase evidence, plan identity, or policy changed after preflight. No phase transition or post-commit side effect was written.',
				agentsDispatched,
				agentsMissing: [],
				warnings,
				gate_report: lockedPreflight,
				recovery: { kind: 'retry', action: 'phase_complete' },
			});
		}
		let plan = await loadPlan(dir);
		if ((plan as RuntimePlan | null)?._ledgerReplayStale === true) {
			const staleReason =
				(plan as RuntimePlan)._ledgerReplayStaleReason ?? 'unknown reason';
			return JSON.stringify({
				success: false,
				phase,
				status: 'incomplete' as const,
				reason: 'PHASE_PLAN_STALE',
				message: `Plan write refused: plan.json is stale from a failed ledger replay (${staleReason}). Refusing to complete phase ${phase} against a known-stale plan.`,
				agentsDispatched,
				agentsMissing: [],
				warnings,
				gate_report: lockedPreflight,
				errors: [`Stale plan from failed ledger replay: ${staleReason}`],
				recovery_guidance:
					'The ledger replay failed and no critic-approved snapshot was available, so loadPlan fell back to a stale plan.json. Do NOT retry blindly. Recover first: re-verify the plan (re-run completion verification), reset the session, or restore from the latest checkpoint under .swarm/plan-export/, then retry phase_complete.',
				_ledgerReplayStaleReason: staleReason,
			});
		}
		if (!plan && (await ledgerExists(dir))) {
			plan = await replayFromLedger(dir);
		}
		const phaseObject = plan
			? plan.phases.find((candidate) => candidate.id === phase)
			: undefined;
		if (plan) {
			if (!phaseObject) {
				return JSON.stringify({
					success: false,
					phase,
					status: 'incomplete' as const,
					reason: 'PHASE_NOT_IN_PLAN',
					message: `Phase ${phase} is not present in the authoritative plan.`,
					agentsDispatched,
					agentsMissing: [],
					warnings,
					gate_report: lockedPreflight,
				});
			}
		} else if (fs.existsSync(validateSwarmPath(dir, 'plan.json'))) {
			return JSON.stringify({
				success: false,
				phase,
				status: 'incomplete' as const,
				reason: 'PHASE_PLAN_UNREADABLE',
				message:
					'Plan exists but could not be read or rebuilt from the ledger; no phase transition was committed.',
				agentsDispatched,
				agentsMissing: [],
				warnings,
				gate_report: lockedPreflight,
			});
		}
		// The close intent is the WAL record for the plan transition. Persist it
		// only after the locked freshness and authoritative-plan validation, but
		// before mutation, so rejected plans cannot publish misleading intents.
		if (knowledgeEnabled) {
			const closeIntent =
				await phaseCompleteReceiptInternals.recordPhaseCloseIntent(
					dir,
					receiptPhaseLabel,
					sessionID,
				);
			if (!closeIntent.ok) {
				return JSON.stringify({
					success: false,
					phase,
					status: 'incomplete' as const,
					reason: 'PHASE_CLOSE_INTENT_FAILED',
					message:
						'Phase completion blocked: could not persist receipt phase-close intent.',
					agentsDispatched,
					agentsMissing: [],
					warnings,
					gate_report: lockedPreflight,
					errors: [closeIntent.detail],
					recovery: { kind: 'retry', action: 'phase_complete' },
				});
			}
		}
		const commitPreflight = await collectPhaseGateReport({
			phase,
			checks: preflightChecks,
		});
		if (commitPreflight.outcome !== 'pass') {
			return JSON.stringify({
				success: false,
				phase,
				status: 'blocked' as const,
				reason: 'PHASE_PREFLIGHT_STALE',
				message:
					'Phase evidence or policy changed before the authoritative transition. No plan transition or completion event was written.',
				agentsDispatched,
				agentsMissing: [],
				warnings,
				gate_report: commitPreflight,
				recovery: { kind: 'retry', action: 'phase_complete' },
			});
		}
		const commitEvidenceRef = commitPreflight.entries
			.find((entry) => entry.id === 'snapshot_identity')
			?.evidenceRefs.find((reference) =>
				reference.startsWith('phase-evidence:'),
			);
		const commitPolicyRef = commitPreflight.entries
			.find((entry) => entry.id === 'snapshot_identity')
			?.evidenceRefs.find((reference) => reference.startsWith('policy:'));
		const expectedCommitEvidenceHash = commitEvidenceRef?.slice(
			'phase-evidence:'.length,
		);
		const expectedCommitPolicyHash = commitPolicyRef?.slice('policy:'.length);
		if (!expectedCommitEvidenceHash || !expectedCommitPolicyHash) {
			return JSON.stringify({
				success: false,
				phase,
				status: 'blocked' as const,
				reason: 'PHASE_PREFLIGHT_STALE',
				message:
					'The commit-boundary evidence identity was unavailable. No plan transition or completion event was written.',
				agentsDispatched,
				agentsMissing: [],
				warnings,
				gate_report: commitPreflight,
				recovery: { kind: 'retry', action: 'phase_complete' },
			});
		}
		if (
			plan &&
			phaseObject &&
			!['complete', 'completed', 'closed'].includes(phaseObject.status)
		) {
			phaseObject.status = 'complete';
			try {
				await phaseCompleteCommitInternals.savePlan(dir, plan, {
					preserveCompletedStatuses: true,
					planLockAlreadyHeld: true,
					preCommitCheck: () => {
						const currentPolicyHash = createHash('sha256')
							.update(JSON.stringify(loadPluginConfigWithMeta(dir).config))
							.digest('hex');
						if (
							computePhaseEvidenceSnapshot(dir) !==
								expectedCommitEvidenceHash ||
							currentPolicyHash !== expectedCommitPolicyHash
						) {
							throw new Error(
								'PHASE_PREFLIGHT_STALE: evidence changed at the authoritative transition boundary',
							);
						}
					},
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.startsWith('PHASE_PREFLIGHT_STALE:')
				) {
					return JSON.stringify({
						success: false,
						phase,
						status: 'blocked' as const,
						reason: 'PHASE_PREFLIGHT_STALE',
						message:
							'Phase evidence changed at the authoritative transition boundary. No plan transition or completion event was written.',
						agentsDispatched,
						agentsMissing: [],
						warnings,
						gate_report: commitPreflight,
						recovery: { kind: 'retry', action: 'phase_complete' },
					});
				}
				throw error;
			}
			await takeSnapshotEvent(dir, plan).catch(() => undefined);
		}
	} finally {
		if (phasePlanLock.lock._release) {
			await phasePlanLock.lock._release().catch((error: unknown) => {
				logger.warn(
					'[phase_complete] Plan lock release failed:',
					error instanceof Error ? error.message : String(error),
				);
			});
		}
	}
	if (knowledgeEnabled) {
		const receiptClose = await phaseCompleteReceiptInternals.commitPhaseClosed(
			dir,
			receiptPhaseLabel,
			sessionID,
		);
		if (!receiptClose.ok) {
			return JSON.stringify({
				success: false,
				phase,
				status: 'incomplete' as const,
				reason: 'PHASE_RECEIPT_CLOSE_PENDING',
				message:
					'Plan phase closed, but receipt lifecycle closure is pending reconciliation; retry phase_complete.',
				agentsDispatched,
				agentsMissing: [],
				warnings: [...warnings, receiptClose.detail],
				gate_report: preflightReport,
				recovery: { kind: 'retry', action: 'phase_complete' },
			});
		}
	}
	const requiredAgentsEntry = preflightReport.entries.find(
		(entry) => entry.id === 'required_agents',
	);
	if (requiredAgentsEntry) {
		agentsDispatched.splice(
			0,
			agentsDispatched.length,
			...requiredAgentsEntry.agentsDispatched,
		);
	}

	// Knowledge config: load from plugin config so user overrides are respected.
	// Falls back to schema defaults if config is absent or partially specified.
	// Degrade gracefully on malformed user config — sweep is non-blocking.
	let knowledgeConfig: KnowledgeConfig;
	try {
		knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
	} catch (parseErr) {
		warnings.push(`Knowledge config validation failed: ${String(parseErr)}`);
		knowledgeConfig = KnowledgeConfigSchema.parse({});
	}

	// Extract and store lessons from retrospective to knowledge.jsonl
	if (
		acceptedRetro.found &&
		acceptedRetro.entry?.lessons_learned &&
		acceptedRetro.entry.lessons_learned.length > 0
	) {
		try {
			// Infer project name from directory
			const projectName = path.basename(dir);

			// Change 4 (Task 4.2): provide the curator LLM delegate so plain-prose
			// lessons are enriched with v3 actionability fields before the Layer-5
			// gate; quota knobs come from the dedicated knowledge.enrichment budget.
			const curationResult = await curateAndStoreSwarm(
				acceptedRetro.entry.lessons_learned,
				projectName,
				{ phase_number: phase },
				dir,
				knowledgeConfig,
				{
					llmDelegate: createCuratorLLMDelegate(dir, 'phase', sessionID),
					enrichmentQuota: {
						maxCalls: knowledgeConfig.enrichment.max_calls_per_day,
						window: knowledgeConfig.enrichment.quota_window,
					},
				},
			);
			// curateAndStoreSwarm always returns a non-nullable object, so gate on
			// substance: only announce the curation when it actually did something
			// (stored/reinforced/quarantined/rejected). A skipped-only curation is a
			// no-op not worth surfacing to the architect.
			const curationTouchedAny =
				curationResult &&
				curationResult.stored +
					curationResult.reinforced +
					curationResult.quarantined +
					curationResult.rejected >
					0;
			if (curationTouchedAny) {
				const sessionState = swarmState.agentSessions.get(sessionID);
				if (sessionState) {
					pushAdvisory(
						sessionState,
						`[CURATOR] Knowledge curation: ${curationResult.stored} stored, ${curationResult.reinforced} reinforced, ${curationResult.skipped} skipped, ${curationResult.rejected} rejected, ${curationResult.quarantined} quarantined (unactionable).`,
					);
				}
			}

			// Retrieval-outcome recording moved below — it now runs after the
			// phase's real success/failure is determined (see the call after
			// `result` is built). Recording `true` here was wrong: it asserted
			// success before the outcome was known.
		} catch (error) {
			// Log warning but don't block phase completion
			safeWarn(
				'[phase_complete] Failed to curate lessons from retrospective:',
				error,
			);
		}
	}

	let complianceWarnings: string[] = [];

	// Curator pipeline: collect phase data and run knowledge updates. Never blocks phase_complete.
	try {
		const curatorConfig = CuratorConfigSchema.parse(config.curator ?? {});
		if (curatorConfig.enabled && curatorConfig.phase_enabled) {
			const llmDelegate = createCuratorLLMDelegate(
				dir,
				'phase',
				sessionID ?? undefined,
			);
			const curatorResult = await runCuratorPhase(
				dir,
				phase,
				agentsDispatched,
				curatorConfig,
				{},
				llmDelegate,
			);
			// Persist review receipt for drift tracking (best-effort)
			{
				const scopeContent =
					curatorResult.digest?.summary ?? `Phase ${phase} curator analysis`;
				const complianceWarnings = curatorResult.compliance.filter(
					(c) => c.severity === 'warning',
				);
				const receipt =
					complianceWarnings.length > 0
						? buildRejectedReceipt({
								agent: 'curator',
								scopeContent,
								scopeDescription: 'phase-digest',
								blockingFindings: complianceWarnings.map((c) => ({
									location: `phase-${c.phase}`,
									summary: c.description,
									severity:
										c.type === 'missing_reviewer'
											? ('high' as const)
											: ('medium' as const),
								})),
								evidenceReferences: [],
								passConditions: [
									'resolve all compliance warnings before phase completion',
								],
							})
						: buildApprovedReceipt({
								agent: 'curator',
								scopeContent,
								scopeDescription: 'phase-digest',
								checkedAspects: [
									'phase_compliance',
									'knowledge_recommendations',
									'phase_digest',
								],
								validatedClaims: [
									`phase: ${phase}`,
									`agents_dispatched: ${agentsDispatched.length}`,
									`knowledge_recommendations: ${curatorResult.knowledge_recommendations.length}`,
								],
							});
				persistReviewReceipt(dir, receipt).catch(() => {});
			}
			const knowledgeResult = await applyCuratorKnowledgeUpdates(
				dir,
				curatorResult.knowledge_recommendations,
				knowledgeConfig,
			);
			// Site A: deterministic drift check for the current phase. When it
			// detects drift it writes an on-disk report AND pushes an advisory via
			// the callback below. Track whether that callback fired so the
			// prior-report re-read (Site B) can avoid re-pushing a near-duplicate
			// for the SAME phase in the SAME run (issue #1976 B5.4).
			let driftAdvisoryPushedThisRun = false;
			try {
				const { runDeterministicDriftCheck } = await import(
					'../hooks/curator-drift.js'
				);
				await runDeterministicDriftCheck(
					dir,
					phase,
					curatorResult,
					curatorConfig,
					(message) => {
						const sessionState = swarmState.agentSessions.get(sessionID);
						if (sessionState) {
							pushAdvisory(sessionState, message);
							driftAdvisoryPushedThisRun = true;
						}
					},
				);
			} catch {
				// Non-blocking: drift reports are advisory and must not gate phase completion.
			}
			// Advisory injection: push actionable curator message to architect session
			const callerSessionState = swarmState.agentSessions.get(sessionID);
			if (callerSessionState) {
				const DIGEST_PLACEHOLDER = 'Phase analysis complete';
				const digestSummary = curatorResult.digest?.summary
					? curatorResult.digest.summary.slice(0, 200)
					: DIGEST_PLACEHOLDER;
				const complianceNote =
					curatorResult.compliance.length > 0
						? ` (${curatorResult.compliance.length} compliance observation(s))`
						: '';

				// Only suggest curator_analyze when there are unapplied recommendations
				const hasRecommendations =
					curatorResult.knowledge_recommendations.length > 0;
				const analyzeHint = hasRecommendations
					? ' Call curator_analyze with recommendations to apply knowledge updates from this phase.'
					: '';

				// Only surface the phase-digest advisory when there is real analysis to
				// report. When the digest has no summary we fall back to a placeholder,
				// which carries no information worth announcing to the architect.
				if (digestSummary !== DIGEST_PLACEHOLDER) {
					pushAdvisory(
						callerSessionState,
						`[CURATOR] Phase ${phase} digest: ${digestSummary}${complianceNote}. Knowledge: ${knowledgeResult.applied} applied, ${knowledgeResult.skipped} skipped.${analyzeHint}`,
					);
				}

				// Check for drift advisories from prior deterministic drift checks
				try {
					const { readPriorDriftReports } = await import(
						'../hooks/curator-drift.js'
					);
					const priorReports = await readPriorDriftReports(dir);
					const phaseReport = priorReports
						.filter((r) => r.phase === phase)
						.pop();
					// Site B: only reach here for a PRIOR on-disk drift report when the
					// deterministic check this run did NOT already push for this phase
					// (e.g. it threw, or returned ALIGNED). When Site A already fired we
					// skip to avoid a near-duplicate advisory for the same phase (the
					// critic_drift_verifier nudge was folded into Site A's message).
					if (
						phaseReport &&
						phaseReport.drift_score > 0 &&
						!driftAdvisoryPushedThisRun
					) {
						pushAdvisory(
							callerSessionState,
							`[CURATOR DRIFT DETECTED (phase ${phase}, score ${phaseReport.drift_score})]: Prior drift report found on disk. Consider running critic_drift_verifier before phase completion to get a proper drift review. Review drift report for phase ${phase} and address spec alignment if applicable.`,
						);
					}
				} catch {
					// Non-blocking — drift advisory is informational only
				}
			}
			// Surface non-suppressed compliance observations in return value
			// so the architect sees workflow deviations (missing reviewer, missing retro, etc.)
			if (
				curatorResult.compliance.length > 0 &&
				!curatorConfig.suppress_warnings
			) {
				const complianceLines = curatorResult.compliance
					.map((obs) => `[${obs.severity.toUpperCase()}] ${obs.description}`)
					.slice(0, 5); // cap at 5 to limit token cost
				complianceWarnings = complianceLines;
			}
		}
	} catch (curatorError) {
		safeWarn(
			'[phase_complete] Curator pipeline error (non-blocking):',
			curatorError,
		);
	}

	// Design-doc drift (issue #1080): opt-in, advisory, never blocks phase_complete.
	// Deterministically compares the generated design docs against code/spec mtimes
	// via the traceability registry and, when stale, advises the architect to run a
	// docs_design sync (MODE: DESIGN_DOCS --update). It does NOT auto-dispatch the
	// standard docs agent and does NOT gate completion.
	try {
		if (config.design_docs?.enabled === true) {
			const outDir = config.design_docs.out_dir ?? 'docs';
			const { runDesignDocDriftCheck } = await import(
				'../hooks/design-doc-drift.js'
			);
			const docReport = await runDesignDocDriftCheck(dir, phase, outDir);
			if (docReport?.verdict === 'DOC_STALE') {
				const callerSessionState = swarmState.agentSessions.get(sessionID);
				if (callerSessionState) {
					const staleIds = docReport.stale_sections
						.map((s) => s.section_id)
						.slice(0, 8)
						.join(', ');
					pushAdvisory(
						callerSessionState,
						`[DESIGN-DOC DRIFT (phase ${phase})]: ${docReport.stale_sections.length} design-doc section(s) are stale (${staleIds}). Run /swarm design-docs --update to sync ${outDir}/ and append a design-changelog entry. Advisory only — does not block completion.`,
					);
				}
			}
		}
	} catch (docDriftError) {
		safeWarn(
			'[phase_complete] Design-doc drift check error (non-blocking):',
			docDriftError,
		);
	}

	// G2 (#1715): confidence-floor options derived from config once, reused by
	// both feedback bridges (skill-usage and verdict) so they stay consistent.
	const floorOptions: ConfidenceFloorOptions = {
		floorAction: knowledgeConfig.confidence_floor_action,
		floorMinOutcomes: knowledgeConfig.confidence_floor_min_outcomes,
		floorSignalThreshold: knowledgeConfig.confidence_floor_signal_threshold,
	};

	// Skill usage feedback + pruning: close the learning loop at phase boundaries.
	// Idempotency is provided by the authoritative sidecar queue in
	// `.swarm/skill-usage-pending.json` (issue #2038), NOT by `feedback_applied`
	// marker lines in the JSONL — those were the unbounded accumulation the issue
	// is about, and the one-time migration drops them. Each actionable verdict is
	// enqueued as a record before it is appended to the stream; consumption claims
	// records under a lock, marks them `in_flight`, and dequeues them once the
	// confidence bump returns, so a record is applied at most once and a crash
	// mid-cycle leaves it visible rather than replayed.
	// Errors never block phase_complete.
	try {
		const feedbackResult = await applySkillUsageFeedback(dir, { floorOptions });

		if (feedbackResult.processed > 0) {
			const sessionState = swarmState.agentSessions.get(sessionID);
			if (sessionState) {
				pushAdvisory(
					sessionState,
					`[FEEDBACK] Skill usage feedback: ${feedbackResult.processed} skills processed, ${feedbackResult.bumps} confidence updates applied.`,
				);
			}
		}
	} catch (skillUsageError) {
		safeWarn(
			'[phase_complete] Skill usage feedback error (non-blocking):',
			skillUsageError,
		);
	}

	try {
		pruneSkillUsageLog(dir, 500);
	} catch (skillPruneError) {
		safeWarn(
			'[phase_complete] Skill usage log pruning error (non-blocking):',
			skillPruneError,
		);
	}

	// Knowledge verdict feedback: bridge applied/violated/ignored events → confidence.
	try {
		const verdictMarkerPath = validateSwarmPath(
			dir,
			'verdict-feedback-last-processed.json',
		);
		let verdictSinceTimestamp: string | undefined;
		let verdictSinceEventId: string | undefined;
		try {
			const markerData = JSON.parse(
				fs.readFileSync(verdictMarkerPath, 'utf-8'),
			);
			verdictSinceTimestamp = markerData.lastProcessedTimestamp;
			verdictSinceEventId = markerData.lastProcessedEventId;
		} catch {
			// marker doesn't exist yet — process all entries
		}

		const { applyKnowledgeVerdictFeedback } = await import(
			'../hooks/knowledge-events.js'
		);
		const verdictResult = await applyKnowledgeVerdictFeedback(dir, {
			sinceTimestamp: verdictSinceTimestamp,
			sinceEventId: verdictSinceEventId,
			floorOptions,
		});

		if (verdictResult.lastProcessedTimestamp) {
			try {
				fs.writeFileSync(
					verdictMarkerPath,
					JSON.stringify({
						lastProcessedTimestamp: verdictResult.lastProcessedTimestamp,
						lastProcessedEventId: verdictResult.lastProcessedEventId,
					}),
					'utf-8',
				);
			} catch {
				// best-effort marker write
			}
		}

		if (verdictResult.bumps > 0) {
			const sessionState = swarmState.agentSessions.get(sessionID);
			if (sessionState) {
				pushAdvisory(
					sessionState,
					`[FEEDBACK] Knowledge verdict feedback: ${verdictResult.processed} entries processed, ${verdictResult.bumps} confidence updates applied.`,
				);
			}
		}
	} catch (verdictError) {
		safeWarn(
			'[phase_complete] Knowledge verdict feedback error (non-blocking):',
			verdictError,
		);
	}

	// All authoritative blockers, including durable participation, were checked
	// twice (before and under the commit lock). Do not re-run gates after the
	// phase transition: a post-commit observation must never turn a committed
	// phase into an apparent failure.
	const agentsMissing = [...(requiredAgentsEntry?.agentsMissing ?? [])];

	// Detect potential auto-repair of retrospective bundle
	// If loaded from a retro-N task ID with schema_version 1.0.0 and valid task_complexity,
	// it may have been auto-repaired from a malformed legacy format
	const VALID_TASK_COMPLEXITY = ['trivial', 'simple', 'moderate', 'complex'];
	const firstEntry = acceptedRetro.bundle?.entries?.[0] as
		| { task_complexity?: string }
		| undefined;
	if (
		acceptedRetro.taskId !== primaryRetroTaskId &&
		acceptedRetro.taskId?.startsWith('retro-') &&
		acceptedRetro.bundle?.schema_version === '1.0.0' &&
		firstEntry?.task_complexity &&
		VALID_TASK_COMPLEXITY.includes(firstEntry.task_complexity)
	) {
		warnings.push(
			`Retrospective data for phase ${phase} may have been automatically migrated to current schema format.`,
		);
	}

	const success = true;
	const status: PhaseCompleteResult['status'] =
		agentsMissing.length > 0 ? 'warned' : 'success';
	const safeSummary = summary?.trim().slice(0, 500);
	const message = safeSummary
		? `Phase ${phase} completed: ${safeSummary}`
		: `Phase ${phase} completed`;

	// Declare result early so the ledger-rebuild blocks can set result fields
	// instead of returning early, allowing flow-through to the finalization block
	const result: PhaseCompleteResult = {
		success,
		phase,
		status,
		message,
		agentsDispatched,
		agentsMissing,
		warnings,
		gate_report: preflightReport,
		...(phaseRecoveryGuidance
			? { recovery_guidance: phaseRecoveryGuidance }
			: {}),
	};

	// Plan-free code-change enforcement (issue #1744): when there's no plan.json,
	// the agent-dispatch fallback can't infer from task gates. If reviewer/
	// test_engineer weren't dispatched independently, emit a prominent warning
	// so the gap is visible in phase-complete output and curator reports.
	let hasPlan = false;
	try {
		hasPlan = fs.existsSync(validateSwarmPath(dir, 'plan.json'));
	} catch {
		// Non-blocking — treat as plan-free if path validation fails
	}
	if (
		!hasPlan &&
		!crossSessionResult.agents.has('reviewer') &&
		!crossSessionResult.agents.has('test_engineer')
	) {
		warnings.push(
			`⚠️ Plan-free phase ${phase}: no independent reviewer or test_engineer dispatch detected. ` +
				`Code changes in plan-free sessions should have independent review. ` +
				`Consider dispatching reviewer + test_engineer before completing future plan-free phases.`,
		);
	}
	if (!hasPlan) {
		warnings.push(
			`Warning: failed to update plan.json phase status because no authoritative plan was found; phase ${phase} completed in plan-free mode.`,
		);
	}

	// Record retrieval outcome for shown lessons from this phase, using the
	// REAL outcome. Previously this was hardcoded `true` and ran before `success`
	// was determined — so a failed phase (policy=enforce + missing required
	// agents) could never record a 'failure' outcome, leaving the negative half
	// of the outcome signal dead (G1). Now it runs after `success` is finalized.
	if (
		acceptedRetro.found &&
		acceptedRetro.entry?.lessons_learned &&
		acceptedRetro.entry.lessons_learned.length > 0
	) {
		await updateRetrievalOutcome(dir, `Phase ${phase}`, success).catch(() => {
			// Never throw out of phase-complete on a knowledge-store failure.
		});
	}

	// Regression sweep check: advisory warning if enforce=true and no sweep found
	if (phaseCompleteConfig.regression_sweep?.enforce) {
		try {
			// Get all task IDs for this phase from the plan
			const planPath = validateSwarmPath(dir, 'plan.json');
			const planRaw = fs.readFileSync(planPath, 'utf-8');
			const plan: {
				phases: Array<{
					id: number;
					tasks: Array<{ id: string; status: string }>;
				}>;
			} = JSON.parse(planRaw);
			const targetPhase = plan.phases.find((p) => p.id === phase);
			if (targetPhase) {
				let sweepFound = false;
				for (const task of targetPhase.tasks) {
					const taskEvidenceResult = await loadEvidence(dir, task.id);
					if (taskEvidenceResult.status === 'found') {
						const entries = taskEvidenceResult.bundle.entries ?? [];
						for (const entry of entries) {
							if (
								(entry as Record<string, unknown>).regression_sweep !==
								undefined
							) {
								sweepFound = true;
								break;
							}
						}
					}
					if (sweepFound) break;
				}
				if (!sweepFound) {
					warnings.push(
						`Warning: regression_sweep.enforce=true but no regression-sweep result found for any task in phase ${phase}. Run tests to populate regression-sweep results.`,
					);
				}
			}
		} catch {
			// Non-blocking — skip check if plan.json or evidence is inaccessible
		}
	}

	// Record timing
	const now = Date.now();
	const durationMs = now - phaseReferenceTimestamp;

	// Write event to .swarm/events.jsonl
	const event: PhaseCompleteEvent = {
		event: 'phase_complete',
		phase,
		timestamp: new Date(now).toISOString(),
		agents_dispatched: agentsDispatched,
		agents_missing: agentsMissing,
		status,
		summary: safeSummary ?? null,
	};

	try {
		appendCoreEventSync(dir, { ...event });
	} catch (writeError) {
		warnings.push(
			`Warning: failed to write phase complete event: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
		);
	}

	// Reset phase state on success
	if (success) {
		// Scheduled skill consolidation: opportunistic and explicitly non-blocking.
		// It may call an LLM and write proposal files, so only launch it after the
		// phase gates have accepted completion.
		try {
			const skillConfig = SkillImproverConfigSchema.parse(
				config.skill_improver ?? {},
			);
			if (skillConfig.enabled && skillConfig.trigger === 'scheduled') {
				runSkillConsolidationFireAndForget(
					{
						directory: dir,
						config: skillConfig,
						source: 'phase_complete',
						sessionId: sessionID,
						enrichmentQuota: {
							maxCalls: knowledgeConfig.enrichment.max_calls_per_day,
							window: knowledgeConfig.enrichment.quota_window,
						},
						evaluateDrafts: true,
					},
					(consolidationResult) => {
						if (!consolidationResult.started) return;
						const sessionState = swarmState.agentSessions.get(sessionID);
						if (!sessionState) return;
						// Derive the activation suffix from the critic-gated auto-apply
						// outcome rather than hardcoding "auto-activated no skills" — the
						// run may legitimately have activated approved proposals.
						const activatedSlugs =
							consolidationResult.result?.autoApply?.approved ?? [];
						const activationSuffix =
							activatedSlugs.length > 0
								? ` and auto-activated ${activatedSlugs.length} skill(s): ${activatedSlugs.join(', ')}.`
								: ' and auto-activated no skills.';
						pushAdvisory(
							sessionState,
							`[SKILL CONSOLIDATION] Scheduled skill_improver consolidation wrote ${consolidationResult.result?.proposalPath ?? 'a proposal'}${activationSuffix}`,
						);
					},
					(err) => {
						safeWarn(
							'[phase_complete] Scheduled skill consolidation error (non-blocking):',
							err,
						);
					},
				);
			}
		} catch (skillConsolidationError) {
			safeWarn(
				'[phase_complete] Scheduled skill consolidation setup error (non-blocking):',
				skillConsolidationError,
			);
		}

		// Memory consolidation (issue #1464): distill the phase's episodic memory
		// into durable semantic facts. Opportunistic, gated by memory config, and
		// explicitly non-blocking — it may call an LLM and write memory records.
		try {
			const memoryConfig = config.memory;
			if (memoryConfig?.enabled && memoryConfig.consolidation?.enabled) {
				runMemoryConsolidationFireAndForget(
					{
						directory: dir,
						config: memoryConfig,
						phase,
						sessionId: sessionID,
					},
					undefined,
					(err) => {
						safeWarn(
							'[phase_complete] Memory consolidation error (non-blocking):',
							err,
						);
					},
				);
			}
		} catch (memoryConsolidationError) {
			safeWarn(
				'[phase_complete] Memory consolidation setup error (non-blocking):',
				memoryConsolidationError,
			);
		}

		// Reset phase-tracking state for all contributor sessions
		for (const contributorSessionId of crossSessionResult.contributorSessionIds) {
			const contributorSession =
				swarmState.agentSessions.get(contributorSessionId);
			if (contributorSession) {
				// Only snapshot agents if there are any new agents to persist (prevents empty overwrite on repeated calls)
				if (contributorSession.phaseAgentsDispatched.size > 0) {
					contributorSession.lastCompletedPhaseAgentsDispatched = new Set(
						contributorSession.phaseAgentsDispatched,
					);
				}
				contributorSession.phaseAgentsDispatched = new Set();
				contributorSession.fullAutoInteractionCount = 0;
				contributorSession.fullAutoDeadlockCount = 0;
				contributorSession.fullAutoLastQuestionHash = null;
				contributorSession.lastPhaseCompleteTimestamp = now;
				const oldPhase = contributorSession.lastPhaseCompletePhase;
				contributorSession.lastPhaseCompletePhase = phase;
				telemetry.phaseChanged(contributorSessionId, oldPhase ?? 0, phase);
			}
		}

		// Knowledge decay sweep: runs on EVERY successful phase completion.
		// Note: sweep fires regardless of drift-verifier (when no spec.md exists,
		// drift is advisory-only and sweep still runs). Reuses the knowledgeConfig
		// parsed earlier in this tool (see above near line 675).
		try {
			if (knowledgeConfig.sweep_enabled) {
				const swarmPath = resolveSwarmKnowledgePath(dir);
				await sweepAgedEntries<KnowledgeEntryBase>(
					swarmPath,
					knowledgeConfig.default_max_phases,
				);
				await sweepStaleTodos<KnowledgeEntryBase>(
					swarmPath,
					knowledgeConfig.todo_max_phases,
				);

				// Hive sweep. Directory lock in both sweep functions prevents concurrent
				// appends from racing. Non-promoted hive entries may age N× faster under
				// N concurrent projects, but this is acceptable: (a) hive entries are
				// 100% promoted by design (hive-promoter.ts:436/511), and (b) non-promoted
				// entries should age out anyway.
				if (knowledgeConfig.hive_enabled) {
					const hivePath = resolveHiveKnowledgePath();
					await sweepAgedEntries<KnowledgeEntryBase>(
						hivePath,
						knowledgeConfig.default_max_phases,
					);
					await sweepStaleTodos<KnowledgeEntryBase>(
						hivePath,
						knowledgeConfig.todo_max_phases,
					);
				}
			}
		} catch (err) {
			// Never block phase completion on a sweep failure. Log and continue.
			let detail = String(err);
			if (detail.includes('ELOCKED')) {
				detail = 'lock timeout (stale lock detected)';
			} else if (detail.includes('ENOSPC')) {
				detail = 'disk full';
			} else if (detail.includes('EACCES')) {
				detail = 'permission denied';
			}
			warnings.push(`Knowledge sweep failed for phase ${phase}: ${detail}`);
		}
	}

	if (complianceWarnings.length > 0) {
		warnings.push(`Curator compliance: ${complianceWarnings.join('; ')}`);
	}

	// v6.33.1: Flush debounced snapshot on phase-complete
	await flushPendingSnapshot(dir);

	// Write root-level checkpoint artifact (non-blocking)
	await writeCheckpoint(dir).catch(() => {});

	// Auto-fire post-mortem when all plan phases are now complete (WP7, #1234).
	// Fail-open: post-mortem failures never affect phase_complete result.
	try {
		const curatorCfg = CuratorConfigSchema.parse(config.curator ?? {});
		if (curatorCfg.enabled && curatorCfg.postmortem_enabled) {
			const finalPlan = await loadPlan(dir);
			if (finalPlan?.phases?.length) {
				const allComplete = finalPlan.phases.every(
					(p: { status?: string }) => p.status === 'complete',
				);
				if (allComplete) {
					const { runCuratorPostMortem } = await import(
						'../hooks/curator-postmortem.js'
					);
					const pmResult = await runCuratorPostMortem(dir, {
						llmDelegate: createCuratorLLMDelegate(dir, 'postmortem', sessionID),
						scope: 'project',
						sessionID,
					});
					if (pmResult.success && pmResult.summary) {
						warnings.push(`[POST-MORTEM] ${pmResult.summary}`);
					}
					if (pmResult.warnings.length > 0) {
						for (const w of pmResult.warnings) {
							warnings.push(`[POST-MORTEM] ${w}`);
						}
					}
				}
			}
		}
	} catch {
		// fail-open: post-mortem never blocks phase completion
	}

	const outputData = {
		...result,
		timestamp: event.timestamp,
		duration_ms: durationMs,
	};
	return _buildOutputJson(outputData);
}

/** @internal exported for testing only */
export function _buildOutputJson(outputData: {
	phase: number;
	success: boolean;
	status: string;
	message?: string;
	agentsDispatched?: string[];
	agentsMissing?: string[];
	warnings?: string[];
	timestamp: string;
	duration_ms: number;
	[key: string]: unknown;
}): string {
	let json = JSON.stringify(outputData, null, 2);
	if (json.length > MAX_OUTPUT_BYTES) {
		const truncated = {
			_truncated: true,
			_truncation_reason: `Output exceeded MAX_OUTPUT_BYTES (${MAX_OUTPUT_BYTES}) limit`,
			phase: outputData.phase,
			success: outputData.success,
			status: outputData.status,
			message: outputData.message,
			agentsDispatched: outputData.agentsDispatched?.slice(0, 10),
			agentsMissing: outputData.agentsMissing?.slice(0, 10),
			warnings: ['(output truncated — full output exceeded size limit)'],
			timestamp: outputData.timestamp,
			duration_ms: outputData.duration_ms,
		};
		json = JSON.stringify(truncated, null, 2);
	}
	return json;
}

/**
 * Tool definition for phase_complete
 */
export function createPhaseCompleteTool(
	runtime: PhaseCompleteRuntime = {},
): ToolDefinition {
	return createSwarmTool({
		description:
			'Mark a phase as complete and track which agents were dispatched. ' +
			'Used for phase completion gating and tracking. ' +
			'Accepts phase number and optional summary. Returns list of agents that were dispatched.',
		args: {
			phase: z
				.number()
				.int()
				.min(1)
				.describe(
					'The phase number being completed — a positive integer (e.g., 1, 2, 3)',
				),
			summary: z
				.string()
				.optional()
				.describe('Optional summary of what was accomplished in this phase'),
			sessionID: z
				.string()
				.optional()
				.describe(
					'Session ID for tracking state (auto-provided by plugin context)',
				),
			working_directory: z
				.string()
				.optional()
				.describe(
					'Explicit project root directory. When provided, .swarm/ is resolved relative to this path instead of the plugin context directory. Use this when CWD differs from the actual project root.',
				),
			accept_violations: z
				.array(z.string())
				.optional()
				.describe(
					'DEPRECATED COMPATIBILITY INPUT. phase_complete never records directive overrides. When supplied, it fails closed with recovery instructions for the architect-only record_directive_override action.',
				),
			accept_violations_justification: z
				.string()
				.optional()
				.describe(
					'Written justification retained only for deprecated compatibility input; use it with record_directive_override instead.',
				),
		},
		execute: async (args, directory, ctx) => {
			// Parse and validate arguments
			let phaseCompleteArgs: PhaseCompleteArgs;
			let workingDirInput: string | undefined;

			try {
				phaseCompleteArgs = {
					phase: Number(args.phase),
					summary:
						args.summary !== undefined ? String(args.summary) : undefined,
					sessionID:
						ctx?.sessionID ??
						(args.sessionID !== undefined ? String(args.sessionID) : undefined),
					acceptViolations: Array.isArray(args.accept_violations)
						? (args.accept_violations as unknown[]).map((s) => String(s))
						: undefined,
					acceptViolationsJustification:
						args.accept_violations_justification !== undefined
							? String(args.accept_violations_justification)
							: undefined,
					// Caller identity for the architect-only override gate.
					callerAgent: ctx?.agent !== undefined ? String(ctx.agent) : undefined,
				};
				workingDirInput =
					args.working_directory !== undefined
						? String(args.working_directory)
						: undefined;
			} catch {
				return JSON.stringify(
					{
						success: false,
						phase: 0,
						message: 'Invalid arguments',
						agentsDispatched: [],
						warnings: ['Failed to parse arguments'],
					},
					null,
					2,
				);
			}

			// Resolve effective directory: explicit working_directory > injected directory
			const dirResult = resolveWorkingDirectory(workingDirInput, directory);
			if (!dirResult.success) {
				return JSON.stringify(
					{
						success: false,
						phase: phaseCompleteArgs.phase,
						message: dirResult.message,
						agentsDispatched: [],
						warnings: [dirResult.message],
					},
					null,
					2,
				);
			}

			return executePhaseComplete(
				phaseCompleteArgs,
				dirResult.directory,
				dirResult.directory,
				runtime,
			);
		},
	});
}

export const phase_complete: ToolDefinition = createPhaseCompleteTool();

export const _test_exports = {
	allCompletedTasksHavePassedGateEvidence,
	resolvePhaseReviewAgentNames,
};
