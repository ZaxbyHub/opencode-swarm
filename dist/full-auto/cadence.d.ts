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
import { dispatchFullAutoOversight } from './oversight';
import { type FullAutoRunState } from './state';
export type CadenceTrigger = {
    kind: 'tool_calls';
    threshold: number;
} | {
    kind: 'architect_turns';
    threshold: number;
} | {
    kind: 'minutes';
    threshold: number;
    elapsedMinutes: number;
} | {
    kind: 'consecutive_no_progress';
    threshold: number;
} | {
    kind: 'denials_near_limit';
    consecutive: number;
    max: number;
};
export interface CadenceDecision {
    shouldEscalate: boolean;
    triggers: CadenceTrigger[];
}
export declare function evaluateFullAutoCadence(state: FullAutoRunState, config: PluginConfig, now?: number): CadenceDecision;
/**
 * Convenience: increment the relevant counter and evaluate cadence in one
 * call. Returns undefined when there is no active Full-Auto run.
 */
export declare function tickAndEvaluate(directory: string, sessionID: string, counter: 'toolCalls' | 'architectTurns', config: PluginConfig): CadenceDecision | undefined;
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
export declare function tickAndMaybeDispatchCadence(directory: string, sessionID: string, counter: 'toolCalls' | 'architectTurns', config: PluginConfig, options?: {
    activeAgent?: string;
    dispatch?: typeof dispatchFullAutoOversight;
}): CadenceDecision | undefined;
export declare const _internals: {
    clearInFlight: () => void;
    inFlight: Set<string>;
};
