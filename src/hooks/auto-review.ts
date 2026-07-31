/**
 * Automatic task-completion review hook.
 *
 * Phase/plan review is owned by the phase_complete tool body so it can await a
 * durable artifact before the evidence-only gate runs. This hook therefore owns
 * only task-completion review, remains fire-and-forget, and delegates every
 * model/diff/persistence decision to the shared review engine.
 */

import * as fs from 'node:fs';
import {
	type AutoReviewConfig,
	AutoReviewConfigSchema,
	stripKnownSwarmPrefix,
} from '../config/schema.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import { type ReviewEngineResult, runReviewEngine } from '../review/engine.js';
import {
	optionalModelOverride,
	type ReviewAgentModelRegistry,
	resolveReviewAgentNames,
	resolveReviewFallbackModels,
} from '../review/runtime.js';
import { swarmState } from '../state.js';
import * as logger from '../utils/logger.js';
import { normalizeToolName } from './normalize-tool-name.js';
import { validateSwarmPath } from './utils.js';

const MAX_TRACKED_SESSIONS = 256;
const COOLDOWN_MS = 60_000;

function injectAutoReviewAdvisory(
	injectAdvisory: (sessionId: string, message: string) => void,
	sessionID: string,
	message: string,
): void {
	try {
		injectAdvisory(sessionID, message);
	} catch (error) {
		logger.warn(
			`[auto-review] advisory injection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function evictCooldownMap(lastDispatchBySession: Map<string, number>): void {
	while (lastDispatchBySession.size > MAX_TRACKED_SESSIONS) {
		const firstKey = lastDispatchBySession.keys().next().value;
		if (firstKey === undefined) break;
		lastDispatchBySession.delete(firstKey);
	}
}

interface AutoReviewEvent {
	type: 'auto_review';
	timestamp: string;
	session_id: string;
	trigger: 'task_completion';
	task_id?: string;
	verdict:
		| 'approved'
		| 'rejected'
		| 'completed'
		| 'clean'
		| 'error'
		| 'skipped';
	detail: string;
	receipt_path?: string;
	evidence_path?: string;
	scope_hash?: string;
	model_calls: number;
}

function writeAutoReviewEvent(directory: string, event: AutoReviewEvent): void {
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
	} catch (error) {
		logger.warn(
			`[auto-review] event write failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export interface AutoReviewRunInput {
	directory: string;
	sessionID: string;
	trigger: 'task_completion';
	taskId?: string;
	config: AutoReviewConfig;
	dispatcher?: ReviewModelDispatcher;
	generatedAgentNames?: Iterable<string>;
	activeAgentName?: string;
	agentModelRegistry?: ReviewAgentModelRegistry;
	injectAdvisory: (sessionId: string, message: string) => void;
}

export async function runAutoReview(
	input: AutoReviewRunInput,
): Promise<ReviewEngineResult | undefined> {
	if (!input.dispatcher) {
		writeAutoReviewEvent(input.directory, {
			type: 'auto_review',
			timestamp: new Date().toISOString(),
			session_id: input.sessionID,
			trigger: 'task_completion',
			task_id: input.taskId,
			verdict: 'error',
			detail: 'review runtime unavailable',
			model_calls: 0,
		});
		return undefined;
	}
	try {
		const agents = resolveReviewAgentNames(
			input.generatedAgentNames ?? swarmState.generatedAgentNames,
			input.activeAgentName,
		);
		const result = await _internals.runReviewEngine({
			directory: input.directory,
			sessionID: input.sessionID,
			trigger: 'task_completion',
			selector: { kind: 'working-tree' },
			config: input.config,
			dispatcher: input.dispatcher,
			reviewerAgent: agents.reviewer,
			validatorAgent: agents.validator,
			reviewerFallbackModels: resolveReviewFallbackModels(
				agents.reviewer,
				input.agentModelRegistry,
			),
			validatorModel: optionalModelOverride(input.config.validation_model),
			validatorFallbackModels: resolveReviewFallbackModels(
				agents.validator,
				input.agentModelRegistry,
			),
			injectAdvisory: input.injectAdvisory,
		});
		writeAutoReviewEvent(input.directory, {
			type: 'auto_review',
			timestamp: new Date().toISOString(),
			session_id: input.sessionID,
			trigger: 'task_completion',
			task_id: input.taskId,
			verdict: result.reviewVerdict ?? result.status,
			detail: result.message,
			receipt_path: result.receiptPath,
			evidence_path: result.evidencePath,
			scope_hash: result.scopeHash,
			model_calls: result.modelCalls,
		});
		return result;
	} catch (error) {
		logger.warn(
			`[auto-review] run failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		writeAutoReviewEvent(input.directory, {
			type: 'auto_review',
			timestamp: new Date().toISOString(),
			session_id: input.sessionID,
			trigger: 'task_completion',
			task_id: input.taskId,
			verdict: 'error',
			detail: error instanceof Error ? error.message : String(error),
			model_calls: 0,
		});
		return undefined;
	}
}

export interface AutoReviewHookOptions {
	config: AutoReviewConfig;
	directory: string;
	dispatcher?: ReviewModelDispatcher;
	generatedAgentNames?: Iterable<string>;
	agentModelRegistry?: ReviewAgentModelRegistry;
	getActiveAgentName?: (sessionID: string) => string | undefined;
	injectAdvisory: (sessionId: string, message: string) => void;
}

export interface AutoReviewToolAfterContext {
	/**
	 * Arguments recovered from the callID snapshot. The OpenCode SDK's
	 * `tool.execute.after` output does not carry the original tool arguments.
	 */
	args: Record<string, unknown> | null;
}

export function createAutoReviewHook(options: AutoReviewHookOptions): {
	toolAfter: (
		input: { tool: string; sessionID: string; callID?: string },
		context: AutoReviewToolAfterContext,
	) => Promise<void>;
	/** Instance-local test/lifecycle seam; never affects another plugin instance. */
	resetTracking: () => void;
} {
	const config = AutoReviewConfigSchema.parse(options.config);
	const inFlightSessions = new Set<string>();
	const lastDispatchBySession = new Map<string, number>();
	const resetTracking = (): void => {
		inFlightSessions.clear();
		lastDispatchBySession.clear();
	};
	const generatedAgentNames = options.generatedAgentNames
		? Object.freeze([...options.generatedAgentNames])
		: undefined;
	const wantsTask =
		config.enabled &&
		(config.trigger === 'task_completion' || config.trigger === 'both');
	if (!wantsTask) return { toolAfter: async () => {}, resetTracking };

	return {
		resetTracking,
		toolAfter: async (input, context) => {
			try {
				const tool = (
					normalizeToolName(input.tool) ??
					input.tool ??
					''
				).toLowerCase();
				const args = context.args ?? undefined;
				if (
					tool !== 'update_task_status' ||
					args?.status !== 'completed' ||
					!input.sessionID
				) {
					return;
				}
				const agentName =
					options.getActiveAgentName?.(input.sessionID) ??
					swarmState.activeAgent.get(input.sessionID) ??
					swarmState.agentSessions.get(input.sessionID)?.agentName ??
					'';
				if (agentName && stripKnownSwarmPrefix(agentName) !== 'architect') {
					return;
				}
				if (inFlightSessions.has(input.sessionID)) return;
				const now = _internals.now();
				if (
					now - (lastDispatchBySession.get(input.sessionID) ?? 0) <
					COOLDOWN_MS
				) {
					return;
				}
				const taskId =
					typeof args.task_id === 'string' ? args.task_id : undefined;
				if (inFlightSessions.size >= MAX_TRACKED_SESSIONS) {
					const detail = `active review capacity reached (${MAX_TRACKED_SESSIONS}); task-completion review skipped`;
					writeAutoReviewEvent(options.directory, {
						type: 'auto_review',
						timestamp: new Date().toISOString(),
						session_id: input.sessionID,
						trigger: 'task_completion',
						task_id: taskId,
						verdict: 'skipped',
						detail,
						model_calls: 0,
					});
					injectAutoReviewAdvisory(
						options.injectAdvisory,
						input.sessionID,
						`[AUTO-REVIEW TASK_COMPLETION] ${detail}. Completion remains fail-open.`,
					);
					return;
				}
				inFlightSessions.add(input.sessionID);
				lastDispatchBySession.delete(input.sessionID);
				lastDispatchBySession.set(input.sessionID, now);
				evictCooldownMap(lastDispatchBySession);
				const runInput: AutoReviewRunInput = {
					directory: options.directory,
					sessionID: input.sessionID,
					trigger: 'task_completion',
					taskId,
					config,
					dispatcher: options.dispatcher,
					generatedAgentNames,
					activeAgentName: agentName || undefined,
					agentModelRegistry: options.agentModelRegistry,
					injectAdvisory: options.injectAdvisory,
				};
				let pending: Promise<ReviewEngineResult | undefined>;
				try {
					pending = Promise.resolve(_internals.runAutoReview(runInput));
				} catch (error) {
					inFlightSessions.delete(input.sessionID);
					const detail = `unexpected review scheduler failure: ${error instanceof Error ? error.message : String(error)}`;
					writeAutoReviewEvent(options.directory, {
						type: 'auto_review',
						timestamp: new Date().toISOString(),
						session_id: input.sessionID,
						trigger: 'task_completion',
						task_id: taskId,
						verdict: 'error',
						detail,
						model_calls: 0,
					});
					injectAutoReviewAdvisory(
						options.injectAdvisory,
						input.sessionID,
						`[AUTO-REVIEW TASK_COMPLETION] ${detail}. Completion remains fail-open.`,
					);
					return;
				}
				void pending
					.catch((error) => {
						const detail = `unexpected review scheduler rejection: ${error instanceof Error ? error.message : String(error)}`;
						writeAutoReviewEvent(options.directory, {
							type: 'auto_review',
							timestamp: new Date().toISOString(),
							session_id: input.sessionID,
							trigger: 'task_completion',
							task_id: taskId,
							verdict: 'error',
							detail,
							model_calls: 0,
						});
						injectAutoReviewAdvisory(
							options.injectAdvisory,
							input.sessionID,
							`[AUTO-REVIEW TASK_COMPLETION] ${detail}. Completion remains fail-open.`,
						);
					})
					.finally(() => {
						inFlightSessions.delete(input.sessionID);
					});
			} catch (error) {
				logger.warn(
					`[auto-review] hook error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

export const _internals: {
	runReviewEngine: typeof runReviewEngine;
	runAutoReview: typeof runAutoReview;
	now: () => number;
} = {
	runReviewEngine,
	runAutoReview,
	now: () => Date.now(),
};
