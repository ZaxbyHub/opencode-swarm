import { createHash, randomUUID } from 'node:crypto';
import { stableCanonicalStringify } from '../utils/stable-stringify';
import { MemoryValidationError } from './errors';
import { containsSecret } from './redaction';
import { MemoryAnchorSchema, MemoryOutcomeSchema } from './schema';
import type { MemoryAnchor, MemoryOutcome, MemoryRecord } from './types';

export interface MemoryOutcomeEvent {
	id: string;
	memoryId: string;
	generation: string;
	outcome: MemoryOutcome;
	anchors: MemoryAnchor[];
}

export function newOutcomeGeneration(): string {
	return randomUUID();
}

export function ensureOutcomeGeneration(record: MemoryRecord): MemoryRecord {
	const existing = record.metadata.outcomeGeneration;
	if (typeof existing === 'string' && existing.length > 0) return record;
	return {
		...record,
		metadata: {
			...record.metadata,
			outcomeGeneration: newOutcomeGeneration(),
		},
	};
}

export function outcomeGeneration(record: MemoryRecord): string {
	const value = record.metadata.outcomeGeneration;
	if (typeof value !== 'string' || value.length === 0) {
		throw new MemoryValidationError('memory outcome generation is missing');
	}
	return value;
}

export function stripMaterializedOutcomes(record: MemoryRecord): MemoryRecord {
	const metadata = { ...record.metadata };
	delete metadata.outcomeEventIds;
	const { outcomes: _outcomes, ...base } = record;
	return { ...base, metadata };
}

export function materializeOutcomeRecord(
	base: MemoryRecord,
	events: readonly MemoryOutcomeEvent[],
): MemoryRecord {
	const rawGeneration = base.metadata.outcomeGeneration;
	if (typeof rawGeneration !== 'string' || rawGeneration.length === 0) {
		return base;
	}
	const generation = rawGeneration;
	const matching = events
		.filter(
			(event) => event.memoryId === base.id && event.generation === generation,
		)
		.sort(
			(a, b) =>
				compareText(a.outcome.at, b.outcome.at) || compareText(a.id, b.id),
		);
	const anchors = dedupeAnchors([
		...(base.anchors ?? []),
		...matching.flatMap((event) => event.anchors),
	]);
	const metadata = { ...base.metadata };
	if (matching.length > 0) {
		metadata.outcomeEventIds = matching.map((event) => event.id);
	} else {
		delete metadata.outcomeEventIds;
	}
	return {
		...base,
		metadata,
		anchors: anchors.length > 0 ? anchors : undefined,
		outcomes:
			matching.length > 0 ? matching.map((event) => event.outcome) : undefined,
	};
}

export function importMaterializedOutcomeEvents(
	record: MemoryRecord,
	existing: readonly MemoryOutcomeEvent[],
): MemoryOutcomeEvent[] {
	const generation = outcomeGeneration(record);
	const ids = Array.isArray(record.metadata.outcomeEventIds)
		? record.metadata.outcomeEventIds.filter(
				(value): value is string => typeof value === 'string',
			)
		: [];
	const occurrence = new Map<string, number>();
	return (record.outcomes ?? []).map((raw, index) => {
		const outcome = MemoryOutcomeSchema.parse(raw);
		const payload = canonicalOutcomePayload(outcome, record.anchors ?? []);
		const ordinal = occurrence.get(payload) ?? 0;
		occurrence.set(payload, ordinal + 1);
		const matched = existing.filter(
			(event) =>
				event.memoryId === record.id &&
				event.generation === generation &&
				canonicalOutcomePayload(event.outcome, event.anchors) === payload,
		)[ordinal];
		return {
			id:
				ids[index] ??
				matched?.id ??
				`import-${hash(`${record.id}:${generation}:${payload}:${ordinal}`)}`,
			memoryId: record.id,
			generation,
			outcome,
			anchors: dedupeAnchors(record.anchors ?? []),
		};
	});
}

export function validateOutcomeEvent(value: unknown): MemoryOutcomeEvent {
	if (!value || typeof value !== 'object') {
		throw new MemoryValidationError('invalid memory outcome event');
	}
	const candidate = value as Partial<MemoryOutcomeEvent>;
	if (
		typeof candidate.id !== 'string' ||
		candidate.id.length < 1 ||
		candidate.id.length > 256 ||
		typeof candidate.memoryId !== 'string' ||
		typeof candidate.generation !== 'string' ||
		candidate.generation.length < 1 ||
		candidate.generation.length > 256
	) {
		throw new MemoryValidationError('invalid memory outcome event identity');
	}
	return {
		id: candidate.id,
		memoryId: candidate.memoryId,
		generation: candidate.generation,
		outcome: MemoryOutcomeSchema.parse(candidate.outcome),
		anchors: dedupeAnchors(
			(candidate.anchors ?? []).map((anchor) =>
				MemoryAnchorSchema.parse(anchor),
			),
		),
	};
}

/**
 * Apply record-sensitive policy before an outcome event reaches either
 * provider's canonical store. Shape validation alone cannot determine whether
 * correction text belongs to a durable record.
 */
export function validateOutcomeEventForMemory(
	value: unknown,
	memory: MemoryRecord,
	rejectDurableSecrets: boolean,
): MemoryOutcomeEvent {
	const event = validateOutcomeEvent(value);
	if (
		rejectDurableSecrets &&
		memory.stability === 'durable' &&
		typeof event.outcome.correction === 'string' &&
		containsSecret(event.outcome.correction)
	) {
		throw new MemoryValidationError('durable memory contains a likely secret');
	}
	return event;
}

export function assertEventIdentityCompatible(
	existing: MemoryOutcomeEvent | undefined,
	next: MemoryOutcomeEvent,
): void {
	if (!existing) return;
	// `at` is assigned from execution time. A retry of the same invocation id can
	// therefore arrive later, after the outcome commit but before a downstream
	// reflection write succeeds. Compare the semantic payload while retaining the
	// first commit's timestamp as canonical.
	if (
		stableCanonicalStringify(outcomeEventReplayIdentity(existing)) !==
		stableCanonicalStringify(outcomeEventReplayIdentity(next))
	) {
		throw new MemoryValidationError(
			'outcome event id already exists with a different payload',
		);
	}
}

function outcomeEventReplayIdentity(event: MemoryOutcomeEvent): unknown {
	const correction = event.outcome.correction;
	const taskId = event.outcome.taskId;
	return {
		id: event.id,
		memoryId: event.memoryId,
		generation: event.generation,
		outcome: {
			outcome: event.outcome.outcome,
			...(typeof taskId === 'string' ? { taskId } : {}),
			...(typeof correction === 'string' ? { correction } : {}),
		},
		anchors: event.anchors,
	};
}

export function canonicalOutcomePayload(
	outcome: MemoryOutcome,
	anchors: readonly MemoryAnchor[],
): string {
	return stableCanonicalStringify({
		outcome,
		anchors: dedupeAnchors(anchors),
	});
}

export function dedupeAnchors(
	anchors: readonly MemoryAnchor[],
): MemoryAnchor[] {
	const byKey = new Map<string, MemoryAnchor>();
	for (const anchor of anchors) {
		const parsed = MemoryAnchorSchema.parse(anchor);
		const key = `${parsed.file}\0${parsed.symbol ?? ''}`;
		byKey.set(key, parsed);
	}
	return [...byKey.values()].sort(
		(a, b) =>
			compareText(a.file, b.file) ||
			compareText(a.symbol ?? '', b.symbol ?? ''),
	);
}

function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
