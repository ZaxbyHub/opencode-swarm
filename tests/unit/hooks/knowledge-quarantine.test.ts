import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeEntryBase } from '../../../src/hooks/knowledge-types.js';
import {
	auditEntryHealth,
	type EntryHealthResult,
	type QuarantinedEntry,
	quarantineEntry,
	restoreEntry,
} from '../../../src/hooks/knowledge-validator.js';

function createMockEntry(overrides = {}) {
	return {
		id: 'test-entry-001',
		lesson: 'Use vitest for testing TypeScript code',
		category: 'testing',
		scope: 'global',
		confidence: 0.9,
		tags: ['testing', 'vitest'],
		created_at: new Date().toISOString(),
		retrieval_outcomes: {
			retrieval_count: 10,
			applied_count: 5,
			success_rate: 0.8,
		},
		confirmed_by: [],
		auto_generated: false,
		...overrides,
	};
}

let tempDir;

describe('auditEntryHealth', () => {
	it('returns low-utility when appliedCount >= 5 AND utilityScore <= 0', () => {
		const entry = createMockEntry({
			retrieval_outcomes: {
				retrieval_count: 10,
				applied_count: 7,
				success_rate: 0.8,
			},
		});
		entry.utility_score = -0.1;
		const result = auditEntryHealth(entry);
		expect(result).toEqual({ healthy: false, concern: 'Low-utility entry' });
	});

	it('returns healthy when appliedCount >= 5 but utilityScore > 0', () => {
		const entry = createMockEntry({
			retrieval_outcomes: {
				retrieval_count: 10,
				applied_count: 7,
				success_rate: 0.8,
			},
		});
		entry.utility_score = 0.5;
		const result = auditEntryHealth(entry);
		expect(result).toEqual({ healthy: true });
	});

	it('returns near-zero confidence when confidence < 0.1', () => {
		const entry = createMockEntry({ confidence: 0.05 });
		const result = auditEntryHealth(entry);
		expect(result).toEqual({ healthy: false, concern: 'Near-zero confidence' });
	});

	it('returns unconfirmed auto-generated when auto_generated === true and no confirmations', () => {
		const entry = createMockEntry({ auto_generated: true, confirmed_by: [] });
		const result = auditEntryHealth(entry);
		expect(result).toEqual({
			healthy: false,
			concern: 'Unconfirmed auto-generated',
		});
	});

	it('returns healthy for a healthy entry', () => {
		const entry = createMockEntry();
		const result = auditEntryHealth(entry);
		expect(result).toEqual({ healthy: true });
	});

	it('casts utility_score from unknown field correctly', () => {
		const entry = createMockEntry({
			retrieval_outcomes: {
				retrieval_count: 10,
				applied_count: 5,
				success_rate: 0.8,
			},
		});
		entry.utility_score = -0.1;
		const result = auditEntryHealth(entry);
		expect(result).toEqual({ healthy: false, concern: 'Low-utility entry' });
	});
});

describe('quarantineEntry', () => {
	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-test-'));
		await mkdir(path.join(tempDir, '.swarm'), { recursive: true });
		const entry1 = createMockEntry({
			id: 'entry-001',
			lesson: 'Test lesson 1',
		});
		const entry2 = createMockEntry({
			id: 'entry-002',
			lesson: 'Test lesson 2',
		});
		const entry3 = createMockEntry({
			id: 'entry-003',
			lesson: 'Test lesson 3',
		});
		const content =
			JSON.stringify(entry1) +
			'\n' +
			JSON.stringify(entry2) +
			'\n' +
			JSON.stringify(entry3) +
			'\n';
		await writeFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			content,
			'utf-8',
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('moves entry from knowledge.jsonl to knowledge-quarantined.jsonl', async () => {
		await quarantineEntry(tempDir, 'entry-002', 'Testing quarantine', 'user');
		const knowledgeContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		const knowledgeEntries = knowledgeContent
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		expect(knowledgeEntries.length).toBe(2);
		expect(knowledgeEntries.map((e) => e.id)).not.toContain('entry-002');
		const quarantineContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantinedEntries = quarantineContent
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		expect(quarantinedEntries.length).toBe(1);
		expect(quarantinedEntries[0].id).toBe('entry-002');
	});

	it('adds quarantine fields to quarantined entry', async () => {
		await quarantineEntry(tempDir, 'entry-001', 'Reason', 'architect');
		const quarantineContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const entry = JSON.parse(quarantineContent.trim());
		expect(entry.quarantine_reason).toBe('Reason');
		expect(entry.reported_by).toBe('architect');
		expect(entry.quarantined_at).toBeDefined();
		expect(entry.quarantined_at).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);
	});

	it('is no-op if entryId not found', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		await quarantineEntry(tempDir, 'non-existent-id', 'Test reason', 'user');
		const after = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(after).toBe(initial);
	});

	it('returns early for null entryId', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		await quarantineEntry(tempDir, null, 'Test reason', 'user');
		const after = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(after).toBe(initial);
	});

	it('returns early for empty string entryId', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		await quarantineEntry(tempDir, '', 'Test reason', 'user');
		const after = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(after).toBe(initial);
	});

	it('returns early for entryId with null byte', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		const idWithNull = 'entry' + String.fromCharCode(0) + '-001';
		await quarantineEntry(tempDir, idWithNull, 'Test reason', 'user');
		const after = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(after).toBe(initial);
	});

	it('returns early for entryId with newline', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		await quarantineEntry(tempDir, 'entry\n001', 'Test reason', 'user');
		const after = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(after).toBe(initial);
	});

	it('returns early for directory with .. in path', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		await quarantineEntry(
			path.join(tempDir, '..'),
			'entry-001',
			'Test reason',
			'user',
		);
		const after = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(after).toBe(initial);
	});

	it('truncates reason to 500 chars', async () => {
		const longReason = 'a'.repeat(600);
		await quarantineEntry(tempDir, 'entry-001', longReason, 'user');
		const quarantineContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const entry = JSON.parse(quarantineContent.trim());
		expect(entry.quarantine_reason.length).toBe(500);
		expect(entry.quarantine_reason).toBe('a'.repeat(500));
	});

	it('strips control characters from reason', async () => {
		const reasonWithControl =
			'Reason' +
			String.fromCharCode(0) +
			'with' +
			String.fromCharCode(31) +
			'control' +
			String.fromCharCode(8) +
			'chars';
		await quarantineEntry(tempDir, 'entry-001', reasonWithControl, 'user');
		const quarantineContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const entry = JSON.parse(quarantineContent.trim());
		expect(entry.quarantine_reason).toBe('Reasonwithcontrolchars');
	});
});

describe('restoreEntry', () => {
	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-test-'));
		await mkdir(path.join(tempDir, '.swarm'), { recursive: true });
		const entry1 = createMockEntry({
			id: 'entry-001',
			lesson: 'First test lesson for knowledge store',
		});
		const knowledgeContent = JSON.stringify(entry1) + '\n';
		await writeFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			knowledgeContent,
			'utf-8',
		);
		const quarantinedEntry = {
			...createMockEntry({
				id: 'entry-002',
				lesson: 'Second test lesson for quarantine restore',
			}),
			quarantine_reason: 'Test quarantine',
			quarantined_at: new Date().toISOString(),
			reported_by: 'architect',
		};
		const quarantineContent = JSON.stringify(quarantinedEntry) + '\n';
		await writeFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			quarantineContent,
			'utf-8',
		);
		const rejectedEntry = {
			id: 'entry-002',
			lesson: 'Second test lesson for quarantine restore',
			rejection_reason: 'Test quarantine',
			rejected_at: new Date().toISOString(),
			rejection_layer: 3,
		};
		const rejectedContent = JSON.stringify(rejectedEntry) + '\n';
		await writeFile(
			path.join(tempDir, '.swarm', 'knowledge-rejected.jsonl'),
			rejectedContent,
			'utf-8',
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('moves entry from quarantine.jsonl to knowledge.jsonl', async () => {
		await restoreEntry(tempDir, 'entry-002');
		const knowledgeContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		const knowledgeEntries = knowledgeContent
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		expect(knowledgeEntries.length).toBe(2);
		expect(knowledgeEntries.map((e) => e.id)).toContain('entry-002');
	});

	it('removes entry from quarantine.jsonl after restore', async () => {
		await restoreEntry(tempDir, 'entry-002');
		const quarantineContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantinedEntries = quarantineContent
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		expect(quarantinedEntries.length).toBe(0);
	});

	it('restored entry does NOT have quarantine fields', async () => {
		await restoreEntry(tempDir, 'entry-002');
		const knowledgeContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		const restored = knowledgeContent
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l))
			.find((e) => e.id === 'entry-002');
		expect(restored).toBeDefined();
		expect(restored.status).toBe('candidate'); // original status restored
		expect(restored.original_status).toBeUndefined(); // spurious field stripped
		expect(restored.quarantine_reason).toBeUndefined();
		expect(restored.quarantined_at).toBeUndefined();
		expect(restored.reported_by).toBeUndefined();
	});

	it('is no-op if entryId not found in quarantine file', async () => {
		const initialKnowledge = await readFile(
			path.join(tempDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		const initialQuarantine = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		await restoreEntry(tempDir, 'non-existent-id');
		expect(
			await readFile(path.join(tempDir, '.swarm', 'knowledge.jsonl'), 'utf-8'),
		).toBe(initialKnowledge);
		expect(
			await readFile(
				path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
				'utf-8',
			),
		).toBe(initialQuarantine);
	});

	it('returns early for null entryId', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		await restoreEntry(tempDir, null);
		expect(
			await readFile(
				path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
				'utf-8',
			),
		).toBe(initial);
	});

	it('returns early for empty string entryId', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		await restoreEntry(tempDir, '');
		expect(
			await readFile(
				path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
				'utf-8',
			),
		).toBe(initial);
	});

	it('returns early for entryId with null byte', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const idWithNull = 'entry' + String.fromCharCode(0) + '-002';
		await restoreEntry(tempDir, idWithNull);
		expect(
			await readFile(
				path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
				'utf-8',
			),
		).toBe(initial);
	});

	it('returns early for entryId with newline', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		await restoreEntry(tempDir, 'entry\n002');
		expect(
			await readFile(
				path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
				'utf-8',
			),
		).toBe(initial);
	});

	it('returns early for directory with .. in path', async () => {
		const initial = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		await restoreEntry(path.join(tempDir, '..'), 'entry-002');
		expect(
			await readFile(
				path.join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
				'utf-8',
			),
		).toBe(initial);
	});

	it('removes entry from rejected.jsonl if present', async () => {
		await restoreEntry(tempDir, 'entry-002');
		const rejectedContent = await readFile(
			path.join(tempDir, '.swarm', 'knowledge-rejected.jsonl'),
			'utf-8',
		);
		const rejectedEntries = rejectedContent
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		expect(rejectedEntries.length).toBe(0);
	});
});
