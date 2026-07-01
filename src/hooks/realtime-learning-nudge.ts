import type { PluginConfig } from '../config';

const MAX_TRACKED_LEARNING_NUDGE_SESSIONS = 500;
const DEFAULT_LEARNING_NUDGE_FIRST_TOOL_CALLS = 10;
const DEFAULT_LEARNING_NUDGE_REPEAT_TOOL_CALLS = 25;

export const REALTIME_LEARNING_NUDGE_ID_PREFIX = 'realtime-learning-nudge';

type RealtimeLearningNudgeConfig = NonNullable<
	NonNullable<PluginConfig['knowledge']>['realtime_learning_nudge']
>;

interface RealtimeLearningNudgeState {
	observedToolCallCount: number;
	lastNudgedAtToolCallCount: number;
}

const realtimeLearningNudgeBySession = new Map<
	string,
	RealtimeLearningNudgeState
>();

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0
		? Number(value)
		: fallback;
}

function rememberSession(
	sessionID: string,
	state: RealtimeLearningNudgeState,
): void {
	if (realtimeLearningNudgeBySession.has(sessionID)) {
		realtimeLearningNudgeBySession.delete(sessionID);
	}
	realtimeLearningNudgeBySession.set(sessionID, state);

	while (
		realtimeLearningNudgeBySession.size > MAX_TRACKED_LEARNING_NUDGE_SESSIONS
	) {
		const oldestSessionID = realtimeLearningNudgeBySession.keys().next().value;
		if (oldestSessionID === undefined) break;
		realtimeLearningNudgeBySession.delete(oldestSessionID);
	}
}

export function recordRealtimeLearningToolCall(sessionID: string): number {
	const prior = realtimeLearningNudgeBySession.get(sessionID);
	const nextState = {
		observedToolCallCount: (prior?.observedToolCallCount ?? 0) + 1,
		lastNudgedAtToolCallCount: prior?.lastNudgedAtToolCallCount ?? 0,
	};
	rememberSession(sessionID, nextState);
	return nextState.observedToolCallCount;
}

export function getRealtimeLearningToolCallCount(sessionID?: string): number {
	if (!sessionID) return 0;
	return (
		realtimeLearningNudgeBySession.get(sessionID)?.observedToolCallCount ?? 0
	);
}

export function shouldInjectRealtimeLearningNudge(args: {
	sessionID?: string;
	config?: RealtimeLearningNudgeConfig;
}): boolean {
	if (!args.sessionID) return false;
	if (args.config?.enabled === false) return false;

	const state = realtimeLearningNudgeBySession.get(args.sessionID);
	const toolCallCount = state?.observedToolCallCount ?? 0;
	const firstAfterToolCalls = positiveIntegerOrDefault(
		args.config?.first_after_tool_calls,
		DEFAULT_LEARNING_NUDGE_FIRST_TOOL_CALLS,
	);
	const repeatAfterToolCalls = positiveIntegerOrDefault(
		args.config?.repeat_after_tool_calls,
		DEFAULT_LEARNING_NUDGE_REPEAT_TOOL_CALLS,
	);

	if (toolCallCount < firstAfterToolCalls) return false;
	if (!state || state.lastNudgedAtToolCallCount === 0) return true;

	return (
		toolCallCount - state.lastNudgedAtToolCallCount >= repeatAfterToolCalls
	);
}

export function recordRealtimeLearningNudge(sessionID: string): void {
	const prior = realtimeLearningNudgeBySession.get(sessionID);
	if (!prior) return;
	rememberSession(sessionID, {
		...prior,
		lastNudgedAtToolCallCount: prior.observedToolCallCount,
	});
}

export function resetRealtimeLearningNudgeState(): void {
	realtimeLearningNudgeBySession.clear();
}

export function clearRealtimeLearningNudgeSession(sessionID: string): void {
	realtimeLearningNudgeBySession.delete(sessionID);
}

export function getTrackedRealtimeLearningNudgeSessionCount(): number {
	return realtimeLearningNudgeBySession.size;
}

export function buildRealtimeLearningNudge(args: {
	currentPhase: number;
	toolCallCount: number;
}): string {
	return [
		'[SWARM LEARNING NUDGE]',
		`Session has ${args.toolCallCount} tool calls in phase ${args.currentPhase}. Before continuing, decide whether the current work revealed a durable procedural lesson.`,
		'- If yes, call knowledge_add now with actionable when/then/scope fields so later turns can retrieve it.',
		'- If the signal needs review across evidence, repeated outcomes, or generated-skill health, let the curator phase/postmortem path handle it; curator can emit knowledge_application_findings and skill_candidates without activating skills.',
		'- Prefer reinforcing existing knowledge over noisy one-offs. Do not save transient setup failures, stale negative tool claims, or repo-specific accidents without a reusable trigger.',
		'- If repeated KNOWLEDGE_IGNORED/VIOLATED outcomes or stale generated skills are accumulating, use skill_improve only when enabled/approved; generated skills stay proposal/draft gated and must not auto-activate.',
		'- If there is nothing durable, continue without adding knowledge.',
	].join('\n');
}
