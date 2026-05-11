/**
 * Phase completion tool for tracking and validating phase completion.
 * Core implementation - gathers data, enforces policy, writes event, resets state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import type { EvidenceBundle } from '../config/evidence-schema';
import {
	CuratorConfigSchema,
	KnowledgeConfigSchema,
	type PhaseCompleteConfig,
	PhaseCompleteConfigSchema,
	stripKnownSwarmPrefix,
} from '../config/schema';
import { getEffectiveGates, getProfile } from '../db/qa-gate-profile.js';
import { listEvidenceTaskIds, loadEvidence } from '../evidence/manager';
import { verifyFullAutoPhaseApproval } from '../full-auto/phase-approval';
import {
	applyCuratorKnowledgeUpdates,
	runCuratorPhase,
} from '../hooks/curator';
import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory.js';
import { curateAndStoreSwarm } from '../hooks/knowledge-curator.js';
import { updateRetrievalOutcome } from '../hooks/knowledge-reader.js';
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
	buildApprovedReceipt,
	buildRejectedReceipt,
	persistReviewReceipt,
} from '../hooks/review-receipt.js';
import { validateSwarmPath } from '../hooks/utils';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { writeCheckpoint } from '../plan/checkpoint';
import {
	ledgerExists,
	replayFromLedger,
	takeSnapshotEvent,
} from '../plan/ledger';
import { loadPlan, savePlan } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { flushPendingSnapshot } from '../session/snapshot-writer';
import {
	ensureAgentSession,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	swarmState,
} from '../state';
import { telemetry } from '../telemetry';
import { _internals as leanPhaseInternals } from '../turbo/lean/phase-ready';
import { executeCompletionVerify } from './completion-verify';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

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
	phase_council_required?: boolean;
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
		console.warn(
			message,
			error instanceof Error ? error.message : String(error),
		);
	} catch {
		// Ignore logger failures to keep phase_complete non-blocking
	}
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

		// Collect agents from caller's delegation chains
		const callerDelegations = swarmState.delegationChains.get(callerSessionId);
		if (callerDelegations) {
			for (const delegation of callerDelegations) {
				agents.add(stripKnownSwarmPrefix(delegation.from));
				agents.add(stripKnownSwarmPrefix(delegation.to));
			}
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

			// Collect agents from this session's delegation chains
			const delegations = swarmState.delegationChains.get(sessionId);
			if (delegations) {
				for (const delegation of delegations) {
					agents.add(stripKnownSwarmPrefix(delegation.from));
					agents.add(stripKnownSwarmPrefix(delegation.to));
				}
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
		(entry as { verdict?: unknown }).verdict === 'pass'
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
		return JSON.stringify(
			{
				success: true,
				phase,
				status: 'disabled',
				message: `Phase ${phase} complete (enforcement disabled)`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [],
			},
			null,
			2,
		);
	}

	// Retrospective gate: require a valid retro bundle for this phase
	const retroResult = await loadEvidence(dir, `retro-${phase}`);
	let retroFound = false;
	let retroEntry: { lessons_learned?: string[] } | null = null;
	let invalidSchemaErrors: string[] = [];
	let loadedRetroTaskId: string | null = null;
	let loadedRetroBundle: EvidenceBundle | null = null;

	// Track the task ID that was used to load the retro bundle
	const primaryRetroTaskId = `retro-${phase}`;

	if (retroResult.status === 'found') {
		const validEntry = retroResult.bundle.entries?.find((entry) =>
			isValidRetroEntry(entry, phase),
		);
		if (validEntry) {
			retroFound = true;
			retroEntry = validEntry as { lessons_learned?: string[] } | null;
			loadedRetroTaskId = primaryRetroTaskId;
			loadedRetroBundle = retroResult.bundle;
		}
	} else if (retroResult.status === 'invalid_schema') {
		invalidSchemaErrors = retroResult.errors;
	}

	if (!retroFound) {
		// Fallback: scan all task IDs for any retro-N matching this phase
		const allTaskIds = await listEvidenceTaskIds(dir);
		const retroTaskIds = allTaskIds.filter(
			(id) => id.startsWith('retro-') && /^retro-\d+$/.test(id),
		);
		for (const taskId of retroTaskIds) {
			const bundleResult = await loadEvidence(dir, taskId);
			if (bundleResult.status !== 'found') {
				if (bundleResult.status === 'invalid_schema') {
					invalidSchemaErrors.push(...bundleResult.errors);
				}
				continue;
			}
			const validEntry = bundleResult.bundle.entries?.find((entry) =>
				isValidRetroEntry(entry, phase),
			);
			if (validEntry) {
				retroFound = true;
				retroEntry = validEntry as { lessons_learned?: string[] } | null;
				loadedRetroTaskId = taskId;
				loadedRetroBundle = bundleResult.bundle;
				break;
			}
		}
	}

	if (!retroFound) {
		const schemaErrorDetail =
			invalidSchemaErrors.length > 0
				? ` Schema validation failed: ${invalidSchemaErrors.join('; ')}.`
				: '';
		return JSON.stringify(
			{
				success: false,
				phase,
				status: 'blocked' as const,
				reason: 'RETROSPECTIVE_MISSING',
				message: `Phase ${phase} cannot be completed: no valid retrospective evidence found.${schemaErrorDetail} Write a retrospective bundle at .swarm/evidence/retro-${phase}/evidence.json before calling phase_complete.`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [
					`Retrospective missing for phase ${phase}.${schemaErrorDetail} Use this template:`,
					JSON.stringify(
						{
							schema_version: '1.0.0',
							task_id: `retro-${phase}`,
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
							entries: [
								{
									task_id: `retro-${phase}`,
									type: 'retrospective',
									timestamp: new Date().toISOString(),
									agent: 'architect',
									verdict: 'pass',
									summary: `Phase ${phase} completed.`,
									phase_number: phase,
									total_tool_calls: 0,
									coder_revisions: 0,
									reviewer_rejections: 0,
									test_failures: 0,
									security_findings: 0,
									integration_issues: 0,
									task_count: 1,
									task_complexity: 'simple',
									top_rejection_reasons: [],
									lessons_learned: [],
								},
							],
						},
						null,
						2,
					),
				],
			},
			null,
			2,
		);
	}

	// Turbo mode: skip completion-verify, drift-verifier, and hallucination-guard gates
	if (hasActiveTurboMode(sessionID)) {
		// Non-blocking warning so architect knows gates were bypassed
		console.warn(
			`[phase_complete] Turbo mode active — skipping completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council, and final-council gates for phase ${phase}`,
		);
	} else {
		// Gate 1: Completion Verify (deterministic, in-process)
		try {
			const completionResultRaw = await executeCompletionVerify({ phase }, dir);
			const completionResult = JSON.parse(completionResultRaw);
			if (completionResult.status === 'blocked') {
				return JSON.stringify(
					{
						success: false,
						phase,
						status: 'blocked' as const,
						reason: 'COMPLETION_INCOMPLETE',
						message: `Phase ${phase} cannot be completed: ${completionResult.reason}`,
						agentsDispatched,
						agentsMissing: [],
						warnings: completionResult.blockedTasks
							? [
									`Blocked tasks: ${completionResult.blockedTasks.map((t: { task_id: string }) => t.task_id).join(', ')}`,
								]
							: [],
					},
					null,
					2,
				);
			}
		} catch (completionError) {
			// Non-blocking — treat as warning and continue
			safeWarn(
				`[phase_complete] Completion verify error (non-blocking):`,
				completionError,
			);
		}

		// Gate 2: Drift Verifier (conditional on drift_check QA gate)
		// Load QA gate profile to check drift_check flag
		let driftCheckEnabled = true; // Default: preserve current mandatory behavior
		let driftHasSpecMd = false;
		try {
			const specMdPath = path.join(dir, '.swarm', 'spec.md');
			driftHasSpecMd = fs.existsSync(specMdPath);

			const gatePlan = await loadPlan(dir);
			if (gatePlan) {
				const gatePlanId = derivePlanId(gatePlan);
				const gateProfile = getProfile(dir, gatePlanId);
				if (gateProfile) {
					const gateSession = sessionID
						? swarmState.agentSessions.get(sessionID)
						: undefined;
					const gateOverrides = gateSession?.qaGateSessionOverrides ?? {};
					const gateEffective = getEffectiveGates(gateProfile, gateOverrides);
					driftCheckEnabled = gateEffective.drift_check === true;
				}
				// No profile → driftCheckEnabled stays true (DEFAULT_QA_GATES fallback)
			}
		} catch (gateLoadError) {
			// Profile load failure — preserve current mandatory behavior (safe default)
			safeWarn(
				`[phase_complete] QA gate profile load error, drift_check defaults to enabled:`,
				gateLoadError,
			);
		}

		if (!driftCheckEnabled) {
			// drift_check gate disabled — skip drift verification entirely
			console.info(
				`[phase_complete] drift_check disabled — skipping drift verification gate for phase ${phase}`,
			);
			warnings.push(
				`drift_check gate is disabled. Drift verification was skipped for phase ${phase}.`,
			);
		} else {
			// drift_check enabled — run drift verification
			// First: check phase type annotation — non-code phases skip entirely
			let phaseType: string | undefined;
			try {
				const planPath = path.join(dir, '.swarm', 'plan.json');
				if (fs.existsSync(planPath)) {
					const planRaw = fs.readFileSync(planPath, 'utf-8');
					const plan = JSON.parse(planRaw);
					const targetPhase = plan.phases?.find(
						(p: { id: number }) => p.id === phase,
					);
					phaseType = targetPhase?.type;
				}
			} catch {
				// plan.json missing or unreadable — phaseType stays undefined
			}

			if (phaseType === 'non-code') {
				// Phase annotated as non-code — drift check not required, skip entirely
				console.info(
					`[phase_complete] Phase ${phase} annotated as 'non-code' — drift verification skipped.`,
				);
				warnings.push(
					`Phase ${phase} is annotated as 'non-code'. Drift verification was skipped per phase type annotation.`,
				);
			} else {
				// Code phase — proceed with drift evidence checking
				try {
					// Check for evidence at .swarm/evidence/{phase}/drift-verifier.json
					const driftEvidencePath = path.join(
						dir,
						'.swarm',
						'evidence',
						String(phase),
						'drift-verifier.json',
					);
					let driftVerdictFound = false;
					let driftVerdictApproved = false;

					try {
						const driftEvidenceContent = fs.readFileSync(
							driftEvidencePath,
							'utf-8',
						);
						const driftEvidence = JSON.parse(driftEvidenceContent);
						const entries = driftEvidence.entries ?? [];
						for (const entry of entries) {
							if (
								typeof entry.type === 'string' &&
								entry.type.includes('drift') &&
								typeof entry.verdict === 'string'
							) {
								driftVerdictFound = true;
								if (entry.verdict === 'approved') {
									driftVerdictApproved = true;
								}
								// Check if summary indicates needs_revision
								if (
									entry.verdict === 'rejected' ||
									(typeof entry.summary === 'string' &&
										entry.summary.includes('NEEDS_REVISION'))
								) {
									return JSON.stringify(
										{
											success: false,
											phase,
											status: 'blocked' as const,
											reason: 'DRIFT_VERIFICATION_REJECTED',
											message: `Phase ${phase} cannot be completed: drift verifier returned verdict '${entry.verdict}'. Address the drift issues before completing the phase.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										},
										null,
										2,
									);
								}
							}
						}
					} catch (readError) {
						// File doesn't exist or is invalid JSON
						if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
							safeWarn(
								`[phase_complete] Drift verifier evidence unreadable:`,
								readError,
							);
						}
						// Treat as missing — fall through to blocked check below
						driftVerdictFound = false;
					}

					if (!driftVerdictFound) {
						if (!driftHasSpecMd) {
							// No spec.md — drift verification is advisory-only
							// Check task completion status for advisory message quality
							let incompleteTaskCount = 0;
							let planParseable = false;
							try {
								const planPath = path.join(dir, '.swarm', 'plan.json');
								if (fs.existsSync(planPath)) {
									const planRaw = fs.readFileSync(planPath, 'utf-8');
									const plan = JSON.parse(planRaw);
									planParseable = true;
									const planPhase = plan.phases?.find(
										(p: { id: number }) => p.id === phase,
									);
									if (planPhase?.tasks) {
										incompleteTaskCount = planPhase.tasks.filter(
											(t: { status?: string }) =>
												t.status !== 'completed' && t.status !== 'closed',
										).length;
									}
								}
							} catch {
								// plan.json unreadable or malformed — planParseable stays false
							}

							if (!planParseable) {
								// plan.json missing or malformed — can't determine task status, suggest verifier
								warnings.push(
									`No spec.md found and drift verification evidence missing — consider running critic_drift_verifier before phase completion.`,
								);
							} else if (incompleteTaskCount > 0) {
								warnings.push(
									`No spec.md found and drift verification evidence missing. Phase ${phase} has ${incompleteTaskCount} incomplete task(s) in plan.json — consider running critic_drift_verifier before phase completion.`,
								);
							} else {
								warnings.push(
									`No spec.md found. Phase ${phase} tasks are all completed in plan.json. Drift verification was skipped.`,
								);
							}
						} else {
							// spec.md exists AND drift evidence missing — hard block
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'DRIFT_VERIFICATION_MISSING',
									message: `Phase ${phase} cannot be completed: drift_check is enabled and drift verifier evidence not found at .swarm/evidence/${phase}/drift-verifier.json. Run drift verification before completing the phase.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}
					}

					if (!driftVerdictApproved && driftVerdictFound) {
						// Drift verdict found but not approved — this shouldn't happen if above checks passed,
						// but treat as rejected for safety
						return JSON.stringify(
							{
								success: false,
								phase,
								status: 'blocked' as const,
								reason: 'DRIFT_VERIFICATION_REJECTED',
								message: `Phase ${phase} cannot be completed: drift verifier verdict is not approved.`,
								agentsDispatched,
								agentsMissing: [],
								warnings: [],
							},
							null,
							2,
						);
					}
				} catch (driftError) {
					// Hard block — drift verification errors prevent phase completion
					return JSON.stringify(
						{
							success: false,
							phase,
							status: 'blocked' as const,
							reason: 'DRIFT_VERIFICATION_ERROR',
							message: `Phase ${phase} cannot be completed: drift verification encountered an error: ${driftError instanceof Error ? driftError.message : String(driftError)}. This is a hard block — resolve the error before completing the phase.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						},
						null,
						2,
					);
				}
			}
		}

		// Gate 3: Hallucination Guard (conditional on QA gate flag)
		try {
			const plan = await loadPlan(dir);
			if (plan) {
				const planId = derivePlanId(plan);
				const profile = getProfile(dir, planId);
				if (profile) {
					const session = sessionID
						? swarmState.agentSessions.get(sessionID)
						: undefined;
					const overrides = session?.qaGateSessionOverrides ?? {};
					const effective = getEffectiveGates(profile, overrides);

					if (effective.hallucination_guard === true) {
						const hgPath = path.join(
							dir,
							'.swarm',
							'evidence',
							String(phase),
							'hallucination-guard.json',
						);
						let hgVerdictFound = false;
						let hgVerdictApproved = false;

						try {
							const hgContent = fs.readFileSync(hgPath, 'utf-8');
							const hgBundle = JSON.parse(hgContent);
							for (const entry of hgBundle.entries ?? []) {
								if (
									typeof entry.type === 'string' &&
									entry.type.includes('hallucination') &&
									typeof entry.verdict === 'string'
								) {
									hgVerdictFound = true;
									if (entry.verdict === 'approved') {
										hgVerdictApproved = true;
									}
									if (
										entry.verdict === 'rejected' ||
										(typeof entry.summary === 'string' &&
											entry.summary.includes('NEEDS_REVISION'))
									) {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'HALLUCINATION_VERIFICATION_REJECTED',
												message: `Phase ${phase} cannot be completed: hallucination verifier returned verdict '${entry.verdict}'. Remove fabricated APIs/signatures and fix broken citations before completing the phase.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}
								}
							}
						} catch (readErr) {
							if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
								safeWarn(
									`[phase_complete] Hallucination guard evidence unreadable:`,
									readErr,
								);
							}
							hgVerdictFound = false;
						}

						if (!hgVerdictFound) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'HALLUCINATION_VERIFICATION_MISSING',
									message: `Phase ${phase} cannot be completed: hallucination_guard is enabled and evidence not found at .swarm/evidence/${phase}/hallucination-guard.json. Delegate to critic_hallucination_verifier and call write_hallucination_evidence before completing the phase.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}

						if (!hgVerdictApproved) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'HALLUCINATION_VERIFICATION_REJECTED',
									message: `Phase ${phase} cannot be completed: hallucination verifier verdict is not approved.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}
					}
				}
			}
		} catch (hgError) {
			// Non-blocking — treat as warning and continue
			safeWarn(
				`[phase_complete] Hallucination guard error (non-blocking):`,
				hgError,
			);
		}

		// Gate 4: Mutation Gate (conditional on QA gate flag)
		try {
			const plan = await loadPlan(dir);
			if (plan) {
				const planId = derivePlanId(plan);
				const profile = getProfile(dir, planId);
				if (profile) {
					const session = sessionID
						? swarmState.agentSessions.get(sessionID)
						: undefined;
					const overrides = session?.qaGateSessionOverrides ?? {};
					const effective = getEffectiveGates(profile, overrides);

					if (effective.mutation_test === true) {
						const mgPath = path.join(
							dir,
							'.swarm',
							'evidence',
							String(phase),
							'mutation-gate.json',
						);
						let mgVerdictFound = false;
						let mgVerdict: string | undefined;

						try {
							const mgContent = fs.readFileSync(mgPath, 'utf-8');
							const mgBundle = JSON.parse(mgContent);
							for (const entry of mgBundle.entries ?? []) {
								if (
									typeof entry.type === 'string' &&
									entry.type === 'mutation-gate' &&
									typeof entry.verdict === 'string'
								) {
									mgVerdictFound = true;
									mgVerdict = entry.verdict;
									if (entry.verdict === 'fail') {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'MUTATION_GATE_FAIL',
												message: `Phase ${phase} cannot be completed: mutation gate returned verdict 'fail'. Resolve surviving mutants or lower the kill-rate threshold before completing the phase.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									} else if (
										!['pass', 'warn', 'skip'].includes(entry.verdict)
									) {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'MUTATION_GATE_FAIL',
												message: `Phase ${phase} cannot be completed: mutation gate evidence contains unrecognized verdict '${entry.verdict}'. Expected one of: pass, warn, fail, skip.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}
								}
							}
						} catch (readErr) {
							if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
								safeWarn(
									`[phase_complete] Mutation gate evidence unreadable:`,
									readErr,
								);
							}
							mgVerdictFound = false;
						}

						if (!mgVerdictFound) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'MUTATION_GATE_MISSING',
									message: `Phase ${phase} cannot be completed: mutation_test is enabled and evidence not found at .swarm/evidence/${phase}/mutation-gate.json. Run mutation_test, then call write_mutation_evidence before completing the phase.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}

						if (mgVerdict === 'warn') {
							safeWarn(
								`[phase_complete] Mutation gate verdict is 'warn' for phase ${phase} — proceeding with warning`,
								undefined,
							);
						}
					}
				}
			}
		} catch (mgError) {
			// Non-blocking — treat as warning and continue
			safeWarn(`[phase_complete] Mutation gate error (non-blocking):`, mgError);
		}

		// Gate 5: Phase Council (conditional on council_mode QA gate flag)
		let councilModeEnabled = false;
		try {
			const plan = await loadPlan(dir);
			if (plan) {
				const planId = derivePlanId(plan);
				const profile = getProfile(dir, planId);
				if (profile) {
					const session = sessionID
						? swarmState.agentSessions.get(sessionID)
						: undefined;
					const overrides = session?.qaGateSessionOverrides ?? {};
					const effective = getEffectiveGates(profile, overrides);

					if (effective.council_mode === true) {
						councilModeEnabled = true;
						const pcPath = path.join(
							dir,
							'.swarm',
							'evidence',
							String(phase),
							'phase-council.json',
						);
						let pcVerdictFound = false;
						let _pcVerdict: string | undefined;
						let pcQuorumSize: number | undefined;
						let pcTimestamp: string | undefined;
						let pcPhaseNumber: number | undefined;

						try {
							const pcContent = fs.readFileSync(pcPath, 'utf-8');
							const pcBundle = JSON.parse(pcContent);
							for (const entry of pcBundle.entries ?? []) {
								if (
									typeof entry.type === 'string' &&
									entry.type === 'phase-council' &&
									typeof entry.verdict === 'string'
								) {
									pcVerdictFound = true;
									_pcVerdict = entry.verdict;
									pcQuorumSize =
										typeof entry.quorumSize === 'number'
											? entry.quorumSize
											: undefined;
									pcTimestamp =
										typeof entry.timestamp === 'string'
											? entry.timestamp
											: undefined;
									pcPhaseNumber =
										typeof entry.phase_number === 'number'
											? entry.phase_number
											: typeof entry.phase === 'number'
												? entry.phase
												: undefined;

									// Validate timestamp freshness (must be within last 24 hours and not in the future)
									const now = new Date();
									const pcTime = pcTimestamp ? new Date(pcTimestamp) : null;
									if (!pcTime || Number.isNaN(pcTime.getTime())) {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'PHASE_COUNCIL_INVALID_TIMESTAMP',
												message: `Phase ${phase} cannot be completed: phase council evidence has missing or invalid timestamp.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}
									const maxAge = 24 * 60 * 60 * 1000; // 24 hours
									if (pcTime.getTime() > now.getTime()) {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'PHASE_COUNCIL_FUTURE_TIMESTAMP',
												message: `Phase ${phase} cannot be completed: phase council evidence timestamp is in the future.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}
									if (now.getTime() - pcTime.getTime() > maxAge) {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'PHASE_COUNCIL_STALE_EVIDENCE',
												message: `Phase ${phase} cannot be completed: phase council evidence is older than 24 hours. Re-convene council for fresh review.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}

									if (
										entry.verdict === 'REJECT' ||
										entry.verdict === 'reject'
									) {
										const requiredFixes =
											entry.requiredFixes ?? entry.required_fixes ?? [];
										const fixesDetail =
											Array.isArray(requiredFixes) && requiredFixes.length > 0
												? `\nRequired fixes: ${requiredFixes.map((f: { detail?: string; location?: string }) => f.detail ?? JSON.stringify(f)).join('; ')}`
												: '';

										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'PHASE_COUNCIL_REJECTED',
												message: `Phase ${phase} cannot be completed: phase council returned verdict 'REJECT'. Address the required fixes before completing the phase.${fixesDetail}`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}

									if (
										entry.verdict === 'CONCERNS' ||
										entry.verdict === 'concerns'
									) {
										const phaseConcernsAllow =
											config.council?.phaseConcernsAllowComplete ?? true;

										if (!phaseConcernsAllow) {
											const advisoryNotes =
												entry.advisoryNotes ?? entry.advisory_notes ?? [];
											const notesDetail =
												Array.isArray(advisoryNotes) && advisoryNotes.length > 0
													? `\nAdvisory notes: ${advisoryNotes.join('; ')}`
													: '';

											return JSON.stringify(
												{
													success: false,
													phase,
													status: 'blocked' as const,
													reason: 'PHASE_COUNCIL_CONCERNS',
													message: `Phase ${phase} cannot be completed: phase council returned verdict 'CONCERNS'.${notesDetail}`,
													agentsDispatched,
													agentsMissing: [],
													warnings: [],
												},
												null,
												2,
											);
										}
										// If concerns-pass is allowed, warn and continue
										safeWarn(
											`[phase_complete] Phase council returned CONCERNS for phase ${phase} — proceeding (phaseConcernsAllowComplete is enabled)`,
											undefined,
										);
									}

									if (
										entry.verdict !== 'APPROVE' &&
										entry.verdict !== 'approve' &&
										entry.verdict !== 'CONCERNS' &&
										entry.verdict !== 'concerns'
									) {
										return JSON.stringify(
											{
												success: false,
												phase,
												status: 'blocked' as const,
												reason: 'PHASE_COUNCIL_INVALID',
												message: `Phase ${phase} cannot be completed: phase council evidence contains unrecognized verdict '${entry.verdict}'. Expected one of: APPROVE, CONCERNS, REJECT.`,
												agentsDispatched,
												agentsMissing: [],
												warnings: [],
											},
											null,
											2,
										);
									}
								}
							}
						} catch (readErr) {
							if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
								safeWarn(
									`[phase_complete] Phase council evidence unreadable:`,
									readErr,
								);
							}
							pcVerdictFound = false;
						}

						if (!pcVerdictFound) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'PHASE_COUNCIL_REQUIRED',
									phase_council_required: true,
									message: `Phase ${phase} cannot be completed: council_mode is enabled and phase council evidence not found at .swarm/evidence/${phase}/phase-council.json. Convene a phase-level council (dispatch 5 members, collect verdicts, call submit_phase_council_verdicts) before completing the phase.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [
										`Phase council required — convene 5 council members (critic, reviewer, sme, test_engineer, explorer) for holistic phase review. Call submit_phase_council_verdicts to synthesize verdicts and write phase-council.json evidence.`,
									],
								},
								null,
								2,
							);
						}

						// Validate quorum (minimum 3)
						if (
							pcQuorumSize === undefined ||
							typeof pcQuorumSize !== 'number'
						) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'PHASE_COUNCIL_MISSING_QUORUM',
									message: `Phase ${phase} cannot be completed: phase council evidence is missing quorumSize field.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}
						if (pcQuorumSize < 3) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'PHASE_COUNCIL_INSUFFICIENT_QUORUM',
									message: `Phase ${phase} cannot be completed: phase council quorum (${pcQuorumSize}) is below minimum (3). Re-convene council with sufficient members.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}

						// Validate phase number matches
						if (
							pcPhaseNumber === undefined ||
							typeof pcPhaseNumber !== 'number'
						) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'PHASE_COUNCIL_MISSING_PHASE',
									message: `Phase ${phase} cannot be completed: phase council evidence is missing phase_number field.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}
						if (pcPhaseNumber !== phase) {
							return JSON.stringify(
								{
									success: false,
									phase,
									status: 'blocked' as const,
									reason: 'PHASE_COUNCIL_PHASE_MISMATCH',
									message: `Phase ${phase} cannot be completed: phase council evidence is for phase ${pcPhaseNumber}, not phase ${phase}. Run council for the correct phase.`,
									agentsDispatched,
									agentsMissing: [],
									warnings: [],
								},
								null,
								2,
							);
						}
					}
				}
			}
		} catch (pcError) {
			if (councilModeEnabled) {
				// Fail-closed: council gate errors block phase completion
				warnings.push(`PHASE_COUNCIL_ERROR: ${String(pcError)}`);
				return JSON.stringify(
					{
						success: false,
						phase,
						status: 'blocked' as const,
						reason: 'PHASE_COUNCIL_ERROR',
						message: `Phase ${phase} cannot be completed: phase council gate encountered an error when council_mode was enabled. Error: ${String(pcError)}`,
						agentsDispatched,
						agentsMissing: [],
						warnings: [`PHASE_COUNCIL_ERROR: ${String(pcError)}`],
					},
					null,
					2,
				);
			} else {
				// Non-blocking when council_mode is off
				safeWarn(
					`[phase_complete] Phase council gate error (non-blocking):`,
					pcError,
				);
			}
		}
	}

	// Gate 6: Final Council (conditional on final_council QA gate flag)
	// Only fires after the LAST phase completes — not after intermediate phases.
	if (!hasActiveTurboMode(sessionID)) {
		let finalCouncilEnabled = false;
		try {
			const plan = await loadPlan(dir);
			if (plan) {
				const lastPhaseId = plan.phases[plan.phases.length - 1]?.id;
				if (lastPhaseId !== undefined && phase === lastPhaseId) {
					const planId = derivePlanId(plan);
					const profile = getProfile(dir, planId);
					if (profile) {
						const session = sessionID
							? swarmState.agentSessions.get(sessionID)
							: undefined;
						const overrides = session?.qaGateSessionOverrides ?? {};
						const effective = getEffectiveGates(profile, overrides);

						if (effective.final_council === true) {
							finalCouncilEnabled = true;
							const fcPath = path.join(
								dir,
								'.swarm',
								'evidence',
								'final-council.json',
							);
							let fcVerdictFound = false;
							let _fcVerdict: string | undefined;

							try {
								const fcContent = fs.readFileSync(fcPath, 'utf-8');
								const fcBundle = JSON.parse(fcContent);
								for (const entry of fcBundle.entries ?? []) {
									if (
										typeof entry.type === 'string' &&
										entry.type === 'final-council' &&
										typeof entry.verdict === 'string'
									) {
										fcVerdictFound = true;
										_fcVerdict = entry.verdict;

										// Plan ID binding: prevent stale evidence from prior project
										if (plan) {
											const currentPlanId = derivePlanId(plan);
											if (entry.plan_id && entry.plan_id !== currentPlanId) {
												return JSON.stringify(
													{
														success: false,
														phase,
														status: 'blocked' as const,
														reason: 'final_council_plan_mismatch',
														message: `Final council evidence belongs to a different plan (evidence: ${entry.plan_id}, current: ${currentPlanId}). Re-run the final council.`,
														agentsDispatched,
														agentsMissing: [],
														warnings: [],
													},
													null,
													2,
												);
											}
											if (!entry.plan_id) {
												// Fail-closed: evidence without plan_id cannot be trusted
												return JSON.stringify(
													{
														success: false,
														phase,
														status: 'blocked' as const,
														reason: 'FINAL_COUNCIL_PLAN_ID_REQUIRED',
														message: `Phase ${phase} (last phase) cannot be completed: final council evidence is missing plan_id binding. Re-run the final council to generate evidence with plan identity.`,
														agentsDispatched,
														agentsMissing: [],
														warnings: [],
													},
													null,
													2,
												);
											}
										}

										if (
											entry.verdict === 'rejected' ||
											entry.verdict === 'REJECTED'
										) {
											return JSON.stringify(
												{
													success: false,
													phase,
													status: 'blocked' as const,
													reason: 'FINAL_COUNCIL_REJECTED',
													message: `Phase ${phase} (last phase) cannot be completed: final council returned verdict 'REJECTED'. Address the required fixes before completing the project.`,
													agentsDispatched,
													agentsMissing: [],
													warnings: [],
												},
												null,
												2,
											);
										}

										if (
											entry.verdict !== 'approved' &&
											entry.verdict !== 'APPROVED'
										) {
											return JSON.stringify(
												{
													success: false,
													phase,
													status: 'blocked' as const,
													reason: 'FINAL_COUNCIL_INVALID_VERDICT',
													message: `Phase ${phase} (last phase) cannot be completed: final council evidence contains unrecognized verdict '${entry.verdict}'. Expected 'approved'.`,
													agentsDispatched,
													agentsMissing: [],
													warnings: [],
												},
												null,
												2,
											);
										}
									}
								}
							} catch (readErr) {
								if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
									safeWarn(
										`[phase_complete] Final council evidence unreadable:`,
										readErr,
									);
								}
								fcVerdictFound = false;
							}

							if (!fcVerdictFound) {
								return JSON.stringify(
									{
										success: false,
										phase,
										status: 'blocked' as const,
										reason: 'FINAL_COUNCIL_REQUIRED',
										final_council_required: true,
										message: `Phase ${phase} (last phase) cannot be completed: final_council is enabled and final council evidence not found at .swarm/evidence/final-council.json. Convene a final holistic council (use convene_general_council with mode 'general') and call write_final_council_evidence to persist the verdict before completing the project.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [
											`Final council required — convene a holistic project review using convene_general_council, then call write_final_council_evidence to persist the verdict.`,
										],
									},
									null,
									2,
								);
							}
						}
					}
				}
			}
		} catch (fcError) {
			if (finalCouncilEnabled) {
				// Fail-closed: final council gate errors block phase completion
				warnings.push(`FINAL_COUNCIL_ERROR: ${String(fcError)}`);
				return JSON.stringify(
					{
						success: false,
						phase,
						status: 'blocked' as const,
						reason: 'FINAL_COUNCIL_ERROR',
						message: `Phase ${phase} (last phase) cannot be completed: final council gate encountered an error. Error: ${String(fcError)}`,
						agentsDispatched,
						agentsMissing: [],
						warnings: [`FINAL_COUNCIL_ERROR: ${String(fcError)}`],
					},
					null,
					2,
				);
			} else {
				safeWarn(
					`[phase_complete] Final council gate error (non-blocking):`,
					fcError,
				);
			}
		}
	}

	// Gate 7: Full-Auto v2 approval (sits OUTSIDE the Turbo bypass on purpose).
	// When Full-Auto v2 is the active autonomy regime, Turbo must NOT bypass
	// the autonomous-oversight approval — fail-closed by default. The gate is
	// a no-op when full_auto.enabled is false or when no durable Full-Auto run
	// is active for this session. Runs after Gate 6 (Final Council) so that
	// last-phase completions are gated by both council approval (when
	// final_council is enabled) AND Full-Auto v2 approval (when active).
	{
		const approval = verifyFullAutoPhaseApproval(dir, sessionID, phase, config);
		if (!approval.ok) {
			return JSON.stringify(
				{
					success: false,
					phase,
					status: 'blocked' as const,
					reason: 'FULL_AUTO_APPROVAL_REQUIRED',
					message: `Phase ${phase} cannot be completed: ${approval.reason ?? 'Full-Auto v2 approval missing'}`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [
						`Full-Auto v2 active. Re-run critic_oversight with trigger_source=phase_boundary so an APPROVED record is written to .swarm/evidence/${phase}/full-auto-*.json before calling phase_complete again.`,
					],
				},
				null,
				2,
			);
		}
	}

	// Lean Turbo phase readiness gate (outside standard Turbo bypass)
	if (hasActiveLeanTurbo(sessionID)) {
		// Extract lean config for phase readiness checks (phase_reviewer, phase_critic, etc.)
		const leanConfig = config?.turbo?.lean;
		const leanPhaseReadyConfig = leanConfig
			? {
					phase_reviewer: leanConfig.phase_reviewer,
					phase_critic: leanConfig.phase_critic,
					integrated_diff_required: leanConfig.integrated_diff_required,
				}
			: undefined;
		const leanCheck = leanPhaseInternals.verifyLeanTurboPhaseReady(
			dir,
			phase,
			sessionID,
			leanPhaseReadyConfig,
		);
		if (!leanCheck.ok) {
			return JSON.stringify(
				{
					success: false,
					phase,
					status: 'blocked' as const,
					reason: 'LEAN_TURBO_PHASE_NOT_READY',
					message: `Phase ${phase} cannot be completed: ${leanCheck.reason}`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [`Lean Turbo phase readiness: ${leanCheck.reason}`],
				},
				null,
				2,
			);
		}
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
		retroFound &&
		retroEntry?.lessons_learned &&
		retroEntry.lessons_learned.length > 0
	) {
		try {
			// Infer project name from directory
			const projectName = path.basename(dir);

			const curationResult = await curateAndStoreSwarm(
				retroEntry.lessons_learned,
				projectName,
				{ phase_number: phase },
				dir,
				knowledgeConfig,
			);
			if (curationResult) {
				const sessionState = swarmState.agentSessions.get(sessionID);
				if (sessionState) {
					sessionState.pendingAdvisoryMessages ??= [];
					sessionState.pendingAdvisoryMessages.push(
						`[CURATOR] Knowledge curation: ${curationResult.stored} stored, ${curationResult.skipped} skipped, ${curationResult.rejected} rejected.`,
					);
				}
			}

			// Record retrieval outcome: mark shown lessons from this phase as applied.
			// Phase completed successfully at this point — lessons applied = positive signal.
			await updateRetrievalOutcome(dir, `Phase ${phase}`, true);
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
			// Advisory injection: push actionable curator message to architect session
			const callerSessionState = swarmState.agentSessions.get(sessionID);
			if (callerSessionState) {
				callerSessionState.pendingAdvisoryMessages ??= [];

				const digestSummary = curatorResult.digest?.summary
					? curatorResult.digest.summary.slice(0, 200)
					: 'Phase analysis complete';
				const complianceNote =
					curatorResult.compliance.length > 0
						? ` (${curatorResult.compliance.length} compliance observation(s))`
						: '';

				callerSessionState.pendingAdvisoryMessages.push(
					`[CURATOR] Phase ${phase} digest: ${digestSummary}${complianceNote}. Knowledge: ${knowledgeResult.applied} applied, ${knowledgeResult.skipped} skipped. Call curator_analyze with recommendations to apply knowledge updates from this phase.`,
				);

				// Check for drift advisories from prior deterministic drift checks
				try {
					const { readPriorDriftReports } = await import(
						'../hooks/curator-drift'
					);
					const priorReports = await readPriorDriftReports(dir);
					const phaseReport = priorReports
						.filter((r) => r.phase === phase)
						.pop();
					if (phaseReport && phaseReport.drift_score > 0) {
						callerSessionState.pendingAdvisoryMessages.push(
							`[CURATOR DRIFT DETECTED (phase ${phase}, score ${phaseReport.drift_score})]: Consider running critic_drift_verifier before phase completion to get a proper drift review. Review drift report for phase ${phase} and address spec alignment if applicable.`,
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

	// Build the effective required-agents list.
	// If the phase defines its own required_agents, use those instead of the global config.
	// This allows non-code phases (acceptance, docs) to skip coder/reviewer/test_engineer requirements.
	let phaseRequiredAgents: string[] | undefined;
	try {
		const planPath = validateSwarmPath(dir, 'plan.json');
		const planRaw = fs.readFileSync(planPath, 'utf-8');
		const plan: { phases: Array<{ id: number; required_agents?: string[] }> } =
			JSON.parse(planRaw);
		const phaseObj = plan.phases.find((p) => p.id === phase);
		phaseRequiredAgents = phaseObj?.required_agents;
	} catch {
		// plan.json missing or unreadable — fall through to config defaults
	}
	const effectiveRequired: string[] = [
		...(phaseRequiredAgents ?? phaseCompleteConfig.required_agents),
	];
	if (phaseCompleteConfig.require_docs && !effectiveRequired.includes('docs')) {
		effectiveRequired.push('docs');
	}

	// Compute missing agents using cross-session aggregated agents
	let agentsMissing = effectiveRequired.filter(
		(req) => !crossSessionResult.agents.has(req),
	);

	// Build warnings and determine success based on policy

	// Plan.json fallback: if agents are missing but all tasks in the phase are
	// completed in plan.json, treat the phase as closeable. Completed tasks prove
	// agents were dispatched (update_task_status requires QA gates to pass).
	if (agentsMissing.length > 0) {
		try {
			const planPath = validateSwarmPath(dir, 'plan.json');
			const planRaw = fs.readFileSync(planPath, 'utf-8');
			const plan: {
				phases: Array<{
					id: number;
					status: string;
					tasks: Array<{ id: string; status: string }>;
				}>;
			} = JSON.parse(planRaw);
			const targetPhase = plan.phases.find((p) => p.id === phase);
			if (
				targetPhase &&
				targetPhase.tasks.length > 0 &&
				targetPhase.tasks.every((t) => t.status === 'completed')
			) {
				warnings.push(
					`Agent dispatch fallback: all ${targetPhase.tasks.length} tasks in phase ${phase} are completed in plan.json. Clearing missing agents: ${agentsMissing.join(', ')}.`,
				);
				agentsMissing = [];
			}
		} catch {
			// plan.json missing or unreadable — fall through to normal enforcement
		}
	}

	// Detect potential auto-repair of retrospective bundle
	// If loaded from a retro-N task ID with schema_version 1.0.0 and valid task_complexity,
	// it may have been auto-repaired from a malformed legacy format
	const VALID_TASK_COMPLEXITY = ['trivial', 'simple', 'moderate', 'complex'];
	const firstEntry = loadedRetroBundle?.entries?.[0] as
		| { task_complexity?: string }
		| undefined;
	if (
		loadedRetroTaskId !== primaryRetroTaskId &&
		loadedRetroTaskId?.startsWith('retro-') &&
		loadedRetroBundle?.schema_version === '1.0.0' &&
		firstEntry?.task_complexity &&
		VALID_TASK_COMPLEXITY.includes(firstEntry.task_complexity)
	) {
		warnings.push(
			`Retrospective data for phase ${phase} may have been automatically migrated to current schema format.`,
		);
	}

	let success = true;
	let status: PhaseCompleteResult['status'] = 'success';
	const safeSummary = summary?.trim().slice(0, 500);
	let message = safeSummary
		? `Phase ${phase} completed: ${safeSummary}`
		: `Phase ${phase} completed`;

	if (agentsMissing.length > 0) {
		if (phaseCompleteConfig.policy === 'enforce') {
			success = false;
			status = 'incomplete';
			message = `Phase ${phase} incomplete: missing required agents: ${agentsMissing.join(', ')}`;
		} else {
			status = 'warned';
			warnings.push(
				`Warning: phase ${phase} missing required agents: ${agentsMissing.join(', ')}`,
			);
		}
	}

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
	};

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

	const lockTaskId = `phase-complete-${Date.now()}`;
	const eventsFilePath = 'events.jsonl';
	// Derive agent from swarmState session context, fallback to 'phase-complete' sentinel
	let agentName = 'phase-complete';
	for (const [, agent] of swarmState?.activeAgent ?? []) {
		agentName = agent;
		break;
	}
	let lockResult: Awaited<ReturnType<typeof tryAcquireLock>> | undefined;
	try {
		lockResult = await tryAcquireLock(
			dir,
			eventsFilePath,
			agentName,
			lockTaskId,
		);
	} catch (error) {
		warnings.push(
			`Warning: failed to acquire lock for phase complete event: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!lockResult?.acquired) {
		warnings.push(
			`Warning: could not acquire lock for events.jsonl write — proceeding without lock`,
		);
	}
	// Write happens unconditionally (with or without lock protection)
	try {
		const eventsPath = validateSwarmPath(dir, 'events.jsonl');
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
	} catch (writeError) {
		warnings.push(
			`Warning: failed to write phase complete event: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
		);
	} finally {
		if (lockResult?.acquired && lockResult.lock._release) {
			try {
				await lockResult.lock._release();
			} catch (releaseError) {
				console.error('[phase-complete] Lock release failed:', releaseError);
			}
		}
	}

	// Reset phase state on success
	if (success) {
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

		// Update plan.json phase status to complete via ledger-first savePlan
		try {
			const plan = await loadPlan(dir);
			if (plan === null) {
				// loadPlan() returned null (malformed JSON and no plan.md to migrate from)
				// Try ledger-first rebuild before direct write
				if (await ledgerExists(dir)) {
					try {
						const rebuilt = await replayFromLedger(dir);
						if (rebuilt) {
							const phaseObj = rebuilt.phases.find(
								(p: { id: number }) => p.id === phase,
							);
							if (phaseObj) {
								phaseObj.status = 'complete';
								await savePlan(dir, rebuilt);
								// After successful phase completion, take a snapshot
								try {
									await takeSnapshotEvent(dir, rebuilt).catch(() => {});
								} catch {
									// Snapshot failure is non-blocking
								}
								// Don't return here — flow through to the common finalization block
								// which writes checkpoint artifacts and builds the final result
								result.success = true;
								result.status = 'success';
							}
						}
					} catch {
						// Rebuild failed, fall through to direct write
					}
				}
				// Last resort: direct write
				warnings.push(`Warning: failed to update plan.json phase status`);
				try {
					const planPath = validateSwarmPath(dir, 'plan.json');
					const planRaw = fs.readFileSync(planPath, 'utf-8');
					const plan = JSON.parse(planRaw);
					const phaseObj = plan.phases.find(
						(p: { id: number }) => p.id === phase,
					);
					if (phaseObj) {
						phaseObj.status = 'complete';
						fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
					}
				} catch {
					/* fallback failed */
				}
			} else if (plan) {
				const phaseObj = plan.phases.find(
					(p: { id: number }) => p.id === phase,
				);
				if (phaseObj) {
					phaseObj.status = 'complete';
					await savePlan(dir, plan, { preserveCompletedStatuses: true });
				}
				// After successful phase completion, take a snapshot
				try {
					const plan = await loadPlan(dir);
					if (plan) {
						await takeSnapshotEvent(dir, plan).catch(() => {});
					}
				} catch {
					// Snapshot failure is non-blocking
				}
			}
		} catch (_error) {
			// loadPlan() threw — this shouldn't happen for malformed JSON (loadPlan returns null instead)
			// Try ledger-first rebuild before direct write
			if (await ledgerExists(dir)) {
				try {
					const rebuilt = await replayFromLedger(dir);
					if (rebuilt) {
						const phaseObj = rebuilt.phases.find(
							(p: { id: number }) => p.id === phase,
						);
						if (phaseObj) {
							phaseObj.status = 'complete';
							await savePlan(dir, rebuilt);
							// After successful phase completion, take a snapshot
							try {
								await takeSnapshotEvent(dir, rebuilt).catch(() => {});
							} catch {
								// Snapshot failure is non-blocking
							}
							// Don't return here — flow through to the common finalization block
							// which writes checkpoint artifacts and builds the final result
							result.success = true;
							result.status = 'success';
						}
					}
				} catch {
					// Rebuild failed, fall through to direct write
				}
			}
			// Last resort: direct write
			warnings.push(`Warning: failed to update plan.json phase status`);
			try {
				const planPath = validateSwarmPath(dir, 'plan.json');
				const planRaw = fs.readFileSync(planPath, 'utf-8');
				const plan = JSON.parse(planRaw);
				const phaseObj = plan.phases.find(
					(p: { id: number }) => p.id === phase,
				);
				if (phaseObj) {
					phaseObj.status = 'complete';
					fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
				}
			} catch {
				/* fallback failed */
			}
		}
	}

	if (complianceWarnings.length > 0) {
		warnings.push(`Curator compliance: ${complianceWarnings.join('; ')}`);
	}

	// v6.33.1: Flush debounced snapshot on phase-complete
	await flushPendingSnapshot(dir);

	// Write root-level checkpoint artifact (non-blocking)
	await writeCheckpoint(dir).catch(() => {});

	return JSON.stringify(
		{ ...result, timestamp: event.timestamp, duration_ms: durationMs },
		null,
		2,
	);
}

/**
 * Tool definition for phase_complete
 */
export const phase_complete: ToolDefinition = createSwarmTool({
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
	},
	execute: async (args, directory, ctx) => {
		// Parse and validate arguments
		let phaseCompleteArgs: PhaseCompleteArgs;
		let workingDirInput: string | undefined;

		try {
			phaseCompleteArgs = {
				phase: Number(args.phase),
				summary: args.summary !== undefined ? String(args.summary) : undefined,
				sessionID:
					ctx?.sessionID ??
					(args.sessionID !== undefined ? String(args.sessionID) : undefined),
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
		);
	},
});
