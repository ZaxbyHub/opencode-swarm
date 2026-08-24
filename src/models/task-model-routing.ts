import {
	advanceScopedModelSelection,
	clearScopedModelSelectionsForSession,
	getScopedModelSelectionSnapshot,
	type ModelOverrideParts,
	normalizeModelChain,
	resetScopedModelSelectionStateForTests,
	resolveScopedModelSelection,
	type ScopedModelOverrideKey,
} from './model-override-state.js';

const MAX_PENDING_TASK_MODEL_ROUTES = 256;
const PENDING_TASK_MODEL_ROUTE_TTL_MS = 30 * 60_000;

export interface PendingTaskModelRouteInput {
	parentSessionID: string;
	invocationID: string;
	callID: string;
	role: string;
	actionDigest: string;
	swarmID?: string;
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

export function clearPendingTaskModelRoutesForSession(sessionID: string): void {
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
	clearScopedModelSelectionsForSession(normalizedSessionID);
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
	resetScopedModelSelectionStateForTests();
}

export const resetTaskModelRoutingStateForTests = clearAllTaskModelRoutingState;
