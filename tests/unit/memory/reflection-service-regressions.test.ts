import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryGateway } from '../../../src/memory/gateway';
import {
	_internals,
	recordOutcomeWithReflection,
} from '../../../src/memory/reflection-service';
import type { MemoryOutcome, MemoryRecord } from '../../../src/memory/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const MAX_ARTIFACT_BYTES = 256 * 1024;
const originalWithReflectionLock = _internals.withReflectionLock;

let root: string;

beforeEach(() => {
	root = canonicalMkdtemp('reflection-service-regressions-');
});

afterEach(async () => {
	_internals.withReflectionLock = originalWithReflectionLock;
	await fs.rm(root, { recursive: true, force: true });
});

function memory(
	id: string,
	text: string,
	outcomes: MemoryOutcome[],
): MemoryRecord {
	return {
		id,
		scope: { type: 'repository', repoId: 'repo' },
		kind: 'code_pattern',
		text,
		tags: ['reflection'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'tool', ref: 'test' },
		createdAt: '2026-08-19T00:00:00.000Z',
		updatedAt: '2026-08-20T11:00:00.000Z',
		contentHash: `hash-${id}`,
		metadata: {
			outcomeEventIds: outcomes.map((_, index) => `${id}-event-${index}`),
		},
		anchors: [{ file: 'src/example.ts' }],
		outcomes,
	};
}

function gatewayFor(recordOutcome: () => Promise<MemoryRecord>): MemoryGateway {
	return {
		recordOutcome,
		listMemories: async () => [],
	} as unknown as MemoryGateway;
}

describe('reflection service regressions', () => {
	test('skips reflection artifacts entirely when reflection is disabled', async () => {
		const written = memory('mem_reflection_disabled', 'No reflection sidecar', [
			{ outcome: 'useful', at: '2026-08-20T12:00:00.000Z' },
		]);

		const result = await recordOutcomeWithReflection(
			root,
			{
				enabled: true,
				provider: 'local-jsonl',
				reflection: { enabled: false, halfLifeDays: 30 },
			},
			gatewayFor(async () => written),
			{
				memoryId: written.id,
				outcome: 'useful',
				eventId: 'disabled-reflection-event',
			},
		);

		expect(result).toMatchObject({
			record: { id: written.id },
			eventId: 'disabled-reflection-event',
			outcomeRecorded: true,
			reflectionEnabled: false,
			reflectionAttempted: false,
			reflectionUpdated: false,
		});
		expect(
			existsSync(path.join(root, '.swarm', 'reflections', 'lessons.json')),
		).toBe(false);
	});

	test('records the outcome even when acquiring the reflection lock fails', async () => {
		const written = memory(
			'mem_lock_failure',
			'Outcome survives lock failure',
			[{ outcome: 'useful', at: '2026-08-20T12:00:00.000Z' }],
		);
		const recordOutcome = mock(async () => written);
		// Previous code wrapped the durable outcome write inside the reflection
		// lock, so a lock acquisition failure dropped the committed outcome too.
		_internals.withReflectionLock = mock(async () => {
			throw new Error('lock unavailable');
		}) as typeof _internals.withReflectionLock;

		const result = await recordOutcomeWithReflection(
			root,
			{
				enabled: true,
				provider: 'local-jsonl',
				reflection: { enabled: true, halfLifeDays: 30 },
			},
			gatewayFor(recordOutcome),
			{
				memoryId: written.id,
				outcome: 'useful',
				eventId: 'lock-failure-event',
			},
		);

		expect(recordOutcome).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			record: { id: written.id },
			eventId: 'lock-failure-event',
			outcomeRecorded: true,
			reflectionEnabled: true,
			reflectionAttempted: true,
			reflectionUpdated: false,
			error: 'lock unavailable',
		});
		expect(
			existsSync(path.join(root, '.swarm', 'reflections', 'lessons.json')),
		).toBe(false);
	});

	test('bounds artifacts against the actual markdown and pretty-json serializations', () => {
		const hugeText = 'T'.repeat(512);
		const hugeCorrection = 'C'.repeat(512);
		const oversized = _internals.boundDigest({
			preferred: Array.from({ length: 200 }, (_, index) => ({
				memoryId: `preferred-${index}`,
				text: hugeText,
				score: 1,
				positiveOutcomes: 2,
				negativeOutcomes: 0,
				latestAt: '2026-08-20T12:00:00.000Z',
				resolution: 'useful' as const,
			})),
			tentative: Array.from({ length: 200 }, (_, index) => ({
				memoryId: `tentative-${index}`,
				text: hugeText,
				score: 1,
				positiveOutcomes: 1,
				negativeOutcomes: 0,
				latestAt: '2026-08-20T12:00:00.000Z',
				resolution: 'useful' as const,
			})),
			contested: Array.from({ length: 200 }, (_, index) => ({
				memoryId: `contested-${index}`,
				text: hugeText,
				score: 0,
				positiveOutcomes: 1,
				negativeOutcomes: 1,
				latestAt: '2026-08-20T12:00:00.000Z',
				resolution: 'dead_end' as const,
			})),
			deadEnds: Array.from({ length: 200 }, (_, index) => ({
				memoryId: `dead-${index}`,
				text: hugeText,
				score: -1,
				positiveOutcomes: 0,
				negativeOutcomes: 1,
				latestAt: '2026-08-20T12:00:00.000Z',
				resolution: 'dead_end' as const,
			})),
			corrections: Array.from({ length: 200 }, (_, index) => ({
				memoryId: `correction-${index}`,
				correction: hugeCorrection,
				at: '2026-08-20T12:00:00.000Z',
			})),
			deadAnchorMemoryIds: [],
			generatedFrom: {
				entries: 1_000,
				asOf: '2026-08-20T12:00:00.000Z',
			},
		});

		expect(Buffer.byteLength(oversized.artifacts.markdown)).toBeLessThanOrEqual(
			MAX_ARTIFACT_BYTES,
		);
		expect(Buffer.byteLength(oversized.artifacts.json)).toBeLessThanOrEqual(
			MAX_ARTIFACT_BYTES,
		);
	});
});
