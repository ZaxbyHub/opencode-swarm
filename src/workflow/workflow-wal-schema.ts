import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../background/pending-delegations.js';
import {
	isPathWithinDeclaredScope,
	unsafePathTextReason,
} from '../scope/path-identity.js';
import type { TaskWorkflowState } from '../state.js';
import {
	GIT_OBJECT_ID_PATTERN,
	type MergeOperationProvenance,
} from '../worktree/merge.js';

export type CoderSettlementState =
	| 'ABORTED'
	| 'COMMITTED'
	| 'DISPATCHED'
	| 'PREPARED';

export interface CoderSettlementWal {
	version: 1;
	state: CoderSettlementState;
	taskId: string;
	transitionId: string;
	actor: string;
	processId: number;
	runtimeId: string;
	expectedGeneration: number;
	context: BackgroundTaskChangeContext;
	worktree?: BackgroundWorktreeDescriptor;
	observedFiles?: string[];
	mergeProvenance?: MergeOperationProvenance;
	accepted?: boolean;
	testEngineerExempt?: boolean;
	settlementFailed?: boolean;
	cleanupComplete?: boolean;
	recordedAt: string;
}

export type RepairWalState = 'ABORTED' | 'COMMITTED' | 'PREPARED';

export interface TaskRepairWal {
	version: 1;
	state: RepairWalState;
	taskId: string;
	transitionId: string;
	reason: string;
	actor: string;
	oldPlanStatus: string;
	newPlanStatus: 'in_progress';
	oldWorkflowState: string;
	newWorkflowState: 'idle';
	oldGeneration: number;
	generation: number;
	recordedAt: string;
}

export type TerminalWalState = 'ABORTED' | 'COMMITTED' | 'PREPARED';
export type TerminalPlanStatus = 'blocked' | 'closed' | 'completed';
export type TerminalWorkflowState = 'blocked' | 'closed' | 'complete';

export interface TaskTerminalWalV1 {
	version: 1;
	state: TerminalWalState;
	taskId: string;
	transitionId: string;
	actor: string;
	oldPlanStatus: string;
	newPlanStatus: 'blocked' | 'completed';
	oldWorkflowState: TaskWorkflowState;
	newWorkflowState: 'blocked' | 'complete';
	generation: number;
	qaExempt: boolean;
	recordedAt: string;
}

export interface TaskTerminalWalV2
	extends Omit<
		TaskTerminalWalV1,
		'version' | 'newPlanStatus' | 'newWorkflowState'
	> {
	version: 2;
	newPlanStatus: 'closed' | 'completed';
	newWorkflowState: 'closed' | 'complete';
	planIdentityHash: string;
	planEpoch: string;
}

export type TaskTerminalWal = TaskTerminalWalV1 | TaskTerminalWalV2;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// Branch names reach git as bare argv operands (`git merge <branch>`,
// `git rebase <branch>`, `git branch -D <branch>`) with no `--` separator
// present at those call sites, so a tampered WAL carrying a leading `-` would
// be read by git as an option — `git rebase --exec=<cmd>` runs <cmd> per
// replayed commit. (Those three commands would accept a `--` before the
// operand; `git cherry-pick` would not, so validating the shape here is the
// guard that covers every sink.) This allowlist is deliberately NOT expressed in terms of
// `git check-ref-format --branch`: it neither contains nor is contained by that
// grammar. It rejects names git would accept (`release+1`) and accepts at least
// one git rejects (`HEAD`). Its safety argument does not depend on that
// relationship — it rests on argv safety (no leading `-`, no control
// characters, bounded length) plus the fact that `buildSwarmBranchName` is the
// only producer of the branch names this parser ever sees. The 1024 bound
// matches WorktreeDescriptorSchema in src/background/pending-delegations.ts,
// the writer-side schema for this field.
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,1023}$/;

function isSafeGitBranchName(value: unknown): value is string {
	if (typeof value !== 'string' || !BRANCH_NAME_PATTERN.test(value)) {
		return false;
	}
	if (value.includes('..') || value.endsWith('/') || value.endsWith('.')) {
		return false;
	}
	return !value
		.split('/')
		.some(
			(segment) =>
				segment.length === 0 ||
				segment.startsWith('.') ||
				segment.endsWith('.lock'),
		);
}

// `worktree.worktreePath` reaches existsSync() (src/workflow/coder-settlement.ts)
// and `git worktree remove <path>` (src/worktree/core.ts) with no `--` guard.
// Containment is deliberately NOT asserted here: the Windows path-budget
// fallback relocates lanes under os.tmpdir(), and `worktree_dir` is
// configurable — isPathUnderSwarmWorktreeBase already gates the one dangerous
// sink (the `--force` removal).
function isSafeWorktreePath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.startsWith('-') &&
		unsafePathTextReason(value) === null
	);
}
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_STATES = new Set<TaskWorkflowState>([
	'idle',
	'coder_delegated',
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
	'rework_required',
	'complete',
	'blocked',
	'closed',
]);

function formatUnreadableMessage(
	code: string,
	filePath: string,
	detail: string,
	remediation: string,
): never {
	throw new Error(`${code}: ${filePath} ${detail}. ${remediation}`);
}

/**
 * Shared JSON entry point for every WAL parser below. `JSON.parse("null")`
 * SUCCEEDS, so a WAL whose whole content is the literal `null` slips past the
 * try/catch and the first property access throws a raw TypeError instead of the
 * intended *_WAL_UNREADABLE diagnostic. Non-null primitives box, so only `null`
 * (and, for a precise message, an array) needs the extra guard.
 */
function parseWalObject(
	raw: string,
	filePath: string,
	code: string,
	remediation: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		formatUnreadableMessage(
			code,
			filePath,
			`is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			remediation,
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		formatUnreadableMessage(
			code,
			filePath,
			'is not a JSON object',
			remediation,
		);
	}
	return parsed as Record<string, unknown>;
}

export function parseCoderSettlementWal(
	raw: string,
	filePath: string,
	expectedTaskId?: string,
): CoderSettlementWal {
	const parsed = parseWalObject(
		raw,
		filePath,
		'CODER_SETTLEMENT_WAL_UNREADABLE',
		'Preserve this file, reconcile the task lane, and only then move it aside.',
	) as Partial<CoderSettlementWal>;
	const context = parsed.context as
		| Partial<BackgroundTaskChangeContext>
		| undefined;
	const baseline = context?.baseline;
	const worktree = parsed.worktree as
		| Partial<BackgroundWorktreeDescriptor>
		| undefined;
	const provenance = parsed.mergeProvenance as
		| Partial<MergeOperationProvenance>
		| undefined;
	if (
		parsed.version !== 1 ||
		!['ABORTED', 'COMMITTED', 'DISPATCHED', 'PREPARED'].includes(
			String(parsed.state),
		) ||
		typeof parsed.taskId !== 'string' ||
		!TASK_ID_PATTERN.test(parsed.taskId) ||
		typeof parsed.transitionId !== 'string' ||
		parsed.transitionId.length === 0 ||
		parsed.transitionId.length > 512 ||
		typeof parsed.actor !== 'string' ||
		parsed.actor.length === 0 ||
		parsed.actor.length > 512 ||
		!Number.isInteger(parsed.processId) ||
		(parsed.processId ?? 0) <= 0 ||
		typeof parsed.runtimeId !== 'string' ||
		parsed.runtimeId.length === 0 ||
		!Number.isInteger(parsed.expectedGeneration) ||
		(parsed.expectedGeneration ?? -1) < 0 ||
		!context ||
		!baseline ||
		typeof baseline.directory !== 'string' ||
		baseline.directory.length === 0 ||
		baseline.directory.length > 4096 ||
		(typeof baseline.gitHead !== 'string' && baseline.gitHead !== null) ||
		(typeof baseline.dirtyHash !== 'string' && baseline.dirtyHash !== null) ||
		(typeof baseline.prHeadSha !== 'string' && baseline.prHeadSha !== null) ||
		(typeof baseline.scope !== 'string' && baseline.scope !== null) ||
		(!Array.isArray(baseline.changedFiles) &&
			baseline.changedFiles !== null &&
			baseline.changedFiles !== undefined) ||
		(Array.isArray(baseline.changedFiles) &&
			(baseline.changedFiles.length > 50_000 ||
				baseline.changedFiles.some(
					(candidatePath) =>
						typeof candidatePath !== 'string' || candidatePath.length > 4096,
				))) ||
		(!Array.isArray(context.declaredFiles) && context.declaredFiles !== null) ||
		(Array.isArray(context.declaredFiles) &&
			(context.declaredFiles.length > 50_000 ||
				context.declaredFiles.some(
					(candidatePath) =>
						typeof candidatePath !== 'string' || candidatePath.length > 4096,
				))) ||
		(parsed.observedFiles !== undefined &&
			(!Array.isArray(parsed.observedFiles) ||
				parsed.observedFiles.length > 50_000 ||
				parsed.observedFiles.some(
					(candidatePath) =>
						typeof candidatePath !== 'string' ||
						candidatePath.length > 4096 ||
						!isPathWithinDeclaredScope(
							candidatePath,
							context.declaredFiles ?? [],
							baseline.directory,
						),
				))) ||
		(worktree !== undefined &&
			(typeof worktree.callID !== 'string' ||
				typeof worktree.parentSessionId !== 'string' ||
				typeof worktree.taskId !== 'string' ||
				worktree.taskId !== parsed.taskId ||
				!isSafeWorktreePath(worktree.worktreePath) ||
				!isSafeGitBranchName(worktree.branchName) ||
				typeof worktree.worktreeId !== 'string' ||
				typeof worktree.worktreeSessionId !== 'string' ||
				!['merge', 'rebase', 'cherry-pick'].includes(
					String(worktree.mergeStrategy),
				) ||
				!Number.isInteger(worktree.laneIndex))) ||
		(provenance !== undefined &&
			(typeof provenance.operationId !== 'string' ||
				provenance.operationId !== parsed.transitionId ||
				typeof provenance.sourceHead !== 'string' ||
				!GIT_OBJECT_ID_PATTERN.test(provenance.sourceHead) ||
				typeof provenance.targetHeadBefore !== 'string' ||
				!GIT_OBJECT_ID_PATTERN.test(provenance.targetHeadBefore) ||
				!isSafeGitBranchName(provenance.branchName) ||
				(worktree !== undefined &&
					(provenance.branchName !== worktree.branchName ||
						provenance.strategy !== worktree.mergeStrategy)) ||
				!['merge', 'rebase', 'cherry-pick'].includes(
					String(provenance.strategy),
				))) ||
		typeof parsed.recordedAt !== 'string' ||
		(parsed.state === 'PREPARED' && typeof parsed.accepted !== 'boolean') ||
		(parsed.cleanupComplete !== undefined &&
			typeof parsed.cleanupComplete !== 'boolean') ||
		(parsed.settlementFailed !== undefined &&
			typeof parsed.settlementFailed !== 'boolean')
	) {
		formatUnreadableMessage(
			'CODER_SETTLEMENT_WAL_UNREADABLE',
			filePath,
			'is not a valid v1 coder-settlement WAL',
			'Preserve this file, reconcile the task lane, and only then move it aside.',
		);
	}
	if (expectedTaskId && parsed.taskId !== expectedTaskId) {
		formatUnreadableMessage(
			'CODER_SETTLEMENT_WAL_TASK_MISMATCH',
			filePath,
			`records task ${parsed.taskId} but was read for task ${expectedTaskId}`,
			'Preserve this file, reconcile the task lane, and only then move it aside.',
		);
	}
	return parsed as CoderSettlementWal;
}

export function parseTaskRepairWal(
	raw: string,
	filePath: string,
	expectedTaskId?: string,
): TaskRepairWal {
	const parsed = parseWalObject(
		raw,
		filePath,
		'TASK_REPAIR_WAL_UNREADABLE',
		'Preserve this file, reconcile the repair transition, and only then move it aside.',
	) as Partial<TaskRepairWal>;
	if (
		parsed.version !== 1 ||
		(parsed.state !== 'PREPARED' &&
			parsed.state !== 'COMMITTED' &&
			parsed.state !== 'ABORTED') ||
		typeof parsed.taskId !== 'string' ||
		!TASK_ID_PATTERN.test(parsed.taskId) ||
		typeof parsed.transitionId !== 'string' ||
		parsed.transitionId.length === 0 ||
		parsed.transitionId.length > 512 ||
		typeof parsed.reason !== 'string' ||
		parsed.reason.length === 0 ||
		parsed.reason.length > 4096 ||
		typeof parsed.actor !== 'string' ||
		parsed.actor.length === 0 ||
		parsed.actor.length > 512 ||
		typeof parsed.oldPlanStatus !== 'string' ||
		parsed.oldPlanStatus.length === 0 ||
		parsed.oldPlanStatus.length > 128 ||
		parsed.newPlanStatus !== 'in_progress' ||
		typeof parsed.oldWorkflowState !== 'string' ||
		!WORKFLOW_STATES.has(parsed.oldWorkflowState as TaskWorkflowState) ||
		parsed.newWorkflowState !== 'idle' ||
		!Number.isInteger(parsed.generation) ||
		(parsed.generation ?? -1) < 0 ||
		!Number.isInteger(parsed.oldGeneration) ||
		(parsed.oldGeneration ?? -1) < 0 ||
		parsed.generation !== (parsed.oldGeneration ?? -1) + 1 ||
		typeof parsed.recordedAt !== 'string' ||
		!Number.isFinite(Date.parse(parsed.recordedAt))
	) {
		formatUnreadableMessage(
			'TASK_REPAIR_WAL_UNREADABLE',
			filePath,
			'is not a valid v1 repair WAL (unexpected shape or version)',
			'Preserve this file, reconcile the repair transition, and only then move it aside.',
		);
	}
	if (expectedTaskId && parsed.taskId !== expectedTaskId) {
		formatUnreadableMessage(
			'TASK_REPAIR_WAL_TASK_MISMATCH',
			filePath,
			`records task ${parsed.taskId} but was read for task ${expectedTaskId}`,
			'Preserve this file, reconcile the repair transition, and only then move it aside.',
		);
	}
	return parsed as TaskRepairWal;
}

export function parseTaskTerminalWal(
	raw: string,
	filePath: string,
	expectedTaskId?: string,
): TaskTerminalWal {
	const parsed = parseWalObject(
		raw,
		filePath,
		'TASK_TERMINAL_WAL_UNREADABLE',
		'Preserve this file and reconcile the task terminal transition before moving it aside.',
	) as Partial<{
		version: number;
		state: TerminalWalState;
		taskId: string;
		transitionId: string;
		actor: string;
		oldPlanStatus: string;
		newPlanStatus: TerminalPlanStatus;
		oldWorkflowState: TaskWorkflowState;
		newWorkflowState: TerminalWorkflowState;
		generation: number;
		qaExempt: boolean;
		recordedAt: string;
		planIdentityHash: string;
		planEpoch: string;
	}>;
	if (
		(parsed.version !== 1 && parsed.version !== 2) ||
		(parsed.state !== 'PREPARED' &&
			parsed.state !== 'COMMITTED' &&
			parsed.state !== 'ABORTED') ||
		typeof parsed.taskId !== 'string' ||
		!TASK_ID_PATTERN.test(parsed.taskId) ||
		typeof parsed.transitionId !== 'string' ||
		parsed.transitionId.length === 0 ||
		parsed.transitionId.length > 512 ||
		typeof parsed.actor !== 'string' ||
		parsed.actor.length === 0 ||
		parsed.actor.length > 512 ||
		typeof parsed.oldPlanStatus !== 'string' ||
		parsed.oldPlanStatus.length === 0 ||
		parsed.oldPlanStatus.length > 128 ||
		(parsed.newPlanStatus !== 'completed' &&
			parsed.newPlanStatus !== 'blocked' &&
			parsed.newPlanStatus !== 'closed') ||
		typeof parsed.oldWorkflowState !== 'string' ||
		!WORKFLOW_STATES.has(parsed.oldWorkflowState as TaskWorkflowState) ||
		(parsed.newWorkflowState !== 'complete' &&
			parsed.newWorkflowState !== 'blocked' &&
			parsed.newWorkflowState !== 'closed') ||
		!Number.isInteger(parsed.generation) ||
		(parsed.generation ?? -1) < 0 ||
		typeof parsed.qaExempt !== 'boolean' ||
		typeof parsed.recordedAt !== 'string' ||
		!Number.isFinite(Date.parse(parsed.recordedAt))
	) {
		formatUnreadableMessage(
			'TASK_TERMINAL_WAL_UNREADABLE',
			filePath,
			'is not a valid terminal WAL',
			'Preserve this file and reconcile the task terminal transition before moving it aside.',
		);
	}
	if (
		parsed.version === 2 &&
		(typeof parsed.planIdentityHash !== 'string' ||
			!SHA256_PATTERN.test(parsed.planIdentityHash) ||
			typeof parsed.planEpoch !== 'string' ||
			!UUID_PATTERN.test(parsed.planEpoch))
	) {
		formatUnreadableMessage(
			'TASK_TERMINAL_WAL_UNREADABLE',
			filePath,
			'is missing the v2 plan identity fields',
			'Preserve this file and reconcile the task terminal transition before moving it aside.',
		);
	}
	if (
		parsed.version === 1 &&
		(parsed.newPlanStatus === 'closed' || parsed.newWorkflowState === 'closed')
	) {
		formatUnreadableMessage(
			'TASK_TERMINAL_WAL_UNREADABLE',
			filePath,
			'claims a closed transition in a legacy v1 terminal WAL',
			'Preserve this file and reconcile the task terminal transition before moving it aside.',
		);
	}
	if (
		!(
			(parsed.newPlanStatus === 'completed' &&
				parsed.newWorkflowState === 'complete') ||
			(parsed.newPlanStatus === 'blocked' &&
				parsed.newWorkflowState === 'blocked') ||
			(parsed.newPlanStatus === 'closed' &&
				parsed.newWorkflowState === 'closed')
		)
	) {
		throw new Error(
			`TASK_TERMINAL_WAL_STATE_MISMATCH: ${filePath} encodes ${String(parsed.newPlanStatus)} -> ${String(parsed.newWorkflowState)}`,
		);
	}
	if (expectedTaskId && parsed.taskId !== expectedTaskId) {
		formatUnreadableMessage(
			'TASK_TERMINAL_WAL_TASK_MISMATCH',
			filePath,
			`records task ${parsed.taskId} but was read for task ${expectedTaskId}`,
			'Preserve this file and reconcile the task terminal transition before moving it aside.',
		);
	}
	return parsed as TaskTerminalWal;
}
