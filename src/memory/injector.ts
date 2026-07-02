import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
	extractCuratorMemoryDecisionsFromAgentOutput,
	extractMemoryProposalsFromAgentOutput,
} from '../agents/agent-output-schema';
import { stripKnownSwarmPrefix } from '../config/schema';
import type { MessageWithParts } from '../hooks/knowledge-types';
import { normalizeToolName } from '../hooks/normalize-tool-name';
import { validateSwarmPath } from '../hooks/utils';
import { type MemoryConfig, resolveMemoryConfig } from './config';
import type {
	MemoryGateway,
	ProposeMemoryInput,
	RecallMemoryInput,
} from './gateway';
import { createMemoryGateway } from './gateway';
import {
	buildMemoryRecallPlan,
	type MemoryRecallPlannerInput,
} from './recall-planner';
import { appendMemoryRunLog } from './run-log';
import { MEMORY_RECALL_SENTINEL } from './sentinel';
import type {
	MemoryKind,
	MemoryScopeRef,
	RecallBundle,
	RecallInjectionSkipReason,
} from './types';

const MEMORY_SENTINEL = MEMORY_RECALL_SENTINEL;

export interface MemoryLifecycleHookOptions {
	directory: string;
	config?: Partial<MemoryConfig>;
	getActiveAgentName?: (sessionID: string | undefined) => string | undefined;
	/**
	 * Resolve the task/phase unit-of-work id (e.g. plan task "1.1") for the
	 * session being processed. ADDITIVE join key threaded onto recorded recall
	 * bundles (B.1). Injectable seam (mirrors getActiveAgentName) so the injector
	 * stays swarmState-free; the production default reads the SAME session's
	 * `currentTaskId` in index.ts. MUST resolve only from the recall's OWN session
	 * — never a parent/orchestrator — because a wrong id corrupts B.2 attribution
	 * (a false join is worse than NULL). Returns undefined when unresolvable.
	 */
	getActiveTaskId?: (sessionID: string | undefined) => string | undefined;
	createGateway?: (
		context: {
			directory: string;
			sessionID?: string;
			agentRole?: string;
			agentId?: string;
			runId?: string;
			unitId?: string;
		},
		options: { config?: Partial<MemoryConfig> },
	) => Pick<
		MemoryGateway,
		'isEnabled' | 'deriveAllowedScopes' | 'recall' | 'propose'
	> &
		Partial<Pick<MemoryGateway, 'applyCuratorDecision' | 'dispose'>>;
	appendRunLog?: typeof appendMemoryRunLog;
}

export interface MemoryLifecycleHooks {
	messagesTransform(input: unknown, output: unknown): Promise<void>;
	toolAfter(input: unknown, output: unknown): Promise<void>;
}

export function createMemoryLifecycleHooks(
	options: MemoryLifecycleHookOptions,
): MemoryLifecycleHooks {
	const internals = {
		createGateway: options.createGateway ?? createMemoryGateway,
		appendRunLog: options.appendRunLog ?? appendMemoryRunLog,
	};

	return {
		messagesTransform: async (input, output): Promise<void> => {
			await injectIntoMessages(input, output, options, internals);
		},
		toolAfter: async (input, output): Promise<void> => {
			await captureTaskOutputProposals(input, output, options, internals);
		},
	};
}

async function injectIntoMessages(
	input: unknown,
	output: unknown,
	options: MemoryLifecycleHookOptions,
	internals: RequiredInternals,
): Promise<void> {
	const messages = (output as { messages?: unknown })?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return;
	if (messagesContainRecall(messages)) return;
	const sessionID = getSessionID(input, messages);
	const agentRole = resolveMessageAgent(messages, options, sessionID);
	const latestUserText = latestTextForRole(messages, 'user');
	if (!latestUserText) return;
	const agentTask = extractTaskToolPrompt(messages) ?? latestUserText;
	// ADDITIVE unit identity (B.1). Resolve ONLY from this same session's
	// currentTaskId via the injectable seam; on the dominant subagent-injection
	// path this is typically undefined (currentTaskId is populated on the
	// orchestrator session, not the subagent), so recall degrades to
	// session-scoped runId — the intended graceful degrade.
	const unitId = options.getActiveTaskId?.(sessionID);
	const result = await recallForAgent({
		directory: options.directory,
		config: options.config,
		sessionID,
		agentRole,
		agentId: agentRole,
		userGoal: latestUserText,
		agentTask,
		unitId,
		createGateway: internals.createGateway,
		appendRunLog: internals.appendRunLog,
	});
	if (result) {
		await maybeWriteUnitIdProbe({
			directory: options.directory,
			sessionID,
			agentRole,
			unitId,
			agentTask,
			bundleId: result.bundle.id,
		});
	}
	if (!result || result.bundle.items.length === 0) return;
	const insertAt = recallMessageInsertIndex(messages);
	const recallMessage: MessageWithParts = {
		info: {
			role: 'system',
			agent: agentRole,
			sessionID,
		},
		parts: [{ type: 'text', text: result.bundle.promptBlock }],
	};
	messages.splice(insertAt, 0, recallMessage);
	await internals.appendRunLog(options.directory, sessionID, {
		event: 'prompt_injected',
		runId: sessionID ?? 'unknown',
		agentRole,
		agentId: agentRole,
		bundleId: result.bundle.id,
		memoryIds: result.bundle.items.map((item) => item.record.id),
		tokenEstimate: result.bundle.tokenEstimate,
		metadata: { surface: 'chat_messages' },
	});
}

async function captureTaskOutputProposals(
	input: unknown,
	output: unknown,
	options: MemoryLifecycleHookOptions,
	internals: RequiredInternals,
): Promise<void> {
	const task = parseTaskToolInput(input);
	if (!task) return;
	const outputText = (output as { output?: unknown })?.output;
	if (
		typeof outputText !== 'string' ||
		(!outputText.includes('memoryProposals') &&
			!outputText.includes('curatorMemoryDecisions'))
	) {
		return;
	}
	const extracted = outputText.includes('memoryProposals')
		? extractMemoryProposalsFromAgentOutput(outputText)
		: { proposals: [] };
	if (extracted.error) {
		await internals.appendRunLog(options.directory, task.sessionID, {
			event: 'proposal_rejected_by_validation',
			runId: task.sessionID ?? 'unknown',
			agentRole: task.agentRole,
			agentId: task.agentRole,
			rejectionReason: extracted.error,
		});
		return;
	}
	const decisionExtraction = outputText.includes('curatorMemoryDecisions')
		? extractCuratorMemoryDecisionsFromAgentOutput(outputText)
		: { decisions: [] };
	if (decisionExtraction.error) {
		await internals.appendRunLog(options.directory, task.sessionID, {
			event: 'curator_decision_rejected_by_validation',
			runId: task.sessionID ?? 'unknown',
			agentRole: task.agentRole,
			agentId: task.agentRole,
			rejectionReason: decisionExtraction.error,
		});
		return;
	}
	if (
		extracted.proposals.length === 0 &&
		decisionExtraction.decisions.length === 0
	) {
		return;
	}
	const gateway = internals.createGateway(
		{
			directory: options.directory,
			sessionID: task.sessionID,
			agentRole: task.agentRole,
			agentId: task.agentRole,
			runId: task.sessionID,
		},
		{ config: options.config },
	);
	if (!gateway.isEnabled()) {
		await gateway.dispose?.();
		return;
	}
	try {
		for (const proposalInput of extracted.proposals) {
			try {
				const proposal = await gateway.propose(proposalInput);
				await internals.appendRunLog(options.directory, task.sessionID, {
					event:
						proposal.status === 'pending'
							? 'proposal_created'
							: 'proposal_rejected_by_validation',
					runId: task.sessionID ?? 'unknown',
					agentRole: task.agentRole,
					agentId: task.agentRole,
					proposalId: proposal.id,
					rejectionReason: proposal.rejectionReason,
				});
			} catch (err) {
				await internals.appendRunLog(options.directory, task.sessionID, {
					event: 'proposal_rejected_by_validation',
					runId: task.sessionID ?? 'unknown',
					agentRole: task.agentRole,
					agentId: task.agentRole,
					rejectionReason: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (
			decisionExtraction.decisions.length > 0 &&
			!isCuratorAgent(task.agentRole)
		) {
			await internals.appendRunLog(options.directory, task.sessionID, {
				event: 'curator_decision_rejected_by_validation',
				runId: task.sessionID ?? 'unknown',
				agentRole: task.agentRole,
				agentId: task.agentRole,
				rejectionReason: 'only curator agents may emit curatorMemoryDecisions',
			});
			return;
		}
		if (decisionExtraction.decisions.length > 0) {
			const applyCuratorDecisionMethod = gateway.applyCuratorDecision;
			if (!applyCuratorDecisionMethod) {
				await internals.appendRunLog(options.directory, task.sessionID, {
					event: 'curator_decision_rejected_by_validation',
					runId: task.sessionID ?? 'unknown',
					agentRole: task.agentRole,
					agentId: task.agentRole,
					rejectionReason: 'memory gateway does not support curator decisions',
				});
				return;
			}
			const applyCuratorDecision = applyCuratorDecisionMethod.bind(gateway);
			for (const decision of decisionExtraction.decisions) {
				try {
					const change = await applyCuratorDecision(decision);
					await internals.appendRunLog(options.directory, task.sessionID, {
						event: 'curator_decision_applied',
						runId: task.sessionID ?? 'unknown',
						agentRole: task.agentRole,
						agentId: task.agentRole,
						proposalId: change.proposalId,
						memoryIds: [
							change.memoryId,
							change.targetMemoryId,
							change.oldMemoryId,
							change.replacementMemoryId,
						].filter((id): id is string => Boolean(id)),
						rejectionReason: change.reason,
						metadata: {
							action: change.action,
							proposalStatus: change.proposalStatus,
							eventId: change.eventId,
						},
					});
				} catch (err) {
					await internals.appendRunLog(options.directory, task.sessionID, {
						event: 'curator_decision_rejected_by_validation',
						runId: task.sessionID ?? 'unknown',
						agentRole: task.agentRole,
						agentId: task.agentRole,
						proposalId: decision.proposalId,
						rejectionReason: err instanceof Error ? err.message : String(err),
						metadata: { action: decision.action },
					});
				}
			}
		}
	} finally {
		await gateway.dispose?.();
	}
}

async function recallForAgent(input: {
	directory: string;
	config?: Partial<MemoryConfig>;
	sessionID?: string;
	agentRole: string;
	agentId: string;
	userGoal: string;
	agentTask: string;
	unitId?: string;
	createGateway: RequiredInternals['createGateway'];
	appendRunLog: RequiredInternals['appendRunLog'];
}): Promise<{ bundle: RecallBundle; scopes: MemoryScopeRef[] } | null> {
	const gateway = input.createGateway(
		{
			directory: input.directory,
			sessionID: input.sessionID,
			agentRole: input.agentRole,
			agentId: input.agentId,
			runId: input.sessionID,
			unitId: input.unitId,
		},
		{ config: input.config },
	);
	try {
		const resolvedConfig = resolveMemoryConfig(input.config);
		if (!gateway.isEnabled()) {
			await logInjectionSkipped(input, 'disabled');
			return null;
		}
		if (!resolvedConfig.recall.injection.enabled) {
			await logInjectionSkipped(input, 'disabled');
			return null;
		}
		const scopes = gateway.deriveAllowedScopes();
		const planInput: MemoryRecallPlannerInput = {
			userGoal: compactText(input.userGoal),
			runId: input.sessionID ?? 'unknown',
			agentRole: input.agentRole,
			agentId: input.agentId,
			agentTask: compactText(input.agentTask),
			touchedFiles: extractTouchedFiles(input.agentTask),
		};
		const plan = buildMemoryRecallPlan(planInput, { scopes });
		plan.maxItems = resolvedConfig.recall.injection.maxItems;
		plan.tokenBudget = resolvedConfig.recall.injection.tokenBudget;
		await input.appendRunLog(input.directory, input.sessionID, {
			event: 'recall_requested',
			runId: input.sessionID ?? 'unknown',
			agentRole: input.agentRole,
			agentId: input.agentId,
			metadata: {
				kinds: plan.kinds,
				maxItems: plan.maxItems,
				tokenBudget: plan.tokenBudget,
				scopeTypes: plan.scopes.map((scope) => scope.type),
			},
		});
		const recallInput: RecallMemoryInput = {
			query: plan.query,
			task: planInput.agentTask,
			mode: 'injection',
			scopes: plan.scopes,
			kinds: plan.kinds,
			maxItems: plan.maxItems,
			tokenBudget: plan.tokenBudget,
			minScore: resolvedConfig.recall.injection.minScore,
			requireQuerySignal: resolvedConfig.recall.injection.requireQuerySignal,
		};
		const bundle = await gateway.recall(recallInput);
		await input.appendRunLog(input.directory, input.sessionID, {
			event: 'recall_returned',
			runId: input.sessionID ?? 'unknown',
			agentRole: input.agentRole,
			agentId: input.agentId,
			bundleId: bundle.id,
			memoryIds: bundle.items.map((item) => item.record.id),
			scores: bundle.items.map((item) => item.score),
			tokenEstimate: bundle.tokenEstimate,
		});
		if (bundle.items.length === 0) {
			await logInjectionSkipped(
				input,
				bundle.diagnostics?.injectionSkipReason ?? 'no_results',
				bundle,
			);
		}
		return { bundle, scopes };
	} finally {
		await gateway.dispose?.();
	}
}

async function logInjectionSkipped(
	input: {
		directory: string;
		sessionID?: string;
		agentRole: string;
		agentId: string;
		appendRunLog: RequiredInternals['appendRunLog'];
	},
	reason: RecallInjectionSkipReason,
	bundle?: RecallBundle,
): Promise<void> {
	await input.appendRunLog(input.directory, input.sessionID, {
		event: 'prompt_injection_skipped',
		runId: input.sessionID ?? 'unknown',
		agentRole: input.agentRole,
		agentId: input.agentId,
		bundleId: bundle?.id,
		memoryIds: bundle?.items.map((item) => item.record.id),
		scores: bundle?.items.map((item) => item.score),
		tokenEstimate: bundle?.tokenEstimate,
		rejectionReason: reason,
		metadata: {
			reason,
			candidateCount: bundle?.diagnostics?.candidateCount,
			preScoredFilteredCount: bundle?.diagnostics?.preScoredFilteredCount,
			noSignalCount: bundle?.diagnostics?.noSignalCount,
			belowThresholdCount: bundle?.diagnostics?.belowThresholdCount,
		},
	});
}

/**
 * TEMPORARY empirical-verification probe for issue #1467 Phase B attribution.
 *
 * Purpose: let an operator confirm, in a REAL swarm session, whether a
 * dispatched subagent's memory injection can see a parseable plan-task-id in
 * its own dispatch prompt (via a `TASK: <id>` marker) even when the
 * session-state resolver (`getActiveTaskId`) returns nothing for that
 * session — the dominant subagent-injection case. That comparison
 * (`resolvedUnitId` vs. `promptTaskIdCandidate`) is the load-bearing unknown
 * for a future prompt-parse-based attribution enhancement.
 *
 * Fires for every produced bundle, INCLUDING zero-item recalls where nothing
 * is actually injected into the message stream. This is intentional, not an
 * oversight: cold-memory subagent recalls that return zero items are likely
 * the majority real-world case, and they still answer the question this probe
 * exists to answer (can the injector see a parseable task id in the prompt).
 * Gating on `items.length > 0` would blind the probe to exactly the case it
 * needs to observe.
 *
 * Gated by `OPENCODE_SWARM_MEMORY_UNITID_PROBE=1`. Inert by default: the env
 * check is the very first thing this function does, so with the flag unset
 * this is a single string comparison and an early return — zero behavior
 * change, zero measurable perf cost. Safe to leave in. All I/O is wrapped in
 * try/catch so a probe failure can never break or slow real injection.
 */
const UNITID_PROBE_TASK_ID_PATTERN = /\bTASK:\s*(\d+(?:\.\d+)+)\b/;

async function maybeWriteUnitIdProbe(input: {
	directory: string;
	sessionID: string | undefined;
	agentRole: string;
	unitId: string | undefined;
	agentTask: string;
	bundleId: string;
}): Promise<void> {
	if (process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE !== '1') return;
	try {
		const match = input.agentTask.match(UNITID_PROBE_TASK_ID_PATTERN);
		const record = {
			sessionID: input.sessionID,
			agentRole: input.agentRole,
			resolvedUnitId: input.unitId ?? null,
			promptTaskIdCandidate: match ? match[1] : null,
			agentTaskSnippet: input.agentTask.slice(0, 160),
			bundleId: input.bundleId,
			timestamp: new Date().toISOString(),
		};
		const filePath = validateSwarmPath(
			input.directory,
			path.join('memory', 'unitid-probe.jsonl'),
		);
		await mkdir(path.dirname(filePath), { recursive: true });
		await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
	} catch {
		// Probe I/O must never affect real injection behavior.
	}
}

interface ParsedTaskInput {
	sessionID?: string;
	agentRole: string;
	prompt: string;
}

function parseTaskToolInput(input: unknown): ParsedTaskInput | null {
	const record = input as {
		tool?: unknown;
		sessionID?: unknown;
		args?: unknown;
		agent?: unknown;
	};
	const rawTool = typeof record.tool === 'string' ? record.tool : undefined;
	const toolName = rawTool
		? (normalizeToolName(rawTool) ?? rawTool)
		: undefined;
	if (toolName !== 'Task' && toolName !== 'task') return null;
	if (!record.args || typeof record.args !== 'object') return null;
	const args = record.args as Record<string, unknown>;
	const prompt = args.prompt;
	if (typeof prompt !== 'string' || prompt.trim().length === 0) return null;
	const target =
		typeof args.subagent_type === 'string'
			? args.subagent_type
			: typeof args.agent === 'string'
				? args.agent
				: typeof record.agent === 'string'
					? record.agent
					: 'architect';
	return {
		sessionID:
			typeof record.sessionID === 'string' ? record.sessionID : undefined,
		agentRole: stripKnownSwarmPrefix(target),
		prompt,
	};
}

function isCuratorAgent(agentRole: string): boolean {
	return (
		agentRole === 'curator' ||
		agentRole === 'curator_init' ||
		agentRole === 'curator_phase' ||
		agentRole === 'curator_postmortem'
	);
}

function messagesContainRecall(messages: unknown[]): boolean {
	return messages.some((message) =>
		((message as { parts?: unknown })?.parts as unknown[] | undefined)?.some(
			(part) =>
				typeof (part as { text?: unknown })?.text === 'string' &&
				((part as { text: string }).text.includes(MEMORY_SENTINEL) ||
					(part as { text: string }).text.includes('Retrieved Swarm Memory')),
		),
	);
}

function getSessionID(input: unknown, messages: unknown[]): string | undefined {
	const inputSession = (input as { sessionID?: unknown })?.sessionID;
	if (typeof inputSession === 'string') return inputSession;
	for (const message of messages) {
		const sessionID = (message as { info?: { sessionID?: unknown } })?.info
			?.sessionID;
		if (typeof sessionID === 'string') return sessionID;
	}
	return undefined;
}

function resolveMessageAgent(
	messages: unknown[],
	options: MemoryLifecycleHookOptions,
	sessionID: string | undefined,
): string {
	const configured = options.getActiveAgentName?.(sessionID);
	if (configured) return stripKnownSwarmPrefix(configured);
	for (const message of messages) {
		const agent = (message as { info?: { agent?: unknown } })?.info?.agent;
		if (typeof agent === 'string') return stripKnownSwarmPrefix(agent);
	}
	return 'architect';
}

function latestTextForRole(messages: unknown[], role: string): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as {
			info?: { role?: unknown };
			parts?: unknown;
		};
		if (message.info?.role !== role || !Array.isArray(message.parts)) continue;
		const text = message.parts
			.map((part) => (part as { text?: unknown })?.text)
			.filter((partText): partText is string => typeof partText === 'string')
			.join('\n')
			.trim();
		if (text) return text;
	}
	return null;
}

function extractTaskToolPrompt(messages: unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown>;

		// Support both message shapes
		const role =
			msg.role ?? (msg.info as Record<string, unknown> | undefined)?.role;
		if (role !== 'assistant') continue;

		const content = Array.isArray(msg.content)
			? msg.content
			: Array.isArray(msg.parts)
				? msg.parts
				: [];

		for (let j = content.length - 1; j >= 0; j--) {
			const block = content[j];
			if (block && typeof block === 'object') {
				const b = block as Record<string, unknown>;
				if (b.type === 'tool_use' && b.name === 'Task') {
					const input = b.input as Record<string, unknown> | undefined;
					const prompt = input?.prompt;
					if (typeof prompt === 'string' && prompt.length > 0) {
						return prompt;
					}
				}
			}
		}
	}
	return null;
}

function recallMessageInsertIndex(messages: unknown[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = (messages[i] as { info?: { role?: unknown } })?.info?.role;
		if (role === 'user') return i;
	}
	return messages.length;
}

function extractTouchedFiles(text: string): string[] {
	const matches = text.match(
		/\b(?:src|tests|test|docs|scripts|packages)\/[A-Za-z0-9._/@+-]+/g,
	);
	return Array.from(new Set(matches ?? [])).slice(0, 20);
}

function compactText(text: string): string {
	const compacted = text.replace(/\s+/g, ' ').trim();
	if (compacted.length <= 2000) return compacted;
	return Array.from(compacted).slice(0, 2000).join('');
}

type RequiredInternals = {
	createGateway: NonNullable<MemoryLifecycleHookOptions['createGateway']>;
	appendRunLog: NonNullable<MemoryLifecycleHookOptions['appendRunLog']>;
};

export type { ProposeMemoryInput, MemoryKind };
export const _test_exports = { compactText, messagesContainRecall };
