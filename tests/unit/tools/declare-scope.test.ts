import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advanceTaskState, getTaskState, swarmState } from '../../../src/state';
import {
	type DeclareScopeArgs,
	executeDeclareScope,
	validateFiles,
	validateTaskIdFormat,
} from '../../../src/tools/declare-scope';
import { createWorkflowTestSession } from '../../helpers/workflow-session-factory';

describe('validateTaskIdFormat', () => {
	test('accepts valid taskId formats', () => {
		expect(validateTaskIdFormat('1.1')).toBeUndefined();
		expect(validateTaskIdFormat('1.2.3')).toBeUndefined();
		expect(validateTaskIdFormat('10.20.30')).toBeUndefined();
		expect(validateTaskIdFormat('1.2.3.4')).toBeUndefined();
	});

	test('rejects invalid taskId formats', () => {
		expect(validateTaskIdFormat('1')).toBeDefined();
		expect(validateTaskIdFormat('a.b')).toBeDefined();
		expect(validateTaskIdFormat('.1.1')).toBeDefined();
		expect(validateTaskIdFormat('1.')).toBeDefined();
		expect(validateTaskIdFormat('1.1.a')).toBeDefined();
		expect(validateTaskIdFormat('')).toBeDefined();
		expect(validateTaskIdFormat('1.1.')).toBeDefined();
	});
});

describe('validateFiles', () => {
	test('accepts valid file paths', () => {
		expect(validateFiles(['src/index.ts'])).toEqual([]);
		expect(validateFiles(['/absolute/path/file.ts'])).toEqual([]);
		expect(validateFiles(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual([]);
	});

	test('rejects path with null byte', () => {
		const errors = validateFiles(['src/file\0.ts']);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('null bytes are not allowed');
	});

	test('rejects path with .. (path traversal)', () => {
		const errors = validateFiles(['src/../etc/passwd']);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain(
			'path traversal sequences (..) are not allowed',
		);
	});

	test('rejects path exceeding 4096 characters', () => {
		const longPath = 'a'.repeat(4097);
		const errors = validateFiles([longPath]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('exceeds maximum length of 4096 characters');
	});

	test('returns multiple errors when multiple files fail', () => {
		const errors = validateFiles(['src/../bad', 'b'.repeat(4097), 'good.ts']);
		expect(errors.length).toBe(2);
	});
});

describe('executeDeclareScope', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: Map<string, any>;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'declare-scope-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Save original agent sessions and clear for clean test state
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();

		// Create .swarm directory with a valid plan
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			migration_status: 'migrated',
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
							description: 'Test task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Test task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });

		// Restore original agent sessions
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}
	});

	// Test 1: Success path - valid taskId + files + plan with task
	test('success path: valid taskId + files + plan with task returns success', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts', 'src/utils.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(true);
		expect(result.taskId).toBe('1.1');
		expect(result.fileCount).toBe(2);
	});

	// Test 2: Invalid taskId format
	test('invalid taskId format returns error', async () => {
		const args: DeclareScopeArgs = {
			taskId: 'invalid',
			files: ['src/index.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('Invalid taskId');
	});

	// Test 3: Empty files array
	test('empty files array returns error', async () => {
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: [],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('files must be a non-empty array');
	});

	// Test 4: plan.json not found
	test('plan.json not found returns error', async () => {
		// Remove the .swarm directory
		fs.rmSync(path.join(tempDir, '.swarm'), { recursive: true });

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('plan.json not found');
	});

	// Test 5: taskId not in plan
	test('taskId not in plan returns error', async () => {
		const args: DeclareScopeArgs = {
			taskId: '99.99',
			files: ['src/index.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('does not exist in plan.json');
	});

	// Test 6: Task already 'complete' in plan.json
	test('task already complete returns error', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session-complete', session);

		// Update plan.json to mark task '1.1' as complete (authoritative source)
		const planPath = path.join(tempDir, '.swarm', 'plan.json');
		const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		plan.phases[0].tasks[0].status = 'completed';
		fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain(
			'Cannot declare scope for completed task',
		);
	});

	// Test 7: Whitelist merges into declaredCoderScope
	test('whitelist merges into declaredCoderScope - fileCount = files.length + whitelist.length', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts', 'src/utils.ts'],
			whitelist: ['lib/helper.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(true);
		// files (2) + whitelist (1) = 3
		expect(result.fileCount).toBe(3);
	});

	// Test 8: Sets declaredCoderScope and clears lastScopeViolation on session
	test('sets declaredCoderScope and clears lastScopeViolation on session', async () => {
		const session = createWorkflowTestSession({
			lastScopeViolation: 'Previous violation',
		});
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
		};

		await executeDeclareScope(args, tempDir);

		// Check that declaredCoderScope was set
		const updatedSession = swarmState.agentSessions.get('test-session');
		expect(updatedSession?.declaredCoderScope).toEqual(['src/index.ts']);

		// Check that lastScopeViolation was cleared
		expect(updatedSession?.lastScopeViolation).toBeNull();
	});

	// Test 9: Sets declaredCoderScope on ALL sessions
	test('sets declaredCoderScope on ALL active architect sessions', async () => {
		const session1 = createWorkflowTestSession();
		const session2 = createWorkflowTestSession();
		const session3 = createWorkflowTestSession();

		swarmState.agentSessions.set('session-1', session1);
		swarmState.agentSessions.set('session-2', session2);
		swarmState.agentSessions.set('session-3', session3);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
		};

		await executeDeclareScope(args, tempDir);

		// All sessions should have the scope set
		expect(
			swarmState.agentSessions.get('session-1')?.declaredCoderScope,
		).toEqual(['src/index.ts']);
		expect(
			swarmState.agentSessions.get('session-2')?.declaredCoderScope,
		).toEqual(['src/index.ts']);
		expect(
			swarmState.agentSessions.get('session-3')?.declaredCoderScope,
		).toEqual(['src/index.ts']);
	});

	// Test 10: working_directory validation - directory doesn't exist
	test('working_directory does not exist returns error', async () => {
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
			working_directory: '/nonexistent/path/12345',
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('does not exist or is inaccessible');
	});

	// Test 11: working_directory without plan.json
	test('working_directory without plan.json returns error', async () => {
		const noPlanDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'no-plan-test-')),
		);
		try {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/index.ts'],
				working_directory: noPlanDir,
			};

			const result = await executeDeclareScope(args, tempDir);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]).toContain('plan not found');
		} finally {
			fs.rmSync(noPlanDir, { recursive: true, force: true });
		}
	});

	// Test 12: working_directory with null byte
	test('working_directory with null byte returns error', async () => {
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
			working_directory: 'src\0/bad',
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('null bytes are not allowed');
	});

	// Test 13: working_directory with path traversal - on Windows path.normalize resolves ..,
	// so this test validates the code doesn't crash and handles non-existent paths correctly
	test('working_directory with path traversal returns error', async () => {
		// Create a valid directory structure to test
		const testDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'traversal-test-')),
		);
		const subDir = path.join(testDir, 'subdir');
		fs.mkdirSync(subDir, { recursive: true });

		// Use a path that would go up after normalization to a non-existent location
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
			working_directory: path.join(subDir, '..', '..', 'nonexistent'),
		};

		const result = await executeDeclareScope(args, tempDir);

		// This path doesn't exist so it should fail with "does not exist or is inaccessible"
		// which is the correct behavior - path.normalize resolves the ..
		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		// The actual error will be about path not existing, not traversal
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	// Test 14: working_directory with Windows device path
	test('working_directory with Windows device path returns error', async () => {
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
			working_directory: '\\\\.\\C:\\Windows',
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain(
			'Windows device paths are not allowed',
		);
	});

	// Test 15: Valid working_directory with valid plan succeeds
	test('valid working_directory with plan succeeds', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
			working_directory: tempDir,
		};

		const result = await executeDeclareScope(args, '/different/fallback');

		expect(result.success).toBe(true);
		expect(result.taskId).toBe('1.1');
	});

	// Issue #259: Absolute path normalization
	test('normalizes absolute paths to relative and returns warnings', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const absolutePath = path.join(
			tempDir,
			'src',
			'services',
			'price-calculator.ts',
		);
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: [absolutePath],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(true);
		expect(result.warnings).toBeDefined();
		// v6.71.1 (#519): a standing SCOPE ENFORCEMENT NOTE is always appended.
		const warnings = result.warnings ?? [];
		const normalizeWarning = warnings.find((w) =>
			w.includes('Absolute path normalized to relative'),
		);
		expect(normalizeWarning).toBeDefined();
		expect(normalizeWarning!).toContain('src/services/price-calculator.ts');

		// Verify the stored scope is relative, not absolute
		const updatedSession = swarmState.agentSessions.get('test-session');
		expect(updatedSession?.declaredCoderScope).toBeDefined();
		expect(updatedSession!.declaredCoderScope![0]).toBe(
			'src/services/price-calculator.ts',
		);
	});

	test('relative paths produce no normalization warnings', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts', 'tests/unit/test.ts'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(true);
		// v6.71.1 (#519): the standing SCOPE ENFORCEMENT NOTE is always appended,
		// but no per-path normalization warning is produced for relative inputs.
		const warnings = result.warnings ?? [];
		expect(warnings.some((w) => w.includes('Absolute path normalized'))).toBe(
			false,
		);
		expect(warnings.some((w) => w.includes('SCOPE ENFORCEMENT NOTE'))).toBe(
			true,
		);
	});

	test('mixed absolute and relative paths normalizes only absolute ones', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const absolutePath = path.join(tempDir, 'src', 'auth.ts');
		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts', absolutePath],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(true);
		expect(result.warnings).toBeDefined();
		// v6.71.1 (#519): a standing SCOPE ENFORCEMENT NOTE plus one normalization warning.
		const warnings = result.warnings ?? [];
		expect(warnings.some((w) => w.includes('Absolute path normalized'))).toBe(
			true,
		);
		expect(result.fileCount).toBe(2);

		const updatedSession = swarmState.agentSessions.get('test-session');
		expect(updatedSession?.declaredCoderScope).toEqual([
			'src/index.ts',
			'src/auth.ts',
		]);
	});

	test('rejects absolute paths that resolve outside the project directory', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['/etc/passwd'],
		};

		const result = await executeDeclareScope(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors![0]).toContain(
			'resolves outside the project directory',
		);
	});

	// Regression: when working_directory is not provided and fallbackDir is also
	// undefined, executeDeclareScope must NOT fall back to process.cwd() — it
	// should return an explicit error (FR-006).
	test('rejects when neither working_directory nor fallbackDir is provided', async () => {
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('test-session', session);

		const args: DeclareScopeArgs = {
			taskId: '1.1',
			files: ['src/index.ts'],
		};

		// Pass undefined as fallbackDir — should fail, not fall back to process.cwd()
		const result = await executeDeclareScope(args, undefined);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Cannot resolve project directory');
	});

	// Issue #922: Subdirectory containment check
	describe('subdirectory containment (Issue #922)', () => {
		test('accepts working_directory equal to project root (same dir)', async () => {
			const session = createWorkflowTestSession();
			swarmState.agentSessions.set('test-session', session);

			// working_directory === fallbackDir (same directory)
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/index.ts'],
				working_directory: tempDir,
			};

			const result = await executeDeclareScope(args, tempDir);

			expect(result.success).toBe(true);
			expect(result.taskId).toBe('1.1');
		});

		test('rejects working_directory that is a strict subdirectory of project root', async () => {
			const session = createWorkflowTestSession();
			swarmState.agentSessions.set('test-session', session);

			// Create a subdirectory that has its own .swarm/plan.json
			// (so it passes the existence check and reaches the containment check)
			const subDir = path.join(tempDir, 'src');
			fs.mkdirSync(path.join(subDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(subDir, '.swarm', 'plan.json'),
				JSON.stringify(
					{
						schema_version: '1.0.0',
						title: 'Sub Project',
						swarm: 'sub-swarm',
						current_phase: 1,
						migration_status: 'migrated',
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
										description: 'Sub task',
										depends: [],
										files_touched: [],
									},
								],
							},
						],
					},
					null,
					2,
				),
			);

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/index.ts'],
				working_directory: subDir,
			};

			const result = await executeDeclareScope(args, tempDir);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors![0]).toContain(
				'Subdirectory working_directory not allowed',
			);
		});

		test('accepts working_directory that is outside project root (different project)', async () => {
			const session = createWorkflowTestSession();
			swarmState.agentSessions.set('test-session', session);

			// Create a completely separate project directory with its own plan.json
			const otherProjectDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'other-project-')),
			);
			try {
				fs.mkdirSync(path.join(otherProjectDir, '.swarm'), { recursive: true });
				const otherPlan = {
					schema_version: '1.0.0',
					title: 'Other Project',
					swarm: 'other-swarm',
					current_phase: 1,
					migration_status: 'migrated',
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
									description: 'Task in other project',
									depends: [],
									files_touched: [],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(otherProjectDir, '.swarm', 'plan.json'),
					JSON.stringify(otherPlan, null, 2),
				);

				const args: DeclareScopeArgs = {
					taskId: '1.1',
					files: ['src/index.ts'],
					working_directory: otherProjectDir,
				};

				// tempDir is the injected project root; otherProjectDir is outside it
				const result = await executeDeclareScope(args, tempDir);

				expect(result.success).toBe(true);
				expect(result.taskId).toBe('1.1');
			} finally {
				fs.rmSync(otherProjectDir, { recursive: true, force: true });
			}
		});

		test('handles realpathSync correctly — canonical paths via symlink', async () => {
			const session = createWorkflowTestSession();
			swarmState.agentSessions.set('test-session', session);

			// Create a symlink to the tempDir to verify realpathSync canonicalizes correctly
			const symlinkDir = path.join(tempDir, 'symlink-root');
			try {
				fs.symlinkSync(tempDir, symlinkDir, 'junction' as any);

				const args: DeclareScopeArgs = {
					taskId: '1.1',
					files: ['src/index.ts'],
					working_directory: symlinkDir,
				};

				// Symlink resolves to same canonical path as tempDir — should be accepted
				const result = await executeDeclareScope(args, tempDir);

				expect(result.success).toBe(true);
				expect(result.taskId).toBe('1.1');
			} finally {
				// Clean up symlink (junction on Windows needs different handling)
				try {
					fs.unlinkSync(symlinkDir);
				} catch {
					// ignore
				}
			}
		});
	});
});
