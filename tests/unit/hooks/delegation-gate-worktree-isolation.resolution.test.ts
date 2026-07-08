/**
 * Worktree isolation tests (delegation-gate-worktree-isolation.test.ts — Part 1 of 2)
 *
 * Covers:
 * - Worktree path resolution
 * - Cross-worktree delegation blocking
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	_internals as isolationInternals,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resolveScopeWithFallbacks } from '../../../src/scope/scope-persistence';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	attemptMergeBackFromDirty,
	postMergeCleanup,
	provisionWorktree,
	removeWorktree,
} from '../../../src/worktree';

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function writePlanJson(
	dir: string,
	options: {
		tasks?: Array<{
			id: string;
			status?: string;
			depends?: string[];
			phase?: number;
		}>;
		currentPhase?: number;
	},
): void {
	const phase = options.currentPhase ?? 1;
	const tasks = options.tasks ?? [
		{ id: '1.1', status: 'pending' },
		{ id: '1.2', status: 'pending' },
	];
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phase,
		phases: [
			{
				id: phase,
				name: `Phase ${phase}`,
				status: 'in_progress',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: task.phase ?? phase,
					status: task.status ?? 'pending',
					size: 'small' as const,
					description: `Task ${task.id}`,
					depends: task.depends ?? [],
					files_touched: [],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

async function callToolBefore(
	hook: ReturnType<typeof createDelegationGateHook>,
	tool: string,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolBefore(
		{ tool, sessionID, callID: `call-${Date.now()}` },
		{ args },
	);
}

describe('delegation-gate: worktree isolation', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-worktree-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
	});

	afterEach(() => {
		resetSwarmState();
		// Restore isolation _internals to real implementations (AGENTS.md invariant 7)
		isolationInternals.provisionWorktree = provisionWorktree;
		isolationInternals.removeWorktree = removeWorktree;
		isolationInternals.attemptMergeBackFromDirty = attemptMergeBackFromDirty;
		isolationInternals.postMergeCleanup = postMergeCleanup;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('should isolate delegation state by project directory', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	it('should handle symlinked worktree paths', async () => {
		// Create a symlink to the temp directory
		const symlinkDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'delegation-gate-symlink-'),
		);
		try {
			// On Windows, symlinks may require admin privileges, so skip if it fails
			fs.symlinkSync(tempDir, path.join(symlinkDir, 'worktree'));
		} catch {
			// Symlinks not available, skip test
			return;
		}

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);

		// Cleanup
		try {
			fs.rmSync(symlinkDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('should handle nested project directories', async () => {
		const nestedDir = path.join(tempDir, 'nested', 'project');
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.mkdirSync(path.join(nestedDir, '.swarm'), { recursive: true });

		const plan: Plan = {
			schema_version: '1.0.0' as const,
			title: 'Nested Plan',
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
							status: 'pending',
							size: 'small' as const,
							description: 'Task 1.1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(nestedDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		const hook = createDelegationGateHook(makeConfig(), nestedDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	// SC-104: executable test for pendingAdvisoryMessages emission on skip + test/build gates
	it('SC-104: precreateStandardWorktreeSession with deps_strategy skip and test-containing description emits WORKTREE_DEPS_SKIP advisory', async () => {
		// Fabricate a client so precreate does not hit the UNAVAILABLE path
		const createdDirs: string[] = [];
		swarmState.opencodeClient = {
			session: {
				create: async (opts: any) => {
					createdDirs.push(opts.query.directory);
					return { data: { id: 'sess-lane-123' } };
				},
			},
		} as any;

		// Stub provisionWorktree to succeed (we only care about the advisory path after it)
		const origProvision = isolationInternals.provisionWorktree;
		isolationInternals.provisionWorktree = async () => ({
			worktreePath: path.join(tempDir, '.swarm-worktrees', 'sess', 't1'),
			branchName: 'swarm/lane/sess/t1',
			purpose: 'lane',
			id: 't1',
			sessionId: 'sess',
		});

		try {
			const session = ensureAgentSession('sc104-session');
			session.pendingAdvisoryMessages = [];

			await precreateStandardWorktreeSession({
				config: {
					worktree: {
						policy: 'auto',
						merge_strategy: 'merge',
						deps_strategy: 'skip',
					},
				} as any,
				directory: tempDir,
				parentSessionID: 'sc104-session',
				callID: 'call-sc104',
				taskId: 'task-sc104',
				description: 'run tests and build the feature',
				outputArgs: {},
			});

			expect(session.pendingAdvisoryMessages).toBeDefined();
			expect(session.pendingAdvisoryMessages!.length).toBeGreaterThan(0);
			const advisory = session.pendingAdvisoryMessages!.find((m) =>
				m.includes('WORKTREE_DEPS_SKIP'),
			);
			expect(advisory).toBeDefined();
			expect(advisory).toContain('task-sc104');
			expect(advisory).toContain("deps_strategy: 'skip'");
		} finally {
			isolationInternals.provisionWorktree = origProvision;
			swarmState.opencodeClient = undefined;
		}
	});

	// SC-104 negative: skip + non-test/build/lint/check task → NO advisory
	it('SC-104: precreateStandardWorktreeSession with deps_strategy skip and NON-test-build description does NOT emit WORKTREE_DEPS_SKIP advisory', async () => {
		const createdDirs: string[] = [];
		swarmState.opencodeClient = {
			session: {
				create: async (opts: any) => {
					createdDirs.push(opts.query.directory);
					return { data: { id: 'sess-lane-456' } };
				},
			},
		} as any;

		const origProvision = isolationInternals.provisionWorktree;
		isolationInternals.provisionWorktree = async () => ({
			worktreePath: path.join(tempDir, '.swarm-worktrees', 'sess', 't2'),
			branchName: 'swarm/lane/sess/t2',
			purpose: 'lane',
			id: 't2',
			sessionId: 'sess',
		});

		try {
			const session = ensureAgentSession('sc104-neg-session');
			session.pendingAdvisoryMessages = [];

			await precreateStandardWorktreeSession({
				config: {
					worktree: {
						policy: 'auto',
						merge_strategy: 'merge',
						deps_strategy: 'skip',
					},
				} as any,
				directory: tempDir,
				parentSessionID: 'sc104-neg-session',
				callID: 'call-sc104-neg',
				taskId: 'task-sc104-neg',
				// Description has NO test/build/lint/check keywords
				description: 'refactor the authentication module',
				outputArgs: {},
			});

			// Verify: pendingAdvisoryMessages must NOT contain a WORKTREE_DEPS_SKIP advisory
			expect(session.pendingAdvisoryMessages).toBeDefined();
			const depsSkipAdvisory = session.pendingAdvisoryMessages!.find((m) =>
				m.includes('WORKTREE_DEPS_SKIP'),
			);
			expect(depsSkipAdvisory).toBeUndefined();
		} finally {
			isolationInternals.provisionWorktree = origProvision;
			swarmState.opencodeClient = undefined;
		}
	});

	// SC-105 regression: precreateStandardWorktreeSession must forward scope to provisionWorktree
	it('SC-105: precreateStandardWorktreeSession forwards scope to _internals.provisionWorktree', async () => {
		const captured: any[] = [];
		const origProvision = isolationInternals.provisionWorktree;
		isolationInternals.provisionWorktree = async (...args: any[]) => {
			captured.push(args);
			return {
				worktreePath: path.join(
					tempDir,
					'.swarm-worktrees',
					'sess',
					'scopefwd',
				),
				branchName: 'swarm/lane/sess/scopefwd',
				purpose: 'lane' as const,
				id: 'scopefwd',
				sessionId: 'sess',
			};
		};

		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'sess-scopefwd' } }),
			},
		} as any;

		try {
			const testScope = { taskId: 'X', files: ['src/a.ts', 'tests/a.test.ts'] };
			await precreateStandardWorktreeSession({
				config: { worktree: { policy: 'auto' } } as any,
				directory: tempDir,
				parentSessionID: 'scopefwd-session',
				callID: 'call-scopefwd',
				taskId: 'task-scopefwd',
				outputArgs: {},
				scope: testScope,
			});

			expect(captured.length).toBe(1);
			const optionsArg = captured[0][3];
			expect(optionsArg).toBeDefined();
			expect(optionsArg.scope).toEqual(testScope);
		} finally {
			isolationInternals.provisionWorktree = origProvision;
			swarmState.opencodeClient = undefined;
		}
	});

	// SC-105/SC-106 end-to-end: real provision path materializes scope and resolveScopeWithFallbacks recovers it
	it('SC-105/SC-106: precreateStandardWorktreeSession with real provisionWorktree materializes scope file; resolveScopeWithFallbacks recovers from lane disk', async () => {
		// This test requires a real git repo because provisionWorktree does git worktree add
		const gitDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'delegation-gate-scope-e2e-'),
		);
		const realGitDir = fs.realpathSync(gitDir);
		try {
			// Init minimal git repo (required for worktree add)
			const { spawnSync } = require('node:child_process');
			spawnSync('git', ['init', '-q'], { cwd: realGitDir, stdio: 'pipe' });
			spawnSync('git', ['config', 'user.email', 'test@test.com'], {
				cwd: realGitDir,
				stdio: 'pipe',
			});
			spawnSync('git', ['config', 'user.name', 'Test'], {
				cwd: realGitDir,
				stdio: 'pipe',
			});
			spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'initial'], {
				cwd: realGitDir,
				stdio: 'pipe',
			});
			fs.mkdirSync(path.join(realGitDir, '.swarm'), { recursive: true });

			// Ensure .swarm/ is gitignored (as in real repos)
			const giPath = path.join(realGitDir, '.gitignore');
			fs.writeFileSync(giPath, '.swarm/\n');
			spawnSync('git', ['add', '.gitignore'], {
				cwd: realGitDir,
				stdio: 'pipe',
			});
			spawnSync('git', ['commit', '-q', '-m', 'gitignore'], {
				cwd: realGitDir,
				stdio: 'pipe',
			});

			// Fabricate client so precreate proceeds past the client check
			swarmState.opencodeClient = {
				session: {
					create: async (opts: any) => {
						return { data: { id: 'sess-e2e-scope' } };
					},
				},
			} as any;

			const testScope = {
				taskId: 'e2e-1.2',
				files: ['src/feature.ts', 'tests/feature.test.ts'],
			};

			// Capture the real provision call to verify scope was passed
			const origProvision = isolationInternals.provisionWorktree;
			let capturedOptions: any = null;
			isolationInternals.provisionWorktree = async (
				dir: string,
				id: string,
				sess: string,
				opts: any,
			) => {
				capturedOptions = opts;
				// Call the REAL implementation (seam-respecting)
				return origProvision(dir, id, sess, opts);
			};

			try {
				await precreateStandardWorktreeSession({
					config: { worktree: { policy: 'auto' } } as any,
					directory: realGitDir,
					parentSessionID: 'e2e-scope-session',
					callID: 'call-e2e-scope',
					taskId: 'e2e-1.2',
					outputArgs: {},
					scope: testScope,
				});

				// 1. Verify the handoff passed scope through
				expect(capturedOptions).toBeDefined();
				expect(capturedOptions.scope).toEqual(testScope);

				// 2. Find the lane that was created (standardWorktreeByCallID tracks it)
				const dispatch = standardWorktreeByCallID.get('call-e2e-scope');
				expect(dispatch).toBeDefined();
				const lanePath = dispatch!.handle.worktreePath;

				// 3. SC-106: simulate restart (null in-memory + pending map) and recover from disk
				const recovered = resolveScopeWithFallbacks({
					directory: lanePath,
					taskId: 'e2e-1.2',
					inMemoryScope: null,
					pendingMapScope: null,
				});
				expect(recovered).toEqual(testScope.files);

				// 4. Also assert the file physically exists under the lane
				const scopeFile = path.join(
					lanePath,
					'.swarm',
					'scopes',
					'scope-e2e-1.2.json',
				);
				expect(fs.existsSync(scopeFile)).toBe(true);
			} finally {
				isolationInternals.provisionWorktree = origProvision;
				swarmState.opencodeClient = undefined;
				// Best-effort cleanup of any created worktree
				try {
					const dispatch = standardWorktreeByCallID.get('call-e2e-scope');
					if (dispatch?.handle?.worktreePath) {
						spawnSync(
							'git',
							['worktree', 'remove', '--force', dispatch.handle.worktreePath],
							{
								cwd: realGitDir,
								stdio: 'pipe',
							},
						);
					}
				} catch {
					/* ignore */
				}
				resetStandardWorktreeIsolationState();
			}
		} finally {
			try {
				fs.rmSync(realGitDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});
});
