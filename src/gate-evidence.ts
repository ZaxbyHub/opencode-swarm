/**
 * Gate Evidence Store
 *
 * Durable, task-scoped evidence for QA gate completion.
 * Evidence is recorded on disk (.swarm/evidence/{taskId}.json) by the
 * delegation-gate toolAfter hook and read by checkReviewerGate at
 * update_task_status(completed) time.
 *
 * Evidence files survive session restarts (unlike in-memory state).
 * Agents never write these files directly — only the hook does.
 * Gates are append-only: required_gates can only grow, never shrink.
 *
 * Threat boundary: this store provides atomic, path-contained durability and
 * auditability for cooperative same-user agents. It is not tamper-proof
 * authorization against a process with arbitrary same-user workspace access;
 * that requires a protected trust root outside the project workspace.
 */

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
	atomicWriteFile,
	taskEvidencePath,
	withTaskEvidenceLock,
} from './evidence/task-file.js';
import { validateSwarmPath } from './hooks/utils.js';
import type { TaskWorkflowState } from './state';
import { telemetry } from './telemetry.js';
import { assertStrictTaskId, isStrictTaskId } from './validation/task-id';
import { readWorkflowWalFileSync } from './workflow/workflow-wal-file.js';

export interface GateEvidence {
	sessionId: string;
	timestamp: string;
	agent: string;
}

export const TASK_WORKFLOW_SCHEMA_MARKER = 'exact-task-v1' as const;

const TASK_WORKFLOW_STATES = [
	'idle',
	'coder_delegated',
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
	'rework_required',
	'complete',
	'blocked',
	'closed',
] as const satisfies ReadonlyArray<TaskWorkflowState>;

const TASK_WORKFLOW_OUTCOMES = [
	'none',
	'dispatch_attempted',
	'dispatch_no_mutation',
	'accepted_mutation',
	'accepted_mutation_failed',
	'stage_a_passed',
	'stage_a_failed',
	'stage_b_completed',
	'stage_b_failed',
	'gate_recorded',
	'task_completed',
	'task_blocked',
	'task_closed',
	'repair_idle',
] as const;

export type TaskWorkflowTransitionOutcome =
	(typeof TASK_WORKFLOW_OUTCOMES)[number];

export interface TaskWorkflowMetadata {
	schema: typeof TASK_WORKFLOW_SCHEMA_MARKER;
	generation: number;
	state: TaskWorkflowState;
	retryCount: number;
	retryHistory: TaskWorkflowTransitionOutcome[];
	/** Stable circuit-breaker cycle across accepted repair mutations. */
	retryEpoch: number;
	lastOutcome: TaskWorkflowTransitionOutcome;
	lastTransitionId: string | null;
	updatedAt: string;
}

export interface TaskWorkflowSnapshot extends TaskWorkflowMetadata {
	authoritative: boolean;
}

export interface TaskEvidence {
	taskId: string;
	required_gates: string[];
	gates: Record<string, GateEvidence>;
	turbo?: boolean;
	/** Durable proof that the coder dispatch was classified as exact Markdown-only. */
	test_engineer_exempt?: boolean;
	/** Exact-task workflow metadata. Missing on legacy evidence written before #2098. */
	workflow?: TaskWorkflowMetadata;
}

/**
 * Fence ordinary evidence writers while a terminal or repair plan/evidence
 * transaction is PREPARED. Only the owning WAL transition may proceed.
 */
export function assertTaskEvidenceWriteAllowed(
	directory: string,
	taskId: string,
	event?: TaskWorkflowTransitionEvent,
): void {
	assertValidTaskId(taskId);
	const coderWalPath = validateSwarmPath(
		directory,
		`coder-settlements/${taskId}.json`,
	);
	const coderWal = readWorkflowWalFileSync(
		'coder-settlement',
		coderWalPath,
		taskId,
	);
	if (
		(coderWal?.state === 'DISPATCHED' || coderWal?.state === 'PREPARED') &&
		!(
			event != null &&
			event.transitionId === coderWal.transitionId &&
			(event.type === 'dispatch_attempted' ||
				event.type === 'dispatch_no_mutation' ||
				event.type === 'accepted_mutation')
		)
	) {
		throw new Error(
			`CODER_SETTLEMENT_IN_PROGRESS: transition ${String(coderWal.transitionId)} owns evidence for task ${taskId}`,
		);
	}

	const terminalWalPath = validateSwarmPath(
		directory,
		`task-terminals/${taskId}.json`,
	);
	const terminalWal = readWorkflowWalFileSync(
		'task-terminal',
		terminalWalPath,
		taskId,
	);
	if (terminalWal?.state === 'PREPARED') {
		const matchingTerminalEvent =
			event != null &&
			event.transitionId === terminalWal.transitionId &&
			((event.type === 'task_completed' &&
				terminalWal.newPlanStatus === 'completed') ||
				(event.type === 'task_blocked' &&
					terminalWal.newPlanStatus === 'blocked') ||
				(event.type === 'task_closed' &&
					terminalWal.newPlanStatus === 'closed'));
		if (!matchingTerminalEvent) {
			throw new Error(
				`TASK_TERMINAL_PREPARED: transition ${String(terminalWal.transitionId)} owns evidence for task ${taskId}`,
			);
		}
	}

	const repairWalPath = validateSwarmPath(
		directory,
		`task-repairs/${taskId}.json`,
	);
	const repairWal = readWorkflowWalFileSync(
		'task-repair',
		repairWalPath,
		taskId,
	);
	if (
		repairWal?.state === 'PREPARED' &&
		!(
			event?.type === 'repair_idle' &&
			event.transitionId === repairWal.transitionId
		)
	) {
		throw new Error(
			`TASK_REPAIR_PREPARED: transition ${String(repairWal.transitionId)} owns evidence for task ${taskId}`,
		);
	}
}

export type TaskWorkflowTransitionEvent =
	| {
			type: 'dispatch_attempted';
			agentType?: string;
			context?: GateDerivationContext;
			turbo?: boolean;
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'dispatch_no_mutation';
			agentType?: string;
			context?: GateDerivationContext;
			turbo?: boolean;
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'accepted_mutation';
			agentType?: string;
			context?: GateDerivationContext;
			turbo?: boolean;
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'stage_a_passed';
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'stage_a_failed';
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'stage_b_completed';
			gate: 'reviewer' | 'test_engineer';
			sessionId: string;
			turbo?: boolean;
			ensureDefaultStageB?: boolean;
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'stage_b_failed';
			gate: 'reviewer' | 'test_engineer';
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'gate_recorded';
			gate: string;
			sessionId: string;
			turbo?: boolean;
			expectedGeneration?: number;
			transitionId?: string;
	  }
	| {
			type: 'task_completed';
			/** Locked plan phase explicitly declares that reviewer QA is not required. */
			qaExempt?: boolean;
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'task_blocked';
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'task_closed';
			expectedGeneration: number;
			transitionId?: string;
	  }
	| {
			type: 'repair_idle';
			expectedGeneration: number;
			transitionId?: string;
	  };

export interface TaskEvidenceTransaction {
	taskId: string;
	read(): TaskEvidence | null;
	transition(event: TaskWorkflowTransitionEvent): Promise<TaskEvidence>;
}

const GateEvidenceSchema = z
	.object({
		sessionId: z.string(),
		timestamp: z.string(),
		agent: z.string(),
	})
	.passthrough(); // preserve council-specific extras (verdict, vetoedBy, etc.)

const TaskWorkflowMetadataSchema = z.object({
	schema: z.literal(TASK_WORKFLOW_SCHEMA_MARKER),
	generation: z.number().int().min(0),
	state: z.enum(TASK_WORKFLOW_STATES),
	retryCount: z.number().int().min(0).default(0),
	retryHistory: z.array(z.enum(TASK_WORKFLOW_OUTCOMES)).max(3).default([]),
	retryEpoch: z.number().int().min(0).default(0),
	lastOutcome: z.enum(TASK_WORKFLOW_OUTCOMES).default('none'),
	lastTransitionId: z.string().min(1).nullable().optional().default(null),
	updatedAt: z.string(),
});

const TaskEvidenceSchema = z.object({
	taskId: z.string(),
	required_gates: z.array(z.string()).default([]),
	gates: z.record(z.string(), GateEvidenceSchema),
	turbo: z.boolean().optional(),
	test_engineer_exempt: z.boolean().optional(),
	workflow: TaskWorkflowMetadataSchema.optional(),
});

export function parseTaskEvidence(
	raw: string,
	expectedTaskId: string,
): TaskEvidence {
	const parsed = TaskEvidenceSchema.parse(JSON.parse(raw));
	if (parsed.taskId !== expectedTaskId) {
		throw new Error(
			`TASK_EVIDENCE_IDENTITY_MISMATCH: expected ${expectedTaskId}, found ${parsed.taskId}`,
		);
	}
	return parsed;
}

export const DEFAULT_REQUIRED_GATES = ['reviewer', 'test_engineer'];

export interface GateDerivationContext {
	/** Trusted pre/post workspace classification; false/absent fails closed. */
	testEngineerExempt?: boolean;
	/** The shared-root coder changed files but returned a failed/cancelled result. */
	settlementFailed?: boolean;
}

const DEFAULT_WORKFLOW_STATE: TaskWorkflowState = 'idle';
const WORKFLOW_STATE_RANK: Record<TaskWorkflowState, number> = {
	idle: 0,
	coder_delegated: 1,
	pre_check_passed: 2,
	reviewer_run: 3,
	tests_run: 4,
	rework_required: 5,
	blocked: 6,
	closed: 7,
	complete: 8,
};

/**
 * Canonical task-id validation helper.
 * Delegates to the shared strict validator (#452 item 2).
 * Re-exported for backward compatibility with existing callers.
 */
export function isValidTaskId(taskId: string): boolean {
	return isStrictTaskId(taskId);
}

function assertValidTaskId(taskId: string): void {
	assertStrictTaskId(taskId);
}

function createDefaultWorkflowMetadata(nowIso: string): TaskWorkflowMetadata {
	return {
		schema: TASK_WORKFLOW_SCHEMA_MARKER,
		generation: 0,
		state: DEFAULT_WORKFLOW_STATE,
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		lastOutcome: 'none',
		lastTransitionId: null,
		updatedAt: nowIso,
	};
}

function getEventOutcome(
	event: TaskWorkflowTransitionEvent,
): TaskWorkflowTransitionOutcome {
	switch (event.type) {
		case 'dispatch_attempted':
			return 'dispatch_attempted';
		case 'dispatch_no_mutation':
			return 'dispatch_no_mutation';
		case 'accepted_mutation':
			return event.context?.settlementFailed === true
				? 'accepted_mutation_failed'
				: 'accepted_mutation';
		case 'stage_a_passed':
			return 'stage_a_passed';
		case 'stage_a_failed':
			return 'stage_a_failed';
		case 'stage_b_completed':
			return 'stage_b_completed';
		case 'stage_b_failed':
			return 'stage_b_failed';
		case 'gate_recorded':
			return 'gate_recorded';
		case 'task_completed':
			return 'task_completed';
		case 'task_blocked':
			return 'task_blocked';
		case 'task_closed':
			return 'task_closed';
		case 'repair_idle':
			return 'repair_idle';
	}
}

function isAuthoritativeWorkflowMetadata(
	workflow: TaskEvidence['workflow'],
): workflow is TaskWorkflowMetadata {
	return workflow?.schema === TASK_WORKFLOW_SCHEMA_MARKER;
}

export function getTaskWorkflowSnapshot(
	evidence: TaskEvidence | null | undefined,
): TaskWorkflowSnapshot {
	if (isAuthoritativeWorkflowMetadata(evidence?.workflow)) {
		return { ...evidence.workflow, authoritative: true };
	}
	return {
		...createDefaultWorkflowMetadata(''),
		authoritative: false,
	};
}

function maybeExpandRequiredGates(
	existing: TaskEvidence | null,
	event: TaskWorkflowTransitionEvent,
): string[] {
	if (event.type === 'accepted_mutation') {
		const agentType = event.agentType;
		if (typeof agentType === 'string' && agentType.trim() !== '') {
			return existing
				? expandRequiredGates(
						existing.required_gates,
						agentType,
						event.context ?? {},
					)
				: deriveRequiredGates(agentType, event.context ?? {});
		}
	}
	if (
		event.type === 'stage_b_completed' &&
		event.ensureDefaultStageB === true
	) {
		return expandRequiredGates(existing?.required_gates ?? [], 'coder', {
			testEngineerExempt: false,
		});
	}
	if (event.type === 'stage_b_completed' || event.type === 'gate_recorded') {
		return existing
			? expandRequiredGates(existing.required_gates, event.gate)
			: deriveRequiredGates(event.gate);
	}
	return existing?.required_gates ?? [];
}

function hasAllRequiredGatesPassed(
	requiredGates: string[],
	gates: Record<string, GateEvidence>,
): boolean {
	return (
		requiredGates.length > 0 &&
		requiredGates.every((gate) => gates[gate] != null)
	);
}

function shouldTreatGateAsStageB(
	gate: string,
): gate is 'reviewer' | 'test_engineer' {
	return gate === 'reviewer' || gate === 'test_engineer';
}

function clearWorkflowGateProof(
	gates: Record<string, GateEvidence>,
): Record<string, GateEvidence> {
	const retained = { ...gates };
	delete retained.pre_check;
	delete retained.reviewer;
	delete retained.test_engineer;
	delete retained.council;
	delete retained.critic;
	delete retained.critic_sounding_board;
	return retained;
}

function assertExpectedGeneration(
	snapshot: TaskWorkflowSnapshot,
	event: TaskWorkflowTransitionEvent,
): void {
	if (
		typeof event.expectedGeneration === 'number' &&
		event.expectedGeneration !== snapshot.generation
	) {
		throw new Error(
			`TASK_WORKFLOW_GENERATION_MISMATCH: expected ${event.expectedGeneration}, current ${snapshot.generation}`,
		);
	}
}

function isDuplicateTransition(
	snapshot: TaskWorkflowSnapshot,
	event: TaskWorkflowTransitionEvent,
): boolean {
	return (
		snapshot.authoritative &&
		typeof event.transitionId === 'string' &&
		event.transitionId.length > 0 &&
		snapshot.lastTransitionId === event.transitionId &&
		snapshot.lastOutcome === getEventOutcome(event)
	);
}

export function reduceTaskWorkflowSnapshot(
	current: TaskWorkflowSnapshot,
	event: TaskWorkflowTransitionEvent,
	context: {
		requiredGates: string[];
		gates: Record<string, GateEvidence>;
		nowIso: string;
	},
): TaskWorkflowMetadata {
	if (
		(current.state === 'complete' ||
			current.state === 'blocked' ||
			current.state === 'closed') &&
		event.type !== 'repair_idle' &&
		!(
			(current.state === 'complete' && event.type === 'task_completed') ||
			(current.state === 'blocked' && event.type === 'task_blocked') ||
			(current.state === 'blocked' && event.type === 'task_closed')
		)
	) {
		throw new Error(
			`TASK_WORKFLOW_TERMINAL: cannot apply ${event.type} from ${current.state}`,
		);
	}
	const outcome = getEventOutcome(event);
	const base: TaskWorkflowMetadata = {
		schema: TASK_WORKFLOW_SCHEMA_MARKER,
		generation: current.generation,
		state: current.state,
		retryCount: current.retryCount,
		retryHistory: current.retryHistory,
		retryEpoch: current.retryEpoch,
		lastOutcome: outcome,
		lastTransitionId: event.transitionId ?? current.lastTransitionId,
		updatedAt: context.nowIso,
	};

	switch (event.type) {
		case 'dispatch_attempted':
			return base;
		case 'dispatch_no_mutation':
			return {
				...base,
				retryCount: Math.min(current.retryCount + 1, 3),
				retryHistory: [...current.retryHistory, outcome].slice(-3),
				retryEpoch: current.retryEpoch || current.generation + 1,
			};
		case 'stage_b_failed':
			if (
				current.state !== 'pre_check_passed' &&
				current.state !== 'reviewer_run' &&
				current.state !== 'tests_run' &&
				current.state !== 'rework_required'
			) {
				throw new Error(
					`TASK_WORKFLOW_STAGE_A_REQUIRED: cannot reject ${event.gate} from ${current.state}`,
				);
			}
			return {
				...base,
				state: 'rework_required',
				retryCount: Math.min(current.retryCount + 1, 3),
				retryHistory: [...current.retryHistory, outcome].slice(-3),
				retryEpoch: current.retryEpoch || current.generation + 1,
			};
		case 'accepted_mutation':
			if (event.context?.settlementFailed === true) {
				return {
					...base,
					generation: current.generation + 1,
					state: 'rework_required',
					retryCount: Math.min(current.retryCount + 1, 3),
					retryHistory: [...current.retryHistory, outcome].slice(-3),
					retryEpoch: current.retryEpoch || current.generation + 1,
				};
			}
			return {
				...base,
				generation: current.generation + 1,
				state: 'coder_delegated',
				// A mutation is a repair attempt, not proof that prior rejections were
				// resolved. Preserve the task-level circuit history across generations.
			};
		case 'stage_a_passed':
			if (
				current.state !== 'coder_delegated' &&
				current.state !== 'pre_check_passed'
			) {
				throw new Error(
					`TASK_WORKFLOW_CODER_MUTATION_REQUIRED: cannot pass Stage A from ${current.state}`,
				);
			}
			return {
				...base,
				state: 'pre_check_passed',
			};
		case 'stage_a_failed':
			if (
				current.state !== 'coder_delegated' &&
				current.state !== 'pre_check_passed' &&
				current.state !== 'rework_required'
			) {
				throw new Error(
					`TASK_WORKFLOW_CODER_MUTATION_REQUIRED: cannot fail Stage A from ${current.state}`,
				);
			}
			return {
				...base,
				state: 'rework_required',
				retryCount: Math.min(current.retryCount + 1, 3),
				retryHistory: [...current.retryHistory, outcome].slice(-3),
				retryEpoch: current.retryEpoch || current.generation + 1,
			};
		case 'stage_b_completed':
			if (
				current.state !== 'pre_check_passed' &&
				current.state !== 'reviewer_run' &&
				current.state !== 'tests_run'
			) {
				throw new Error(
					`TASK_WORKFLOW_STAGE_A_REQUIRED: cannot record ${event.gate} from ${current.state}`,
				);
			}
			return {
				...base,
				state: hasAllRequiredGatesPassed(context.requiredGates, context.gates)
					? 'tests_run'
					: 'reviewer_run',
			};
		case 'gate_recorded':
			return {
				...base,
				// Advisory/non-Stage-B gates never advance the code QA lifecycle.
				state: current.state,
			};
		case 'task_completed':
			if (
				event.qaExempt !== true &&
				current.state !== 'tests_run' &&
				current.state !== 'complete' &&
				!(current.state === 'pre_check_passed' && context.gates.council != null)
			) {
				throw new Error(
					`TASK_WORKFLOW_QA_REQUIRED: cannot complete from ${current.state}`,
				);
			}
			return {
				...base,
				state: 'complete',
			};
		case 'task_blocked':
			return {
				...base,
				state: 'blocked',
			};
		case 'task_closed':
			return {
				...base,
				state: 'closed',
			};
		case 'repair_idle':
			return {
				...base,
				generation: current.generation + 1,
				state: 'idle',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
			};
	}
}

function getEvidenceDir(directory: string): string {
	const swarmDir = path.resolve(directory, '.swarm');
	const evidenceDir = path.join(swarmDir, 'evidence');
	mkdirSync(evidenceDir, { recursive: true });

	let resolvedSwarmDir: string;
	let resolvedEvidenceDir: string;
	try {
		resolvedSwarmDir = path.normalize(realpathSync(swarmDir));
		resolvedEvidenceDir = path.normalize(realpathSync(evidenceDir));
	} catch (error) {
		throw new Error(
			`Unable to resolve evidence directory: ${(error as Error).message}`,
		);
	}
	const swarmPrefix = `${resolvedSwarmDir}${path.sep}`;
	const withinSwarmBoundary =
		process.platform === 'win32'
			? resolvedEvidenceDir.toLowerCase().startsWith(swarmPrefix.toLowerCase())
			: resolvedEvidenceDir.startsWith(swarmPrefix);

	if (!withinSwarmBoundary) {
		throw new Error(
			`Evidence path escapes .swarm boundary: ${resolvedEvidenceDir}`,
		);
	}

	return resolvedEvidenceDir;
}

function getEvidencePath(directory: string, taskId: string): string {
	assertValidTaskId(taskId);
	return taskEvidencePath(directory, taskId);
}

function readExisting(
	evidencePath: string,
	taskId: string,
): TaskEvidence | null {
	try {
		const raw = readFileSync(evidencePath, 'utf-8');
		return parseTaskEvidence(raw, taskId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		telemetry.gateParseError(taskId, error as Error);
		throw error;
	}
}

/**
 * Maps the first-dispatched agent type to the initial required_gates array.
 * Unknown agent types fall back to the safe default ["reviewer", "test_engineer"].
 */
export function deriveRequiredGates(
	agentType: string,
	context: GateDerivationContext = {},
): string[] {
	switch (agentType) {
		case 'coder':
			return context.testEngineerExempt === true
				? ['reviewer']
				: ['reviewer', 'test_engineer'];
		case 'docs':
			return ['docs'];
		case 'designer':
			return ['designer', 'reviewer', 'test_engineer'];
		case 'explorer':
			return ['explorer'];
		case 'sme':
			return ['sme'];
		case 'reviewer':
			return ['reviewer'];
		case 'test_engineer':
			return ['test_engineer'];
		case 'critic':
			return ['critic'];
		case 'critic_sounding_board':
			return ['critic_sounding_board'];
		case 'critic_drift_verifier':
			return ['critic_drift_verifier'];
		case 'critic_hallucination_verifier':
			return ['critic_hallucination_verifier'];
		case 'critic_architecture_supervisor':
			return ['critic_architecture_supervisor'];
		default:
			return ['reviewer', 'test_engineer'];
	}
}

/**
 * Returns the union of existingGates and deriveRequiredGates(newAgentType).
 * Sorted, deduplicated. Gates can only grow, never shrink.
 */
export function expandRequiredGates(
	existingGates: string[],
	newAgentType: string,
	context: GateDerivationContext = {},
): string[] {
	const newGates = deriveRequiredGates(newAgentType, context);
	const combined = [...new Set([...(existingGates ?? []), ...newGates])];
	return combined.sort();
}

function updateEvidenceForTransition(
	existing: TaskEvidence | null,
	event: TaskWorkflowTransitionEvent,
): TaskEvidence {
	const nowIso = new Date().toISOString();
	const requiredGates = maybeExpandRequiredGates(existing, event);
	let gates: Record<string, GateEvidence> = {
		...(existing?.gates ?? {}),
	};

	if (event.type === 'accepted_mutation' || event.type === 'repair_idle') {
		gates = clearWorkflowGateProof(gates);
	}

	if (event.type === 'stage_a_passed') {
		gates = {
			...gates,
			pre_check: {
				sessionId: 'system',
				timestamp: nowIso,
				agent: 'pre_check',
			},
		};
	}

	if (event.type === 'stage_a_failed') {
		delete gates.pre_check;
	}

	if (event.type === 'stage_b_failed') {
		delete gates.reviewer;
		delete gates.test_engineer;
	}

	if (event.type === 'stage_b_completed' || event.type === 'gate_recorded') {
		gates = {
			...gates,
			[event.gate]: {
				sessionId: event.sessionId,
				timestamp: nowIso,
				agent: event.gate,
			},
		};
	}

	const snapshot = getTaskWorkflowSnapshot(existing);
	assertExpectedGeneration(snapshot, event);
	if (isDuplicateTransition(snapshot, event) && existing) {
		return existing;
	}

	const workflow = reduceTaskWorkflowSnapshot(snapshot, event, {
		requiredGates,
		gates,
		nowIso,
	});

	return {
		taskId: existing?.taskId ?? '',
		required_gates: requiredGates,
		gates,
		turbo:
			'turbo' in event && event.turbo === true
				? true
				: 'turbo' in event && event.turbo === false
					? existing?.turbo
					: existing?.turbo,
		test_engineer_exempt:
			(event.type === 'dispatch_attempted' ||
				event.type === 'dispatch_no_mutation' ||
				event.type === 'accepted_mutation') &&
			event.agentType === 'coder'
				? event.context?.testEngineerExempt === true &&
					!requiredGates.includes('test_engineer')
				: existing?.test_engineer_exempt,
		workflow,
	};
}

export async function transitionTaskWorkflowEvidence(
	directory: string,
	taskId: string,
	event: TaskWorkflowTransitionEvent,
): Promise<TaskEvidence> {
	assertValidTaskId(taskId);

	let updatedEvidence: TaskEvidence | null = null;
	await withTaskEvidenceTransaction(
		directory,
		taskId,
		event.type,
		async (transaction) => {
			updatedEvidence = await transaction.transition(event);
		},
	);

	return (
		updatedEvidence ?? {
			taskId,
			required_gates: [],
			gates: {},
			workflow: createDefaultWorkflowMetadata(new Date().toISOString()),
		}
	);
}

export async function withTaskEvidenceTransaction<T>(
	directory: string,
	taskId: string,
	agent: string,
	callback: (transaction: TaskEvidenceTransaction) => Promise<T>,
): Promise<T> {
	assertValidTaskId(taskId);

	return withTaskEvidenceLock(directory, taskId, agent, async () => {
		const resolvedEvidenceDir = getEvidenceDir(directory);
		const evidencePath = path.join(resolvedEvidenceDir, `${taskId}.json`);
		let current: TaskEvidence | null = null;
		try {
			current = readExisting(evidencePath, taskId);
		} catch (error) {
			telemetry.gateParseError(taskId, error as Error);
			throw error;
		}

		const persist = async (
			nextEvidence: TaskEvidence,
		): Promise<TaskEvidence> => {
			const validated = TaskEvidenceSchema.parse({
				...nextEvidence,
				taskId,
			});
			await atomicWriteFile(evidencePath, JSON.stringify(validated, null, 2));
			current = validated;
			return validated;
		};

		return callback({
			taskId,
			read: () => current,
			transition: async (event) => {
				assertTaskEvidenceWriteAllowed(directory, taskId, event);
				const nextEvidence = updateEvidenceForTransition(current, event);
				nextEvidence.taskId = taskId;
				return persist(nextEvidence);
			},
		});
	});
}

/**
 * Creates or updates .swarm/evidence/{taskId}.json with a gate pass entry.
 * If file doesn't exist: creates with required_gates from deriveRequiredGates(gate).
 * If file exists: merges gate entry, expands required_gates via expandRequiredGates.
 * Atomic write: temp file + rename.
 */
export async function recordGateEvidence(
	directory: string,
	taskId: string,
	gate: string,
	sessionId: string,
	turbo?: boolean,
	options: {
		expectedGeneration?: number;
		transitionId?: string;
		ensureDefaultStageB?: boolean;
	} = {},
): Promise<void> {
	assertValidTaskId(taskId);
	if (
		shouldTreatGateAsStageB(gate) &&
		typeof options.expectedGeneration !== 'number'
	) {
		throw new Error(
			`TASK_WORKFLOW_GENERATION_REQUIRED: ${gate} for task ${taskId} must be bound at dispatch`,
		);
	}

	await transitionTaskWorkflowEvidence(
		directory,
		taskId,
		shouldTreatGateAsStageB(gate)
			? {
					type: 'stage_b_completed',
					gate,
					sessionId,
					turbo,
					ensureDefaultStageB: options.ensureDefaultStageB,
					expectedGeneration: options.expectedGeneration as number,
					transitionId: options.transitionId,
				}
			: {
					type: 'gate_recorded',
					gate,
					sessionId,
					turbo,
					expectedGeneration: options.expectedGeneration,
					transitionId: options.transitionId,
				},
	);

	telemetry.gatePassed(sessionId, gate, taskId);
}

/**
 * Compatibility API for a settled non-gate dispatch. Coder callers represent
 * an accepted mutation and therefore rotate the workflow generation; mere
 * attempts must call `transitionTaskWorkflowEvidence(dispatch_attempted)` and
 * failed/no-op settlements must use `dispatch_no_mutation` instead.
 */
export async function recordAgentDispatch(
	directory: string,
	taskId: string,
	agentType: string,
	turbo?: boolean,
	context: GateDerivationContext = {},
): Promise<void> {
	assertValidTaskId(taskId);
	const expectedGeneration = getTaskWorkflowSnapshot(
		await readTaskEvidence(directory, taskId),
	).generation;

	await transitionTaskWorkflowEvidence(
		directory,
		taskId,
		agentType === 'coder'
			? {
					type: 'accepted_mutation',
					agentType,
					turbo,
					context,
					expectedGeneration,
				}
			: {
					type: 'dispatch_attempted',
					agentType,
					turbo,
					context,
					expectedGeneration,
				},
	);
}

/**
 * Returns the TaskEvidence for a task, or null if file missing or parse error.
 * Never throws.
 */
export async function readTaskEvidence(
	directory: string,
	taskId: string,
): Promise<TaskEvidence | null> {
	try {
		assertValidTaskId(taskId);
		return readExisting(getEvidencePath(directory, taskId), taskId);
	} catch {
		return null;
	}
}

/**
 * Returns the TaskEvidence for a task, or null if the file does not exist (ENOENT).
 * Throws on malformed JSON, permission errors, or other non-ENOENT issues.
 * Used by checkReviewerGate for evidence-first gate checking with proper error handling.
 */
export function readTaskEvidenceRaw(
	directory: string,
	taskId: string,
): TaskEvidence | null {
	assertValidTaskId(taskId);
	const evidencePath = getEvidencePath(directory, taskId);
	try {
		const raw = readFileSync(evidencePath, 'utf-8');
		return parseTaskEvidence(raw, taskId);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// ENOENT: no evidence file → fall through to session state.
		// ENAMETOOLONG: the taskId produces a filename exceeding the platform's
		// NAME_MAX (255 bytes on HFS+/APFS/ext4/NTFS). The file cannot exist,
		// so treat it as missing rather than corrupt (issue #1729: a 999-char
		// taskId was reported as "corrupt or unreadable" on macOS instead of
		// falling through to the session-state gate check).
		if (code === 'ENOENT' || code === 'ENAMETOOLONG') return null;
		throw error;
	}
}

/**
 * Returns true only when every required_gate has a matching gates entry.
 * Returns false if no evidence file exists.
 */
export async function hasPassedAllGates(
	directory: string,
	taskId: string,
): Promise<boolean> {
	const evidence = await readTaskEvidence(directory, taskId);
	if (!evidence) return false;
	if (
		!Array.isArray(evidence.required_gates) ||
		evidence.required_gates.length === 0
	)
		return false;
	return evidence.required_gates.every((gate) => evidence.gates[gate] != null);
}

export function compareTaskWorkflowStateRank(
	left: TaskWorkflowState,
	right: TaskWorkflowState,
): number {
	return WORKFLOW_STATE_RANK[left] - WORKFLOW_STATE_RANK[right];
}
