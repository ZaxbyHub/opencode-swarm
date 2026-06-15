import pLimit from 'p-limit';
import { z } from 'zod';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import {
	isKnownCanonicalRole,
	resolveGeneratedAgentRole,
} from '../config/schema.js';
import type { ParallelDispatcher } from '../parallel/dispatcher/parallel-dispatcher.js';
import { createParallelDispatcher } from '../parallel/dispatcher/parallel-dispatcher.js';
import { swarmState } from '../state.js';
import { createSwarmTool } from './create-tool.js';

const MAX_LANES = 8;
const MAX_PROMPT_CHARS = 80_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_LANE_OUTPUT_CHARS = 20_000;

const AGENT_NAME_SEPARATORS = ['_', '-', ' '] as const;

const READ_ONLY_LANE_ROLES: ReadonlySet<string> = new Set([
	'explorer',
	'reviewer',
	'critic',
	'critic_oversight',
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'sme',
	'researcher',
	'council_generalist',
	'council_skeptic',
	'council_domain_expert',
]);

const READ_ONLY_TOOL_DENYLIST = [
	...new Set([
		...WRITE_TOOL_NAMES,
		'extract_code_blocks',
		'multiedit',
		'multi_edit',
		'todo_write',
		'save_plan',
		'update_task_status',
		'phase_complete',
		'declare_scope',
		'declare_council_criteria',
		'submit_council_verdicts',
		'submit_phase_council_verdicts',
		'set_qa_gates',
		'write_retro',
		'write_drift_evidence',
		'write_hallucination_evidence',
		'write_mutation_evidence',
		'knowledge_add',
		'knowledge_remove',
	]),
] as const;

const LaneSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
		.describe('Stable lane identifier, unique within this dispatch batch'),
	agent: z
		.string()
		.min(1)
		.max(120)
		.describe(
			'Read-only swarm agent name, including any generated swarm prefix',
		),
	prompt: z
		.string()
		.min(1)
		.max(MAX_PROMPT_CHARS)
		.describe('Full lane prompt to send to the requested agent'),
});

const DispatchLanesArgsSchema = z.object({
	lanes: z
		.array(LaneSchema)
		.min(1)
		.max(MAX_LANES)
		.describe('Read-only lane specs to dispatch concurrently'),
	max_concurrent: z
		.number()
		.int()
		.min(1)
		.max(MAX_LANES)
		.optional()
		.describe('Maximum lanes in flight at once; defaults to lane count'),
	timeout_ms: z
		.number()
		.int()
		.min(10)
		.max(MAX_TIMEOUT_MS)
		.optional()
		.describe('Per-lane session create/prompt timeout in milliseconds'),
});

export type DispatchLaneSpec = z.infer<typeof LaneSchema>;
export type DispatchLanesArgs = z.infer<typeof DispatchLanesArgsSchema>;

export type DispatchLaneStatus = 'completed' | 'failed' | 'rejected';

export interface DispatchLaneResult {
	id: string;
	agent: string;
	role: string;
	status: DispatchLaneStatus;
	session_id?: string;
	slot_id?: string;
	run_id?: string;
	started_at: string;
	completed_at: string;
	output?: string;
	output_chars?: number;
	output_truncated?: boolean;
	error?: string;
}

export interface DispatchLanesResult {
	success: boolean;
	failure_class?: 'invalid_args' | 'no_client';
	message?: string;
	dispatched: number;
	completed: number;
	failed: number;
	rejected: number;
	max_concurrent: number;
	timeout_ms: number;
	lane_results: DispatchLaneResult[];
	errors?: string[];
}

export interface SessionOps {
	create(args: {
		query: { directory: string };
	}): Promise<{ data?: { id?: string } | null; error?: unknown }>;
	prompt(args: {
		path: { id: string };
		body: {
			agent: string;
			tools: ReadOnlyToolPermissions;
			parts: Array<{ type: 'text'; text: string }>;
		};
	}): Promise<{
		data?: { parts?: Array<{ type: string; text?: string }> } | null;
		error?: unknown;
	}>;
	delete(args: { path: { id: string } }): Promise<unknown>;
}

export const _internals: {
	getSessionOps: () => SessionOps | null;
	getGeneratedAgentNames: () => readonly string[];
	createParallelDispatcher: typeof createParallelDispatcher;
	now: () => number;
} = {
	getSessionOps: () =>
		(swarmState.opencodeClient?.session as unknown as SessionOps | undefined) ??
		null,
	getGeneratedAgentNames: () => swarmState.generatedAgentNames,
	createParallelDispatcher,
	now: () => Date.now(),
};

type ReadOnlyToolPermissions = Record<string, false> & {
	write: false;
	edit: false;
	patch: false;
};

interface DispatchLanesExecutionContext {
	callerAgent?: string;
}

export async function executeDispatchLanes(
	args: unknown,
	directory: string,
	context: DispatchLanesExecutionContext = {},
): Promise<DispatchLanesResult> {
	const parsed = DispatchLanesArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes arguments',
			errors: parsed.error.issues.map(
				(issue) => `${issue.path.join('.')}: ${issue.message}`,
			),
		});
	}

	const duplicateLaneIds = findDuplicateLaneIds(parsed.data.lanes);
	if (duplicateLaneIds.length > 0) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Lane IDs must be unique within one dispatch_lanes batch',
			errors: duplicateLaneIds.map((id) => `Duplicate lane id: ${id}`),
		});
	}

	const session = _internals.getSessionOps();
	if (!session) {
		return failureResult({
			failure_class: 'no_client',
			message: 'OpenCode session client is not available',
		});
	}

	const lanes = parsed.data.lanes;
	const maxConcurrent = Math.min(
		parsed.data.max_concurrent ?? lanes.length,
		lanes.length,
		MAX_LANES,
	);
	const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_TIMEOUT_MS;
	const dispatcher = _internals.createParallelDispatcher({
		enabled: true,
		maxConcurrentTasks: maxConcurrent,
		evidenceLockTimeoutMs: 0,
	});
	const limit = pLimit(maxConcurrent);

	try {
		const laneResults = await Promise.all(
			lanes.map((lane) =>
				limit(() =>
					runLane(session, dispatcher, lane, directory, timeoutMs, context),
				),
			),
		);
		return buildResult(laneResults, maxConcurrent, timeoutMs);
	} finally {
		dispatcher.shutdown();
	}
}

async function runLane(
	session: SessionOps,
	dispatcher: ParallelDispatcher,
	lane: DispatchLaneSpec,
	directory: string,
	timeoutMs: number,
	context: DispatchLanesExecutionContext,
): Promise<DispatchLaneResult> {
	const validation = validateLaneAgent(lane.agent, context);
	const role = validation.role;
	const startedAt = isoNow();
	if (!validation.ok) {
		return {
			id: lane.id,
			agent: lane.agent,
			role,
			status: 'rejected',
			started_at: startedAt,
			completed_at: isoNow(),
			error: validation.error,
		};
	}

	const decision = dispatcher.dispatch(lane.id);
	if (decision.action !== 'dispatch') {
		return {
			id: lane.id,
			agent: lane.agent,
			role,
			status: 'failed',
			started_at: startedAt,
			completed_at: isoNow(),
			error: `dispatcher ${decision.action}: ${decision.reason}`,
		};
	}

	let sessionId: string | undefined;
	try {
		const createTimeoutMessage = `Lane "${lane.id}" session.create timed out after ${timeoutMs}ms`;
		const createPromise = session.create({ query: { directory } });
		let createTimedOut = false;
		createPromise
			.then((createResult) => {
				if (createTimedOut && createResult.data?.id) {
					scheduleSessionCleanup(session, createResult.data.id);
				}
			})
			.catch(() => undefined);
		const createResult = await withTimeout(
			createPromise.catch((error) => {
				throw error;
			}),
			timeoutMs,
			createTimeoutMessage,
		).catch((error) => {
			if (formatError(error) === createTimeoutMessage) {
				createTimedOut = true;
			}
			throw error;
		});
		if (!createResult.data?.id) {
			return failedLane(
				lane,
				role,
				startedAt,
				`session.create failed: ${formatError(createResult.error)}`,
				decision.slot.slotId,
				decision.slot.runId,
			);
		}
		sessionId = createResult.data.id;

		const promptResult = await withTimeout(
			session.prompt({
				path: { id: sessionId },
				body: {
					agent: lane.agent,
					tools: buildReadOnlyTools(),
					parts: [{ type: 'text', text: lane.prompt }],
				},
			}),
			timeoutMs,
			`Lane "${lane.id}" session.prompt timed out after ${timeoutMs}ms`,
		);
		if (!promptResult.data) {
			return failedLane(
				lane,
				role,
				startedAt,
				`session.prompt failed: ${formatError(promptResult.error)}`,
				decision.slot.slotId,
				decision.slot.runId,
				sessionId,
			);
		}

		const boundedOutput = boundLaneOutput(extractText(promptResult.data.parts));
		return {
			id: lane.id,
			agent: lane.agent,
			role,
			status: 'completed',
			session_id: sessionId,
			slot_id: decision.slot.slotId,
			run_id: decision.slot.runId,
			started_at: startedAt,
			completed_at: isoNow(),
			...boundedOutput,
		};
	} catch (error) {
		return failedLane(
			lane,
			role,
			startedAt,
			formatError(error),
			decision.slot.slotId,
			decision.slot.runId,
			sessionId,
		);
	} finally {
		dispatcher.releaseSlot(decision.slot.slotId);
		if (sessionId) {
			scheduleSessionCleanup(session, sessionId);
		}
	}
}

function buildResult(
	laneResults: DispatchLaneResult[],
	maxConcurrent: number,
	timeoutMs: number,
): DispatchLanesResult {
	const completed = laneResults.filter((lane) => lane.status === 'completed');
	const failed = laneResults.filter((lane) => lane.status === 'failed');
	const rejected = laneResults.filter((lane) => lane.status === 'rejected');
	return {
		success: failed.length === 0 && rejected.length === 0,
		dispatched: laneResults.length,
		completed: completed.length,
		failed: failed.length,
		rejected: rejected.length,
		max_concurrent: maxConcurrent,
		timeout_ms: timeoutMs,
		lane_results: laneResults,
	};
}

function failedLane(
	lane: DispatchLaneSpec,
	role: string,
	startedAt: string,
	error: string,
	slotId?: string,
	runId?: string,
	sessionId?: string,
): DispatchLaneResult {
	return {
		id: lane.id,
		agent: lane.agent,
		role,
		status: 'failed',
		session_id: sessionId,
		slot_id: slotId,
		run_id: runId,
		started_at: startedAt,
		completed_at: isoNow(),
		error,
	};
}

function validateLaneAgent(
	agent: string,
	context: DispatchLanesExecutionContext,
): { ok: true; role: string } | { ok: false; role: string; error: string } {
	const generatedAgentNames = _internals.getGeneratedAgentNames();
	const role = resolveGeneratedAgentRole(agent, generatedAgentNames);
	if (!isKnownCanonicalRole(role)) {
		return {
			ok: false,
			role,
			error: `Agent "${agent}" is not registered as a generated swarm agent or canonical role`,
		};
	}
	if (!READ_ONLY_LANE_ROLES.has(role)) {
		return {
			ok: false,
			role,
			error: `Agent role "${role}" is not allowed for read-only lane dispatch`,
		};
	}

	const callerPrefix = context.callerAgent
		? getGeneratedAgentPrefix(context.callerAgent, generatedAgentNames)
		: null;
	if (callerPrefix) {
		const lanePrefix = getGeneratedAgentPrefix(agent, generatedAgentNames);
		if (lanePrefix !== callerPrefix) {
			return {
				ok: false,
				role,
				error: `Agent "${agent}" does not match caller swarm prefix "${callerPrefix}"`,
			};
		}
	}

	return { ok: true, role };
}

function getGeneratedAgentPrefix(
	agent: string,
	generatedAgentNames: readonly string[],
): string | null {
	const role = resolveGeneratedAgentRole(agent, generatedAgentNames);
	if (!isKnownCanonicalRole(role)) return null;
	const normalized = agent.toLowerCase();
	if (normalized === role) return null;
	for (const separator of AGENT_NAME_SEPARATORS) {
		const suffix = `${separator}${role}`;
		if (normalized.endsWith(suffix)) {
			return normalized.slice(0, -suffix.length);
		}
	}
	return null;
}

function buildReadOnlyTools(): ReadOnlyToolPermissions {
	const tools: Record<string, false> = {};
	for (const toolName of READ_ONLY_TOOL_DENYLIST) {
		tools[toolName] = false;
	}
	tools.write = false;
	tools.edit = false;
	tools.patch = false;
	return tools as ReadOnlyToolPermissions;
}

function boundLaneOutput(output: string): {
	output: string;
	output_chars: number;
	output_truncated: boolean;
} {
	if (output.length <= MAX_LANE_OUTPUT_CHARS) {
		return {
			output,
			output_chars: output.length,
			output_truncated: false,
		};
	}
	const omitted = output.length - MAX_LANE_OUTPUT_CHARS;
	return {
		output: `${output.slice(0, MAX_LANE_OUTPUT_CHARS)}\n[... ${omitted} chars truncated by dispatch_lanes ...]`,
		output_chars: output.length,
		output_truncated: true,
	};
}

function failureResult(args: {
	failure_class: 'invalid_args' | 'no_client';
	message: string;
	errors?: string[];
}): DispatchLanesResult {
	return {
		success: false,
		failure_class: args.failure_class,
		message: args.message,
		dispatched: 0,
		completed: 0,
		failed: 0,
		rejected: 0,
		max_concurrent: 0,
		timeout_ms: 0,
		lane_results: [],
		errors: args.errors,
	};
}

function findDuplicateLaneIds(lanes: DispatchLaneSpec[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const lane of lanes) {
		if (seen.has(lane.id)) duplicates.add(lane.id);
		seen.add(lane.id);
	}
	return [...duplicates];
}

function scheduleSessionCleanup(session: SessionOps, sessionId: string): void {
	void session.delete({ path: { id: sessionId } }).catch(() => undefined);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function extractText(
	parts: Array<{ type: string; text?: string }> | undefined,
): string {
	if (!Array.isArray(parts)) return '';
	return parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n');
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function isoNow(): string {
	return new Date(_internals.now()).toISOString();
}

export const dispatch_lanes: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Dispatch multiple read-only exploration/review lanes concurrently through OpenCode sessions and return a structured join result.',
		args: {
			lanes: DispatchLanesArgsSchema.shape.lanes,
			max_concurrent: DispatchLanesArgsSchema.shape.max_concurrent,
			timeout_ms: DispatchLanesArgsSchema.shape.timeout_ms,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeDispatchLanes(args, directory, {
				callerAgent: getContextAgent(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

function getContextAgent(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).agent;
	return typeof value === 'string' ? value : undefined;
}
