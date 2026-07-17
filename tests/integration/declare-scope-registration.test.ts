import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { declare_scope } from '../../src/tools';
import { executeDeclareScope } from '../../src/tools/declare-scope';

describe('declare_scope tool registration integration', () => {
	let tempDir: string;
	let sessionID: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declare-scope-int-'));

		// Create required .swarm directory
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Write a schema-valid plan.json with task "1.1".
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Declare scope integration fixture',
			swarm: 'fixture-swarm',
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
							description: 'Test task 1.1',
							status: 'pending',
							size: 'small',
							depends: [],
							files_touched: ['src/test.ts', 'src/utils.ts'],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		// Reset swarm state and setup session
		resetSwarmState();
		sessionID = `test-session-${Date.now()}`;
		ensureAgentSession(sessionID, 'architect');
	});

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		resetSwarmState();
	});

	describe('export verification', () => {
		it('should export declare_scope from src/tools/index.ts', () => {
			// This verifies the import resolves and declare_scope is defined
			expect(declare_scope).toBeDefined();
		});

		it('should have declare_scope as a valid tool definition with execute function', () => {
			expect(declare_scope).toBeDefined();
			expect(typeof declare_scope.execute).toBe('function');
		});

		it('should have description mentioning "scope"', () => {
			expect(declare_scope).toBeDefined();
			expect(declare_scope.description).toBeDefined();
			expect(declare_scope.description.toLowerCase()).toContain('scope');
		});
	});

	describe('end-to-end execution', () => {
		it('should successfully execute declare_scope with valid args', async () => {
			const args = {
				taskId: '1.1',
				files: ['src/test.ts', 'src/utils.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(true);
			expect(parsed.message).toBe('Scope declared successfully');
			expect(parsed.taskId).toBe('1.1');
			expect(parsed.fileCount).toBe(2);
		});

		it('should successfully execute declare_scope with files and whitelist', async () => {
			const args = {
				taskId: '1.1',
				files: ['src/test.ts'],
				whitelist: ['src/utils.ts', 'src/helpers.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(true);
			expect(parsed.fileCount).toBe(3); // 1 file + 2 whitelist
		});

		it('should fail when task does not exist in plan', async () => {
			const args = {
				taskId: '99.99',
				files: ['src/test.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(false);
			expect(parsed.errors).toContain('Task 99.99 does not exist in plan.json');
		});

		it('should fail when files array is empty', async () => {
			const args = {
				taskId: '1.1',
				files: [],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(false);
			expect(parsed.errors).toContain('files must be a non-empty array');
		});

		it('should fail when taskId format is invalid', async () => {
			const args = {
				taskId: 'invalid',
				files: ['src/test.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(false);
			expect(parsed.errors?.[0]).toMatch(/Invalid taskId/);
		});

		it('should fail when working_directory does not exist', async () => {
			const args = {
				taskId: '1.1',
				files: ['src/test.ts'],
				working_directory: '/nonexistent/path/12345',
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(false);
			expect(parsed.errors?.[0]).toMatch(/does not exist/);
		});

		it('should reject path traversal in files', async () => {
			const args = {
				taskId: '1.1',
				files: ['src/../../../etc/passwd'],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(false);
			expect(parsed.errors?.[0]).toMatch(/path traversal/);
		});

		it('should reject null bytes in files', async () => {
			const args = {
				taskId: '1.1',
				files: ['src/test.ts\0'],
			};

			const result = await executeDeclareScope(args, tempDir);
			const parsed = typeof result === 'string' ? JSON.parse(result) : result;

			expect(parsed.success).toBe(false);
			expect(parsed.errors?.[0]).toMatch(/null bytes/);
		});
	});
});
