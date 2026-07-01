import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { z } from 'zod';
import {
	buildLaneOutputPreview,
	storeLaneOutput,
} from '../background/lane-output-store.js';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	findByBatchId,
	recordPendingDelegation,
} from '../background/pending-delegations.js';
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
export const MAX_PROMPT_CHARS = 80_000;
const COMMON_PROMPT_SEPARATOR = '\n\n';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_LANE_OUTPUT_CHARS = 20_000;
const ASYNC_MESSAGE_FETCH_LIMIT = 50;
const MAX_ERROR_CHARS = 200;
const ERROR_TRUNCATION_SUFFIX = '...';
const MAX_BATCH_ID_CHARS = 120;
const DEFAULT_ASYNC_STALE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COLLECT_TIMEOUT_MS = DEFAULT_ASYNC_STALE_TIMEOUT_MS;
const MAX_COLLECT_TIMEOUT_MS = 60 * 60_000;
const COLLECT_POLL_INTERVAL_MS = 500;
const MAX_COLLECT_POLL_INTERVAL_MS = 10_000;

const AGENT_NAME_SEPARATORS = ['_', '-', ' '] as const;

const EXPLORER_CANDIDATE_FORMAT_SUFFIX = `

IMPORTANT — OUTPUT FORMAT REQUIREMENT:
You MUST emit your findings as pipe-delimited [CANDIDATE] rows.
Header row first, then one row per finding.

Standard explorer format (use unless the prompt specifies micro-lane work):
[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence

Micro-lane format (use when the prompt references invariant checking or micro_lane):
[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence

If you find zero issues, emit only the header row with no data rows.
Do NOT use the default PROJECT/STRUCTURE output format for this dispatch.`;

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
		'summarize_work',
		'doc_scan',
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
	common_prompt: z
		.string()
		.min(1)
		// Must carry real content: a whitespace-only value would prepend a blank
		// prefix + separator to every lane prompt without adding any context.
		.regex(/\S/, 'common_prompt must contain non-whitespace content')
		// Reserve room for the separator + at least 1 char of lane prompt so any
		// schema-valid common_prompt can coexist with the shortest valid lane
		// prompt without the combined length exceeding MAX_PROMPT_CHARS.
		.max(MAX_PROMPT_CHARS - COMMON_PROMPT_SEPARATOR.length - 1)
		.optional()
		.describe(
			'Optional shared context prepended to every lane prompt. Send large shared context (PR diff, obligation ledger, scope) ONCE here instead of inlining the same blob into each lane prompt; this keeps the tool-call payload small and avoids malformed/truncated tool-call JSON. Combined common_prompt + per-lane prompt must not exceed the per-lane character limit.',
		),
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
		.describe(
			'Per-lane timeout in milliseconds. For blocking dispatch this covers session create and prompt execution; for async dispatch this covers launch only, never lane runtime.',
		),
});

const DispatchLanesAsyncArgsSchema = DispatchLanesArgsSchema.extend({
	launch_timeout_ms: z
		.number()
		.int()
		.min(10)
		.max(MAX_TIMEOUT_MS)
		.optional()
		.describe(
			'Async launch acceptance timeout in milliseconds. This only bounds session creation and promptAsync acceptance; it is never a lane runtime timeout. Deprecated alias: timeout_ms.',
		),
	batch_id: z
		.string()
		.min(1)
		.max(MAX_BATCH_ID_CHARS)
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
		.optional()
		.describe(
			'Stable async batch id for later collection; generated when omitted',
		),
	mode: z
		.string()
		.min(1)
		.max(80)
		.optional()
		.describe('Advisory workflow mode, such as deep-dive or swarm-pr-review'),
	pr_head_sha: z.string().min(1).max(80).optional(),
	scope: z.string().min(1).max(500).optional(),
});

const CollectLaneResultsArgsSchema = z.object({
	batch_id: z.string().min(1).max(MAX_BATCH_ID_CHARS),
	wait: z
		.boolean()
		.optional()
		.describe('Poll until all lanes settle or timeout'),
	timeout_ms: z
		.number()
		.int()
		.min(0)
		.max(MAX_COLLECT_TIMEOUT_MS)
		.optional()
		.describe('Total wait budget when wait=true'),
	include_pending: z
		.boolean()
		.optional()
		.describe(
			'Include pending/running lanes in lane_results. Defaults to true for non-blocking polls and false for wait=true joins.',
		),
	cancel_pending: z
		.boolean()
		.optional()
		.describe('Abort and mark pending/running lanes cancelled'),
});

export type DispatchLaneSpec = z.infer<typeof LaneSchema>;
export type DispatchLanesArgs = z.infer<typeof DispatchLanesArgsSchema>;
export type DispatchLanesAsyncArgs = z.infer<
	typeof DispatchLanesAsyncArgsSchema
>;
export type CollectLaneResultsArgs = z.infer<
	typeof CollectLaneResultsArgsSchema
>;

export type DispatchLaneStatus =
	| 'pending'
	| 'completed'
	| 'failed'
	| 'rejected'
	| 'cancelled'
	| 'stale'
	| 'consumed';

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
	output_ref?: string;
	output_digest?: string;
	output_preview_chars?: number;
	output_degraded?: boolean;
	output_artifact_error?: string;
	transcript_incomplete?: boolean;
	message_count?: number;
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

export interface DispatchLanesAsyncResult {
	success: boolean;
	failure_class?: 'invalid_args' | 'no_client';
	message?: string;
	batch_id: string | null;
	dispatched: number;
	pending: number;
	failed: number;
	rejected: number;
	max_concurrent: number;
	launch_timeout_ms: number;
	/** Deprecated alias for launch_timeout_ms; retained for existing callers. */
	timeout_ms: number;
	lane_results: DispatchLaneResult[];
	errors?: string[];
}

export interface CollectLaneResultsResult {
	success: boolean;
	failure_class?: 'invalid_args' | 'not_found' | 'no_client';
	message?: string;
	batch_id: string;
	total: number;
	completed: number;
	failed: number;
	cancelled: number;
	stale: number;
	pending: number;
	consumed: number;
	all_settled: boolean;
	lane_results: DispatchLaneResult[];
	errors?: string[];
}

export interface SessionOps {
	create(args: {
		body?: { parentID?: string; title?: string };
		query: { directory: string };
	}): Promise<{ data?: { id?: string } | null; error?: unknown }>;
	prompt(args: {
		path: { id: string };
		body: {
			agent: string;
			tools: ReadOnlyToolPermissions;
			parts: Array<{ type: 'text'; text: string }>;
		};
		signal?: AbortSignal;
	}): Promise<{
		data?: { parts?: Array<{ type: string; text?: string }> } | null;
		error?: unknown;
	}>;
	promptAsync?: (args: {
		path: { id: string };
		query?: { directory?: string };
		body: {
			agent: string;
			tools: ReadOnlyToolPermissions;
			parts: Array<{ type: 'text'; text: string }>;
		};
		signal?: AbortSignal;
	}) => Promise<{ data?: unknown; error?: unknown }>;
	messages?: (args: {
		path: { id: string };
		query?: { directory?: string; limit?: number };
	}) => Promise<{
		data?: Array<{
			info?: { role?: string };
			parts?: Array<{ type: string; text?: string }>;
		}> | null;
		error?: unknown;
	}>;
	status?: (args: { query?: { directory?: string } }) => Promise<{
		data?: Record<string, { type?: string }> | null;
		error?: unknown;
	}>;
	abort?: (args: { path: { id: string } }) => Promise<unknown>;
	delete(args: { path: { id: string } }): Promise<unknown>;
}

export const _internals: {
	getSessionOps: () => SessionOps | null;
	getGeneratedAgentNames: () => readonly string[];
	createParallelDispatcher: typeof createParallelDispatcher;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
} = {
	getSessionOps: () =>
		(swarmState.opencodeClient?.session as unknown as SessionOps | undefined) ??
		null,
	getGeneratedAgentNames: () => swarmState.generatedAgentNames,
	createParallelDispatcher,
	now: () => Date.now(),
	sleep,
};

export const _test_exports = {
	applyCommonPrompt,
	applyExplorerFormatSuffix,
	buildLaneSessionCreateArgs,
	extractAssistantTranscript,
	formatError,
	nextCollectPollInterval,
	promptHash,
	DispatchLanesArgsSchema,
	DispatchLanesAsyncArgsSchema,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
	DEFAULT_ASYNC_STALE_TIMEOUT_MS,
	DEFAULT_COLLECT_TIMEOUT_MS,
};

type ReadOnlyToolPermissions = Record<string, false> & {
	write: false;
	edit: false;
	patch: false;
};

interface DispatchLanesExecutionContext {
	callerAgent?: string;
	sessionID?: string;
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

	const common = applyCommonPrompt(
		parsed.data.lanes,
		parsed.data.common_prompt,
	);
	if (!common.ok) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes arguments',
			errors: common.errors,
		});
	}
	const lanes = applyExplorerFormatSuffix(common.lanes);
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

export async function executeDispatchLanesAsync(
	args: unknown,
	directory: string,
	context: DispatchLanesExecutionContext = {},
): Promise<DispatchLanesAsyncResult> {
	const parsed = DispatchLanesAsyncArgsSchema.safeParse(args);
	if (!parsed.success) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes_async arguments',
			errors: parsed.error.issues.map(
				(issue) => `${issue.path.join('.')}: ${issue.message}`,
			),
		});
	}

	const duplicateLaneIds = findDuplicateLaneIds(parsed.data.lanes);
	if (duplicateLaneIds.length > 0) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Lane IDs must be unique within one dispatch_lanes_async batch',
			errors: duplicateLaneIds.map((id) => `Duplicate lane id: ${id}`),
		});
	}

	const session = _internals.getSessionOps();
	if (!session || typeof session.promptAsync !== 'function') {
		return asyncFailureResult({
			failure_class: 'no_client',
			message: 'OpenCode session promptAsync client is not available',
		});
	}

	const common = applyCommonPrompt(
		parsed.data.lanes,
		parsed.data.common_prompt,
	);
	if (!common.ok) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes_async arguments',
			errors: common.errors,
		});
	}
	const lanes = applyExplorerFormatSuffix(common.lanes);
	const batchId = parsed.data.batch_id ?? makeBatchId();
	if (findByBatchId(directory, batchId).length > 0) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: `Async lane batch already exists: ${batchId}`,
			errors: [`batch_id must be unique: ${batchId}`],
		});
	}
	const maxConcurrent = Math.min(
		parsed.data.max_concurrent ?? lanes.length,
		lanes.length,
		MAX_LANES,
	);
	const launchTimeoutMs =
		parsed.data.launch_timeout_ms ??
		parsed.data.timeout_ms ??
		DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS;
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
					launchAsyncLane({
						session,
						dispatcher,
						lane,
						directory,
						timeoutMs: launchTimeoutMs,
						context,
						batchId,
						mode: parsed.data.mode,
						prHeadSha: parsed.data.pr_head_sha,
						scope: parsed.data.scope,
					}),
				),
			),
		);
		const failed = laneResults.filter((lane) => lane.status === 'failed');
		const rejected = laneResults.filter((lane) => lane.status === 'rejected');
		const pending = laneResults.filter((lane) => lane.status === 'pending');
		return {
			success: failed.length === 0 && rejected.length === 0,
			batch_id: batchId,
			dispatched: laneResults.length,
			pending: pending.length,
			failed: failed.length,
			rejected: rejected.length,
			max_concurrent: maxConcurrent,
			launch_timeout_ms: launchTimeoutMs,
			timeout_ms: launchTimeoutMs,
			lane_results: laneResults,
		};
	} finally {
		dispatcher.shutdown();
	}
}

export async function executeCollectLaneResults(
	args: unknown,
	directory: string,
	context: Pick<DispatchLanesExecutionContext, 'sessionID'> = {},
): Promise<CollectLaneResultsResult> {
	const parsed = CollectLaneResultsArgsSchema.safeParse(args);
	if (!parsed.success) {
		return collectFailureResult({
			failure_class: 'invalid_args',
			batch_id: '',
			message: 'Invalid collect_lane_results arguments',
			errors: parsed.error.issues.map(
				(issue) => `${issue.path.join('.')}: ${issue.message}`,
			),
		});
	}
	const session = _internals.getSessionOps();
	if (!session || typeof session.messages !== 'function') {
		return collectFailureResult({
			failure_class: 'no_client',
			batch_id: parsed.data.batch_id,
			message: 'OpenCode session messages client is not available',
		});
	}
	const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_COLLECT_TIMEOUT_MS;
	const deadline = _internals.now() + timeoutMs;
	const batchFilter =
		context.sessionID !== undefined
			? { parentSessionId: context.sessionID }
			: undefined;
	let records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
	if (records.length === 0) {
		return collectFailureResult({
			failure_class: 'not_found',
			batch_id: parsed.data.batch_id,
			message: `No async lane batch found for ${parsed.data.batch_id}`,
		});
	}

	let keepPolling = true;
	let pollIntervalMs = COLLECT_POLL_INTERVAL_MS;
	while (keepPolling) {
		await collectOnce(
			session,
			directory,
			records,
			parsed.data.cancel_pending === true,
		);
		await sweepStaleAsyncLaneRecords(
			session,
			directory,
			records,
			DEFAULT_ASYNC_STALE_TIMEOUT_MS,
		);
		records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
		if (allSettled(records) || parsed.data.wait !== true) {
			keepPolling = false;
			continue;
		}
		if (_internals.now() >= deadline) {
			keepPolling = false;
			continue;
		}
		await _internals.sleep(
			Math.min(pollIntervalMs, Math.max(0, deadline - _internals.now())),
		);
		pollIntervalMs = nextCollectPollInterval(pollIntervalMs);
	}

	return buildCollectResult(
		parsed.data.batch_id,
		records,
		parsed.data.include_pending ?? parsed.data.wait !== true,
	);
}

async function launchAsyncLane(args: {
	session: SessionOps;
	dispatcher: ParallelDispatcher;
	lane: DispatchLaneSpec;
	directory: string;
	timeoutMs: number;
	context: DispatchLanesExecutionContext;
	batchId: string;
	mode?: string;
	prHeadSha?: string;
	scope?: string;
}): Promise<DispatchLaneResult> {
	const validation = validateLaneAgent(args.lane.agent, args.context);
	const role = validation.role;
	const startedAt = isoNow();
	if (!validation.ok) {
		return {
			id: args.lane.id,
			agent: args.lane.agent,
			role,
			status: 'rejected',
			started_at: startedAt,
			completed_at: isoNow(),
			error: validation.error,
		};
	}
	const decision = args.dispatcher.dispatch(args.lane.id);
	if (decision.action !== 'dispatch') {
		return {
			id: args.lane.id,
			agent: args.lane.agent,
			role,
			status: 'failed',
			started_at: startedAt,
			completed_at: isoNow(),
			error: `dispatcher ${decision.action}: ${decision.reason}`,
		};
	}
	try {
		const createTimeoutMessage = `Lane "${args.lane.id}" session.create timed out after ${args.timeoutMs}ms`;
		const createPromise = args.session.create(
			buildLaneSessionCreateArgs(args.directory, args.lane, args.context),
		);
		let createTimedOut = false;
		createPromise
			.then((createResult) => {
				if (createTimedOut && createResult.data?.id) {
					scheduleSessionCleanup(args.session, createResult.data.id);
				}
			})
			.catch(() => undefined);
		const createResult = await withTimeout(
			createPromise,
			args.timeoutMs,
			createTimeoutMessage,
		).catch((error) => {
			if (formatError(error) === createTimeoutMessage) {
				createTimedOut = true;
			}
			throw error;
		});
		const sessionId = createResult.data?.id;
		if (!sessionId) {
			return failedLane(
				args.lane,
				role,
				startedAt,
				`session.create failed: ${formatError(createResult.error)}`,
				decision.slot.slotId,
				decision.slot.runId,
			);
		}

		const pendingRecord = await recordPendingDelegation(args.directory, {
			correlationId: sessionId,
			jobId: null,
			subagentSessionId: sessionId,
			parentSessionId:
				args.context.sessionID ?? `dispatch_lanes_async:${args.batchId}`,
			callID: args.batchId,
			normalizedAgent: role,
			swarmPrefixedAgent: args.lane.agent,
			planTaskId: null,
			evidenceTaskId: null,
			batchId: args.batchId,
			laneId: args.lane.id,
			mode: args.mode ?? 'advisory',
			promptHash: promptHash(args.lane, args.directory, args.batchId),
			workspace: {
				directory: args.directory,
				gitHead: null,
				dirtyHash: null,
				prHeadSha: args.prHeadSha ?? null,
				scope: args.scope ?? null,
			},
			generation: 1,
		});
		if (!pendingRecord) {
			cleanupAsyncLaunchSession(args.session, sessionId);
			return failedLane(
				args.lane,
				role,
				startedAt,
				'Failed to record async lane in background delegation ledger',
				decision.slot.slotId,
				decision.slot.runId,
			);
		}

		scheduleAsyncLanePrompt({
			session: args.session,
			directory: args.directory,
			sessionId,
			lane: args.lane,
			timeoutMs: args.timeoutMs,
		});

		return {
			id: args.lane.id,
			agent: args.lane.agent,
			role,
			status: 'pending',
			session_id: sessionId,
			slot_id: decision.slot.slotId,
			run_id: decision.slot.runId,
			started_at: startedAt,
			completed_at: isoNow(),
		};
	} catch (error) {
		return failedLane(
			args.lane,
			role,
			startedAt,
			formatError(error),
			decision.slot.slotId,
			decision.slot.runId,
		);
	} finally {
		args.dispatcher.releaseSlot(decision.slot.slotId);
	}
}

async function collectOnce(
	session: SessionOps,
	directory: string,
	records: BackgroundDelegationRecord[],
	cancelPending: boolean,
): Promise<void> {
	for (const record of records) {
		if (record.status !== 'pending' && record.status !== 'running') continue;
		if (cancelPending) {
			if (typeof session.abort === 'function') {
				await session
					.abort({ path: { id: record.subagentSessionId } })
					.catch(() => undefined);
			}
			await appendDelegationTransition(directory, record.correlationId, {
				status: 'cancelled',
			});
			continue;
		}
		const readyForCollection = await isLaneReadyForCollection(
			session,
			directory,
			record.subagentSessionId,
		);
		if (!readyForCollection) continue;
		let messages: Awaited<ReturnType<NonNullable<SessionOps['messages']>>>;
		try {
			messages = await session.messages!({
				path: { id: record.subagentSessionId },
				query: { directory, limit: ASYNC_MESSAGE_FETCH_LIMIT },
			});
		} catch {
			continue;
		}
		if (!messages.data) continue;
		const transcript = extractAssistantTranscript(messages.data);
		if (!transcript.text) continue;
		const output = prepareLaneOutput({
			directory,
			batchId: record.batchId ?? record.callID,
			laneId: record.laneId ?? record.correlationId,
			agent: record.swarmPrefixedAgent,
			role: record.normalizedAgent,
			sessionId: record.subagentSessionId,
			parentSessionId: record.parentSessionId,
			mode: record.mode,
			source: 'collect_lane_results',
			text: transcript.text,
			messageCount: transcript.messageCount,
			transcriptIncomplete: transcript.transcriptIncomplete,
		});
		await appendDelegationTransition(directory, record.correlationId, {
			status: 'completed',
			result: {
				text: output.output,
				chars: output.output_chars,
				truncated: output.output_truncated,
				digest: output.output_digest,
				...(output.output_ref ? { outputRef: output.output_ref } : {}),
				outputPreviewChars: output.output.length,
				...(output.output_degraded !== undefined
					? { outputDegraded: output.output_degraded }
					: {}),
				...(output.output_artifact_error
					? { outputArtifactError: output.output_artifact_error }
					: {}),
				...(output.transcript_incomplete !== undefined
					? { transcriptIncomplete: output.transcript_incomplete }
					: {}),
				messageCount: transcript.messageCount,
			},
		});
	}
}

function scheduleAsyncLanePrompt(args: {
	session: SessionOps;
	directory: string;
	sessionId: string;
	lane: DispatchLaneSpec;
	timeoutMs: number;
}): void {
	queueMicrotask(() => {
		void startAsyncLanePrompt(args).catch(async (error) => {
			const message = formatError(error);
			await appendAsyncLaneLaunchError(
				args.directory,
				args.session,
				args.sessionId,
				message,
			);
		});
	});
}

async function startAsyncLanePrompt(args: {
	session: SessionOps;
	directory: string;
	sessionId: string;
	lane: DispatchLaneSpec;
	timeoutMs: number;
}): Promise<void> {
	const promptController = new AbortController();
	let promptResult: { data?: unknown; error?: unknown };
	try {
		promptResult = await withTimeout(
			args.session.promptAsync!({
				path: { id: args.sessionId },
				query: { directory: args.directory },
				body: {
					agent: args.lane.agent,
					tools: buildReadOnlyTools(),
					parts: [{ type: 'text', text: args.lane.prompt }],
				},
				signal: promptController.signal,
			}),
			args.timeoutMs,
			`Lane "${args.lane.id}" session.promptAsync launch timed out after ${args.timeoutMs}ms`,
			promptController,
		);
	} catch (error) {
		await appendAsyncLaneLaunchError(
			args.directory,
			args.session,
			args.sessionId,
			formatError(error),
		);
		return;
	}
	if (promptResult.error) {
		await appendAsyncLaneLaunchError(
			args.directory,
			args.session,
			args.sessionId,
			`session.promptAsync launch failed: ${formatError(promptResult.error)}`,
		);
		return;
	}
	await appendDelegationTransition(args.directory, args.sessionId, {
		status: 'running',
	});
}

async function appendAsyncLaneLaunchError(
	directory: string,
	session: SessionOps,
	sessionId: string,
	message: string,
): Promise<void> {
	await appendDelegationTransition(directory, sessionId, {
		status: 'error',
		result: {
			error: message,
			chars: message.length,
			truncated: false,
			digest: digestText(message),
		},
	});
	cleanupAsyncLaunchSession(session, sessionId);
}

async function isLaneReadyForCollection(
	session: SessionOps,
	directory: string,
	sessionId: string,
): Promise<boolean> {
	if (typeof session.status !== 'function') return true;
	try {
		const status = await session.status({ query: { directory } });
		if (status.error || !status.data) return false;
		const current = status.data[sessionId];
		return current === undefined || current.type === 'idle';
	} catch {
		return false;
	}
}

async function sweepStaleAsyncLaneRecords(
	session: SessionOps,
	directory: string,
	records: BackgroundDelegationRecord[],
	staleTimeoutMs: number,
): Promise<void> {
	if (staleTimeoutMs <= 0) return;
	const now = _internals.now();
	for (const record of records) {
		if (
			record.status !== 'pending' &&
			record.status !== 'running' &&
			record.status !== 'ingestion_error'
		)
			continue;
		if (now - record.updatedAt <= staleTimeoutMs) continue;
		const readyForCollection = await isLaneReadyForCollection(
			session,
			directory,
			record.subagentSessionId,
		);
		if (!readyForCollection) continue;
		await appendDelegationTransition(directory, record.correlationId, {
			status: 'stale',
		});
	}
}

function extractAssistantTranscript(
	messages: Array<{
		info?: { role?: string };
		parts?: Array<{ type: string; text?: string }>;
	}>,
): { text: string; messageCount: number; transcriptIncomplete: boolean } {
	const assistantTexts: string[] = [];
	for (const message of messages) {
		if (message.info?.role !== 'assistant') continue;
		const text = extractText(message.parts);
		if (text.trim().length > 0) assistantTexts.push(text);
	}
	return {
		text: assistantTexts.join('\n\n'),
		messageCount: assistantTexts.length,
		// Total message count (not just assistant) is the correct signal: the API
		// limit is applied to all message types, so hitting it means there may be
		// earlier messages of any role — including assistant — that were not fetched.
		transcriptIncomplete: messages.length >= ASYNC_MESSAGE_FETCH_LIMIT,
	};
}

function nextCollectPollInterval(currentMs: number): number {
	if (currentMs <= 0) return COLLECT_POLL_INTERVAL_MS;
	return Math.min(currentMs * 2, MAX_COLLECT_POLL_INTERVAL_MS);
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

	const promptController = new AbortController();
	let sessionId: string | undefined;
	try {
		const createTimeoutMessage = `Lane "${lane.id}" session.create timed out after ${timeoutMs}ms`;
		const createPromise = session.create(
			buildLaneSessionCreateArgs(directory, lane, context),
		);
		let createTimedOut = false;
		createPromise
			.then((createResult) => {
				if (createTimedOut && createResult.data?.id) {
					scheduleSessionCleanup(session, createResult.data.id);
				}
			})
			.catch(() => undefined);
		const createResult = await withTimeout(
			createPromise,
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
				signal: promptController.signal,
			}),
			timeoutMs,
			`Lane "${lane.id}" session.prompt timed out after ${timeoutMs}ms`,
			promptController,
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

		const laneOutput = prepareLaneOutput({
			directory,
			batchId: `blocking:${sessionId}`,
			laneId: lane.id,
			agent: lane.agent,
			role,
			sessionId,
			parentSessionId: context.sessionID,
			source: 'dispatch_lanes',
			text: extractText(promptResult.data.parts),
		});
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
			...laneOutput,
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
		promptController.abort();
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

function buildCollectResult(
	batchId: string,
	records: BackgroundDelegationRecord[],
	includePending: boolean,
): CollectLaneResultsResult {
	const laneResults = records
		.filter(
			(record) =>
				includePending ||
				(record.status !== 'pending' && record.status !== 'running'),
		)
		.map(recordToLaneResult);
	const completed = records.filter((record) => record.status === 'completed');
	const failed = records.filter(
		(record) =>
			record.status === 'error' || record.status === 'ingestion_error',
	);
	const cancelled = records.filter((record) => record.status === 'cancelled');
	const stale = records.filter((record) => record.status === 'stale');
	const pending = records.filter(
		(record) => record.status === 'pending' || record.status === 'running',
	);
	const consumed = records.filter((record) => record.status === 'consumed');
	return {
		success:
			pending.length === 0 &&
			failed.length === 0 &&
			cancelled.length === 0 &&
			stale.length === 0,
		batch_id: batchId,
		total: records.length,
		completed: completed.length,
		failed: failed.length,
		cancelled: cancelled.length,
		stale: stale.length,
		pending: pending.length,
		consumed: consumed.length,
		all_settled: pending.length === 0,
		lane_results: laneResults,
	};
}

function recordToLaneResult(
	record: BackgroundDelegationRecord,
): DispatchLaneResult {
	const status =
		record.status === 'error'
			? 'failed'
			: record.status === 'ingestion_error'
				? 'failed'
				: record.status === 'running'
					? 'pending'
					: record.status;
	return {
		id: record.laneId ?? record.correlationId,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		status,
		session_id: record.subagentSessionId,
		started_at: new Date(record.createdAt).toISOString(),
		completed_at: new Date(
			record.completedAt ?? record.updatedAt,
		).toISOString(),
		...(record.result?.text !== undefined
			? {
					output: record.result.text,
					output_chars: record.result.chars,
					output_truncated: record.result.truncated,
					output_digest: record.result.digest,
					...(record.result.outputRef
						? { output_ref: record.result.outputRef }
						: {}),
					...(record.result.outputPreviewChars !== undefined
						? { output_preview_chars: record.result.outputPreviewChars }
						: {}),
					...(record.result.outputDegraded !== undefined
						? { output_degraded: record.result.outputDegraded }
						: {}),
					...(record.result.outputArtifactError
						? { output_artifact_error: record.result.outputArtifactError }
						: {}),
					...(record.result.transcriptIncomplete !== undefined
						? { transcript_incomplete: record.result.transcriptIncomplete }
						: {}),
					...(record.result.messageCount !== undefined
						? { message_count: record.result.messageCount }
						: {}),
				}
			: {}),
		...(record.result?.error !== undefined
			? { error: record.result.error }
			: {}),
	};
}

function allSettled(records: BackgroundDelegationRecord[]): boolean {
	return records.every(
		(record) => record.status !== 'pending' && record.status !== 'running',
	);
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

function prepareLaneOutput(args: {
	directory: string;
	batchId: string;
	laneId: string;
	agent: string;
	role: string;
	sessionId?: string;
	parentSessionId?: string;
	mode?: string;
	source: 'dispatch_lanes' | 'collect_lane_results';
	text: string;
	messageCount?: number;
	transcriptIncomplete?: boolean;
}): {
	output: string;
	output_chars: number;
	output_truncated: boolean;
	output_ref?: string;
	output_digest: string;
	output_preview_chars: number;
	output_degraded?: boolean;
	output_artifact_error?: string;
	transcript_incomplete?: boolean;
	message_count?: number;
} {
	const stored = storeLaneOutput(args.directory, {
		batchId: args.batchId,
		laneId: args.laneId,
		agent: args.agent,
		role: args.role,
		sessionId: args.sessionId,
		parentSessionId: args.parentSessionId,
		mode: args.mode,
		source: args.source,
		text: args.text,
		messageCount: args.messageCount,
		transcriptIncomplete: args.transcriptIncomplete,
	});
	const preview = buildLaneOutputPreview({
		text: args.text,
		ref: stored.ref,
		degraded: stored.degraded,
		maxChars: MAX_LANE_OUTPUT_CHARS,
	});
	return {
		...preview,
		output_ref: stored.ref,
		output_digest: stored.digest,
		output_preview_chars: preview.output.length,
		...(stored.degraded ? { output_degraded: true } : {}),
		...(stored.error ? { output_artifact_error: stored.error } : {}),
		...(args.transcriptIncomplete !== undefined
			? { transcript_incomplete: args.transcriptIncomplete }
			: {}),
		...(args.messageCount !== undefined
			? { message_count: args.messageCount }
			: {}),
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

function asyncFailureResult(args: {
	failure_class: 'invalid_args' | 'no_client';
	message: string;
	errors?: string[];
}): DispatchLanesAsyncResult {
	return {
		success: false,
		failure_class: args.failure_class,
		message: args.message,
		batch_id: null,
		dispatched: 0,
		pending: 0,
		failed: 0,
		rejected: 0,
		max_concurrent: 0,
		launch_timeout_ms: 0,
		timeout_ms: 0,
		lane_results: [],
		errors: args.errors,
	};
}

function collectFailureResult(args: {
	failure_class: 'invalid_args' | 'not_found' | 'no_client';
	batch_id: string;
	message: string;
	errors?: string[];
}): CollectLaneResultsResult {
	return {
		success: false,
		failure_class: args.failure_class,
		message: args.message,
		batch_id: args.batch_id,
		total: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		stale: 0,
		pending: 0,
		consumed: 0,
		all_settled: false,
		lane_results: [],
		errors: args.errors,
	};
}

type ApplyCommonPromptResult =
	| { ok: true; lanes: DispatchLaneSpec[] }
	| { ok: false; errors: string[] };

/**
 * Prepend an optional shared `common_prompt` to every lane prompt so callers can
 * send large shared context once instead of inlining it into each lane (which
 * bloats the tool-call payload and triggers truncated/malformed tool-call JSON).
 * Returns an error when any assembled prompt exceeds the per-lane character limit.
 *
 * Always returns a fresh array the caller owns: a shallow copy of the originals
 * when no `commonPrompt` is provided, or shallow-copied lanes with rewritten
 * prompts when it is. Callers may treat the returned array as their own.
 */
function applyCommonPrompt(
	lanes: DispatchLaneSpec[],
	commonPrompt: string | undefined,
): ApplyCommonPromptResult {
	if (!commonPrompt) return { ok: true, lanes: [...lanes] };
	const errors: string[] = [];
	const merged = lanes.map((lane) => {
		const prompt = `${commonPrompt}${COMMON_PROMPT_SEPARATOR}${lane.prompt}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			errors.push(
				`Lane "${lane.id}" combined common_prompt + prompt is ${prompt.length} chars ` +
					`(common_prompt ${commonPrompt.length} + separator ${COMMON_PROMPT_SEPARATOR.length} + ` +
					`lane prompt ${lane.prompt.length}; max ${MAX_PROMPT_CHARS})`,
			);
		}
		return { ...lane, prompt };
	});
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, lanes: merged };
}

function applyExplorerFormatSuffix(
	lanes: DispatchLaneSpec[],
): DispatchLaneSpec[] {
	const generatedAgentNames = _internals.getGeneratedAgentNames();
	return lanes.map((lane) => {
		const role = resolveGeneratedAgentRole(lane.agent, generatedAgentNames);
		if (role !== 'explorer') return lane;
		if (lane.prompt.includes('[CANDIDATE]')) return lane;
		const prompt = `${lane.prompt}${EXPLORER_CANDIDATE_FORMAT_SUFFIX}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			console.warn(
				`[dispatch-lanes] applyExplorerFormatSuffix: lane "${lane.id}" prompt too long ` +
					`(${lane.prompt.length} chars + suffix = ${prompt.length}, max ${MAX_PROMPT_CHARS}); ` +
					`format enforcement skipped — explorer may not emit [CANDIDATE] rows`,
			);
			return lane;
		}
		return { ...lane, prompt };
	});
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

function cleanupAsyncLaunchSession(
	session: SessionOps,
	sessionId: string,
): void {
	if (typeof session.abort === 'function') {
		void session.abort({ path: { id: sessionId } }).catch(() => undefined);
	}
	scheduleSessionCleanup(session, sessionId);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	controller?: AbortController,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					controller?.abort();
					reject(new Error(message));
				}, timeoutMs);
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
	const text = typeof error === 'string' ? error : String(error);
	return boundErrorString(text);
}

function boundErrorString(text: string): string {
	if (text.length <= MAX_ERROR_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_CHARS)}${ERROR_TRUNCATION_SUFFIX}`;
}

function isoNow(): string {
	return new Date(_internals.now()).toISOString();
}

function buildLaneSessionCreateArgs(
	directory: string,
	lane: DispatchLaneSpec,
	context: Pick<DispatchLanesExecutionContext, 'sessionID'>,
): {
	body: { parentID?: string; title: string };
	query: { directory: string };
} {
	const parentID = context.sessionID?.trim();
	// Escape parentheses in agent name for title to prevent ambiguous nesting
	const escapedAgent = lane.agent
		.replace(/\(/g, '&#40;')
		.replace(/\)/g, '&#41;');
	return {
		body: {
			...(parentID ? { parentID } : {}),
			title: `${lane.id} (${escapedAgent})`,
		},
		query: { directory },
	};
}

function makeBatchId(): string {
	return `lanes-${_internals.now().toString(36)}`;
}

function promptHash(
	lane: DispatchLaneSpec,
	directory: string,
	batchId: string,
): string {
	return digestText(
		JSON.stringify({
			batchId,
			laneId: lane.id,
			agent: lane.agent,
			directory,
			prompt: lane.prompt.replace(/\r\n/g, '\n'),
		}),
	);
}

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export const dispatch_lanes: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Dispatch multiple read-only exploration/review lanes concurrently and BLOCK until every lane finishes, returning a structured join result. This blocks the caller until completion; for non-blocking dispatch that lets you keep working while lanes run, prefer dispatch_lanes_async + collect_lane_results and use this blocking variant only when promptAsync is unavailable. Keep each lane prompt compact: send large shared context once via common_prompt (or have lanes read it from a file by absolute path) instead of inlining it into every lane prompt.',
		args: {
			lanes: DispatchLanesArgsSchema.shape.lanes,
			common_prompt: DispatchLanesArgsSchema.shape.common_prompt,
			max_concurrent: DispatchLanesArgsSchema.shape.max_concurrent,
			timeout_ms: DispatchLanesArgsSchema.shape.timeout_ms,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeDispatchLanes(args, directory, {
				callerAgent: getContextAgent(ctx),
				sessionID: getContextSessionID(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const dispatch_lanes_async: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Launch multiple read-only advisory lanes with OpenCode promptAsync and return IMMEDIATELY with a batch id and lane session handles (non-blocking). launch_timeout_ms only bounds session creation and promptAsync acceptance; it is NOT a lane runtime timeout. After launching, keep working on non-dependent investigation while lanes run — poll incrementally with collect_lane_results (wait omitted or false) to process settled lanes as they complete, or use wait: true only at workflow boundaries where all results are needed. Keep each lane prompt compact: send large shared context once via common_prompt (or have lanes read it from a file by absolute path) instead of inlining it into every lane prompt, which can produce oversized or malformed tool-call JSON.',
		args: {
			lanes: DispatchLanesAsyncArgsSchema.shape.lanes,
			common_prompt: DispatchLanesAsyncArgsSchema.shape.common_prompt,
			max_concurrent: DispatchLanesAsyncArgsSchema.shape.max_concurrent,
			launch_timeout_ms: DispatchLanesAsyncArgsSchema.shape.launch_timeout_ms,
			timeout_ms: DispatchLanesAsyncArgsSchema.shape.timeout_ms,
			batch_id: DispatchLanesAsyncArgsSchema.shape.batch_id,
			mode: DispatchLanesAsyncArgsSchema.shape.mode,
			pr_head_sha: DispatchLanesAsyncArgsSchema.shape.pr_head_sha,
			scope: DispatchLanesAsyncArgsSchema.shape.scope,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeDispatchLanesAsync(args, directory, {
				callerAgent: getContextAgent(ctx),
				sessionID: getContextSessionID(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const collect_lane_results: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Collect or poll results for a dispatch_lanes_async batch. Supports two modes: (1) non-blocking poll (wait omitted or false) — performs one collection pass and returns current lane status, including pending lane identities by default, and any settled results so you can process completed lanes while continuing independent work; (2) blocking join (wait: true) — polls until all lanes settle or the collection wait budget expires. Busy/retry lanes do not become stale solely because they run for a long time. Does not advance workflow gates.',
		args: {
			batch_id: CollectLaneResultsArgsSchema.shape.batch_id,
			wait: CollectLaneResultsArgsSchema.shape.wait,
			timeout_ms: CollectLaneResultsArgsSchema.shape.timeout_ms,
			include_pending: CollectLaneResultsArgsSchema.shape.include_pending,
			cancel_pending: CollectLaneResultsArgsSchema.shape.cancel_pending,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeCollectLaneResults(args, directory, {
				sessionID: getContextSessionID(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

function getContextAgent(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).agent;
	return typeof value === 'string' ? value : undefined;
}

function getContextSessionID(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).sessionID;
	return typeof value === 'string' ? value : undefined;
}
