/**
 * Phase 4 verification tests: Stack Trace Leakage Hotfix
 *
 * KEY BEHAVIORS TO VERIFY:
 * 1. update_task_status catch block returns only error.message, not stack frames
 * 2. A thrown Error from a wrapped tool (via createSwarmTool) returns sanitized JSON with only the message
 * 3. Sanitized error text does NOT contain: 'at execute', 'src/tool/registry.ts', 'src/session/prompt.ts', 'dist/index.js'
 * 4. createSwarmTool wrapper catches errors that the inner tool doesn't catch
 * 5. save-plan catch block returns sanitized error (test by mocking scenario where plan save throws)
 * 6. Non-Error throwables (e.g., throw 'string') are handled by the String(error) fallback without leaking stack
 *
 * STACK TRACE PATTERNS TO DETECT (all must be absent in sanitized output):
 * - 'at execute' — internal Bun/execution stack frame
 * - 'src/tool/registry.ts' — internal tool registry
 * - 'src/session/prompt.ts' — internal prompt handling
 * - 'dist/index.js' — compiled bundle path
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { closeProjectDb } from '../../../src/db/project-db';

// ========== STACK TRACE LEAKAGE PATTERNS ==========
const STACK_TRACE_PATTERNS = [
	'at execute',
	'src/tool/registry.ts',
	'src/session/prompt.ts',
	'dist/index.js',
] as const;
type StackTracePattern = (typeof STACK_TRACE_PATTERNS)[number];
/**
 * Check if text contains any stack trace leakage pattern.
 * Returns the pattern that was found, or null if clean.
 */
function findStackTraceLeak(text: string): StackTracePattern | null {
	for (const pattern of STACK_TRACE_PATTERNS) {
		if (text.includes(pattern)) {
			return pattern;
		}
	}
	return null;
}
// Helper to call tool execute with proper context
function createToolContext(directory: string): ToolContext {
	return { directory } as unknown as ToolContext;
}
// ========== GROUP 1: createSwarmTool centralized wrapper ==========
describe('createSwarmTool error sanitization', () => {
	test('thrown Error from wrapped tool returns sanitized JSON with only the message', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const throwingTool = createSwarmTool({
			description: 'A tool that throws',
			args: {} as Record<string, never>,
			execute: async () => {
				const err = new Error('This is a test error with stack trace');
				expect(err.stack).toBeDefined();
				expect(err.stack!.length).toBeGreaterThan(0);
				throw err;
			},
		});

		const result = await throwingTool.execute(
			{},
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('Tool execution failed');
		expect(parsed.errors).toBeDefined();
		expect(Array.isArray(parsed.errors)).toBe(true);
		expect(parsed.errors.length).toBe(1);

		const errorText = parsed.errors[0];
		expect(errorText).toBe('This is a test error with stack trace');

		const fullOutput = JSON.stringify(parsed);
		const leak = findStackTraceLeak(fullOutput);
		expect(leak).toBeNull();
	});

	test('inner tool error does NOT leak stack trace patterns to output', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const errorWithStack = new Error('Database connection failed');
		if (errorWithStack.stack) {
			errorWithStack.stack = `Error: Database connection failed
    at execute (/project/src/tools/registry.ts:45:11)
    at async /project/src/session/prompt.ts:120:5)
    at Object.<anonymous> (/project/dist/index.js:1:1)`;
		}

		const throwingTool = createSwarmTool({
			description: 'DB tool',
			args: {} as Record<string, never>,
			execute: async () => {
				throw errorWithStack;
			},
		});

		const result = await throwingTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.errors[0]).toBe('Database connection failed');

		const fullOutput = JSON.stringify(parsed);
		const leak = findStackTraceLeak(fullOutput);
		expect(leak).toBeNull();
	});

	test('createSwarmTool catches errors that inner tool does NOT catch (defense in depth)', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const unhandledTool = createSwarmTool({
			description: 'Tool with unhandled error',
			args: {} as Record<string, never>,
			execute: async () => {
				throw new Error('Unhandled error in inner tool');
			},
		});

		const result = await unhandledTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('Tool execution failed');
		expect(parsed.errors[0]).toBe('Unhandled error in inner tool');

		const fullOutput = JSON.stringify(parsed);
		const leak = findStackTraceLeak(fullOutput);
		expect(leak).toBeNull();
	});

	test('Non-Error throwables (throw "string") handled by String(error) fallback', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const stringThrowTool = createSwarmTool({
			description: 'Tool that throws a string',
			args: {} as Record<string, never>,
			execute: async () => {
				throw 'This is a string error';
			},
		});

		const result = await stringThrowTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toBe('This is a string error');
	});

	test('Error with empty message is handled gracefully', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const emptyMsgTool = createSwarmTool({
			description: 'Tool with empty error',
			args: {} as Record<string, never>,
			execute: async () => {
				const err = new Error('');
				throw err;
			},
		});

		const result = await emptyMsgTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		// Empty message is still returned (empty string)
		expect(parsed.errors[0]).toBe('');
	});

	test('Error with undefined message returns undefined (null in JSON)', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const undefinedMsgTool = createSwarmTool({
			description: 'Tool with undefined error',
			args: {} as Record<string, never>,
			execute: async () => {
				const err = new Error('original');
				err.message = undefined as any;
				throw err;
			},
		});

		const result = await undefinedMsgTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		// When error.message is undefined but error is still instanceof Error,
		// the check returns undefined (not the string "undefined")
		// JSON.stringify converts undefined to null in arrays
		expect(parsed.errors[0]).toBeNull();
	});
});

// ========== GROUP 2: update_task_status error sanitization ==========
describe('update_task_status error sanitization', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'update-task-status-sanitize-test-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		closeProjectDb(tempDir);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('catch block returns only error.message, not stack frames', async () => {
		const { executeUpdateTaskStatus } = await import(
			'../../../src/tools/update-task-status'
		);
		const { ensureAgentSession } = await import('../../../src/state');

		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test',
			current_phase: 1,
			migration_status: 'native',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		const session = ensureAgentSession('test-session', 'test-agent');
		session.taskWorkflowStates.set('1.1', 'tests_run');
		session.currentTaskId = '1.1';

		// Remove plan.json to trigger error
		fs.rmSync(path.join(tempDir, '.swarm', 'plan.json'));

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			tempDir,
		);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);

		// Verify errors are sanitized (no stack traces)
		const errorsStr = result.errors!.join(' ');
		const leak = findStackTraceLeak(errorsStr);
		expect(leak).toBeNull();

		// Errors should not contain 'at ' (stack frame indicator)
		for (const error of result.errors!) {
			expect(error).not.toContain('at ');
		}
	});

	test('updateTaskStatus catch block sanitizes Error objects to message only', async () => {
		const { executeUpdateTaskStatus } = await import(
			'../../../src/tools/update-task-status'
		);

		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test',
			current_phase: 1,
			migration_status: 'native',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		// Make plan.json a directory to trigger an error during write
		fs.rmSync(path.join(tempDir, '.swarm', 'plan.json'));
		fs.mkdirSync(path.join(tempDir, '.swarm', 'plan.json'));

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			tempDir,
		);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();

		// All errors should be messages, not stack traces
		for (const error of result.errors!) {
			expect(error).not.toContain('at ');
			expect(error).not.toContain('src/');
			expect(error).not.toContain('dist/');
		}

		const errorsStr = result.errors!.join(' ');
		const leak = findStackTraceLeak(errorsStr);
		expect(leak).toBeNull();
	});
});

// ========== GROUP 3: save-plan error sanitization ==========
describe('save-plan error sanitization', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'save-plan-sanitize-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		closeProjectDb(tempDir);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('catch block returns sanitized error when plan save throws', async () => {
		const { executeSavePlan } = await import('../../../src/tools/save-plan');

		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test',
			current_phase: 1,
			migration_status: 'native',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		// Make plan.json a directory to trigger a write error
		fs.rmSync(path.join(tempDir, '.swarm', 'plan.json'));
		fs.mkdirSync(path.join(tempDir, '.swarm', 'plan.json'));

		const args = {
			title: 'Updated Plan',
			swarm_id: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							description: 'Updated task',
						},
					],
				},
			],
			working_directory: tempDir,
		};

		const result = await executeSavePlan(args);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);

		// All errors should be sanitized messages, not stack traces
		const errorsStr = result.errors!.join(' ');
		const leak = findStackTraceLeak(errorsStr);
		expect(leak).toBeNull();

		for (const error of result.errors!) {
			expect(error).not.toContain('at ');
		}
	});

	test('save-plan returns only message, not stack, when updateTaskStatus throws', async () => {
		const { executeSavePlan } = await import('../../../src/tools/save-plan');

		const plan = {
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test',
			current_phase: 1,
			migration_status: 'native',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		fs.rmSync(path.join(tempDir, '.swarm', 'plan.json'));
		fs.mkdirSync(path.join(tempDir, '.swarm', 'plan.json'));

		const args = {
			title: 'Test Plan',
			swarm_id: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							description: 'Test',
						},
					],
				},
			],
			working_directory: tempDir,
		};

		const result = await executeSavePlan(args);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();

		const errorsStr = result.errors!.join(' ');
		const leak = findStackTraceLeak(errorsStr);
		expect(leak).toBeNull();
	});
});

// ========== GROUP 4: curator-analyze error sanitization ==========
describe('curator_analyze error sanitization', () => {
	test('catch block returns sanitized error via error.message', async () => {
		const { curator_analyze } = await import(
			'../../../src/tools/curator-analyze'
		);

		const result = await curator_analyze.execute(
			{ phase: -1 },
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		if (parsed.error) {
			expect(parsed.error).not.toContain('at ');
			expect(parsed.error).not.toContain('src/');
			expect(parsed.error).not.toContain('dist/');
		}
	});

	test('execute function returns only error.message, not stack', async () => {
		const { curator_analyze } = await import(
			'../../../src/tools/curator-analyze'
		);

		const result = await curator_analyze.execute(
			{ phase: 1 },
			createToolContext('/nonexistent/path'),
		);
		const parsed = JSON.parse(result);

		if (parsed.error) {
			const leak = findStackTraceLeak(parsed.error);
			expect(leak).toBeNull();
		}
	});
});

// ========== GROUP 5: phase-complete safeWarn sanitization (indirect test) ==========
describe('phase_complete safeWarn sanitization (indirect)', () => {
	test('phase_complete tool does not leak stack traces via safeWarn calls', async () => {
		const { phase_complete } = await import(
			'../../../src/tools/phase-complete'
		);

		// Call with valid phase but no sessionID - triggers error path
		const result = await phase_complete.execute(
			{ phase: 1, sessionID: undefined },
			createToolContext('/fake/dir'),
		);

		let parsed;
		try {
			parsed = JSON.parse(result);
		} catch {
			// If not JSON, verify no stack traces in raw result
			expect(result).not.toContain('at ');
			expect(result).not.toContain('src/');
			expect(result).not.toContain('dist/');
			return;
		}

		const fullOutput = JSON.stringify(parsed);
		const leak = findStackTraceLeak(fullOutput);
		expect(leak).toBeNull();

		if (parsed.message) {
			expect(parsed.message).not.toContain('at ');
			expect(parsed.message).not.toContain('src/');
		}
		if (parsed.warnings) {
			for (const warning of parsed.warnings) {
				expect(warning).not.toContain('at ');
				expect(warning).not.toContain('src/');
			}
		}
	});
});

// ========== GROUP 6: evidence/manager error sanitization ==========
describe('evidence/manager error sanitization', () => {
	test('loadEvidence catch block sanitizes errors in warn calls', async () => {
		const { loadEvidence } = await import('../../../src/evidence/manager');

		const tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-sanitize-test-')),
		);

		try {
			// Create a malformed evidence file
			fs.mkdirSync(path.join(tmpDir, 'evidence', '1.1'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, 'evidence', '1.1', 'evidence.json'),
				'{ invalid json }',
			);

			const originalWarn = console.warn;
			const warnCalls: string[] = [];
			console.warn = (...args: any[]) => {
				warnCalls.push(args.join(' '));
			};

			try {
				const result = await loadEvidence(tmpDir, '1.1');

				// Should return invalid_schema or not_found depending on how JSON parse fails
				expect(result.status).toMatch(/invalid_schema|not_found/);

				// Any warn calls should be sanitized
				for (const call of warnCalls) {
					expect(call).not.toContain('at ');
					expect(call).not.toContain('src/evidence/manager');
					expect(call).not.toContain('dist/index.js');
				}
			} finally {
				console.warn = originalWarn;
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ========== GROUP 7: commands error sanitization ==========
describe('commands error sanitization', () => {
	test('rollback handles missing checkpoint gracefully', async () => {
		const { handleRollbackCommand } = await import(
			'../../../src/commands/rollback'
		);

		const tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-sanitize-test-')),
		);

		try {
			// No checkpoint structure - should return error message
			const result = await handleRollbackCommand(tmpDir, ['1']);

			// Error message should not contain stack traces
			expect(result).not.toContain('at ');
			expect(result).not.toContain('src/commands/rollback');
			expect(result).not.toContain('dist/index.js');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('promote command returns only error.message in catch blocks', async () => {
		const { handlePromoteCommand } = await import(
			'../../../src/commands/promote'
		);

		// Call with invalid text that fails validation
		const result = await handlePromoteCommand('/fake/dir', [
			'[invalid placeholder]',
		]);

		// If it returns an error message, it should be sanitized
		if (result.includes('rejected') || result.includes('Failed')) {
			expect(result).not.toContain('at ');
			expect(result).not.toContain('src/commands/promote');
		}
	});

	test('curate command returns only error.message in catch block', async () => {
		const { handleCurateCommand } = await import(
			'../../../src/commands/curate'
		);

		// Call with directory that causes an error
		const result = await handleCurateCommand(
			'/nonexistent/path/that/does/not/exist',
			[],
		);

		// If it returns an error, it should be sanitized
		if (result.includes('failed') || result.includes('Failed')) {
			expect(result).not.toContain('at ');
			expect(result).not.toContain('src/commands/curate');
			expect(result).not.toContain('stack');
		}
	});

	test('dark-matter command uses sanitized console.warn', async () => {
		const { handleDarkMatterCommand } = await import(
			'../../../src/commands/dark-matter'
		);

		const tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dark-matter-sanitize-test-')),
		);

		try {
			// Create a minimal git repo to trigger dark matter detection
			fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

			const originalWarn = console.warn;
			const warnCalls: string[] = [];
			console.warn = (...args: any[]) => {
				warnCalls.push(args.join(' '));
			};

			try {
				await handleDarkMatterCommand(tmpDir, []);

				// Any warn calls should be sanitized
				for (const call of warnCalls) {
					expect(call).not.toContain('at ');
					expect(call).not.toContain('src/commands/dark-matter');
					expect(call).not.toContain('dist/index.js');
				}
			} finally {
				console.warn = originalWarn;
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ========== GROUP 8: Negative tests - ensure patterns ARE detected when present ==========
describe('stack trace detection verification', () => {
	test('findStackTraceLeak correctly detects "at execute" pattern', () => {
		const text =
			'Error: something failed\n    at execute (/app/src/tool/registry.ts:45:11)';
		const leak = findStackTraceLeak(text);
		expect(leak).toBe('at execute');
	});

	test('findStackTraceLeak correctly detects "src/tool/registry.ts" pattern', () => {
		const text = 'Error at /app/src/tool/registry.ts line 100';
		const leak = findStackTraceLeak(text);
		expect(leak).toBe('src/tool/registry.ts');
	});

	test('findStackTraceLeak correctly detects "src/session/prompt.ts" pattern', () => {
		const text = 'Error in /app/src/session/prompt.ts';
		const leak = findStackTraceLeak(text);
		expect(leak).toBe('src/session/prompt.ts');
	});

	test('findStackTraceLeak correctly detects "dist/index.js" pattern', () => {
		const text = 'at Object.<anonymous> (/app/dist/index.js:1:1)';
		const leak = findStackTraceLeak(text);
		expect(leak).toBe('dist/index.js');
	});

	test('findStackTraceLeak returns null for clean text', () => {
		const text =
			'This is a clean error message without any stack trace patterns';
		const leak = findStackTraceLeak(text);
		expect(leak).toBeNull();
	});

	test('findStackTraceLeak returns null when only error.message is present', () => {
		const text = 'Database connection failed: could not connect to server';
		const leak = findStackTraceLeak(text);
		expect(leak).toBeNull();
	});
});

// ========== GROUP 9: Adversarial - oversized errors ==========
describe('adversarial error handling', () => {
	test('oversized Error message does not cause issues', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const largeMessage = 'x'.repeat(100000);
		const largeErrorTool = createSwarmTool({
			description: 'Large error tool',
			args: {} as Record<string, never>,
			execute: async () => {
				throw new Error(largeMessage);
			},
		});

		const result = await largeErrorTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0].length).toBe(100000);
		const leak = findStackTraceLeak(JSON.stringify(parsed));
		expect(leak).toBeNull();
	});

	test('circular reference in error object handled gracefully', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const circularTool = createSwarmTool({
			description: 'Circular error tool',
			args: {} as Record<string, never>,
			execute: async () => {
				const err: any = new Error('Circular reference test');
				err.self = err;
				throw err;
			},
		});

		const result = await circularTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toBeDefined();
	});

	test('null error thrown is handled by String() fallback', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const nullThrowTool = createSwarmTool({
			description: 'Null throw tool',
			args: {} as Record<string, never>,
			execute: async () => {
				throw null;
			},
		});

		const result = await nullThrowTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toBe('null');
	});

	test('undefined error thrown is handled by String() fallback', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const undefinedThrowTool = createSwarmTool({
			description: 'Undefined throw tool',
			args: {} as Record<string, never>,
			execute: async () => {
				throw undefined;
			},
		});

		const result = await undefinedThrowTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toBe('undefined');
	});

	test('number error thrown is handled by String() fallback', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const numberThrowTool = createSwarmTool({
			description: 'Number throw tool',
			args: {} as Record<string, never>,
			execute: async () => {
				throw 42;
			},
		});

		const result = await numberThrowTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toBe('42');
	});

	test('object error thrown is handled by String() fallback', async () => {
		const { createSwarmTool } = await import('../../../src/tools/create-tool');

		const objectThrowTool = createSwarmTool({
			description: 'Object throw tool',
			args: {} as Record<string, never>,
			execute: async () => {
				throw { code: 'ERR_TEST', message: 'Test object error' };
			},
		});

		const result = await objectThrowTool.execute(
			{},
			createToolContext('/fake/dir'),
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toBeDefined();
	});
});

// ========== GROUP 10: Integration - full tool pipeline ==========
describe('full tool pipeline sanitization', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'full-pipeline-test-')),
		);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		closeProjectDb(tempDir);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('update_task_status tool definition execute returns sanitized output', async () => {
		const { update_task_status } = await import(
			'../../../src/tools/update-task-status'
		);

		const plan = {
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test',
			current_phase: 1,
			migration_status: 'native',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		const result = await update_task_status.execute(
			{ task_id: '1.1', status: 'in_progress' },
			createToolContext(tempDir),
		);

		const parsed = JSON.parse(result);

		if (parsed.success) {
			const fullOutput = JSON.stringify(parsed);
			const leak = findStackTraceLeak(fullOutput);
			expect(leak).toBeNull();
		}
	});

	test('save_plan tool definition execute returns sanitized output', async () => {
		const { save_plan } = await import('../../../src/tools/save-plan');

		const result = await save_plan.execute(
			{
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{
								id: '1.1',
								description: 'Test task',
							},
						],
					},
				],
				working_directory: tempDir,
			},
			createToolContext(tempDir),
		);

		const parsed = JSON.parse(result);

		if (parsed.success) {
			const fullOutput = JSON.stringify(parsed);
			const leak = findStackTraceLeak(fullOutput);
			expect(leak).toBeNull();
		}
	});
});
