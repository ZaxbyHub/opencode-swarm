/**
 * Adversarial/security tests for knowledge-validator.ts quarantine and restore functions.
 * Focus: attack vectors, edge cases, boundary violations.
 * NO happy-path tests (those are in verification test files).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeEntryBase } from '../../../src/hooks/knowledge-types.js';
import {
	auditEntryHealth,
	quarantineEntry,
	restoreEntry,
} from '../../../src/hooks/knowledge-validator.js';

// Test data
const createValidEntry = (): KnowledgeEntryBase => ({
	id: '123e4567-e89b-12d3-a456-426614174000',
	lesson: 'Always use TypeScript strict mode for better type safety',
	category: 'architecture',
	scope: 'global',
	confidence: 0.9,
	tags: ['typescript', 'strict-mode'],
	created_at: '2024-01-01T00:00:00.000Z',
	updated_at: '2024-01-01T00:00:00.000Z',
	retrieval_outcomes: {
		applied_count: 5,
		succeeded_after_count: 3,
		failed_after_count: 1,
	},
	confirmed_by: [
		{
			phase_number: 1,
			confirmed_at: '2024-01-01T00:00:00.000Z',
			project_name: 'test',
		},
	],
	tier: 'swarm',
	status: 'established',
	schema_version: 1,
});

describe('quarantineEntry - Path Traversal Attacks', () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it('blocks relative path traversal: ../../../etc', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'test quarantine';

		// Should NOT throw, should just early return
		await expect(
			quarantineEntry('../../../etc', entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('blocks Windows-style path traversal: ..\\..\\windows', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'test quarantine';

		await expect(
			quarantineEntry('..\\..\\windows', entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('blocks embedded traversal: foo/../../../bar', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'test quarantine';

		await expect(
			quarantineEntry('foo/../../../bar', entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('allows absolute paths (no .. in path)', async () => {
		const tempDir = join(tmpdir(), `test-${Date.now()}`);
		tempDirs.push(tempDir);
		await mkdir(tempDir, { recursive: true });

		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'test quarantine';

		// Should not crash - entry won't be found, but no error thrown
		await expect(
			quarantineEntry(tempDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('blocks empty string directory', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'test quarantine';

		await expect(
			quarantineEntry('', entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});
});

describe('quarantineEntry - Injection Attacks on entryId', () => {
	const tempDirs: string[] = [];
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		tempDirs.push(testDir);
		await mkdir(testDir, { recursive: true });
		await mkdir(join(testDir, '.swarm'), { recursive: true });

		// Create a valid knowledge entry to quaratine
		const entry = createValidEntry();
		const fs = await import('node:fs/promises');
		await fs.writeFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			`${JSON.stringify(entry)}\n`,
			'utf-8',
		);
	});

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it('rejects null byte injection in entryId', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000\0injected';
		const reason = 'test quarantine';

		await expect(
			quarantineEntry(testDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();

		// Original entry should still exist
		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(content).toContain('123e4567-e89b-12d3-a456-426614174000');
	});

	it('rejects newline injection in entryId', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000\ninjected';
		const reason = 'test quarantine';

		await expect(
			quarantineEntry(testDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();

		// Original entry should still exist
		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(content).toContain('123e4567-e89b-12d3-a456-426614174000');
	});

	it('accepts CR (\\r) alone in entryId (only \\n blocked)', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000\rinjected';
		const reason = 'test quarantine';

		// Should not crash - just won't find a matching entry
		await expect(
			quarantineEntry(testDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('rejects CRLF injection (\\r\\n contains \\n)', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000\r\ninjected';
		const reason = 'test quarantine';

		await expect(
			quarantineEntry(testDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('handles very long entryId (10000 chars) without crashing', async () => {
		const entryId = 'a'.repeat(10000);
		const reason = 'test quarantine';

		// Should not crash - just won't find a matching entry
		await expect(
			quarantineEntry(testDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});

	it('handles JSON injection attempt in entryId', async () => {
		const entryId = '{"id": "other", "attack": true}';
		const reason = 'test quarantine';

		// Should not crash - just won't find a matching entry
		await expect(
			quarantineEntry(testDir, entryId, reason, 'architect'),
		).resolves.toBeUndefined();
	});
});

describe('quarantineEntry - Boundary Cases for reason', () => {
	const tempDirs: string[] = [];
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		tempDirs.push(testDir);
		await mkdir(testDir, { recursive: true });
		await mkdir(join(testDir, '.swarm'), { recursive: true });

		// Create a valid knowledge entry to quaratine
		const entry = createValidEntry();
		const fs = await import('node:fs/promises');
		await fs.writeFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			`${JSON.stringify(entry)}\n`,
			'utf-8',
		);
	});

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it('truncates 501-char reason to 500 chars', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'a'.repeat(501);

		await quarantineEntry(testDir, entryId, reason, 'architect');

		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantined = JSON.parse(content.trim()) as {
			quarantine_reason: string;
		};

		expect(quarantined.quarantine_reason).toHaveLength(500);
		expect(quarantined.quarantine_reason).toBe('a'.repeat(500));
	});

	it('strips null bytes from reason', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'reason\0injected';

		await quarantineEntry(testDir, entryId, reason, 'architect');

		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantined = JSON.parse(content.trim()) as {
			quarantine_reason: string;
		};

		expect(quarantined.quarantine_reason).not.toContain('\0');
		expect(quarantined.quarantine_reason).toBe('reasoninjected');
	});

	it('strips CR (\\x0d) from reason', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'reason\x0dinjected';

		await quarantineEntry(testDir, entryId, reason, 'architect');

		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantined = JSON.parse(content.trim()) as {
			quarantine_reason: string;
		};

		expect(quarantined.quarantine_reason).not.toContain('\x0d');
		expect(quarantined.quarantine_reason).toBe('reasoninjected');
	});

	it('strips CR from CRLF reason (LF passes sanitization but is blocked by entryId validation)', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'reason\r\ninjected';

		await quarantineEntry(testDir, entryId, reason, 'architect');

		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantined = JSON.parse(content.trim()) as {
			quarantine_reason: string;
		};

		// CR is stripped by the control char regex
		expect(quarantined.quarantine_reason).not.toContain('\r');
		// LF is NOT stripped by the control char regex (by design - only \n is blocked in entryId validation)
		expect(quarantined.quarantine_reason).toContain('\n');
		expect(quarantined.quarantine_reason).toBe('reason\ninjected');
	});

	it('preserves Unicode emoji in reason', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';
		const reason = 'Test with emoji 🚀 🎉 ✨';

		await quarantineEntry(testDir, entryId, reason, 'architect');

		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const quarantined = JSON.parse(content.trim()) as {
			quarantine_reason: string;
		};

		expect(quarantined.quarantine_reason).toBe('Test with emoji 🚀 🎉 ✨');
	});
});

describe('quarantineEntry - Concurrent-like Behavior', () => {
	const tempDirs: string[] = [];
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		tempDirs.push(testDir);
		await mkdir(testDir, { recursive: true });
		await mkdir(join(testDir, '.swarm'), { recursive: true });

		// Create a valid knowledge entry to quaratine
		const entry = createValidEntry();
		const fs = await import('node:fs/promises');
		await fs.writeFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			`${JSON.stringify(entry)}\n`,
			'utf-8',
		);
	});

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it('second quarantine call for same entryId is no-op', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		// First quarantine
		await quarantineEntry(testDir, entryId, 'first reason', 'architect');

		// Second quarantine - should be no-op (entry already removed from knowledge.jsonl)
		await expect(
			quarantineEntry(testDir, entryId, 'second reason', 'architect'),
		).resolves.toBeUndefined();

		// Should still be in quarantine, not duplicated
		const { readFile } = await import('node:fs/promises');
		const content = await readFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			'utf-8',
		);
		const lines = content
			.trim()
			.split('\n')
			.filter((l) => l.length > 0);

		expect(lines).toHaveLength(1);
		const quarantined = JSON.parse(lines[0]) as { quarantine_reason: string };
		expect(quarantined.quarantine_reason).toBe('first reason');
	});
});

describe('restoreEntry - Concurrent-like Behavior', () => {
	const tempDirs: string[] = [];
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		tempDirs.push(testDir);
		await mkdir(testDir, { recursive: true });
		await mkdir(join(testDir, '.swarm'), { recursive: true });

		// Create a quarantined entry
		const entry = createValidEntry();
		const { writeFile } = await import('node:fs/promises');
		await writeFile(
			join(testDir, '.swarm', 'knowledge-quarantined.jsonl'),
			`${JSON.stringify({
				...entry,
				quarantine_reason: 'test',
				quarantined_at: '2024-01-01T00:00:00.000Z',
				reported_by: 'architect' as const,
			})}\n`,
			'utf-8',
		);
	});

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it('second restore call for same entryId is no-op', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		// First restore
		await restoreEntry(testDir, entryId);

		// Verify entry is restored
		const { readFile } = await import('node:fs/promises');
		let knowledgeContent = await readFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		expect(knowledgeContent).toContain(entryId);

		// Second restore - should be no-op (entry already removed from quarantine.jsonl)
		await expect(restoreEntry(testDir, entryId)).resolves.toBeUndefined();

		// Knowledge file should still only have one entry (not duplicated)
		knowledgeContent = await readFile(
			join(testDir, '.swarm', 'knowledge.jsonl'),
			'utf-8',
		);
		const lines = knowledgeContent
			.trim()
			.split('\n')
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
	});
});

describe('auditEntryHealth - Edge Cases', () => {
	it('flags unhealthy: utility_score = 0.0 with appliedCount >= 5', () => {
		const entry: KnowledgeEntryBase & { utility_score?: number } = {
			...createValidEntry(),
			utility_score: 0.0,
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(false);
		expect(result.concern).toBe('Low-utility entry');
	});

	it('flags unhealthy: confidence = 0.0 exactly', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			confidence: 0.0,
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(false);
		expect(result.concern).toBe('Near-zero confidence');
	});

	it('flags unhealthy: confidence = 0.099 (below 0.1 threshold)', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			confidence: 0.099,
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(false);
		expect(result.concern).toBe('Near-zero confidence');
	});

	it('marks healthy: confidence = 0.1 (at threshold)', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			confidence: 0.1,
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(true);
		expect(result.concern).toBeUndefined();
	});

	it('marks healthy: auto_generated = false with empty confirmed_by', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			auto_generated: false,
			confirmed_by: [],
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(true);
		expect(result.concern).toBeUndefined();
	});

	it('flags unhealthy: auto_generated = true with empty confirmed_by', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			auto_generated: true,
			confirmed_by: [],
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(false);
		expect(result.concern).toBe('Unconfirmed auto-generated');
	});

	it('marks healthy: auto_generated = true with confirmed_by non-empty', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			auto_generated: true,
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2024-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(true);
		expect(result.concern).toBeUndefined();
	});

	it('does not flag low-utility when appliedCount < 5', () => {
		const entry: KnowledgeEntryBase & { utility_score?: number } = {
			...createValidEntry(),
			utility_score: 0.0,
			retrieval_outcomes: {
				applied_count: 4,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(true);
		expect(result.concern).toBeUndefined();
	});

	it('does not flag low-utility when utility_score is undefined', () => {
		const entry: KnowledgeEntryBase = {
			...createValidEntry(),
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
		};
		// Remove utility_score
		delete (entry as { utility_score?: number }).utility_score;

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(true);
		expect(result.concern).toBeUndefined();
	});

	it('does not flag low-utility when utility_score > 0', () => {
		const entry: KnowledgeEntryBase & { utility_score?: number } = {
			...createValidEntry(),
			utility_score: 0.01,
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
		};

		const result = auditEntryHealth(entry);
		expect(result.healthy).toBe(true);
		expect(result.concern).toBeUndefined();
	});
});

describe('restoreEntry - Path Traversal and Injection Attacks', () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	it('blocks relative path traversal: ../../../etc', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		await expect(
			restoreEntry('../../../etc', entryId),
		).resolves.toBeUndefined();
	});

	it('blocks Windows-style path traversal: ..\\..\\windows', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		await expect(
			restoreEntry('..\\..\\windows', entryId),
		).resolves.toBeUndefined();
	});

	it('blocks embedded traversal: foo/../../../bar', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		await expect(
			restoreEntry('foo/../../../bar', entryId),
		).resolves.toBeUndefined();
	});

	it('allows absolute paths (no .. in path)', async () => {
		const tempDir = join(tmpdir(), `test-${Date.now()}`);
		tempDirs.push(tempDir);
		await mkdir(tempDir, { recursive: true });

		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		// Should not crash - entry won't be found, but no error thrown
		await expect(restoreEntry(tempDir, entryId)).resolves.toBeUndefined();
	});

	it('blocks empty string directory', async () => {
		const entryId = '123e4567-e89b-12d3-a456-426614174000';

		await expect(restoreEntry('', entryId)).resolves.toBeUndefined();
	});

	it('rejects null byte injection in entryId', async () => {
		const tempDir = join(tmpdir(), `test-${Date.now()}`);
		tempDirs.push(tempDir);
		await mkdir(tempDir, { recursive: true });
		await mkdir(join(tempDir, '.swarm'), { recursive: true });

		const entryId = '123e4567-e89b-12d3-a456-426614174000\0injected';

		// Create quarantined entry
		const { writeFile } = await import('node:fs/promises');
		await writeFile(
			join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			`${JSON.stringify({
				...createValidEntry(),
				quarantine_reason: 'test',
				quarantined_at: '2024-01-01T00:00:00.000Z',
				reported_by: 'architect' as const,
			})}\n`,
			'utf-8',
		);

		await expect(restoreEntry(tempDir, entryId)).resolves.toBeUndefined();
	});

	it('rejects newline injection in entryId', async () => {
		const tempDir = join(tmpdir(), `test-${Date.now()}`);
		tempDirs.push(tempDir);
		await mkdir(tempDir, { recursive: true });
		await mkdir(join(tempDir, '.swarm'), { recursive: true });

		const entryId = '123e4567-e89b-12d3-a456-426614174000\ninjected';

		// Create quarantined entry
		const { writeFile } = await import('node:fs/promises');
		await writeFile(
			join(tempDir, '.swarm', 'knowledge-quarantined.jsonl'),
			`${JSON.stringify({
				...createValidEntry(),
				quarantine_reason: 'test',
				quarantined_at: '2024-01-01T00:00:00.000Z',
				reported_by: 'architect' as const,
			})}\n`,
			'utf-8',
		);

		await expect(restoreEntry(tempDir, entryId)).resolves.toBeUndefined();
	});
});
