/**
 * Worktree isolation serialization — SC-111 supplemental (FR-104)
 *
 * Covers FR-104 SC-111: Release a serialized session after N successful dispatches
 *
 * This is a supplemental file containing SC-111 tests, allowing the original
 * serialization.test.ts to focus on SC-112 (TTL) and SC-113 (FIFO eviction).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	PluginConfig,
	WorktreeIsolationConfig,
} from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals as isolationInternals,
	resetStandardWorktreeIsolationState,
	standardWorktreeSerializationSessions,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	attemptMergeBackFromDirty,
	postMergeCleanup,
	provisionWorktree,
	removeWorktree,
} from '../../../src/worktree';

function makeConfig(
	overrides?: Partial<WorktreeIsolationConfig>,
): PluginConfig {
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
		},
		worktree: {
			policy: 'auto',
			merge_strategy: 'merge',
			deps_strategy: 'skip',
			serialization_release_after_dispatches: 5,
			serialization_release_after_ms: 60_000,
			...overrides,
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
	options?: {
		tasks?: Array<{
			id: string;
			status?: string;
			depends?: string[];
			phase?: number;
		}>;
		currentPhase?: number;
	},
): void {
	const phase = options?.currentPhase ?? 1;
	const tasks = options?.tasks ?? [
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

function makeFakeDispatch(
	callID: string,
	parentSessionID: string,
	taskId: string,
): {
	callID: string;
	parentSessionID: string;
	taskId: string;
	handle: { worktreePath: string; branchName: string };
} {
	return {
		callID,
		parentSessionID,
		taskId,
		handle: {
			worktreePath: path.join(os.tmpdir(), `wt-${parentSessionID}-${taskId}`),
			branchName: `swarm/lane/${parentSessionID}/${taskId}`,
		},
	};
}

/**
 * Directly serialize a session by populating the internal state directly.
 * This mimics what happens when handleStandardWorktreeFailure calls
 * serializeStandardWorktreeDispatches.
 */
function serializeSessionDirectly(sessionID: string): void {
	standardWorktreeSerializationSessions.add(sessionID);
	isolationInternals.serializationStateBySessionID!.set(sessionID, {
		sessionID,
		serializedAt: Date.now(),
		successfulDispatchesSince: 0,
	});
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = 1;
}

describe('FR-104 SC-111: release after N successful dispatches', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-sc111-');
		writePlanJson(tempDir);

		isolationInternals.removeWorktree = async () => {};
		isolationInternals.postMergeCleanup = async () => {};
		isolationInternals.attemptMergeBackFromDirty = async () => ({
			merged: true as const,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		});
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
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

	it('SC-111: session is NOT released before reaching dispatch count threshold', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 3 });

		// Directly serialize session (mimics handleStandardWorktreeFailure path)
		serializeSessionDirectly('sc111-session');

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// Dispatch 1: count = 1, still below threshold 3
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-1', 'sc111-session', '1.1') as any,
			config as any,
		);
		expect(standardWorktreeSerializationSessions.has('sc111-session')).toBe(
			true,
		);

		// Dispatch 2: count = 2, still below threshold 3
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-2', 'sc111-session', '1.2') as any,
			config as any,
		);
		expect(standardWorktreeSerializationSessions.has('sc111-session')).toBe(
			true,
		);
	});

	it('SC-111: session IS released after reaching dispatch count threshold', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 3 });

		serializeSessionDirectly('sc111-release-session');

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// Dispatch 1: count = 1, below threshold 3
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-r1', 'sc111-release-session', '1.1') as any,
			config as any,
		);
		expect(
			standardWorktreeSerializationSessions.has('sc111-release-session'),
		).toBe(true);

		// Dispatch 2: count = 2, below threshold 3
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-r2', 'sc111-release-session', '1.2') as any,
			config as any,
		);
		expect(
			standardWorktreeSerializationSessions.has('sc111-release-session'),
		).toBe(true);

		// Dispatch 3: count = 3, meets threshold — session should be released
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-r3', 'sc111-release-session', '1.3') as any,
			config as any,
		);

		// SC-111: after N successful dispatches, session should be released
		expect(
			standardWorktreeSerializationSessions.has('sc111-release-session'),
		).toBe(false);
	});

	it('SC-111: maxConcurrencyOverride is cleared upon release', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 1 });

		serializeSessionDirectly('sc111-clear-override');

		const session = ensureAgentSession('sc111-clear-override');
		expect(session.maxConcurrencyOverride).toBe(1);

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-override', 'sc111-clear-override', '1.1') as any,
			config as any,
		);

		expect(
			standardWorktreeSerializationSessions.has('sc111-clear-override'),
		).toBe(false);
		expect(session.maxConcurrencyOverride).toBeUndefined();
	});
});

// ─── End of file ─────────────────────────────────────────────────────────────
