import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swarmState } from '../../../src/state';
import { executeCompletionVerify } from '../../../src/tools/completion-verify';

// Helper to create a mock plan.json
function createPlanFile(dir: string, plan: object) {
	const planPath = join(dir, '.swarm', 'plan.json');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(planPath, JSON.stringify(plan), 'utf-8');
}

// Helper to create a source file
function createSourceFile(dir: string, filePath: string, content: string) {
	const fullPath = join(dir, filePath);
	mkdirSync(join(dir, filePath).replace(/[/\\][^/\\]+$/, ''), {
		recursive: true,
	});
	writeFileSync(fullPath, content, 'utf-8');
}

// Helper to check if evidence file was written
function evidenceExists(dir: string, phase: number): boolean {
	const evidencePath = join(
		dir,
		'.swarm',
		'evidence',
		`${phase}`,
		'completion-verify.json',
	);
	return existsSync(evidencePath);
}

// Helper to read evidence file
function readEvidence(dir: string, phase: number): object | null {
	const evidencePath = join(
		dir,
		'.swarm',
		'evidence',
		`${phase}`,
		'completion-verify.json',
	);
	if (!existsSync(evidencePath)) return null;
	return JSON.parse(readFileSync(evidencePath, 'utf-8'));
}

describe('completion-verify unit tests', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'completion-verify-test-'));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('1. Happy path - identifiers exist in target files', () => {
		test('returns passed when task identifiers are found in source files', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/helper.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/utils/helper.ts',
				'export function myFunction() { return 42; }',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.tasksBlocked).toBe(0);
			expect(parsed.tasksChecked).toBe(1);
			expect(parsed.tasksSkipped).toBe(0);
		});

		test('returns passed with multiple tasks all verified', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `helperFn` in src/utils/helper.ts',
								status: 'completed',
							},
							{
								id: '1.2',
								description: 'Create `Validator` in src/types/validator.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/utils/helper.ts',
				'export function helperFn() {}',
			);
			createSourceFile(
				testDir,
				'src/types/validator.ts',
				'export class Validator {}',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.tasksBlocked).toBe(0);
			expect(parsed.tasksChecked).toBe(2);
		});

		test('files_touched without identifiers blocks (foundCount=0)', async () => {
			// When files_touched has paths but description has no identifiers,
			// the task blocks because foundCount stays 0
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Update some config',
								status: 'completed',
								files_touched: ['src/config/settings.ts'],
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/config/settings.ts',
				'export const CONFIG = { version: 1 };',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			// Without identifiers to find, foundCount === 0 blocks the task
			expect(parsed.status).toBe('blocked');
			expect(parsed.tasksBlocked).toBe(1);
		});
	});

	describe('2. Blocked path - file not found', () => {
		test('returns blocked when target file does not exist', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/missing.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			// Do NOT create the source file

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(parsed.tasksBlocked).toBe(1);
			// blockedTasks has 2 entries: one for file-not-found, one for "no identifiers found"
			expect(parsed.blockedTasks.length).toBeGreaterThanOrEqual(1);
			expect(parsed.blockedTasks[0].task_id).toBe('1.1');
			expect(parsed.blockedTasks[0].reason).toContain('not found');
		});
	});

	describe('3. Blocked path - identifiers not found', () => {
		test('returns blocked when identifiers are NOT in target files', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/helper.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			// File exists but does NOT contain 'myFunction'
			createSourceFile(
				testDir,
				'src/utils/helper.ts',
				'export function otherFunction() {}',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(parsed.tasksBlocked).toBe(1);
			expect(parsed.blockedTasks).toHaveLength(1);
			expect(parsed.blockedTasks[0].reason).toContain('No identifiers found');
		});
	});

	describe('4. Skip path - no parseable file paths (research/inventory tasks)', () => {
		test('skips task with no file paths in description — research tasks are unverifiable, not incomplete', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Update documentation',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			// Research/inventory tasks have no file targets — they are skipped, not blocked.
			// Absence of file targets is not evidence of incompleteness.
			expect(parsed.status).toBe('passed');
			expect(parsed.tasksBlocked).toBe(0);
			expect(parsed.tasksSkipped).toBe(1);
			expect(parsed.tasksChecked).toBe(1);
		});
	});

	describe('5. Skip path - no identifiers AND no file paths', () => {
		test('skips task with no identifiers and no file paths (unverifiable research task)', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description:
									'Just a simple task description with no specific identifiers or file paths mentioned',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			// No file targets → skipped, not blocked. Phase can proceed.
			expect(parsed.status).toBe('passed');
			expect(parsed.tasksBlocked).toBe(0);
			expect(parsed.tasksSkipped).toBe(1);
		});
	});

	describe('6. Invalid phase number', () => {
		test('returns blocked for phase=0', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [],
					},
				],
			};
			createPlanFile(testDir, plan);

			const result = await executeCompletionVerify({ phase: 0 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('Invalid phase number');
		});

		test('returns blocked for phase=-1', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [],
					},
				],
			};
			createPlanFile(testDir, plan);

			const result = await executeCompletionVerify({ phase: -1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('Invalid phase number');
		});
	});

	describe('7. Missing plan.json', () => {
		test('returns passed with reason when plan.json does not exist', async () => {
			// Do NOT create plan.json

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.reason).toBe('Cannot verify without plan.json');
		});
	});

	describe('8. Phase not found', () => {
		test('returns blocked when phase number not in plan', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Phase One',
						tasks: [],
					},
				],
			};
			createPlanFile(testDir, plan);

			const result = await executeCompletionVerify({ phase: 2 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('Phase 2 not found in plan.json');
		});
	});

	describe('9. Evidence file written', () => {
		test('writes evidence to .swarm/evidence/{phase}/completion-verify.json', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/helper.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/utils/helper.ts',
				'export function myFunction() {}',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(evidenceExists(testDir, 1)).toBe(true);

			const evidence = readEvidence(testDir, 1) as any;
			expect(evidence.schema_version).toBe('1.0.0');
			expect(evidence.entries).toHaveLength(1);
			expect(evidence.entries[0].verdict).toBe('pass');
			expect(evidence.entries[0].tasks_checked).toBe(1);
		});

		test('writes fail verdict when blocked', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/missing.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			// No source file

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(evidenceExists(testDir, 1)).toBe(true);

			const evidence = readEvidence(testDir, 1) as any;
			expect(evidence.entries[0].verdict).toBe('fail');
			expect(evidence.entries[0].tasks_blocked).toBe(1);
		});
	});

	describe('10. Non-completed tasks skipped', () => {
		test('only checks tasks with status=completed', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/helper.ts',
								status: 'completed',
							},
							{
								id: '1.2',
								description: 'Update config',
								status: 'pending',
							},
							{
								id: '1.3',
								description: 'Refactor something',
								status: 'in_progress',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/utils/helper.ts',
				'export function myFunction() {}',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.tasksChecked).toBe(1); // Only 1.1 is completed
			expect(parsed.tasksSkipped).toBe(0); // No completed task was skipped
		});
	});

	describe('Identifier parsing edge cases', () => {
		test('parses backtick-wrapped identifiers correctly', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `createUser` in src/models/user.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/models/user.ts',
				'export function createUser() {}',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
		});

		test('parses camelCase identifiers correctly', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Implement userService in src/services/user.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/services/user.ts',
				'const userService = {}; export default userService;',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
		});

		test('parses PascalCase identifiers correctly', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description:
									'Create DataProcessor class in src/utils/processor.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/utils/processor.ts',
				'export class DataProcessor {}',
			);

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
		});

		test('identifier found in one of multiple files passes', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description:
									'Update `helper` across src/utils/a.ts and src/utils/b.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(testDir, 'src/utils/a.ts', '// no helper here');
			createSourceFile(testDir, 'src/utils/b.ts', 'export const helper = 42;');

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.tasksBlocked).toBe(0);
		});
	});

	describe('Turbo Mode bypass', () => {
		// Save/restore to avoid polluting global swarmState between tests
		let originalAgentSessions: Map<string, any>;

		beforeEach(() => {
			// Save original state
			originalAgentSessions = swarmState.agentSessions;
		});

		afterEach(() => {
			// Restore original state
			swarmState.agentSessions = originalAgentSessions;
		});

		test('returns passed with turbo bypass reason when turbo mode is active', async () => {
			swarmState.agentSessions = new Map([
				['test-session', { turboMode: true } as any],
			]);

			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/missing.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			// No source file: the caller's own Turbo session bypasses this check.
			const result = await executeCompletionVerify(
				{ phase: 1, sessionID: 'test-session' },
				testDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.reason).toContain('Turbo');
			expect(parsed.reason).toContain('bypass');
			expect(parsed.tasksChecked).toBe(0);
			expect(parsed.tasksBlocked).toBe(0);
			// Evidence should NOT be written since it returns early before evidence write
			expect(evidenceExists(testDir, 1)).toBe(false);
		});

		test('returns blocked result when turbo mode is not active', async () => {
			// Ensure no turbo sessions - use empty Map so hasActiveTurboMode returns false
			swarmState.agentSessions = new Map();

			const plan = {
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						tasks: [
							{
								id: '1.1',
								description: 'Create `myFunction` in src/utils/missing.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			// Do NOT create the source file - should be blocked

			const result = await executeCompletionVerify({ phase: 1 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('blocked');
			expect(parsed.tasksBlocked).toBe(1);
		});
	});

	describe('Multiple phases in plan', () => {
		test('checks only the specified phase', async () => {
			const plan = {
				phases: [
					{
						id: 1,
						name: 'Phase One',
						tasks: [
							{
								id: '1.1',
								description: 'Create `missingFn` in src/missing.ts',
								status: 'completed',
							},
						],
					},
					{
						id: 2,
						name: 'Phase Two',
						tasks: [
							{
								id: '2.1',
								description: 'Create `existingFn` in src/existing.ts',
								status: 'completed',
							},
						],
					},
				],
			};
			createPlanFile(testDir, plan);
			createSourceFile(
				testDir,
				'src/existing.ts',
				'export function existingFn() {}',
			);

			// Phase 1 has a blocked task, but we check phase 2 which is fine
			const result = await executeCompletionVerify({ phase: 2 }, testDir);
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('passed');
			expect(parsed.tasksChecked).toBe(1);
			expect(parsed.tasksBlocked).toBe(0);
		});
	});
});
