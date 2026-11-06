/**
 * #3169 Phase 3 — the delegation gate's worktree precreate THROUGH the v2
 * session-client shim (gate-shaped end-to-end pin; trace
 * 3169-epic-v2-phase3-isolated-coders, approved plan Change 2).
 *
 * Drives the REAL `precreateStandardWorktreeSession` with
 * `swarmState.opencodeClient` set to `createV2SessionClient(fakeCtx)` — a
 * divergent-directory lane create therefore flows through the eager lane
 * arm — with `provisionWorktree` stubbed via the module's `_internals` seam
 * (the lane provisioning machinery itself is pinned by the
 * delegation-gate-worktree-isolation suites). Pins the AC4 clauses a shim-level
 * test cannot see: the Task `task_id` rewrite stores the REAL lane session id,
 * an `isolationRequired` dispatch does NOT throw
 * (`EPIC_ISOLATION_DEGRADED` is the wrap of a precreate rejection), no
 * degradation reason is recorded, and the host create carries the real
 * parentID (OpenCode 2.1.x's native `subagent` resume requires it) with the
 * lane directory as its location.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getStandardWorktreeDegradationReason,
	_internals as isolationInternals,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
} from '../../../../src/hooks/delegation-gate/worktree-isolation';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState, swarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const GIT_FIXTURE_TIMEOUT_MS = 30_000;

const PARENT = 'ses_gate_parent';

function makeFakeSessionDomain(parentDirectory: string, laneDirectory: string) {
	const calls: Array<{ op: string; arg: unknown }> = [];
	return {
		calls,
		async hook() {
			calls.push({ op: 'hook', arg: undefined });
			return { dispose: async () => {} };
		},
		async create(input: {
			parentID?: string;
			title?: string;
			location?: { directory: string };
		}) {
			calls.push({ op: 'create', arg: input });
			return { id: 'ses_gate_lane', location: { directory: laneDirectory } };
		},
		async get({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'get', arg: sessionID });
			if (sessionID === PARENT) {
				return { id: sessionID, location: { directory: parentDirectory } };
			}
			return { id: sessionID };
		},
		async remove({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'remove', arg: sessionID });
		},
		async prompt(input: unknown) {
			calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: unknown) {
			calls.push({ op: 'wait', arg: input });
		},
		async context() {
			calls.push({ op: 'context', arg: undefined });
			return [];
		},
		async interrupt(input: unknown) {
			calls.push({ op: 'interrupt', arg: input });
		},
		async switchAgent(input: unknown) {
			calls.push({ op: 'switchAgent', arg: input });
		},
		async switchModel(input: unknown) {
			calls.push({ op: 'switchModel', arg: input });
		},
	};
}

describe('gate precreate through the v2 session-client shim (#3169 Phase 3)', () => {
	let gitDir: string;
	let laneDirectory: string;
	// PRR-016: captured in beforeEach, NOT mid-test — a mid-test capture left the
	// unconditional afterEach restore installing `undefined` into the
	// module-wide `_internals` seam whenever the test threw first.
	let originalProvision: unknown;
	let gitFixtureAvailable = true;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		// PRR-016: eager records live in the shim's module-level registry.
		clearV2SessionClientState();
		originalProvision = isolationInternals.provisionWorktree;
		gitFixtureAvailable = true;
		gitDir = canonicalMkdtemp('swarm-v2-gate-');
		fs.writeFileSync(path.join(gitDir, 'a.txt'), 'a\n');
		fs.writeFileSync(path.join(gitDir, 'b.txt'), 'b\n');
		for (const args of [
			['init'],
			['add', '.'],
			['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'],
		] as string[][]) {
			// PRR-015: hermetic git env (the repo-wide convention documented in
			// tests/unit/helpers/no-global-git-config.test.ts) plus a bound so a
			// hung credential helper cannot stall the suite.
			const result = spawnSync('git', args, {
				cwd: gitDir,
				encoding: 'utf8',
				timeout: GIT_FIXTURE_TIMEOUT_MS,
				env: {
					...process.env,
					// Git wants the NULL DEVICE by NAME: os.devNull is '\\.\NUL'
					// on Windows, which git rejects as an invalid path. Same value the
					// sibling suites use (tests/unit/helpers/no-global-git-config.test.ts).
					GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
					GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
				},
			});
			if (result.error) {
				// PRR-015: a missing/slow git must not fail the suite — the
				// flag makes each test return early (a skip) instead.
				gitFixtureAvailable = false;
				return;
			}
			if (result.status !== 0) {
				throw new Error(`git ${args[0]} failed: ${result.stderr ?? 'unknown'}`);
			}
		}
		laneDirectory = path.join(gitDir, '.swarm-worktrees', 'lane-gate');
	});

	afterEach(() => {
		(isolationInternals as Record<string, unknown>).provisionWorktree =
			originalProvision;
		(swarmState as { opencodeClient: unknown }).opencodeClient = undefined;
		clearV2SessionClientState();
		try {
			fs.rmSync(gitDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	test('isolationRequired dispatch rewrites task_id to the REAL lane id without degrading', async () => {
		if (!gitFixtureAvailable) return; // git unavailable: skip, not fail
		const fake = makeFakeSessionDomain(gitDir, laneDirectory);
		const registration = { dispose: async () => {} };
		const ctx = {
			app: { name: 'opencode', version: 'test', channel: 'test' },
			location: {
				directory: gitDir,
				workspaceID: 'w',
				project: { id: 'p', directory: gitDir, canonical: gitDir },
			},
			options: {},
			tool: {
				transform: async () => registration,
				hook: async () => registration,
			},
			agent: { transform: async () => registration },
			command: { transform: async () => registration },
			session: fake,
			event: { subscribe: () => (async function* () {})() },
		} as never as V2PluginContext;
		const client = createV2SessionClient(ctx);
		expect(client).toBeDefined();
		(swarmState as { opencodeClient: unknown }).opencodeClient = client;

		(isolationInternals as Record<string, unknown>).provisionWorktree =
			async () => ({
				worktreePath: laneDirectory,
				branchName: 'swarm/lane/lane-gate',
				purpose: 'lane',
				id: 'lane-gate',
				sessionId: PARENT,
			});

		const outputArgs: Record<string, unknown> = {};
		// isolationRequired + policy auto ⇒ treated as required: a shim refusal
		// here would throw (StandardWorktreeLifecycleError), which the delegation
		// gate wraps as EPIC_ISOLATION_DEGRADED.
		await precreateStandardWorktreeSession({
			isolationRequired: true,
			config: { worktree: { policy: 'auto', merge_strategy: 'merge' } },
			directory: gitDir,
			parentSessionID: PARENT,
			callID: 'call-gate',
			taskId: 'task-gate',
			outputArgs,
		} as Parameters<typeof precreateStandardWorktreeSession>[0]);

		expect(outputArgs.task_id).toBe('ses_gate_lane');
		expect(String(outputArgs.task_id)).not.toMatch(/^v2shim-/);
		expect(getStandardWorktreeDegradationReason(PARENT)).toBeUndefined();
		const createArg = fake.calls.find((c) => c.op === 'create')?.arg as {
			parentID?: string;
			location?: { directory: string };
		};
		expect(createArg.parentID).toBe(PARENT);
		expect(createArg.location?.directory).toBe(laneDirectory);
		// The lane prompt context (worktree_lane_context) is prepended in place.
		expect(typeof outputArgs.prompt).toBe('string');
		expect(String(outputArgs.prompt)).toContain('<worktree_lane_context>');
		// PRR-019/e: the lane title is the operator-visible
		// "(worktree lane)" marker on the host session — assert it survives.
		expect(createArg.title).toContain('(worktree lane)');
	});

	// PRR-013: the gate's FAILURE path is the Phase 3 guard's whole purpose —
	// a placement mismatch must route into the gate's existing degradation, not
	// silently hand the caller a wrong-directory session.
	test('placement mismatch through the shim throws under isolationRequired (the EPIC_ISOLATION_DEGRADED path)', async () => {
		if (!gitFixtureAvailable) return; // git unavailable: skip, not fail
		const fake = makeFakeSessionDomain(gitDir, laneDirectory);
		// Host echoes a location that is NOT the requested lane directory.
		(fake as { create: unknown }).create = async () => ({
			id: 'ses_gate_wrong',
			location: { directory: gitDir },
		});
		const registration = { dispose: async () => {} };
		const ctx = {
			app: { name: 'opencode', version: 'test', channel: 'test' },
			location: {
				directory: gitDir,
				workspaceID: 'w',
				project: { id: 'p', directory: gitDir, canonical: gitDir },
			},
			options: {},
			tool: {
				transform: async () => registration,
				hook: async () => registration,
			},
			agent: { transform: async () => registration },
			command: { transform: async () => registration },
			session: fake,
			event: { subscribe: () => (async function* () {})() },
		} as never as V2PluginContext;
		(swarmState as { opencodeClient: unknown }).opencodeClient =
			createV2SessionClient(ctx);
		(isolationInternals as Record<string, unknown>).provisionWorktree =
			async () => ({
				worktreePath: laneDirectory,
				branchName: 'swarm/lane/lane-gate-bad',
				purpose: 'lane',
				id: 'lane-gate-bad',
				sessionId: PARENT,
			});

		const outputArgs: Record<string, unknown> = {};
		await expect(
			precreateStandardWorktreeSession({
				isolationRequired: true,
				config: { worktree: { policy: 'auto', merge_strategy: 'merge' } },
				directory: gitDir,
				parentSessionID: PARENT,
				callID: 'call-gate-bad',
				taskId: 'task-gate-bad',
				outputArgs,
			} as Parameters<typeof precreateStandardWorktreeSession>[0]),
		).rejects.toThrow(/STANDARD_WORKTREE_SESSION_CREATE_FAILED/);
		// The mis-placed host session is removed, and no task_id is published.
		expect(
			fake.calls.some((c) => c.op === 'remove' && c.arg === 'ses_gate_wrong'),
		).toBe(true);
		expect(outputArgs.task_id).toBeUndefined();
	});
});
