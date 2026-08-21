/**
 * Context Status Tool
 *
 * Read-only tool that reports current context-window headroom for the active
 * session. Returns both the measured usage and the `usageSource`
 * (`provider` prompt accounting when available, otherwise `estimated`).
 * Derives messages from the runtime session context (via
 * `swarmState.opencodeClient.session.messages`) and resolves thresholds from
 * the plugin config, mirroring the active `createContextBudgetHandler` hook's
 * behavior exactly — including strict `>` boundary semantics (exact threshold
 * values do NOT trigger a warning).
 *
 * Pure read-only: no state mutation, no warning injection, no side effects.
 * Works whether `context_budget.enabled` is true or false.
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { loadPluginConfig } from '../config';
import {
	type ContextUsageSource,
	computeContextUsage,
} from '../hooks/context-usage';
import { extractModelInfo, resolveModelLimit } from '../hooks/model-limits';
import {
	getLiveContextModelIdentity,
	getLiveContextWindow,
	swarmState,
} from '../state';
import { createSwarmTool } from './create-tool';

/**
 * Shape of a message's info block.
 * Mirrors the `MessageInfo` interface used by the context-budget hook.
 */
interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
	modelID?: string;
	providerID?: string;
	[key: string]: unknown;
}

/**
 * Shape of a single message part (text chunk).
 * Mirrors the `MessagePart` interface used by the context-budget hook.
 */
interface MessagePart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/**
 * Shape of a single message in the session array.
 * Mirrors `MessageWithParts` from the context-budget hook.
 */
export interface ContextMessage {
	info: MessageInfo;
	parts: MessagePart[];
	[key: string]: unknown;
}

/**
 * Result returned by the context_status tool.
 */
export interface ContextStatusResult {
	/** Provider-accounted or estimated tokens used across the session */
	tokensUsed: number;
	/** Whether usage came from provider prompt accounting or a bounded estimate */
	usageSource: ContextUsageSource;
	/** Resolved model context limit in tokens */
	modelLimit: number;
	/** Ratio of tokens-used to model-limit (0.0 – 1.0+) */
	usagePercent: number;
	/** Threshold state: 'none' | 'warn' | 'critical' */
	thresholdCrossed: 'none' | 'warn' | 'critical';
	/** Model identifier detected from the most recent assistant message */
	modelId: string | null;
	/** Provider identifier detected from the most recent assistant message */
	provider: string | null;
}

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPluginConfig(...)` and `_internals.fetchSessionMessages(...)`
 * so tests can replace these functions without `mock.module` leakage across
 * Bun's shared test-runner process. Mutating this local object is file-scoped
 * and trivially restorable via `afterEach`.
 */
export const _internals: {
	loadPluginConfig: typeof loadPluginConfig;
	fetchSessionMessages: (
		sessionID: string,
		directory: string,
		limit?: number,
	) => Promise<ContextMessage[] | null>;
} = {
	loadPluginConfig,
	fetchSessionMessages: async (sessionID, directory, limit = 100) => {
		if (!swarmState.opencodeClient?.session) return null;
		try {
			const result = await swarmState.opencodeClient.session.messages({
				path: { id: sessionID },
				query: { directory, limit },
			});
			return (result.data as ContextMessage[]) ?? null;
		} catch {
			return null;
		}
	},
};

/**
 * Compute context headroom from a session message array.
 * Pure function — no side effects, no logging, no state mutation.
 *
 * @param messages - Session messages (same shape as experimental.chat.messages.transform output)
 * @param warnThreshold - Usage ratio that triggers 'warn' state (default 0.7)
 * @param criticalThreshold - Usage ratio that triggers 'critical' state (default 0.9)
 * @param modelLimitsConfig - Model-specific limit overrides from config
 * @param liveContextLimit - Live `model.limit.context` recorded for the session
 *   by the system.transform hook; `undefined` when none has been seen yet
 * @returns Context status with token usage, limit, and threshold state
 */
function computeContextHeadroom(
	messages: ContextMessage[],
	warnThreshold = 0.7,
	criticalThreshold = 0.9,
	modelLimitsConfig: Record<string, number> = {},
	liveContextLimit?: unknown,
	modelIdentity?: { modelID?: string; providerID?: string },
): ContextStatusResult {
	// The current live identity outranks historical assistant metadata during a
	// first-turn handoff. Direct callers that do not have session state retain
	// the original extraction behavior.
	const { modelID, providerID } = modelIdentity ?? extractModelInfo(messages);

	// Resolve the model's context limit through the single derivation
	// (src/config/context-window.ts): explicit `model_limits` entry → the live
	// window the host reported for this session → the static fallback table →
	// DEFAULT_MODEL_CONTEXT_TOKENS. This tool must agree with the live
	// context-budget hook; reporting headroom against a different denominator
	// than the one that actually prunes messages is worse than not reporting it.
	const modelLimit = resolveModelLimit(
		modelID,
		providerID,
		modelLimitsConfig,
		liveContextLimit,
	);

	const usage = computeContextUsage(messages);

	const usagePercent = usage.tokensUsed / modelLimit;

	// Determine threshold state using config-resolved thresholds
	// Uses strict `>` to match the live context-budget hook boundary semantics.
	let thresholdCrossed: 'none' | 'warn' | 'critical' = 'none';
	if (usagePercent > criticalThreshold) {
		thresholdCrossed = 'critical';
	} else if (usagePercent > warnThreshold) {
		thresholdCrossed = 'warn';
	}

	return {
		tokensUsed: usage.tokensUsed,
		usageSource: usage.source,
		modelLimit,
		usagePercent,
		thresholdCrossed,
		modelId: modelID ?? null,
		provider: providerID ?? null,
	};
}

/**
 * context_status tool — read-only context window headroom report.
 *
 * Architects invoke this on demand to check how much context budget remains
 * without triggering the reactive warning injection that the
 * `createContextBudgetHandler` hook performs.
 *
 * The tool derives messages from the active session context (via
 * `ctx.sessionID` and the OpenCode client session API) and resolves
 * warn/critical thresholds from the plugin config, matching the live
 * context-budget hook's behavior.
 *
 * No arguments required — the tool queries current state automatically.
 *
 * Returns JSON with tokensUsed, usageSource, modelLimit, usagePercent,
 * thresholdCrossed, modelId, and provider.
 */
export { computeContextHeadroom };
export const context_status: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		allowWorkingDirectoryOverride: true,
		description:
			'Report current context-window headroom for the active session. Returns tokens-used, usageSource (provider|estimated), model-limit, usage-percent, threshold-state (none/warn/critical), model name, and provider. Pure read-only — no state mutation, no warning injection. Works whether context_budget.enabled is true or false.',
		args: {},
		async execute(
			_args: unknown,
			directory: string,
			ctx?: ToolContext,
		): Promise<string> {
			const config = _internals.loadPluginConfig(directory);
			const warnThreshold = config.context_budget?.warn_threshold ?? 0.7;
			const criticalThreshold =
				config.context_budget?.critical_threshold ?? 0.9;
			const modelLimitsConfig = config.context_budget?.model_limits ?? {};

			let messages: ContextMessage[] = [];
			if (ctx?.sessionID) {
				const sessionMessages = await _internals.fetchSessionMessages(
					ctx.sessionID,
					directory,
				);
				if (sessionMessages) {
					messages = sessionMessages;
				}
			}

			const { modelID, providerID } =
				getLiveContextModelIdentity(ctx?.sessionID) ??
				extractModelInfo(messages);
			const headroom = computeContextHeadroom(
				messages,
				warnThreshold,
				criticalThreshold,
				modelLimitsConfig,
				// Same live window the context-budget hook enforces against.
				// `ctx.sessionID` is the tool-side key; `undefined` before the first
				// system.transform of the session.
				getLiveContextWindow(ctx?.sessionID, { modelID, providerID }),
				{ modelID, providerID },
			);

			return JSON.stringify(headroom, null, 2);
		},
	});
