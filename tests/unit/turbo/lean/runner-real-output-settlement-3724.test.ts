/**
 * #3724 item 3 (AC5/AC6 durable pins): a Lean Turbo lane whose reply carries
 * REAL OUTPUT (non-empty text parts) plus a provider error settles under the
 * dispatch-lanes real-output contract — completed, worktree merged back —
 * instead of failing and stranding the produced work.
 *
 * Root cause: `src/turbo/lean/runner.ts` guarded with
 * `!promptResult.data || providerError` — no real-output term (the lean twin of
 * dispatch-lanes' load-bearing `!transcript.text` guard). Harness mirrors
 * tests/unit/turbo/lean/runner.test.ts (session registration, _internals
 * mocks) and the frozen C6 probe fixtures (SDK APIError shape on info.error).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import * as leanState from '../../../../src/turbo/lean/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const SESSION_ID = 'sess-runner-3724';

const PROVIDER_ERROR_429 = {
	name: 'APIError',
	data: { statusCode: 429, message: 'rate limit exceeded' },
};

const LANE: LeanTurboLane = {
	laneId: 'lane-1',
	taskIds: ['1.1'],
	files: ['src/a.ts'],
	status: 'pending',
};

function replyWithData(parts: Array<{ type: string; text?: string }>) {
	return { info: { error: PROVIDER_ERROR_429 }, parts };
}

let tmpDir: string;
let origAssertCleanWorkingTree: typeof LeanTurboRunner._internals.assertCleanWorkingTree;
let origAttemptMergeBackFromDirty: typeof LeanTurboRunner._internals.attemptMergeBackFromDirty;

beforeEach(() => {
	resetSwarmState();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = canonicalMkdtemp('runner-3724-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	origAssertCleanWorkingTree =
		LeanTurboRunner._internals.assertCleanWorkingTree;
	LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
		Promise.resolve({ clean: true }),
	);
	origAttemptMergeBackFromDirty =
		LeanTurboRunner._internals.attemptMergeBackFromDirty;
	LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(() =>
		Promise.resolve({
			merged: true,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		}),
	);
});

afterEach(() => {
	LeanTurboRunner._internals.assertCleanWorkingTree =
		origAssertCleanWorkingTree;
	LeanTurboRunner._internals.attemptMergeBackFromDirty =
		origAttemptMergeBackFromDirty;
	leanState.repairStateUnreadable(tmpDir);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LeanTurboRunner real-output settlement (#3724 item 3)', () => {
	test('dispatchLane: text parts + provider error resolves ok with the session kept (no teardown)', async () => {
		let deletes = 0;
		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		(runner as unknown as { _sessionOps: unknown })._sessionOps = {
			create: async () => ({ data: { id: 'lane-sess' }, error: null }),
			prompt: async () => ({
				data: replyWithData([{ type: 'text', text: 'Real produced output' }]),
				error: null,
			}),
			delete: async () => {
				deletes += 1;
			},
		};
		const result = await runner.dispatchLane(LANE, 'coder');
		// teardownEphemeralSession is fire-and-forget; let it settle.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(result.ok).toBe(true);
		expect(result.sessionId).toBe('lane-sess');
		expect(deletes).toBe(0);
	}, 30_000);

	test('dispatchLane: empty text parts + the same provider error still fails closed with teardown', async () => {
		let deletes = 0;
		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		(runner as unknown as { _sessionOps: unknown })._sessionOps = {
			create: async () => ({ data: { id: 'lane-sess' }, error: null }),
			prompt: async () => ({ data: replyWithData([]), error: null }),
			delete: async () => {
				deletes += 1;
			},
		};
		const result = await runner.dispatchLane(LANE, 'coder');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(result.ok).toBe(false);
		expect(deletes).toBe(1);
	}, 30_000);
});

describe('LeanTurboRunner real-output settlement routing (#3724 item 3)', () => {
	test('runPhase: a lane whose dispatch produced text + provider error takes the merge-back route (attemptMergeBackFromDirty called, worktree not stranded)', async () => {
		// Minimal plan + declared scope so the lane is authorized.
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Routing Plan',
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
								description: 'Task 1',
								status: 'pending',
								phase: 1,
								size: 'small',
								depends: [],
								acceptance: 'Done',
							},
						],
					},
				],
				lean: {
					max_parallel_coders: 1,
					require_declared_scope: false,
					conflict_policy: 'serialize',
					degrade_on_risk: true,
					phase_reviewer: false,
					phase_critic: false,
					integrated_diff_required: false,
					allow_docs_only_without_reviewer: false,
					worktree_isolation: true,
				},
			}),
			'utf-8',
		);
		const scopeDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopeDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopeDir, 'scope-1.1.json'),
			JSON.stringify({ files: ['src/a.ts'] }),
			'utf-8',
		);

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		} as never);
		(runner as unknown as { _sessionOps: unknown })._sessionOps = {
			create: async () => ({ data: { id: 'lane-sess' }, error: null }),
			prompt: async () => ({
				data: replyWithData([{ type: 'text', text: 'Real produced output' }]),
				error: null,
			}),
			delete: async () => {},
		};

		const mergeCalls: unknown[][] = [];
		LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(
			(...args: Parameters<typeof origAttemptMergeBackFromDirty>) => {
				mergeCalls.push(args);
				return Promise.resolve({
					merged: true,
					strategy: 'merge',
					autoCommitted: true,
					cleaned: true,
				});
			},
		);
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath: path.join(
					tmpDir,
					'.swarm-worktrees',
					SESSION_ID,
					'lane-1',
				),
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		try {
			const result = await runner.runPhase(1);
			expect(mergeCalls.length).toBeGreaterThan(0);
			expect(result.ok).toBe(true);
			expect(result.lanes[0]?.status).toBe('completed');
			expect(
				(result as { mergeBackFailures?: unknown[] }).mergeBackFailures
					?.length ?? 0,
			).toBe(0);
		} finally {
			LeanTurboRunner._internals.provisionWorktree = origProvision;
			LeanTurboRunner._internals.postMergeCleanup = origCleanup;
			LeanTurboRunner._internals.removeWorktree = origRemove;
		}
	}, 120_000);
});
