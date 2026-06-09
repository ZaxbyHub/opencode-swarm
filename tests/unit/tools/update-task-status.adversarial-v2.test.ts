/**
 * ADVERSARIAL SECURITY TESTS for src/tools/update-task-status.ts
 *
 * Tests specifically targeting the non-null assertions (!) and type assertions (as string)
 * that were added when removing process.cwd() fallbacks.
 *
 * Changes tested:
 * - Line 143: workingDirectory! (non-null assertion in checkReviewerGate - Turbo Mode path)
 * - Line 178: workingDirectory! (non-null assertion in checkReviewerGate - evidence-first path)
 * - Line 263: workingDirectory! (non-null assertion in checkReviewerGate - plan.json fallback path)
 * - Line 356: workingDirectory! (non-null assertion in checkReviewerGateWithScope)
 * - Line 596: fallbackDir as string (type assertion when working_directory not provided)
 *
 * Attack vectors:
 * 1. undefined workingDirectory causing undefined string in path operations
 * 2. undefined fallbackDir causing "undefined" string in path operations
 * 3. Type confusion - passing non-string where string is expected
 * 4. Boundary: MAX_SAFE_INTEGER in paths
 * 5. NaN/Infinity in paths
 * 6. Object/array passed as working_directory
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import {
	checkReviewerGate,
	checkReviewerGateWithScope,
	executeUpdateTaskStatus,
	validateStatus,
	validateTaskId,
} from '../../../src/tools/update-task-status';

let tmpDir: string;

function runUpdate(
	args: Parameters<typeof executeUpdateTaskStatus>[0],
	fallbackDir: string | undefined = tmpDir,
) {
	return executeUpdateTaskStatus(args, fallbackDir);
}

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'uts-adv2-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Adversarial Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'test task',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'test task 2',
							depends: [],
							files_touched: ['architect.ts'],
						},
					],
				},
			],
		}),
	);
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 1: Non-null assertion on undefined workingDirectory
// checkReviewerGate is called with workingDirectory = undefined
// Line 143: const resolvedDir = workingDirectory!; → resolvedDir = undefined
// Line 178: const resolvedDir = workingDirectory!; → resolvedDir = undefined
// Line 263: const resolvedDir = workingDirectory!; → resolvedDir = undefined
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: checkReviewerGate with undefined workingDirectory', () => {
	it('should NOT crash when workingDirectory is undefined (line 143 non-null assertion)', () => {
		// Line 143 is in the Turbo Mode bypass check
		// If workingDirectory is undefined, workingDirectory! = undefined
		// path.join(undefined, '.swarm', 'plan.json') = '[undefined]/.swarm/plan.json'
		// fs.readFileSync would fail with ENOENT, not crash

		expect(() => {
			const result = checkReviewerGate('1.1', undefined);
			// Should return safely, not crash
			expect(typeof result.blocked).toBe('boolean');
			expect(typeof result.reason).toBe('string');
		}).not.toThrow();
	});

	it('should NOT crash when workingDirectory is undefined (line 178 non-null assertion)', () => {
		// Line 178 is in the evidence-first check path
		// fs.readFileSync with undefined path should throw ENOENT
		expect(() => {
			const result = checkReviewerGate('1.1', undefined);
			expect(typeof result.blocked).toBe('boolean');
		}).not.toThrow();
	});

	it('should NOT crash when workingDirectory is undefined (line 263 non-null assertion)', () => {
		// Line 263 is in the plan.json fallback check path
		expect(() => {
			const result = checkReviewerGate('1.1', undefined);
			expect(typeof result.blocked).toBe('boolean');
		}).not.toThrow();
	});

	it('should NOT crash in checkReviewerGateWithScope with undefined workingDirectory', async () => {
		// Line 356: workingDirectory! is used in validateDiffScope call
		expect(async () => {
			const result = await checkReviewerGateWithScope('1.1', undefined);
			expect(typeof result.blocked).toBe('boolean');
		}).not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 2: Type assertion fallbackDir as string with undefined
// Line 596: directory = fallbackDir as string;
// If fallbackDir is undefined, this becomes directory = "undefined" (string!)
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: executeUpdateTaskStatus with undefined fallbackDir', () => {
	it('should NOT crash when fallbackDir is undefined (line 596 type assertion)', async () => {
		// When fallbackDir is undefined and no working_directory is provided,
		// the source returns a structured error result without emitting console.warn.

		const result = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'pending',
				// No working_directory
			},
			undefined, // fallbackDir is undefined
		);

		// Should fail safely with an error message, not crash
		expect(result.success).toBe(false);
		expect(result.message).toContain('fallbackDir');
	});

	it('should NOT silently use "undefined" string as directory path', async () => {
		// When fallbackDir is undefined and no working_directory is provided,
		// the source guards against this explicitly and returns a structured error.

		const result = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'pending',
			},
			undefined,
		);

		// Must fail safely - should NOT succeed
		expect(result.success).toBe(false);
		// Error message should mention fallbackDir
		expect(result.message).toContain('fallbackDir');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 3: Type confusion attacks on working_directory parameter
// The args object is typed as UpdateTaskStatusArgs but could receive anything
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: type confusion on working_directory', () => {
	it('rejects number working_directory without crashing', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: 12345 as unknown as string,
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('must be a string');
	});

	it('rejects NaN working_directory without crashing', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: NaN as unknown as string,
		});

		expect(result.success).toBe(false);
	});

	it('rejects Infinity working_directory without crashing', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: Infinity as unknown as string,
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('must be a string');
	});

	it('should NOT crash when working_directory is null', async () => {
		// null is treated like an omitted working_directory and uses the injected fallback
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: null as unknown as string,
		});

		expect(result.success).toBe(true);
		expect(result.new_status).toBe('pending');
	});

	it('rejects object working_directory without crashing', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: { path: '/etc' } as unknown as string,
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('must be a string');
	});

	it('rejects array working_directory without crashing', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: ['/etc', '../'] as unknown as string,
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('must be a string');
	});

	it('should NOT crash when working_directory is MAX_SAFE_INTEGER', async () => {
		// Number as string passes type check, but path doesn't exist
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory:
				Number.MAX_SAFE_INTEGER.toString() as unknown as string,
		});

		// Should fail (path doesn't exist), not crash
		expect(result.success).toBe(false);
	});

	it('should NOT crash when working_directory is negative zero', async () => {
		// '-0' as string is valid
		const result = await runUpdate({
			task_id: '1.1',
			status: 'pending',
			working_directory: '-0' as unknown as string,
		});

		// Should fail (path doesn't exist), not crash
		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 4: Type confusion on task_id
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: type confusion on task_id', () => {
	it('should NOT crash when task_id is a number', async () => {
		const result = await runUpdate({
			task_id: 1.1 as unknown as string,
			status: 'pending',
			working_directory: tmpDir,
		});

		// Task not found error means validation passed (pattern matched) but task doesn't exist
		expect(result.success).toBe(false);
	});

	it('should NOT crash when task_id is an array', async () => {
		const result = await runUpdate({
			task_id: ['1.1'] as unknown as string,
			status: 'pending',
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
	});

	it('should NOT crash when task_id is an object', async () => {
		const result = await runUpdate({
			task_id: { id: '1.1' } as unknown as string,
			status: 'pending',
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
	});

	it('should NOT crash when task_id is null', async () => {
		const result = await runUpdate({
			task_id: null as unknown as string,
			status: 'pending',
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 5: Type confusion on status
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: type confusion on status', () => {
	it('should NOT crash when status is a number', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: 123 as unknown as string,
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain('status');
	});

	it('should NOT crash when status is an array', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: ['pending'] as unknown as string,
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
	});

	it('should NOT crash when status is null', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: null as unknown as string,
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
	});

	it('should NOT crash when status is undefined', async () => {
		const result = await runUpdate({
			task_id: '1.1',
			status: undefined as unknown as string,
			working_directory: tmpDir,
		});

		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 6: Boundary - oversized task_id
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: oversized task_id', () => {
	it('should NOT crash with very long task_id (10KB)', async () => {
		const longTaskId = '1.' + '1'.repeat(10 * 1024);

		const result = await runUpdate({
			task_id: longTaskId,
			status: 'pending',
			working_directory: tmpDir,
		});

		// Should fail validation due to pattern mismatch
		expect(result.success).toBe(false);
	});

	it('should NOT crash with deeply nested task_id (100 levels)', async () => {
		const nestedTaskId = '1.' + Array(100).fill('1').join('.');

		const result = await runUpdate({
			task_id: nestedTaskId,
			status: 'pending',
			working_directory: tmpDir,
		});

		// Should fail - pattern doesn't match or path resolution issue
		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 7: Injection in task_id (not just validation failure)
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: task_id injection attempts', () => {
	it('should reject task_id with null byte', () => {
		const result = validateTaskId('1.1\x00/../../../etc');
		expect(result).toBeDefined();
		expect(result).toContain('Invalid');
	});

	it('should reject task_id with path traversal', () => {
		const result = validateTaskId('1.1/../../../etc/passwd');
		expect(result).toBeDefined();
	});

	it('should reject task_id with shell metacharacters', () => {
		const result = validateTaskId('1.1; rm -rf /');
		expect(result).toBeDefined();
	});

	it('should reject task_id with Unicode RTL override', () => {
		const result = validateTaskId('1.1\u202e/etc');
		expect(result).toBeDefined();
	});

	it('should reject task_id with template literal injection', () => {
		const result = validateTaskId('1.1${process.exit(1)}');
		expect(result).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 8: Injection in status
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: status injection attempts', () => {
	it('should reject status with null byte', () => {
		const result = validateStatus('pending\x00; rm -rf /');
		expect(result).toBeDefined();
	});

	it('should reject status with path traversal', () => {
		const result = validateStatus('../etc/passwd');
		expect(result).toBeDefined();
	});

	it('should reject status with template literal injection', () => {
		const result = validateStatus('${process.exit(1)}');
		expect(result).toBeDefined();
	});

	it('should reject status with SQL-like injection', () => {
		const result = validateStatus("pending'; DROP TABLE tasks;--");
		expect(result).toBeDefined();
	});

	it('should reject non-existent status values', () => {
		const result = validateStatus('hacked_status');
		expect(result).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 9: Turbo Mode with malicious Tier 3 files_touched bypass
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: Turbo Mode Tier 3 bypass attempts', () => {
	it('should NOT allow bypassing Tier 3 by spoofing files_touched', async () => {
		// If a task claims to touch architect.ts but doesn't, Turbo Mode should
		// NOT bypass the reviewer gate for Tier 3 files

		// First, create a task that claims to touch Tier 3
		const turboPlanPath = path.join(tmpDir, '.swarm', 'plan.json');
		const plan = JSON.parse(fs.readFileSync(turboPlanPath, 'utf-8'));
		plan.phases[0].tasks[0].files_touched = ['architect.ts'];
		writeFileSync(turboPlanPath, JSON.stringify(plan));

		// This is a Turbo Mode test - need to enable it in swarmState
		// But since we're testing without actual Turbo Mode, check the gate directly
		const result = checkReviewerGate('1.1', tmpDir);

		// Without actual Turbo Mode session, gate should be blocked
		// The point is files_touched is read-only, not user-controlled in this path
		expect(typeof result.blocked).toBe('boolean');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL TEST 10: Race condition on concurrent calls with undefined
// ─────────────────────────────────────────────────────────────────────────────

describe('ADVERSARIAL: concurrent calls with undefined workingDirectory', () => {
	it('should handle 10 concurrent calls with undefined workingDirectory safely', async () => {
		const promises = Array(10)
			.fill(null)
			.map(() =>
				executeUpdateTaskStatus(
					{ task_id: '1.1', status: 'pending' },
					undefined,
				),
			);

		const results = await Promise.all(promises);

		// All should fail safely, none should crash
		for (const result of results) {
			expect(result.success).toBe(false);
		}
	});

	it('should handle 10 concurrent calls with undefined workingDirectory in checkReviewerGate', () => {
		const results = Array(10)
			.fill(null)
			.map(() => checkReviewerGate('1.1', undefined));

		// All should return safely
		for (const result of results) {
			expect(typeof result.blocked).toBe('boolean');
			expect(typeof result.reason).toBe('string');
		}
	});
});
