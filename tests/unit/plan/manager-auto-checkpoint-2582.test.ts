/**
 * Issue #2582 — integration tests for the `checkpoint.auto_checkpoint_threshold`
 * runtime trigger through the real `updateTaskStatus` completion funnel
 * (`src/plan/manager.ts`). Pins the frozen acceptance contracts C1 (cadence
 * changes with the threshold), C2 (max_retention independently bounds the log),
 * and C4 (no checkpoint below the boundary; trigger failure is non-fatal to the
 * durable status write). Config is provided through the loader's real project
 * source (`.opencode/opencode-swarm.json`), so these tests also prove the
 * merged-config reader is live.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { _internals as mergeEpochInternals } from '../../../src/epic/merge-epoch.js';
import {
	_internals as autoCheckpointInternals,
	buildAutoCheckpointLabel,
	maybeSaveAutoCheckpoint,
} from '../../../src/plan/auto-checkpoint.js';
import { _internals as managerInternals } from '../../../src/plan/manager.js';
import { executeSavePlan } from '../../../src/tools/save-plan.js';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ORIGINAL_TRIGGER = managerInternals.maybeSaveAutoCheckpoint;
const ORIGINAL_MERGE_FAILURE = mergeEpochInternals.getWorktreeMergeFailure;
const ORIGINAL_BOUND_PATH = mergeEpochInternals.getBoundStatusPath;
const ORIGINAL_LOADER = autoCheckpointInternals.loadPluginConfigWithMeta;
const ORIGINAL_SPAWN_SYNC = autoCheckpointInternals.spawnSync;

let tempDir: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let consoleCapture: string[] = [];
let originalConsoleWarn: typeof console.warn | undefined;
let originalConsoleLog: typeof console.log | undefined;

interface CheckpointEntryLike {
	label: string;
	sha: string;
	timestamp: string;
}

function gitRun(directory: string, args: string[]): string {
	const result = child_process.spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
		},
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr?.trim() ?? result.status}`,
		);
	}
	return result.stdout ?? '';
}

function gitInit(directory: string, withCommit = true): void {
	gitRun(directory, ['init']);
	gitRun(directory, ['config', 'user.email', 'test@example.com']);
	gitRun(directory, ['config', 'user.name', 'Test User']);
	if (withCommit) {
		fs.writeFileSync(path.join(directory, 'seed.txt'), 'seed', 'utf-8');
		gitRun(directory, ['add', '--all']);
		gitRun(directory, ['commit', '-m', 'seed']);
	}
}

function writeCheckpointConfig(config: Record<string, unknown>): void {
	fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config, null, 2),
		'utf-8',
	);
}

async function savePlanWithTasks(taskIds: string[]): Promise<void> {
	const result = await executeSavePlan(
		{
			title: 'Auto Checkpoint Plan',
			swarm_id: 'auto-checkpoint-2582',
			phases: [
				{
					id: 1,
					name: 'Phase One',
					tasks: taskIds.map((id) => ({
						id,
						description: `task ${id}`,
						size: 'small' as const,
					})),
				},
			],
			working_directory: tempDir,
		},
		tempDir,
	);
	if (!result.success) {
		process.stderr.write(`DEBUG savePlan result: ${JSON.stringify(result).slice(0, 400)}
`);
	}
	expect(result.success).toBe(true);
}

function readCheckpointEntries(): CheckpointEntryLike[] {
	const logPath = path.join(tempDir, '.swarm', 'checkpoints.json');
	if (!fs.existsSync(logPath)) return [];
	const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as {
		checkpoints?: CheckpointEntryLike[];
	};
	return parsed.checkpoints ?? [];
}

function readTaskStatus(taskId: string): string | undefined {
	const plan = JSON.parse(
		fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
	) as { phases: Array<{ tasks: Array<{ id: string; status: string }> }> };
	return plan.phases
		.flatMap((phase) => phase.tasks)
		.find((task) => task.id === taskId)?.status;
}

async function completeTasks(taskIds: string[]): Promise<void> {
	const { updateTaskStatus } = await import('../../../src/plan/manager');
	for (const taskId of taskIds) {
		await updateTaskStatus(tempDir, taskId, 'completed');
	}
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('auto-checkpoint-2582-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-001\n\nThe system SHALL checkpoint.\n',
		'utf-8',
	);
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	// m-c-004/F9 safety net: capture console BEFORE anything that can throw,
	// so afterEach can never restore undefined console methods.
	consoleCapture = [];
	originalConsoleWarn = console.warn;
	originalConsoleLog = console.log;
	console.warn = (...args: unknown[]) => {
		consoleCapture.push(args.map(String).join(' '));
	};
	console.log = (...args: unknown[]) => {
		consoleCapture.push(args.map(String).join(' '));
	};
	// PRR-002: the loader deep-merges the developer's real user config; keep
	// unset keys (max_retention etc.) deterministic across machines.
	isolatedEnv = createIsolatedTestEnv();
});

afterEach(() => {
	managerInternals.maybeSaveAutoCheckpoint = ORIGINAL_TRIGGER;
	mergeEpochInternals.getWorktreeMergeFailure = ORIGINAL_MERGE_FAILURE;
	mergeEpochInternals.getBoundStatusPath = ORIGINAL_BOUND_PATH;
	autoCheckpointInternals.loadPluginConfigWithMeta = ORIGINAL_LOADER;
	autoCheckpointInternals.spawnSync = ORIGINAL_SPAWN_SYNC;
	console.warn = originalConsoleWarn;
	console.log = originalConsoleLog;
	try {
		isolatedEnv?.cleanup();
	} catch {
		// best-effort
	}
	delete process.env.SWARM_SKIP_SPEC_GATE;
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	try {
		closeProjectDb(tempDir);
	} catch {
		// best-effort
	}
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('auto-checkpoint cadence through updateTaskStatus (#2582)', () => {
	test('threshold 2 writes exactly one entry at counts 2 and 4, each with sha and timestamp', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 2 },
		});
		await savePlanWithTasks(['1.1', '1.2', '1.3', '1.4']);

		await completeTasks(['1.1']);
		expect(readCheckpointEntries()).toHaveLength(0);
		await completeTasks(['1.2']);
		expect(readCheckpointEntries()).toHaveLength(1);
		await completeTasks(['1.3']);
		expect(readCheckpointEntries()).toHaveLength(1);
		await completeTasks(['1.4']);
		expect(readCheckpointEntries()).toHaveLength(2);

		const entries = readCheckpointEntries();
		for (const entry of entries) {
			expect(entry.label).toMatch(/^auto-task-checkpoint-[0-9a-f]{12}-\d{3}$/);
			expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
		expect(new Set(entries.map((entry) => entry.label)).size).toBe(2);
	});

	test('threshold 3 changes the cadence: entry appears only at count 3', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 3 },
		});
		await savePlanWithTasks(['1.1', '1.2', '1.3', '1.4']);

		await completeTasks(['1.1', '1.2']);
		expect(readCheckpointEntries()).toHaveLength(0);
		await completeTasks(['1.3']);
		expect(readCheckpointEntries()).toHaveLength(1);
		await completeTasks(['1.4']);
		expect(readCheckpointEntries()).toHaveLength(1);
	});

	test('checkpoint.enabled false disables the trigger', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: false, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1', '1.2']);

		await completeTasks(['1.1', '1.2']);
		expect(readCheckpointEntries()).toHaveLength(0);
	});

	test('max_retention independently bounds the automatic entries (retention != threshold)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: {
				enabled: true,
				auto_checkpoint_threshold: 1,
				max_retention: 2,
			},
		});
		await savePlanWithTasks(['1.1', '1.2', '1.3', '1.4']);

		await completeTasks(['1.1', '1.2', '1.3', '1.4']);
		const entries = readCheckpointEntries();
		expect(entries).toHaveLength(2);
		// FIFO keeps the newest two labels (counts 003 and 004).
		expect(entries.map((entry) => entry.label).join(',')).toMatch(/003/);
		expect(entries.map((entry) => entry.label).join(',')).toMatch(/004/);
	});

	test('a throwing trigger never fails the durable status write and is always visibly warned', async () => {
		gitInit(tempDir);
		await savePlanWithTasks(['1.1']);
		managerInternals.maybeSaveAutoCheckpoint = async () => {
			throw new Error('injected auto-checkpoint failure');
		};

		const warnings: string[] = [];
		const originalWarn = console.warn;
		const originalLog = console.log;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		console.log = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		try {
			const { updateTaskStatus } = await import('../../../src/plan/manager');
			await expect(
				updateTaskStatus(tempDir, '1.1', 'completed'),
			).resolves.toBeTruthy();
		} finally {
			console.warn = originalWarn;
			console.log = originalLog;
		}
		expect(readTaskStatus('1.1')).toBe('completed');
		expect(readCheckpointEntries()).toHaveLength(0);
		// The exception path uses the always-visible criticalWarn, not the
		// debug-gated warn — an operator must see a lost trigger.
		expect(
			warnings.some((message) => message.includes('auto-checkpoint')),
		).toBe(true);
	});

	test('non-git projects skip the checkpoint but still complete tasks', async () => {
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1']);

		await completeTasks(['1.1']);
		expect(readTaskStatus('1.1')).toBe('completed');
		expect(readCheckpointEntries()).toHaveLength(0);
	});

	test('unborn git repository (no commits) records nothing', async () => {
		gitInit(tempDir, false);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1']);

		await completeTasks(['1.1']);
		expect(readTaskStatus('1.1')).toBe('completed');
		expect(readCheckpointEntries()).toHaveLength(0);
	});

	test('a failed save outcome surfaces an operator warning without blocking the write', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1']);
		// Force the checkpoint write to fail: a directory at the log path makes
		// every write attempt fail (returned as a failure result, not a throw).
		fs.mkdirSync(path.join(tempDir, '.swarm', 'checkpoints.json'));

		const warnings: string[] = [];
		const originalWarn = console.warn;
		const originalLog = console.log;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		console.log = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		try {
			await completeTasks(['1.1']);
		} finally {
			console.warn = originalWarn;
			console.log = originalLog;
		}
		expect(readTaskStatus('1.1')).toBe('completed');
		expect(
			warnings.some((message) => message.includes('auto-checkpoint for 1.1')),
		).toBe(true);
	});

	test('Epic-mode completion records HEAD and writes no commit (Epic v2 C3)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
			epic: { mode: { enabled: true } },
		});
		gitRun(tempDir, ['add', '.opencode/opencode-swarm.json']);
		gitRun(tempDir, ['commit', '-m', 'config']);
		await savePlanWithTasks(['1.1']);
		// An epic is open for this plan (real lifecycle row + sentinel).
		openEpicForTest(tempDir);
		const headBefore = gitRun(tempDir, ['rev-parse', 'HEAD']).trim();

		await completeTasks(['1.1']);
		const entries = readCheckpointEntries();
		expect(entries).toHaveLength(1);
		// An epic task's work is committed when its worktree lands, so the
		// completion itself commits nothing and the checkpoint records HEAD.
		expect(gitRun(tempDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
		expect(entries[0]?.sha).toBe(headBefore);
	});

	test('default threshold (3) applies when the config omits the key (PRR-006)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({ checkpoint: { enabled: true } });
		await savePlanWithTasks(['1.1', '1.2', '1.3', '1.4']);

		await completeTasks(['1.1', '1.2']);
		expect(readCheckpointEntries()).toHaveLength(0);
		await completeTasks(['1.3']);
		const entries = readCheckpointEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.label).toMatch(/-003$/);
		await completeTasks(['1.4']);
		expect(readCheckpointEntries()).toHaveLength(1);
	});

	test('worktree-merge failure of an epic task skips the auto-checkpoint (PRR-008, Epic v2 C3)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
			epic: { mode: { enabled: true } },
		});
		await savePlanWithTasks(['1.1']);
		openEpicForTest(tempDir);
		// The shared registry is bound to this project and holds an undated
		// failure for 1.1 (undated ⇒ relevant, fail closed).
		mergeEpochInternals.getBoundStatusPath = () =>
			path.join(tempDir, '.swarm', 'worktree-merge-status.json');
		mergeEpochInternals.getWorktreeMergeFailure = () => ({
			outcome: 'failed' as const,
			stage: 'merge',
			message: 'injected merge-back failure',
		});

		await completeTasks(['1.1']);
		expect(readTaskStatus('1.1')).toBe('completed');
		expect(readCheckpointEntries()).toHaveLength(0);
		expect(
			consoleCapture.some((message) =>
				message.includes('auto-checkpoint SKIPPED for 1.1'),
			),
		).toBe(true);
	});

	test('the same injected failure does NOT skip the checkpoint without an open epic', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1']);
		mergeEpochInternals.getBoundStatusPath = () =>
			path.join(tempDir, '.swarm', 'worktree-merge-status.json');
		mergeEpochInternals.getWorktreeMergeFailure = () => ({
			outcome: 'failed' as const,
			stage: 'merge',
			message: 'injected merge-back failure',
		});

		await completeTasks(['1.1']);
		expect(readCheckpointEntries()).toHaveLength(1);
	});

	test('successful automatic saves emit checkpoint_auto_saved on the events stream (PRR-009)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1']);

		await completeTasks(['1.1']);
		const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);
		const events = fs
			.readFileSync(eventsPath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { event?: string; label?: string });
		const autoSaved = events.filter(
			(event) => event.event === 'checkpoint_auto_saved',
		);
		expect(autoSaved).toHaveLength(1);
		expect(autoSaved[0]?.label).toBe(readCheckpointEntries()[0]?.label);
	});

	test('unborn repo trigger reports no_restorable_head skipReason (PRR-007)', async () => {
		gitInit(tempDir, false);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		await savePlanWithTasks(['1.1']);
		await completeTasks(['1.1']);
		expect(readCheckpointEntries()).toHaveLength(0);
		const plan = JSON.parse(
			fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as Parameters<typeof maybeSaveAutoCheckpoint>[1];
		const outcome = await maybeSaveAutoCheckpoint(tempDir, plan);
		expect(outcome.saved).toBe(false);
		expect(outcome.skipReason).toBe('no_restorable_head');
	});
});
