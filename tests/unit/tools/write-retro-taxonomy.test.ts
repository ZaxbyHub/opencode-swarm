import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RetrospectiveEvidence } from '../../../src/config/evidence-schema';
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
		verdict: 'pass',
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

/**
 * Creates an evidence bundle directory and file for a given task
 */
function createEvidenceBundle(
	tempDir: string,
	taskId: string,
	entries: Record<string, unknown>[],
): void {
	const evidenceDir = path.join(tempDir, '.swarm', 'evidence', taskId);
	fs.mkdirSync(evidenceDir, { recursive: true });

	const bundle = {
		schema_version: '1.0.0',
		task_id: taskId,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		entries,
	};

	fs.writeFileSync(
		path.join(evidenceDir, 'evidence.json'),
		JSON.stringify(bundle),
	);
}

/**
 * Creates a reviewer failure entry with proper schema structure
 */
function makeReviewEntry(
	taskId: string,
	summary: string,
	issues: { severity: 'error' | 'warning' | 'info'; message: string }[],
): Record<string, unknown> {
	return {
		task_id: taskId,
		type: 'review',
		timestamp: new Date().toISOString(),
		agent: 'reviewer',
		verdict: 'fail',
		summary,
		risk: 'high' as const,
		issues: issues.map((i) => ({ severity: i.severity, message: i.message })),
		metadata: {},
	};
}

/**
 * Creates a test failure entry with proper schema structure
 */
function makeTestEntry(taskId: string): Record<string, unknown> {
	return {
		task_id: taskId,
		type: 'test',
		timestamp: new Date().toISOString(),
		agent: 'test_agent',
		verdict: 'fail',
		summary: 'Tests failed',
		tests_passed: 0,
		tests_failed: 1,
		failures: [{ name: 'test_one', message: 'Test failed' }],
		metadata: {},
	};
}

/**
 * Creates a scope_guard failure entry with proper schema structure
 */
function makeScopeGuardEntry(taskId: string): Record<string, unknown> {
	return {
		task_id: taskId,
		type: 'note',
		timestamp: new Date().toISOString(),
		agent: 'scope_guard',
		verdict: 'fail',
		summary: 'Scope violation detected',
		metadata: {},
	};
}

/**
 * Creates a loop_detector failure entry with proper schema structure
 */
function makeLoopDetectorEntry(taskId: string): Record<string, unknown> {
	return {
		task_id: taskId,
		type: 'note',
		timestamp: new Date().toISOString(),
		agent: 'loop_detector',
		verdict: 'fail',
		summary: 'Loop detected and blocked',
		metadata: {},
	};
}

describe('write-retro error taxonomy classification', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'write-retro-taxonomy-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('case 1: no evidence files exist', () => {
		test('error_taxonomy is empty array', async () => {
			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Load and verify the bundle
			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toEqual([]);
		});
	});

	describe('case 2: reviewer rejection mentioning interface/type/signature/contract', () => {
		test("'interface_mismatch' in taxonomy when summary contains 'signature'", async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Method signature mismatch', []),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
		});

		test("'interface_mismatch' in taxonomy when issues[].message contains 'interface'", async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Review failed', [
					{
						severity: 'error',
						message: 'Interface contract violation detected',
					},
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
		});

		test("'interface_mismatch' in taxonomy when issues[].message contains 'type'", async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Review failed', [
					{ severity: 'error', message: 'Type mismatch in return value' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
		});

		test("'interface_mismatch' in taxonomy when issues[].message contains 'contract'", async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Review failed', [
					{ severity: 'error', message: 'Contract not fulfilled' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
		});

		test('regex matching is case-insensitive', async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'INTERFACE ERROR', [
					{ severity: 'error', message: 'SIGNATURE MISMATCH' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
		});
	});

	describe('case 3: reviewer rejection WITHOUT interface keywords', () => {
		test("'logic_error' in taxonomy", async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Logic error in calculation', [
					{ severity: 'error', message: 'Wrong result produced' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('logic_error');
			expect(entry.error_taxonomy).not.toContain('interface_mismatch');
		});
	});

	describe('case 4: test failure', () => {
		test("'logic_error' in taxonomy", async () => {
			createEvidenceBundle(tempDir, '1.1', [makeTestEntry('1.1')]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('logic_error');
		});
	});

	describe('case 5: scope_guard failure', () => {
		test("'scope_creep' in taxonomy", async () => {
			createEvidenceBundle(tempDir, '1.1', [makeScopeGuardEntry('1.1')]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('scope_creep');
		});
	});

	describe('case 6: loop_detector failure', () => {
		test("'gate_evasion' in taxonomy", async () => {
			createEvidenceBundle(tempDir, '1.1', [makeLoopDetectorEntry('1.1')]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('gate_evasion');
		});
	});

	describe('case 7: multiple evidence files for same phase', () => {
		test('deduplicates taxonomy entries', async () => {
			// Create multiple evidence files with different failure types
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Some logic error', [
					{ severity: 'error', message: 'Wrong result' },
				]),
			]);
			createEvidenceBundle(tempDir, '1.2', [makeTestEntry('1.2')]);
			createEvidenceBundle(tempDir, '1.3', [makeScopeGuardEntry('1.3')]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			// Both review and test add 'logic_error', but should only appear once
			expect(entry.error_taxonomy).toContain('logic_error');
			expect(entry.error_taxonomy).toContain('scope_creep');
			// Deduplication check
			const logicErrorCount = entry.error_taxonomy.filter(
				(t) => t === 'logic_error',
			).length;
			expect(logicErrorCount).toBe(1);
			// Total should be 2 (logic_error + scope_creep)
			expect(entry.error_taxonomy).toHaveLength(2);
		});

		test('handles multiple review failures in same bundle', async () => {
			// Create bundle with multiple review entries
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
			fs.mkdirSync(evidenceDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: '1.1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					makeReviewEntry('1.1', 'First review failed', [
						{ severity: 'error', message: 'Error 1' },
					]),
					makeReviewEntry('1.1', 'Second review failed', [
						{ severity: 'error', message: 'Error 2' },
					]),
				],
			};

			fs.writeFileSync(
				path.join(evidenceDir, 'evidence.json'),
				JSON.stringify(bundle),
			);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			// Should still only have logic_error once due to deduplication
			const logicErrorCount = entry.error_taxonomy.filter(
				(t) => t === 'logic_error',
			).length;
			expect(logicErrorCount).toBe(1);
		});
	});

	describe('case 8: evidence read failure is non-fatal', () => {
		test('corrupt JSON file - taxonomy empty but write succeeds', async () => {
			// Create a corrupt evidence file
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
			fs.mkdirSync(evidenceDir, { recursive: true });
			fs.writeFileSync(
				path.join(evidenceDir, 'evidence.json'),
				'{ invalid json }',
			);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			// Write should still succeed due to non-fatal error handling
			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			// Taxonomy should be empty because evidence couldn't be read
			expect(entry.error_taxonomy).toEqual([]);
		});

		test('partial evidence - some files valid, some corrupt', async () => {
			// Create valid evidence for 1.1
			createEvidenceBundle(tempDir, '1.1', [makeTestEntry('1.1')]);
			// Create corrupt evidence for 1.2
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.2');
			fs.mkdirSync(evidenceDir, { recursive: true });
			fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), '{ corrupt }');

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			// Should still have logic_error from valid file
			expect(entry.error_taxonomy).toContain('logic_error');
		});
	});

	describe('case 9: phase with task N.5 (boundary)', () => {
		test('task 5 evidence is included in taxonomy', async () => {
			createEvidenceBundle(tempDir, '3.5', [makeScopeGuardEntry('3.5')]);

			const args = makeArgs({ phase: 3 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-3');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('scope_creep');
		});

		test('all tasks for phase are checked dynamically (including task 6)', async () => {
			// Evidence discovery now uses listEvidenceTaskIds which finds ALL task IDs
			// matching the phase prefix, not just a hardcoded 1-5 range
			createEvidenceBundle(tempDir, '3.6', [makeScopeGuardEntry('3.6')]);

			const args = makeArgs({ phase: 3 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-3');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			// Task 3.6 IS now discovered and contributes to taxonomy
			expect(entry.error_taxonomy).toContain('scope_creep');
		});
	});

	describe('case 10: retroEntry saves successfully with populated error_taxonomy', () => {
		test('saveEvidence called with interface_mismatch taxonomy', async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Interface mismatch', [
					{ severity: 'error', message: 'Signature does not match' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
			expect(entry.error_taxonomy).toHaveLength(1);
		});

		test('multiple taxonomy types saved correctly', async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Logic error', [
					{ severity: 'error', message: 'Wrong calculation' },
				]),
			]);
			createEvidenceBundle(tempDir, '1.2', [makeScopeGuardEntry('1.2')]);
			createEvidenceBundle(tempDir, '1.3', [makeLoopDetectorEntry('1.3')]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('logic_error');
			expect(entry.error_taxonomy).toContain('scope_creep');
			expect(entry.error_taxonomy).toContain('gate_evasion');
			expect(entry.error_taxonomy).toHaveLength(3);
		});
	});

	describe('evidence with passing verdict is ignored', () => {
		test('review pass does not add to taxonomy', async () => {
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
			fs.mkdirSync(evidenceDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: '1.1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						...makeReviewEntry('1.1', 'Review passed', []),
						verdict: 'pass',
					},
				],
			};

			fs.writeFileSync(
				path.join(evidenceDir, 'evidence.json'),
				JSON.stringify(bundle),
			);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toEqual([]);
		});

		test('test pass does not add to taxonomy', async () => {
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
			fs.mkdirSync(evidenceDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: '1.1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						...makeTestEntry('1.1'),
						verdict: 'pass',
					},
				],
			};

			fs.writeFileSync(
				path.join(evidenceDir, 'evidence.json'),
				JSON.stringify(bundle),
			);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toEqual([]);
		});
	});

	describe('summary field classification', () => {
		test('interface keyword in summary triggers interface_mismatch', async () => {
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Interface design flaw', [
					{ severity: 'error', message: 'Some other issue' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).toContain('interface_mismatch');
		});
	});

	describe('planning_error is not auto-classified', () => {
		test('no evidence type maps to planning_error', async () => {
			// Create evidence that would not match any classification
			createEvidenceBundle(tempDir, '1.1', [
				makeReviewEntry('1.1', 'Something went wrong', [
					{ severity: 'error', message: 'General error' },
				]),
			]);

			const args = makeArgs({ phase: 1 });
			const result = await executeWriteRetro(args, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const loaded = await loadEvidence(tempDir, 'retro-1');
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;

			const entry = loaded.bundle.entries[0] as RetrospectiveEvidence;
			expect(entry.error_taxonomy).not.toContain('planning_error');
			expect(entry.error_taxonomy).toContain('logic_error');
		});
	});
});
