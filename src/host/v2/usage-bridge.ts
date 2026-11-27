/**
 * OpenCode 2.3 durable per-step accounting, separate from the ephemeral
 * session.usage.updated projection. This state is bounded and only accepts
 * validated host-mapped step records. A replay of a durable step is idempotent.
 * No usage for the architect is assigned to a child without an exact session ID.
 */

export interface V2TokenTotals {
	input: number;
	output: number;
	reasoning: number;
	cache: { read: number; write: number };
}

export interface V2SessionUsage {
	role: 'assistant';
	sessionID: string;
	cost: number;
	tokens: V2TokenTotals;
	/** No provider report is replaced by a guessed zero. */
	swarmV2Aggregated: true;
}

interface UsageEntry {
	events: Set<string>;
	value: V2SessionUsage;
	unusable: boolean;
}

const MAX_SESSIONS = 200;
const MAX_EVENTS_PER_SESSION = 1024;
const totalsBySession = new Map<string, UsageEntry>();
const ID_LIMIT = 256;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
	return (
		typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT
	);
}
function n(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function add(a: number, b: number): number | undefined {
	const s = a + b;
	return Number.isFinite(s) && s <= Number.MAX_SAFE_INTEGER ? s : undefined;
}

/**
 * Returns undefined for duplicate, incomplete, malformed or over-limit data.
 * Invalid records do not overwrite an earlier good total. An exhausted session
 * is kept as an unusable marker until task completion rather than forgetting
 * event ids and accidentally counting subsequent replays twice.
 */
export function ingestV2StepUsage(part: unknown): V2SessionUsage | undefined {
	if (!record(part) || part.swarmV2UsageStep !== true) return undefined;
	const sessionID = part.sessionID;
	const eventId = part.swarmV2EventId;
	const tokens = part.tokens;
	if (
		!id(sessionID) ||
		!id(eventId) ||
		!record(tokens) ||
		!record(tokens.cache)
	)
		return undefined;
	if (
		!n(part.cost) ||
		!n(tokens.input) ||
		!n(tokens.output) ||
		!n(tokens.reasoning) ||
		!n(tokens.cache.read) ||
		!n(tokens.cache.write)
	)
		return undefined;

	let entry = totalsBySession.get(sessionID);
	if (!entry) {
		if (totalsBySession.size >= MAX_SESSIONS) return undefined;
		entry = {
			events: new Set<string>(),
			unusable: false,
			value: {
				role: 'assistant',
				sessionID,
				cost: 0,
				tokens: {
					input: 0,
					output: 0,
					reasoning: 0,
					cache: { read: 0, write: 0 },
				},
				swarmV2Aggregated: true,
			},
		};
		totalsBySession.set(sessionID, entry);
	}
	if (entry.unusable || entry.events.has(eventId)) return undefined;
	if (entry.events.size >= MAX_EVENTS_PER_SESSION) {
		entry.unusable = true;
		return undefined;
	}
	const current = entry.value;
	const newCost = add(current.cost, part.cost);
	const newInput = add(current.tokens.input, tokens.input);
	const newOutput = add(current.tokens.output, tokens.output);
	const newReasoning = add(current.tokens.reasoning, tokens.reasoning);
	const newRead = add(current.tokens.cache.read, tokens.cache.read);
	const newWrite = add(current.tokens.cache.write, tokens.cache.write);
	if (
		newCost === undefined ||
		newInput === undefined ||
		newOutput === undefined ||
		newReasoning === undefined ||
		newRead === undefined ||
		newWrite === undefined
	) {
		entry.unusable = true;
		return undefined;
	}
	entry.events.add(eventId);
	entry.value = {
		role: 'assistant',
		sessionID,
		cost: newCost,
		tokens: {
			input: newInput,
			output: newOutput,
			reasoning: newReasoning,
			cache: { read: newRead, write: newWrite },
		},
		swarmV2Aggregated: true,
	};
	return entry.value;
}

export function forgetV2StepUsage(sessionID: string): void {
	totalsBySession.delete(sessionID);
}
export function clearV2StepUsage(): void {
	totalsBySession.clear();
}
