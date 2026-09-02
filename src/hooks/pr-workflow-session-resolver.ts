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

			let parent = parents.get(current);
			if (!parent) {
				parent = findByCorrelationId(
					options.directory,
					current,
				)?.parentSessionId;
			}
			if (!parent && session?.get) {
				const result = await session.get({
					path: { id: current },
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
						`pr-workflow-session-resolver: session.get(${current}) failed while walking ancestor depth`,
						describeSessionGetError(result.error),
					);
				}
			}
			if (!parent) return original;
			rememberBounded(parents, current, parent);
			current = parent;
		}
		return original;
	};

	return { observeEvent, resolve };
}
