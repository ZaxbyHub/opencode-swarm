/**
 * Epic v2 C0 (reviewer L1) — `/swarm epic clear-merge-failure <taskId>
 * [--confirm]`: the Epic-owned escape hatch for a recorded worktree merge
 * failure that blocks an epic wave (e.g. the undated delegation-gate
 * `task-result` record). Read-only without `--confirm`; only a task id with
 * a recorded failure can be cleared; clearing goes through the shared
 * registry's own `clearWorktreeMergeStatus`.
 *
 * Real registry against a canonical temp project; the registry's
 * `resetForTest` restores global state in `afterEach`. No clock is read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import {
	getWorktreeMergeFailure,
	initDurableStatusPath,
	_internals as mergeStatus,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realInternals = { ..._internals };
let dir: string;
let statusFile: string;

function onDisk(): Record<string, unknown> {
	return fs.existsSync(statusFile)
		? JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
		: {};
}

beforeEach(() => {
	dir = canonicalMkdtemp('c0-epic-clear-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	statusFile = path.join(dir, '.swarm', 'worktree-merge-status.json');
	mergeStatus.resetForTest();
	initDurableStatusPath(dir);
	// Undated, exactly as the delegation-gate 'task-result' writer records it.
	recordWorktreeMergeFailure('1.3', {
		outcome: 'failed',
		stage: 'task-result',
		message: 'task terminated with cancelled',
	});
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	mergeStatus.resetForTest();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('/swarm epic clear-merge-failure', () => {
	test('without a task id → usage', async () => {
		const out = await handleEpicCommand(dir, ['clear-merge-failure'], 's');
		expect(out).toContain('Usage: /swarm epic clear-merge-failure <taskId>');
	});

	test('a task id with no recorded failure → nothing cleared', async () => {
		const out = await handleEpicCommand(
			dir,
			['clear-merge-failure', '9.9', '--confirm'],
			's',
		);
		expect(out).toContain('nothing to clear');
		expect(Object.keys(onDisk())).toEqual(['1.3']);
	});

	test('without --confirm the call is read-only and explains the consequence', async () => {
		const out = await handleEpicCommand(
			dir,
			['clear-merge-failure', '1.3'],
			's',
		);
		expect(out).toContain('no timestamp');
		expect(out).toContain("treating the task's work as landed");
		expect(out).toContain('/swarm epic clear-merge-failure 1.3 --confirm');
		expect(getWorktreeMergeFailure('1.3')).toBeDefined();
		expect(Object.keys(onDisk())).toEqual(['1.3']);
	});

	test('--confirm clears the record in memory and on disk', async () => {
		const out = await handleEpicCommand(
			dir,
			['clear-merge-failure', '1.3', '--confirm'],
			's',
		);
		expect(out).toContain(
			'Cleared the recorded worktree merge failure for task 1.3',
		);
		expect(getWorktreeMergeFailure('1.3')).toBeUndefined();
		expect(onDisk()).toEqual({});
	});

	test('status remedy points at the escape hatch for blocking records', async () => {
		_internals.loadPlanJsonOnly = (async () => null) as never;
		const out = await handleEpicCommand(dir, ['status'], 's');
		expect(out).toMatch(/1\.3: .*NO timestamp/);
		expect(out).toContain('/swarm epic clear-merge-failure <taskId> --confirm');
	});
});
