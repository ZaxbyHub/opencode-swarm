import { describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	normalizeMemoryText,
	validateMemoryRecordRules,
} from '../../../src/memory';

const baseTime = '2026-05-24T12:00:00.000Z';

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const base = {
		scope: {
			type: 'repository' as const,
			repoId: 'repo-a',
			repoRoot: '/repo-a',
		},
		kind: 'repo_convention' as const,
		text: 'This repo uses bun. Run tests with bun --smol test.',
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: baseTime,
		updatedAt: baseTime,
		contentHash: computeMemoryContentHash(base),
		metadata: {},
		...overrides,
	};
}

describe('memory schema helpers', () => {
	test('normalizes text and derives deterministic IDs and content hashes', () => {
		const a = {
			scope: { type: 'repository' as const, repoId: 'repo-a' },
			kind: 'repo_convention' as const,
			text: 'This repo uses bun.',
		};
		const b = { ...a, text: '  This   repo uses bun.  ' };

		expect(normalizeMemoryText(b.text)).toBe('This repo uses bun.');
		expect(computeMemoryContentHash(a)).toBe(computeMemoryContentHash(b));
		expect(createMemoryId(a)).toBe(createMemoryId(b));
		expect(createMemoryId(a)).toMatch(/^mem_[a-f0-9]{16}$/);
	});

	test('accepts a valid durable evidence-backed repository memory', () => {
		const record = makeRecord();
		expect(
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toEqual(record);
	});

	test('rejects durable run-scoped memory', () => {
		const base = {
			scope: { type: 'run' as const, runId: 'run-a' },
			kind: 'repo_convention' as const,
			text: 'Run-scoped facts cannot be durable.',
		};
		const record = makeRecord({
			...base,
			id: createMemoryId(base),
			contentHash: computeMemoryContentHash(base),
		});

		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toThrow('durable memories cannot use run or agent scope');
	});

	test('rejects durable project/repository memories without source evidence', () => {
		const record = makeRecord({ source: { type: 'agent' } });

		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toThrow('require source evidence');
	});

	test('rejects durable memories containing likely secrets', () => {
		const base = {
			scope: { type: 'repository' as const, repoId: 'repo-a' },
			kind: 'security_note' as const,
			text: 'Never store Authorization: Bearer abcdefghijklmnopqrstuvwxyz12345',
		};
		const record = makeRecord({
			...base,
			id: createMemoryId(base),
			contentHash: computeMemoryContentHash(base),
			source: { type: 'file', filePath: 'SECURITY.md' },
		});

		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toThrow('likely secret');
	});

	test('requires scratch memories to expire within seven days', () => {
		const base = {
			scope: { type: 'agent' as const, agentId: 'coder' },
			kind: 'scratch' as const,
			text: 'Temporary observation.',
		};
		const record = makeRecord({
			...base,
			id: createMemoryId(base),
			contentHash: computeMemoryContentHash(base),
			stability: 'ephemeral',
			source: { type: 'agent', createdBy: 'coder' },
			expiresAt: '2026-06-10T12:00:00.000Z',
		});

		expect(() =>
			validateMemoryRecordRules(record, { rejectDurableSecrets: true }),
		).toThrow('scratch memories must expire');
	});
});
