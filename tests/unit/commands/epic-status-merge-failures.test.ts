/**
 * Epic v2 C0 — `/swarm epic status` surfaces recorded worktree merge-back
 * failures classified against the current plan's root (stale ⇒ ignored by
 * Epic; undated ⇒ blocking, fail closed) with a remedy.
 *
 * Uses the command's `_internals` seam (AGENTS.md #7) with a real temp
 * project holding `.swarm/worktree-merge-status.json`. Timestamps are
 * literals; no clock is read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ROOT = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z
const realInternals = { ..._internals };
let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('c0-epic-status-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_internals.loadPlanJsonOnly = (async () => ({})) as never;
	_internals.resolvePlanMarkerScope = async () => ({
		planKey: 'aaaaaaaaaaaaaaaa',
		rootTimestampMs: ROOT,
	});
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeStatus(data: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'worktree-merge-status.json'),
		JSON.stringify(data),
	);
}

describe('/swarm epic status — merge-failure epoch section', () => {
	test('no recorded failures → no section', async () => {
		const out = await handleEpicCommand(dir, ['status'], 's');
		expect(out).not.toContain('Worktree merge failures');
	});

	test('stale, current and undated failures are classified with a remedy', async () => {
		writeStatus({
			'1.1': {
				outcome: 'failed',
				stage: 'merge',
				message: 'old plan',
				completedAt: ROOT - 1,
			},
			'1.2': {
				outcome: 'partial',
				stage: 'rebase',
				message: 'this plan',
				completedAt: ROOT + 1,
			},
			'1.3': { outcome: 'failed', stage: 'merge', message: 'undated' },
		});
		for (const args of [['status'], []]) {
			const out = await handleEpicCommand(dir, args, 's');
			expect(out).toContain('### Worktree merge failures');
			expect(out).toMatch(/1\.1: .*stale/);
			expect(out).toMatch(/1\.2: .*BLOCKING/);
			expect(out).toMatch(/1\.3: .*NO timestamp.*fail closed/);
			expect(out).toContain('Remedy:');
		}
	});

	test('plan identity unresolvable → every failure reported as blocking', async () => {
		_internals.resolvePlanMarkerScope = async () => {
			throw new Error('no ledger identity');
		};
		writeStatus({
			'1.1': {
				outcome: 'failed',
				stage: 'merge',
				message: 'x',
				completedAt: 1,
			},
		});
		const out = await handleEpicCommand(dir, ['status'], 's');
		expect(out).toContain('unknown (no plan ledger)');
		expect(out).toMatch(/1\.1: .*BLOCKING/);
	});
});
