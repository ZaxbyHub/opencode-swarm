/**
 * Execution-stall detector — PROGRESS events (issue #2063 B5).
 *
 * A progress event resets the non-progress streak and clears any active denial
 * rung while KEEPING the episode armed. The set is deliberately narrow:
 *
 *   - completion of a `Task` to a mutating/verifying role. Read-only roles
 *     (`explorer`, `sme`) are excluded on purpose — otherwise "delegate the
 *     spelunking" is a one-line escape from the entire lever (round-2 advisory).
 *   - any file-write tool SUCCESS.
 *   - `update_task_status` success, any status.
 *   - a periodic workspace-diff probe showing new changes.
 *
 * The workspace probe carries the subtlest requirement: `changedFilesSinceSnapshot`
 * returns `null` whenever the baseline was DIRTY, which is the common case for a
 * real stalled session. The fallback below is what keeps the rung alive there,
 * and the dirty-baseline case is the one this file exercises first.
 *
 * Issue #2472 W7: `recordExecutionStallToolAfter` is async (its workspace
 * captures route through the async snapshot twin), so every helper here awaits
 * it — the probe's counter resets happen after those awaits.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { isExecutionEpisodeArmed } from '../../../src/hooks/guardrails/execution-episode';
import {
	_internals,
	_test_exports,
	DEFAULT_EXECUTION_STALL_STOP_CALLS,
	enforceExecutionStallDenial,
	observeExecutionStallToolCall,
	recordExecutionStallToolAfter,
} from '../../../src/hooks/guardrails/execution-stall';
import { resetSwarmState, swarmState } from '../../../src/state';

const TEST_DIR = path.join(os.tmpdir(), 'stall-progress-fixture');
const PROBE_EVERY = _test_exports.WORKSPACE_PROBE_EVERY_CALLS;

const realNow = _internals.now;
const realCapture = _internals.captureWorkspaceSnapshotAsync;
const realChanged = _internals.changedFilesSinceSnapshotAsync;

let clock = 1_700_000_000_000;
let snapshots: Array<{ gitHead: string | null; changedFiles: string[] }> = [];
let snapshotIndex = 0;
let changedResult: string[] | null = null;

beforeEach(() => {
	resetSwarmState();
	_test_exports.reset();
	clock = 1_700_000_000_000;
	snapshotIndex = 0;
	snapshots = [{ gitHead: 'H0', changedFiles: [] }];
	changedResult = [];
	_internals.now = () => clock;
	// Deterministic, git-free snapshot sequence: each capture consumes the next
	// scripted snapshot and then sticks on the last one.
	_internals.captureWorkspaceSnapshotAsync = mock(() => {
		const snap = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
		snapshotIndex++;
		return snap as never;
	}) as never;
	_internals.changedFilesSinceSnapshotAsync = mock(
		async () => changedResult,
	) as never;
});

afterEach(() => {
	_internals.now = realNow;
	_internals.captureWorkspaceSnapshotAsync = realCapture;
	_internals.changedFilesSinceSnapshotAsync = realChanged;
	_test_exports.reset();
	resetSwarmState();
});

function arm(sessionID: string): void {
	swarmState.activeAgent.set(sessionID, 'architect');
	observeExecutionStallToolCall({
		sessionID,
		tool: 'Task',
		args: { subagent_type: 'coder' },
		callID: 'arm-task',
	});
}

function beforeRead(sessionID: string, n: number): void {
	clock += 1_000;
	observeExecutionStallToolCall({
		sessionID,
		tool: 'read',
		args: { filePath: `/p/f-${n}.ts` },
		callID: `r-${n}`,
	});
}

async function afterRead(sessionID: string, n: number): Promise<void> {
	await recordExecutionStallToolAfter({
		sessionID,
		tool: 'read',
		callID: `r-${n}`,
		output: { title: 'read', output: 'contents', metadata: {} },
		directory: TEST_DIR,
	});
}

/** One full non-progress tool-call cycle (before + after). */
async function readCycle(sessionID: string, n: number): Promise<void> {
	beforeRead(sessionID, n);
	await afterRead(sessionID, n);
}

function counter(sessionID: string): number {
	return _test_exports.peekState(sessionID)?.nonProgressCalls ?? -1;
}

async function dispatchCycle(
	sessionID: string,
	role: string,
	n: number,
	output: unknown,
): Promise<void> {
	clock += 1_000;
	observeExecutionStallToolCall({
		sessionID,
		tool: 'Task',
		args: { subagent_type: role },
		callID: `t-${n}`,
	});
	await recordExecutionStallToolAfter({
		sessionID,
		tool: 'Task',
		callID: `t-${n}`,
		output,
		directory: TEST_DIR,
	});
}

const TASK_OK = { title: 'Task', output: 'summary', metadata: {} };
const TASK_ERR = { title: 'Task', output: '', metadata: {}, error: 'boom' };

describe('#2063 B5 — delegation-completion progress', () => {
	test('a coder completion resets the counter and clears an active hard rung', async () => {
		const sessionID = 'coder-resets';
		arm(sessionID);
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS; i++) {
			beforeRead(sessionID, i);
		}
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).toThrow(/^EXECUTION_STALL:/);

		await dispatchCycle(sessionID, 'coder', 1, TASK_OK);

		expect(counter(sessionID)).toBe(0);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).not.toThrow();
		// The episode itself survives — only the streak resets.
		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(true);
	});

	test('an EXPLORER completion does NOT reset the counter', async () => {
		// Closes the "delegate the spelunking" escape: an architect that farms
		// read-only work out to explorers is still not making progress.
		const sessionID = 'explorer-no-reset';
		arm(sessionID);
		for (let i = 0; i < 10; i++) beforeRead(sessionID, i);
		const before = counter(sessionID);

		await dispatchCycle(sessionID, 'explorer', 1, TASK_OK);

		// +1 for the dispatch call itself, and no reset.
		expect(counter(sessionID)).toBe(before + 1);
	});

	test('an sme completion does NOT reset the counter', async () => {
		const sessionID = 'sme-no-reset';
		arm(sessionID);
		for (let i = 0; i < 10; i++) beforeRead(sessionID, i);
		const before = counter(sessionID);

		await dispatchCycle(sessionID, 'sme', 1, TASK_OK);

		expect(counter(sessionID)).toBe(before + 1);
	});

	test('a FAILED coder completion does NOT reset the counter', async () => {
		const sessionID = 'coder-fail-no-reset';
		arm(sessionID);
		for (let i = 0; i < 10; i++) beforeRead(sessionID, i);
		const before = counter(sessionID);

		await dispatchCycle(sessionID, 'coder', 1, TASK_ERR);

		expect(counter(sessionID)).toBe(before + 1);
	});

	test('reviewer and test_engineer completions reset the counter', async () => {
		for (const role of ['reviewer', 'test_engineer', 'mega_coder']) {
			resetSwarmState();
			_test_exports.reset();
			const sessionID = `reset-${role}`;
			arm(sessionID);
			for (let i = 0; i < 10; i++) beforeRead(sessionID, i);
			await dispatchCycle(sessionID, role, 1, TASK_OK);
			expect(counter(sessionID)).toBe(0);
		}
	});
});

describe('#2063 B5 — write and status progress', () => {
	test('a successful file write resets the counter', async () => {
		const sessionID = 'write-resets';
		arm(sessionID);
		for (let i = 0; i < 12; i++) beforeRead(sessionID, i);

		clock += 1_000;
		observeExecutionStallToolCall({
			sessionID,
			tool: 'write',
			args: { filePath: '/p/out.ts', content: 'x' },
			callID: 'w-1',
		});
		await recordExecutionStallToolAfter({
			sessionID,
			tool: 'write',
			callID: 'w-1',
			output: { title: 'write', output: 'ok', metadata: {} },
			directory: TEST_DIR,
		});

		expect(counter(sessionID)).toBe(0);
	});

	test('a FAILED write does not reset the counter', async () => {
		const sessionID = 'write-fail';
		arm(sessionID);
		for (let i = 0; i < 12; i++) beforeRead(sessionID, i);
		const before = counter(sessionID);

		clock += 1_000;
		observeExecutionStallToolCall({
			sessionID,
			tool: 'edit',
			args: { filePath: '/p/out.ts' },
			callID: 'w-2',
		});
		await recordExecutionStallToolAfter({
			sessionID,
			tool: 'edit',
			callID: 'w-2',
			output: {
				title: 'edit',
				output: '',
				metadata: {},
				error: 'no such file',
			},
			directory: TEST_DIR,
		});

		expect(counter(sessionID)).toBe(before + 1);
	});

	test('update_task_status success resets the counter for ANY status', async () => {
		for (const status of ['in_progress', 'completed', 'blocked', 'pending']) {
			resetSwarmState();
			_test_exports.reset();
			const sessionID = `uts-${status}`;
			arm(sessionID);
			for (let i = 0; i < 12; i++) beforeRead(sessionID, i);

			await recordExecutionStallToolAfter({
				sessionID,
				tool: 'update_task_status',
				callID: 'uts',
				args: { task_id: '1.1', status },
				output: {
					title: 'update_task_status',
					output: JSON.stringify({ success: true, new_status: status }),
					metadata: {},
				},
				directory: TEST_DIR,
			});

			expect(counter(sessionID)).toBe(0);
		}
	});
});

describe('#2063 B5 — periodic workspace probe', () => {
	/** Arm, then capture the baseline via one non-progress cycle. */
	async function armWithBaseline(sessionID: string): Promise<void> {
		arm(sessionID);
		await readCycle(sessionID, 0);
		expect(_test_exports.peekState(sessionID)?.needsWorkspaceBaseline).toBe(
			false,
		);
	}

	test('a DIRTY baseline still detects new changes (changedFilesSinceSnapshot returns null there)', async () => {
		// This is the production-shaped case: a stalled architect's workspace is
		// almost always already dirty, and `changedFilesSinceSnapshot` fails
		// closed to `null` for a dirty baseline (workspace-snapshot.ts:1259). If
		// the probe relied on it alone, the git rung would be dead in production
		// while passing against a clean-baseline fixture.
		const sessionID = 'dirty-baseline';
		snapshots = [
			{ gitHead: 'H0', changedFiles: ['pre-existing.ts'] },
			{ gitHead: 'H0', changedFiles: ['pre-existing.ts', 'brand-new.ts'] },
		];
		changedResult = null;

		await armWithBaseline(sessionID);
		for (let i = 1; i <= PROBE_EVERY; i++) await readCycle(sessionID, i);

		expect(counter(sessionID)).toBe(0);
	});

	test('a DIRTY baseline with no new paths is NOT progress', async () => {
		const sessionID = 'dirty-no-change';
		snapshots = [
			{ gitHead: 'H0', changedFiles: ['pre-existing.ts'] },
			{ gitHead: 'H0', changedFiles: ['pre-existing.ts'] },
		];
		changedResult = null;

		await armWithBaseline(sessionID);
		for (let i = 1; i <= PROBE_EVERY; i++) await readCycle(sessionID, i);

		// arming dispatch (1) + the baseline-capture read (1) + PROBE_EVERY reads.
		expect(counter(sessionID)).toBe(PROBE_EVERY + 2);
	});

	test('a moved HEAD counts as progress even with a dirty baseline', async () => {
		const sessionID = 'head-moved';
		snapshots = [
			{ gitHead: 'H0', changedFiles: ['pre-existing.ts'] },
			{ gitHead: 'H1', changedFiles: ['pre-existing.ts'] },
		];
		changedResult = null;

		await armWithBaseline(sessionID);
		for (let i = 1; i <= PROBE_EVERY; i++) await readCycle(sessionID, i);

		expect(counter(sessionID)).toBe(0);
	});

	test('a CLEAN baseline uses changedFilesSinceSnapshot as the authoritative signal', async () => {
		const sessionID = 'clean-baseline';
		changedResult = ['src/new.ts'];

		await armWithBaseline(sessionID);
		for (let i = 1; i <= PROBE_EVERY; i++) await readCycle(sessionID, i);

		expect(counter(sessionID)).toBe(0);
	});

	test('the probe runs at most once per WORKSPACE_PROBE_EVERY_CALLS calls', async () => {
		const sessionID = 'probe-frequency';
		await armWithBaseline(sessionID);
		const capturesAfterBaseline = (
			_internals.captureWorkspaceSnapshotAsync as unknown as {
				mock: { calls: unknown[] };
			}
		).mock.calls.length;

		changedResult = [];
		for (let i = 1; i <= PROBE_EVERY - 1; i++) await readCycle(sessionID, i);
		expect(
			(
				_internals.captureWorkspaceSnapshotAsync as unknown as {
					mock: { calls: unknown[] };
				}
			).mock.calls.length,
		).toBe(capturesAfterBaseline);

		await readCycle(sessionID, PROBE_EVERY);
		expect(
			(
				_internals.captureWorkspaceSnapshotAsync as unknown as {
					mock: { calls: unknown[] };
				}
			).mock.calls.length,
		).toBeGreaterThan(capturesAfterBaseline);
	});

	test('the probe RE-BASELINES, so one old change cannot suppress the rung forever', async () => {
		// Without re-baselining, a workspace that changed once at minute 1 would
		// read as "progress" at every later probe and the hard rung would be
		// unreachable in any dirty repository.
		const sessionID = 're-baseline';
		snapshots = [
			{ gitHead: 'H0', changedFiles: [] },
			{ gitHead: 'H0', changedFiles: ['one-change.ts'] },
			{ gitHead: 'H0', changedFiles: ['one-change.ts'] },
			{ gitHead: 'H0', changedFiles: ['one-change.ts'] },
		];
		changedResult = null;

		await armWithBaseline(sessionID);
		// First probe sees the new file → progress → counter 0.
		for (let i = 1; i <= PROBE_EVERY; i++) await readCycle(sessionID, i);
		expect(counter(sessionID)).toBe(0);

		// The next window sees the SAME file, now part of the baseline → no
		// progress, so the counter keeps climbing.
		for (let i = 0; i < PROBE_EVERY + 1; i++) {
			await readCycle(sessionID, 100 + i);
		}
		expect(counter(sessionID)).toBeGreaterThan(PROBE_EVERY);
	});

	test('no probe runs while the episode is unarmed', async () => {
		const sessionID = 'unarmed-no-probe';
		swarmState.activeAgent.set(sessionID, 'architect');
		for (let i = 0; i < PROBE_EVERY * 3; i++) await readCycle(sessionID, i);
		expect(
			(
				_internals.captureWorkspaceSnapshotAsync as unknown as {
					mock: { calls: unknown[] };
				}
			).mock.calls.length,
		).toBe(0);
	});
});
