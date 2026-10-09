/**
 * The trajectory store must refuse a blank, whitespace-only, or relative
 * workspace root. `path.resolve('', '.swarm')` falls back to process.cwd(), so
 * before this guard an empty directory silently wrote `.swarm/trajectories/`
 * into whatever directory the process ran in — the plugin checkout under
 * `bun test` (AGENTS.md invariant 4).
 *
 * Every case runs with cwd inside a throwaway sandbox, so a regression lands
 * in the sandbox (and is caught by the existsSync assertions) rather than in
 * the developer's checkout.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type CwdSandbox,
	enterCwdSandbox,
} from '../../../tests/helpers/cwd-sandbox';
import {
	appendTrajectoryEntry,
	cleanupOldTrajectoryFiles,
	clearTrajectoryCache,
	getCurrentStep,
	getInMemoryTrajectory,
	readTrajectory,
} from '../trajectory-store';
import type { TrajectoryEntry } from '../types';

const entry: TrajectoryEntry = {
	step: 1,
	agent: 'test-agent',
	action: 'edit',
	target: 'src/test.ts',
	intent: 'root guard',
	timestamp: '2026-01-01T00:00:00.000Z',
	result: 'success',
};

const BAD_ROOTS = ['', '   ', '\t', 'relative/project', '.'];

describe('trajectory-store workspace-root guard', () => {
	let sandbox: CwdSandbox;

	beforeEach(() => {
		clearTrajectoryCache();
		sandbox = enterCwdSandbox('trajectory-root-guard-');
	});

	afterEach(() => {
		sandbox.restore();
		clearTrajectoryCache();
	});

	for (const bad of BAD_ROOTS) {
		test(`append with ${JSON.stringify(bad)} writes nothing and caches nothing`, async () => {
			await expect(
				appendTrajectoryEntry('s-guard', entry, bad),
			).resolves.toBeUndefined();

			expect(fs.existsSync(path.join(sandbox.cwd, '.swarm'))).toBe(false);
			expect(
				fs.existsSync(path.join(sandbox.cwd, bad.trim() || 'x', '.swarm')),
			).toBe(false);
			// A whitespace root must not materialize a whitespace-named dir.
			expect(fs.readdirSync(sandbox.cwd)).toEqual([]);
			expect(getInMemoryTrajectory('s-guard', bad)).toEqual([]);
		});
	}

	test('reads and cleanup on a blank root are inert', async () => {
		expect(await readTrajectory('s-guard', '')).toEqual([]);
		expect(await getCurrentStep('s-guard', '   ')).toBe(0);
		await expect(cleanupOldTrajectoryFiles('')).resolves.toBeUndefined();
		expect(fs.readdirSync(sandbox.cwd)).toEqual([]);
	});

	test('an absolute root still works', async () => {
		const root = path.join(sandbox.root, 'project');
		fs.mkdirSync(root);
		await appendTrajectoryEntry('s-guard', entry, root);
		expect(
			fs.existsSync(path.join(root, '.swarm', 'trajectories', 's-guard.jsonl')),
		).toBe(true);
		expect(await readTrajectory('s-guard', root)).toHaveLength(1);
	});
});
