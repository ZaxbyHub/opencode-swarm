/**
 * Epic v2 C0 — merge-failure epoch filter (`src/epic/merge-epoch.ts`).
 *
 * The shared registry is keyed by bare task id and never cleaned, so a
 * failure from a previous plan must not block the current plan's epic,
 * while an undated failure stays relevant (fail closed). Registry reads go
 * through the module's `_internals` seam; timestamps are literals.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	classifyMergeFailure,
	describeMergeFailuresForStatus,
	relevantMergeFailure,
	relevantMergeFailureForProject,
} from '../../../src/epic/merge-epoch';
import type { WorktreeMergeFailure } from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ROOT = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z
const base: WorktreeMergeFailure = {
	outcome: 'failed',
	stage: 'merge',
	message: 'conflict',
};

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
});

describe('classifyMergeFailure / relevantMergeFailure', () => {
	test('completedAt wins over queuedAt; boundary is inclusive', () => {
		expect(classifyMergeFailure({ ...base, completedAt: ROOT }, ROOT)).toBe(
			'current',
		);
		expect(classifyMergeFailure({ ...base, completedAt: ROOT - 1 }, ROOT)).toBe(
			'stale',
		);
		expect(
			classifyMergeFailure(
				{ ...base, queuedAt: ROOT + 5, completedAt: ROOT - 1 },
				ROOT,
			),
		).toBe('stale');
		expect(classifyMergeFailure({ ...base, queuedAt: ROOT + 5 }, ROOT)).toBe(
			'current',
		);
		expect(classifyMergeFailure(base, ROOT)).toBe('undated');
	});

	test('stale pre-root failure is filtered out; current and undated are returned', () => {
		const table: Record<string, WorktreeMergeFailure> = {
			stale: { ...base, completedAt: ROOT - 60_000 },
			current: { ...base, completedAt: ROOT + 60_000 },
			undated: base,
		};
		_internals.getWorktreeMergeFailure = (id: string) => table[id];
		expect(relevantMergeFailure('stale', ROOT)).toBeUndefined();
		expect(relevantMergeFailure('current', ROOT)).toBe(table.current);
		expect(relevantMergeFailure('undated', ROOT)).toBe(table.undated);
		expect(relevantMergeFailure('absent', ROOT)).toBeUndefined();
		// Unknown plan root (sinceMs 0): every recorded failure is relevant.
		expect(relevantMergeFailure('stale', 0)).toBe(table.stale);
	});
});

describe('describeMergeFailuresForStatus', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('c0-merge-epoch-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function writeStatus(data: unknown): void {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'worktree-merge-status.json'),
			typeof data === 'string' ? data : JSON.stringify(data),
		);
	}

	test('no status file → no lines', () => {
		expect(describeMergeFailuresForStatus(dir, ROOT)).toEqual([]);
	});

	test('classifies stale / blocking / undated with a remedy', () => {
		writeStatus({
			'1.1': { ...base, completedAt: ROOT - 1 },
			'1.2': { ...base, completedAt: ROOT + 1 },
			'1.3': base,
		});
		const text = describeMergeFailuresForStatus(dir, ROOT).join('\n');
		expect(text).toContain('### Worktree merge failures');
		expect(text).toContain('2026-01-01T00:00:00.000Z');
		expect(text).toMatch(/1\.1: .*stale .*ignored by Epic/);
		expect(text).toMatch(/1\.2: .*BLOCKING/);
		expect(text).toMatch(/1\.3: .*NO timestamp.*BLOCKING \(fail closed\)/);
		expect(text).toContain('Remedy:');
	});

	test('only stale failures → listed without a remedy', () => {
		writeStatus({ '1.1': { ...base, completedAt: ROOT - 1 } });
		const text = describeMergeFailuresForStatus(dir, ROOT).join('\n');
		expect(text).toContain('stale');
		expect(text).not.toContain('Remedy:');
	});

	test('unknown plan root → every failure reported as blocking', () => {
		writeStatus({ '1.1': { ...base, completedAt: 1 } });
		const text = describeMergeFailuresForStatus(dir, null).join('\n');
		expect(text).toContain('unknown (no plan ledger)');
		expect(text).toMatch(/1\.1: .*BLOCKING/);
	});

	test('malformed status file → uncertain notice, never throws', () => {
		writeStatus('{not json');
		const text = describeMergeFailuresForStatus(dir, ROOT).join('\n');
		expect(text).toContain('Could not read');
	});
});

describe('relevantMergeFailureForProject (epic_next_wave advance rule)', () => {
	const ours = path.join('/p', '.swarm', 'worktree-merge-status.json');
	const durable: Array<[string, WorktreeMergeFailure]> = [
		['disk', { ...base, completedAt: ROOT + 1 }],
		['old', { ...base, completedAt: ROOT - 1 }],
	];
	beforeEach(() => {
		_internals.initDurableStatusPath = () => {
			throw new Error('the shared binding must never change');
		};
		_internals.getWorktreeMergeFailure = (id: string) =>
			id === 'live' ? { ...base, completedAt: ROOT + 2 } : undefined;
		_internals.scanWorktreeMergeFailuresForRecovery = () => ({
			status: 'ok',
			failures: durable,
		});
	});

	test('registry bound to THIS project: in-memory first, then the durable file; stale filtered', () => {
		_internals.getBoundStatusPath = () => ours;
		expect(
			relevantMergeFailureForProject('/p', 'live', ROOT)?.completedAt,
		).toBe(ROOT + 2);
		expect(
			relevantMergeFailureForProject('/p', 'disk', ROOT)?.completedAt,
		).toBe(ROOT + 1);
		expect(relevantMergeFailureForProject('/p', 'old', ROOT)).toBeUndefined();
		expect(relevantMergeFailureForProject('/p', 'none', ROOT)).toBeUndefined();
	});

	test.each([
		[
			'another project',
			() => path.join('/other', '.swarm', 'worktree-merge-status.json'),
		],
		[
			'nothing (unbound)',
			() => {
				throw new Error('durableStatusPath not set');
			},
		],
	])('registry bound to %s: the in-memory map is ignored; only this project’s durable file counts', (_label, bound) => {
		_internals.getBoundStatusPath = bound as () => string;
		expect(relevantMergeFailureForProject('/p', 'live', ROOT)).toBeUndefined();
		expect(
			relevantMergeFailureForProject('/p', 'disk', ROOT)?.completedAt,
		).toBe(ROOT + 1);
	});

	test('an unreadable durable file adds nothing', () => {
		_internals.getBoundStatusPath = () => ours;
		_internals.scanWorktreeMergeFailuresForRecovery = () => ({
			status: 'uncertain',
			reason: 'corrupt',
		});
		expect(relevantMergeFailureForProject('/p', 'disk', ROOT)).toBeUndefined();
	});
});
