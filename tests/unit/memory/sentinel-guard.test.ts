import { describe, expect, test } from 'bun:test';
import { buildRecallPromptBlock } from '../../../src/memory/prompt-block';
import {
	computeMemoryContentHash,
	createMemoryId,
	validateMemoryRecordRules,
} from '../../../src/memory/schema';
import { MEMORY_RECALL_SENTINEL } from '../../../src/memory/sentinel';
import type { MemoryRecord } from '../../../src/memory/types';

function makeRecord(text: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'todo' as const,
		text,
	};
	const now = '2026-06-23T00:00:00.000Z';
	return {
		id: createMemoryId(base),
		scope: base.scope,
		kind: base.kind,
		text,
		tags: [],
		confidence: 0.5,
		stability: 'session',
		source: { type: 'agent', createdBy: 'tester' },
		createdAt: now,
		updatedAt: now,
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

describe('DD-14 sentinel write guard', () => {
	test('rejects memory text containing the recall sentinel header', () => {
		const record = makeRecord(
			`Note about format: ${MEMORY_RECALL_SENTINEL} appears in prompts`,
		);
		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toThrow(/recall sentinel/i);
	});

	test('rejects when the sentinel is the entire text', () => {
		const record = makeRecord(MEMORY_RECALL_SENTINEL);
		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toThrow(/recall sentinel/i);
	});

	test('accepts ordinary memory text that does not contain the sentinel', () => {
		const record = makeRecord('Use bun for tests in this repository.');
		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).not.toThrow();
	});

	test('the emitted recall header and the write guard share one sentinel constant', () => {
		// Lockstep: if prompt-block ever emits a header the guard does not reject,
		// stored memory could spoof an injected block again (DD-14).
		const { promptBlock } = buildRecallPromptBlock([], 1000);
		expect(promptBlock.startsWith(MEMORY_RECALL_SENTINEL)).toBe(true);
		expect(MEMORY_RECALL_SENTINEL).toBe('## Retrieved Swarm Memory');
	});
});
