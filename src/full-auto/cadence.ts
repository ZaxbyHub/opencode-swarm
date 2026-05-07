/**
 * Full-Auto v2 oversight cadence.
 *
 * Pure helpers that decide when periodic / risk-triggered oversight should
 * fire. Wired into the existing tool.execute.after flow (counters increment)
 * and into the chat.message transform (architect turn increment) by the
 * orchestrating hook composition in `src/index.ts`.
 *
 * Critic oversight sessions and critic-internal tool calls must be exempt
 * from triggering further Full-Auto oversight. Callers identify those by
 * passing `excludeAgent: true` for the relevant call.
 */
import type { PluginConfig } from '../config';
import { ORCHESTRATOR_NAME } from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import * as logger from '../utils/logger';
import { dispatchFullAutoOversight } from './oversight';
import {
	type FullAutoRunState,
	incrementFullAutoCounter,
	loadFullAutoRunState,
} from './state';

export type CadenceTrigger =
	| { kind: 'tool_calls'; threshold: number }
	| { kind: 'architect_turns'; threshold: number }
	| { kind: 'minutes'; threshold: number; elapsedMinutes: number }
	| { kind: 'consecutive_no_progress'; threshold: number }
	| { kind: 'denials_near_limit'; consecutive: number; max: number };

export interface CadenceDecision {
	shouldEscalate: boolean;
	triggers: CadenceTrigger[];
}

function configCadence(config: PluginConfig): {
	everyToolCalls: number;
	everyArchitectTurns: number;
	everyMinutes: number;
} {
	const oversight = config.full_auto?.oversight;
	return {
		everyToolCalls: oversight?.every_tool_calls ?? 25,
		everyArchitectTurns: oversight?.every_architect_turns ?? 5,
		everyMinutes: oversight?.every_minutes ?? 20,
	};
}

function denialLimits(config: PluginConfig): {
	maxConsecutive: number;
	maxTotal: number;
} {
	return {
		maxConsecutive: config.full_auto?.denials?.max_consecutive ?? 3,
		maxTotal: config.full_auto?.denials?.max_total ?? 20,
	};
}

export function evaluateFullAutoCadence(
	state: FullAutoRunState,
	config: PluginConfig,
	now = Date.now(),
): CadenceDecision {
	const triggers: CadenceTrigger[] = [];
	const cadence = configCadence(config);
	const denials = denialLimits(config);

	if (
		cadence.everyToolCalls > 0 &&
		state.counters.toolCalls > 0 &&
		state.counters.toolCalls % cadence.everyToolCalls === 0
	) {
		triggers.push({
			kind: 'tool_calls',
			threshold: cadence.everyToolCalls,
		});
	}

	if (
		cadence.everyArchitectTurns > 0 &&
		state.counters.architectTurns > 0 &&
		state.counters.architectTurns % cadence.everyArchitectTurns === 0
	) {
		triggers.push({
			kind: 'architect_turns',
			threshold: cadence.everyArchitectTurns,
		});
	}

	if (cadence.everyMinutes > 0 && state.lastOversightAt) {
		const lastTs = Date.parse(state.lastOversightAt);
		if (Number.isFinite(lastTs)) {
			const elapsedMinutes = (now - lastTs) / 60_000;
			if (elapsedMinutes >= cadence.everyMinutes) {
				triggers.push({
					kind: 'minutes',
					threshold: cadence.everyMinutes,
					elapsedMinutes,
				});
			}
		}
	}

	if (state.counters.consecutiveNoProgressTurns >= 3) {
		triggers.push({
			kind: 'consecutive_no_progress',
			threshold: 3,
		});
	}

	// Trigger near the consecutive-denial limit so the critic can intervene
	// before the durable pause kicks in.
	if (
		denials.maxConsecutive > 1 &&
		state.denialCounters.consecutive >= denials.maxConsecutive - 1 &&
		state.denialCounters.consecutive < denials.maxConsecutive
	) {
		triggers.push({
			kind: 'denials_near_limit',
			consecutive: state.denialCounters.consecutive,
			max: denials.maxConsecutive,
		});
	}

	return {
		shouldEscalate: triggers.length > 0,
		triggers,
	};
}

/**
 * Convenience: increment the relevant counter and evaluate cadence in one
 * call. Returns undefined when there is no active Full-Auto run.
 */
export function tickAndEvaluate(
	directory: string,
	sessionID: string,
	counter: 'toolCalls' | 'architectTurns',
	config: PluginConfig,
): CadenceDecision | undefined {
	if (!config.full_auto?.enabled) return undefined;
	const before = loadFullAutoRunState(directory, sessionID);
	if (!before || before.status !== 'running') return undefined;
	const updated = incrementFullAutoCounter(directory, sessionID, counter);
	if (!updated) return undefined;
	return evaluateFullAutoCadence(updated, config);
}

/**
 * Module-level reentry guard. When cadence dispatches a critic call, the
 * critic agent itself may emit chat messages / tool calls; without this
 * guard the cadence path could re-enter and dispatch recursively. The guard
 * is keyed by sessionID so unrelated sessions are not blocked.
 */
const cadenceDispatchInFlight: Set<string> = new Set();

function resolveOversightAgentName(activeAgent: string | undefined): string {
	if (!activeAgent) return 'critic_oversight';
	const stripped = stripKnownSwarmPrefix(activeAgent);
	if (stripped !== ORCHESTRATOR_NAME) return 'critic_oversight';
	const lastIdx = activeAgent.toLowerCase().lastIndexOf('architect');
	if (lastIdx > 0) {
		return `${activeAgent.slice(0, lastIdx)}critic_oversight`;
	}
	return 'critic_oversight';
}

/**
 * Tick a counter, evaluate cadence, and — if a trigger fires — dispatch the
 * critic oversight agent in a non-blocking way. The dispatch:
 *   - increments the durable oversight counter
 *   - writes a `full_auto_oversight` event/evidence record
 *   - mutates durable run state (pause / terminate) according to verdict
 *
 * The chat.message and tool.execute.after callers do not await the dispatch
 * — they fire-and-forget. The next tool call by the agent will see the
 * paused/terminated state and surface a structured error.
 *
 * Returns the CadenceDecision so callers can introspect for tests.
 */
export function tickAndMaybeDispatchCadence(
	directory: string,
	sessionID: string,
	counter: 'toolCalls' | 'architectTurns',
	config: PluginConfig,
	options: {
		activeAgent?: string;
		// Optional dispatcher override for tests.
		dispatch?: typeof dispatchFullAutoOversight;
	} = {},
): CadenceDecision | undefined {
	const decision = tickAndEvaluate(directory, sessionID, counter, config);
	if (!decision || !decision.shouldEscalate) return decision;
	if (cadenceDispatchInFlight.has(sessionID)) return decision;

	const runState = loadFullAutoRunState(directory, sessionID);
	if (!runState || runState.status !== 'running') return decision;

	const oversightAgentName = resolveOversightAgentName(options.activeAgent);
	const criticModel =
		config.full_auto?.critic_model ??
		config.agents?.critic?.model ??
		'opencode/big-pickle';

	cadenceDispatchInFlight.add(sessionID);
	const dispatcher = options.dispatch ?? dispatchFullAutoOversight;
	void dispatcher({
		directory,
		sessionID,
		trigger: `cadence:${decision.triggers.map((t) => t.kind).join(',')}`,
		triggerSource: 'cadence',
		phase: runState.currentPhase,
		taskID: runState.currentTaskID ?? undefined,
		planID: runState.planID,
		actionContext: {
			counters: runState.counters,
			denialCounters: runState.denialCounters,
			triggers: decision.triggers,
		},
		criticModel,
		oversightAgentName,
		fullAutoConfig: {
			fail_closed: config.full_auto?.fail_closed !== false,
		},
	})
		.catch((err) => {
			// Adversarial review M6 partial fix: log + best-effort pause.
			// dispatchFullAutoOversight should pause durable state on its own
			// fail-closed branches; if the throw happened BEFORE those
			// branches (e.g. pauseFullAutoRun itself threw because state.ts
			// persistence failed), surface the error so the operator can
			// see the degraded oversight pipeline. Crashing the hook chain
			// is still avoided — the next tool call will see the unchanged
			// run state and attempt enforcement on the next cadence tick.
			logger.error(
				`[full-auto/cadence] dispatch threw past dispatcher's own fail-closed branches: ${err instanceof Error ? err.message : String(err)}`,
			);
		})
		.finally(() => {
			cadenceDispatchInFlight.delete(sessionID);
			// Adversarial review C3 fix: do NOT call
			// `recordFullAutoOversight('CADENCE', 'cadence-tick')` here. The
			// dispatcher already records the actual verdict when it succeeds
			// (or 'BLOCKED' when persistence fails). Writing 'CADENCE' in
			// .finally() unconditionally CLOBBERS the real verdict on
			// `lastOversightVerdict`/`lastOversightReason`, breaking the
			// audit trail that phase-approval and operators consult.
		});

	return decision;
}

export const _internals: {
	clearInFlight: () => void;
	inFlight: Set<string>;
} = {
	clearInFlight: () => cadenceDispatchInFlight.clear(),
	inFlight: cadenceDispatchInFlight,
};
