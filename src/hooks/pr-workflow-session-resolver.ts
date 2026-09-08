import { findByCorrelationId } from '../background/pending-delegations.js';
import { warn } from '../utils/logger.js';
import { readPrWorkflowGateState } from './pr-workflow-gate.js';

/** Bounded to a short, loggable message — never store the raw error object. */
const MAX_SESSION_GET_ERROR_LENGTH = 200;

/** Extracts a bounded, human-readable reason from a session.get() error channel. */
function describeSessionGetError(error: unknown): string {
	let raw: string;
	if (error instanceof Error) {
		raw = error.message;
	} else if (typeof error === 'string') {
		raw = error;
	} else if (error && typeof error === 'object') {
		const maybeMessage = (error as { message?: unknown }).message;
		raw =
			typeof maybeMessage === 'string' ? maybeMessage : JSON.stringify(error);
	} else {
		raw = String(error);
	}
	return raw.length > MAX_SESSION_GET_ERROR_LENGTH
		? `${raw.slice(0, MAX_SESSION_GET_ERROR_LENGTH)}...`
		: raw;
}

const MAX_PARENT_DEPTH = 16;
const MAX_TRACKED_SESSION_PARENTS = 512;

interface SessionGetResult {
	data?: { id?: unknown; parentID?: unknown };
	error?: unknown;
}

interface SessionClient {
	get?: (args: unknown) => Promise<SessionGetResult>;
}

interface ResolverClient {
	session?: unknown;
}

interface SessionEvent {
	type?: unknown;
	properties?: {
		info?: { id?: unknown; parentID?: unknown };
	};
}

function rememberBounded(
	parents: Map<string, string>,
	childSessionID: string,
	parentSessionID: string,
): void {
	parents.delete(childSessionID);
	parents.set(childSessionID, parentSessionID);
	while (parents.size > MAX_TRACKED_SESSION_PARENTS) {
		const oldest = parents.keys().next().value;
		if (typeof oldest !== 'string') break;
		parents.delete(oldest);
	}
}

/**
 * Shared single-hop parent resolution (issue #2511 workstream D): observed
 * parent map first, then the durable correlation record, then — only when
 * `allowHostFallback` — the host `session.get` API. Both the enforcement
 * resolver (`createPrWorkflowSessionResolver().resolve`) and the typed
 * observation walk (`resolvePrWorkflowControllerSession`) route through this
 * one helper, so status and enforcement can never disagree about HOW a
 * session's parent is resolved — only about how a failed walk is reported.
 */
async function lookupSessionParent(options: {
	directory: string;
	sessionID: string;
	parents?: Map<string, string>;
	session?: SessionClient;
	allowHostFallback: boolean;
}): Promise<string | null> {
	let parent = options.parents?.get(options.sessionID);
	if (!parent) {
		const recorded = findByCorrelationId(
			options.directory,
			options.sessionID,
		)?.parentSessionId;
		if (typeof recorded === 'string' && recorded.trim()) {
			parent = recorded.trim();
		}
	}
	if (!parent && options.allowHostFallback && options.session?.get) {
		const result = await options.session.get({
			path: { id: options.sessionID },
			query: { directory: options.directory },
		});
		if (result?.error == null) {
			const candidate = result?.data?.parentID;
			if (typeof candidate === 'string' && candidate.trim()) {
				parent = candidate.trim();
			}
		} else {
			// Forward WHY session.get() failed instead of discarding
			// result.error after reading it only as a boolean (issue #2349
			// follow-up) — debug-gated, so no unbounded log growth.
			warn(
				`pr-workflow-session-resolver: session.get(${options.sessionID}) failed while walking ancestor depth`,
				describeSessionGetError(result.error),
			);
		}
	}
	return parent ?? null;
}

/**
 * Typed outcome of the bounded observation walk (issue #2511 workstream D).
 * `gate-owner` carries the caller's gate payload for the resolved owner;
 * `no-gate` means the queried session itself has no parent linkage at the
 * first hop (an ordinary gate-less session, NOT uncertainty); `uncertain`
 * means the delegation chain is missing, cyclic, or depth-exhausted and must
 * be reported as unknown — never as absence.
 */
export type PrWorkflowControllerResolution<T> =
	| { kind: 'gate-owner'; sessionID: string; gate: T }
	| { kind: 'no-gate'; sessionID: string }
	| { kind: 'uncertain'; sessionID: null };

/**
 * Bounded ancestry walk with typed uncertainty (issue #2511 workstream D).
 *
 * The same identity-resolution machinery the enforcement resolver uses
 * (parent map -> `findByCorrelationId` -> host `session.get`), exposed for
 * observation callers that must distinguish "no gate" from "cannot know".
 * The gate-existence predicate is caller-supplied so status can use its
 * recovery reader while enforcement keeps its strict reader — identity
 * resolution stays shared, gate reading stays role-appropriate.
 *
 * Null-preservation rule: the host `session.get` fallback may resolve ONLY
 * the first hop (the direct-controller case, where the queried session has no
 * durable correlation record). Every later hop must come from durable
 * records; a missing, cyclic, or depth-exhausted non-first hop resolves to
 * `uncertain` BEFORE any host fallback is consulted.
 */
export async function resolvePrWorkflowControllerSession<T>(options: {
	directory: string;
	sessionID: string;
	/** Gate reader; a truthy payload marks its session as the gate owner. */
	readGate: (sessionID: string) => Promise<T | null | undefined>;
	/** Host client whose `session.get` may resolve only the first hop. */
	client?: ResolverClient;
	/** Optional shared parent map (e.g. the enforcement resolver's own map). */
	parents?: Map<string, string>;
}): Promise<PrWorkflowControllerResolution<T>> {
	const original = options.sessionID.trim();
	if (!original) return { kind: 'no-gate', sessionID: options.sessionID };
	const session = options.client?.session as SessionClient | undefined;
	let current = original;
	const visited = new Set<string>();
	for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
		if (visited.has(current)) {
			return { kind: 'uncertain', sessionID: null };
		}
		visited.add(current);
		const gate = await options.readGate(current);
		if (gate !== null && gate !== undefined) {
			return { kind: 'gate-owner', sessionID: current, gate };
		}
		const parent = await lookupSessionParent({
			directory: options.directory,
			sessionID: current,
			parents: options.parents,
			session,
			allowHostFallback: depth === 0,
		});
		if (!parent) {
			// First hop with no linkage at all is an ordinary gate-less session
			// (the queried session is its own answer). A later hop with no
			// durable record is a broken chain — typed uncertainty.
			if (depth === 0) return { kind: 'no-gate', sessionID: original };
			return { kind: 'uncertain', sessionID: null };
		}
		if (options.parents) rememberBounded(options.parents, current, parent);
		current = parent;
	}
	return { kind: 'uncertain', sessionID: null };
}

/** Resolve a child tool call back to the nearest ancestor owning a durable PR gate. */
export function createPrWorkflowSessionResolver(options: {
	directory: string;
	client?: ResolverClient;
}) {
	const session = options.client?.session as SessionClient | undefined;
	const parents = new Map<string, string>();

	const observeEvent = (input: { event: unknown }): void => {
		const event = input.event as SessionEvent | undefined;
		if (event?.type !== 'session.created' && event?.type !== 'session.updated')
			return;
		const child = event.properties?.info?.id;
		const parent = event.properties?.info?.parentID;
		if (
			typeof child === 'string' &&
			child.trim() &&
			typeof parent === 'string' &&
			parent.trim()
		) {
			rememberBounded(parents, child.trim(), parent.trim());
		}
	};

	const resolve = async (sessionID: string): Promise<string> => {
		const original = sessionID.trim();
		if (!original) return sessionID;
		let current = original;
		const visited = new Set<string>();
		for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
			if (visited.has(current)) break;
			visited.add(current);
			if (await readPrWorkflowGateState(options.directory, current))
				return current;

			const parent = await lookupSessionParent({
				directory: options.directory,
				sessionID: current,
				parents,
				session,
				allowHostFallback: true,
			});
			if (!parent) return original;
			rememberBounded(parents, current, parent);
			current = parent;
		}
		return original;
	};

	return { observeEvent, resolve };
}
