import { extractMemoryProposalsFromAgentOutput } from '../agents/agent-output-schema';
import { stripKnownSwarmPrefix } from '../config/schema';
import type { MessageWithParts } from '../hooks/knowledge-types';
import { normalizeToolName } from '../hooks/normalize-tool-name';
import type { MemoryConfig } from './config';
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
import type { MemoryKind, MemoryScopeRef, RecallBundle } from './types';

const MEMORY_SENTINEL = '## Retrieved Swarm Memory';

export interface MemoryLifecycleHookOptions {
	directory: string;
	config?: Partial<MemoryConfig>;
	getActiveAgentName?: (sessionID: string | undefined) => string | undefined;
	createGateway?: (
		context: {
			directory: string;
			sessionID?: string;
			agentRole?: string;
			agentId?: string;
			runId?: string;
		},
		options: { config?: Partial<MemoryConfig> },
	) => Pick<
		MemoryGateway,
		'isEnabled' | 'deriveAllowedScopes' | 'recall' | 'propose'
	>;
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
	const result = await recallForAgent({
		directory: options.directory,
		config: options.config,
		sessionID,
		agentRole,
		agentId: agentRole,
		userGoal: latestUserText,
		agentTask: latestUserText,
		createGateway: internals.createGateway,
		appendRunLog: internals.appendRunLog,
	});
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
		!outputText.includes('memoryProposals')
	) {
		return;
	}
	const extracted = extractMemoryProposalsFromAgentOutput(outputText);
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
	if (extracted.proposals.length === 0) return;
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
	if (!gateway.isEnabled()) return;
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
}

async function recallForAgent(input: {
	directory: string;
	config?: Partial<MemoryConfig>;
	sessionID?: string;
	agentRole: string;
	agentId: string;
	userGoal: string;
	agentTask: string;
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
		},
		{ config: input.config },
	);
	if (!gateway.isEnabled()) return null;
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
		scopes: plan.scopes,
		kinds: plan.kinds,
		maxItems: plan.maxItems,
		tokenBudget: plan.tokenBudget,
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
	return { bundle, scopes };
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
	return text.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

type RequiredInternals = {
	createGateway: NonNullable<MemoryLifecycleHookOptions['createGateway']>;
	appendRunLog: NonNullable<MemoryLifecycleHookOptions['appendRunLog']>;
};

export type { ProposeMemoryInput, MemoryKind };
