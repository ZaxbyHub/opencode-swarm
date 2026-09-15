/**
 * Tests for working_directory parameter override in tools that read .swarm/ state.
 *
 * Validates the fix for: completion_verify, phase_complete, and check_gate_status
 * all resolving .swarm/ relative to CWD instead of project root when CWD != project root.
 *
 * The fix adds a working_directory parameter to these tools, consistent with save_plan
 * and update_task_status which already had it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { executeCompletionVerify } from '../../../src/tools/completion-verify';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

// Helper to call check_gate_status with context
async function executeCheckGateStatus(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	return check_gate_status.execute(args, {
		directory,
	} as unknown as ToolContext);
}

describe('working_directory override — check_gate_status', () => {
	let wrongDir: string;
	let rightDir: string;

	beforeEach(() => {
		// Simulate the bug: CWD (wrongDir) != project root (rightDir)
		wrongDir = mkdtempSync(path.join(os.tmpdir(), 'wrong-cwd-'));
		rightDir = mkdtempSync(path.join(os.tmpdir(), 'right-project-'));

		// Set up evidence in the RIGHT directory
		const evidenceDir = path.join(rightDir, '.swarm', 'evidence');
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			path.join(evidenceDir, '1.6.json'),
			JSON.stringify({
				taskId: '1.6',
				required_gates: ['pre_check', 'reviewer', 'test_engineer'],
				gates: {
					pre_check: {
						sessionId: 'pre-check-session',
						timestamp: '2026-09-14T00:00:00.000Z',
						agent: 'pre_check_batch',
					},
					reviewer: {
						sessionId: 'test-session',
						timestamp: new Date().toISOString(),
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test-session',
						timestamp: new Date().toISOString(),
						agent: 'test_engineer',
					},
				},
				workflow: { state: 'tests_run', generation: 1 },
			}),
			'utf-8',
		);

		// wrongDir has NO .swarm/ at all — simulates reading stale/missing data
	});

	afterEach(() => {
		try {
			rmSync(wrongDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		try {
			rmSync(rightDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});

	it('reads evidence from wrong directory when working_directory is not provided', async () => {
		// Without fix: ctx.directory points to wrongDir (simulating CWD mismatch)
		const result = await executeCheckGateStatus(
			{ task_id: '1.6' },
			wrongDir, // This is the "CWD" — wrong directory
		);
		const parsed = JSON.parse(result);

		// Should NOT find evidence (it's in rightDir, not wrongDir)
		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('No evidence file found');
	});

	it('reads evidence from correct directory when working_directory is provided', async () => {
		// With fix: working_directory overrides the ctx.directory
		const result = await executeCheckGateStatus(
			{ task_id: '1.6', working_directory: rightDir },
			wrongDir, // ctx.directory still points to wrong place
		);
		const parsed = JSON.parse(result);

		// Should find evidence because working_directory pointed to the right place
		expect(parsed.status).toBe('all_passed');
		expect(parsed.passed_gates).toContain('reviewer');
		expect(parsed.passed_gates).toContain('test_engineer');
	});

	it('rejects invalid working_directory with null bytes', async () => {
		const result = await executeCheckGateStatus(
			{ task_id: '1.6', working_directory: '/some/path\0/bad' },
			wrongDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('null bytes');
	});

	it('rejects non-existent working_directory', async () => {
		const result = await executeCheckGateStatus(
			{
				task_id: '1.6',
				working_directory: '/definitely/not/real/path/xyz',
			},
			wrongDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('does not exist');
	});
});

describe('working_directory override — completion_verify (via executeCompletionVerify)', () => {
	let wrongDir: string;
	let rightDir: string;

	beforeEach(() => {
		wrongDir = mkdtempSync(path.join(os.tmpdir(), 'wrong-cwd-cv-'));
		rightDir = mkdtempSync(path.join(os.tmpdir(), 'right-project-cv-'));

		// Create plan.json in the RIGHT directory with a completed task
		const swarmDir = path.join(rightDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{
								id: '1.1',
								description: 'Create `helperFunction` in src/utils/helper.ts',
								status: 'completed',
								files_touched: ['src/utils/helper.ts'],
							},
						],
					},
				],
			}),
			'utf-8',
		);

		// Create the source file in the RIGHT directory
		const srcDir = path.join(rightDir, 'src', 'utils');
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(
			path.join(srcDir, 'helper.ts'),
			'export function helperFunction() { return 42; }',
			'utf-8',
		);

		// wrongDir has NO .swarm/ — simulates CWD mismatch
	});

	afterEach(() => {
		try {
			rmSync(wrongDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		try {
			rmSync(rightDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});

	it('reads plan.json from wrong dir when called with wrong directory', async () => {
		// Without fix: directory points to wrongDir
		const result = await executeCompletionVerify({ phase: 1 }, wrongDir);
		const parsed = JSON.parse(result);

		// Should pass vacuously (can't find plan.json)
		expect(parsed.status).toBe('passed');
		expect(parsed.reason).toContain('Cannot verify without plan.json');
	});

	it('reads plan.json from correct dir when called with right directory', async () => {
		// With fix: directory points to rightDir
		const result = await executeCompletionVerify({ phase: 1 }, rightDir);
		const parsed = JSON.parse(result);

		// Should actually verify and pass (identifiers found in source files)
		expect(parsed.status).toBe('passed');
		expect(parsed.tasksChecked).toBe(1);
		expect(parsed.tasksBlocked).toBe(0);
	});
});

describe('working_directory override — phase_complete (via executePhaseComplete)', () => {
	let wrongDir: string;
	let rightDir: string;

	beforeEach(() => {
		wrongDir = mkdtempSync(path.join(os.tmpdir(), 'wrong-cwd-pc-'));
		rightDir = mkdtempSync(path.join(os.tmpdir(), 'right-project-pc-'));

		// Create a minimal .swarm/ in the RIGHT directory with config
		const swarmDir = path.join(rightDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(wrongDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		try {
			rmSync(rightDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});

	it('loads config from correct directory when working_directory is provided', async () => {
		// executePhaseComplete(args, workingDirectory, directory)
		// With fix: both params are set to rightDir, so line 322's
		// `const dir = workingDirectory || directory!` always resolves correctly.
		// Without a sessionID in swarmState the tool returns early, but we can
		// still verify it ran, accepted the phase, and didn't crash trying to
		// read config from the wrong directory.
		const result = await executePhaseComplete(
			{ phase: 1 },
			rightDir, // workingDirectory — the override
			wrongDir, // directory — the fallback (wrong)
		);
		const parsed = JSON.parse(result);

		// Phase complete should execute and reference the correct phase
		expect(parsed.phase).toBe(1);
		// Returns valid JSON with expected keys (success may be false due to missing sessionID)
		expect(typeof parsed.success).toBe('boolean');
		expect(typeof parsed.message).toBe('string');
	});

	it('uses directory fallback when workingDirectory is not provided', async () => {
		// When workingDirectory is undefined, falls back to directory param
		const result = await executePhaseComplete(
			{ phase: 1 },
			undefined, // no override
			rightDir, // directory fallback — correct
		);
		const parsed = JSON.parse(result);

		expect(parsed.phase).toBe(1);
		expect(typeof parsed.success).toBe('boolean');
		expect(typeof parsed.message).toBe('string');
	});
});
