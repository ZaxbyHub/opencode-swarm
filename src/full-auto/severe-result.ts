import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getModifiedFilesForTask } from '../state';
import { normalizePath } from '../utils/path';

export type FullAutoSevereCategory =
	| 'external_instructions'
	| 'out_of_scope_files'
	| 'protected_state_mutation';

export interface FullAutoSevereEnvelopeV1 {
	version: 1;
	kind: 'full_auto_severe';
	parent_session_id: string;
	parent_call_id: string;
	run_generation: number;
	correlation_nonce: string;
	category: FullAutoSevereCategory;
	path_digests?: string[];
	path_count?: number;
	evidence_event_ids?: string[];
}

export interface RegisteredSevereEvent {
	id: string;
	sessionID: string;
	category: string;
	callID?: string;
	generation?: number;
	pathDigests?: string[];
	recordedAt: number;
}

type PendingCorrelation = {
	sessionID: string;
	callID: string;
	generation: number;
	subagent: string;
	createdAt: number;
	nonce: string;
};

type ChildSessionBinding = {
	childSessionID: string;
	parentSessionID: string;
	parentCallID: string;
	generation: number;
	createdAt: number;
};

const MAX_PENDING = 200;
const MAX_EVENTS = 500;
const TTL_MS = 10 * 60_000;

const pendingCorrelations = new Map<string, PendingCorrelation>();
const evidenceEvents = new Map<string, RegisteredSevereEvent>();
const childBindings = new Map<string, ChildSessionBinding>();

function nowMs(): number {
	return Date.now();
}

function digestPath(filePath: string): string {
	return createHash('sha256')
		.update(normalizePath(filePath))
		.digest('hex')
		.slice(0, 16);
}

function sweepMaps(now = nowMs()): void {
	for (const [key, value] of pendingCorrelations) {
		if (now - value.createdAt > TTL_MS) pendingCorrelations.delete(key);
	}
	for (const [key, value] of evidenceEvents) {
		if (now - value.recordedAt > TTL_MS) evidenceEvents.delete(key);
	}
	for (const [key, value] of childBindings) {
		if (now - value.createdAt > TTL_MS) childBindings.delete(key);
	}
	while (pendingCorrelations.size > MAX_PENDING) {
		const oldest = pendingCorrelations.keys().next().value;
		if (!oldest) break;
		pendingCorrelations.delete(oldest);
	}
	while (evidenceEvents.size > MAX_EVENTS) {
		const oldest = evidenceEvents.keys().next().value;
		if (!oldest) break;
		evidenceEvents.delete(oldest);
	}
	while (childBindings.size > MAX_PENDING) {
		const oldest = childBindings.keys().next().value;
		if (!oldest) break;
		childBindings.delete(oldest);
	}
}

export function registerFullAutoSevereCorrelation(input: {
	sessionID: string;
	callID: string;
	generation: number;
	subagent: string;
}): { nonce: string; instruction: string } {
	sweepMaps();
	const nonce = randomUUID();
	const correlation: PendingCorrelation = {
		sessionID: input.sessionID,
		callID: input.callID,
		generation: input.generation,
		subagent: input.subagent,
		createdAt: nowMs(),
		nonce,
	};
	pendingCorrelations.set(`${input.sessionID}:${input.callID}`, correlation);
	const instruction =
		'If and only if you encounter a severe deterministic Full-Auto violation that you can prove from your own execution context, append exactly one SINGLE-LINE JSON object after the marker `FULL_AUTO_SEVERE_RESULT:`. ' +
		`Use this exact correlation: {"version":1,"kind":"full_auto_severe","parent_session_id":"${input.sessionID}","parent_call_id":"${input.callID}","run_generation":${input.generation},"correlation_nonce":"${nonce}","category":"out_of_scope_files","path_digests":["<sha256-16>"],"path_count":1}. Include evidence_event_ids only when your tool result already contains a registered event ID; never invent one. ` +
		'Allowed categories: out_of_scope_files, external_instructions, protected_state_mutation. Never emit more than one marker. Never wrap it in markdown fences. Never paraphrase the envelope in prose.';
	return { nonce, instruction };
}

export function clearFullAutoSevereCorrelation(
	sessionID: string,
	callID: string,
): void {
	pendingCorrelations.delete(`${sessionID}:${callID}`);
}

export function clearFullAutoSevereSession(sessionID: string): void {
	for (const [key, value] of pendingCorrelations) {
		if (value.sessionID === sessionID) pendingCorrelations.delete(key);
	}
	for (const [key, value] of evidenceEvents) {
		if (value.sessionID === sessionID) evidenceEvents.delete(key);
	}
	for (const [key, value] of childBindings) {
		if (
			value.parentSessionID === sessionID ||
			value.childSessionID === sessionID
		) {
			childBindings.delete(key);
		}
	}
}

export function bindFullAutoSevereChildSession(input: {
	childSessionID: string;
	parentSessionID: string;
	parentCallID: string;
	generation: number;
}): void {
	sweepMaps();
	childBindings.set(input.childSessionID, {
		...input,
		createdAt: nowMs(),
	});
}

export function recordFullAutoSevereEvidenceEvent(input: {
	sessionID: string;
	category: string;
	callID?: string;
	generation?: number;
	paths?: string[];
	childSessionID?: string;
}): string {
	sweepMaps();
	const binding = input.childSessionID
		? childBindings.get(input.childSessionID)
		: undefined;
	const id = randomUUID();
	evidenceEvents.set(id, {
		id,
		sessionID: binding?.parentSessionID ?? input.sessionID,
		category: input.category,
		callID: binding?.parentCallID ?? input.callID,
		generation: binding?.generation ?? input.generation,
		pathDigests: (input.paths ?? []).map(digestPath),
		recordedAt: nowMs(),
	});
	return id;
}

export function extractFullAutoSevereEnvelope(
	text: string,
): FullAutoSevereEnvelopeV1 | null {
	if (!text) return null;
	// The protocol requires the marker to be appended. Restrict parsing to the
	// bounded tail so an untrusted multi-megabyte subagent response cannot make
	// severe-result extraction proportional to its total size.
	const boundedText = text.slice(-4096);
	const matches = boundedText.match(/FULL_AUTO_SEVERE_RESULT:/g) ?? [];
	if (matches.length !== 1) return null;
	const markerIndex = boundedText.indexOf('FULL_AUTO_SEVERE_RESULT:');
	if (markerIndex < 0) return null;
	const tail = boundedText
		.slice(markerIndex + 'FULL_AUTO_SEVERE_RESULT:'.length)
		.trimStart()
		.split(/\r?\n/, 1)[0]
		.trim();
	if (tail.length === 0 || tail.length > 4096) return null;
	try {
		const parsed = JSON.parse(tail) as Record<string, unknown>;
		if (
			parsed.version !== 1 ||
			parsed.kind !== 'full_auto_severe' ||
			typeof parsed.parent_session_id !== 'string' ||
			parsed.parent_session_id.length === 0 ||
			parsed.parent_session_id.length > 128 ||
			typeof parsed.parent_call_id !== 'string' ||
			parsed.parent_call_id.length === 0 ||
			parsed.parent_call_id.length > 128 ||
			typeof parsed.run_generation !== 'number' ||
			!Number.isSafeInteger(parsed.run_generation) ||
			parsed.run_generation < 0 ||
			typeof parsed.correlation_nonce !== 'string' ||
			parsed.correlation_nonce.length === 0 ||
			parsed.correlation_nonce.length > 128 ||
			typeof parsed.category !== 'string' ||
			(parsed.category !== 'external_instructions' &&
				parsed.category !== 'out_of_scope_files' &&
				parsed.category !== 'protected_state_mutation')
		) {
			return null;
		}
		if (
			parsed.path_digests !== undefined &&
			(!Array.isArray(parsed.path_digests) ||
				parsed.path_digests.length > 32 ||
				parsed.path_digests.some(
					(item) => typeof item !== 'string' || !/^[a-f0-9]{16}$/.test(item),
				))
		) {
			return null;
		}
		if (
			parsed.path_count !== undefined &&
			(!Number.isSafeInteger(parsed.path_count) ||
				(parsed.path_count as number) < 0 ||
				(parsed.path_count as number) > 32 ||
				(parsed.path_count as number) !==
					(Array.isArray(parsed.path_digests) ? parsed.path_digests.length : 0))
		) {
			return null;
		}
		if (
			parsed.evidence_event_ids !== undefined &&
			(!Array.isArray(parsed.evidence_event_ids) ||
				parsed.evidence_event_ids.length > 16 ||
				new Set(parsed.evidence_event_ids).size !==
					parsed.evidence_event_ids.length ||
				parsed.evidence_event_ids.some(
					(item) => typeof item !== 'string' || item.length > 128,
				))
		) {
			return null;
		}
		return parsed as unknown as FullAutoSevereEnvelopeV1;
	} catch {
		return null;
	}
}

export function validateFullAutoSevereEnvelope(input: {
	envelope: FullAutoSevereEnvelopeV1 | null;
	sessionID: string;
	callID: string;
	generation: number;
	declaredScope?: string[] | null;
	currentTaskID?: string | null;
	session?: Parameters<typeof getModifiedFilesForTask>[0];
	projectDirectory: string;
}): {
	accepted: boolean;
	category?: FullAutoSevereCategory;
	reason: string;
} {
	sweepMaps();
	const pending = pendingCorrelations.get(`${input.sessionID}:${input.callID}`);
	const envelope = input.envelope;
	if (!envelope) {
		return { accepted: false, reason: 'missing-or-malformed-envelope' };
	}
	if (!pending) return { accepted: false, reason: 'no-pending-correlation' };
	if (
		envelope.parent_session_id !== input.sessionID ||
		envelope.parent_call_id !== input.callID ||
		envelope.run_generation !== input.generation ||
		envelope.correlation_nonce !== pending.nonce
	) {
		return { accepted: false, reason: 'correlation-mismatch' };
	}
	// A correlated result is single-use. Consume it before corroboration so a
	// duplicate or later replay can never acquire durable authority.
	pendingCorrelations.delete(`${input.sessionID}:${input.callID}`);
	if (envelope.category === 'external_instructions') {
		const corroborated = (envelope.evidence_event_ids ?? []).some((id) => {
			const event = evidenceEvents.get(id);
			return (
				!!event &&
				event.sessionID === input.sessionID &&
				event.category === 'external_instructions' &&
				event.callID === input.callID &&
				event.generation === input.generation
			);
		});
		return corroborated
			? { accepted: true, category: envelope.category, reason: 'corroborated' }
			: {
					accepted: false,
					reason: 'uncorroborated-external-instructions',
				};
	}
	if (envelope.category === 'protected_state_mutation') {
		const corroborated = (envelope.evidence_event_ids ?? []).some((id) => {
			const event = evidenceEvents.get(id);
			return (
				!!event &&
				event.sessionID === input.sessionID &&
				event.category === 'protected_state_mutation' &&
				event.callID === input.callID &&
				event.generation === input.generation
			);
		});
		return corroborated
			? { accepted: true, category: envelope.category, reason: 'corroborated' }
			: {
					accepted: false,
					reason: 'uncorroborated-protected-state-mutation',
				};
	}
	const declared = (input.declaredScope ?? []).map((item) =>
		normalizePath(item),
	);
	if (!input.session || !input.currentTaskID || declared.length === 0) {
		return { accepted: false, reason: 'no-deterministic-scope-evidence' };
	}
	const modified =
		getModifiedFilesForTask(input.session, input.currentTaskID) ?? [];
	const outOfScope = modified
		.map((item) =>
			normalizePath(
				path.relative(
					input.projectDirectory,
					path.isAbsolute(item)
						? item
						: path.resolve(input.projectDirectory, item),
				),
			),
		)
		.filter((filePath) => {
			if (!filePath || filePath.startsWith('..')) return false;
			return !declared.some(
				(scope) => filePath === scope || filePath.startsWith(`${scope}/`),
			);
		});
	if (outOfScope.length === 0) {
		return { accepted: false, reason: 'no-out-of-scope-writes' };
	}
	const expectedDigests = new Set(outOfScope.map(digestPath));
	const envelopeDigests = new Set(envelope.path_digests ?? []);
	// Corroboration is set-exact. Accepting one matching path lets a result hide
	// additional out-of-scope writes behind a truthful-but-incomplete envelope.
	const matched =
		expectedDigests.size === envelopeDigests.size &&
		[...expectedDigests].every((digest) => envelopeDigests.has(digest));
	return matched
		? { accepted: true, category: envelope.category, reason: 'corroborated' }
		: { accepted: false, reason: 'digest-mismatch' };
}

export const _internals = {
	pendingCorrelations,
	evidenceEvents,
	childBindings,
	digestPath,
};
