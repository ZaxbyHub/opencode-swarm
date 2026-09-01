/**
 * Delegation Gate Hook
 *
 * Warns the architect when coder delegations are too large or batched.
 * Uses experimental.chat.messages.transform to provide non-blocking guidance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZodError, z } from 'zod';
import type {
	BackgroundCoderReservation,
	BackgroundDelegationRecord,
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
	RecordPendingInput,
} from '../background/pending-delegations.js';
import { buildBackgroundCoderReservationId } from '../background/pending-delegations.js';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
} from '../background/workspace-snapshot.js';
import type { PluginConfig } from '../config';
import { ALL_AGENT_NAMES } from '../config/agent-names.js';
import { DEFAULT_MODELS } from '../config/constants';
import type { Phase, Plan, Task } from '../config/plan-schema';
import { isKnownCanonicalRole, stripKnownSwarmPrefix } from '../config/schema';
import {
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getProfileForIdentity,
	type QaGates,
} from '../db/qa-gate-profile.js';
import {
	appendCoreEventSync,
	CORE_EVENT_LOCKED,
	getCoderRetryEscalationActions,
} from '../events/core-events.js';
import { isReadOnlyTool } from '../full-auto/policy';
import { isMarkdownOnlyTaskChange } from '../gate-evidence-classification.js';
import {
	routeReviewForChanges,
	shouldParallelizeReview,
} from '../parallel/review-router.js';
import {
	computePlanStructureHash,
	loadLastPlanCriticApprovedSnapshot,
	takeSnapshotEvent,
} from '../plan/ledger';
import { loadPlanJsonOnly, savePlan } from '../plan/manager';
import {
	computeParallelVerdict,
	isProvablyDisjoint,
} from '../plan/parallel-verdict';
import { derivePlanId } from '../plan/utils.js';
import { resetPrmSessionState } from '../prm/index.js';
import { isPathWithinDeclaredScope } from '../scope/path-identity';
import {
	canonicalWorkspaceIdentity,
	clearExactScopeBinding,
	clearScopeBindings,
	createPrFeedbackScopeBinding,
	createScopeBinding,
	deriveChildScopeBinding,
	formatCoderScopeConflict,
	MAX_PENDING_SCOPE_BINDINGS,
	resolveCoderScopeSources,
	type ScopeBinding,
} from '../scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	clearScopeBindingFromDisk,
	persistAndRegisterScopeBinding,
	resolveScopeBindingFromDisk,
} from '../scope/scope-persistence';
import { formatScopeResolutionDiagnostic } from '../scope/scope-resolution-diagnostic';
import type { AgentSessionState } from '../state';
import {
	advanceTaskState,
	ensureAgentSession,
	getModifiedFilesForTask,
	getTaskState,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	isCouncilGateActive,
	recordStageBCompletion,
	swarmState,
	updateTaskWorkflowCache,
} from '../state';
import { telemetry } from '../telemetry.js';
import type {
	DelegationEnvelope,
	EnvelopeValidationResult,
} from '../types/delegation.js';
import * as logger from '../utils/logger';
import { isStrictTaskId } from '../validation/task-id';
import {
	abortCoderSettlement,
	abortCoderSettlementIfDoomed,
	beginCoderSettlement,
	completeCoderSettlementCleanup,
	recordCoderMergeProvenance,
	recoverCoderSettlement,
	releaseCoderDispatchOwnership,
	settleCoderDispatch,
} from '../workflow/coder-settlement.js';
import { recoverPreparedTaskRepair } from '../workflow/task-repair.js';
import { recoverPreparedTaskTerminal } from '../workflow/task-terminal.js';
import {
	awaitingMergeByCallID,
	checkStandardWorktreeSerializationRelease,
	cleanupStandardWorktreeForCallId,
	finishStandardWorktreeDispatch,
	getStandardWorktreeDegradationReason,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
	resolveWorktreeIsolationConfig,
	type StandardWorktreeDispatch,
	sanitizeWorktreeTaskId,
	standardWorktreeByCallID,
	standardWorktreeSerializationSessions,
} from './delegation-gate/worktree-isolation';
import { consumePrFeedbackScopeDeclaration } from './pr-workflow-gate.js';
export { resetStandardWorktreeIsolationState };

import { pushAdvisory } from '../utils/advisory-queue';
import { _internals as _wtiInternals } from './delegation-gate/worktree-isolation';
import {
	initDurableStatusPath,
	recordWorktreeMergeFailure,
} from './delegation-gate/worktree-merge-status';
import { deleteStoredInputArgs, getStoredInputArgs } from './guardrails';
import { normalizeToolName } from './normalize-tool-name';
import { validateSwarmPath } from './utils';

const EvidenceTaskIdPlanSchema = z
	.object({
		phases: z
			.array(
				z
					.object({
						tasks: z
							.array(
								z
									.object({
										id: z.string(),
										status: z.string().optional(),
									})
									.passthrough(),
							)
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

/**
 * v6.33.1 CRIT-1: Fallback map for declared coder scope by taskId.
 * When messagesTransform sets declaredCoderScope on the architect session,
 * the coder session may not exist yet. This map allows scope-guard to look up
 * the scope by taskId when the session's declaredCoderScope is null.
 *
 * v6.70.0 gap-closure: this map is module-scoped (not inside `swarmState`) and
 * is cleared by `resetSwarmState` via `clearPendingCoderScope()` below. Without
 * that cleanup, a `/swarm close` followed by a new session with a colliding
 * taskId (e.g. "1.1") would inherit stale scope from the previous swarm.
 */
class BoundedPendingScopeMap extends Map<string, string[]> {
	private readonly expiresAtByKey = new Map<string, number>();
	private sweepExpired(now = Date.now()): void {
		for (const [key, expiresAt] of this.expiresAtByKey) {
			if (expiresAt <= now) this.delete(key);
		}
	}
	override set(key: string, value: string[]): this {
		this.sweepExpired();
		this.delete(key);
		super.set(key, value);
		this.expiresAtByKey.set(key, Date.now() + 5 * 60_000);
		while (this.size > MAX_PENDING_SCOPE_BINDINGS) {
			const oldest = this.keys().next().value as string | undefined;
			if (!oldest) break;
			this.delete(oldest);
		}
		return this;
	}
	override get(key: string): string[] | undefined {
		this.sweepExpired();
		return super.get(key);
	}
	override has(key: string): boolean {
		this.sweepExpired();
		return super.has(key);
	}
	override delete(key: string): boolean {
		this.expiresAtByKey.delete(key);
		return super.delete(key);
	}
	override clear(): void {
		this.expiresAtByKey.clear();
		super.clear();
	}
}

/** @deprecated Compatibility-only test fixture; never consulted by production. */
export const pendingCoderScopeByTaskId = new BoundedPendingScopeMap();

function pendingScopeKey(directory: string, taskId: string): string | null {
	const workspace = canonicalWorkspaceIdentity(directory);
	return workspace ? `${workspace}\0${taskId}` : null;
}

function exactProvisioningOwnerForBackgroundDescriptor(
	owner: StandardWorktreeDispatch['provisioningOwner'],
): BackgroundWorktreeDescriptor['provisioningOwner'] | undefined {
	if (
		owner?.reservationId === undefined ||
		owner.generation === undefined ||
		owner.branchName === undefined
	) {
		return undefined;
	}
	return {
		reservationId: owner.reservationId,
		generation: owner.generation,
		branchName: owner.branchName,
	};
}

export function setPendingCoderScope(
	directory: string,
	taskId: string,
	files: string[],
): void {
	const key = pendingScopeKey(directory, taskId);
	if (key) pendingCoderScopeByTaskId.set(key, files);
}

export function getPendingCoderScope(
	directory: string,
	taskId: string,
): string[] | null {
	const key = pendingScopeKey(directory, taskId);
	return key ? (pendingCoderScopeByTaskId.get(key) ?? null) : null;
}

/**
 * v6.70.0 gap-closure: clears the pending coder-scope map. Exported as a
 * helper (rather than importing the map directly from state.ts) to avoid the
 * circular import `state.ts ↔ delegation-gate.ts`. Called by `resetSwarmState`.
 */
export function clearPendingCoderScope(): void {
	pendingCoderScopeByTaskId.clear();
}

interface PreparedCoderScope {
	plan: Plan | null;
	taskId: string;
	declaredFiles: string[] | null;
	binding: ScopeBinding;
}

async function prepareCoderScope(
	directory: string,
	input: { sessionID: string; callID: string },
	args: Record<string, unknown>,
): Promise<PreparedCoderScope> {
	// loadPlanJsonOnly swallows read/parse errors and returns null for missing,
	// corrupt, or schema-invalid plan.json — it never throws (see plan/manager.ts).
	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		// PR #1915 PR-workflow gate: if there's no plan.json but the caller has
		// declared a verified PR-feedback scope for an explicit plan-task-shaped
		// task_id, bind that scope and return early (no plan needed).
		const rawTaskId =
			typeof args.task_id === 'string'
				? args.task_id.trim()
				: typeof args.taskId === 'string'
					? args.taskId.trim()
					: '';
		if (isStrictTaskId(rawTaskId)) {
			const feedbackScope = await consumePrFeedbackScopeDeclaration(
				directory,
				input.sessionID,
				rawTaskId,
				input.callID,
			);
			if (feedbackScope) {
				const directives = extractTaskFileDirectives(args);
				if (directives.present && !directives.files) {
					throw new Error(
						'SCOPE_NOT_DECLARED: FILE: directives are present but empty or ambiguous; provide one complete relative path per FILE: line.',
					);
				}
				const resolved = resolveCoderScopeSources({
					explicitFiles: feedbackScope.files,
					planFiles: null,
					fileDirectiveFiles: directives.files,
				});
				if (!resolved.ok) {
					throw new Error(formatCoderScopeConflict(resolved));
				}
				const binding = createPrFeedbackScopeBinding({
					directory,
					taskId: rawTaskId,
					files: resolved.files,
					ownerSessionId: input.sessionID,
					ownerMessageId: input.callID,
					dispatchCallId: input.callID,
					activation: 'pending_child',
					workflowSessionId: input.sessionID,
					workflowRevisionDigest: feedbackScope.revisionDigest,
				});
				if (!binding) {
					throw new Error(
						'SCOPE_NOT_DECLARED: PR-feedback scope could not be bound to this Task invocation.',
					);
				}
				return {
					plan: null,
					taskId: rawTaskId,
					declaredFiles: resolved.files,
					binding,
				};
			}
		}
		// Issue #1914: no plan AND no PR-feedback declaration. One message
		// covers missing / corrupt / schema-invalid (loadPlanJsonOnly already
		// logged the validation warning).
		const planPath = path.join(directory, '.swarm', 'plan.json');
		throw new Error(
			`SCOPE_NOT_DECLARED: no valid plan found at ${planPath} (file missing or invalid). Declare a plan via save_plan or run /swarm plan first.`,
		);
	}
	const planTaskIds = new Set(
		plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
	);
	const taskId = resolveDelegatedPlanTaskId(args, planTaskIds);
	if (!taskId) {
		// Cause-specific diagnostic so the architect can self-correct in one turn
		// instead of guessing (issue #1914 Defect 2).
		throw new Error(
			`SCOPE_NOT_DECLARED: ${describeCoderScopeFailure(args, planTaskIds)}`,
		);
	}
	// Membership gate (issue #1914 critic item 1): reject plan-task-shaped-but-
	// unknown ids explicitly. Without this, `task_id: "9.9"` + FILE: directives
	// would produce a valid binding for a non-existent task — createScopeBinding
	// only validates isStrictTaskId, not plan membership.
	if (!planTaskIds.has(taskId)) {
		throw new Error(
			`SCOPE_NOT_DECLARED: task_id "${taskId}" does not match any known plan task id. Known: ${[...planTaskIds].sort().join(', ') || '(none)'}. Update the dispatch or revise the plan.`,
		);
	}
	const directives = extractTaskFileDirectives(args);
	if (directives.present && !directives.files) {
		throw new Error(
			'SCOPE_NOT_DECLARED: FILE: directives are present but empty or ambiguous; provide one complete relative path per FILE: line.',
		);
	}
	const explicitResolution = resolveScopeBindingFromDisk({
		directory,
		plan,
		taskId,
		ownerSessionId: input.sessionID,
		requireDeclaration: true,
		includeExpired: true,
	});
	if (
		explicitResolution.status === 'ambiguous' ||
		explicitResolution.status === 'expired' ||
		explicitResolution.status === 'overloaded'
	) {
		throw new Error(
			formatScopeResolutionDiagnostic({
				resolution: explicitResolution,
				taskId,
				sessionId: input.sessionID,
			}) ?? 'SCOPE_NOT_DECLARED: durable declaration resolution failed.',
		);
	}
	const explicitBinding =
		explicitResolution.status === 'found' ? explicitResolution.binding : null;
	const declaredFiles = getPlanTaskDeclaredFiles(plan, taskId);
	const resolved = resolveCoderScopeSources({
		explicitFiles: explicitBinding?.files,
		planFiles: declaredFiles,
		fileDirectiveFiles: directives.files,
	});
	if (!resolved.ok) {
		throw new Error(formatCoderScopeConflict(resolved));
	}
	const binding = createScopeBinding({
		directory,
		plan,
		taskId,
		files: resolved.files,
		ownerSessionId: input.sessionID,
		ownerMessageId: input.callID,
		dispatchCallId: input.callID,
		activation: 'pending_child',
		source: resolved.source,
	});
	if (!binding) {
		throw new Error(
			'SCOPE_NOT_DECLARED: coder scope could not be bound to this Task invocation.',
		);
	}
	return { plan, taskId, declaredFiles, binding };
}

/**
 * Issue #1151: OpenCode v1.16.2 background subagents.
 *
 * `Task` with `background=true` (gated upstream by
 * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`) returns a "running" placeholder
 * immediately and completes later via synthetic parent injection. The delegation gate
 * treats a foreground `Task` result as completion, so the running placeholder must be
 * tracked without terminal side effects. When the opt-in is enabled, trusted deferred
 * completion ingestion performs exact parent correlation, workspace settlement, and
 * role-appropriate state/evidence updates. With the opt-in disabled (the default while
 * upstream remains experimental), background swarm delegations are fail-closed-blocked.
 * We do NOT silently coerce `background` to false.
 */
export const SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE =
	'SWARM_BACKGROUND_TASK_BLOCKED: OpenCode background subagents (Task with background=true, ' +
	'requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true or OPENCODE_EXPERIMENTAL=true) ' +
	'remain experimental upstream and are disabled by default in swarm. Omit `background` ' +
	'(or set background=false), or explicitly enable hooks.background_subagents only after ' +
	'reviewing the background-subagent recovery and readiness guidance.';

/**
 * Fail-closed background-flag detector. Treats both the boolean `true` and the
 * stringified `'true'` as background so a stringified flag cannot bypass the guard.
 */
export function isBackgroundTrue(value: unknown): boolean {
	return value === true || value === 'true';
}

/**
 * True when a `Task` tool RESULT looks like an OpenCode background "running"
 * placeholder (`state: "running"` or `metadata.background === true`). Belt-and-
 * suspenders for `toolAfter`; never throws.
 */
export function outputLooksLikeBackgroundRunning(output: unknown): boolean {
	if (typeof output !== 'object' || output === null) return false;
	const o = output as Record<string, unknown>;
	if (o.state === 'running') return true;
	const metadata = o.metadata;
	return (
		typeof metadata === 'object' &&
		metadata !== null &&
		(metadata as Record<string, unknown>).background === true
	);
}

/**
 * Checks if an object has the required fields to be a DelegationEnvelope.
 */
function isEnvelope(obj: unknown): boolean {
	if (typeof obj !== 'object' || obj === null) return false;
	const e = obj as Record<string, unknown>;
	return (
		typeof e.taskId === 'string' &&
		typeof e.targetAgent === 'string' &&
		typeof e.action === 'string'
	);
}

/**
 * Parses a string to extract a DelegationEnvelope.
 * Returns null if no valid envelope is found.
 * Never throws - all errors are caught and result in null.
 */
export function parseDelegationEnvelope(
	content: string,
	directory?: string,
): DelegationEnvelope | null {
	// Helper to validate file paths in an envelope
	const validateEnvelopePaths = (
		envelope: DelegationEnvelope,
	): DelegationEnvelope | null => {
		if (directory) {
			for (const filePath of envelope.files) {
				try {
					validateSwarmPath(directory, filePath);
				} catch {
					return null;
				}
				// Verify referenced files actually exist
				const resolvedPath = path.resolve(directory, filePath);
				if (!fs.existsSync(resolvedPath)) {
					return null;
				}
			}
		}
		return envelope;
	};

	try {
		// Try direct JSON parse first
		const parsed = JSON.parse(content);
		if (isEnvelope(parsed))
			return validateEnvelopePaths(parsed as DelegationEnvelope);
	} catch {
		// Try to extract JSON block from content
		const match = content.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				const parsed = JSON.parse(match[0]);
				if (isEnvelope(parsed))
					return validateEnvelopePaths(parsed as DelegationEnvelope);
			} catch {
				// not an envelope
			}
		}
	}

	// Try KEY:VALUE text format
	const lines = content.split('\n');
	const keyValueMap: Record<string, string> = {};

	for (const line of lines) {
		const match = line.match(/^([^:]+):\s*(.+)$/);
		if (match) {
			const key = match[1].trim().toLowerCase();
			const value = match[2].trim();
			keyValueMap[key] = value;
		}
	}

	// Normalize key names to camelCase
	const keyNormalization: Record<string, string> = {
		taskid: 'taskId',
		task_id: 'taskId',
		targetagent: 'targetAgent',
		target_agent: 'targetAgent',
		commandtype: 'commandType',
		command_type: 'commandType',
		acceptancecriteria: 'acceptanceCriteria',
		acceptance_criteria: 'acceptanceCriteria',
		technicalcontext: 'technicalContext',
		technical_context: 'technicalContext',
		errorstrategy: 'errorStrategy',
		error_strategy: 'errorStrategy',
		platformnotes: 'platformNotes',
		platform_notes: 'platformNotes',
		action: 'action',
		files: 'files',
	};

	const normalizedMap: Record<string, string> = {};
	for (const [key, value] of Object.entries(keyValueMap)) {
		const normalized = keyNormalization[key] || key;
		normalizedMap[normalized] = value;
	}

	// If fewer than 3 envelope fields found → return null
	if (Object.keys(normalizedMap).length < 3) {
		return null;
	}

	// Required fields check
	const requiredFields = [
		'taskId',
		'targetAgent',
		'action',
		'commandType',
		'files',
		'acceptanceCriteria',
	];
	for (const field of requiredFields) {
		if (!normalizedMap[field]) {
			return null;
		}
	}

	// Parse array fields (files and acceptanceCriteria)
	const parseArrayField = (value: string): string[] => {
		let parts = value.split(',');
		if (parts.length === 1) {
			parts = value.split(';');
		}
		return parts.map((s) => s.trim()).filter((s) => s.length > 0);
	};

	// Build the envelope
	const envelope: DelegationEnvelope = {
		taskId: normalizedMap.taskId,
		targetAgent: normalizedMap.targetAgent,
		action: normalizedMap.action,
		commandType: normalizedMap.commandType as 'task' | 'slash_command',
		files: parseArrayField(normalizedMap.files),
		acceptanceCriteria: parseArrayField(normalizedMap.acceptanceCriteria),
		technicalContext: normalizedMap.technicalContext || '',
	};

	// Add optional fields if present
	if (normalizedMap.technicalContext) {
		envelope.technicalContext = normalizedMap.technicalContext;
	}
	if (normalizedMap.errorStrategy) {
		envelope.errorStrategy = normalizedMap.errorStrategy as
			| 'FAIL_FAST'
			| 'BEST_EFFORT';
	}
	if (normalizedMap.platformNotes) {
		envelope.platformNotes = normalizedMap.platformNotes;
	}

	return validateEnvelopePaths(envelope);
}

interface ValidationContext {
	planTasks: string[];
	validAgents: string[];
}

/**
 * Validates a DelegationEnvelope against the current plan and agent list.
 * Returns { valid: true } on success, or { valid: false; reason: string } on failure.
 *
 * NOTE (#1687, kept SEPARATE from {@link validateCoderReviewerAcceptanceField}):
 * this validator operates on a *structured* `DelegationEnvelope` object recovered
 * from the OLD `KEY:VALUE` envelope format (`taskId:`/`targetAgent:`/`action:`/
 * `commandType:`/`files:`/`acceptanceCriteria:`) and is consumed ADVISORY-ONLY,
 * POST-execution via {@link appendDelegationEnvelopeAdvisory} in `toolAfter` (it
 * never throws). The free-text coder/reviewer format
 * (`TASK:`/`FILE:`/`ACCEPTANCE:`) does NOT parse into this shape
 * (`parseDelegationEnvelope` returns `null`), so this path never fires on a real
 * coder/reviewer dispatch. The pre-dispatch, BLOCKING acceptance-field gate for
 * the free-text format lives in {@link validateCoderReviewerAcceptanceField};
 * the two are intentionally not merged (advisory-vs-blocking, structured-vs-
 * free-text are different contracts). Do not delete this function — it retains a
 * real purpose for the old envelope format and other delegation types.
 */
export function validateDelegationEnvelope(
	envelope: unknown,
	context: ValidationContext,
): EnvelopeValidationResult {
	// Must be a non-null object
	if (typeof envelope !== 'object' || envelope === null) {
		return { valid: false, reason: 'envelope_not_object' };
	}

	const e = envelope as Record<string, unknown>;

	// Required fields
	const requiredFields = [
		'taskId',
		'targetAgent',
		'action',
		'commandType',
		'files',
		'acceptanceCriteria',
	] as const;

	for (const field of requiredFields) {
		if (!(field in e) || e[field] === undefined || e[field] === null) {
			return { valid: false, reason: `missing_field_${field}` };
		}
	}

	// slash_command delegation is blocked
	if (e.commandType === 'slash_command') {
		return { valid: false, reason: 'slash_command_delegation_blocked' };
	}

	// taskId must be in planTasks (if planTasks is non-empty)
	const taskId = e.taskId as string;
	if (context.planTasks.length > 0 && !context.planTasks.includes(taskId)) {
		return { valid: false, reason: 'taskId_not_in_plan' };
	}

	// targetAgent must be valid after stripping swarm prefix
	const rawAgent = e.targetAgent as string;
	const normalizedAgent = stripKnownSwarmPrefix(rawAgent);
	if (!context.validAgents.includes(normalizedAgent)) {
		return { valid: false, reason: 'invalid_target_agent' };
	}

	// files must be non-empty for implement or review actions
	const action = e.action as string;
	const files = e.files as unknown[];
	if (
		(action === 'implement' || action === 'review') &&
		(!Array.isArray(files) || files.length === 0)
	) {
		return { valid: false, reason: 'files_required_for_action' };
	}

	// acceptanceCriteria must be non-empty
	const acceptanceCriteria = e.acceptanceCriteria as unknown[];
	if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
		return { valid: false, reason: 'acceptanceCriteria_required' };
	}

	// M15: OPTIONAL specCriteria field. A MISSING field passes silently — it is
	// never a rejection reason and never produces advisory noise. Only a
	// POPULATED-but-malformed value is flagged: specCriteria must be a plain
	// object, and each present member (fr/sc/acceptance) must be a string[].
	if (
		'specCriteria' in e &&
		e.specCriteria !== undefined &&
		e.specCriteria !== null
	) {
		const spec = e.specCriteria;
		if (typeof spec !== 'object' || Array.isArray(spec)) {
			return { valid: false, reason: 'specCriteria_malformed' };
		}
		const specObj = spec as Record<string, unknown>;
		for (const member of ['fr', 'sc', 'acceptance'] as const) {
			const value = specObj[member];
			if (value === undefined || value === null) continue;
			if (
				!Array.isArray(value) ||
				!value.every((entry) => typeof entry === 'string')
			) {
				return { valid: false, reason: `specCriteria_${member}_malformed` };
			}
		}
	}

	return { valid: true };
}

/**
 * M15 advisory-only delegation-envelope check. NON-BLOCKING by contract: it
 * NEVER throws and NEVER rejects a delegation. It runs
 * {@link validateDelegationEnvelope} (previously reachable only from tests) on a
 * delegation prompt that ALREADY parses as a structured `DelegationEnvelope`,
 * and on validation failure appends a concise advisory to
 * `session.pendingAdvisoryMessages` — the existing non-blocking channel.
 *
 * A real, minimal free-text delegation (TASK:/FILE:/... with no structured
 * envelope) is a no-op: {@link parseDelegationEnvelope} returns `null`, so no
 * advisory is produced and nothing is rejected. The new optional `specCriteria`
 * field is OPTIONAL in the validator — a missing field passes silently; only a
 * populated-but-malformed field surfaces an advisory.
 *
 * @returns the validation result when an envelope was parsed, or `null` when the
 *   prompt was not a structured envelope. Return value is for tests/telemetry;
 *   the side effect (advisory push) is the production purpose.
 */
export function appendDelegationEnvelopeAdvisory(
	session: AgentSessionState,
	promptText: string,
	context: ValidationContext,
): EnvelopeValidationResult | null {
	try {
		const envelope = parseDelegationEnvelope(promptText);
		if (!envelope) return null; // free-text / non-envelope → no advisory, no block
		const result = validateDelegationEnvelope(envelope, context);
		if (!result.valid) {
			pushAdvisory(
				session,
				`DELEGATION ENVELOPE ADVISORY: a parsed delegation envelope failed validation (${result.reason}). ` +
					`This is advisory-only — the delegation was NOT blocked. Review the envelope's structured ` +
					`fields (including the optional specCriteria acceptance/FR/SC arrays) before the next dispatch.`,
			);
		}
		return result;
	} catch {
		// The advisory path must never throw into the caller (fail-open).
		return null;
	}
}

/**
 * FR-003 / SC-003 / SC-004 (issue #1687): pre-dispatch acceptance-criteria
 * enforcement for **coder and reviewer** delegations, operating on the REAL
 * free-text delegation prompt (`TASK:`/`FILE:`/`INPUT:`/`OUTPUT:`/`CONSTRAINT:`/
 * `ACCEPTANCE:`/`SKILLS:`) the architect actually sends via the native Task tool.
 *
 * Deliberately kept SEPARATE from {@link validateDelegationEnvelope} (see the
 * sibling note there), NOT a rename/reuse of it, because the semantics differ on
 * two axes: this function parses the FREE-TEXT `ACCEPTANCE:` line (not a
 * structured envelope object) and is consumed as a BLOCKING, PRE-execution
 * (`toolBefore`) gate (not the advisory, post-execution `toolAfter` path that
 * `validateDelegationEnvelope` feeds via {@link appendDelegationEnvelopeAdvisory}).
 * The two formats never overlap — `parseDelegationEnvelope` returns `null` for
 * the free-text coder/reviewer format — so merging them would conflate
 * advisory-vs-blocking and structured-vs-free-text contracts. M15's advisory
 * mechanism is left fully intact for the old envelope format and other
 * delegation types.
 *
 * A dispatch passes when an `ACCEPTANCE:` line exists AND the field carries
 * non-empty, non-whitespace content — either INLINE on the header line (the
 * architect-instructed same-line format) OR on the lines that FOLLOW a bare
 * `ACCEPTANCE:` header, up to (but excluding) the next INPUT-FORMAT field header
 * (`^[A-Z][A-Z0-9_]*:`, e.g. `SKILLS:`) or end of input. The multi-line form is
 * a plausible way to paste a verbatim FR/SC body that spans lines (PR #1864
 * review feedback), so treating a bare header + following content as EMPTY would
 * false-block a good-faith copy. The next-field-header terminator ensures
 * content belonging to the NEXT field (e.g. `SKILLS: none`) is never miscounted
 * as ACCEPTANCE content — an empty `ACCEPTANCE:` immediately followed by another
 * field is still correctly rejected as empty. Prompts are split on `\r?\n` so a
 * trailing `\r` (CRLF-authored prompts) never leaks into the captured content.
 *
 * Only NON-EMPTINESS is enforced here; verbatim-coverage of the mapped FR/SC
 * bodies is a SEPARATE, later check ({@link checkAcceptanceCoversFrRefs}) that
 * already newline-normalizes the whole prompt, so multi-line ACCEPTANCE content
 * is visible to it regardless.
 *
 * @param promptText the assembled delegation prompt (all text-bearing Task args
 *   joined).
 * @returns `{ valid: true }` when the ACCEPTANCE field is present and non-empty;
 *   otherwise `{ valid: false, reason }` with a diagnosable reason the caller
 *   turns into a blocking, pre-dispatch error.
 */
export function validateCoderReviewerAcceptanceField(promptText: string): {
	valid: boolean;
	reason?: 'acceptance_field_missing' | 'acceptance_field_empty';
} {
	// Split on CR?LF so a trailing `\r` never leaks into captured content and so
	// a bare `ACCEPTANCE:` header's following lines can be scanned individually.
	const lines = promptText.split(/\r?\n/);
	// `^ACCEPTANCE:` anchored to a line start so an incidental "ACCEPTANCE:"
	// appearing mid-line (e.g. inside a CONSTRAINT sentence) is not mistaken for
	// the field header. Case-insensitive to match the architect's authored case.
	const headerRe = /^ACCEPTANCE:[ \t]*(.*)$/i;
	// A subsequent INPUT-FORMAT field header (TASK:/FILE:/CONSTRAINT:/SKILLS:/…):
	// an all-caps token immediately followed by a colon at line start. Terminates
	// the ACCEPTANCE section so content belonging to the NEXT field is never
	// counted as ACCEPTANCE content.
	const nextFieldRe = /^[A-Z][A-Z0-9_]*:/;

	for (let i = 0; i < lines.length; i++) {
		const match = headerRe.exec(lines[i]);
		if (!match) continue;

		// Inline content on the header line itself (the common same-line format).
		if (match[1].trim().length > 0) {
			return { valid: true };
		}
		// Bare `ACCEPTANCE:` — accept content on the following lines up to the
		// next field header / end of input (multi-line verbatim-copy format).
		for (let j = i + 1; j < lines.length; j++) {
			if (nextFieldRe.test(lines[j])) break; // next field starts
			if (lines[j].trim().length > 0) {
				return { valid: true };
			}
		}
		// Header present, but no inline content and no content before the next
		// field header / EOF.
		return { valid: false, reason: 'acceptance_field_empty' };
	}
	return { valid: false, reason: 'acceptance_field_missing' };
}

/**
 * FR-001/FR-002/FR-005/SC-001/SC-002/SC-006 (issue #1687): pull the verbatim
 * requirement BODY for a single spec id (`FR-###` / `SC-###`) out of `spec.md`.
 *
 * spec.md requirements are bold-prefixed bullets, one per (possibly wrapped)
 * bullet, e.g.
 *   `- **FR-000 — Structured task-to-FR mapping.** The plan task model SHALL ...`
 *   `- **SC-000 (FR-000).** Given a plan ..., then ...`
 * The requirement BODY is the text AFTER the FIRST closing `**` of the leading
 * bold span — i.e. everything past the `**...**` id/title prefix. Handles both
 * FR-### and SC-### uniformly (no special-casing) and stitches on any
 * immediately-following continuation lines of a wrapped bullet until the next
 * bullet / next FR-|SC- bullet / a blank line / a markdown heading.
 *
 * @returns the raw (untrimmed) body string, or `null` when the id is not present
 *   in the spec (unknown/typo/renamed) — the caller treats null as fail-open skip.
 */
export function extractSpecRequirementBodyById(
	specText: string,
	id: string,
): string | null {
	// Guard against an empty/whitespace-only id: without this, the regex below
	// degenerates to matching the FIRST bold bullet in spec.md instead of
	// correctly reporting "not found".
	if (!id || id.trim().length === 0) return null;
	// Escape regex metacharacters in the id (`-` etc.) so it matches literally.
	const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const lines = specText.split(/\r?\n/);
	// Leading bold span containing the id: optional list marker, whitespace, `**`,
	// optional whitespace, then the id at a word boundary (so `FR-001` does not
	// match `FR-0012`, and the id must open the bold span — not appear inside a
	// parenthetical like SC-000's `(FR-000)`).
	const headerRe = new RegExp(`^\\s*[-*]?\\s*\\*\\*\\s*${escapedId}\\b`);
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headerRe.test(lines[i])) {
			headerIdx = i;
			break;
		}
	}
	if (headerIdx === -1) return null;

	const headerLine = lines[headerIdx];
	// Body starts after the FIRST closing `**` of the leading bold span. Using
	// indexOf from just past the opening `**` grabs the closing marker even when
	// the body itself later contains its own bold spans.
	const openIdx = headerLine.indexOf('**');
	const closeIdx = openIdx === -1 ? -1 : headerLine.indexOf('**', openIdx + 2);
	if (closeIdx === -1) return null; // malformed bullet — treat as not found
	let body = headerLine.slice(closeIdx + 2);

	// Stitch wrapped-bullet continuation lines (current spec has none, but be safe).
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) break; // blank line
		if (/^#/.test(line)) break; // markdown heading
		if (/^\s*[-*]\s/.test(line)) break; // next bullet
		if (/^\s*[-*]?\s*\*\*\s*(?:FR|SC)-/.test(line)) break; // next FR/SC bullet
		body += ` ${line}`;
	}
	return body;
}

/**
 * FR-001/FR-002 (issue #1687): symmetric normalization applied identically to
 * BOTH the extracted spec body AND the ACCEPTANCE prompt text before the
 * substring-coverage compare. Asymmetric normalization would false-block, so this
 * is deliberately the single shared normalizer. Strips markdown emphasis/code
 * markers and leading list markers, folds punctuation the architect's LLM copy
 * routinely substitutes (dash-width, curly-vs-straight quotes) so a good-faith
 * verbatim copy is not false-blocked on a `—`→`--` or `'`→`'` swap, collapses
 * ALL whitespace (incl. newlines) to single spaces, trims, and lowercases. Every
 * fold is symmetric (both sides go through this one function), so it can only
 * REDUCE false-blocks — it never opens a bypass, since covered/uncovered still
 * differ by whole words, not punctuation.
 *
 * Issue #1896: encoding tolerance. Canonicalizes Unicode via NFC first (so a
 * decomposed accent vs its composed form compare equal — same text, different
 * byte encoding), and folds the section sign `§` (U+00A7) — and the common
 * Latin-1 mojibake `Â§` a non-UTF-8 web save produces — to the spaced word token
 * " section " so `§4.2`, `§ 4.2`, `Â§ 4.2`, and `section 4.2` all compare equal.
 * Both additions are symmetric and information-preserving, so they can only
 * reduce false-blocks. A literal `??` (U+003F run, from a save that DESTROYED the
 * `§`) is NOT recoverable here — the coverage-miss diagnostic surfaces it instead.
 */
export function normalizeAcceptanceText(s: string): string {
	return (
		s
			.normalize('NFC') // canonical Unicode compose (encoding tolerance, #1896)
			.replace(/`/g, '') // inline code backticks
			.replace(/\*\*/g, '') // bold markers
			.replace(/\*/g, '') // italic / list-star markers
			.replace(/^[ \t]*[-*][ \t]+/gm, '') // leading list markers "- " / "* "
			// Fold punctuation variants AFTER the leading-list-marker strip so a
			// content em-dash normalized to a hyphen is never mistaken for a bullet.
			.replace(/[‘’]/g, "'") // curly single quotes -> straight
			.replace(/[“”]/g, '"') // curly double quotes -> straight
			.replace(/[—–]/g, '-') // em/en dash -> hyphen
			.replace(/-{2,}/g, '-') // collapse hyphen runs (incl. `--` for an em-dash)
			// #1896: fold `§` and its Latin-1 mojibake `Â§` to a SPACED word token
			// BEFORE the whitespace-collapse, so `§4.2` -> ` section 4.2` -> matches
			// `section 4.2`. A bare (unspaced) fold would yield `section4.2` and
			// false-block the no-space form.
			.replace(/Â?§/g, ' section ')
			.replace(/\s+/g, ' ') // collapse all whitespace (incl. newlines)
			.trim()
			.toLowerCase()
	);
}

/**
 * Issue #1896: bounded, diagnostic description of WHY an ACCEPTANCE text failed
 * to cover a requirement body. The coverage check is a SUBSTRING match
 * (`acceptance.includes(body)`), so "first divergence" is defined against the
 * best-aligning window: the longest prefix of the normalized expected body that
 * still appears as a substring of the normalized acceptance. `divergenceOffset`
 * is the length of that matched prefix; the snippets show the expected text at
 * the break and the acceptance text where the match ran out. All scans and
 * snippets are capped so this stays O(1)-bounded on large spec bodies. When the
 * raw (pre-normalization) text carries mojibake markers (a `??` run, U+FFFD, or a
 * Latin-1 `Â`-prefixed byte), a corruption hint is attached — this is the signal
 * that unblocks the destroyed-`§`-as-`??` case the diagnostic exists for.
 */
export interface CoverageMissDiagnostic {
	expectedSnippet: string;
	foundSnippet: string;
	divergenceOffset: number;
	/**
	 * Issue #2204: the longest matching prefix fell under
	 * `COVERAGE_DIAG_MIN_PREFIX`, so the "divergence" is coincidental
	 * punctuation/noise rather than a real aligned prefix — the requirement
	 * text is effectively absent from ACCEPTANCE. Renderers must emit the
	 * "requirement text completely missing" fallback instead of a
	 * divergence pointer.
	 *
	 * Issue #2215: a SUFFIX of the body `COVERAGE_DIAG_MIN_PREFIX`+ characters
	 * long that occurs as a substring ANYWHERE in the acceptance text ALSO
	 * prevents this flag from being set. So the flag means: no ≥10-char prefix
	 * of the body AND no ≥10-char suffix of the body appears anywhere in the
	 * acceptance text. A body that is present but not aligned at character 0
	 * (e.g. sitting behind a leading id-label glue, or embedded mid-prompt with
	 * other dispatch fields around it) keeps the divergence-pointer rendering.
	 */
	completelyMissing?: boolean;
	corruptionHint?: string;
}

const COVERAGE_DIAG_SNIPPET_CAP = 80;
const COVERAGE_DIAG_MAX_SCAN = 400;
/**
 * Issue #2204: minimum longest-matching-prefix length for the divergence
 * pointer to be meaningful. Below this, the match is treated as coincidental
 * (e.g. a short shared prefix, such as the `": "` after a field label — the
 * colon is only illustrative; ANY short coincidental content triggers this)
 * and the diagnostic reports the requirement text as completely missing
 * instead of pointing at a random "divergence" word in the prompt.
 *
 * Issue #2215: the SAME threshold is applied to the longest SUFFIX of the body
 * that occurs as a substring anywhere in the acceptance text, so a body whose
 * tail is present in ACCEPTANCE is treated as present-but-shifted rather than
 * absent.
 */
const COVERAGE_DIAG_MIN_PREFIX = 10;

/**
 * Issue #2063 (A2): per-body cap, in characters, on the raw requirement body
 * embedded verbatim in the ACCEPTANCE_FIELD_COVERAGE_MISMATCH error. Keeps the
 * thrown message bounded even for an unusually long FR/SC body; when a body
 * exceeds this cap the message states the cap and points at `.swarm/spec.md`
 * for the remainder rather than growing the error without limit.
 */
export const ACCEPTANCE_EXPECTED_BODY_CAP = 2000;

/**
 * Issue #2215: length of the longest SUFFIX of `expected` that occurs as a
 * substring ANYWHERE in `acceptance`, bounded by `maxScan` so this stays
 * O(1)-bounded on large spec bodies exactly like the prefix growth loop in
 * `describeCoverageMiss`.
 *
 * True symmetric counterpart to that loop: the prefix loop grows a PREFIX of
 * `expected` and asks `acceptance.includes(...)`; this grows a SUFFIX of
 * `expected` and asks the same question. It is anchored only on the `expected`
 * side — it does NOT assume the match sits at the literal end of `acceptance`,
 * because the "acceptance text" this diagnostic receives is the full delegation
 * prompt blob (`prompt`/`description`/`task`/`input`/`message` concatenated at
 * the toolBefore call site), not a narrow slice of the ACCEPTANCE field. The
 * dispatch examples in src/agents/architect.ts place `SKILLS:` after
 * `ACCEPTANCE:`, and `SKILLS:` is optional (coder.ts, reviewer.ts) and can
 * also be auto-injected after this check runs — so a verbatim body may sit
 * mid-blob or at its tail, and searching anywhere covers both. (A
 * tail-position character compare would miss the mid-blob case and falsely
 * report the body absent.)
 *
 * The greedy grow-until-it-fails loop is exact: if a suffix of length k is a
 * substring of `acceptance`, every shorter suffix is a substring of that one,
 * so "is a substring" is monotone in k and the first failure is the maximum.
 */
function longestCommonSuffixLength(
	expected: string,
	acceptance: string,
	maxScan: number,
): number {
	let len = 0;
	const cap = Math.min(expected.length, maxScan);
	while (
		len < cap &&
		acceptance.includes(expected.slice(expected.length - len - 1))
	) {
		len++;
	}
	return len;
}

export function describeCoverageMiss(params: {
	rawExpectedBody: string;
	rawAcceptanceText: string;
	normalizedExpected: string;
	normalizedAcceptance: string;
}): CoverageMissDiagnostic {
	const { normalizedExpected, normalizedAcceptance } = params;
	// Longest prefix of the expected body that is still a substring of the
	// acceptance text (bounded scan). Since the full body is NOT a substring
	// (that is why we are here), this stops at a proper prefix.
	let divergenceOffset = 0;
	const maxScan = Math.min(normalizedExpected.length, COVERAGE_DIAG_MAX_SCAN);
	while (
		divergenceOffset < maxScan &&
		normalizedAcceptance.includes(
			normalizedExpected.slice(0, divergenceOffset + 1),
		)
	) {
		divergenceOffset++;
	}
	const raw = `${params.rawExpectedBody}\n${params.rawAcceptanceText}`;
	let corruptionHint: string | undefined;
	if (/�/.test(raw)) {
		corruptionHint =
			'the text contains U+FFFD (the Unicode replacement char), a sign spec.md was decoded with the wrong encoding — re-save spec.md as UTF-8';
	} else if (/\?{2,}/.test(raw)) {
		corruptionHint =
			"the text contains a '??' run — a non-UTF-8 save can turn characters like § into ?? on disk; open .swarm/spec.md and re-type the affected character, then re-save as UTF-8";
	} else if (/Ã.|â€|Â[^\s]/.test(raw)) {
		corruptionHint =
			'the text contains a Latin-1 mojibake byte sequence (e.g. Â§, Ã©) — re-save spec.md as UTF-8';
	}
	// #2204: a sub-threshold longest-matching-prefix is coincidental noise (a
	// short shared run such as a `": "` after a field label — the colon is only
	// illustrative, ANY short coincidental content lands here), not an aligned
	// prefix. But a failed prefix alone does NOT prove the body is absent, so
	// #2215 checks the symmetric anchor before declaring it missing.
	if (divergenceOffset < COVERAGE_DIAG_MIN_PREFIX) {
		const suffixLen = longestCommonSuffixLength(
			normalizedExpected,
			normalizedAcceptance,
			COVERAGE_DIAG_MAX_SCAN,
		);
		if (suffixLen < COVERAGE_DIAG_MIN_PREFIX) {
			// Neither a meaningful PREFIX nor a meaningful SUFFIX of the requirement
			// body occurs anywhere in ACCEPTANCE — the text is genuinely absent, not
			// just a coincidental short prefix match (#2204).
			return {
				expectedSnippet: normalizedExpected.slice(0, COVERAGE_DIAG_SNIPPET_CAP),
				foundSnippet: '',
				divergenceOffset: 0,
				completelyMissing: true,
				...(corruptionHint ? { corruptionHint } : {}),
			};
		}
		// #2215: a meaningful SUFFIX of the body was found somewhere in ACCEPTANCE
		// even though nothing aligns from position 0 — the text is PRESENT but
		// shifted, e.g. by a leading id-label glue (a spec bullet of the form
		// `- **FR-001**: <body>` leaves a `": "` on the body extracted
		// by `extractSpecRequirementBodyById`, so a verbatim paste written as
		// `FR-001 - <body>` misaligns by two characters) or by spec.md-side
		// corruption near — not at — the start (#1896's destroyed `§`-as-`??`).
		// Point at the mismatched HEAD region instead of falsely claiming the text
		// is absent. `divergenceOffset` stays 0, which is accurate (nothing
		// meaningful aligns from the very start — any match there is under
		// `COVERAGE_DIAG_MIN_PREFIX`) and flows into the renderer's "(no aligned
		// prefix found)" divergence-pointer branch.
		const matchedSuffix = normalizedExpected.slice(
			normalizedExpected.length - suffixLen,
		);
		// >= 0 by construction: `matchedSuffix` is exactly the last window
		// `longestCommonSuffixLength` confirmed with `.includes()`. The match can
		// sit ANYWHERE in ACCEPTANCE (the prompt blob usually continues past it,
		// e.g. with a trailing `SKILLS:` line), so its position must be located
		// rather than computed from `normalizedAcceptance.length`.
		const foundIdx = normalizedAcceptance.indexOf(matchedSuffix);
		// `Math.max(0, …)` is defensive only: `suffixLen` cannot exceed
		// `normalizedExpected.length`, and it cannot EQUAL it either — that would
		// mean the whole body is a substring of ACCEPTANCE, and
		// `checkAcceptanceCoversFrRefs` only calls this function after the very
		// same `normalizedAcceptance.includes(normalizedExpected)` returned false.
		// So `expectedSnippet` below is always non-empty.
		const mismatchedHeadLen = Math.max(
			0,
			normalizedExpected.length - suffixLen,
		);
		const expectedSnippet = normalizedExpected.slice(
			0,
			Math.min(mismatchedHeadLen, COVERAGE_DIAG_SNIPPET_CAP),
		);
		// Show what precedes the matched region in ACCEPTANCE — that is where the
		// mismatched head lives. When the match starts at index 0 there is nothing
		// before it, so show the start of the matched content itself rather than
		// rendering an empty, confusing snippet.
		const foundSnippet =
			foundIdx > 0
				? normalizedAcceptance.slice(
						Math.max(0, foundIdx - COVERAGE_DIAG_SNIPPET_CAP),
						foundIdx,
					)
				: normalizedAcceptance.slice(
						0,
						Math.min(normalizedAcceptance.length, COVERAGE_DIAG_SNIPPET_CAP),
					);
		return {
			expectedSnippet,
			foundSnippet,
			divergenceOffset: 0,
			...(corruptionHint ? { corruptionHint } : {}),
		};
	}
	const expectedSnippet = normalizedExpected.slice(
		divergenceOffset,
		divergenceOffset + COVERAGE_DIAG_SNIPPET_CAP,
	);
	const matchedPrefix = normalizedExpected.slice(0, divergenceOffset);
	const foundIdx =
		matchedPrefix.length > 0 ? normalizedAcceptance.indexOf(matchedPrefix) : -1;
	const foundPos = foundIdx >= 0 ? foundIdx + matchedPrefix.length : 0;
	const foundSnippet = normalizedAcceptance.slice(
		foundPos,
		foundPos + COVERAGE_DIAG_SNIPPET_CAP,
	);
	return {
		expectedSnippet,
		foundSnippet,
		divergenceOffset,
		...(corruptionHint ? { corruptionHint } : {}),
	};
}

/**
 * Builds the ACCEPTANCE_FIELD_COVERAGE_MISMATCH error (#1687/#1896/#2063/#2204
 * contract). Exported pure so the message contract — normalized-compare note,
 * divergence pointer vs #2204 completely-missing fallback, mojibake warning,
 * fenced paste-ready requirement body with its cap, and the anti-spelunking
 * directive — stays unit-testable even though #2205's injection makes the
 * toolBefore throw structurally unreachable today (injection and the
 * coverage recheck share the same field list, id-resolution, and
 * normalization logic, so whatever injection covers, the recheck also
 * considers covered). This stays wired as defense-in-depth against a FUTURE
 * divergence — e.g. someone edits `injectSpecRequirementsIntoAcceptance`'s
 * field list, unknown-id handling, or normalization without updating
 * `checkAcceptanceCoversFrRefs` to match, or vice versa.
 */
export function buildAcceptanceCoverageMismatchError(params: {
	targetAgent: string;
	coverageTaskId: string | null;
	coverageResult: {
		covered: boolean;
		missingId?: string;
		diagnostic?: CoverageMissDiagnostic;
		expectedBody?: string;
	};
}): Error {
	const { targetAgent, coverageTaskId, coverageResult } = params;
	// #1896: the compare is a NORMALIZED substring match (Unicode NFC +
	// punctuation/whitespace folding), not a raw byte compare — so the
	// diagnostic below points at the first NORMALIZED divergence and, when
	// the text looks mojibake'd, says so.
	const diag = coverageResult.diagnostic;
	const diagLines: string[] = [];
	if (diag) {
		if (diag.completelyMissing) {
			// #2204: the sub-threshold prefix match is coincidental noise —
			// do NOT point at a "divergence" word; state the text is absent.
			// #2215: the flag now also requires the SUFFIX probe to fail, so
			// say so. Note this only reports what the two anchor probes
			// checked, not an absolute claim about the whole body: a middle
			// portion of the requirement CAN still be present verbatim in
			// ACCEPTANCE (e.g. an id-label prefix glued on the front plus a
			// truncated tail) while both anchor probes still miss.
			diagLines.push(
				`  neither the leading nor the trailing ${COVERAGE_DIAG_MIN_PREFIX} characters of the requirement text were found anywhere in ACCEPTANCE (a shorter or partial match is treated as coincidental)`,
			);
			diagLines.push(`  spec requires here: "${diag.expectedSnippet}"`);
			diagLines.push(
				'  ACCEPTANCE has here: "[Requirement text completely missing from prompt]"',
			);
		} else {
			diagLines.push(
				`  first divergence at normalized offset ${diag.divergenceOffset}` +
					(diag.divergenceOffset === 0 ? ' (no aligned prefix found)' : ''),
			);
			diagLines.push(`  spec requires here: "${diag.expectedSnippet}"`);
			diagLines.push(`  ACCEPTANCE has here: "${diag.foundSnippet}"`);
		}
		if (diag.corruptionHint) {
			diagLines.push(`  ENCODING WARNING: ${diag.corruptionHint}`);
		}
	}
	// #2063 A2: embed the raw, untrimmed requirement body verbatim (fenced,
	// capped) so the architect can paste it directly instead of re-reading
	// spec.md. `normalizeAcceptanceText`'s leading list-marker strip is
	// POSITION-dependent (only a line-initial `- `/`* ` is stripped), so a
	// bulleted multi-line body flattened onto one line can false-fail even
	// when "pasted verbatim" — hence the explicit line-break instruction.
	const rawExpectedBody = coverageResult.expectedBody ?? '';
	const truncated = rawExpectedBody.length > ACCEPTANCE_EXPECTED_BODY_CAP;
	const expectedBodyBlock = truncated
		? `${rawExpectedBody.slice(0, ACCEPTANCE_EXPECTED_BODY_CAP)}\n…[truncated — read the remainder from .swarm/spec.md under ${coverageResult.missingId}]`
		: rawExpectedBody;
	return new Error(
		`ACCEPTANCE_FIELD_COVERAGE_MISMATCH: the ${targetAgent} delegation for task ${coverageTaskId} was blocked because its ACCEPTANCE field does not cover the requirement text for ${coverageResult.missingId} from .swarm/spec.md (compared after Unicode/whitespace normalization, not raw bytes).\n${diagLines.join('\n')}\n` +
			`Replace your ACCEPTANCE text for ${coverageResult.missingId} with the exact requirement text below, ` +
			`PRESERVING ITS LINE BREAKS, then re-dispatch (body capped at ${ACCEPTANCE_EXPECTED_BODY_CAP} chars` +
			`${truncated ? ', truncated below' : ''}):\n` +
			'```\n' +
			`${expectedBodyBlock}\n` +
			'```\n' +
			`(see the ACCEPTANCE FIELD RESOLUTION section of your system prompt for how ACCEPTANCE is derived; ` +
			`if the ENCODING WARNING above is present, repair .swarm/spec.md first, then re-dispatch.) ` +
			`Do NOT investigate the installed swarm plugin package (node_modules/opencode-swarm, ~/.cache/opencode) ` +
			`— the fix is in your dispatch content, not in plugin internals. If this same error repeats after 2 fix ` +
			`attempts, STOP and present the blocker to the user.`,
	);
}

/**
 * FR-001/FR-002/FR-005/SC-001/SC-002/SC-006 (issue #1687): mechanical coverage
 * check that the ACCEPTANCE text CONTAINS the verbatim requirement body for each
 * mapped spec id. Fail-open by construction:
 *  - an id not present in spec.md (unknown/typo/renamed) is SKIPPED, never blocked;
 *  - an id whose body normalizes to empty is SKIPPED (neither trivially covered
 *    nor a miss);
 *  - each id is checked INDEPENDENTLY (per-id substring), because the architect
 *    concatenates multiple requirement bodies with an UNSPECIFIED separator — a
 *    whole-string equality compare would false-block multi-FR tasks.
 *
 * @returns `{ covered: true }` when every id is present-and-covered or skipped;
 *   `{ covered: false, missingId }` naming the FIRST id whose body is not a
 *   substring of the ACCEPTANCE text, plus `expectedBody` — the RAW, UNTRIMMED
 *   requirement body for `missingId` (issue #2063 A2) — so the throw site can
 *   embed paste-ready remediation text instead of just pointing at a location.
 */
export function checkAcceptanceCoversFrRefs(params: {
	acceptanceText: string;
	frRefs: string[];
	specText: string;
}): {
	covered: boolean;
	missingId?: string;
	diagnostic?: CoverageMissDiagnostic;
	expectedBody?: string;
} {
	const normalizedAcceptance = normalizeAcceptanceText(params.acceptanceText);
	for (const id of params.frRefs) {
		const body = extractSpecRequirementBodyById(params.specText, id);
		if (body === null) continue; // unknown id — fail-open skip
		const normalizedBody = normalizeAcceptanceText(body);
		if (normalizedBody.length === 0) continue; // empty body — skip
		if (!normalizedAcceptance.includes(normalizedBody)) {
			// #1896: surface WHAT diverged (bounded diff + encoding-corruption hint)
			// so the architect can fix the copy/encoding without hex-dumping spec.md.
			return {
				covered: false,
				missingId: id,
				diagnostic: describeCoverageMiss({
					rawExpectedBody: body,
					rawAcceptanceText: params.acceptanceText,
					normalizedExpected: normalizedBody,
					normalizedAcceptance,
				}),
				// Raw (pre-normalization) body, untrimmed — #2063 A2 embeds this
				// verbatim (fenced) in the thrown error so the architect can paste
				// it directly instead of re-reading spec.md.
				expectedBody: body,
			};
		}
	}
	return { covered: true };
}

/** Args fields (in precedence order) that may carry the ACCEPTANCE header. */
const ACCEPTANCE_ARGS_FIELDS = [
	'prompt',
	'description',
	'task',
	'input',
	'message',
] as const;

export interface AcceptanceInjectionOutcome {
	/** The args field that carried the ACCEPTANCE header and was mutated. */
	field: (typeof ACCEPTANCE_ARGS_FIELDS)[number];
	/** Spec ids whose verbatim bodies were appended. */
	injectedIds: string[];
}

/**
 * Issue #2205: programmatically guarantee verbatim FR/SC fidelity in the
 * ACCEPTANCE field. The architect lists the task's mapped FR-###/SC-### ids on
 * the ACCEPTANCE line (or pastes bodies itself, legacy style); this helper
 * appends the VERBATIM requirement body from .swarm/spec.md — prefixed with the
 * id, on its own line inside the ACCEPTANCE section — for every mapped id the
 * current ACCEPTANCE text does not already cover, mutating the args field in
 * place so the downstream coder/reviewer receives the exact requirement text.
 *
 * Coverage uses the SAME normalized-substring test as
 * `checkAcceptanceCoversFrRefs` (shared helpers, no drift), so:
 *  - an already-verbatim legacy dispatch is a no-op;
 *  - an id missing from spec.md is skipped (fail-open, mirrored semantics);
 *  - after injection, every extractable id is covered by construction.
 *
 * Returns null when nothing was injected (no ACCEPTANCE header in any field,
 * or every mapped id already covered). Throws never — mechanical failures are
 * the caller's concern (the coverage block is already fail-open).
 */
export function injectSpecRequirementsIntoAcceptance(params: {
	args: Record<string, unknown>;
	frRefs: string[];
	specText: string;
}): AcceptanceInjectionOutcome | null {
	const headerRe = /^ACCEPTANCE:[ \t]*(.*)$/i;
	let field: (typeof ACCEPTANCE_ARGS_FIELDS)[number] | undefined;
	let lines: string[] | undefined;
	let headerIdx = -1;
	for (const candidate of ACCEPTANCE_ARGS_FIELDS) {
		const value = params.args[candidate];
		if (typeof value !== 'string' || !/ACCEPTANCE:/i.test(value)) continue;
		const candidateLines = value.split(/\r?\n/);
		const idx = candidateLines.findIndex((line) => headerRe.test(line));
		if (idx >= 0) {
			field = candidate;
			lines = candidateLines;
			headerIdx = idx;
			break;
		}
	}
	if (!field || !lines || headerIdx < 0) return null;

	const normalizedAcceptance = normalizeAcceptanceText(lines.join('\n'));
	// Dedupe frRefs so a literal duplicate id in the caller's list is never
	// injected twice — the "already covered" check below is a snapshot taken
	// once before the loop and never reflects blocks queued earlier in this
	// same run.
	const uniqueFrRefs = [...new Set(params.frRefs)];
	const injectedIds: string[] = [];
	const injectionBlocks: string[] = [];
	for (const id of uniqueFrRefs) {
		const body = extractSpecRequirementBodyById(params.specText, id);
		if (body === null) continue; // unknown id — fail-open skip
		if (normalizedAcceptance.includes(normalizeAcceptanceText(body))) {
			continue; // already covered verbatim — nothing to inject
		}
		injectedIds.push(id);
		// trim(): extractSpecRequirementBodyById returns the RAW body (untrimmed,
		// leading space after the bold span); the injected block reads cleaner
		// trimmed, and the coverage compare normalizes whitespace anyway.
		//
		// NOT capped: the post-injection `checkAcceptanceCoversFrRefs` recheck
		// requires the FULL, UNCAPPED normalized body to be a substring of the
		// dispatch text ("after injection, every extractable id is covered by
		// construction" — see this function's docblock). Capping here would
		// break that invariant for any body longer than the cap, hard-blocking
		// a dispatch that should have succeeded.
		const trimmedBody = body.trim();
		injectionBlocks.push(`${id}: ${trimmedBody}`);
	}
	if (injectedIds.length === 0) return null;
	// Insert right after the ACCEPTANCE header line. A `FR-###:`/`SC-###:` line
	// does NOT match the next-field-header pattern (`^[A-Z][A-Z0-9_]*:` cannot
	// span the `-`), so the injected bodies stay INSIDE the ACCEPTANCE section.
	lines.splice(headerIdx + 1, 0, injectionBlocks.join('\n'));
	params.args[field] = lines.join('\n');
	logger.log(
		'[delegation-gate] injected verbatim requirement text into ACCEPTANCE',
		{ field, injected_ids: injectedIds.join(',') },
	);
	return { field, injectedIds };
}

interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
}

interface MessagePart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface MessageWithParts {
	info: MessageInfo;
	parts: MessagePart[];
}

/**
 * Extracts the TASK line content from the delegation text.
 * Returns the content after "TASK:" or null if not found.
 */
function extractTaskLine(text: string): string | null {
	const match = text.match(/TASK:\s*(.+?)(?:\n|$)/i);
	return match ? match[1].trim() : null;
}

/**
 * Extracts a plan task ID (N.M or N.M.P format) from text.
 * Checks for:
 * 1. Task IDs in task list format: "- [ ] 1.1: ..." or "- [x] 1.1: ..."
 * 2. Standalone task IDs like "1.1" or "1.2.3" near the TASK: line
 * Returns the plan task ID if found, otherwise null.
 */
function extractPlanTaskId(text: string): string | null {
	// Pattern 1: Task list format "- [ ] N.M: ..." or "- [x] N.M: ..."
	const taskListMatch = text.match(
		/^[ \t]*-[ \t]*(?:\[[ x]\][ \t]+)?(\d+\.\d+(?:\.\d+)*)[:. ]/m,
	);
	if (taskListMatch) {
		return taskListMatch[1];
	}

	// Pattern 2: Look for N.M or N.M.P near the TASK: line
	// Match "TASK: N.M ..." or "TASK: ... N.M ..." or standalone "N.M" after TASK:
	const taskLineMatch = text.match(
		/TASK:\s*(?:.+?\s)?(\d+\.\d+(?:\.\d+)*)(?:\s|$|:)/i,
	);
	if (taskLineMatch) {
		return taskLineMatch[1];
	}

	return null;
}

function outputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (typeof output === 'number' || typeof output === 'boolean') {
		return String(output);
	}
	if (Array.isArray(output)) {
		return output.map(outputText).filter(Boolean).join('\n');
	}
	if (output && typeof output === 'object') {
		const record = output as Record<string, unknown>;
		const preferred = ['output', 'text', 'content', 'message', 'result'];
		const parts: string[] = [];
		for (const key of preferred) {
			if (key in record) parts.push(outputText(record[key]));
		}
		if (parts.length > 0) return parts.filter(Boolean).join('\n');
		try {
			return JSON.stringify(output);
		} catch {
			return '';
		}
	}
	return '';
}

function extractPlanCriticVerdict(
	output: unknown,
): 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | null {
	const text = outputText(output);
	if (!text) return null;

	// Primary signal (highest confidence): a `VERDICT: <TOKEN>` line. The critic
	// system prompt (src/agents/critic.ts) instructs this exact shape, so a
	// conforming critic always matches here. Also tolerates markdown-bold labels
	// (`**VERDICT**:`) which LLMs frequently emit despite the plain instruction.
	const primary =
		/^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(APPROVED|NEEDS_REVISION|REJECTED)\b/im.exec(
			text,
		);
	if (primary) {
		return primary[1].toUpperCase() as
			| 'APPROVED'
			| 'NEEDS_REVISION'
			| 'REJECTED';
	}

	// Fallback 1: a `## Verdict` (or `### Verdict`, …) heading followed (within
	// 2 lines) by a line whose only non-whitespace content is the verdict token.
	// Matches critics that emit the verdict under a markdown heading instead of
	// the `VERDICT:` label. The heading must be the verdict section specifically
	// (not e.g. `## PLAN REVIEW`), so the `Verdict` word is required.
	const heading = /^(#{1,6})\s*Verdict\s*$/im.exec(text);
	if (heading && heading.index !== undefined) {
		const after = text.slice(heading.index + heading[0].length);
		const nextLines = after.split('\n').slice(0, 3).join('\n');
		const headingMatch = /^\s*(APPROVED|NEEDS_REVISION|REJECTED)\s*$/im.exec(
			nextLines,
		);
		if (headingMatch) {
			return headingMatch[1].toUpperCase() as
				| 'APPROVED'
				| 'NEEDS_REVISION'
				| 'REJECTED';
		}
	}

	// Fallback 2: a BARE verdict token on its own line — but ONLY in the final
	// few lines of output (so a mid-review mention like "this is approved for
	// execution" cannot trigger it) and ONLY when the line does not contain a
	// `|` separator (which marks the critic-rubric template line
	// `VERDICT: APPROVED | NEEDS_REVISION | REJECTED`, an enumeration rather
	// than a real verdict) and is not inside a fenced code block.
	//
	// Issue #2012: real critics do not always emit the `VERDICT:` label, and a
	// missing snapshot here permanently wedges every coder delegation because
	// the gate is ratchet-tighter with no escape hatch. The tail-only + no-pipe
	// + no-code-fence guards keep false positives out while recovering the
	// common "the critic just wrote APPROVED at the end" case.
	const lines = text.split('\n');
	const tailStart = Math.max(0, lines.length - 6);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		// Match 3+ backticks so a 4-backtick fenced block (common for nested
		// code blocks) also toggles the fence state, not just exactly ```.
		// The regex is "3 or more backtick characters" — the {3,} quantifier
		// applies to the single preceding backtick literal.
		if (/^\s*(?:`{3,})/.test(lines[i])) inFence = !inFence;
		if (i < tailStart) continue;
		if (inFence) continue;
		const line = lines[i];
		if (line.includes('|')) continue;
		const bare = /^\s*(APPROVED|NEEDS_REVISION|REJECTED)\s*$/i.exec(line);
		if (bare) {
			return bare[1].toUpperCase() as
				| 'APPROVED'
				| 'NEEDS_REVISION'
				| 'REJECTED';
		}
	}

	return null;
}

function taskLooksLikePlanCritic(args: Record<string, unknown>): boolean {
	const text = [
		args.prompt,
		args.task,
		args.description,
		args.message,
		args.input,
	]
		.filter((value): value is string => typeof value === 'string')
		.join('\n')
		.toLowerCase();
	if (!text) return false;
	// Broad-recall-biased on purpose: the caller already narrows to
	// `subagent_type === 'critic'` (a target the trusted architect controls), so
	// a false positive is low-risk, while a false negative silently blocks ALL
	// EXECUTE-phase coder work with no auto-recovery. Any single signal below —
	// drawn from the phrasings the critic-gate/plan skills tell the architect to
	// send — is therefore sufficient; no AND-pairing.
	return PLAN_CRITIC_TASK_SIGNALS.some((signal) => text.includes(signal));
}

// Substrings that, in a dispatch to `subagent_type: 'critic'`, mark it as a
// plan critic-gate review. Kept lowercase (text is lowercased before matching).
const PLAN_CRITIC_TASK_SIGNALS = [
	'critic-gate', // "MODE: CRITIC-GATE", "critic-gate protocol/review"
	'plan critic',
	'review plan',
	'review the plan',
	'plan.md', // critic-gate/SKILL.md: "Send the full plan.md content"
	'approve the plan',
	'plan approval',
	// Issue #2012: realistic architect phrasings that the original 7 signals
	// silently missed, wedging the ratchet-tighter critic_pre_plan gate with
	// no recovery. These are safe to add: the caller already narrows to
	// `subagent_type === 'critic'` (a target the trusted architect controls),
	// so a false positive is low-risk, while a false negative silently blocks
	// ALL EXECUTE-phase coder work with no auto-recovery.
	'pre-implementation review',
	'evaluate this plan',
	'evaluate the plan',
	'assess this plan',
	'assess the plan',
	'plan soundness',
	'before implementation',
	'review the plan below',
] as const;

/**
 * Returns whether the plan in the given directory has a valid plan-critic
 * approval. Does not throw — returns `false` for any failure (fail-closed).
 */
export async function isPlanCriticApproved(
	directory: string,
): Promise<boolean> {
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (!plan) return false;

		const planId = derivePlanId(plan);
		const approved = await loadLastPlanCriticApprovedSnapshot(
			directory,
			planId,
		);
		if (!approved) return false;
		if (
			approved.approval?.verdict !== 'APPROVED' ||
			approved.approval?.source !== 'plan_critic_gate'
		)
			return false;
		if (approved.payloadHash !== computePlanStructureHash(plan)) return false;
		return true;
	} catch {
		return false;
	}
}

async function assertPlanCriticApprovedForExecution(
	directory: string,
	plan: Plan | null,
): Promise<void> {
	if (!plan) return;

	const planId = derivePlanId(plan);
	// Use the plan-critic-scoped loader (not the general loadLastApprovedPlan):
	// it looks PAST unrelated `critic_approved` snapshots (e.g. per-phase
	// drift-verification snapshots from write-drift-evidence.ts) to find the
	// snapshot carrying the `plan_critic_gate` approval marker. Otherwise a later
	// drift snapshot would shadow a still-valid plan-critic approval (bug F-A2).
	const approved = await loadLastPlanCriticApprovedSnapshot(directory, planId);
	if (!approved) {
		throw new Error(
			'PLAN_CRITIC_GATE_VIOLATION: Cannot delegate to coder before plan critic approval. ' +
				'Delegate to critic in MODE: CRITIC-GATE and require VERDICT: APPROVED before EXECUTE. ' +
				'If the critic already returned APPROVED but the snapshot was not recorded ' +
				'(format/signal mismatch — issue #2012), call approve_plan_critic with a reason, ' +
				'or run /swarm approve-plan-critic <reason>, to record a manual approval.',
		);
	}

	// Verdict is still load-bearing: the loader filters on the plan_critic_gate
	// marker but not on the verdict value, so a (malformed) non-APPROVED
	// plan-critic snapshot must still be rejected here.
	if (
		approved.approval?.verdict !== 'APPROVED' ||
		approved.approval?.source !== 'plan_critic_gate'
	) {
		throw new Error(
			'PLAN_CRITIC_GATE_VIOLATION: Latest approved-plan snapshot does not contain plan critic VERDICT: APPROVED evidence. ' +
				'Re-run MODE: CRITIC-GATE and wait for explicit approval before coder execution. ' +
				'If the critic already returned APPROVED but the snapshot was not recorded ' +
				'(issue #2012), call approve_plan_critic or run /swarm approve-plan-critic.',
		);
	}

	// Compare STRUCTURAL hashes (excluding phase/task status). The plan-critic
	// snapshot is taken while all tasks are `pending`, but the EXECUTE skill
	// mandates flipping the current task to `in_progress` (a status-only
	// mutation, dual-written into plan.json) BEFORE delegating its coder. A
	// status-inclusive comparison would therefore fire on the first conforming
	// coder dispatch of every run (bug F-A1). An actual structural change
	// (description, files, dependencies, ...) still trips this staleness check.
	if (approved.payloadHash !== computePlanStructureHash(plan)) {
		throw new Error(
			'PLAN_CRITIC_GATE_VIOLATION: Current plan differs from the last critic-approved snapshot. ' +
				'Re-run MODE: CRITIC-GATE after plan changes before delegating to coder. ' +
				'If re-review is not possible, call approve_plan_critic or run ' +
				'/swarm approve-plan-critic to record a fresh manual approval for the current plan.',
		);
	}
}

/**
 * Resolve the effective critic-pre-plan policy for coder execution.
 *
 * Missing or unreadable profiles preserve the historical default (`true`). A
 * persisted `false` is honored, while session overrides can only ratchet it
 * back to `true` through `getEffectiveGates`.
 */
export interface PlanCriticPolicyDecision {
	required: boolean;
	source:
		| 'persisted_profile'
		| 'session_ratchet'
		| 'default_missing_profile'
		| 'corrupt_profile_conservative';
}

export function resolvePlanCriticPolicyForExecution(
	directory: string,
	plan: Plan,
	sessionOverrides: Partial<QaGates> = {},
): PlanCriticPolicyDecision {
	try {
		const profile = getProfileForIdentity(directory, {
			swarm: plan.swarm,
			title: plan.title,
		});
		if (!profile) {
			return {
				required: DEFAULT_QA_GATES.critic_pre_plan,
				source: 'default_missing_profile',
			};
		}
		const required = getEffectiveGates(
			profile,
			sessionOverrides,
		).critic_pre_plan;
		return {
			required,
			source:
				sessionOverrides.critic_pre_plan === true &&
				profile.gates.critic_pre_plan === false
					? 'session_ratchet'
					: 'persisted_profile',
		};
	} catch (error) {
		logger.warn(
			`[delegation-gate] failed to resolve critic_pre_plan profile; enforcing the gate: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { required: true, source: 'corrupt_profile_conservative' };
	}
}

async function recordPlanCriticApprovalSnapshotIfApplicable(
	directory: string,
	input: { sessionID: string; callID: string },
	args: Record<string, unknown>,
	output: unknown,
): Promise<void> {
	const targetAgent =
		typeof args.subagent_type === 'string'
			? stripKnownSwarmPrefix(args.subagent_type)
			: null;
	if (targetAgent !== 'critic') return;
	if (!taskLooksLikePlanCritic(args)) return;
	if (extractPlanCriticVerdict(output) !== 'APPROVED') return;

	// Issue #2012: a critic APPROVED verdict that fails to record a snapshot
	// permanently wedges the ratchet-tighter critic_pre_plan gate (no escape
	// hatch). loadPlanJsonOnly can transiently return null if the critic
	// dispatch landed microseconds before a concurrent save_plan flush. The
	// architect skill ordering (save_plan → CRITIC-GATE) is the primary
	// guarantee; this bounded retry is cheap insurance against the race so a
	// legitimate APPROVED is not silently dropped. Keep attempts tiny — the
	// common path resolves on the first read.
	let plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		for (let attempt = 0; attempt < 2 && !plan; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			plan = await loadPlanJsonOnly(directory);
		}
	}
	if (!plan) {
		logger.warn(
			`[delegation-gate] plan critic APPROVED verdict could not be recorded: ` +
				`plan.json not readable after retry. The critic_pre_plan gate will ` +
				`block coder delegation until a snapshot exists. Call ` +
				`approve_plan_critic (or /swarm approve-plan-critic) with a reason ` +
				`to record a manual approval if the critic genuinely approved.`,
		);
		return;
	}

	// Store the STRUCTURAL hash (status-excluded) as the snapshot's payload_hash
	// so `assertPlanCriticApprovedForExecution` can match this approval after the
	// architect flips the current task to `in_progress` before delegating its
	// coder. This MUST be the same hash function the gate compares against
	// (`computePlanStructureHash`), or the staleness check would never match.
	await takeSnapshotEvent(directory, plan, {
		source: 'critic_approved',
		approvalMetadata: {
			verdict: 'APPROVED',
			source: 'plan_critic_gate',
			session_id: input.sessionID,
			call_id: input.callID,
			approved_at: new Date().toISOString(),
		},
		payloadHashOverride: computePlanStructureHash(plan),
	});
}

/**
 * Escape hatch for the ratchet-tighter `critic_pre_plan` gate (issue #2012).
 *
 * When the critic returns APPROVED but the mechanical snapshot recorder
 * ({@link recordPlanCriticApprovalSnapshotIfApplicable}) fails to persist it
 * (verdict-format mismatch, dispatch-signal miss, or a plan.json read race),
 * the gate blocks coder delegations when the effective `critic_pre_plan`
 * policy is enabled. This records a manual `plan_critic_gate` approval snapshot
 * so the gate unblocks, with a
 * distinct `method: 'manual_override'` audit marker so a human or downstream
 * review can distinguish a manual approval from a mechanical critic approval.
 *
 * This mirrors the established escape-hatch pattern (PR_REVIEW gate #1898:
 * `abortPrWorkflow` + `/swarm abort-pr-workflow` + `abort_pr_workflow` tool).
 *
 * Fail-closed preconditions:
 * - The session must be an active **architect** session. The escape hatch is an
 *   escalation; non-architect callers are rejected so a coder/reviewer cannot
 *   self-unblock.
 * - A plan.json must exist; you cannot approve a non-existent plan.
 *
 * @param directory - Project root containing `.swarm/`
 * @param sessionID - The caller's session id (must be an architect session)
 * @param options.reason - Optional human/agent-supplied reason (audited)
 * @param options.userConfirmed - `true` only when invoked via the restricted
 *   `/swarm approve-plan-critic` command (human-run); `false` when invoked via
 *   the `approve_plan_critic` tool (agent-initiated). Recorded in the audit so a
 *   self-approve is visible.
 */
export async function forceRecordPlanCriticApproval(
	directory: string,
	sessionID: string,
	options: { reason?: string; userConfirmed?: boolean } = {},
): Promise<{
	planId: string;
	recordedAt: string;
	reason?: string;
	userConfirmed: boolean;
}> {
	const session = ensureAgentSession(sessionID);
	// Defense-in-depth: the approve_plan_critic tool is registered in
	// AGENT_TOOL_MAP.architect only, so only the architect can call it. But the
	// /swarm approve-plan-critic command passes the *current* sessionID, whose
	// agentName may not be the architect (e.g. a user ran it while a coder was
	// active). Require the active session to be the architect so a non-architect
	// context cannot self-unblock the gate. agentName may be swarm-prefixed.
	if (
		!session ||
		!session.agentName ||
		stripKnownSwarmPrefix(session.agentName) !== 'architect'
	) {
		throw new Error(
			'NOT_AUTHORIZED: approve_plan_critic requires an active architect session. ' +
				'The plan-critic gate escape hatch is an architect-only escalation; ' +
				'a coder/reviewer cannot self-unblock. Run /swarm approve-plan-critic ' +
				'from an architect context, or ask the user to run it.',
		);
	}

	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		// loadPlanJsonOnly returns null for missing, corrupt, OR schema-invalid
		// plan.json. Distinguish so the user knows whether to save a plan or
		// repair a corrupt one.
		const planPath = path.join(directory, '.swarm', 'plan.json');
		if (fs.existsSync(planPath)) {
			throw new Error(
				'PLAN_CORRUPT: .swarm/plan.json exists but could not be parsed ' +
					'(corrupt or schema-invalid). Repair or re-save the plan before ' +
					'recording a plan-critic approval.',
			);
		}
		throw new Error(
			'PLAN_NOT_FOUND: no .swarm/plan.json — cannot record a plan-critic ' +
				'approval for a non-existent plan. Save a plan first.',
		);
	}

	const planId = derivePlanId(plan);
	const recordedAt = new Date().toISOString();
	const sanitizedReason =
		typeof options.reason === 'string' && options.reason.trim().length > 0
			? options.reason.trim().slice(0, 500)
			: undefined;
	const userConfirmed = options.userConfirmed === true;

	// Write a snapshot the gate's scoped loader accepts. `source: 'plan_critic_gate'`
	// MUST match {@link loadLastPlanCriticApprovedSnapshot}'s extraFilter so the
	// gate unblocks; `method: 'manual_override'` distinguishes it from a
	// mechanical critic approval for audit/review.
	await takeSnapshotEvent(directory, plan, {
		source: 'critic_approved',
		approvalMetadata: {
			verdict: 'APPROVED',
			source: 'plan_critic_gate',
			method: 'manual_override',
			reason: sanitizedReason,
			user_confirmed: userConfirmed,
			session_id: sessionID,
			approved_at: recordedAt,
		},
		payloadHashOverride: computePlanStructureHash(plan),
	});

	// Best-effort non-fatal audit event (matches abortPrWorkflow / knowledge-gate
	// precedent). The snapshot is authoritative for the gate; the audit event is
	// the human-readable trail. Issue #2039: appended through the core event
	// seam.
	try {
		appendCoreEventSync(directory, {
			type: 'plan_critic_gate_manual_approval',
			timestamp: recordedAt,
			sessionID,
			plan_id: planId,
			user_confirmed: userConfirmed,
			...(sanitizedReason ? { reason: sanitizedReason } : {}),
		});
	} catch (err) {
		logger.warn(
			`[delegation-gate] plan_critic_gate_manual_approval audit event write failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		planId,
		recordedAt,
		...(sanitizedReason ? { reason: sanitizedReason } : {}),
		userConfirmed,
	};
}

const ACTIVE_PARALLEL_TASK_STATES = new Set([
	'coder_delegated',
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
]);

function isTaskCompletedForParallelGuidance(task: Task): boolean {
	const status = task.status ?? 'pending';
	return status === 'completed' || status === 'closed';
}

function getPlanTaskDeclaredFiles(
	plan: Plan | null,
	taskId: string | null,
): string[] | null {
	if (!plan || !taskId) return null;
	for (const phase of plan.phases) {
		const task = phase.tasks.find((candidate) => candidate.id === taskId);
		if (task) return [...task.files_touched];
	}
	return null;
}

export function resolveDelegatedPlanTaskId(
	args: Record<string, unknown>,
	knownPlanTaskIds?: ReadonlySet<string>,
): string | null {
	// Prefer plan-task-shaped explicit task_id/taskId fields. The arg name is
	// generic and is overloaded by newer OpenCode runtimes (and by our own
	// worktree-isolation pre-create at delegation-gate/worktree-isolation.ts:836)
	// to carry a child SESSION id (e.g. `ses_…`), not a plan-task id. A
	// non-plan-shaped value means "this field is not ours" — fall through to
	// TASK: line / prompt-text extraction instead of fail-closing on what is
	// really a runtime-injected session reuse handle. (Issue #1914 Defect 1.)
	//
	// This reverts the PR #961 bypass-guard for the non-plan-shaped case only.
	// Plan-task-shaped values still win over prompt text (preserves PR #961's
	// "explicit id takes precedence" intent). Plan-task-shaped-but-unknown ids
	// are rejected by the membership gate in prepareCoderScope (typo protection,
	// acceptance criterion 2).
	//
	// The guard is general (not `ses_`-prefix-specific) so future runtime
	// session-id shapes don't silently re-break dispatches.
	const rawTaskId = args.task_id ?? args.taskId;
	if (typeof rawTaskId === 'string') {
		const trimmed = rawTaskId.trim();
		if (trimmed.length <= 20 && isStrictTaskId(trimmed)) return trimmed;
		// Non-plan-shaped explicit value (e.g. `ses_…`) — fall through to text
		// extraction below. Do NOT return null here.
	}

	// Text field extraction: collect ALL distinct task IDs to detect ambiguity.
	// Uses direct regex rather than extractPlanTaskId because that helper returns
	// only the first match per field, which misses multi-ID prompts.
	const candidateTextFields = [
		args.prompt,
		args.description,
		args.task,
		args.input,
	];

	// Strong signal: when delegation text includes a TASK: line, prefer IDs from
	// that line even if other task IDs appear elsewhere in the same prompt.
	const taskLineMatches = new Set<string>();
	for (const field of candidateTextFields) {
		if (typeof field !== 'string') continue;
		const taskLine = extractTaskLine(field);
		if (!taskLine) continue;
		for (const m of taskLine.matchAll(/\b(\d+\.\d+(?:\.\d+)*)\b/g)) {
			const candidate = m[1];
			if (!isStrictTaskId(candidate)) continue;
			if (knownPlanTaskIds && !knownPlanTaskIds.has(candidate)) continue;
			taskLineMatches.add(candidate);
		}
	}
	if (taskLineMatches.size === 1) {
		return taskLineMatches.values().next().value as string;
	}
	if (taskLineMatches.size > 1) return null;

	const seen = new Set<string>();
	for (const field of candidateTextFields) {
		if (typeof field !== 'string') continue;
		for (const m of field.matchAll(/\b(\d+\.\d+(?:\.\d+)*)\b/g)) {
			const candidate = m[1];
			if (isStrictTaskId(candidate)) {
				// Filter against known plan task IDs when available — excludes
				// version numbers and other numeric-dot patterns that aren't tasks.
				if (knownPlanTaskIds && !knownPlanTaskIds.has(candidate)) continue;
				seen.add(candidate);
			}
		}
	}

	// Fail closed on ambiguity — multiple distinct IDs means we can't determine intent.
	if (seen.size === 1) return seen.values().next().value as string;
	return null;
}

/**
 * Builds a cause-specific diagnostic for `prepareCoderScope`'s SCOPE_NOT_DECLARED
 * throw when `resolveDelegatedPlanTaskId` returns null. Re-runs extraction with
 * diagnostics enabled so the architect can self-correct in one turn instead of
 * guessing. Issue #1914 Defect 2.
 *
 * Only invoked on the null-resolution failure path — does not affect happy-path
 * latency, and does NOT handle plan-task-shaped-but-unknown ids (those are
 * rejected by the membership gate in prepareCoderScope with their own message).
 */
function describeCoderScopeFailure(
	args: Record<string, unknown>,
	planTaskIds: ReadonlySet<string>,
): string {
	const known = [...planTaskIds].sort().join(', ') || '(none)';
	const rawTaskId = args.task_id ?? args.taskId;
	const explicitFieldShape =
		typeof rawTaskId === 'string' && rawTaskId.trim().length > 0
			? `"${rawTaskId.trim().slice(0, 40)}" (non-plan-shaped; treated as runtime session id and ignored — falling through to text extraction)`
			: 'absent';
	const candidateTextFields = [
		args.prompt,
		args.description,
		args.task,
		args.input,
	];
	const taskLineCandidates = new Set<string>();
	let taskLineDetected = false;
	for (const field of candidateTextFields) {
		if (typeof field !== 'string') continue;
		const taskLine = extractTaskLine(field);
		if (!taskLine) continue;
		taskLineDetected = true;
		for (const m of taskLine.matchAll(/\b(\d+\.\d+(?:\.\d+)*)\b/g)) {
			if (planTaskIds.has(m[1])) taskLineCandidates.add(m[1]);
		}
	}
	const textCandidates = new Set<string>();
	for (const field of candidateTextFields) {
		if (typeof field !== 'string') continue;
		for (const m of field.matchAll(/\b(\d+\.\d+(?:\.\d+)*)\b/g)) {
			if (planTaskIds.has(m[1])) textCandidates.add(m[1]);
		}
	}
	if (taskLineCandidates.size > 1) {
		return `multiple candidate task ids found in TASK: line: [${[...taskLineCandidates].sort().join(', ')}]; provide exactly one unambiguous TASK: <id> line. Known plan task ids: ${known}.`;
	}
	if (textCandidates.size > 1) {
		return `multiple candidate task ids found in prompt text: [${[...textCandidates].sort().join(', ')}]; provide exactly one unambiguous TASK: <id> line. Known plan task ids: ${known}.`;
	}
	return `no plan task id could be resolved. Include a TASK: <N.M> line or plan-task-shaped task_id arg. Explicit task_id field: ${explicitFieldShape}. TASK: line detected: ${taskLineDetected ? 'yes' : 'no'}. Known plan task ids: ${known}.`;
}

function stripSingleTrailingAnnotationSuffix(value: string): string | null {
	const suffixMatch = value.match(/(?:\s+\([^()]*\))+$/);
	if (!suffixMatch) return value;
	const suffix = suffixMatch[0];
	const annotationGroups = suffix.match(/\([^()]*\)/g) ?? [];
	if (annotationGroups.length !== 1) return null;
	const normalized = value.slice(0, -suffix.length).trimEnd();
	return normalized || null;
}

function normalizeFileDirectiveValue(rawValue: string): string | null {
	const value = rawValue.trim();
	if (!value) return null;

	const quote = value[0];
	if (quote === '"' || quote === "'") {
		const closingQuoteIndex = value.indexOf(quote, 1);
		if (closingQuoteIndex === -1) return null;

		const filePath = value.slice(1, closingQuoteIndex);
		if (!filePath) return null;

		const suffix = value.slice(closingQuoteIndex + 1);
		if (suffix.length > 0 && !/^\s+\([^()]*\)\s*$/.test(suffix)) return null;
		return filePath;
	}

	// A parenthetical is commentary only when it is a single balanced,
	// non-nested, whitespace-separated terminal suffix. Internal parentheses and
	// nested/unbalanced trailing forms are preserved as literal path text here;
	// downstream scope validation still rejects those malformed targets fail
	// closed instead of silently changing the declared file.
	const normalized = stripSingleTrailingAnnotationSuffix(value);
	if (!normalized || /[,;|]/.test(normalized)) return null;
	return normalized;
}

type FileDirectiveExtractionMode = 'enforce' | 'observe';

function extractTaskFileDirectives(
	args: Record<string, unknown>,
	mode?: FileDirectiveExtractionMode,
): {
	present: boolean;
	files: string[] | null;
} {
	const files = new Set<string>();
	let present = false;
	for (const field of [args.prompt, args.description, args.task, args.input]) {
		if (typeof field !== 'string') continue;
		for (const line of field.split(/\r?\n/)) {
			if (!/^\s*FILE\s*:/i.test(line)) continue;
			present = true;
			const value = normalizeFileDirectiveValue(
				line.replace(/^\s*FILE\s*:\s*/i, ''),
			);
			if (!value) {
				if (mode === 'observe') continue;
				return { present: true, files: null };
			}
			files.add(value);
		}
	}
	return { present, files: present && files.size > 0 ? [...files] : null };
}

/**
 * Parses structured per-task verdict lines from agent dispatch output.
 *
 * Recognized formats:
 *   [REVIEWED] | task-2.1 | APPROVED | ...
 *   [TESTED] | task-2.1 | PASS | ...
 *   [REVIEWED] | 2.1 | APPROVED | ...   (bare task ID without prefix)
 *
 * Returns a Map from task ID to verdict string (e.g. "APPROVED", "REJECTED", "PASS", "FAIL").
 * Only task IDs matching strict task ID format (N.M or N.M.P) are included.
 * Lines that don't match the pattern are silently ignored.
 *
 * @param outputText - Raw text output from the agent dispatch
 * @returns StageBAttributionResult with typed verdicts and any parsing errors
 */
export interface VerdictEntry {
	verdict: string;
	kind: 'REVIEWED' | 'TESTED';
}

export interface StageBAttributionResult {
	verdicts: Map<string, VerdictEntry>;
	errors: string[];
}

export function parsePerTaskVerdicts(
	outputText: string,
): StageBAttributionResult {
	const verdicts = new Map<string, VerdictEntry>();
	const errors: string[] = [];
	const reviewedPattern =
		/^\[REVIEWED\]\s*\|\s*(?:task-)?(\d+\.\d+(?:\.\d+)*)\s*\|\s*(APPROVED|REJECTED|CONCERNS)\s*\|?/im;
	const testedPattern =
		/^\[TESTED\]\s*\|\s*(?:task-)?(\d+\.\d+(?:\.\d+)*)\s*\|\s*(PASS|FAIL|SKIPPED)\s*\|?/im;

	for (const line of outputText.split(/\r?\n/)) {
		const trimmed = line.trim();
		let match = reviewedPattern.exec(trimmed);
		if (match) {
			const taskId = match[1];
			const verdict = match[2];
			if (isStrictTaskId(taskId)) {
				const existing = verdicts.get(taskId);
				if (existing) {
					if (existing.verdict !== verdict || existing.kind !== 'REVIEWED') {
						errors.push(
							`STAGE_B_VERDICT_CONFLICT: task ${taskId} has conflicting verdicts: ${existing.kind}/${existing.verdict} vs REVIEWED/${verdict}`,
						);
					}
				} else {
					verdicts.set(taskId, { verdict, kind: 'REVIEWED' });
				}
			}
			continue;
		}
		match = testedPattern.exec(trimmed);
		if (match) {
			const taskId = match[1];
			const verdict = match[2];
			if (isStrictTaskId(taskId)) {
				const existing = verdicts.get(taskId);
				if (existing) {
					if (existing.verdict !== verdict || existing.kind !== 'TESTED') {
						errors.push(
							`STAGE_B_VERDICT_CONFLICT: task ${taskId} has conflicting verdicts: ${existing.kind}/${existing.verdict} vs TESTED/${verdict}`,
						);
					}
				} else {
					verdicts.set(taskId, { verdict, kind: 'TESTED' });
				}
			}
		}
	}
	return { verdicts, errors };
}

/**
 * Plural variant of resolveDelegatedPlanTaskId that returns ALL discovered task IDs
 * rather than failing closed on ambiguity. Used when a single agent covers multiple tasks
 * (set-dispatch) and we need per-task attribution.
 */
async function findTaskAwaitingCompletion(
	directory: string | undefined,
	requestedTaskId?: string | null,
): Promise<string | null> {
	if (!directory) return null;

	let plan: Plan | null = null;
	try {
		plan = await loadPlanJsonOnly(directory);
	} catch {
		return null;
	}
	if (!plan) return null;

	const { getTaskWorkflowSnapshot, readTaskEvidence } = await import(
		'../gate-evidence'
	);
	const tasks = plan.phases.flatMap((phase) => phase.tasks);
	const orderedTasks = requestedTaskId
		? [
				...tasks.filter((task) => task.id === requestedTaskId),
				...tasks.filter((task) => task.id !== requestedTaskId),
			]
		: tasks;
	for (const task of orderedTasks) {
		const taskId = task.id;
		const evidence = await readTaskEvidence(directory, taskId);
		const workflow = getTaskWorkflowSnapshot(evidence);
		const councilEvidence = evidence?.gates.council as
			| (Record<string, unknown> & { verdict?: string })
			| undefined;
		const awaitsQaCompletion =
			workflow.authoritative && workflow.state === 'tests_run';
		const awaitsCouncilCompletion =
			workflow.authoritative &&
			workflow.state === 'pre_check_passed' &&
			councilEvidence?.verdict === 'APPROVE';
		if (!awaitsQaCompletion && !awaitsCouncilCompletion) continue;

		const planStatus = task.status ?? 'pending';
		if (
			planStatus === 'completed' ||
			planStatus === 'closed' ||
			planStatus === 'blocked'
		)
			continue;

		return taskId;
	}

	return null;
}

function completionGateViolationMessage(
	taskAwaitingCompletion: string,
): string {
	return (
		`TASK_COMPLETION_GATE_VIOLATION: Task ${taskAwaitingCompletion} reached tests_run but is not marked completed in plan.json/plan.md. ` +
		`Call update_task_status with task_id="${taskAwaitingCompletion}" and status="completed". ` +
		'Read-only inspection remains available; a proven-disjoint task may continue; if plan.json is ledger-stale, retry save_plan with reconcile_ledger_projection=true and otherwise-unchanged plan content.'
	);
}

type CoderRetryEscalationAction =
	| 'sounding_board_consultation'
	| 'simplification'
	| 'user_escalation';

/**
 * Issue #2039: escalation audit state moved off raw events.jsonl scans to
 * the authoritative core event index (index answer UNION the bounded
 * retained-window scan). Verdict semantics are identical to the previous
 * whole-file scan for everything within the window, and complete after
 * compaction via the index (the fold pass indexes authority lines before
 * removing them).
 */
function readCoderRetryEscalations(
	directory: string,
	taskId: string,
	retryEpoch: number,
): Set<CoderRetryEscalationAction> {
	return getCoderRetryEscalationActions(directory, taskId, retryEpoch);
}

async function emitCoderRetryEscalation(
	directory: string,
	input: {
		taskId: string;
		generation: number;
		retryEpoch: number;
		rejectionCount: number;
		rejectionHistory: string[];
		action: CoderRetryEscalationAction;
	},
): Promise<void> {
	// Issue #2039: the store's exclusive lock replaces the former
	// tryAcquireLock/proper-lockfile sentinel on this file, and
	// dedupeOnAuthorityKey restores the at-most-once contract the old
	// lock-then-recheck read enforced. The hard-fail contract is preserved —
	// sustained contention still throws TASK_RETRY_AUDIT_LOCKED.
	try {
		appendCoreEventSync(
			directory,
			{
				type: 'coder_retry_circuit_breaker',
				timestamp: new Date().toISOString(),
				taskId: input.taskId,
				generation: input.generation,
				retryEpoch: input.retryEpoch,
				rejectionCount: input.rejectionCount,
				rejectionHistory: input.rejectionHistory,
				phase: Number(input.taskId.split('.')[0]) || 0,
				action: input.action,
			},
			{ dedupeOnAuthorityKey: true },
		);
	} catch (error) {
		if (error instanceof Error && error.message === CORE_EVENT_LOCKED) {
			throw new Error('TASK_RETRY_AUDIT_LOCKED');
		}
		throw error;
	}
}

async function enforceCoderRetryEscalation(input: {
	directory: string;
	taskId: string;
	generation: number;
	retryEpoch: number;
	retryCount: number;
	retryHistory: string[];
	criticSatisfied: boolean;
}): Promise<void> {
	if (input.retryCount < 3) return;
	let prior: Set<CoderRetryEscalationAction>;
	try {
		prior = readCoderRetryEscalations(
			input.directory,
			input.taskId,
			input.retryEpoch,
		);
	} catch (error) {
		// A corrupt authority index fails closed (the pre-#2039 malformed-JSONL
		// throw had the same effect) — surface a typed, diagnosable code.
		if (
			error instanceof Error &&
			error.message === 'CORE_EVENT_AUTHORITY_INDEX_UNREADABLE'
		) {
			throw new Error('TASK_RETRY_AUDIT_INDEX_UNREADABLE');
		}
		throw error;
	}
	if (!prior.has('sounding_board_consultation')) {
		await emitCoderRetryEscalation(input.directory, {
			...input,
			rejectionCount: input.retryCount,
			rejectionHistory: input.retryHistory,
			action: 'sounding_board_consultation',
		});
		throw new Error(
			`TASK_RETRY_CRITIC_REQUIRED: task ${input.taskId} reached the bounded retry threshold. Dispatch critic_sounding_board for this exact task before another coder attempt.`,
		);
	}
	if (prior.has('simplification')) {
		await emitCoderRetryEscalation(input.directory, {
			...input,
			rejectionCount: input.retryCount,
			rejectionHistory: input.retryHistory,
			action: 'user_escalation',
		});
		throw new Error(
			`TASK_RETRY_USER_ESCALATION_REQUIRED: task ${input.taskId} failed its critic-guided simplified retry. Stop and ask the user to change scope, authorize repair, or choose a different approach.`,
		);
	}
	if (!input.criticSatisfied) {
		throw new Error(
			`TASK_RETRY_CRITIC_REQUIRED: task ${input.taskId} is waiting for an exact-generation critic_sounding_board APPROVED verdict.`,
		);
	}
	await emitCoderRetryEscalation(input.directory, {
		...input,
		rejectionCount: input.retryCount,
		rejectionHistory: input.retryHistory,
		action: 'simplification',
	});
	// One exact-generation coder retry is admitted after durable critic proof.
	// Accepted mutation rotates the generation while retryEpoch preserves the
	// circuit; any later failure progresses directly to user escalation.
}

const COMPLETION_RECOVERY_TOOLS = new Set([
	'get_approved_plan',
	'get_qa_gate_profile',
	'check_gate_status',
]);

const TASK_GATE_AGENTS = new Set([
	'reviewer',
	'test_engineer',
	'docs',
	'designer',
	'critic',
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'explorer',
	'sme',
]);

export function canRunWhileTaskAwaitsCompletion(input: {
	directory: string | undefined;
	normalizedTool: string;
	args: Record<string, unknown>;
	awaitingTaskId: string;
	requestedTaskId: string | null;
}): boolean {
	const normalizedTool = input.normalizedTool.toLowerCase();
	if (isReadOnlyTool(normalizedTool)) return true;
	if (COMPLETION_RECOVERY_TOOLS.has(normalizedTool)) return true;
	if (
		normalizedTool === 'spec_write' &&
		input.directory &&
		fs.existsSync(path.join(input.directory, '.swarm', 'spec-staleness.json'))
	) {
		return true;
	}

	if (
		normalizedTool === 'save_plan' &&
		input.args.reconcile_ledger_projection === true
	) {
		// save_plan performs the authoritative under-lock equality/tail check.
		return true;
	}

	if (
		normalizedTool === 'update_task_status' &&
		input.requestedTaskId === input.awaitingTaskId
	) {
		return true;
	}

	if (
		input.directory &&
		input.requestedTaskId &&
		input.requestedTaskId !== input.awaitingTaskId &&
		isProvablyDisjoint(input.directory, [
			input.awaitingTaskId,
			input.requestedTaskId,
		])
	) {
		return true;
	}

	return false;
}

async function buildParallelExecutionGuidance(
	directory: string | undefined,
	sessionID: string,
	session: AgentSessionState,
): Promise<string | null> {
	if (!directory) return null;

	const plan: Plan | null = await loadPlanJsonOnly(directory);
	if (!plan) {
		return null;
	}

	const profile = plan.execution_profile;
	const enabled = profile?.parallelization_enabled === true;
	const maxConcurrent = profile?.max_concurrent_tasks ?? 10;
	// Check for session-scoped concurrency override (Issue #761)
	// Override only applies in standard mode — Lean Turbo short-circuits above.
	let effectiveMaxConcurrent = session?.maxConcurrencyOverride ?? maxConcurrent;

	// Adaptive backoff on errors: detect failures and reduce concurrency.
	// Only count tasks explicitly blocked by a failure, not normal dependency
	// ordering. `blocked_reason` is set by the execution engine when a task
	// fails; absent or non-failure reasons (e.g. "waiting on dependency")
	// are NOT treated as backoff-worthy failures.
	const allTasks = plan.phases.flatMap((phase) => phase.tasks);
	const blockedTasks = allTasks.filter((task) => {
		if (task.status !== 'blocked') return false;
		const reason = (task.blocked_reason ?? '').toLowerCase();
		// Treat as a failure only when the reason explicitly indicates
		// execution failure. Falls back to conservative "count nothing"
		// when the reason is absent to avoid false-positive throttling.
		return (
			reason.includes('fail') ||
			reason.includes('error') ||
			reason.includes('exception')
		);
	});
	const totalTasks = allTasks.length;
	let backoffTriggered = false;

	if (totalTasks > 0 && blockedTasks.length > 0) {
		const failureRate = blockedTasks.length / totalTasks;
		// If failure rate exceeds 20%, reduce concurrency by 50%
		const FAILURE_RATE_THRESHOLD = 0.2;
		const BACKOFF_MULTIPLIER = 0.5;

		// Require at least 2 blocked tasks to avoid throttling on single-task
		// flakiness in small plans (e.g. 1/4 = 25% should not auto-reduce).
		if (failureRate > FAILURE_RATE_THRESHOLD && blockedTasks.length >= 2) {
			const newConcurrency = Math.max(
				1,
				Math.floor(effectiveMaxConcurrent * BACKOFF_MULTIPLIER),
			);
			if (newConcurrency < effectiveMaxConcurrent) {
				// Auto-reduce the effective concurrency due to high failure rate
				effectiveMaxConcurrent = newConcurrency;
				session.maxConcurrencyOverride = newConcurrency;
				backoffTriggered = true;
			}
		}
	}

	if (!enabled || effectiveMaxConcurrent <= 1) return null;

	if (hasActiveLeanTurbo(sessionID)) {
		return '[NEXT] Lean Turbo is active; use lean_turbo_run_phase and Lean Turbo lane guidance instead of standard execution-profile slot filling.';
	}

	const currentPhase =
		plan.current_phase !== undefined
			? plan.phases.find((phase) => phase.id === plan.current_phase)
			: plan.phases.find((phase) => !isParallelGuidancePhaseComplete(phase));
	if (!currentPhase) return null;

	const tasks = currentPhase.tasks;
	if (tasks.length === 0) return null;

	// #1674 v8 AUTOMATIC FALLBACK message: when parallelization is enabled but
	// the active phase's pending tasks are NOT provably file-disjoint, the gate
	// forces serial. Tell the architect exactly what happened and how to
	// inspect the conflict matrix, so it is never left guessing why parallel
	// dispatch was blocked.
	if (!scopeVerdictAllowsParallel(directory, plan)) {
		return `[PARALLEL EXECUTION PROFILE] parallelization_enabled=true max_concurrent_tasks=${effectiveMaxConcurrent}; the active phase's pending tasks are NOT provably file-disjoint (overlapping or unknown declared scopes) — SERIAL fallback active (v8 automatic safety). Run plan_conflict_check on the pending tasks to inspect the conflict matrix and a suggested serialization order, or proceed serially (one coder at a time).`;
	}

	const completed = new Set<string>();
	for (const task of allTasks) {
		const taskId = task.id;
		if (isTaskCompletedForParallelGuidance(task)) completed.add(taskId);
		if (getTaskState(session, taskId) === 'complete') completed.add(taskId);
	}

	// max_concurrent_tasks is a plan-level budget, so active work in earlier or
	// later phases still occupies a standard execution slot.
	const occupied = new Set<string>();
	for (const task of allTasks) {
		const taskId = task.id;
		if (task.status === 'in_progress') occupied.add(taskId);
		const state = getTaskState(session, taskId);
		if (ACTIVE_PARALLEL_TASK_STATES.has(state)) occupied.add(taskId);
	}

	const availableSlots = Math.max(0, effectiveMaxConcurrent - occupied.size);
	if (availableSlots <= 0) {
		return `[PARALLEL EXECUTION PROFILE] parallelization_enabled=true max_concurrent_tasks=${effectiveMaxConcurrent}; all standard execution slots are occupied. Continue current active task gates before starting more coder work.`;
	}

	const eligible = tasks
		.filter((task) => {
			const taskId = task.id;
			const status = task.status ?? 'pending';
			if (status !== 'pending') return false;
			if (occupied.has(taskId)) return false;
			return task.depends.every((dep) => completed.has(dep));
		})
		.map((task) => task.id)
		.slice(0, availableSlots);

	if (eligible.length === 0) {
		return `[PARALLEL EXECUTION PROFILE] parallelization_enabled=true max_concurrent_tasks=${effectiveMaxConcurrent}; no dependency-ready pending tasks are available for a new coder slot. Continue the current task/gate.`;
	}

	const failureWarning = backoffTriggered
		? ` (${blockedTasks.length} blocked task(s) detected — concurrency auto-reduced due to failures)`
		: '';

	return `[PARALLEL EXECUTION PROFILE] parallelization_enabled=true max_concurrent_tasks=${effectiveMaxConcurrent}; ${occupied.size} slot(s) occupied. Eligible now: ${eligible.join(', ')}. [NEXT] dispatch up to ${availableSlots} eligible coder task(s) before waiting; preserve ONE task per coder call and call declare_scope for each task.${failureWarning}`;
}

function isParallelGuidancePhaseComplete(phase: Phase): boolean {
	return (
		phase.status === 'complete' ||
		phase.status === 'completed' ||
		phase.status === 'closed'
	);
}

/**
 * #1674 v8: collect the pending-task ids of the active phase, mirroring
 * `buildParallelExecutionGuidance`'s `currentPhase` selection EXACTLY
 * (`plan.current_phase` first, else the first non-complete phase). The
 * execution gate uses this to compute the parallel/serial verdict over the
 * same task set the advisory guidance references, so the two never disagree.
 *
 * Returns `[]` when there is no active phase or no pending tasks in it.
 */
function collectPendingTaskIdsForActivePhase(plan: Plan): string[] {
	const currentPhase =
		plan.current_phase !== undefined
			? plan.phases.find((phase) => phase.id === plan.current_phase)
			: plan.phases.find((phase) => !isParallelGuidancePhaseComplete(phase));
	if (!currentPhase) return [];
	return currentPhase.tasks
		.filter((t) => t.status === 'pending')
		.map((t) => t.id);
}

/**
 * #1674 v8: compute whether the active phase's pending tasks are provably
 * file-disjoint. This is the AUTOMATIC fallback that enforces acceptance
 * criterion 4 (overlapping/unknown scopes → serial by default). Fail-safe:
 * any error → false (serial). Pure + bounded — the gate calls this inline
 * in `toolBefore` on every coder dispatch.
 */
function scopeVerdictAllowsParallel(directory: string, plan: Plan): boolean {
	try {
		const pendingTaskIds = collectPendingTaskIdsForActivePhase(plan);
		if (pendingTaskIds.length < 2) return false; // nothing to parallelize
		return (
			computeParallelVerdict(directory, pendingTaskIds).verdict ===
			'all_disjoint'
		);
	} catch {
		// Fail-safe serial: a verdict-computation failure must never permit
		// parallel dispatch on potentially-overlapping scopes.
		return false;
	}
}

/**
 * Returns the task ID for evidence recording, with fallback to taskWorkflowStates
 * and plan.json when currentTaskId and lastCoderDelegationTaskId are both null.
 * Uses synchronous disk reads for the plan.json fallback.
 * Security-hardened: validates paths and only swallows expected errors.
 */
async function getEvidenceTaskId(
	session: AgentSessionState,
	directory: string,
): Promise<string | null> {
	let resolvedPlanPath: string | undefined;
	// Primary: currentTaskId or lastCoderDelegationTaskId
	const primary = session.currentTaskId ?? session.lastCoderDelegationTaskId;
	if (primary) return primary;

	// Fallback: derive from taskWorkflowStates if it has entries
	if (session.taskWorkflowStates && session.taskWorkflowStates.size > 0) {
		// Return any key from the map (deterministic: first entry)
		return session.taskWorkflowStates.keys().next().value ?? null;
	}

	// Fallback: read from .swarm/plan.json to find first in_progress task
	// Security hardening: validate and resolve paths safely
	try {
		// Validate directory is a non-empty string
		if (typeof directory !== 'string' || directory.length === 0) {
			return null;
		}

		// Resolve both paths to normalize and check for path traversal
		const resolvedDirectory = path.resolve(directory);
		const planPath = path.join(resolvedDirectory, '.swarm', 'plan.json');
		resolvedPlanPath = path.resolve(planPath);

		// Security check: ensure resolved plan path is within the working directory
		// This prevents path traversal attacks (e.g., ../../etc/plan.json)
		if (
			!resolvedPlanPath.startsWith(resolvedDirectory + path.sep) &&
			resolvedPlanPath !== resolvedDirectory
		) {
			// Path traversal attempt detected - reject
			return null;
		}

		// Read and parse the plan file
		const planContent = await fs.promises.readFile(resolvedPlanPath, 'utf-8');
		const plan = EvidenceTaskIdPlanSchema.parse(JSON.parse(planContent));

		// Only expected: missing phases array or malformed structure - return null quietly
		if (!plan || !Array.isArray(plan.phases)) {
			return null;
		}

		for (const phase of plan.phases) {
			if (Array.isArray(phase.tasks)) {
				for (const task of phase.tasks) {
					if (task.status === 'in_progress') {
						return task.id ?? null;
					}
				}
			}
		}
	} catch (err) {
		if (err instanceof ZodError) {
			const issueSummary = err.issues
				.slice(0, 3)
				.map((issue) => issue.message)
				.join('; ');
			logger.warn(
				`[delegation-gate] getEvidenceTaskId ignored invalid plan schema at ${resolvedPlanPath ?? 'unknown path'}: ${issueSummary}`,
			);
			return null;
		}
		// v6.33.7: Never re-throw from getEvidenceTaskId.
		// Previously, unexpected errors (EPERM, EBUSY, etc.) were re-thrown,
		// which propagated out of the evidence try-catch (since this call was
		// outside it) and into the toolAfter chain.  On Windows, EBUSY from
		// virus scanner file locks caused the entire hook chain to fail.
		// Evidence task ID lookup is best-effort — return null on any error.
		if (process.env.DEBUG_SWARM && err instanceof Error) {
			logger.warn(
				`[delegation-gate] getEvidenceTaskId error: ${err.message} (code=${(err as NodeJS.ErrnoException).code ?? 'none'})`,
			);
		}
		return null;
	}

	return null;
}

/**
 * Resolves the correct task ID for evidence recording by chaining:
 * 1. Explicit task_id in direct args (structured field)
 * 2. Prompt-text extraction via resolveDelegatedPlanTaskId (plan-aware)
 * 3. Session-state fallback via getEvidenceTaskId
 *
 * This fixes parallel evidence recording where multiple reviewer/test_engineer
 * agents are dispatched for different tasks from the same architect session.
 * Issue #970.
 */
async function resolveEvidenceTaskId(
	args: Record<string, unknown> | undefined,
	session: AgentSessionState,
	directory: string,
): Promise<string | null> {
	// Step 1: Explicit task_id in direct args
	const rawTaskId = args?.task_id;
	if (
		typeof rawTaskId === 'string' &&
		rawTaskId.length <= 20 &&
		isStrictTaskId(rawTaskId.trim())
	) {
		return rawTaskId.trim();
	}

	// Step 2: Prompt-text extraction via resolveDelegatedPlanTaskId with plan-aware filtering
	// When plan is unavailable, skip text extraction entirely to prevent version-like
	// patterns (e.g. "v6.33.7") from being misidentified as task IDs.
	if (args) {
		try {
			const plan = await loadPlanJsonOnly(directory);
			if (plan) {
				const planTaskIds = new Set(
					plan.phases.flatMap((p) => p.tasks.map((t) => t.id)),
				);
				const promptTaskId = resolveDelegatedPlanTaskId(args, planTaskIds);
				if (promptTaskId) return promptTaskId;
			}
			// Plan unavailable — skip text extraction, fall through to session state
		} catch {
			// Plan unavailable — proceed to session fallback
		}
	}

	// Step 3: Session-state fallback
	return getEvidenceTaskId(session, directory);
}

const recordPendingDelegationForBackground: typeof import('../background/pending-delegations.js').recordPendingDelegationDetailed =
	async (...args) =>
		(
			await import('../background/pending-delegations.js')
		).recordPendingDelegationDetailed(...args);

function sameReplayPrompt(
	existing: BackgroundDelegationRecord['prompt'],
	incoming: RecordPendingInput['prompt'],
): boolean {
	if (existing === undefined || incoming === undefined) {
		return existing === incoming;
	}
	return (
		existing.digest === incoming.digest &&
		existing.chars === incoming.chars &&
		existing.truncated === incoming.truncated &&
		existing.text === incoming.text
	);
}

function hasStableBackgroundReplayIdentity(
	existing: BackgroundDelegationRecord,
	incoming: RecordPendingInput,
): boolean {
	return (
		existing.correlationId === incoming.correlationId &&
		existing.subagentSessionId === incoming.subagentSessionId &&
		existing.parentSessionId === incoming.parentSessionId &&
		existing.callID === incoming.callID &&
		existing.jobId === incoming.jobId &&
		existing.normalizedAgent === incoming.normalizedAgent &&
		existing.swarmPrefixedAgent === incoming.swarmPrefixedAgent &&
		existing.planTaskId === incoming.planTaskId &&
		existing.evidenceTaskId === incoming.evidenceTaskId &&
		sameReplayPrompt(existing.prompt, incoming.prompt)
	);
}

function hydrateBackgroundReplayInput(
	existing: BackgroundDelegationRecord,
	incoming: RecordPendingInput,
): RecordPendingInput {
	return {
		...incoming,
		workspace: existing.workspace,
		taskChangeContext: existing.taskChangeContext,
		worktree: existing.worktree,
		coderReservationId: existing.coderReservationId,
		prompt: existing.prompt,
		generation: existing.generation ?? 1,
	};
}

const writeDelegationFallbackForBackground: typeof import('../background/pending-delegations.js').writeDelegationFallback =
	async (...args) =>
		(
			await import('../background/pending-delegations.js')
		).writeDelegationFallback(...args);

const reserveBackgroundCoderSlotForDispatch: typeof import('../background/pending-delegations.js').reserveBackgroundCoderSlot =
	async (...args) =>
		(
			await import('../background/pending-delegations.js')
		).reserveBackgroundCoderSlot(...args);

const bindBackgroundCoderReservationForDispatch: typeof import('../background/pending-delegations.js').bindBackgroundCoderReservation =
	async (...args) =>
		(
			await import('../background/pending-delegations.js')
		).bindBackgroundCoderReservation(...args);

const releaseBackgroundCoderReservationForDispatch: typeof import('../background/pending-delegations.js').releaseBackgroundCoderReservation =
	async (...args) =>
		(
			await import('../background/pending-delegations.js')
		).releaseBackgroundCoderReservation(...args);

const maintainBackgroundDelegationsForDispatch: typeof import('../background/pending-delegations.js').maintainBackgroundDelegations =
	async (...args) =>
		(
			await import('../background/pending-delegations.js')
		).maintainBackgroundDelegations(...args);

/**
 * _internals export for testing — do not use in production code.
 * Exposes resolveEvidenceTaskId, resolveDelegatedPlanTaskId,
 * describeCoderScopeFailure, and buildParallelExecutionGuidance for unit testing.
 *
 * Worktree operation entries (provisionWorktree, removeWorktree, etc.) proxy
 * to delegation-gate/worktree-isolation._internals via getters/setters so
 * that test mutations on this object propagate to the extracted module.
 */
export const _internals = {
	resolveEvidenceTaskId,
	resolveDelegatedPlanTaskId,
	describeCoderScopeFailure,
	parsePerTaskVerdicts,
	buildParallelExecutionGuidance,
	extractTaskFileDirectives,
	loadPlanJsonOnly,
	recordPendingDelegationForBackground,
	writeDelegationFallbackForBackground,
	reserveBackgroundCoderSlotForDispatch,
	bindBackgroundCoderReservationForDispatch,
	releaseBackgroundCoderReservationForDispatch,
	maintainBackgroundDelegationsForDispatch,
	resetStandardWorktreeIsolationState,
	PLAN_CRITIC_TASK_SIGNALS,
	extractPlanCriticVerdict,
	forceRecordPlanCriticApproval,
	get provisionWorktree() {
		return _wtiInternals.provisionWorktree;
	},
	set provisionWorktree(v: typeof _wtiInternals.provisionWorktree) {
		_wtiInternals.provisionWorktree = v;
	},
	get removeWorktree() {
		return _wtiInternals.removeWorktree;
	},
	set removeWorktree(v: typeof _wtiInternals.removeWorktree) {
		_wtiInternals.removeWorktree = v;
	},
	get attemptMergeBackFromDirty() {
		return _wtiInternals.attemptMergeBackFromDirty;
	},
	set attemptMergeBackFromDirty(v: typeof _wtiInternals.attemptMergeBackFromDirty,) {
		_wtiInternals.attemptMergeBackFromDirty = v;
	},
	get postMergeCleanup() {
		return _wtiInternals.postMergeCleanup;
	},
	set postMergeCleanup(v: typeof _wtiInternals.postMergeCleanup) {
		_wtiInternals.postMergeCleanup = v;
	},
	get preserveBackgroundWorktreeOwnershipForCallId() {
		return _wtiInternals.preserveBackgroundWorktreeOwnershipForCallId;
	},
	set preserveBackgroundWorktreeOwnershipForCallId(v: typeof _wtiInternals.preserveBackgroundWorktreeOwnershipForCallId,) {
		_wtiInternals.preserveBackgroundWorktreeOwnershipForCallId = v;
	},
};

/**
 * Creates the experimental.chat.messages.transform hook for delegation gating.
 * Inspects coder delegations and warns when tasks are oversized or batched.
 */
export function createDelegationGateHook(
	config: PluginConfig,
	directory: string,
): {
	messagesTransform: (
		input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	) => Promise<void>;
	toolBefore: (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
		},
		output: { args: unknown },
	) => Promise<void>;
	toolAfter: (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
			args?: Record<string, unknown>;
		},
		output: unknown,
	) => Promise<void>;
	taskMetadata: (input: {
		callID: string;
		parentSessionID: string;
		childSessionID: string;
	}) => Promise<void>;
	sessionEnded: (sessionID: string, includeOwnedChildren?: boolean) => void;
	backgroundCompletionClaimed: (record: BackgroundDelegationRecord) => void;
	abortDeniedSettlementForCall: (callID: string) => Promise<void>;
} {
	// Initialize durable worktree merge-back status before any coders dispatch
	initDurableStatusPath(directory);

	const enabled =
		(config.hooks as Record<string, unknown> | undefined)?.delegation_gate !==
		false;
	const delegationMaxChars =
		((config.hooks as Record<string, unknown> | undefined)
			?.delegation_max_chars as number | undefined) ?? 4000;

	// Opt-in background-subagent support. When false (default), background swarm
	// Task dispatches remain fail-closed-blocked. When true, running placeholders
	// are durably tracked for later trusted completion settlement.
	const backgroundSubagentsEnabled =
		(config.hooks as Record<string, unknown> | undefined)
			?.background_subagents === true;
	const backgroundPendingTimeoutMs =
		(((config.hooks as Record<string, unknown> | undefined)
			?.background_pending_timeout_minutes as number | undefined) ?? 30) *
		60_000;
	const MAX_PENDING_CODER_CHANGE_CONTEXTS = 128;
	const coderTaskChangeContextByCallID = new Map<
		string,
		BackgroundTaskChangeContext
	>();
	// Issue #2214: callID → the settlement this dispatch durably began. Used by
	// (a) the toolBefore denial rollback when a LATER fail-closed hook rejects
	// the Task call after the delegation gate already wrote the DISPATCHED WAL
	// (no toolAfter will ever fire for a denied call), and (b) the toolAfter
	// coder evidence block when resolveEvidenceTaskId cannot recover the task
	// id the toolBefore scope preflight resolved. FIFO-capped like its siblings.
	const begunCoderSettlementsByCallID = new Map<
		string,
		{ taskId: string | null; transitionId: string }
	>();
	const rememberBegunCoderSettlement = (
		callID: string,
		taskId: string | null,
		transitionId: string,
	): void => {
		if (
			!begunCoderSettlementsByCallID.has(callID) &&
			begunCoderSettlementsByCallID.size >= MAX_PENDING_CODER_CHANGE_CONTEXTS
		) {
			// Fail closed like the sibling callID maps (PRR-002): silent FIFO
			// eviction here would drop a denial-rollback entry and could
			// re-introduce the #2214 DISPATCHED wedge under load.
			throw new Error(
				`BEGUN_SETTLEMENT_CONTEXT_CAPACITY: refusing coder dispatch because ${MAX_PENDING_CODER_CHANGE_CONTEXTS} live begun settlements are already tracked`,
			);
		}
		begunCoderSettlementsByCallID.set(callID, { taskId, transitionId });
	};
	const backgroundCoderReservationByCallID = new Map<
		string,
		BackgroundCoderReservation
	>();
	const coderObservedFilesByCallID = new Map<string, string[] | null>();
	const stageBDispatchGenerationsByCallID = new Map<
		string,
		Map<string, number>
	>();
	const gateDispatchPrimaryTaskByCallID = new Map<string, string | null>();

	interface StageBDispatchContext {
		taskIds: Set<string>;
		expectedVerdictKind: 'REVIEWED' | 'TESTED';
	}
	const stageBDispatchContextByCallID = new Map<
		string,
		StageBDispatchContext
	>();
	const publishedScopeBindingsByCallID = new Map<
		string,
		Array<{ directory: string; binding: PreparedCoderScope['binding'] }>
	>();
	const publishScopeBinding = async (
		callID: string,
		bindingDirectory: string,
		binding: PreparedCoderScope['binding'],
	): Promise<void> => {
		const published = await persistAndRegisterScopeBinding(
			bindingDirectory,
			binding,
		);
		if (!published.ok) {
			throw new Error(`${published.code}: ${published.message}`);
		}
		const entries = publishedScopeBindingsByCallID.get(callID) ?? [];
		entries.push({ directory: bindingDirectory, binding });
		publishedScopeBindingsByCallID.delete(callID);
		publishedScopeBindingsByCallID.set(callID, entries);
		while (publishedScopeBindingsByCallID.size > MAX_PENDING_SCOPE_BINDINGS) {
			const oldest = publishedScopeBindingsByCallID.keys().next().value;
			if (oldest === undefined) break;
			const evicted = publishedScopeBindingsByCallID.get(oldest) ?? [];
			publishedScopeBindingsByCallID.delete(oldest);
			for (const entry of evicted) {
				clearScopeBindingFromDisk({
					directory: entry.directory,
					binding: entry.binding,
				});
				clearExactScopeBinding(entry.binding);
			}
		}
	};
	const clearPublishedScopeBindings = (callID: string): void => {
		const entries = publishedScopeBindingsByCallID.get(callID) ?? [];
		publishedScopeBindingsByCallID.delete(callID);
		for (const entry of entries) {
			clearScopeBindingFromDisk({
				directory: entry.directory,
				binding: entry.binding,
			});
			clearExactScopeBinding(entry.binding);
		}
	};
	const taskMetadata = async (input: {
		callID: string;
		parentSessionID: string;
		childSessionID: string;
	}): Promise<void> => {
		const result = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: input.parentSessionID,
			childSessionId: input.childSessionID,
			dispatchCallId: input.callID,
		});
		if (!result.ok) {
			if (result.code === 'SCOPE_NOT_DECLARED') return;
			throw new Error(`${result.code}: ${result.message}`);
		}
		const { previous, claimed } = result.value;
		const entries = publishedScopeBindingsByCallID.get(input.callID) ?? [];
		for (const entry of entries) {
			if (
				entry.directory === directory &&
				entry.binding.bindingId === previous.bindingId &&
				entry.binding.generationId === previous.generationId
			) {
				entry.binding = claimed;
			}
		}
		const childSession = ensureAgentSession(
			input.childSessionID,
			'coder',
			directory,
		);
		// Issue #2134: a delegation start is a fresh coder run, so it starts from a
		// clean PRM escalation ladder.
		//
		// `agentSessions` entries are never removed when a delegated session ends —
		// `sessionEnded` below clears scope bindings only, and `endAgentSession` is
		// reached solely from `/swarm close` and the Lean Turbo runner. A coder
		// session that ended while `prmHardStopPending` was armed therefore left a
		// live DENY token in the map; if that sessionID was reused, the next
		// delegation's very FIRST tool call was denied with "Pattern escalation
		// maximum reached" — the symptom reported in #2134, surviving restarts
		// because it never depended on disk state at all.
		//
		// Guarded on the dispatch callID: `taskMetadata` is driven by
		// `message.part.updated`, which fires repeatedly for the same Task part
		// while the child runs. Resetting unconditionally would clear the ladder on
		// every update and disarm PRM for the whole delegation.
		if (childSession.prmDelegationCallId !== input.callID) {
			childSession.prmDelegationCallId = input.callID;
			resetPrmSessionState(childSession, input.childSessionID);
		}
		childSession.currentTaskId = claimed.taskId;
		childSession.declaredCoderScope = [...claimed.files];
	};
	const sessionEnded = (
		sessionID: string,
		includeOwnedChildren = false,
	): void => {
		if (!sessionID) return;
		const removed = clearScopeBindings(
			(binding) =>
				binding.ownerSessionId === sessionID ||
				(includeOwnedChildren && binding.parentOwnerSessionId === sessionID),
		);
		for (const binding of removed) {
			clearScopeBindingFromDisk({
				directory: binding.workspaceIdentity,
				binding,
			});
		}
		if (
			removed.some(
				(binding) =>
					binding.ownerSessionId === sessionID &&
					binding.activation === 'active',
			)
		) {
			const endedSession = swarmState.agentSessions.get(sessionID);
			if (endedSession) {
				endedSession.currentTaskId = null;
				endedSession.declaredCoderScope = null;
			}
		}
		for (const [callID, entries] of publishedScopeBindingsByCallID) {
			const remaining = entries.filter(
				(entry) =>
					entry.binding.ownerSessionId !== sessionID &&
					(!includeOwnedChildren ||
						entry.binding.parentOwnerSessionId !== sessionID),
			);
			if (remaining.length === 0) publishedScopeBindingsByCallID.delete(callID);
			else if (remaining.length !== entries.length)
				publishedScopeBindingsByCallID.set(callID, remaining);
		}
	};
	const clearCoderTaskChangeContext = (callID: string): void => {
		coderTaskChangeContextByCallID.delete(callID);
		coderObservedFilesByCallID.delete(callID);
	};
	const rememberStageBDispatchGenerations = (
		callID: string,
		generations: Map<string, number>,
	): void => {
		if (
			!stageBDispatchGenerationsByCallID.has(callID) &&
			stageBDispatchGenerationsByCallID.size >=
				MAX_PENDING_CODER_CHANGE_CONTEXTS
		) {
			throw new Error(
				`STAGE_B_CONTEXT_CAPACITY: refusing Stage B dispatch because ${MAX_PENDING_CODER_CHANGE_CONTEXTS} live generation bindings are already tracked`,
			);
		}
		stageBDispatchGenerationsByCallID.set(callID, generations);
	};
	const releasePrelaunchBackgroundCoderReservation = async (
		callID: string,
	): Promise<void> => {
		const reservation = backgroundCoderReservationByCallID.get(callID);
		if (!reservation) return;
		const released =
			await _internals.releaseBackgroundCoderReservationForDispatch(directory, {
				...reservation,
				reason: 'recovered',
			});
		if (released) {
			backgroundCoderReservationByCallID.delete(callID);
			return;
		}
		logger.warn(
			`[delegation-gate] pre-launch background coder reservation ${reservation.reservationId} could not be released; later admission remains fail-closed`,
		);
	};
	const rememberCoderObservedFiles = (
		callID: string,
		observedFiles: string[] | null,
	): void => {
		if (
			!coderObservedFilesByCallID.has(callID) &&
			coderObservedFilesByCallID.size >= MAX_PENDING_CODER_CHANGE_CONTEXTS
		) {
			const oldest = coderObservedFilesByCallID.keys().next().value;
			if (oldest !== undefined) coderObservedFilesByCallID.delete(oldest);
		}
		coderObservedFilesByCallID.set(callID, observedFiles);
	};
	const rememberCoderTaskChangeContext = (
		callID: string,
		declaredFiles: string[] | null,
		observationDirectory = directory,
		workflowGeneration?: number,
	): void => {
		if (
			!coderTaskChangeContextByCallID.has(callID) &&
			coderTaskChangeContextByCallID.size >= MAX_PENDING_CODER_CHANGE_CONTEXTS
		) {
			throw new Error(
				`BACKGROUND_CODER_CONTEXT_CAPACITY: refusing coder dispatch because ${MAX_PENDING_CODER_CHANGE_CONTEXTS} live change baselines are already tracked`,
			);
		}
		coderTaskChangeContextByCallID.set(callID, {
			declaredFiles,
			baseline: captureWorkspaceSnapshot(observationDirectory),
			workflowGeneration,
		});
	};
	const beginForegroundCoderSettlementIfNeeded = async (
		input: { callID: string; sessionID: string },
		taskId: string,
		background: unknown,
		worktree?: BackgroundWorktreeDescriptor,
	): Promise<void> => {
		if (backgroundSubagentsEnabled && isBackgroundTrue(background)) return;
		const context = coderTaskChangeContextByCallID.get(input.callID);
		if (!context || context.workflowGeneration === undefined) {
			throw new Error(
				`CODER_SETTLEMENT_CONTEXT_MISSING: no durable baseline or generation for task ${taskId}`,
			);
		}
		// Issue #2214: a dirty launch baseline can never support mutation
		// attribution — changedFilesSinceSnapshot fails closed for any
		// pre-existing uncommitted/untracked path. Enforce the clean-baseline
		// contract at dispatch time, BEFORE the coder runs and before the
		// settlement WAL is written, so the dispatch fails fast with an
		// actionable message instead of wedging the task at DISPATCHED after
		// the coder's work is done.
		const baselineDirtyFiles = Array.isArray(context.baseline.changedFiles)
			? context.baseline.changedFiles
			: [];
		if (baselineDirtyFiles.length > 0) {
			const sample = baselineDirtyFiles.slice(0, 5).join(', ');
			throw new Error(
				`CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED: ${String(baselineDirtyFiles.length)} uncommitted/untracked change(s) present at dispatch (${sample}${baselineDirtyFiles.length > 5 ? ', …' : ''}). ` +
					'Commit or stash them before dispatching a coder — exact-task settlement cannot attribute coder mutations from a dirty launch baseline. ' +
					'(.swarm/ plugin runtime state is excluded from this check automatically.) ' +
					`Task ${taskId} was not dispatched and no settlement state was created.`,
			);
		}
		await beginCoderSettlement({
			directory,
			taskId,
			transitionId: `coder:${input.callID}`,
			actor: input.sessionID,
			expectedGeneration: context.workflowGeneration,
			context,
			...(worktree ? { worktree } : {}),
		});
		rememberBegunCoderSettlement(input.callID, taskId, `coder:${input.callID}`);
	};
	const shouldRememberCoderTaskChangeContext = (
		_declaredFiles: string[] | null,
		_background: unknown,
	): boolean => true;
	const backgroundCompletionClaimed = (
		record: BackgroundDelegationRecord,
	): void => {
		const callID = record.callID;
		clearPublishedScopeBindings(callID);
		clearCoderTaskChangeContext(callID);
		begunCoderSettlementsByCallID.delete(callID);
		stageBDispatchGenerationsByCallID.delete(callID);
		gateDispatchPrimaryTaskByCallID.delete(callID);
		stageBDispatchContextByCallID.delete(callID);
		deleteStoredInputArgs(callID);
	};

	if (!enabled) {
		return {
			messagesTransform: async (
				_input: Record<string, never>,
				_output: { messages?: MessageWithParts[] },
			): Promise<void> => {
				// No-op when delegation gate is disabled
			},
			toolBefore: async (input, output): Promise<void> => {
				const normalized = normalizeToolName(input.tool);
				const args = output.args as Record<string, unknown> | undefined;
				if (
					(normalized !== 'Task' && normalized !== 'task') ||
					!args ||
					typeof args.subagent_type !== 'string' ||
					stripKnownSwarmPrefix(args.subagent_type) !== 'coder'
				)
					return;
				const prepared = await prepareCoderScope(directory, input, args);
				await publishScopeBinding(input.callID, directory, prepared.binding);
			},
			toolAfter: async (input, output): Promise<void> => {
				if (
					(normalizeToolName(input.tool) === 'Task' ||
						normalizeToolName(input.tool) === 'task') &&
					outputLooksLikeBackgroundRunning(output)
				)
					return;
				clearPublishedScopeBindings(input.callID);
			},
			taskMetadata,
			sessionEnded,
			backgroundCompletionClaimed,
			// Disabled gate never begins a settlement; nothing to roll back.
			abortDeniedSettlementForCall: async (): Promise<void> => {},
		};
	}

	// toolBefore: runtime reviewer gate enforcement
	// Blocks coder re-delegation when the task's workflow state is coder_delegated
	// (meaning a coder already ran but no reviewer has run yet)
	const toolBefore = async (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
		},
		output: { args: unknown },
	): Promise<void> => {
		if (!input.sessionID) return;

		const normalized = normalizeToolName(input.tool);

		// ── Issue #2271 bug 4: critic model-resolution preflight ──
		// A critic dispatch whose model id does not resolve fails permanently
		// AFTER the Task leaves this gate ("Model not found"/"Forbidden"), so the
		// plan-critic gate can never produce VERDICT: APPROVED and wedges into
		// manual approve_plan_critic overrides. Deny fail-fast with an
		// actionable message instead. Fail-open: any catalog/check error lets
		// the dispatch proceed (existing retry classification still applies).
		const preflightArgs = output.args as Record<string, unknown> | undefined;
		if (
			(normalized === 'Task' || normalized === 'task') &&
			preflightArgs &&
			typeof preflightArgs.subagent_type === 'string'
		) {
			const preflightAgent = stripKnownSwarmPrefix(preflightArgs.subagent_type);
			if (preflightAgent.startsWith('critic')) {
				const criticModel =
					config.agents?.[preflightAgent]?.model ??
					DEFAULT_MODELS[preflightAgent] ??
					DEFAULT_MODELS.default;
				try {
					const { checkSingleModelResolution } = await import(
						'../services/model-preflight'
					);
					const resolution = await checkSingleModelResolution(
						criticModel,
						swarmState.opencodeClient,
					);
					if (resolution === 'unresolved') {
						telemetry.modelUnresolved(
							preflightAgent,
							criticModel,
							'plan-critic dispatch preflight',
						);
						throw new Error(
							`PLAN_CRITIC_MODEL_UNRESOLVED: the ${preflightAgent} agent's model "${criticModel}" does not resolve against the provider catalog — the critic can never run, so the plan-critic gate cannot produce VERDICT: APPROVED. ` +
								`Fix agents.${preflightAgent}.model in opencode-swarm.json (or remove the override to fall back to the default model), then re-run MODE: CRITIC-GATE.`,
						);
					}
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.startsWith('PLAN_CRITIC_MODEL_UNRESOLVED')
					) {
						// PR-review PRR-006: a denial invalidates the catalog
						// cache so a user who fixes the model config is not
						// re-denied from a stale catalog for up to the 30 s TTL.
						const { invalidateProviderCatalogCache } = await import(
							'../services/model-preflight'
						);
						invalidateProviderCatalogCache();
						throw error;
					}
					// Catalog unavailable / check failed — fail open.
				}
			}
		}

		// ── Completion gate: blocks starting a different task after QA gates pass ──
		// Runs for ALL tools (declare_scope, update_task_status, Task), not just Task.
		const completionArgs = output.args as Record<string, unknown> | undefined;
		if (completionArgs) {
			// Load plan task IDs for plan-aware text extraction (filters version numbers)
			let completionPlanTaskIds: ReadonlySet<string> | undefined;
			try {
				const plan = await loadPlanJsonOnly(directory);
				if (plan) {
					completionPlanTaskIds = new Set(
						plan.phases.flatMap((p) => p.tasks.map((t) => t.id)),
					);
				}
			} catch {
				// Plan unavailable — proceed without plan filtering (safe: may over-block)
			}
			const requestedTaskId = resolveDelegatedPlanTaskId(
				completionArgs,
				completionPlanTaskIds,
			);
			if (requestedTaskId) {
				const { getTaskWorkflowSnapshot, readTaskEvidence } = await import(
					'../gate-evidence'
				);
				const recoveredCoder = await recoverCoderSettlement(
					directory,
					requestedTaskId,
				);
				if (recoveredCoder) {
					const recoveredSession = ensureAgentSession(input.sessionID);
					const workflow = getTaskWorkflowSnapshot(recoveredCoder.evidence);
					recoveredSession.taskWorkflowStates.set(
						requestedTaskId,
						workflow.state,
					);
					recoveredSession.stageBCompletion?.delete(requestedTaskId);
					updateTaskWorkflowCache(recoveredSession, requestedTaskId, workflow);
				}
				const recoveredTerminal = await recoverPreparedTaskTerminal(
					directory,
					requestedTaskId,
					input.sessionID,
				);
				if (recoveredTerminal) {
					const recoveredSession = ensureAgentSession(input.sessionID);
					const workflow = getTaskWorkflowSnapshot(recoveredTerminal.evidence);
					recoveredSession.taskWorkflowStates.set(
						requestedTaskId,
						workflow.state,
					);
					recoveredSession.stageBCompletion?.delete(requestedTaskId);
					recoveredSession.taskCouncilApproved?.delete(requestedTaskId);
					recoveredSession.taskCouncilWorkflowGeneration?.delete(
						requestedTaskId,
					);
					updateTaskWorkflowCache(recoveredSession, requestedTaskId, workflow);
				}
				// A COMMITTED-but-unaudited repair WAL makes recoverPreparedTaskRepair
				// retry its audit-event write on every call for this task (the WAL is
				// never deleted); transient events.jsonl lock contention must degrade
				// this opportunistic recovery, not hard-block toolBefore for every
				// tool call touching the task.
				let recoveredRepair: Awaited<
					ReturnType<typeof recoverPreparedTaskRepair>
				> = null;
				try {
					recoveredRepair = await recoverPreparedTaskRepair(
						directory,
						requestedTaskId,
						input.sessionID,
					);
				} catch (error) {
					// Always-emitted: a swallowed failure here means the force-repair
					// audit event may not be durably recorded yet, and warn() is
					// silenced outside OPENCODE_SWARM_DEBUG=1.
					logger.criticalWarn(
						`[delegation-gate] task-repair recovery deferred for ${requestedTaskId}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
				if (recoveredRepair) {
					const recoveredSession = ensureAgentSession(input.sessionID);
					const workflow = getTaskWorkflowSnapshot(
						await readTaskEvidence(directory, requestedTaskId),
					);
					recoveredSession.taskWorkflowStates.set(
						requestedTaskId,
						workflow.state,
					);
					recoveredSession.stageBCompletion?.delete(requestedTaskId);
					recoveredSession.taskCouncilApproved?.delete(requestedTaskId);
					recoveredSession.taskCouncilWorkflowGeneration?.delete(
						requestedTaskId,
					);
					updateTaskWorkflowCache(recoveredSession, requestedTaskId, workflow);
				}
			}
			const taskAwaitingCompletion = await findTaskAwaitingCompletion(
				directory,
				requestedTaskId,
			);
			if (taskAwaitingCompletion) {
				const permitted = canRunWhileTaskAwaitsCompletion({
					directory,
					normalizedTool: normalized,
					args: completionArgs,
					awaitingTaskId: taskAwaitingCompletion,
					requestedTaskId,
				});
				if (!permitted) {
					throw new Error(
						completionGateViolationMessage(taskAwaitingCompletion),
					);
				}
			}
		}

		if (normalized !== 'Task' && normalized !== 'task') return;

		const args = output.args as Record<string, unknown> | undefined;
		if (!args) return;

		const subagentType = args.subagent_type;
		if (typeof subagentType !== 'string') return;

		const targetAgent = stripKnownSwarmPrefix(subagentType);

		// Issue #1151: fail-closed block for swarm background Task dispatch.
		// Placed BEFORE the coder-only early return below so reviewer/test_engineer and
		// every other swarm role are caught — not just coder. Scoped to swarm roles via
		// isKnownCanonicalRole so unrelated OpenCode Task usage (e.g. the native `general`
		// agent) is never blocked. This throw propagates through the fail-closed
		// tool.execute.before chain in src/index.ts (no safeHook wrapper), so OpenCode
		// rejects the tool before launching the background task.
		//
		// When background_subagents is opted in, the block is lifted and toolAfter
		// records the running placeholder without terminal effects. Only the later
		// trusted completion observer may apply role-appropriate state/evidence.
		// When disabled (default), the fail-closed behavior stands.
		if (
			!backgroundSubagentsEnabled &&
			isBackgroundTrue(args.background) &&
			isKnownCanonicalRole(targetAgent)
		) {
			throw new Error(SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE);
		}

		// Review routing: when delegating to reviewer, check if review should be parallelized
		if (targetAgent === 'reviewer') {
			try {
				const reviewSession = swarmState.agentSessions.get(input.sessionID);
				if (reviewSession) {
					const reviewTaskId = await resolveEvidenceTaskId(
						args,
						reviewSession,
						directory,
					);
					// Route against the exact reviewed task. The singular projection is
					// compatibility-only and may point at a different concurrent task.
					const changedFiles = reviewTaskId
						? getModifiedFilesForTask(reviewSession, reviewTaskId)
						: [];
					if (changedFiles.length > 0) {
						const routing = await routeReviewForChanges(
							directory,
							changedFiles,
						);
						if (shouldParallelizeReview(routing)) {
							pushAdvisory(
								reviewSession,
								`REVIEW ROUTING: High complexity detected (${routing.reason}). ` +
									`Consider parallel review: ${routing.reviewerCount} reviewers, ${routing.testEngineerCount} test engineers recommended.`,
							);
						}
					}
				}
			} catch {
				// review routing errors must never block delegation
			}
		}

		// FR-003/SC-003/SC-004 (#1687): pre-dispatch acceptance-criteria
		// enforcement, scoped to coder + reviewer ONLY. Runs here in toolBefore
		// (pre-execution) so a dispatch whose prompt lacks a non-empty ACCEPTANCE
		// field is rejected BEFORE the target agent runs — a genuinely new,
		// BLOCKING check, distinct from M15's advisory, post-execution
		// appendDelegationEnvelopeAdvisory (toolAfter), which is left untouched for
		// the old structured-envelope format and other delegation types. Placed
		// ABOVE the `targetAgent !== 'coder'` early-return below so reviewer (which
		// returns there and never reaches the coder-only logic) is gated too. Other
		// delegation targets (sme/explorer/critic/…) are never inspected here.
		if (targetAgent === 'coder' || targetAgent === 'reviewer') {
			// Reuse the same broad text-field extraction other checks in this file
			// use (see resolveDelegatedPlanTaskId / taskLooksLikePlanCritic) so the
			// ACCEPTANCE line is found regardless of which arg carried the prompt.
			const acceptancePromptText = ACCEPTANCE_ARGS_FIELDS.map(
				(field) => args[field],
			)
				.filter((value): value is string => typeof value === 'string')
				.join('\n');
			const acceptanceCheck =
				validateCoderReviewerAcceptanceField(acceptancePromptText);
			if (!acceptanceCheck.valid) {
				const detail =
					acceptanceCheck.reason === 'acceptance_field_empty'
						? 'its ACCEPTANCE field is present but empty/whitespace-only'
						: 'it has no ACCEPTANCE field';
				throw new Error(
					`ACCEPTANCE_FIELD_REQUIRED: the ${targetAgent} delegation was blocked because ${detail}. ` +
						`Every coder/reviewer dispatch MUST carry a non-empty ACCEPTANCE: line in its prompt — the mapped FR-###/SC-### ids ` +
						`(for a single-task dispatch the delegation gate injects their verbatim requirement text from .swarm/spec.md automatically; ` +
						`phase/final-council multi-task reviewer dispatches are NOT auto-injected and must paste the verbatim text yourself) when the task maps to one or more ` +
						`spec requirements, or a one-line task-derived statement of what DONE looks like otherwise (see the ACCEPTANCE FIELD RESOLUTION ` +
						`section of your system prompt and .swarm/spec.md). Add an ACCEPTANCE: line to the delegation prompt and ` +
						`re-dispatch. Do NOT investigate the installed swarm plugin package (node_modules/opencode-swarm, ` +
						`~/.cache/opencode) — the fix is in your dispatch content, not in plugin internals. If this same error ` +
						`repeats after 2 fix attempts, STOP and present the blocker to the user.`,
				);
			}

			// FR-001/FR-002/FR-005/SC-001/SC-002/SC-006 (#1687): beyond "ACCEPTANCE
			// is non-empty", verify the ACCEPTANCE text actually COVERS the verbatim
			// requirement body for EACH spec FR-###/SC-### the plan task maps to.
			// Self-contained + FAIL-OPEN: it loads the plan and resolves the task-id
			// locally (reviewer returns at the coder-only guard below and never reaches
			// the existing below-guard load, so this MUST live above it to gate reviewer
			// too). A false-positive BLOCK halts a real swarm, so EVERY precondition
			// failure => skip (no block), and only a clear, high-confidence mismatch
			// throws. The whole resolution runs inside try/catch: any unexpected error
			// (fs/parse/etc.) is swallowed and treated as covered.
			let coverageResult:
				| {
						covered: boolean;
						missingId?: string;
						diagnostic?: CoverageMissDiagnostic;
						expectedBody?: string;
				  }
				| undefined;
			let coverageTaskId: string | null = null;
			try {
				const coveragePlan = await _internals.loadPlanJsonOnly(directory);
				if (coveragePlan) {
					const coveragePlanTaskIds = new Set(
						coveragePlan.phases.flatMap((phase) =>
							phase.tasks.map((t) => t.id),
						),
					);
					coverageTaskId = resolveDelegatedPlanTaskId(
						args,
						coveragePlanTaskIds,
					);
					if (coverageTaskId) {
						const coverageTask = coveragePlan.phases
							.flatMap((phase) => phase.tasks)
							.find((t) => t.id === coverageTaskId);
						const frRefs = coverageTask?.fr_refs;
						// FR-004: a non-spec task (no fr_refs) stays dispatchable — skip.
						if (coverageTask && Array.isArray(frRefs) && frRefs.length > 0) {
							const specText = await fs.promises.readFile(
								path.join(directory, '.swarm', 'spec.md'),
								'utf8',
							);
							// #2205: guarantee verbatim FR/SC fidelity programmatically —
							// append the exact spec.md requirement bodies for any mapped id
							// the ACCEPTANCE text does not already cover, mutating the
							// dispatch args in place so the downstream coder/reviewer sees
							// them. The architect only has to list the ids on the
							// ACCEPTANCE line; byte-for-byte copying is no longer LLM
							// responsibility. (Errors here fall to the surrounding
							// fail-open catch, same as the rest of this block.)
							injectSpecRequirementsIntoAcceptance({
								args,
								frRefs,
								specText,
							});
							// Re-derive the acceptance text from the (possibly mutated)
							// args so the coverage check validates what will actually be
							// dispatched.
							const effectiveAcceptanceText = ACCEPTANCE_ARGS_FIELDS.map(
								(field) => args[field],
							)
								.filter((value): value is string => typeof value === 'string')
								.join('\n');
							coverageResult = checkAcceptanceCoversFrRefs({
								acceptanceText: effectiveAcceptanceText,
								frRefs,
								specText,
							});
						}
					}
				}
			} catch {
				// Fail-open: never let this check break dispatch by accident.
				coverageResult = undefined;
			}
			if (coverageResult && coverageResult.covered === false) {
				// Defense-in-depth: after #2205's injection this throw is
				// structurally unreachable in the toolBefore flow today
				// (injection covers every extractable id before the check
				// runs, using the same field list, id-resolution, and
				// normalization logic as the recheck), but the check + error
				// contract stay wired for any FUTURE divergence between
				// injection and validation.
				throw buildAcceptanceCoverageMismatchError({
					targetAgent,
					coverageTaskId,
					coverageResult,
				});
			}
		}

		if (TASK_GATE_AGENTS.has(targetAgent)) {
			const stageBSession = ensureAgentSession(input.sessionID);
			const resolvedTaskId = await resolveEvidenceTaskId(
				args,
				stageBSession,
				directory,
			);
			const candidateTaskIds = new Set<string>();
			if (resolvedTaskId) candidateTaskIds.add(resolvedTaskId);
			const dispatchPlan = await loadPlanJsonOnly(directory);
			if (dispatchPlan) {
				const knownIds = new Set(
					dispatchPlan.phases.flatMap((phase) =>
						phase.tasks.map((task) => task.id),
					),
				);
				const dispatchText = [
					args.prompt,
					args.description,
					args.task,
					args.input,
				]
					.filter((value): value is string => typeof value === 'string')
					.join('\n');
				for (const match of dispatchText.matchAll(
					/(?:task-)?(\d+\.\d+(?:\.\d+)*)/gi,
				)) {
					if (match[1] && knownIds.has(match[1]))
						candidateTaskIds.add(match[1]);
				}
			}
			const generations = new Map<string, number>();
			const { getTaskWorkflowSnapshot, readTaskEvidence } = await import(
				'../gate-evidence'
			);
			for (const taskId of candidateTaskIds) {
				const workflow = getTaskWorkflowSnapshot(
					await readTaskEvidence(directory, taskId),
				);
				if (
					taskId === resolvedTaskId &&
					(await isCouncilGateActive(directory, config.council))
				) {
					if (!stageBSession.taskCouncilWorkflowGeneration) {
						stageBSession.taskCouncilWorkflowGeneration = new Map();
					}
					if (!stageBSession.taskCouncilWorkflowGeneration.has(taskId)) {
						stageBSession.taskCouncilWorkflowGeneration.set(
							taskId,
							workflow.generation,
						);
					}
				}
				if (targetAgent !== 'reviewer' && targetAgent !== 'test_engineer') {
					generations.set(taskId, workflow.generation);
					continue;
				}
				if (
					workflow.authoritative &&
					(workflow.state === 'pre_check_passed' ||
						workflow.state === 'reviewer_run')
				) {
					generations.set(taskId, workflow.generation);
					continue;
				}
				if (taskId === resolvedTaskId) {
					// Issue #2383 correlated reviewer re-entry: a direct Task
					// dispatch of reviewer/test_engineer may bypass the GENERIC
					// Stage-A task-workflow requirement ONLY through a persisted
					// one-use authorization issued by the PR workflow controller
					// and still bound to the exact active session, role, head,
					// revision digest, and gate generation. No prompt-text
					// inspection is involved; a missing/expired/replayed/stale
					// authorization consumes to null and falls through to the
					// normal Stage-A error below. This is a Stage-A-ONLY
					// exemption: the council gate above, the background-task
					// block, acceptance-criteria enforcement, and every other
					// check in this hook remain fully authoritative.
					const { consumePrReviewReentryAuthorization } = await import(
						'../pr-review/authorization.js'
					);
					const consumed = await consumePrReviewReentryAuthorization(
						directory,
						input.sessionID,
						{
							role:
								targetAgent === 'test_engineer' ? 'test_engineer' : 'reviewer',
							callID: input.callID,
						},
					);
					if (consumed) {
						rememberStageBDispatchGenerations(input.callID, generations);
						gateDispatchPrimaryTaskByCallID.set(input.callID, resolvedTaskId);
						stageBDispatchContextByCallID.set(input.callID, {
							taskIds: new Set(generations.keys()),
							expectedVerdictKind:
								targetAgent === 'test_engineer' ? 'TESTED' : 'REVIEWED',
						});
						return;
					}
					throw new Error(
						`TASK_WORKFLOW_STAGE_A_REQUIRED: cannot dispatch ${targetAgent} for task ${taskId} from ${workflow.state}. ` +
							`Stage B (${targetAgent}) requires the task to be at pre_check_passed (or later) — a state written only by the stage_a_passed transition, which is emitted when pre_check_batch completes with the task correctly attributed. ` +
							`Remediation: run pre_check_batch on the task's changed files first. If pre_check_batch passes but the task remains coder_delegated (typical after /swarm reset-session), run /swarm recover ${taskId} to repair Stage A attribution, then re-dispatch.` +
							(targetAgent === 'reviewer' || targetAgent === 'test_engineer'
								? ` For PR-review re-entry outside the task workflow, issue a one-use authorization with authorize_pr_review_reentry immediately before the Task dispatch.`
								: ''),
					);
				}
			}
			rememberStageBDispatchGenerations(input.callID, generations);
			gateDispatchPrimaryTaskByCallID.set(input.callID, resolvedTaskId);
			stageBDispatchContextByCallID.set(input.callID, {
				taskIds: new Set(generations.keys()),
				expectedVerdictKind:
					targetAgent === 'test_engineer' ? 'TESTED' : 'REVIEWED',
			});
			return;
		}

		if (targetAgent !== 'coder') return;

		// Only check for the architect session (the orchestrator)
		const session = ensureAgentSession(input.sessionID);
		if (!session || !session.taskWorkflowStates) return;

		const {
			getTaskWorkflowSnapshot,
			readTaskEvidence,
			transitionTaskWorkflowEvidence,
		} = await import('../gate-evidence');
		const resolvedPreflightTaskId = await resolveEvidenceTaskId(
			args,
			session,
			directory,
		);
		const preflightPlan = await loadPlanJsonOnly(directory);
		const preflightTaskId =
			resolvedPreflightTaskId &&
			preflightPlan?.phases.some((phase) =>
				phase.tasks.some((task) => task.id === resolvedPreflightTaskId),
			)
				? resolvedPreflightTaskId
				: null;
		const preflightEvidence = preflightTaskId
			? await readTaskEvidence(directory, preflightTaskId)
			: null;
		const preflightWorkflow = getTaskWorkflowSnapshot(preflightEvidence);
		if (preflightTaskId) {
			await enforceCoderRetryEscalation({
				directory,
				taskId: preflightTaskId,
				generation: preflightWorkflow.generation,
				retryEpoch: preflightWorkflow.retryEpoch,
				retryCount: preflightWorkflow.retryCount,
				retryHistory: preflightWorkflow.retryHistory,
				criticSatisfied: preflightEvidence?.gates.critic_sounding_board != null,
			});
			if (preflightWorkflow.state === 'coder_delegated') {
				const turboBypass =
					hasActiveTurboMode(input.sessionID) &&
					!preflightTaskId.startsWith('3.');
				if (!turboBypass) {
					throw new Error(
						`STAGE_A_REQUIRED: Task ${preflightTaskId} has an accepted coder mutation that has not passed pre_check_batch. ` +
							'Run Stage A first. If Stage A fails, the task becomes rework_required and the same-task coder may repair it. ' +
							'Do not send known-broken output to reviewer.',
					);
				}
			}
		}

		// Scope preflight is mandatory and independent of the optional workflow
		// gates. It creates a staged binding but does not publish authorization.
		let preparedScope: Awaited<ReturnType<typeof prepareCoderScope>>;
		try {
			preparedScope = await prepareCoderScope(directory, input, args);
		} catch (error) {
			if (preflightTaskId) {
				const failed = await transitionTaskWorkflowEvidence(
					directory,
					preflightTaskId,
					{
						type: 'dispatch_no_mutation',
						agentType: 'coder',
						expectedGeneration: preflightWorkflow.generation,
						transitionId: `coder-preflight:${input.callID}`,
					},
				);
				const failedWorkflow = getTaskWorkflowSnapshot(failed);
				if (failedWorkflow.retryCount >= 3) {
					await emitCoderRetryEscalation(directory, {
						taskId: preflightTaskId,
						generation: failedWorkflow.generation,
						retryEpoch: failedWorkflow.retryEpoch,
						rejectionCount: failedWorkflow.retryCount,
						rejectionHistory: failedWorkflow.retryHistory,
						action: 'sounding_board_consultation',
					});
				}
			}
			throw error;
		}
		const { plan, taskId: incomingCoderTaskId } = preparedScope;
		if (incomingCoderTaskId) {
			// Structured dispatch-context attribution (Stage A wedge fix): the
			// resolved task id comes from args.task_id / the plan-validated scope
			// resolution, not prompt-text regex, so it survives odd whitespace,
			// agent prefixes, and missing TASK: lines. This is what
			// toolAfter's coder-completion tracking (guardrails/index.ts) reads to
			// set currentTaskId, which gates every Stage A evidence write. The
			// messages-transform regex writer for this field was removed — this is
			// now the sole writer.
			session.lastCoderDelegationTaskId = incomingCoderTaskId;
		}
		const coderEvidence = incomingCoderTaskId
			? await readTaskEvidence(directory, incomingCoderTaskId)
			: null;
		const coderWorkflow = getTaskWorkflowSnapshot(coderEvidence);
		const coderDispatchGeneration = coderWorkflow.generation;
		if (incomingCoderTaskId) {
			if (incomingCoderTaskId !== preflightTaskId) {
				await enforceCoderRetryEscalation({
					directory,
					taskId: incomingCoderTaskId,
					generation: coderWorkflow.generation,
					retryEpoch: coderWorkflow.retryEpoch,
					retryCount: coderWorkflow.retryCount,
					retryHistory: coderWorkflow.retryHistory,
					criticSatisfied: coderEvidence?.gates.critic_sounding_board != null,
				});
			}
		}
		const reserveBackgroundCoderIfNeeded = async (
			maxConcurrent: number,
		): Promise<void> => {
			if (!backgroundSubagentsEnabled || !isBackgroundTrue(args.background)) {
				return;
			}
			// Maintenance point P1 (issue #2104): reconcile stale delegations and
			// expired reservation leases right before admission. Best-effort with a
			// tight 1 s lock bound — on contention or failure the inline
			// proven-terminal reconciliation inside reserveBackgroundCoderSlot
			// still guards admission, and another maintenance point will finish
			// the wider reclaim later.
			try {
				await _internals.maintainBackgroundDelegationsForDispatch(directory, {
					lockTimeoutMs: 1_000,
					reason: 'admission',
				});
			} catch (error) {
				logger.warn(
					`[delegation-gate] pre-admission background maintenance skipped: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const occupiedTaskIds = [...session.taskWorkflowStates.entries()]
				.filter(([, state]) => state === 'coder_delegated')
				.map(([taskId]) => taskId);
			const claim = await _internals.reserveBackgroundCoderSlotForDispatch(
				directory,
				{
					parentSessionId: input.sessionID,
					planTaskId: incomingCoderTaskId || null,
					callID: input.callID,
					maxConcurrent,
					occupiedTaskIds,
					// The reservation seeds generation 1 (the first launch attempt)
					// regardless of the task's WORKFLOW retry generation: the lease
					// generation tracks only launch attempts (PR #2091 semantics),
					// and the bind site couples it to the record's actual launch
					// generation. Seeding the workflow generation here would make a
					// retry dispatch (workflow generation >= 2) refuse its own bind
					// (generation may only move forward), leaking the reservation.
				},
			);
			if (!claim.ok) {
				const detail = claim.detail ? ` ${claim.detail}` : '';
				const code =
					claim.reason === 'capacity'
						? 'PARALLEL_SLOTS_EXHAUSTED'
						: claim.reason === 'duplicate_task' ||
								claim.reason === 'duplicate_call'
							? 'BACKGROUND_CODER_TASK_RESERVED'
							: 'BACKGROUND_CODER_RESERVATION_UNCERTAIN';
				throw new Error(
					`${code}: background coder admission was blocked (${claim.reason}).${detail}`,
				);
			}
			backgroundCoderReservationByCallID.set(input.callID, claim.reservation);
		};
		if (!plan) {
			await reserveBackgroundCoderIfNeeded(1);
			try {
				if (
					shouldRememberCoderTaskChangeContext(
						preparedScope.declaredFiles,
						args.background,
					)
				) {
					rememberCoderTaskChangeContext(
						input.callID,
						preparedScope.declaredFiles,
						directory,
						coderDispatchGeneration,
					);
				}
				await publishScopeBinding(
					input.callID,
					directory,
					preparedScope.binding,
				);
				await beginForegroundCoderSettlementIfNeeded(
					input,
					incomingCoderTaskId,
					args.background,
				);
			} catch (error) {
				await releasePrelaunchBackgroundCoderReservation(input.callID);
				clearPublishedScopeBindings(input.callID);
				clearCoderTaskChangeContext(input.callID);
				throw error;
			}
			return;
		}
		const profile = plan?.execution_profile;
		const parallelEnabled = profile?.parallelization_enabled === true;
		const maxConcurrent = profile?.max_concurrent_tasks ?? 10;
		const effectiveMaxConcurrent =
			session.maxConcurrencyOverride ?? maxConcurrent;
		// #1674 v8 AUTOMATIC FALLBACK (acceptance criterion 4): parallel mode
		// additionally requires the active phase's pending tasks to be PROVABLY
		// file-disjoint. The gate computes the verdict inline via the same pure
		// helper the architect's `plan_conflict_check` tool uses; conflicts or
		// unknown scopes → serial by default, with no architect discretion.
		const scopeAllowsParallel = scopeVerdictAllowsParallel(directory, plan);
		// Standard worktree isolation remains active even when the concurrency
		// verdict falls back to serial. F-014: coupling isolation to
		// `scopeAllowsParallel` made overlapping/unknown scopes run in the project
		// root, defeating the safety boundary that serial fallback is meant to keep.
		const standardWorktreeIsolationActive =
			parallelEnabled &&
			effectiveMaxConcurrent > 1 &&
			!hasActiveLeanTurbo(input.sessionID);
		// Parallel gate exemptions and slot accounting additionally require the
		// pending tasks to be provably disjoint.
		const parallelModeActive =
			standardWorktreeIsolationActive && scopeAllowsParallel;
		const criticPolicy = resolvePlanCriticPolicyForExecution(
			directory,
			plan,
			session.qaGateSessionOverrides ?? {},
		);
		logger.log(
			`[delegation-gate] critic_pre_plan policy task=${incomingCoderTaskId ?? 'unknown'} required=${criticPolicy.required} source=${criticPolicy.source}`,
		);
		if (criticPolicy.required) {
			await assertPlanCriticApprovedForExecution(directory, plan);
		}
		const incomingCoderDeclaredFiles = preparedScope.declaredFiles;
		const correlatedBinding = preparedScope.binding;

		// Reviewer gate: block coder re-delegation when a prior coder task awaits
		// review. In parallel mode (parallelization_enabled), dispatching a coder
		// for a DIFFERENT dependency-ready task is legitimate, so a coder_delegated
		// task only blocks a coder for the SAME task (a true re-delegation that would
		// skip review). The slot cap below bounds total in-flight unreviewed coders.
		for (const task of plan.phases.flatMap((phase) => phase.tasks)) {
			const taskId = task.id;
			const durableWorkflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, taskId),
			);
			const state = durableWorkflow.authoritative
				? durableWorkflow.state
				: 'idle';
			session.taskWorkflowStates.set(taskId, state);
			updateTaskWorkflowCache(session, taskId, durableWorkflow);
			if (state !== 'coder_delegated') continue;

			// Before blocking, verify this coder_delegated state is from the CURRENT session.
			// If there's no evidence of a coder delegation for this task in the current
			// session's delegation chains, the state is inherited from a prior session — reset it.
			// We use sessionRehydratedAt as the freshness threshold: any delegation chain
			// entry older than rehydration time is from the prior session. For non-rehydrated
			// sessions (sessionRehydratedAt=0), we fall back to lastPhaseCompleteTimestamp.
			const freshnessThreshold =
				session.sessionRehydratedAt > 0
					? session.sessionRehydratedAt
					: (session.lastPhaseCompleteTimestamp ?? 0);
			const delegationChains =
				swarmState.delegationChains.get(input.sessionID) ?? [];
			const hasCurrentSessionCoderDelegation = delegationChains.some(
				(d) =>
					stripKnownSwarmPrefix(d.to) === 'coder' &&
					d.timestamp > freshnessThreshold,
			);
			if (!durableWorkflow.authoritative && !hasCurrentSessionCoderDelegation) {
				// Stale state from prior session — reset to idle and allow the delegation
				session.taskWorkflowStates.set(taskId, 'idle');
				logger.warn(
					`[delegation-gate] Reset stale coder_delegated state for task ${taskId} — ` +
						`no coder delegation found in current session.`,
				);
				continue; // Skip this task, don't block
			}

			// Turbo mode bypasses the block — but Tier 3 tasks are never bypassed
			const turbo = hasActiveTurboMode(input.sessionID);
			if (turbo) {
				// Tier 3 tasks always require reviewer, even in turbo mode
				// Tier 3 pattern: task IDs like 3.x or tasks in phase 3
				const isTier3 = taskId.startsWith('3.');
				if (!isTier3) continue; // Allow bypass for non-Tier-3 in turbo
			}

			// Parallel-mode exemption: a coder for a DIFFERENT task does not block.
			// Re-delegating the SAME unreviewed task still falls through and throws.
			if (
				parallelModeActive &&
				incomingCoderTaskId &&
				taskId !== incomingCoderTaskId
			) {
				continue;
			}

			throw new Error(
				`STAGE_A_REQUIRED: Task ${taskId} has an accepted coder mutation that has not passed pre_check_batch. ` +
					'Run Stage A first. If Stage A fails, the task becomes rework_required and the same-task coder may repair it. ' +
					'Do not send known-broken output to reviewer.',
			);
		}

		// Parallel slot cap: bound the number of concurrently-unreviewed coders to
		// max_concurrent_tasks so the architect cannot outrun the review gates. The
		// cap applies whenever parallel mode is active, independent of whether the
		// incoming coder's task id is parseable — an unresolvable task id must not be
		// a way to slip past the cap and oversubscribe in-flight coders (F-001).
		if (parallelModeActive) {
			let coderDelegatedCount = 0;
			for (const s of session.taskWorkflowStates.values()) {
				if (s === 'coder_delegated') coderDelegatedCount++;
			}
			if (coderDelegatedCount >= effectiveMaxConcurrent) {
				throw new Error(
					`PARALLEL_SLOTS_EXHAUSTED: ${coderDelegatedCount} coder task(s) are awaiting review ` +
						`(max_concurrent_tasks=${effectiveMaxConcurrent}). Dispatch reviewer/test_engineer for an ` +
						`in-flight coder task before starting another coder.`,
				);
			}
		}

		if (standardWorktreeSerializationSessions.has(input.sessionID)) {
			// FR-104 SC-111/SC-112: Before rejecting, check if the serialized session
			// should be released due to TTL expiry or dispatch-count threshold.
			// This makes the release check reachable through the public gating path
			// (not just via precreateStandardWorktreeSession directly).
			checkStandardWorktreeSerializationRelease(
				input.sessionID,
				resolveWorktreeIsolationConfig(config),
			);
			// After release check, re-evaluate — if TTL/count released it, allow through
			if (standardWorktreeSerializationSessions.has(input.sessionID)) {
				throw new Error(
					'STANDARD_WORKTREE_ISOLATION_SERIALIZED: prior standard worktree isolation setup failed in this session; wait for the active coder task to finish before dispatching another coder.',
				);
			}
		}

		// Background coder dispatch: reserve a slot and record task context.
		// The 5-store durable ownership system protects the resulting worktree.
		await reserveBackgroundCoderIfNeeded(
			parallelModeActive ? effectiveMaxConcurrent : 1,
		);
		try {
			if (!parallelModeActive) {
				if (
					shouldRememberCoderTaskChangeContext(
						incomingCoderDeclaredFiles,
						args.background,
					)
				) {
					rememberCoderTaskChangeContext(
						input.callID,
						incomingCoderDeclaredFiles,
						directory,
						coderDispatchGeneration,
					);
				}
			}

			// Standard (non-background) coder: check worktree isolation and
			// short-circuit when no isolated worktree is configured.
			if (!standardWorktreeIsolationActive) {
				if (
					shouldRememberCoderTaskChangeContext(
						incomingCoderDeclaredFiles,
						args.background,
					)
				) {
					rememberCoderTaskChangeContext(
						input.callID,
						incomingCoderDeclaredFiles,
						directory,
						coderDispatchGeneration,
					);
				}
				await publishScopeBinding(input.callID, directory, correlatedBinding);
				await beginForegroundCoderSettlementIfNeeded(
					input,
					incomingCoderTaskId,
					args.background,
				);
				return;
			}

			const resolvedTaskId = incomingCoderTaskId;
			// FR-102: pass declared scope (from pending map populated by FILE: extraction
			// or prior declare_scope) so provisionWorktree can materialize it into the
			// lane's .swarm/scopes/ for durability across plugin restart.
			const laneScope = correlatedBinding.files;
			await precreateStandardWorktreeSession({
				config,
				directory,
				parentSessionID: input.sessionID,
				callID: input.callID,
				taskId: resolvedTaskId ?? sanitizeWorktreeTaskId(input.callID),
				planTaskId: resolvedTaskId ?? undefined,
				reservationId:
					backgroundCoderReservationByCallID.get(input.callID)?.reservationId ??
					buildBackgroundCoderReservationId({
						parentSessionId: input.sessionID,
						planTaskId: resolvedTaskId,
						callID: input.callID,
					}),
				generation: coderDispatchGeneration,
				description:
					typeof args.description === 'string' ? args.description : undefined,
				outputArgs: args,
				scope:
					laneScope && laneScope.length > 0 && resolvedTaskId
						? { taskId: resolvedTaskId, files: laneScope }
						: undefined,
			});
			const standardDispatch = standardWorktreeByCallID.get(input.callID);
			if (standardDispatch) {
				if (resolvedTaskId) {
					try {
						const childSessionId =
							typeof args.task_id === 'string' ? args.task_id.trim() : '';
						if (!childSessionId || childSessionId === input.sessionID) {
							throw new Error(
								'SCOPE_CHILD_IDENTITY_MISSING: worktree dispatch did not return a distinct child session id',
							);
						}
						// Materialize the current authoritative plan in the isolated root via
						// the ledger-aware writer. Strict child authorization never trusts a
						// binding-era snapshot or a raw hand-written plan projection.
						await savePlan(standardDispatch.handle.worktreePath, plan, {
							preserveCompletedStatuses: false,
						});
						const childBinding = deriveChildScopeBinding(correlatedBinding, {
							childDirectory: standardDispatch.handle.worktreePath,
							childSessionId,
							parentCallId: input.callID,
						});
						await publishScopeBinding(
							input.callID,
							standardDispatch.handle.worktreePath,
							childBinding,
						);
						const childSession = ensureAgentSession(
							childSessionId,
							'coder',
							standardDispatch.handle.worktreePath,
						);
						childSession.currentTaskId = childBinding.taskId;
						childSession.declaredCoderScope = [...childBinding.files];
					} catch (error) {
						clearPublishedScopeBindings(input.callID);
						await cleanupStandardWorktreeForCallId(
							input.callID,
							'denied',
							directory,
							resolveWorktreeIsolationConfig(config).worktree_dir,
						);
						throw error;
					}
				}
				// Record task-change context for the isolated worktree path.
				if (
					shouldRememberCoderTaskChangeContext(
						incomingCoderDeclaredFiles,
						args.background,
					)
				) {
					rememberCoderTaskChangeContext(
						input.callID,
						incomingCoderDeclaredFiles,
						standardDispatch.handle.worktreePath,
						coderDispatchGeneration,
					);
				}
			} else {
				// Isolation may degrade to the project root; capture only after the
				// provisioning attempt and before the upstream coder begins execution.
				if (
					shouldRememberCoderTaskChangeContext(
						incomingCoderDeclaredFiles,
						args.background,
					)
				) {
					rememberCoderTaskChangeContext(
						input.callID,
						incomingCoderDeclaredFiles,
						directory,
						coderDispatchGeneration,
					);
				}
				// Issue #2271 bug 1: when this coder is running un-isolated because
				// worktree isolation degraded (not because the user disabled it),
				// record a durable event so a later dispatch_no_mutation outcome is
				// explainable from the ledger instead of looking like the coder
				// did nothing.
				const degradation = getStandardWorktreeDegradationReason(
					input.sessionID,
				);
				if (degradation) {
					try {
						appendCoreEventSync(directory, {
							type: 'worktree_isolation_degraded',
							timestamp: new Date().toISOString(),
							sessionId: input.sessionID,
							callId: input.callID,
							taskId: incomingCoderTaskId,
							// PR-review PRR-014: the reason embeds git stderr /
							// session-create error text whose producers are not
							// all length-bounded — cap the durable ledger copy.
							reason:
								degradation.reason.length > 500
									? `${degradation.reason.slice(0, 500)}… (truncated)`
									: degradation.reason,
							degradedAt: new Date(degradation.at).toISOString(),
						});
					} catch (eventError) {
						logger.log(
							`[delegation-gate] worktree_isolation_degraded event write failed: ${
								eventError instanceof Error
									? eventError.message
									: String(eventError)
							}`,
						);
					}
				}
				await publishScopeBinding(input.callID, directory, correlatedBinding);
			}
			await beginForegroundCoderSettlementIfNeeded(
				input,
				incomingCoderTaskId,
				args.background,
				standardDispatch
					? {
							callID: standardDispatch.callID,
							parentSessionId: standardDispatch.parentSessionID,
							taskId: incomingCoderTaskId,
							planTaskId: standardDispatch.planTaskId ?? null,
							worktreePath: standardDispatch.handle.worktreePath,
							branchName: standardDispatch.handle.branchName,
							worktreeId: standardDispatch.handle.id,
							worktreeSessionId: standardDispatch.handle.sessionId,
							mergeStrategy: standardDispatch.mergeStrategy,
							laneIndex: standardDispatch.laneIndex,
							worktreeDir: standardDispatch.worktree_dir ?? null,
							provisioningOwner: exactProvisioningOwnerForBackgroundDescriptor(
								standardDispatch.provisioningOwner,
							),
						}
					: undefined,
			);
		} catch (error) {
			await releasePrelaunchBackgroundCoderReservation(input.callID);
			clearPublishedScopeBindings(input.callID);
			clearCoderTaskChangeContext(input.callID);
			throw error;
		}
	};

	// toolAfter: resets qaSkip fields and advances task states based on delegation type
	// Uses stored input args from guardrails when available, falls back to delegationChains
	const toolAfter = async (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
			args?: Record<string, unknown>;
		},
		_output: unknown,
	): Promise<void> => {
		const normalized = normalizeToolName(input.tool);
		const isTaskTool = normalized === 'Task' || normalized === 'task';
		if (!input.sessionID) {
			if (isTaskTool && !outputLooksLikeBackgroundRunning(_output))
				clearPublishedScopeBindings(input.callID);
			return;
		}
		const session = swarmState.agentSessions.get(input.sessionID);
		if (!session) {
			if (isTaskTool && !outputLooksLikeBackgroundRunning(_output))
				clearPublishedScopeBindings(input.callID);
			return;
		}

		// Detect task tool calls
		// Cache council-active status; if true, per-task Stage B advancement is
		// replaced by the council verdict path — reviewer/test_engineer may still
		// be dispatched as council members but do not advance state via the
		// Stage B barrier. The advancement event is the council verdict (handled
		// in the submit_council_verdicts branch below).
		// isCouncilGateActive returns false when the plan or QA gate profile is
		// missing, which is the safe default. Pass session overrides so an
		// operator-applied `/swarm qa-gates override council_mode=true` is
		// honoured without requiring a full set_qa_gates call.
		const { qaGateSessionOverrides } = ensureAgentSession(input.sessionID);
		const councilActive = await isCouncilGateActive(
			directory,
			config.council,
			qaGateSessionOverrides ?? {},
		);

		// Council branch: handle submit_council_verdicts tool calls. Records the verdict on the
		// session, and if APPROVE + allCriteriaMet + zero required fixes, advances the
		// task to 'complete'. State machine still requires pre_check_passed (Stage A).
		if (normalized === 'submit_council_verdicts') {
			try {
				// _output may be a string (older runtimes) or already-parsed object.
				const parsed =
					typeof _output === 'string' ? JSON.parse(_output) : _output;
				const result = parsed as {
					success?: boolean;
					overallVerdict?: 'APPROVE' | 'REJECT' | 'CONCERNS';
					allCriteriaMet?: boolean;
					requiredFixesCount?: number;
					roundNumber?: number;
					// Quorum metadata: present on success responses from
					// submit_council_verdicts. Used downstream to validate the
					// fast-path APPROVE has sufficient distinct members.
					quorumSize?: number;
				} | null;
				if (
					result &&
					typeof result === 'object' &&
					result.success === true &&
					typeof result.overallVerdict === 'string'
				) {
					const directArgs = input.args as Record<string, unknown> | undefined;
					const storedArgs = getStoredInputArgs(input.callID) as
						| Record<string, unknown>
						| undefined;
					const taskIdRaw = directArgs?.taskId ?? storedArgs?.taskId;
					const taskId = typeof taskIdRaw === 'string' ? taskIdRaw : null;
					if (taskId) {
						if (!session.taskCouncilApproved)
							session.taskCouncilApproved = new Map();
						// Preserve a prior reward dedup flag: this .set overwrites the
						// entry on every submit_council_verdicts resolution, so without
						// carrying `rewarded` forward a re-submission for an already-
						// rewarded task would clear the guard and reward twice (A.4
						// requires at-most-once per task).
						const priorRewarded =
							session.taskCouncilApproved.get(taskId)?.rewarded === true;
						session.taskCouncilApproved.set(taskId, {
							verdict: result.overallVerdict,
							roundNumber:
								typeof result.roundNumber === 'number' ? result.roundNumber : 1,
							// ?? 1: conservative fallback when the tool result lacks
							// quorumSize (e.g. older tool versions). The fast-path
							// will reject this against the default minimumMembers=3.
							quorumSize:
								typeof result.quorumSize === 'number' ? result.quorumSize : 1,
							rewarded: priorRewarded,
						});
						if (
							councilActive &&
							result.overallVerdict === 'APPROVE' &&
							result.allCriteriaMet === true &&
							(result.requiredFixesCount ?? 0) === 0
						) {
							pushAdvisory(
								session,
								`Council approved task ${taskId}. Call update_task_status with status="completed" so the central plan/evidence transaction can commit it.`,
							);
						}
					}
				}
			} catch (err) {
				logger.log(
					`[delegation-gate] toolAfter submit_council_verdicts: failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			// Return early — gate-evidence recording (inside the Task branch below)
			// does not apply to submit_council_verdicts: it is a synthesis tool, not a gate
			// delegation, and 'submit_council_verdicts' is not in the gateAgents list.
			return;
		}

		if (normalized === 'Task' || normalized === 'task') {
			// The delegated tool has returned (success or failure). Revoke the exact
			// Task-call authorization before any merge/QA bookkeeping runs.
			// Primary source: input.args from OpenCode's tool.execute.after hook (authoritative)
			// Fallback: stored args from guardrails toolBefore (legacy path)
			const standardDispatch = standardWorktreeByCallID.get(input.callID);
			const directArgsRaw = input.args as Record<string, unknown> | undefined;
			const directArgs = directArgsRaw ? { ...directArgsRaw } : undefined;
			if (standardDispatch && directArgs) {
				if (standardDispatch.planTaskId) {
					directArgs.task_id = standardDispatch.planTaskId;
				} else {
					delete directArgs.task_id;
				}
			}
			const storedArgs = getStoredInputArgs(input.callID) as
				| Record<string, unknown>
				| undefined;
			const subagentType =
				directArgs?.subagent_type ?? storedArgs?.subagent_type;
			const backgroundResultIsRunning =
				outputLooksLikeBackgroundRunning(_output);

			// Issue #1151: background swarm Task handling.
			// A background swarm Task returns a "running" placeholder; it must NEVER advance
			// Stage B or record completed gate evidence here. Detect background from args
			// (direct or stored) or from the result shape, scoped to swarm roles.
			//   - PR 1 (flag OFF): defensive belt-and-suspenders — bail before any advancement.
			//   - PR 2 Stage A (flag ON): additionally record a DURABLE pending delegation so a
			//     later (Stage B) trusted completion can be correlated. Still no gate effect.
			// Either way: clean up stored args so the callID entry does not leak, then bail.
			// A terminal failure must not record a
			// pending delegation — there is no later trusted completion to correlate.
			const outputTerminalState = (_output as { state?: string } | undefined)
				?.state;
			const isTerminalFailure =
				outputTerminalState === 'failed' ||
				outputTerminalState === 'error' ||
				outputTerminalState === 'cancelled' ||
				outputTerminalState === 'canceled';
			if (
				!isTerminalFailure &&
				typeof subagentType === 'string' &&
				isKnownCanonicalRole(stripKnownSwarmPrefix(subagentType)) &&
				(isBackgroundTrue(directArgs?.background) ||
					isBackgroundTrue(storedArgs?.background) ||
					backgroundResultIsRunning)
			) {
				const coderReservation = backgroundCoderReservationByCallID.get(
					input.callID,
				);
				let backgroundRecordDurable = !backgroundSubagentsEnabled;
				let backgroundOwnershipDurable = backgroundRecordDurable;
				let backgroundCorrelationConflict = false;
				if (backgroundSubagentsEnabled) {
					const protectUntrackedBackgroundWorktree = async (
						taskId: string | null | undefined,
						reason: string,
					): Promise<{ detail: string; durable: boolean }> => {
						if (!standardDispatch) {
							return {
								detail: 'no isolated worktree ownership tag was available',
								durable: false,
							};
						}
						let detail: string;
						let durable = false;
						try {
							const preserved =
								await _wtiInternals.preserveBackgroundWorktreeOwnershipForCallId(
									input.callID,
								);
							durable = preserved.outcome === 'preserved';
							detail = durable
								? `ownership tag ${preserved.tag} at ${preserved.ref}`
								: `ownership preservation failed: ${preserved.error ?? preserved.outcome}`;
						} catch (err) {
							detail = `ownership preservation threw: ${err instanceof Error ? err.message : String(err)}`;
						}
						recordWorktreeMergeFailure(taskId ?? undefined, {
							outcome: 'failed',
							stage: 'background-correlation-persist',
							message:
								`${reason}; ${detail}. ` +
								'Automatic orphan reclamation is blocked until the dispatch is recovered.',
							worktreePath: standardDispatch.handle.worktreePath,
							branch: standardDispatch.handle.branchName,
							queuedAt: Date.now(),
						});
						return { detail, durable };
					};
					try {
						const { extractDispatchIds } = await import(
							'../background/task-envelope.js'
						);
						const { buildPromptSnapshot, findByCorrelationId } = await import(
							'../background/pending-delegations.js'
						);
						const { captureWorkspaceSnapshot } = await import(
							'../background/workspace-snapshot.js'
						);
						const { subagentSessionId, jobId } = extractDispatchIds(_output);
						if (!subagentSessionId && !backgroundResultIsRunning) {
							await releasePrelaunchBackgroundCoderReservation(input.callID);
							clearPublishedScopeBindings(input.callID);
							clearCoderTaskChangeContext(input.callID);
							if (storedArgs !== undefined) deleteStoredInputArgs(input.callID);
							return;
						}
						if (subagentSessionId) {
							const mergedArgs = { ...(storedArgs ?? {}), ...directArgs };
							const evidenceTaskId = await resolveEvidenceTaskId(
								mergedArgs,
								session,
								directory,
							);
							const scope =
								session.declaredCoderScope &&
								session.declaredCoderScope.length > 0
									? session.declaredCoderScope.join(',')
									: evidenceTaskId;
							const prHeadShaRaw =
								mergedArgs.prHeadSha ?? mergedArgs.pr_head_sha;
							const prHeadSha =
								typeof prHeadShaRaw === 'string' ? prHeadShaRaw : null;
							const taskChangeContext =
								stripKnownSwarmPrefix(subagentType) === 'coder'
									? coderTaskChangeContextByCallID.get(input.callID)
									: undefined;
							const pendingInputDraft: RecordPendingInput = {
								correlationId: subagentSessionId,
								jobId,
								subagentSessionId,
								parentSessionId: input.sessionID,
								callID: input.callID,
								normalizedAgent: stripKnownSwarmPrefix(subagentType),
								swarmPrefixedAgent: subagentType,
								planTaskId: evidenceTaskId,
								evidenceTaskId,
								workspace: taskChangeContext
									? { ...taskChangeContext.baseline, prHeadSha, scope }
									: captureWorkspaceSnapshot(directory, {
											prHeadSha,
											scope,
										}),
								taskChangeContext,
								workflowGeneration: TASK_GATE_AGENTS.has(
									stripKnownSwarmPrefix(subagentType),
								)
									? stageBDispatchGenerationsByCallID
											.get(input.callID)
											?.get(evidenceTaskId ?? '')
									: undefined,
								worktree: standardDispatch
									? {
											callID: standardDispatch.callID,
											parentSessionId: standardDispatch.parentSessionID,
											taskId: standardDispatch.taskId,
											planTaskId: standardDispatch.planTaskId ?? null,
											worktreePath: standardDispatch.handle.worktreePath,
											branchName: standardDispatch.handle.branchName,
											worktreeId: standardDispatch.handle.id,
											worktreeSessionId: standardDispatch.handle.sessionId,
											mergeStrategy: standardDispatch.mergeStrategy,
											laneIndex: standardDispatch.laneIndex,
											worktreeDir: standardDispatch.worktree_dir ?? null,
											provisioningOwner:
												exactProvisioningOwnerForBackgroundDescriptor(
													standardDispatch.provisioningOwner,
												),
											reservationId: standardDispatch.reservationId,
											generation: standardDispatch.generation,
										}
									: undefined,
								coderReservationId: coderReservation?.reservationId,
								prompt:
									typeof mergedArgs.prompt === 'string'
										? buildPromptSnapshot(mergedArgs.prompt, delegationMaxChars)
										: undefined,
								generation: 1,
							};
							const existingOwner = findByCorrelationId(
								directory,
								subagentSessionId,
							);
							const pendingInput =
								existingOwner &&
								hasStableBackgroundReplayIdentity(
									existingOwner,
									pendingInputDraft,
								)
									? hydrateBackgroundReplayInput(
											existingOwner,
											pendingInputDraft,
										)
									: pendingInputDraft;
							const primaryOutcome =
								await _internals.recordPendingDelegationForBackground(
									directory,
									pendingInput,
									{ staleTimeoutMs: backgroundPendingTimeoutMs },
								);
							backgroundRecordDurable =
								primaryOutcome.status === 'recorded' ||
								primaryOutcome.status === 'duplicate';
							backgroundCorrelationConflict =
								primaryOutcome.status === 'conflict';
							if (primaryOutcome.status === 'conflict') {
								const preservation = await protectUntrackedBackgroundWorktree(
									evidenceTaskId ?? standardDispatch?.planTaskId,
									'background correlation id conflicts with an existing immutable launch owner',
								);
								const worktreeStatus = !standardDispatch
									? 'No isolated worktree was attached to this conflicting call.'
									: preservation.durable
										? `The current worktree was durably preserved with ${preservation.detail}.`
										: `The current worktree was not durably preserved (${preservation.detail}); automatic reclamation remains blocked pending recovery.`;
								const reservationStatus = coderReservation
									? `The current reservation ${coderReservation.reservationId} was retained and was not bound to the conflicting correlation.`
									: primaryOutcome.record.coderReservationId
										? `No new reservation was present for this replay; the durable owner's reservation ${primaryOutcome.record.coderReservationId} remains unchanged.`
										: 'No current or durable-owner coder reservation was present.';
								backgroundOwnershipDurable = preservation.durable;
								pushAdvisory(
									session,
									`BACKGROUND DELEGATION CORRELATION CONFLICT: ${subagentType} (${subagentSessionId}) collided with a different durable launch owner (parent=${primaryOutcome.record.parentSessionId}, call=${primaryOutcome.record.callID}, agent=${primaryOutcome.record.swarmPrefixedAgent}, task=${primaryOutcome.record.planTaskId ?? 'none'}). Inspect that existing owner and reconcile it before continuing. ${worktreeStatus} ${reservationStatus} No fallback owner was written and no reservation was bound. Do not abort, delete, or re-dispatch this correlation until reconciliation is complete. Do not advance task ${evidenceTaskId ?? 'unknown'} until the collision is resolved.`,
								);
							} else if (primaryOutcome.status === 'failed') {
								backgroundRecordDurable =
									(await _internals.writeDelegationFallbackForBackground(
										directory,
										pendingInput,
									)) !== null;
								if (backgroundRecordDurable) {
									logger.warn(
										`[delegation-gate] background delegation ${subagentSessionId} persisted to the independent fallback artifact after the primary ledger write failed`,
									);
								}
							}
							if (!backgroundCorrelationConflict && !backgroundRecordDurable) {
								const preservation = await protectUntrackedBackgroundWorktree(
									evidenceTaskId ?? standardDispatch?.planTaskId,
									'both background correlation stores failed',
								);
								backgroundOwnershipDurable = preservation.durable;
								pushAdvisory(
									session,
									`BACKGROUND DELEGATION UNTRACKED: ${subagentType} (${subagentSessionId}) launched, but both durable correlation stores failed. Recovery protection: ${preservation.detail}. Do not advance task ${evidenceTaskId ?? 'unknown'} until the dispatch is recovered.`,
								);
							} else if (!backgroundCorrelationConflict) {
								backgroundOwnershipDurable = true;
								if (coderReservation) {
									const bound =
										await _internals.bindBackgroundCoderReservationForDispatch(
											directory,
											{
												...coderReservation,
												correlationId: subagentSessionId,
												// Bind to the record's launch generation (issue
												// #2104): the reservation tracks exactly the
												// generation that owns the durable correlation.
												generation: pendingInput.generation ?? 1,
											},
										);
									if (!bound) {
										pushAdvisory(
											session,
											`BACKGROUND CODER RESERVATION UNBOUND: task ${evidenceTaskId ?? 'unknown'} is durably tracked, but its pre-launch reservation could not be bound to ${subagentSessionId}. Further coder admission remains fail-closed until completion or recovery reconciles it.`,
										);
									}
								}
							}
						} else {
							// No usable correlation id (no jobId and no parseable dispatch
							// envelope). Do not invent an owner. Preserve the isolated
							// worktree durably and tell the architect to fail closed.
							const preservation = await protectUntrackedBackgroundWorktree(
								standardDispatch?.planTaskId,
								'background dispatch returned no trusted correlation id',
							);
							backgroundOwnershipDurable = preservation.durable;
							logger.warn(
								'[delegation-gate] background dispatch had no correlation id (no jobId / no envelope) — not tracked',
							);
							pushAdvisory(
								session,
								`BACKGROUND DELEGATION UNCORRELATED: ${subagentType} launched without a trusted session correlation. Recovery protection: ${preservation.detail}. Do not advance the task until the dispatch is recovered or safely re-dispatched.`,
							);
						}
					} catch (err) {
						const preservation = await protectUntrackedBackgroundWorktree(
							standardDispatch?.planTaskId,
							'background dispatch correlation recording threw',
						);
						backgroundOwnershipDurable = preservation.durable;
						logger.warn(
							`[delegation-gate] background pending recording failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						pushAdvisory(
							session,
							`BACKGROUND DELEGATION DURABILITY FAILURE: ${subagentType} launched, but its completion owner could not be persisted. Recovery protection: ${preservation.detail}. Do not advance the task until the dispatch is recovered.`,
						);
					}
				}
				if (backgroundOwnershipDurable) {
					const provisioningOwner =
						standardDispatch?.provisioningOwner ??
						(standardDispatch?.reservationId !== undefined &&
						standardDispatch?.generation !== undefined
							? {
									reservationId: standardDispatch.reservationId,
									generation: standardDispatch.generation,
									branchName: standardDispatch.handle.branchName,
								}
							: undefined);
					_wtiInternals.removeWorktreeProvisioningOwner(
						directory,
						input.callID,
						provisioningOwner,
					);
				}
				if (backgroundRecordDurable) {
					clearCoderTaskChangeContext(input.callID);
					stageBDispatchGenerationsByCallID.delete(input.callID);
					gateDispatchPrimaryTaskByCallID.delete(input.callID);
					stageBDispatchContextByCallID.delete(input.callID);
					if (storedArgs !== undefined) deleteStoredInputArgs(input.callID);
				}
				if (!backgroundCorrelationConflict) {
					backgroundCoderReservationByCallID.delete(input.callID);
				}
				if (!backgroundResultIsRunning)
					clearPublishedScopeBindings(input.callID);
				return;
			}
			const foregroundCoderTaskId =
				typeof subagentType === 'string' &&
				stripKnownSwarmPrefix(subagentType) === 'coder'
					? (standardDispatch?.planTaskId ??
						standardDispatch?.taskId ??
						(typeof directArgs?.task_id === 'string'
							? directArgs.task_id
							: typeof storedArgs?.task_id === 'string'
								? storedArgs.task_id
								: null))
					: null;
			// The child has returned, so its exact write lease must end before
			// settlement/merge bookkeeping. A durability failure fences the output;
			// it must not leave the child authorized to create more unattributed work.
			clearPublishedScopeBindings(input.callID);
			try {
				if (typeof subagentType === 'string') {
					try {
						const mergedArgs = { ...(storedArgs ?? {}), ...(directArgs ?? {}) };
						await recordPlanCriticApprovalSnapshotIfApplicable(
							directory,
							input,
							mergedArgs,
							_output,
						);
					} catch (err) {
						logger.warn(
							`[delegation-gate] plan critic approval snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}

				// M15 advisory-only: surface delegation-envelope validation issues
				// WITHOUT blocking. toolAfter runs POST-execution (the tool already ran),
				// so this can never reject a delegation. appendDelegationEnvelopeAdvisory
				// runs validateDelegationEnvelope — formerly dead production code — only
				// when the prompt parses as a STRUCTURED envelope; a real free-text
				// delegation is a no-op. planTasks is left empty so an off-plan taskId is
				// never advised; validAgents covers the canonical role set so a genuinely
				// unknown target agent (or a populated-but-malformed specCriteria field)
				// is surfaced.
				if (typeof subagentType === 'string') {
					const advisoryArgs = { ...(storedArgs ?? {}), ...(directArgs ?? {}) };
					const advisoryPrompt = advisoryArgs.prompt;
					if (typeof advisoryPrompt === 'string' && advisoryPrompt.length > 0) {
						appendDelegationEnvelopeAdvisory(session, advisoryPrompt, {
							planTasks: [],
							validAgents: [...ALL_AGENT_NAMES],
						});
					}
				}

				let standardWorktreeSettled = !standardDispatch;
				let coderSettlementCommitted = false;
				let coderSettlementEvidence:
					| Awaited<ReturnType<typeof settleCoderDispatch>>['evidence']
					| null = null;
				// A terminal failure (cancelled/error/failed) must not attempt merge-back.
				// The worktree is preserved for inspection and cleaned up without merging.
				const isStandardWorktreeFailure =
					outputTerminalState === 'cancelled' ||
					outputTerminalState === 'failed' ||
					outputTerminalState === 'error';
				if (standardDispatch && !isStandardWorktreeFailure) {
					const taskChangeContext = coderTaskChangeContextByCallID.get(
						input.callID,
					);
					if (taskChangeContext) {
						rememberCoderObservedFiles(
							input.callID,
							changedFilesSinceSnapshot(
								taskChangeContext.baseline.directory,
								taskChangeContext.baseline,
							),
						);
					}
					// SC-115: Move from active → awaiting-merge BEFORE calling merge-back.
					// The dispatch is removed from standardWorktreeByCallID here and
					// added to awaitingMergeByCallID so /swarm lanes can show the real state.
					// finishStandardWorktreeDispatch removes it from awaitingMergeByCallID
					// after the merge completes (merged/partial/failed); the .catch() below
					// handles the thrown-rejection path.
					standardWorktreeByCallID.delete(input.callID);
					awaitingMergeByCallID.set(input.callID, {
						callID: input.callID,
						parentSessionID: standardDispatch.parentSessionID,
						taskId: standardDispatch.taskId,
						planTaskId: standardDispatch.planTaskId,
						branch: standardDispatch.handle.branchName,
						worktreePath: standardDispatch.handle.worktreePath,
						mergeStrategy: standardDispatch.mergeStrategy,
						queuedAt: Date.now(),
					});
					const observedForMerge = coderObservedFilesByCallID.get(input.callID);
					if (!Array.isArray(observedForMerge)) {
						throw new Error(
							`CODER_SETTLEMENT_ATTRIBUTION_UNCERTAIN: isolated task ${standardDispatch.planTaskId ?? standardDispatch.taskId} changed files could not be proven from its clean launch baseline`,
						);
					}
					const settlement = await finishStandardWorktreeDispatch(
						directory,
						standardDispatch,
						config,
						input.callID,
						{
							operationId: `coder:${input.callID}`,
							onBeforeMerge: (provenance) =>
								recordCoderMergeProvenance({
									directory,
									taskId:
										standardDispatch.planTaskId ?? standardDispatch.taskId,
									transitionId: `coder:${input.callID}`,
									provenance,
									observedFiles: observedForMerge,
								}),
							onMerged: async () => {
								const result = await settleCoderDispatch({
									directory,
									taskId:
										standardDispatch.planTaskId ?? standardDispatch.taskId,
									transitionId: `coder:${input.callID}`,
									accepted: observedForMerge.length > 0,
									testEngineerExempt: isMarkdownOnlyTaskChange(
										coderTaskChangeContextByCallID.get(input.callID)
											?.declaredFiles,
										observedForMerge,
									),
								});
								coderSettlementEvidence = result.evidence;
								coderSettlementCommitted = true;
							},
						},
					).catch((err) => {
						const reason = err instanceof Error ? err.message : String(err);
						logger.warn(
							`[delegation-gate] standard worktree merge-back failed for ${standardDispatch.taskId}: ${reason}`,
						);
						// A thrown merge-back is a hard failure: the task's work
						// did not land. Record it so Epic Rule 2 skips the
						// completion marker (same contract as the partial/failed
						// returns inside finishStandardWorktreeDispatch).
						recordWorktreeMergeFailure(
							standardDispatch.planTaskId ?? standardDispatch.taskId,
							{
								outcome: 'failed',
								stage: 'merge-back',
								message: reason,
								worktreePath: standardDispatch.handle.worktreePath,
								branch: standardDispatch.handle.branchName,
								completedAt: Date.now(),
							},
						);
						const dispatchSession = ensureAgentSession(
							standardDispatch.parentSessionID,
						);
						pushAdvisory(
							dispatchSession,
							`STANDARD_WORKTREE_MERGE_FAILED: task ${standardDispatch.taskId} preserved at ${standardDispatch.handle.worktreePath}; reason: ${reason}.`,
						);
						// SC-115: Remove from awaiting-merge registry after recording failure.
						awaitingMergeByCallID.delete(input.callID);
					});
					standardWorktreeSettled = settlement?.outcome === 'merged';
				}
				if (standardDispatch && isStandardWorktreeFailure) {
					// Terminal failure: preserve the worktree for inspection, clean up
					// the lane without merge-back, and record the failure.
					standardWorktreeByCallID.delete(input.callID);
					const reason = (
						outputTerminalState === 'cancelled' ? 'cancelled' : 'denied'
					) as 'cancelled' | 'denied';
					await _wtiInternals.preserveDirtyWorktreeForCallId(
						input.callID,
						reason,
						directory,
					);
					await _wtiInternals.removeWorktree(
						standardDispatch.handle.worktreePath,
						directory,
					);
					await _wtiInternals.postMergeCleanup(
						directory,
						standardDispatch.handle.branchName,
					);
					awaitingMergeByCallID.delete(input.callID);
					recordWorktreeMergeFailure(
						standardDispatch.planTaskId ?? standardDispatch.taskId,
						{
							outcome: 'failed',
							stage: 'task-result',
							message: `task terminated with ${outputTerminalState ?? 'terminal-failure'}`,
						},
					);
					const dispatchSession = ensureAgentSession(
						standardDispatch.parentSessionID,
					);
					pushAdvisory(
						dispatchSession,
						`STANDARD_WORKTREE_TASK_FAILED: task ${standardDispatch.taskId} terminated with ${outputTerminalState ?? 'terminal-failure'}; worktree preserved and cleaned without merge-back.`,
					);
				}

				// Track if we detected reviewer and/or test_engineer via stored args
				let hasReviewer = false;
				let hasTestEngineer = false;

				// Primary path: use stored input args if available
				if (typeof subagentType === 'string') {
					const targetAgent = stripKnownSwarmPrefix(subagentType);

					// Track which agents have been delegated to
					if (targetAgent === 'reviewer') hasReviewer = true;
					if (targetAgent === 'test_engineer') hasTestEngineer = true;

					// When council_mode is enabled, per-task Stage B (reviewer + test_engineer
					// barrier) is replaced by the council verdict path (submit_council_verdicts).
					// Stage B delegations may still occur as part of the 5-member council dispatch,
					// but they do not advance state through the Stage B barrier.
					if (!councilActive) {
						const stageBParallelEnabled = true;

						if (stageBParallelEnabled) {
							// ── PR 2 Stage B parallel path ──────────────────────────────────
							// Order-independent barrier: record each completion independently.
							// Advance to tests_run only when BOTH reviewer and test_engineer
							// have completed. Either may complete first.
							// A terminal failure must never advance Stage B.
							const outputStatus = (_output as { status?: string } | undefined)
								?.status;
							if (
								outputStatus !== 'failed' &&
								!isStandardWorktreeFailure &&
								(targetAgent === 'reviewer' ||
									targetAgent === 'test_engineer') &&
								session.taskWorkflowStates
							) {
								const stageBEligibleStates = [
									'pre_check_passed',
									'reviewer_run',
								] as const;
								type EligibleState = (typeof stageBEligibleStates)[number];

								// FR-007: Try to parse per-task verdicts from dispatch output.
								// When a reviewer or test_engineer covers multiple tasks (set-dispatch),
								// it emits structured verdict lines like:
								//   [REVIEWED] | task-2.1 | APPROVED | ...
								//   [TESTED] | task-2.1 | PASS | ...
								// If parseable, attribute per-task rather than over-attributing to
								// every task in taskWorkflowStates.
								const attributionResult = parsePerTaskVerdicts(
									outputText(_output),
								);
								for (const err of attributionResult.errors) {
									logger.warn(`[delegation-gate] ${err}`);
								}
								do {
									if (attributionResult.verdicts.size === 0) {
										const dispatchCtx = stageBDispatchContextByCallID.get(
											input.callID,
										);
										const expectedTasks = dispatchCtx
											? [...dispatchCtx.taskIds].join(', ')
											: (gateDispatchPrimaryTaskByCallID.get(input.callID) ??
												'unknown');
										logger.warn(
											`[delegation-gate] STAGE_B_ATTRIBUTION_MISSING: ${targetAgent} dispatch for call ${input.callID} returned no structured verdict lines. Expected tasks: ${expectedTasks}. Agent output must include [REVIEWED] or [TESTED] verdict lines.`,
										);
										const failClosedTaskIds = dispatchCtx
											? [...dispatchCtx.taskIds]
											: gateDispatchPrimaryTaskByCallID.has(input.callID)
												? [gateDispatchPrimaryTaskByCallID.get(input.callID)!]
												: [];
										for (const failTaskId of failClosedTaskIds) {
											const failState =
												session.taskWorkflowStates.get(failTaskId);
											if (
												failState &&
												(stageBEligibleStates as readonly string[]).includes(
													failState,
												)
											) {
												session.taskWorkflowStates.set(
													failTaskId,
													'rework_required',
												);
												session.stageBCompletion?.delete(failTaskId);
												logger.warn(
													`[delegation-gate] STAGE_B_ATTRIBUTION_MISSING fail-closed: task ${failTaskId} → rework_required`,
												);
											}
										}
										break;
									}

									const {
										getTaskWorkflowSnapshot,
										readTaskEvidence,
										transitionTaskWorkflowEvidence,
									} = await import('../gate-evidence');
									for (const [taskId, state] of session.taskWorkflowStates) {
										if (
											!(stageBEligibleStates as readonly string[]).includes(
												state,
											)
										)
											continue;
										if (!attributionResult.verdicts.has(taskId)) continue;
										const eligibleState = state as EligibleState;
										const launchGeneration = stageBDispatchGenerationsByCallID
											.get(input.callID)
											?.get(taskId);
										if (launchGeneration === undefined) {
											logger.warn(
												`[delegation-gate] ignoring unbound Stage B settlement for ${taskId} from call ${input.callID}`,
											);
											continue;
										}
										const verdictEntry = attributionResult.verdicts.get(taskId);
										const dispatchCtxForVerdict =
											stageBDispatchContextByCallID.get(input.callID);
										const positiveVerdict =
											dispatchCtxForVerdict?.expectedVerdictKind === 'TESTED'
												? verdictEntry?.verdict === 'PASS'
												: verdictEntry?.verdict === 'APPROVED';
										if (!positiveVerdict) {
											try {
												const rejected = await transitionTaskWorkflowEvidence(
													directory,
													taskId,
													{
														type: 'stage_b_failed',
														gate: targetAgent as 'reviewer' | 'test_engineer',
														expectedGeneration: launchGeneration,
														transitionId: `gate-failed:${input.callID}:${taskId}`,
													},
												);
												session.taskWorkflowStates.set(
													taskId,
													'rework_required',
												);
												session.stageBCompletion?.delete(taskId);
												updateTaskWorkflowCache(
													session,
													taskId,
													getTaskWorkflowSnapshot(rejected),
												);
											} catch (err) {
												logger.warn(
													`[delegation-gate] Stage B rejection could not be persisted for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
												);
											}
											continue;
										}
										try {
											const turbo = hasActiveTurboMode(input.sessionID);
											const { recordGateEvidence } = await import(
												'../gate-evidence'
											);
											await recordGateEvidence(
												directory,
												taskId,
												targetAgent as 'reviewer' | 'test_engineer',
												input.sessionID,
												turbo,
												{
													expectedGeneration: launchGeneration,
													transitionId: `gate:${input.callID}:${taskId}`,
												},
											);
										} catch (err) {
											logger.warn(
												`[delegation-gate] Stage B settlement rejected for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
											);
											continue;
										}
										recordStageBCompletion(
											session,
											taskId,
											targetAgent as 'reviewer' | 'test_engineer',
										);

										const taskEvidence = await readTaskEvidence(
											directory,
											taskId,
										);
										const reviewerCompletesStageB =
											targetAgent === 'reviewer' &&
											taskEvidence?.test_engineer_exempt === true;
										if (
											hasBothStageBCompletions(session, taskId) ||
											reviewerCompletesStageB
										) {
											// Barrier reached: both reviewer and test_engineer have completed.
											// Advance through reviewer_run → tests_run in a single compound
											// step so the state machine stays consistent.
											try {
												if (eligibleState === 'pre_check_passed') {
													advanceTaskState(session, taskId, 'reviewer_run', {
														telemetrySessionId: input.sessionID,
													});
												}
												advanceTaskState(session, taskId, 'tests_run', {
													telemetrySessionId: input.sessionID,
												});
											} catch (err) {
												logger.warn(
													`[delegation-gate] toolAfter stage-b-parallel: could not advance ${taskId} (${eligibleState}) → tests_run: ${err instanceof Error ? err.message : String(err)}`,
												);
											}
										} else {
											// Intermediate advancement: advance state immediately when a
											// single Stage B agent completes, without waiting for the barrier.
											// This preserves the sequential-equivalent state machine contract:
											//   coder_delegated → reviewer_run  (when reviewer completes)
											//   reviewer_run → tests_run        (when test_engineer completes)
											// The barrier path above handles the case where both complete
											// while state is still coder_delegated (compound step).
											try {
												if (
													targetAgent === 'reviewer' &&
													eligibleState === 'pre_check_passed'
												) {
													advanceTaskState(session, taskId, 'reviewer_run', {
														telemetrySessionId: input.sessionID,
													});
												} else if (
													targetAgent === 'test_engineer' &&
													eligibleState === 'reviewer_run'
												) {
													advanceTaskState(session, taskId, 'tests_run', {
														telemetrySessionId: input.sessionID,
													});
												}
											} catch (err) {
												logger.warn(
													`[delegation-gate] toolAfter stage-b-parallel intermediate: could not advance ${taskId} (${eligibleState}) after ${targetAgent}: ${err instanceof Error ? err.message : String(err)}`,
												);
											}
										}
									}
								} while (false as boolean);
							}
						}
					} // end if (!councilActive) — primary Stage B path
				}

				// Record gate evidence for stored-args path
				// v6.33.7: Entire block wrapped in try-catch — getEvidenceTaskId can
				// re-throw unexpected errors (EPERM, EBUSY on Windows) which previously
				// escaped outside the evidence try-catch and propagated to safeHook.
				if (typeof subagentType === 'string') {
					let coderSettleTaskId: string | null = null;
					try {
						const mergedArgs = { ...(storedArgs ?? {}), ...directArgs };
						let evidenceTaskId = await resolveEvidenceTaskId(
							mergedArgs,
							session,
							directory,
						);
						// Issue #2214 belt: the toolBefore scope preflight may have
						// resolved the task via sources resolveEvidenceTaskId lacks
						// (e.g. the declare_scope pending-scope map). For a coder
						// dispatch whose settlement this call durably began, trust the
						// begun-settlement record instead of silently skipping
						// finalization — a skipped settle wedges the DISPATCHED WAL.
						if (
							!evidenceTaskId &&
							stripKnownSwarmPrefix(subagentType) === 'coder'
						) {
							const begun = begunCoderSettlementsByCallID.get(input.callID);
							if (begun?.taskId) evidenceTaskId = begun.taskId;
						}
						coderSettleTaskId = evidenceTaskId;
						if (evidenceTaskId) {
							const turbo = hasActiveTurboMode(input.sessionID);
							const gateAgents = [
								'reviewer',
								'test_engineer',
								'docs',
								'designer',
								'critic',
								'critic_sounding_board',
								'explorer',
								'sme',
							];
							const targetAgentForEvidence =
								stripKnownSwarmPrefix(subagentType);
							if (gateAgents.includes(targetAgentForEvidence)) {
								if (
									targetAgentForEvidence === 'reviewer' ||
									targetAgentForEvidence === 'test_engineer'
								) {
									// Primary Stage B handling above is the sole verdict-aware writer.
								} else {
									const positiveGateSettlement =
										!isTerminalFailure &&
										((targetAgentForEvidence !== 'critic' &&
											targetAgentForEvidence !== 'critic_sounding_board') ||
											extractPlanCriticVerdict(_output) === 'APPROVED');
									if (!positiveGateSettlement) {
										throw new Error(
											`TASK_GATE_NOT_SATISFIED: ${targetAgentForEvidence} did not return a trusted positive verdict`,
										);
									}
									const { recordGateEvidence } = await import(
										'../gate-evidence'
									);
									const gateLaunchGeneration = stageBDispatchGenerationsByCallID
										.get(input.callID)
										?.get(evidenceTaskId);
									if (
										TASK_GATE_AGENTS.has(targetAgentForEvidence) &&
										gateLaunchGeneration === undefined
									) {
										throw new Error(
											`TASK_WORKFLOW_GENERATION_REQUIRED: no launch binding for ${targetAgentForEvidence} task ${evidenceTaskId}`,
										);
									}
									await recordGateEvidence(
										directory,
										evidenceTaskId,
										targetAgentForEvidence,
										input.sessionID,
										turbo,
										{
											expectedGeneration: gateLaunchGeneration,
											transitionId: `gate:${input.callID}:${evidenceTaskId}`,
										},
									);
								}
							} else {
								const { getTaskWorkflowSnapshot, recordAgentDispatch } =
									await import('../gate-evidence');
								const taskChangeContext =
									targetAgentForEvidence === 'coder'
										? coderTaskChangeContextByCallID.get(input.callID)
										: undefined;
								const rawObservedFiles = taskChangeContext
									? (coderObservedFilesByCallID.get(input.callID) ??
										changedFilesSinceSnapshot(
											taskChangeContext.baseline.directory,
											taskChangeContext.baseline,
										))
									: null;
								if (
									targetAgentForEvidence === 'coder' &&
									!Array.isArray(rawObservedFiles)
								) {
									throw new Error(
										`CODER_SETTLEMENT_ATTRIBUTION_UNCERTAIN: shared-root task ${evidenceTaskId} changed files could not be proven from its clean launch baseline`,
									);
								}
								const observedFiles =
									taskChangeContext?.declaredFiles &&
									Array.isArray(rawObservedFiles)
										? rawObservedFiles.filter((filePath) =>
												isPathWithinDeclaredScope(
													filePath,
													taskChangeContext.declaredFiles as string[],
													taskChangeContext.baseline.directory,
												),
											)
										: [];
								const context = {
									testEngineerExempt:
										targetAgentForEvidence === 'coder' &&
										isMarkdownOnlyTaskChange(
											taskChangeContext?.declaredFiles,
											observedFiles,
										),
								};
								if (targetAgentForEvidence === 'coder') {
									const accepted =
										(!standardDispatch || !isTerminalFailure) &&
										standardWorktreeSettled &&
										Array.isArray(observedFiles) &&
										observedFiles.length > 0;
									let updated: Awaited<
										ReturnType<typeof settleCoderDispatch>
									>['evidence'];
									if (standardDispatch && !isStandardWorktreeFailure) {
										if (!coderSettlementCommitted || !coderSettlementEvidence) {
											throw new Error(
												`CODER_SETTLEMENT_NOT_COMMITTED: isolated merge for ${evidenceTaskId} did not durably publish accepted-mutation evidence`,
											);
										}
										updated = coderSettlementEvidence;
									} else {
										const settlement = await settleCoderDispatch({
											directory,
											taskId: evidenceTaskId,
											transitionId: `coder:${input.callID}`,
											accepted,
											testEngineerExempt: context.testEngineerExempt === true,
											settlementFailed: !standardDispatch && isTerminalFailure,
										});
										updated = settlement.evidence;
										coderSettlementCommitted = true;
									}
									if (accepted) {
										const workflow = getTaskWorkflowSnapshot(updated);
										session.taskWorkflowStates.set(
											evidenceTaskId,
											workflow.state,
										);
										session.stageBCompletion?.delete(evidenceTaskId);
										session.taskCouncilApproved?.delete(evidenceTaskId);
										session.taskCouncilWorkflowGeneration?.delete(
											evidenceTaskId,
										);
										updateTaskWorkflowCache(session, evidenceTaskId, workflow);
									}
								} else {
									await recordAgentDispatch(
										directory,
										evidenceTaskId,
										targetAgentForEvidence,
										turbo,
										context,
									);
								}
							}
						}
					} catch (err) {
						const normalizedAgent = stripKnownSwarmPrefix(subagentType);
						logger.warn(
							`[delegation-gate] evidence recording failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						if (normalizedAgent === 'coder') {
							// Issue #2214: a coder settle failure that never reached
							// settleCoderDispatch leaves the DISPATCHED WAL with its
							// in-memory ownership key retained — same-process recovery
							// would throw CODER_DISPATCH_IN_PROGRESS forever. Release the
							// key (idempotent) so recoverCoderSettlement can retry, and
							// abort the WAL outright when its recorded launch baseline
							// was structurally attribution-doomed (non-git or dirty at
							// dispatch) — that settlement can never complete.
							let terminalAbort = false;
							if (coderSettleTaskId && !coderSettlementCommitted) {
								releaseCoderDispatchOwnership(
									directory,
									coderSettleTaskId,
									`coder:${input.callID}`,
								);
								try {
									const abortOutcome = await abortCoderSettlementIfDoomed({
										directory,
										taskId: coderSettleTaskId,
										transitionId: `coder:${input.callID}`,
									});
									terminalAbort =
										abortOutcome === 'aborted' ||
										abortOutcome === 'already-aborted';
								} catch (abortErr) {
									logger.warn(
										`[delegation-gate] doomed settlement abort failed for ${coderSettleTaskId}: ${
											abortErr instanceof Error
												? abortErr.message
												: String(abortErr)
										}`,
									);
								}
								if (terminalAbort) {
									// PRR-001: the dispatch is terminally settled; its
									// change context is exhausted (recovery reads the WAL).
									clearCoderTaskChangeContext(input.callID);
								}
							}
							if (terminalAbort) {
								pushAdvisory(
									session,
									`CODER_SETTLEMENT_ABORTED: task ${coderSettleTaskId} dispatch ${input.callID} was settled as ABORTED — its launch baseline was dirty or had no git history, so the coder's changes cannot be attributed. Reconcile the workspace (commit, stash, or discard the coder's output), then repair the task with update_task_status and re-dispatch from a clean tree.`,
								);
							} else {
								pushAdvisory(
									session,
									`CODER_SETTLEMENT_DURABILITY_FAILURE: task output remains fenced until accepted-mutation evidence for call ${input.callID} is recovered.`,
								);
							}
							throw err;
						}
					} finally {
						if (stripKnownSwarmPrefix(subagentType) === 'coder') {
							if (coderSettlementCommitted) {
								clearCoderTaskChangeContext(input.callID);
								clearPublishedScopeBindings(input.callID);
							}
							// PRR-001: both purposes of the begun-settlement entry —
							// denial rollback (a denied call never reaches toolAfter)
							// and the task-id fallback above — are exhausted once
							// toolAfter has run for this callID.
							begunCoderSettlementsByCallID.delete(input.callID);
							// The coder settle failure above RETHROWS, so the post-block
							// cleanup (stored args, Stage B generation bindings) never
							// runs on that path — drain it here instead. Idempotent
							// with the success-path deletes below.
							if (!coderSettlementCommitted) {
								stageBDispatchGenerationsByCallID.delete(input.callID);
								gateDispatchPrimaryTaskByCallID.delete(input.callID);
								deleteStoredInputArgs(input.callID);
							}
						}
					}
				}

				// Always clean up stored args if they exist, regardless of subagent_type validity
				if (storedArgs !== undefined) {
					deleteStoredInputArgs(input.callID);
				}

				// Fallback: use delegationChains if stored args not available.
				// Also runs when councilActive so the chain scan can reset qaSkipCount
				// after council members (reviewer + test_engineer) complete — the primary
				// path sets hasReviewer=true which would otherwise suppress this scan.
				if (!subagentType || !hasReviewer || councilActive) {
					const delegationChain = swarmState.delegationChains.get(
						input.sessionID,
					);
					if (delegationChain && delegationChain.length > 0) {
						// Find the index of the last 'coder' entry in the chain
						let lastCoderIndex = -1;
						for (let i = delegationChain.length - 1; i >= 0; i--) {
							const target = stripKnownSwarmPrefix(delegationChain[i].to);
							if (target.includes('coder')) {
								lastCoderIndex = i;
								break;
							}
						}

						// If no coder in chain, skip qaSkip reset but still scan the
						// full chain for reviewer/test_engineer so state advancement
						// can proceed (pure verification tasks have no coder delegation).
						const searchStart = lastCoderIndex === -1 ? 0 : lastCoderIndex;

						// Walk forward from coder index (or start of chain if no coder)
						const afterCoder = delegationChain.slice(searchStart);
						for (const delegation of afterCoder) {
							const target = stripKnownSwarmPrefix(delegation.to);
							if (target === 'reviewer') hasReviewer = true;
							if (target === 'test_engineer') hasTestEngineer = true;
						}

						// Only reset qaSkip when BOTH have been seen since last coder
						// (skip qaSkip reset entirely when there's no coder in chain).
						// Council members include reviewer + test_engineer, so when
						// councilActive is true the reset fires via the chain scan even
						// though Stage B advancement is skipped below.
						if (lastCoderIndex !== -1 && hasReviewer && hasTestEngineer) {
							session.qaSkipCount = 0;
							session.qaSkipTaskIds = [];
						}
					}
				}

				stageBDispatchGenerationsByCallID.delete(input.callID);
				gateDispatchPrimaryTaskByCallID.delete(input.callID);
				stageBDispatchContextByCallID.delete(input.callID);

				// ── Completion gate: push advisory if a task awaits completion ──
				// B3 (issue #1976): the `break` below only caps pushes to one per
				// toolBefore invocation; without cross-invocation state, a task stuck
				// in tests_run re-injected the identical directive on EVERY Task tool
				// call. Track warned task IDs so the same stuck task warns once.
				if (session.taskWorkflowStates) {
					for (const [, state] of session.taskWorkflowStates) {
						if (state === 'tests_run') {
							const taskAwaiting = await findTaskAwaitingCompletion(directory);
							if (
								taskAwaiting &&
								!session.completionGateWarnedForTask.has(taskAwaiting)
							) {
								pushAdvisory(
									session,
									completionGateViolationMessage(taskAwaiting),
								);
								session.completionGateWarnedForTask.add(taskAwaiting);
							}
							break; // only push once
						}
					}
				}
				if (standardWorktreeSettled && coderSettlementCommitted) {
					if (foregroundCoderTaskId) {
						await completeCoderSettlementCleanup(
							directory,
							foregroundCoderTaskId,
							`coder:${input.callID}`,
						);
					}
				}
			} finally {
				if (foregroundCoderTaskId) {
					releaseCoderDispatchOwnership(
						directory,
						foregroundCoderTaskId,
						`coder:${input.callID}`,
					);
				}
			}
		}
	};

	return {
		toolBefore,
		messagesTransform: async (
			_input: Record<string, never>,
			output: { messages?: MessageWithParts[] },
		): Promise<void> => {
			// biome-ignore lint/suspicious/noExplicitAny: output type from LLM API is not fully typed
			const messages = (output as any).messages;
			if (!messages || messages.length === 0) return;

			// Find the last user message
			let lastUserMessageIndex = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.info?.role === 'user') {
					lastUserMessageIndex = i;
					break;
				}
			}

			if (lastUserMessageIndex === -1) return;

			const lastUserMessage = messages[lastUserMessageIndex];
			if (!lastUserMessage?.parts) return;

			// Only operate when architect is the active agent
			// Check if agent is undefined (main session = architect) or is 'architect' (after stripping prefix)
			// Skip empty string agent names (invalid/uninitialized state)
			const agent = lastUserMessage.info?.agent;
			if (agent === '') return; // Skip empty string explicitly
			const strippedAgent = agent ? stripKnownSwarmPrefix(agent) : undefined;
			if (strippedAgent && strippedAgent !== 'architect') return;

			// Find the first text part
			const textPartIndex = lastUserMessage.parts.findIndex(
				(p: MessagePart) => p?.type === 'text' && p.text !== undefined,
			);

			if (textPartIndex === -1) return;

			const textPart = lastUserMessage.parts[textPartIndex];
			const text = textPart.text ?? '';

			// Progressive task disclosure: trim task list to a window around the current task
			// Scans the text for task list blocks containing '- [ ]' or '- [x]' with task IDs.
			// If more than 5 tasks are visible, trims to: currentTask ± window.
			const taskDisclosureSessionID = lastUserMessage.info?.sessionID;
			if (taskDisclosureSessionID) {
				const taskSession = ensureAgentSession(taskDisclosureSessionID);
				const currentTaskIdForWindow = taskSession.currentTaskId;
				if (currentTaskIdForWindow) {
					// Match task list lines: '- [ ] N.M: ...' or '- [x] N.M: ...' or '- N.M: ...'
					const taskLineRegex =
						/^[ \t]*-[ \t]*(?:\[[ x]\][ \t]+)?(\d+\.\d+(?:\.\d+)*)[:. ].*/gm;
					const taskLines: Array<{
						line: string;
						taskId: string;
						index: number;
					}> = [];
					taskLineRegex.lastIndex = 0;
					let regexMatch = taskLineRegex.exec(text);
					while (regexMatch !== null) {
						taskLines.push({
							line: regexMatch[0],
							taskId: regexMatch[1],
							index: regexMatch.index,
						});
						regexMatch = taskLineRegex.exec(text);
					}

					if (taskLines.length > 5) {
						// Find the index of the current task in the task list
						const currentIdx = taskLines.findIndex(
							(t) => t.taskId === currentTaskIdForWindow,
						);
						const windowStart = Math.max(0, currentIdx - 2);
						const windowEnd = Math.min(taskLines.length - 1, currentIdx + 3);
						const visibleTasks = taskLines.slice(windowStart, windowEnd + 1);
						const hiddenBefore = windowStart;
						const hiddenAfter = taskLines.length - 1 - windowEnd;
						const totalTasks = taskLines.length;
						const visibleCount = visibleTasks.length;

						// Build the trimmed text:
						// Replace the task list region with the windowed version
						const firstTaskIndex = taskLines[0].index;
						const lastTask = taskLines[taskLines.length - 1];
						const lastTaskEnd = lastTask.index + lastTask.line.length;

						const before = text.slice(0, firstTaskIndex);
						const after = text.slice(lastTaskEnd);

						const visibleLines = visibleTasks.map((t) => t.line).join('\n');
						const trimComment = `[Task window: showing ${visibleCount} of ${totalTasks} tasks]`;
						const trimmedMiddle =
							(hiddenBefore > 0
								? `[...${hiddenBefore} tasks hidden...]\n`
								: '') +
							visibleLines +
							(hiddenAfter > 0 ? `\n[...${hiddenAfter} tasks hidden...]` : '');

						textPart.text = `${before}${trimmedMiddle}\n${trimComment}${after}`;
					}
				}
			}

			// Check for zero-coder-delegation violation (v6.12 Anti-Process-Violation)
			// Detect when architect writes to non-.swarm/ files without ever delegating to coder
			// This check runs for ALL architect messages (not just coder delegations)
			const sessionID = lastUserMessage.info?.sessionID;

			// Step 1: Extract task ID - prefer plan task ID (N.M format) when present,
			// otherwise fall back to full TASK line text for workflow state keys
			const planTaskId = extractPlanTaskId(text);
			const taskIdMatch = text.match(/TASK:\s*(.+?)(?:\n|$)/i);
			const taskIdFromLine = taskIdMatch ? taskIdMatch[1].trim() : null;
			// Use plan task ID if found, otherwise fall back to full TASK line text
			const currentTaskId = planTaskId ?? taskIdFromLine;

			// Step 2: Detect if this is a coder delegation BEFORE running violation check
			const coderDelegationPattern = /(?:^|\n)\s*(?:\w+_)?coder\s*\n\s*TASK:/i;
			const isCoderDelegation = coderDelegationPattern.test(text);

			// Capture the prior coder task ID BEFORE the violation check below.
			// lastCoderDelegationTaskId is written ONLY by the structured
			// dispatch path (prepareCoderScope success in toolBefore) — the old
			// prompt-regex writer here was removed (Stage A wedge fix): regex
			// extraction of `N.M` from free text could disagree with the
			// plan-validated scope binding and clobber the structured value on
			// the next transcript transform.
			const priorCoderTaskId = sessionID
				? (swarmState.agentSessions.get(sessionID)?.lastCoderDelegationTaskId ??
					null)
				: null;

			// Step 3: If this is a coder delegation with a task ID, extract FILE:
			// directive values → declaredCoderScope. The task id itself is NOT
			// tracked here anymore — see the structured writer in the coder
			// dispatch path.
			if (sessionID && isCoderDelegation && currentTaskId) {
				const session = ensureAgentSession(sessionID);

				// v6.21 Task 5.3: Extract FILE: directive values → declaredCoderScope
				const directives = extractTaskFileDirectives(
					{ prompt: text },
					'observe',
				);
				session.declaredCoderScope = directives.files;

				// Dispatch text is only an attempt. Durable workflow debt is created
				// after tool settlement proves a non-empty accepted mutation.
			}

			// Step 4: Run zero-coder-delegation warning only if:
			// - Not a coder delegation message
			// - Has a task ID (not null)
			// - Architect has written files
			// - Task ID differs from last coder delegation
			if (sessionID && !isCoderDelegation && currentTaskId) {
				const session = ensureAgentSession(sessionID);
				if (
					session.architectWriteCount > 0 &&
					session.lastCoderDelegationTaskId !== currentTaskId
				) {
					// Inject warning as model-only system guidance (not visible to user)
					const warningText = `[DELEGATION VIOLATION] Code modifications detected for task ${currentTaskId} with zero coder delegations. Rule 1: DELEGATE all coding to coder. You do NOT write code.`;

					// Add as a system message for model-only guidance
					const systemMsgIdx = messages.findIndex(
						(m: MessageWithParts) => m && m.info?.role === 'system',
					);
					const insertIdx = systemMsgIdx >= 0 ? systemMsgIdx + 1 : 0;

					const guidanceMessage: MessageWithParts = {
						info: { role: 'system' },
						parts: [{ type: 'text', text: warningText }],
					};

					messages.splice(insertIdx, 0, guidanceMessage);
				}
			}

			// Deliberation preamble: inject last-gate context + [NEXT] directive as model-only guidance
			// This runs for ALL architect messages (before coder-delegation early return)
			{
				const deliberationSessionID = lastUserMessage.info?.sessionID;
				if (deliberationSessionID) {
					// Fix 1: Validate sessionID format before calling ensureAgentSession()
					if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deliberationSessionID)) {
						// Invalid format - skip guidance injection
					} else {
						const deliberationSession = ensureAgentSession(
							deliberationSessionID,
						);
						const lastGate = deliberationSession.lastGateOutcome;
						const parallelGuidance = await buildParallelExecutionGuidance(
							directory,
							deliberationSessionID,
							deliberationSession,
						);
						const taskAwaitingCompletion =
							await findTaskAwaitingCompletion(directory);
						let guidance: string;
						if (taskAwaitingCompletion) {
							guidance =
								`[TASK COMPLETION REQUIRED] Task ${taskAwaitingCompletion} has completed reviewer/test_engineer gates and is awaiting durable plan update.\n` +
								`[NEXT] Print the task completion checklist, then call update_task_status with task_id="${taskAwaitingCompletion}" and status="completed" before declare_scope or starting another task.`;
						} else if (lastGate?.taskId) {
							const gateResult = lastGate.passed ? 'PASSED' : 'FAILED';
							// Sanitize interpolated values
							const sanitizedGate = lastGate.gate
								.replace(/</g, '&lt;')
								.replace(/>/g, '&gt;')
								.replace(/\[ \]/g, '()')
								.replace(/\[/g, '(')
								.replace(/\]/g, ')')
								.replace(/[\r\n]/g, ' ')
								.slice(0, 64);
							const sanitizedTaskId = lastGate.taskId
								.replace(/</g, '&lt;')
								.replace(/>/g, '&gt;')
								.replace(/\[/g, '(')
								.replace(/\]/g, ')')
								.replace(/[\r\n]/g, ' ')
								.slice(0, 32);
							// Concise [NEXT] directive with last-gate status
							guidance = `[Last gate: ${sanitizedGate} ${gateResult} for task ${sanitizedTaskId}]\n${
								parallelGuidance ??
								'[NEXT] Execute the next gate for the current task.'
							}`;
						} else {
							// Concise [NEXT] directive to begin first plan task
							// Also handles case where lastGate exists but taskId is missing
							guidance =
								parallelGuidance ??
								'[NEXT] Begin the first plan task and run gates sequentially.';
						}

						// Inject as model-only system guidance (not visible in message output)
						const systemMsgIdx = messages.findIndex(
							(m: MessageWithParts) => m && m.info?.role === 'system',
						);
						const insertIdx = systemMsgIdx >= 0 ? systemMsgIdx + 1 : 0;

						const guidanceMessage: MessageWithParts = {
							info: { role: 'system' },
							parts: [{ type: 'text', text: guidance }],
						};

						messages.splice(insertIdx, 0, guidanceMessage);
					}
				}
			}

			// Run heuristic checks and collect warnings
			const warnings: string[] = [];

			// Check for oversized delegation
			if (text.length > delegationMaxChars) {
				warnings.push(
					`Delegation exceeds recommended size (${text.length} chars, limit ${delegationMaxChars}). Consider splitting into smaller tasks.`,
				);
			}

			// Check for multiple FILE: directives — only applies to coder delegations
			if (isCoderDelegation) {
				const fileMatches = text.match(/^FILE:/gm);
				if (fileMatches && fileMatches.length > 1) {
					warnings.push(
						`Multiple FILE: directives detected (${fileMatches.length}). Each coder task should target ONE file.`,
					);
				}
			}

			// Check for multiple TASK: sections — only applies to coder delegations
			if (isCoderDelegation) {
				const taskMatches = text.match(/^TASK:/gm);
				if (taskMatches && taskMatches.length > 1) {
					warnings.push(
						`Multiple TASK: sections detected (${taskMatches.length}). Send ONE task per coder call.`,
					);
				}
			}

			// Check for batching language — only applies to coder delegations
			if (isCoderDelegation) {
				const batchingPattern =
					/\b(?:and also|then also|additionally|as well as|along with|while you'?re at it)[.,]?\b/gi;
				const batchingMatches = text.match(batchingPattern);
				if (batchingMatches && batchingMatches.length > 0) {
					warnings.push(
						`Batching language detected (${batchingMatches.join(', ')}). Break compound objectives into separate coder calls.`,
					);
				}
			}

			// Check for " and " connecting separate actions in the TASK line — only for coder delegations
			if (isCoderDelegation) {
				const taskLine = extractTaskLine(text);
				if (taskLine) {
					// Simple heuristic: " and " followed by a verb-like word
					// Pattern: "word(s) and verb" where verb is action-like
					const andPattern =
						/\s+and\s+(update|add|remove|modify|refactor|implement|create|delete|fix|change|build|deploy|write|test|move|rename|extend|extract|convert|migrate|upgrade|replace)\b/i;
					if (andPattern.test(taskLine)) {
						warnings.push(
							'TASK line contains "and" connecting separate actions',
						);
					}
				}
			}

			// Check for protocol violation: coder → coder without reviewer/test_engineer
			// Only relevant for coder delegations (the current message must be a coder delegation)
			if (isCoderDelegation && sessionID) {
				const delegationChain = swarmState.delegationChains.get(sessionID);
				if (delegationChain && delegationChain.length >= 2) {
					// Find the two most recent coder delegations
					const coderIndices: number[] = [];
					for (let i = delegationChain.length - 1; i >= 0; i--) {
						if (
							stripKnownSwarmPrefix(delegationChain[i].to).includes('coder')
						) {
							coderIndices.unshift(i);
							if (coderIndices.length === 2) break;
						}
					}

					// Only check if there are at least 2 coder delegations (previous + current)
					if (coderIndices.length === 2) {
						const prevCoderIndex = coderIndices[0];
						// Check between previous coder and end of chain for reviewer and test_engineer
						const betweenCoders = delegationChain.slice(prevCoderIndex + 1);
						const hasReviewer = betweenCoders.some(
							(d) => stripKnownSwarmPrefix(d.to) === 'reviewer',
						);
						const hasTestEngineer = betweenCoders.some(
							(d) => stripKnownSwarmPrefix(d.to) === 'test_engineer',
						);

						// State machine secondary signal: if the prior task is still in
						// 'coder_delegated' state, reviewer and tests never ran for it.
						const session = ensureAgentSession(sessionID);
						const priorTaskStuckAtCoder =
							priorCoderTaskId !== null &&
							getTaskState(session, priorCoderTaskId) === 'coder_delegated';

						if (!hasReviewer || !hasTestEngineer || priorTaskStuckAtCoder) {
							// Escalating enforcement: warn on first skip, hard block on second
							if (session.qaSkipCount >= 1) {
								telemetry.qaSkipViolation(
									_input.sessionID,
									session.agentName,
									session.qaSkipCount + 1,
								);
								const skippedTasks = session.qaSkipTaskIds.join(', ');
								throw new Error(
									`🛑 QA GATE ENFORCEMENT: ${session.qaSkipCount + 1} consecutive coder delegations without reviewer/test_engineer. ` +
										`Skipped tasks: [${skippedTasks}]. ` +
										`DELEGATE to reviewer and test_engineer NOW before any further coder work.`,
								);
							}
							// First skip: warn but don't block
							session.qaSkipCount++;
							session.qaSkipTaskIds.push(currentTaskId ?? 'unknown');
							warnings.push(
								`⚠️ PROTOCOL VIOLATION: Previous coder task completed, but QA gate was skipped. ` +
									`You MUST delegate to reviewer (code review) and test_engineer (test execution) ` +
									`before starting a new coder task. Review RULES 7-8 in your system prompt.`,
							);
						}
					}
				}
			}

			// If no warnings, return
			if (warnings.length === 0) return;

			// Build warning text in v6.12 format
			const warningLines = warnings.map((w) => `Detected signal: ${w}`);
			const warningText = `⚠️ BATCH DETECTED: Your coder delegation appears to contain multiple tasks.
Rule 3: ONE task per coder call. Split this into separate delegations.
${warningLines.join('\n')}`;

			// Inject warning as model-only system guidance (not visible to user)
			const batchWarnSystemIdx = messages.findIndex(
				(m: MessageWithParts) => m && m.info?.role === 'system',
			);
			const batchWarnInsertIdx =
				batchWarnSystemIdx >= 0 ? batchWarnSystemIdx + 1 : 0;
			const batchWarnMessage: MessageWithParts = {
				info: { role: 'system' },
				parts: [{ type: 'text', text: warningText }],
			};
			messages.splice(batchWarnInsertIdx, 0, batchWarnMessage);
		},
		toolAfter,
		taskMetadata,
		sessionEnded,
		backgroundCompletionClaimed,
		/**
		 * Issue #2214: roll back a settlement this call durably began when a
		 * LATER fail-closed hook denies the Task call (the delegation gate runs
		 * at step 4; full-auto/knowledge/skill gates at steps 5-8 can still
		 * throw). A denied call never fires toolAfter, so without this rollback
		 * the DISPATCHED WAL and its in-memory ownership key wedge the task
		 * until a process restart. Never throws — the denial itself propagates.
		 *
		 * F-002 (PR #2223 review): cleanup runs in a FINALLY so every failure
		 * class (settlement-lock contention, WAL_MISSING/REPLACED/UNREADABLE,
		 * write errors) still releases the in-memory ownership key and the
		 * callID bookkeeping — an abort that throws must not leave a louder
		 * in-process CODER_DISPATCH_IN_PROGRESS wedge behind.
		 */
		abortDeniedSettlementForCall: async (callID: string): Promise<void> => {
			const begun = begunCoderSettlementsByCallID.get(callID);
			if (!begun?.taskId) return;
			try {
				await abortCoderSettlement({
					directory,
					taskId: begun.taskId,
					transitionId: begun.transitionId,
					reason:
						'dispatch denied by a fail-closed gate after settlement began',
				});
			} catch (error) {
				logger.criticalWarn(
					`[delegation-gate] denied-dispatch settlement rollback failed for call ${callID} (task ${begun.taskId}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			} finally {
				// Unconditional (idempotent) cleanup, mirroring
				// backgroundCompletionClaimed: a denied call never reaches the
				// toolAfter cleanup path, so this is the only drain for these
				// entries.
				releaseCoderDispatchOwnership(
					directory,
					begun.taskId,
					begun.transitionId,
				);
				begunCoderSettlementsByCallID.delete(callID);
				clearCoderTaskChangeContext(callID);
				clearPublishedScopeBindings(callID);
				stageBDispatchGenerationsByCallID.delete(callID);
				gateDispatchPrimaryTaskByCallID.delete(callID);
				deleteStoredInputArgs(callID);
			}
		},
	};
}
