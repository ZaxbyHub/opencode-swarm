/**
 * Delegation Gate Hook
 *
 * Warns the architect when coder delegations are too large or batched.
 * Uses experimental.chat.messages.transform to provide non-blocking guidance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZodError, z } from 'zod';
import type { BackgroundTaskChangeContext } from '../background/pending-delegations.js';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
} from '../background/workspace-snapshot.js';
import type { PluginConfig } from '../config';
import type { Phase, Plan, Task } from '../config/plan-schema';
import { isKnownCanonicalRole, stripKnownSwarmPrefix } from '../config/schema';
import {
	isMarkdownOnlyDeclaredScope,
	isMarkdownOnlyTaskChange,
} from '../gate-evidence-classification.js';
import {
	routeReviewForChanges,
	shouldParallelizeReview,
} from '../parallel/review-router.js';
import {
	computePlanStructureHash,
	loadLastPlanCriticApprovedSnapshot,
	takeSnapshotEvent,
} from '../plan/ledger';
import { loadPlanJsonOnly } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import type { AgentSessionState } from '../state';
import {
	advanceTaskState,
	advanceTaskStateAndPersist,
	ensureAgentSession,
	getTaskState,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	isCouncilGateActive,
	recordStageBCompletion,
	swarmState,
} from '../state';
import { telemetry } from '../telemetry.js';
import type {
	DelegationEnvelope,
	EnvelopeValidationResult,
} from '../types/delegation.js';
import * as logger from '../utils/logger';
import { isStrictTaskId } from '../validation/task-id';
import {
	awaitingMergeByCallID,
	checkStandardWorktreeSerializationRelease,
	finishStandardWorktreeDispatch,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
	resolveWorktreeIsolationConfig,
	sanitizeWorktreeTaskId,
	standardWorktreeByCallID,
	standardWorktreeSerializationSessions,
} from './delegation-gate/worktree-isolation';
export { resetStandardWorktreeIsolationState };

import { COUNCIL_VERDICT_REWARDS } from '../memory/config';
import { createConfiguredMemoryProvider } from '../memory/gateway';
import {
	applyCouncilReward,
	truncateObjectForJson,
} from '../memory/reward-capture';
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
export const pendingCoderScopeByTaskId = new Map<string, string[]>();

/**
 * v6.70.0 gap-closure: clears the pending coder-scope map. Exported as a
 * helper (rather than importing the map directly from state.ts) to avoid the
 * circular import `state.ts ↔ delegation-gate.ts`. Called by `resetSwarmState`.
 */
export function clearPendingCoderScope(): void {
	pendingCoderScopeByTaskId.clear();
}

/**
 * Issue #1151: OpenCode v1.16.2 background subagents.
 *
 * `Task` with `background=true` (gated upstream by
 * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`) returns a "running" placeholder
 * immediately and completes later via synthetic parent injection. The delegation gate
 * treats a `Task` result as completion, so a background swarm delegation would advance
 * Stage B / record gate evidence before any review/test output exists. Until swarm can
 * correlate the deferred completion safely (a separate, spike-gated PR), background
 * swarm delegations are fail-closed-blocked. We do NOT silently coerce `background` to
 * false — the unsupported capability is surfaced explicitly.
 */
export const SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE =
	'SWARM_BACKGROUND_TASK_BLOCKED: OpenCode background subagents (Task with background=true, ' +
	'requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true) are recognized upstream, but swarm ' +
	'cannot yet safely consume their deferred completion events — the Task returns a running ' +
	'placeholder now and completes later via synthetic injection, which would advance swarm gates ' +
	'before any review/test output exists. Omit `background` (or set background=false) for swarm ' +
	'delegations until the completion-ingestion PR lands.';

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

	return { valid: true };
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
	const match = /^\s*VERDICT:\s*(APPROVED|NEEDS_REVISION|REJECTED)\b/im.exec(
		outputText(output),
	);
	if (!match) return null;
	return match[1].toUpperCase() as 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
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
] as const;

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
				'Delegate to critic in MODE: CRITIC-GATE and require VERDICT: APPROVED before EXECUTE.',
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
				'Re-run MODE: CRITIC-GATE and wait for explicit approval before coder execution.',
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
				'Re-run MODE: CRITIC-GATE after plan changes before delegating to coder.',
		);
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

	const plan = await loadPlanJsonOnly(directory);
	if (!plan) return;

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
 * Returns the task ID to use when seeding cross-session state, derived from
 * the originating session's currentTaskId or lastCoderDelegationTaskId.
 */
function getSeedTaskId(session: AgentSessionState): string | null {
	return session.currentTaskId ?? session.lastCoderDelegationTaskId;
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

function getPlanTaskStatus(plan: Plan, taskId: string): string | null {
	for (const phase of plan.phases) {
		const task = phase.tasks.find((candidate) => candidate.id === taskId);
		if (task) return task.status ?? 'pending';
	}
	return null;
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

function resolveDelegatedPlanTaskId(
	args: Record<string, unknown>,
	knownPlanTaskIds?: ReadonlySet<string>,
): string | null {
	// Prefer explicit task_id/taskId fields — never fall through to text extraction
	// when the caller provides a direct task identifier.
	const rawTaskId = args.task_id ?? args.taskId;
	if (typeof rawTaskId === 'string') {
		const trimmed = rawTaskId.trim();
		if (trimmed.length <= 20 && isStrictTaskId(trimmed)) return trimmed;
		// Explicit field was present but invalid — fail closed, don't fish in text fields
		return null;
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
 * @returns Map of taskId -> verdict string
 */
export function parsePerTaskVerdicts(outputText: string): Map<string, string> {
	const result = new Map<string, string>();
	// Match [REVIEWED] or [TESTED] tag lines with task ID and verdict
	// Supports formats like "[REVIEWED] | task-2.1 | APPROVED | details"
	// and "[TESTED] | 2.1 | PASS | details"
	const reviewedPattern =
		/^\[REVIEWED\]\s*\|\s*(?:task-)?(\d+\.\d+(?:\.\d+)*)\s*\|\s*(APPROVED|REJECTED|CONCERNS)\s*\|/im;
	const testedPattern =
		/^\[TESTED\]\s*\|\s*(?:task-)?(\d+\.\d+(?:\.\d+)*)\s*\|\s*(PASS|FAIL|SKIPPED)\s*\|/im;

	for (const line of outputText.split('\n')) {
		const trimmed = line.trim();
		let match = reviewedPattern.exec(trimmed);
		if (match) {
			const taskId = match[1];
			const verdict = match[2];
			if (isStrictTaskId(taskId)) {
				result.set(taskId, verdict);
			}
			continue;
		}
		match = testedPattern.exec(trimmed);
		if (match) {
			const taskId = match[1];
			const verdict = match[2];
			if (isStrictTaskId(taskId)) {
				result.set(taskId, verdict);
			}
		}
	}
	return result;
}

/**
 * Plural variant of resolveDelegatedPlanTaskId that returns ALL discovered task IDs
 * rather than failing closed on ambiguity. Used when a single agent covers multiple tasks
 * (set-dispatch) and we need per-task attribution.
 */
async function findTaskAwaitingCompletion(
	directory: string | undefined,
	session: AgentSessionState,
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

	for (const [taskId, state] of session.taskWorkflowStates) {
		if (state !== 'tests_run') continue;
		if (requestedTaskId && requestedTaskId === taskId) continue;

		const planStatus = getPlanTaskStatus(plan, taskId);
		if (!planStatus) continue;
		if (planStatus === 'completed' || planStatus === 'closed') continue;

		return taskId;
	}

	return null;
}

function completionGateViolationMessage(
	taskAwaitingCompletion: string,
): string {
	return (
		`TASK_COMPLETION_GATE_VIOLATION: Task ${taskAwaitingCompletion} reached tests_run but is not marked completed in plan.json/plan.md. ` +
		`Call update_task_status with task_id="${taskAwaitingCompletion}" and status="completed" before starting another task.`
	);
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

/**
 * _internals export for testing — do not use in production code.
 * Exposes resolveEvidenceTaskId, resolveDelegatedPlanTaskId, and
 * buildParallelExecutionGuidance for unit testing.
 *
 * Worktree operation entries (provisionWorktree, removeWorktree, etc.) proxy
 * to delegation-gate/worktree-isolation._internals via getters/setters so
 * that test mutations on this object propagate to the extracted module.
 */
export const _internals = {
	resolveEvidenceTaskId,
	resolveDelegatedPlanTaskId,
	parsePerTaskVerdicts,
	buildParallelExecutionGuidance,
	loadPlanJsonOnly,
	resetStandardWorktreeIsolationState,
	PLAN_CRITIC_TASK_SIGNALS,
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
} {
	// Initialize durable worktree merge-back status before any coders dispatch
	initDurableStatusPath(directory);

	const enabled =
		(config.hooks as Record<string, unknown> | undefined)?.delegation_gate !==
		false;
	const delegationMaxChars =
		((config.hooks as Record<string, unknown> | undefined)
			?.delegation_max_chars as number | undefined) ?? 4000;

	// Issue #1151 PR 2 (Stage A): opt-in background-subagent support. When false (default)
	// background swarm Task dispatches are fail-closed-blocked (PR 1). When true, they are
	// allowed and tracked as durable pending records (no gate advancement in Stage A).
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
	const coderObservedFilesByCallID = new Map<string, string[] | null>();
	const clearCoderTaskChangeContext = (callID: string): void => {
		coderTaskChangeContextByCallID.delete(callID);
		coderObservedFilesByCallID.delete(callID);
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
	): void => {
		if (!isMarkdownOnlyDeclaredScope(declaredFiles)) {
			clearCoderTaskChangeContext(callID);
			return;
		}
		if (
			!coderTaskChangeContextByCallID.has(callID) &&
			coderTaskChangeContextByCallID.size >= MAX_PENDING_CODER_CHANGE_CONTEXTS
		) {
			const oldest = coderTaskChangeContextByCallID.keys().next().value;
			if (oldest !== undefined) clearCoderTaskChangeContext(oldest);
		}
		coderTaskChangeContextByCallID.set(callID, {
			declaredFiles,
			baseline: captureWorkspaceSnapshot(observationDirectory),
		});
	};

	if (!enabled) {
		return {
			messagesTransform: async (
				_input: Record<string, never>,
				_output: { messages?: MessageWithParts[] },
			): Promise<void> => {
				// No-op when delegation gate is disabled
			},
			toolBefore: async (): Promise<void> => {
				// No-op when delegation gate is disabled
			},
			toolAfter: async (): Promise<void> => {
				// No-op when delegation gate is disabled
			},
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
			const completionSession = ensureAgentSession(input.sessionID);
			const taskAwaitingCompletion = await findTaskAwaitingCompletion(
				directory,
				completionSession,
				requestedTaskId,
			);
			if (taskAwaitingCompletion) {
				const allowingSameTaskRetry =
					requestedTaskId === taskAwaitingCompletion;
				// Allow completion of ANY task that is itself awaiting completion,
				// not just the one returned by findTaskAwaitingCompletion.
				// This prevents deadlock when multiple tasks are in tests_run simultaneously.
				const requestedTaskIsAwaitingCompletion =
					requestedTaskId &&
					completionSession.taskWorkflowStates.get(requestedTaskId) ===
						'tests_run';
				const allowCompletionUpdate =
					normalized === 'update_task_status' &&
					completionArgs.status === 'completed' &&
					requestedTaskIsAwaitingCompletion;
				if (!allowingSameTaskRetry && !allowCompletionUpdate) {
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
		// PR 2 Stage A: when background_subagents is opted in, the block is lifted — the
		// dispatch is allowed and tracked as a durable pending record in toolAfter (still
		// no gate advancement in Stage A). When disabled (default), PR 1 behavior stands.
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
					// Use modified files from the current coder task as changed files
					const changedFiles = reviewSession.modifiedFilesThisCoderTask ?? [];
					if (changedFiles.length > 0) {
						const routing = await routeReviewForChanges(
							directory,
							changedFiles,
						);
						if (shouldParallelizeReview(routing)) {
							reviewSession.pendingAdvisoryMessages ??= [];
							reviewSession.pendingAdvisoryMessages.push(
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

		if (targetAgent !== 'coder') return;

		// Only check for the architect session (the orchestrator)
		const session = ensureAgentSession(input.sessionID);
		if (!session || !session.taskWorkflowStates) return;

		// Load the plan once up front. Both the reviewer-gate parallel exemption
		// below and the standard worktree precreate path need execution_profile;
		// loading here avoids a second read.
		const plan = await _internals.loadPlanJsonOnly(directory);
		const profile = plan?.execution_profile;
		const parallelEnabled = profile?.parallelization_enabled === true;
		const maxConcurrent = profile?.max_concurrent_tasks ?? 10;
		const effectiveMaxConcurrent =
			session.maxConcurrencyOverride ?? maxConcurrent;
		// Parallel mode is active only when the plan enables it, allows >1 concurrent
		// task, and Lean Turbo is not driving its own lane execution.
		const parallelModeActive =
			parallelEnabled &&
			effectiveMaxConcurrent > 1 &&
			!hasActiveLeanTurbo(input.sessionID);
		const planTaskIds = plan
			? new Set(plan.phases.flatMap((phase) => phase.tasks.map((t) => t.id)))
			: new Set<string>();
		const incomingCoderTaskId = resolveDelegatedPlanTaskId(args, planTaskIds);

		await assertPlanCriticApprovedForExecution(directory, plan);
		const incomingCoderDeclaredFiles = getPlanTaskDeclaredFiles(
			plan,
			incomingCoderTaskId,
		);

		// Reviewer gate: block coder re-delegation when a prior coder task awaits
		// review. In parallel mode (parallelization_enabled), dispatching a coder
		// for a DIFFERENT dependency-ready task is legitimate, so a coder_delegated
		// task only blocks a coder for the SAME task (a true re-delegation that would
		// skip review). The slot cap below bounds total in-flight unreviewed coders.
		for (const [taskId, state] of session.taskWorkflowStates) {
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
			if (!hasCurrentSessionCoderDelegation) {
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
				`REVIEWER_GATE_VIOLATION: Cannot re-delegate to coder without reviewer delegation. ` +
					`Task ${taskId} state: coder_delegated. Delegate to reviewer first. ` +
					`If this is stale state from a prior session, run /swarm reset-session to clear workflow state.`,
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

		if (!plan) {
			clearCoderTaskChangeContext(input.callID);
			return;
		}
		if (!parallelModeActive) {
			rememberCoderTaskChangeContext(input.callID, incomingCoderDeclaredFiles);
			return;
		}

		const resolvedTaskId = incomingCoderTaskId;
		// FR-102: pass declared scope (from pending map populated by FILE: extraction
		// or prior declare_scope) so provisionWorktree can materialize it into the
		// lane's .swarm/scopes/ for durability across plugin restart.
		const laneScope = resolvedTaskId
			? (pendingCoderScopeByTaskId.get(resolvedTaskId) ?? null)
			: null;
		await precreateStandardWorktreeSession({
			config,
			directory,
			parentSessionID: input.sessionID,
			callID: input.callID,
			taskId: resolvedTaskId ?? sanitizeWorktreeTaskId(input.callID),
			planTaskId: resolvedTaskId ?? undefined,
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
			rememberCoderTaskChangeContext(
				input.callID,
				incomingCoderDeclaredFiles,
				standardDispatch.handle.worktreePath,
			);
		} else {
			// Isolation may degrade to the project root; capture only after the
			// provisioning attempt and before the upstream coder begins execution.
			rememberCoderTaskChangeContext(input.callID, incomingCoderDeclaredFiles);
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
		if (!input.sessionID) return;
		const session = swarmState.agentSessions.get(input.sessionID);
		if (!session) return;

		// Detect task tool calls
		const normalized = normalizeToolName(input.tool);

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

		// ── Completion gate: advance state when architect marks task completed ──
		if (normalized === 'update_task_status') {
			const directArgs = input.args as Record<string, unknown> | undefined;
			const storedArgs = getStoredInputArgs(input.callID) as
				| Record<string, unknown>
				| undefined;
			const completionArgs = directArgs ?? storedArgs;
			if (completionArgs && completionArgs.status === 'completed') {
				const rawTaskId = completionArgs.task_id ?? completionArgs.taskId;
				const completionTaskId =
					typeof rawTaskId === 'string' ? rawTaskId.trim() : null;
				if (completionTaskId && isStrictTaskId(completionTaskId)) {
					try {
						const completionSession = ensureAgentSession(input.sessionID);
						await advanceTaskStateAndPersist(
							completionSession,
							completionTaskId,
							'complete',
							directory,
							{ telemetrySessionId: input.sessionID },
							config.council,
						);
					} catch (err) {
						logger.warn(
							`[delegation-gate] toolAfter completion advancement: could not advance ${completionTaskId} → complete: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		}

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
							try {
								// Pass council config so the fast-path quorum check
								// inside advanceTaskState uses the configured
								// minimumMembers (default 3) rather than rejecting
								// every entry it sees.
								await advanceTaskStateAndPersist(
									session,
									taskId,
									'complete',
									directory,
									{ telemetrySessionId: input.sessionID },
									config.council,
								);
								// A.4 — positive terminal reward capture. Fires ONLY after
								// the APPROVE→complete advance above SUCCEEDS. Wrapped in its
								// OWN try/catch: this is a HOT hook path and reward capture
								// must NEVER throw into the gate or change task completion.
								// Behavior is identical whether it succeeds, fails, or skips.
								try {
									const memoryConfig = config.memory;
									// Post-condition (C-6): reward ONLY when the advance above
									// actually moved the task to 'complete'. advanceTaskState
									// silently no-ops (returns without throwing AND without
									// advancing) on an invalid taskId — e.g. a whitespace-only id
									// that passed the truthiness `if (taskId)` gate above but
									// fails isValidTaskId — so a non-throwing await does not by
									// itself prove completion. getTaskState also returns a
									// non-'complete' state (or 'idle' for an invalid id) in every
									// non-advance case, so this check closes the false-positive
									// reward path without depending on advanceTaskState internals.
									const advancedToComplete =
										getTaskState(session, taskId) === 'complete';
									if (advancedToComplete && memoryConfig?.enabled === true) {
										const approvedEntry =
											session.taskCouncilApproved?.get(taskId);
										// Dedup: apply at most once per task.
										if (approvedEntry?.rewarded !== true) {
											const provider = createConfiguredMemoryProvider(
												directory,
												memoryConfig,
											);
											try {
												// FR-010: compact synthesis payload, truncated to the
												// configured byte cap with a marker beyond it.
												const synthesis = {
													overallVerdict: result.overallVerdict,
													allCriteriaMet: result.allCriteriaMet === true,
													requiredFixesCount: result.requiredFixesCount ?? 0,
													roundNumber:
														typeof result.roundNumber === 'number'
															? result.roundNumber
															: undefined,
													quorumSize:
														typeof result.quorumSize === 'number'
															? result.quorumSize
															: undefined,
												};
												let verdictSynthesisJson = JSON.stringify(synthesis);
												const cap =
													memoryConfig.qLearning.verdictPayloadCapBytes;
												if (
													typeof cap === 'number' &&
													cap > 0 &&
													verdictSynthesisJson.length > cap
												) {
													verdictSynthesisJson = JSON.stringify(
														truncateObjectForJson(synthesis, cap),
													);
												}
												await applyCouncilReward(provider, {
													runId: input.sessionID,
													unitId: taskId,
													reward: COUNCIL_VERDICT_REWARDS.APPROVE,
													eta: memoryConfig.qLearning.learningRate,
													initialQValue: memoryConfig.qLearning.initialQValue,
													// B.5: thread the full q-learning config so soft
													// Q-propagation reads propagationFraction /
													// propagationFanoutCap / propagationWindowDays.
													qLearning: memoryConfig.qLearning,
													verdictSynthesisJson,
													timestamp: new Date().toISOString(),
												});
												if (approvedEntry) approvedEntry.rewarded = true;
											} finally {
												// Release the pool refcount acquired above (no leak).
												await provider.close?.();
											}
										}
									}
								} catch (rewardErr) {
									logger.warn(
										`[delegation-gate] council reward capture failed: ${rewardErr instanceof Error ? rewardErr.message : String(rewardErr)}`,
									);
								}
							} catch (err) {
								logger.warn(
									`[delegation-gate] toolAfter submit_council_verdicts: could not advance ${taskId} → complete: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
					}
				}
			} catch (err) {
				console.warn(
					`[delegation-gate] toolAfter submit_council_verdicts: failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			// Return early — gate-evidence recording (inside the Task branch below)
			// does not apply to submit_council_verdicts: it is a synthesis tool, not a gate
			// delegation, and 'submit_council_verdicts' is not in the gateAgents list.
			return;
		}

		if (normalized === 'Task' || normalized === 'task') {
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

			// Issue #1151: background swarm Task handling.
			// A background swarm Task returns a "running" placeholder; it must NEVER advance
			// Stage B or record completed gate evidence here. Detect background from args
			// (direct or stored) or from the result shape, scoped to swarm roles.
			//   - PR 1 (flag OFF): defensive belt-and-suspenders — bail before any advancement.
			//   - PR 2 Stage A (flag ON): additionally record a DURABLE pending delegation so a
			//     later (Stage B) trusted completion can be correlated. Still no gate effect.
			// Either way: clean up stored args so the callID entry does not leak, then bail.
			if (
				typeof subagentType === 'string' &&
				isKnownCanonicalRole(stripKnownSwarmPrefix(subagentType)) &&
				(isBackgroundTrue(directArgs?.background) ||
					isBackgroundTrue(storedArgs?.background) ||
					outputLooksLikeBackgroundRunning(_output))
			) {
				if (backgroundSubagentsEnabled) {
					try {
						const { extractDispatchIds } = await import(
							'../background/task-envelope.js'
						);
						const { buildPromptSnapshot, recordPendingDelegation } =
							await import('../background/pending-delegations.js');
						const { captureWorkspaceSnapshot } = await import(
							'../background/workspace-snapshot.js'
						);
						const { subagentSessionId, jobId } = extractDispatchIds(_output);
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
							await recordPendingDelegation(
								directory,
								{
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
									prompt:
										typeof mergedArgs.prompt === 'string'
											? buildPromptSnapshot(
													mergedArgs.prompt,
													delegationMaxChars,
												)
											: undefined,
									generation: 1,
								},
								{ staleTimeoutMs: backgroundPendingTimeoutMs },
							);
						} else {
							// No usable correlation id (no jobId and no parseable dispatch
							// envelope). Do NOT write an unkeyable/orphan record; the dispatch
							// already launched upstream, but Stage A has no gate effect so an
							// untracked background dispatch is safe (it is simply unobservable).
							logger.warn(
								'[delegation-gate] background dispatch had no correlation id (no jobId / no envelope) — not tracked',
							);
						}
					} catch (err) {
						logger.warn(
							`[delegation-gate] background pending recording failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				clearCoderTaskChangeContext(input.callID);
				if (storedArgs !== undefined) deleteStoredInputArgs(input.callID);
				return;
			}

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

			if (standardDispatch) {
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
				await finishStandardWorktreeDispatch(
					directory,
					standardDispatch,
					config,
					input.callID,
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
					dispatchSession.pendingAdvisoryMessages ??= [];
					dispatchSession.pendingAdvisoryMessages.push(
						`STANDARD_WORKTREE_MERGE_FAILED: task ${standardDispatch.taskId} preserved at ${standardDispatch.handle.worktreePath}; reason: ${reason}.`,
					);
					// SC-115: Remove from awaiting-merge registry after recording failure.
					awaitingMergeByCallID.delete(input.callID);
				});
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
						if (
							(targetAgent === 'reviewer' || targetAgent === 'test_engineer') &&
							session.taskWorkflowStates
						) {
							const stageBEligibleStates = [
								'coder_delegated',
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
							const perTaskVerdicts = parsePerTaskVerdicts(outputText(_output));
							const hasPerTaskAttribution = perTaskVerdicts.size > 0;

							// FR-007: When per-task verdicts are parseable, iterate ONLY over the
							// task IDs mentioned in those verdicts — skip all other eligible tasks
							// to prevent over-attribution. When no verdicts are parseable, iterate
							// over all eligible tasks (existing fallback behavior).

							const { readTaskEvidence } = await import('../gate-evidence');
							for (const [taskId, state] of session.taskWorkflowStates) {
								if (
									!(stageBEligibleStates as readonly string[]).includes(state)
								)
									continue;
								// FR-007: Skip tasks NOT mentioned in per-task verdicts
								if (hasPerTaskAttribution && !perTaskVerdicts.has(taskId))
									continue;
								const eligibleState = state as EligibleState;
								recordStageBCompletion(
									session,
									taskId,
									targetAgent as 'reviewer' | 'test_engineer',
								);

								// FR-007: Record per-task gate evidence when parseable verdicts exist.
								// Each task gets its own evidence entry keyed by the specific task ID.
								if (hasPerTaskAttribution) {
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
										);
									} catch (err) {
										logger.warn(
											`[delegation-gate] per-task evidence recording failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
										);
									}
								}

								const taskEvidence = await readTaskEvidence(directory, taskId);
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
										if (
											eligibleState === 'coder_delegated' ||
											eligibleState === 'pre_check_passed'
										) {
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
											(eligibleState === 'coder_delegated' ||
												eligibleState === 'pre_check_passed')
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

							// Cross-session propagation for Stage B parallel path.
							// Scoped to seedTaskId only — recording completion for every task
							// in every other session would contaminate unrelated tasks.
							const seedTaskId = getSeedTaskId(session);
							if (seedTaskId) {
								const seedEvidence = await readTaskEvidence(
									directory,
									seedTaskId,
								);
								const reviewerCompletesSeedStageB =
									targetAgent === 'reviewer' &&
									seedEvidence?.test_engineer_exempt === true;
								for (const [, otherSession] of swarmState.agentSessions) {
									if (otherSession === session) continue;
									if (!otherSession.taskWorkflowStates) continue;

									if (!otherSession.taskWorkflowStates.has(seedTaskId)) {
										otherSession.taskWorkflowStates.set(
											seedTaskId,
											'coder_delegated',
										);
									}

									const seedState =
										otherSession.taskWorkflowStates.get(seedTaskId);
									if (
										!seedState ||
										!(stageBEligibleStates as readonly string[]).includes(
											seedState,
										)
									) {
										continue;
									}
									const seedEligibleState = seedState as EligibleState;
									recordStageBCompletion(
										otherSession,
										seedTaskId,
										targetAgent as 'reviewer' | 'test_engineer',
									);
									if (
										hasBothStageBCompletions(otherSession, seedTaskId) ||
										reviewerCompletesSeedStageB
									) {
										try {
											if (
												seedEligibleState === 'coder_delegated' ||
												seedEligibleState === 'pre_check_passed'
											) {
												advanceTaskState(
													otherSession,
													seedTaskId,
													'reviewer_run',
													{ emitTelemetry: false },
												);
											}
											advanceTaskState(otherSession, seedTaskId, 'tests_run', {
												emitTelemetry: false,
											});
										} catch (err) {
											logger.warn(
												`[delegation-gate] toolAfter cross-session stage-b-parallel: could not advance ${seedTaskId} (${seedEligibleState}) → tests_run: ${err instanceof Error ? err.message : String(err)}`,
											);
										}
									} else {
										// Intermediate cross-session advancement (mirrors same-session logic)
										try {
											if (
												targetAgent === 'reviewer' &&
												(seedEligibleState === 'coder_delegated' ||
													seedEligibleState === 'pre_check_passed')
											) {
												advanceTaskState(
													otherSession,
													seedTaskId,
													'reviewer_run',
													{ emitTelemetry: false },
												);
											} else if (
												targetAgent === 'test_engineer' &&
												seedEligibleState === 'reviewer_run'
											) {
												advanceTaskState(
													otherSession,
													seedTaskId,
													'tests_run',
													{
														emitTelemetry: false,
													},
												);
											}
										} catch (err) {
											logger.warn(
												`[delegation-gate] toolAfter cross-session stage-b-parallel intermediate: could not advance ${seedTaskId} (${seedEligibleState}) after ${targetAgent}: ${err instanceof Error ? err.message : String(err)}`,
											);
										}
									}
								}
							}
						}
					}
				} // end if (!councilActive) — primary Stage B path
			}

			// Record gate evidence for stored-args path
			// v6.33.7: Entire block wrapped in try-catch — getEvidenceTaskId can
			// re-throw unexpected errors (EPERM, EBUSY on Windows) which previously
			// escaped outside the evidence try-catch and propagated to safeHook.
			if (typeof subagentType === 'string') {
				try {
					const mergedArgs = { ...(storedArgs ?? {}), ...directArgs };
					const evidenceTaskId = await resolveEvidenceTaskId(
						mergedArgs,
						session,
						directory,
					);
					if (evidenceTaskId) {
						const turbo = hasActiveTurboMode(input.sessionID);
						const gateAgents = [
							'reviewer',
							'test_engineer',
							'docs',
							'designer',
							'critic',
							'explorer',
							'sme',
						];
						const targetAgentForEvidence = stripKnownSwarmPrefix(subagentType);
						if (gateAgents.includes(targetAgentForEvidence)) {
							const { recordGateEvidence } = await import('../gate-evidence');
							await recordGateEvidence(
								directory,
								evidenceTaskId,
								targetAgentForEvidence,
								input.sessionID,
								turbo,
							);
						} else {
							const { recordAgentDispatch } = await import('../gate-evidence');
							const taskChangeContext =
								targetAgentForEvidence === 'coder'
									? coderTaskChangeContextByCallID.get(input.callID)
									: undefined;
							const observedFiles = taskChangeContext
								? (coderObservedFilesByCallID.get(input.callID) ??
									changedFilesSinceSnapshot(
										taskChangeContext.baseline.directory,
										taskChangeContext.baseline,
									))
								: null;
							await recordAgentDispatch(
								directory,
								evidenceTaskId,
								targetAgentForEvidence,
								turbo,
								{
									testEngineerExempt:
										targetAgentForEvidence === 'coder' &&
										isMarkdownOnlyTaskChange(
											taskChangeContext?.declaredFiles,
											observedFiles,
										),
								},
							);
						}
					}
				} catch (err) {
					/* non-fatal — evidence is additive, never blocks delegation */
					console.warn(
						`[delegation-gate] evidence recording failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				} finally {
					if (stripKnownSwarmPrefix(subagentType) === 'coder') {
						clearCoderTaskChangeContext(input.callID);
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

					// When council_mode is enabled, per-task Stage B (reviewer + test_engineer
					// barrier) is replaced by the council verdict path (submit_council_verdicts).
					// Stage B delegations may still occur as part of the 5-member council dispatch,
					// but they do not advance state through the Stage B barrier.
					if (!councilActive) {
						// Fallback Pass 1: advance states via delegationChains
						if (
							lastCoderIndex !== -1 &&
							hasReviewer &&
							session.taskWorkflowStates
						) {
							for (const [taskId, state] of session.taskWorkflowStates) {
								if (
									state === 'coder_delegated' ||
									state === 'pre_check_passed'
								) {
									try {
										advanceTaskState(session, taskId, 'reviewer_run');
									} catch (err) {
										logger.warn(
											`[delegation-gate] fallback: could not advance ${taskId} (${state}) → reviewer_run: ${err instanceof Error ? err.message : String(err)}`,
										);
									}
								}
							}
						}

						// Fallback Pass 2: advance states via delegationChains
						if (
							lastCoderIndex !== -1 &&
							hasReviewer &&
							hasTestEngineer &&
							session.taskWorkflowStates
						) {
							for (const [taskId, state] of session.taskWorkflowStates) {
								if (state === 'reviewer_run') {
									try {
										advanceTaskState(session, taskId, 'tests_run');
									} catch (err) {
										logger.warn(
											`[delegation-gate] fallback: could not advance ${taskId} (${state}) → tests_run: ${err instanceof Error ? err.message : String(err)}`,
										);
									}
								}
							}
						}

						// Fallback: Also advance states in OTHER sessions via delegationChains
						if (lastCoderIndex !== -1 && hasReviewer) {
							for (const [, otherSession] of swarmState.agentSessions) {
								if (otherSession === session) continue;
								if (!otherSession.taskWorkflowStates) continue;

								// Seed task state in sessions that don't have an entry yet
								const seedTaskId = getSeedTaskId(session);
								if (
									seedTaskId &&
									!otherSession.taskWorkflowStates.has(seedTaskId)
								) {
									otherSession.taskWorkflowStates.set(
										seedTaskId,
										'coder_delegated',
									);
								}
								for (const [taskId, state] of otherSession.taskWorkflowStates) {
									if (
										state === 'coder_delegated' ||
										state === 'pre_check_passed'
									) {
										try {
											advanceTaskState(otherSession, taskId, 'reviewer_run', {
												emitTelemetry: false,
											});
										} catch (err) {
											logger.warn(
												`[delegation-gate] fallback cross-session: could not advance ${taskId} (${state}) → reviewer_run: ${err instanceof Error ? err.message : String(err)}`,
											);
										}
									}
								}
							}
						}

						if (lastCoderIndex !== -1 && hasReviewer && hasTestEngineer) {
							for (const [, otherSession] of swarmState.agentSessions) {
								if (otherSession === session) continue;
								if (!otherSession.taskWorkflowStates) continue;

								// Seed task state in sessions that don't have an entry yet
								const seedTaskId = getSeedTaskId(session);
								if (
									seedTaskId &&
									!otherSession.taskWorkflowStates.has(seedTaskId)
								) {
									otherSession.taskWorkflowStates.set(
										seedTaskId,
										'reviewer_run',
									);
								}
								for (const [taskId, state] of otherSession.taskWorkflowStates) {
									if (state === 'reviewer_run') {
										try {
											advanceTaskState(otherSession, taskId, 'tests_run', {
												emitTelemetry: false,
											});
										} catch (err) {
											logger.warn(
												`[delegation-gate] fallback cross-session: could not advance ${taskId} (${state}) → tests_run: ${err instanceof Error ? err.message : String(err)}`,
											);
										}
									}
								}
							}
						}
					} // end if (!councilActive) — fallback Stage B path
				}

				// Record gate evidence for delegation-chain fallback path
				// v6.33.7: Entire block wrapped in try-catch (same fix as stored-args path)
				try {
					const evidenceTaskId = await resolveEvidenceTaskId(
						directArgs,
						session,
						directory,
					);
					if (evidenceTaskId) {
						const turbo = hasActiveTurboMode(input.sessionID);
						if (hasReviewer) {
							const { recordGateEvidence } = await import('../gate-evidence');
							await recordGateEvidence(
								directory,
								evidenceTaskId,
								'reviewer',
								input.sessionID,
								turbo,
							);
						}
						if (hasTestEngineer) {
							const { recordGateEvidence } = await import('../gate-evidence');
							await recordGateEvidence(
								directory,
								evidenceTaskId,
								'test_engineer',
								input.sessionID,
								turbo,
							);
						}
					}
				} catch (err) {
					/* non-fatal — evidence is additive, never blocks delegation */
					console.warn(
						`[delegation-gate] fallback evidence recording failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// ── Completion gate: push advisory if a task awaits completion ──
			if (session.taskWorkflowStates) {
				for (const [, state] of session.taskWorkflowStates) {
					if (state === 'tests_run') {
						const taskAwaiting = await findTaskAwaitingCompletion(
							directory,
							session,
						);
						if (taskAwaiting) {
							session.pendingAdvisoryMessages ??= [];
							session.pendingAdvisoryMessages.push(
								completionGateViolationMessage(taskAwaiting),
							);
						}
						break; // only push once
					}
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

			// Capture the prior coder task ID BEFORE Step 3 updates lastCoderDelegationTaskId
			const priorCoderTaskId = sessionID
				? (swarmState.agentSessions.get(sessionID)?.lastCoderDelegationTaskId ??
					null)
				: null;

			// Step 3: If this is a coder delegation with a task ID, track it
			if (sessionID && isCoderDelegation && currentTaskId) {
				const session = ensureAgentSession(sessionID);
				session.lastCoderDelegationTaskId = currentTaskId;

				// v6.21 Task 5.3: Extract FILE: directive values → declaredCoderScope
				const fileDirPattern = /^FILE:\s*(.+)$/gm;
				const declaredFiles: string[] = [];
				for (const match of text.matchAll(fileDirPattern)) {
					const filePath = match[1].trim();
					if (filePath.length > 0 && !declaredFiles.includes(filePath)) {
						declaredFiles.push(filePath);
					}
				}
				session.declaredCoderScope =
					declaredFiles.length > 0 ? declaredFiles : null;

				// v6.33.1 CRIT-1: Also store in fallback map for scope-guard access
				if (declaredFiles.length > 0 && currentTaskId) {
					pendingCoderScopeByTaskId.set(currentTaskId, declaredFiles);
				} else {
					pendingCoderScopeByTaskId.delete(currentTaskId);
				}

				// OBSERVE-ONLY (Phase 2): Record coder delegation in task state machine for telemetry.
				// Error swallowing is intentional — Phase 3 enforcement gates will check state directly
				// at enforcement time. A transition failure here means state is already recorded or a
				// re-delegation occurred; the gate continues correctly regardless.
				try {
					await advanceTaskStateAndPersist(
						session,
						currentTaskId,
						'coder_delegated',
						directory,
						{ telemetrySessionId: sessionID },
					);
				} catch (err) {
					// INVALID_TASK_STATE_TRANSITION is non-fatal in Phase 2 (observe-only)
					logger.warn(
						`[delegation-gate] state machine warn: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
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
						const taskAwaitingCompletion = await findTaskAwaitingCompletion(
							directory,
							deliberationSession,
						);
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
	};
}
