import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	EvidenceBundleSchema,
	type RetrospectiveEvidence,
} from '../../../src/config/evidence-schema';
import { loadEvidence } from '../../../src/evidence/manager';
import {
	executeWriteRetro,
	type WriteRetroArgs,
} from '../../../src/tools/write-retro';

/**
 * Helper function to create valid WriteRetroArgs
 */
function makeArgs(overrides: Partial<WriteRetroArgs> = {}): WriteRetroArgs {
	return {
		phase: 4,
		summary: 'Phase 4 completed',
		task_count: 3,
		task_complexity: 'moderate',
		total_tool_calls: 50,
		coder_revisions: 2,
		reviewer_rejections: 1,
		test_failures: 0,
		security_findings: 0,
		integration_issues: 0,
		...overrides,
	};
}

describe('write_retro tool', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Create temp directory
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'write-retro-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('valid retro writes correctly-wrapped EvidenceBundle', () => {
		test('valid retro writes correctly-wrapped EvidenceBundle', async () => {
			const args = makeArgs();
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.task_id).toBe('retro-4');

			// Load the bundle back
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const bundle = loaded.bundle;
			expect(bundle.schema_version).toBe('1.0.0');
			expect(bundle.task_id).toBe('retro-4');
			expect(bundle.entries.length).toBe(1);

			const entry = bundle.entries[0];
			expect(entry.type).toBe('retrospective');
			const retroEntry = entry as RetrospectiveEvidence;
			expect(retroEntry.phase_number).toBe(4);
			expect(retroEntry.verdict).toBe('pass');
			expect(retroEntry.agent).toBe('architect');
			expect(retroEntry.task_complexity).toBe('moderate');
			expect(retroEntry.task_count).toBe(3);
			expect(retroEntry.total_tool_calls).toBe(50);
			expect(retroEntry.coder_revisions).toBe(2);
			expect(retroEntry.reviewer_rejections).toBe(1);
			expect(retroEntry.test_failures).toBe(0);
			expect(retroEntry.security_findings).toBe(0);
			expect(retroEntry.integration_issues).toBe(0);
			expect(retroEntry.summary).toBe('Phase 4 completed');
			expect(retroEntry.timestamp).toBeDefined();
		});
	});

	describe('phase_complete accepts the written bundle', () => {
		test('phase_complete accepts the written bundle', async () => {
			const args = makeArgs();
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify the bundle is found and passes schema validation
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			// Verify it passes schema validation
			const bundle = loaded.bundle;
			const validated = EvidenceBundleSchema.parse(bundle);
			expect(validated).toBeDefined();
			expect(validated.schema_version).toBe('1.0.0');
		});
	});

	describe('validation errors', () => {
		test('invalid phase returns error', async () => {
			const args = makeArgs({ phase: 0 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.phase).toBe(0);
			expect(parsed.message).toContain('Invalid phase');
		});

		test('invalid phase (negative) returns error', async () => {
			const args = makeArgs({ phase: -1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid phase');
		});

		test('invalid task_complexity returns error', async () => {
			const args = makeArgs({ task_complexity: 'high' as any });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid task_complexity');
			expect(parsed.message).toContain(
				"'trivial'|'simple'|'moderate'|'complex'",
			);
		});

		test('invalid task_count returns error', async () => {
			const args = makeArgs({ task_count: 0 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid task_count');
		});

		test('invalid task_count (negative) returns error', async () => {
			const args = makeArgs({ task_count: -5 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid task_count');
		});

		test('empty summary returns error', async () => {
			const args = makeArgs({ summary: '   ' });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid summary');
		});

		test('missing summary returns error', async () => {
			const args = makeArgs({ summary: '' });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid summary');
		});
	});

	describe('custom task_id', () => {
		test('custom task_id overrides default', async () => {
			// Use a valid custom retro ID (retro-N format is accepted by sanitizeTaskId)
			const args = makeArgs({ task_id: 'retro-5' });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.task_id).toBe('retro-5');

			// Verify file written to correct location
			const filePath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				'retro-5',
				'evidence.json',
			);
			expect(fs.existsSync(filePath)).toBe(true);
		});
	});

	describe('optional fields', () => {
		test('optional fields propagate correctly', async () => {
			const args = makeArgs({
				lessons_learned: ['lesson 1', 'lesson 2'],
				top_rejection_reasons: ['reason 1'],
				metadata: { custom: 'value' },
			});
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify the bundle
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0];
			const retroEntry = entry as RetrospectiveEvidence;
			expect(retroEntry.lessons_learned).toEqual(['lesson 1', 'lesson 2']);
			expect(retroEntry.top_rejection_reasons).toEqual(['reason 1']);
			expect(retroEntry.metadata).toEqual({ custom: 'value' });
		});

		test('missing optional fields use defaults', async () => {
			const args = makeArgs({});
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify the bundle
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0];
			const retroEntry = entry as RetrospectiveEvidence;
			expect(retroEntry.lessons_learned).toEqual([]);
			expect(retroEntry.top_rejection_reasons).toEqual([]);
			expect(retroEntry.user_directives).toEqual([]);
			expect(retroEntry.approaches_tried).toEqual([]);
		});
	});

	describe('idempotency', () => {
		test('second write appends to existing bundle', async () => {
			// First write
			const args1 = makeArgs({ summary: 'First retro' });
			const result1 = await executeWriteRetro(args1, tempDir);
			expect(JSON.parse(result1).success).toBe(true);

			// Second write with different summary
			const args2 = makeArgs({ summary: 'Second retro' });
			const result2 = await executeWriteRetro(args2, tempDir);
			expect(JSON.parse(result2).success).toBe(true);

			// Load and verify bundle has 2 entries
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const bundle = loaded.bundle;
			expect(bundle.entries.length).toBe(2);
			expect(bundle.entries[0].summary).toBe('First retro');
			expect(bundle.entries[1].summary).toBe('Second retro');
		});
	});

	describe('lessons_learned truncation', () => {
		test('lessons_learned truncated to 5', async () => {
			const args = makeArgs({
				lessons_learned: ['a', 'b', 'c', 'd', 'e', 'f'],
			});
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify only 5 lessons
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0];
			const retroEntry = entry as RetrospectiveEvidence;
			expect(retroEntry.lessons_learned).toEqual(['a', 'b', 'c', 'd', 'e']);
			expect(retroEntry.lessons_learned.length).toBe(5);
		});

		test('lessons_learned exactly 5 is not truncated', async () => {
			const args = makeArgs({
				lessons_learned: ['a', 'b', 'c', 'd', 'e'],
			});
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify all 5 lessons
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0];
			const retroEntry = entry as RetrospectiveEvidence;
			expect(retroEntry.lessons_learned).toEqual(['a', 'b', 'c', 'd', 'e']);
			expect(retroEntry.lessons_learned.length).toBe(5);
		});
	});

	describe('bundle metadata', () => {
		test('bundle includes created_at and updated_at', async () => {
			const args = makeArgs();
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify timestamps
			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const bundle = loaded.bundle;
			expect(bundle.created_at).toBeDefined();
			expect(bundle.updated_at).toBeDefined();
			expect(bundle.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(bundle.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		test('updated_at changes on second write', async () => {
			// First write
			const args1 = makeArgs();
			await executeWriteRetro(args1, tempDir);

			// Load first bundle
			const loaded1 = await loadEvidence(tempDir, 'retro-4');
			expect(loaded1.status).toBe('found');
			if (loaded1.status !== 'found') return;
			const updatedAt1 = loaded1.bundle.updated_at;

			// Wait a bit
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Second write
			const args2 = makeArgs({ summary: 'Updated summary' });
			await executeWriteRetro(args2, tempDir);

			// Load updated bundle
			const loaded2 = await loadEvidence(tempDir, 'retro-4');
			expect(loaded2.status).toBe('found');
			if (loaded2.status !== 'found') return;
			const updatedAt2 = loaded2.bundle.updated_at;

			// updated_at should be different
			expect(updatedAt1).not.toBe(updatedAt2);
		});
	});

	describe('different phase numbers', () => {
		test('writes retro for phase 1', async () => {
			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.task_id).toBe('retro-1');
			expect(parsed.phase).toBe(1);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.phase_number).toBe(1);
		});

		test('rejects phase over 99', async () => {
			const args = makeArgs({ phase: 100 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid phase');
		});
	});

	describe('all task_complexity values', () => {
		const validComplexities: Array<
			'trivial' | 'simple' | 'moderate' | 'complex'
		> = ['trivial', 'simple', 'moderate', 'complex'];

		validComplexities.forEach((complexity) => {
			test(`accepts task_complexity: ${complexity}`, async () => {
				const args = makeArgs({ task_complexity: complexity });
				const result = await executeWriteRetro(args, tempDir);
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(true);

				const loaded = await loadEvidence(tempDir, 'retro-4');
				expect(loaded.status).toBe('found');
				if (loaded.status !== 'found') return;

				const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
				expect(entry.task_complexity).toBe(complexity);
			});
		});
	});

	describe('metadata field', () => {
		test('stores custom metadata', async () => {
			const customMetadata = {
				project: 'test-project',
				version: '1.0.0',
				tags: ['important', 'reviewed'],
			};

			const args = makeArgs({ metadata: customMetadata });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			expect(loaded.bundle.entries[0].metadata).toEqual(customMetadata);
		});

		test('handles missing metadata', async () => {
			const args = makeArgs();
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-4');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			expect(loaded.bundle.entries[0].metadata).toBeUndefined();
		});
	});
});
