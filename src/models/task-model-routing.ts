import {
	advanceScopedModelSelection,
	clearScopedModelSelectionsForSession,
	getScopedModelSelectionSnapshot,
	type ModelOverrideParts,
	normalizeModelChain,
	peekScopedModelSelection,
	resetScopedModelSelectionStateForTests,
	resolveScopedModelSelection,
	type ScopedModelOverrideKey,
} from './model-override-state.js';

const MAX_PENDING_TASK_MODEL_ROUTES = 256;
const PENDING_TASK_MODEL_ROUTE_TTL_MS = 30 * 60_000;

/**
 * Issue #2989 review (F-001): last-seen chat-boundary agent name per session.
 * The session.error no-route branch must resolve the fallback chain from the
 * SAME agent identity the chat boundary uses. The shared
 * `swarmState.activeAgent` pointer is reset to the bare orchestrator name by
 * every Task-tool completion (src/index.ts), so for a swarm-prefixed primary
 * agent (e.g. `cloud_architect`) a same-turn provider error after a Task
 * returned would otherwise resolve the wrong (or an empty) chain and the
 * fallback silently no-ops. Written on every `chat.message`; FIFO-bounded
 * like the route maps; cleared on session end (never on invocation
 * boundaries — the agent name does not change between turns).
 */
const MAX_SESSION_CHAT_AGENTS = 256;
const sessionChatAgentBySession = new Map<string, string>();

export interface PendingTaskModelRouteInput {
	parentSessionID: string;
	invocationID: string;
	callID: string;
	role: string;
	actionDigest: string;
	swarmID?: string;
	/**
	 * The dispatched agent spelling (subagent_type), whitespace-trimmed only.
	 * Issue #3331: the session.error advance arm resolves the chain from this
	 * name first, so both boundary sides normalize the SAME identity and a
	 * chain-signature mismatch cannot silently discard a completed advance
	 * (the stripped `role` alone can resolve a different primary than the
	 * full name the chat boundary sees).
	 */
	agentName?: string;
}

export interface BindTaskModelRouteChildInput {
	parentSessionID: string;
	callID: string;
	childSessionID: string;
}

export interface AdvanceTaskModelRouteInput {
	childSessionID: string;
	role: string;
	actionDigest: string;
	primaryModel?: string;
	fallbackModels?: Iterable<string | null | undefined>;
	expectedGeneration?: number;
	now?: number;
}

export interface ResolveTaskChatModelOverrideInput {
	childSessionID: string;
	role: string;
	primaryModel?: string;
	fallbackModels?: Iterable<string | null | undefined>;
	actionDigest?: string;
	lookupParentSessionID?: (
		childSessionID: string,
	) => Promise<string | undefined>;
	now?: number;
}

export interface TaskChatModelOverrideResolution {
	status:
		| 'override'
		| 'primary'
		| 'exhausted'
		| 'missing'
		| 'ambiguous'
		| 'mismatch';
	model?: ModelOverrideParts;
	modelString?: string;
	fallbackIndex?: number;
	generation?: number;
	scope?: ScopedModelOverrideKey;
	route?: PendingTaskModelRouteSnapshotEntry;
}

export interface TaskModelRouteAdvanceResult {
	accepted: boolean;
	exhausted: boolean;
	fallbackIndex: number;
	/**
	 * The normalized chain's model string for the advanced entry (#3029 review
	 * F-003). `fallbackIndex` counts positions in `normalizeModelChain` output
	 * (deduped, parse-filtered), so indexing the RAW fallback list by it can
	 * mismap when a fallback duplicates the primary or fails to parse. Always
	 * apply `modelString` when present.
	 */
	modelString?: string;
	generation: number;
	scope: ScopedModelOverrideKey;
	route?: PendingTaskModelRouteSnapshotEntry;
}

export interface PendingTaskModelRouteSnapshotEntry {
	parentSessionID: string;
	invocationID: string;
	callID: string;
	role: string;
	actionDigest: string;
	swarmID?: string;
	/** Dispatched agent spelling, trimmed (issue #3331 advance identity). */
	agentName?: string;
	childSessionID?: string;
	updatedAt: number;
}

type PendingTaskModelRoute = PendingTaskModelRouteSnapshotEntry;

const routesByParentCall = new Map<string, PendingTaskModelRoute>();
const routeKeyByChildSession = new Map<string, string>();

function normalizeText(value: string | undefined): string {
	return value?.trim() ?? '';
}

function parentCallKey(parentSessionID: string, callID: string): string {
	return `${normalizeText(parentSessionID)}\u241f${normalizeText(callID)}`;
}

function normalizeRoute(
	input: PendingTaskModelRouteInput,
	now: number,
): PendingTaskModelRoute {
	return {
		parentSessionID: normalizeText(input.parentSessionID),
		invocationID: normalizeText(input.invocationID),
		callID: normalizeText(input.callID),
		role: normalizeText(input.role),
		actionDigest: normalizeText(input.actionDigest),
		swarmID: normalizeText(input.swarmID) || undefined,
		agentName: normalizeText(input.agentName) || undefined,
		updatedAt: now,
	};
}

function routeScope(route: PendingTaskModelRoute): ScopedModelOverrideKey {
	return {
		sessionID: route.parentSessionID,
		invocationID: route.invocationID,
		swarmID: route.swarmID,
		role: route.role,
	};
}

function upsertRoute(route: PendingTaskModelRoute): void {
	const key = parentCallKey(route.parentSessionID, route.callID);
	const prior = routesByParentCall.get(key);
	if (prior?.childSessionID) {
		routeKeyByChildSession.delete(prior.childSessionID);
	}
	routesByParentCall.delete(key);
	routesByParentCall.set(key, route);
	if (route.childSessionID) {
		routeKeyByChildSession.set(route.childSessionID, key);
	}
}

function pruneRoutes(now: number): void {
	for (const [key, route] of routesByParentCall) {
		if (now - route.updatedAt > PENDING_TASK_MODEL_ROUTE_TTL_MS) {
			routesByParentCall.delete(key);
			if (route.childSessionID) {
				routeKeyByChildSession.delete(route.childSessionID);
			}
		}
	}
	while (routesByParentCall.size > MAX_PENDING_TASK_MODEL_ROUTES) {
		const oldestKey = routesByParentCall.keys().next().value;
		if (typeof oldestKey !== 'string') break;
		const route = routesByParentCall.get(oldestKey);
		routesByParentCall.delete(oldestKey);
		if (route?.childSessionID) {
			routeKeyByChildSession.delete(route.childSessionID);
		}
	}
}

function matchingRouteForParent(
	parentSessionID: string,
	role: string,
	actionDigest?: string,
): PendingTaskModelRoute | 'ambiguous' | undefined {
	let match: PendingTaskModelRoute | undefined;
	const normalizedParent = normalizeText(parentSessionID);
	const normalizedRole = normalizeText(role);
	const normalizedDigest = normalizeText(actionDigest);
	for (const route of routesByParentCall.values()) {
		if (
			route.parentSessionID !== normalizedParent ||
			route.role !== normalizedRole
		) {
			continue;
		}
		if (normalizedDigest && route.actionDigest !== normalizedDigest) continue;
		if (match) return 'ambiguous';
		match = route;
	}
	return match;
}

function touchRoute(route: PendingTaskModelRoute, now: number): void {
	route.updatedAt = now;
	upsertRoute(route);
}

export function registerPendingTaskModelRoute(
	input: PendingTaskModelRouteInput,
	now = Date.now(),
): PendingTaskModelRouteSnapshotEntry {
	pruneRoutes(now);
	const route = normalizeRoute(input, now);
	upsertRoute(route);
	return { ...route };
}

export function bindPendingTaskModelRouteChild(
	input: BindTaskModelRouteChildInput,
	now = Date.now(),
): PendingTaskModelRouteSnapshotEntry | undefined {
	pruneRoutes(now);
	const key = parentCallKey(input.parentSessionID, input.callID);
	const route = routesByParentCall.get(key);
	if (!route) return undefined;
	if (route.childSessionID) {
		routeKeyByChildSession.delete(route.childSessionID);
	}
	route.childSessionID = normalizeText(input.childSessionID);
	touchRoute(route, now);
	return { ...route };
}

export function advancePendingTaskModelRoute(
	input: AdvanceTaskModelRouteInput,
): TaskModelRouteAdvanceResult | undefined {
	const now = input.now ?? Date.now();
	pruneRoutes(now);
	const routeKey = routeKeyByChildSession.get(
		normalizeText(input.childSessionID),
	);
	if (!routeKey) return undefined;
	const route = routesByParentCall.get(routeKey);
	if (
		!route ||
		route.role !== normalizeText(input.role) ||
		route.actionDigest !== normalizeText(input.actionDigest)
	) {
		return undefined;
	}
	const chain = normalizeModelChain(
		input.primaryModel,
		input.fallbackModels ?? [],
	);
	const selection = resolveScopedModelSelection(routeScope(route), chain, now);
	const advanced = advanceScopedModelSelection(
		routeScope(route),
		chain,
		input.expectedGeneration ?? selection.generation,
		now,
	);
	touchRoute(route, now);
	return {
		accepted: advanced.accepted,
		exhausted: advanced.selection.exhausted,
		fallbackIndex: advanced.selection.fallbackIndex,
		modelString: advanced.selection.modelString,
		generation: advanced.selection.generation,
		scope: routeScope(route),
		route: { ...route },
	};
}

export async function resolveTaskChatModelOverride(
	input: ResolveTaskChatModelOverrideInput,
): Promise<TaskChatModelOverrideResolution> {
	const now = input.now ?? Date.now();
	pruneRoutes(now);
	const normalizedChild = normalizeText(input.childSessionID);
	const normalizedRole = normalizeText(input.role);
	let route: PendingTaskModelRoute | undefined;
	const boundKey = routeKeyByChildSession.get(normalizedChild);
	if (boundKey) {
		route = routesByParentCall.get(boundKey);
	}
	let resolvedParentSessionID: string | undefined;
	if (!route && input.lookupParentSessionID) {
		resolvedParentSessionID = normalizeText(
			await input.lookupParentSessionID(normalizedChild),
		);
		if (resolvedParentSessionID) {
			const match = matchingRouteForParent(
				resolvedParentSessionID,
				normalizedRole,
				input.actionDigest,
			);
			if (match === 'ambiguous') {
				return { status: 'ambiguous' };
			}
			route = match;
		}
	}
	if (!route) return { status: 'missing' };
	if (
		route.role !== normalizedRole ||
		(input.actionDigest &&
			route.actionDigest !== normalizeText(input.actionDigest))
	) {
		return { status: 'mismatch', route: { ...route } };
	}
	if (
		resolvedParentSessionID &&
		route.parentSessionID !== resolvedParentSessionID
	) {
		return { status: 'mismatch', route: { ...route } };
	}
	const chain = normalizeModelChain(
		input.primaryModel,
		input.fallbackModels ?? [],
	);
	const selection = resolveScopedModelSelection(routeScope(route), chain, now);
	touchRoute(route, now);
	if (selection.exhausted) {
		return {
			status: 'exhausted',
			fallbackIndex: selection.fallbackIndex,
			generation: selection.generation,
			scope: routeScope(route),
			route: { ...route },
		};
	}
	if (selection.fallbackIndex === 0 || !selection.model) {
		return {
			status: 'primary',
			fallbackIndex: selection.fallbackIndex,
			generation: selection.generation,
			scope: routeScope(route),
			route: { ...route },
		};
	}
	return {
		status: 'override',
		model: selection.model,
		modelString: selection.modelString,
		fallbackIndex: selection.fallbackIndex,
		generation: selection.generation,
		scope: routeScope(route),
		route: { ...route },
	};
}

export interface AdvanceSessionFallbackSelectionInput {
	sessionID: string;
	role: string;
	swarmID?: string;
	primaryModel?: string;
	fallbackModels?: Iterable<string | null | undefined>;
	now?: number;
}

export interface SessionFallbackAdvanceResult {
	accepted: boolean;
	exhausted: boolean;
	fallbackIndex: number;
	modelString?: string;
	scope: ScopedModelOverrideKey;
}

export interface ResolveSessionChatModelOverrideInput {
	sessionID: string;
	role: string;
	swarmID?: string;
	primaryModel?: string;
	fallbackModels?: Iterable<string | null | undefined>;
	now?: number;
}

export interface SessionChatModelOverrideResolution {
	status: 'override' | 'primary' | 'exhausted' | 'missing';
	model?: ModelOverrideParts;
	modelString?: string;
	fallbackIndex?: number;
}

/**
 * Issue #2989: sentinel invocationID for the primary-session (host-driven)
 * fallback scope. Task routes always carry digit-string invocation IDs
 * (`String(activeInvocationId ?? 0)`), so the empty string can never collide
 * with a route's scope key.
 */
const PRIMARY_SESSION_INVOCATION_ID = '';

function sessionFallbackScope(
	input:
		| AdvanceSessionFallbackSelectionInput
		| ResolveSessionChatModelOverrideInput,
): ScopedModelOverrideKey {
	return {
		sessionID: normalizeText(input.sessionID),
		invocationID: PRIMARY_SESSION_INVOCATION_ID,
		swarmID: normalizeText(input.swarmID) || undefined,
		role: normalizeText(input.role),
	};
}

/**
 * Issue #2989: advance the primary-session (host-driven) fallback chain for
 * a session with no Task route. Seed-then-advance mirrors
 * {@link advancePendingTaskModelRoute}'s flow: `resolveScopedModelSelection`
 * seeds a fresh entry at fallbackIndex 0, `advanceScopedModelSelection` moves
 * it forward (clamped at chain end, where `exhausted` becomes true).
 */
export function advanceSessionFallbackSelection(
	input: AdvanceSessionFallbackSelectionInput,
): SessionFallbackAdvanceResult {
	const now = input.now ?? Date.now();
	const scope = sessionFallbackScope(input);
	const chain = normalizeModelChain(
		input.primaryModel,
		input.fallbackModels ?? [],
	);
	const selection = resolveScopedModelSelection(scope, chain, now);
	const advanced = advanceScopedModelSelection(
		scope,
		chain,
		selection.generation,
		now,
	);
	return {
		accepted: advanced.accepted,
		exhausted: advanced.selection.exhausted,
		fallbackIndex: advanced.selection.fallbackIndex,
		modelString: advanced.selection.modelString,
		scope,
	};
}

/**
 * Issue #2989: non-seeding read of the primary-session fallback selection
 * for the chat-boundary override. `missing` covers no-selection/no-fallbacks
 * (and stale-signature entries, which read as absent and are left alone);
 * `exhausted` never throws here — a primary session's user message must
 * never be blocked by the plugin.
 */
export function resolveSessionChatModelOverride(
	input: ResolveSessionChatModelOverrideInput,
): SessionChatModelOverrideResolution {
	const now = input.now ?? Date.now();
	const scope = sessionFallbackScope(input);
	const chain = normalizeModelChain(
		input.primaryModel,
		input.fallbackModels ?? [],
	);
	if (chain.fallbacks.length === 0) return { status: 'missing' };
	const selection = peekScopedModelSelection(scope, chain, now);
	if (selection === undefined) return { status: 'missing' };
	if (selection.exhausted) {
		return {
			status: 'exhausted',
			fallbackIndex: selection.fallbackIndex,
		};
	}
	if (selection.fallbackIndex === 0 || !selection.model) {
		return {
			status: 'primary',
			fallbackIndex: selection.fallbackIndex,
		};
	}
	return {
		status: 'override',
		model: selection.model,
		modelString: selection.modelString,
		fallbackIndex: selection.fallbackIndex,
	};
}

/**
 * Issue #2989 review (F-001): record the exact `input.agent` string at the
 * chat boundary so the session.error no-route branch can resolve the same
 * identity (the activeAgent pointer is reset by Task-tool completions).
 */
export function recordSessionChatAgent(
	sessionID: string,
	agentName: string,
): void {
	const session = normalizeText(sessionID);
	const agent = normalizeText(agentName);
	if (!session || !agent) return;
	while (sessionChatAgentBySession.size >= MAX_SESSION_CHAT_AGENTS) {
		const oldest = sessionChatAgentBySession.keys().next().value;
		if (typeof oldest !== 'string') break;
		sessionChatAgentBySession.delete(oldest);
	}
	sessionChatAgentBySession.delete(session);
	sessionChatAgentBySession.set(session, agent);
}

/**
 * Issue #2989 review (F-001): the chat-boundary-recorded agent name for a
 * session, or undefined when no chat.message has been seen for it in this
 * process.
 */
export function resolveSessionChatAgent(sessionID: string): string | undefined {
	const session = normalizeText(sessionID);
	if (!session) return undefined;
	const agent = sessionChatAgentBySession.get(session);
	if (agent === undefined) return undefined;
	// LRU touch: re-insert so active sessions are evicted last.
	sessionChatAgentBySession.delete(session);
	sessionChatAgentBySession.set(session, agent);
	return agent;
}

export function clearPendingTaskModelRoutesForSession(
	sessionID: string,
	mode: 'session' | 'invocation' = 'session',
): void {
	const normalizedSessionID = normalizeText(sessionID);
	for (const [key, route] of routesByParentCall) {
		if (
			route.parentSessionID === normalizedSessionID ||
			route.childSessionID === normalizedSessionID
		) {
			routesByParentCall.delete(key);
			if (route.childSessionID) {
				routeKeyByChildSession.delete(route.childSessionID);
			}
		}
	}
	// Issue #2989: the per-invocation boundary clear must not reset a
	// primary session's sticky fallback selection (a provider quota does not
	// heal between turns); only the session-end clear removes it.
	clearScopedModelSelectionsForSession(normalizedSessionID, {
		primaryScopes: mode === 'session',
	});
	if (mode === 'session') {
		sessionChatAgentBySession.delete(normalizedSessionID);
	}
}

export function getPendingTaskModelRouteSnapshot(): readonly PendingTaskModelRouteSnapshotEntry[] {
	return [...routesByParentCall.values()].map((route) => ({ ...route }));
}

export function getTaskModelRoutingStateSnapshot(): {
	routes: readonly PendingTaskModelRouteSnapshotEntry[];
	scopedSelections: ReturnType<typeof getScopedModelSelectionSnapshot>;
} {
	return {
		routes: getPendingTaskModelRouteSnapshot(),
		scopedSelections: getScopedModelSelectionSnapshot(),
	};
}

export function clearAllTaskModelRoutingState(): void {
	routesByParentCall.clear();
	routeKeyByChildSession.clear();
	sessionChatAgentBySession.clear();
	resetScopedModelSelectionStateForTests();
}

export const resetTaskModelRoutingStateForTests = clearAllTaskModelRoutingState;
