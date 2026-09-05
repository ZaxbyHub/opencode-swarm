/**
 * Issue #2483 review width tests (FB-6 + FB-18): the keep-newest caps are
 * proven at production width, not just at the shrink-the-seam widths the
 * bounded-writer suite uses.
 *
 * FB-6: `pr-review-run-artifacts` keeps the newest PR_REVIEW_KEEP_NEWEST_RUNS
 * (50) run directories when MORE than the cap exist, deleting exactly the
 * oldest excess — seeded fresh (all mtimes at the fixed NOW) so only the
 * entry cap can prune, never the age horizon.
 *
 * FB-18: `listCapsules` truncates to the MAX_CAPSULES_LISTED seam override,
 * newest-first, when more capsule files exist than the cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
	clearRetentionCapOverrides,
	setRetentionCapOverrides,
} from '../../../src/retention/caps.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { listCapsules } = await import(
	'../../../src/context-map/capsule-persistence.js'
);
const { runRetentionSweep, PR_REVIEW_KEEP_NEWEST_RUNS } = await import(
	'../../../src/retention/sweep.js'
);

const NOW = 1_757_000_000_000; // fixed epoch anchor (check-test-clock-safe)

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`width-2483-${label}-`);
	tempRoots.push(root);
	return root;
}

function seedRunDir(root: string, name: string, mtimeMs: number): void {
	const dirPath = path.join(root, '.swarm', 'pr-review', name);
	mkdirSync(dirPath, { recursive: true });
	const filePath = path.join(dirPath, 'lane-result.json');
	writeFileSync(filePath, '{}');
	utimesSync(dirPath, new Date(mtimeMs), new Date(mtimeMs));
	utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
}

beforeEach(() => {
	clearRetentionCapOverrides();
});

afterEach(() => {
	clearRetentionCapOverrides();
	for (const root of tempRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('sweep keep-newest width (review FB-6)', () => {
	it(`keeps exactly the newest ${PR_REVIEW_KEEP_NEWEST_RUNS} run dirs when ${
		PR_REVIEW_KEEP_NEWEST_RUNS + 5
	} fresh runs exist (entry cap, not age, does the pruning)`, async () => {
		const root = makeRoot('keep-newest-50');
		const names: string[] = [];
		for (let i = 0; i < PR_REVIEW_KEEP_NEWEST_RUNS + 5; i++) {
			const name = `run-${String(i).padStart(4, '0')}`;
			names.push(name);
			// Ascending mtimes: run-0000 oldest, the last seeded run newest.
			seedRunDir(root, name, NOW - (PR_REVIEW_KEEP_NEWEST_RUNS + 5 - i) * 1000);
		}

		const result = await runRetentionSweep(root, { now: NOW });

		// Exactly the 5 oldest excess runs died; everything else survives.
		expect(result.pruned['pr-review-run-artifacts']).toBe(5);
		const victims = names.slice(0, 5); // oldest 5
		const prReviewDir = path.join(root, '.swarm', 'pr-review');
		const remaining = readdirSync(prReviewDir).sort();
		expect(remaining).toHaveLength(PR_REVIEW_KEEP_NEWEST_RUNS);
		for (const victim of victims) {
			expect(remaining).not.toContain(victim);
		}
		// The newest run is never a victim.
		expect(remaining).toContain(names[names.length - 1]);
	}, 30_000);
});

describe('capsule listing cap width (review FB-18)', () => {
	it('listCapsules truncates to the MAX_CAPSULES_LISTED override, newest-first', () => {
		const root = makeRoot('capsule-cap');
		const capsulesDir = path.join(root, '.swarm', 'capsules');
		mkdirSync(capsulesDir, { recursive: true });
		for (let i = 0; i < 12; i++) {
			const id = `task-${String(i).padStart(4, '0')}`;
			const filePath = path.join(capsulesDir, `${id}.json`);
			writeFileSync(filePath, JSON.stringify({ taskId: id }));
			// Ascending mtimes so newest-first order is unambiguous.
			utimesSync(filePath, new Date(NOW + i * 1000), new Date(NOW + i * 1000));
		}

		setRetentionCapOverrides({ MAX_CAPSULES_LISTED: 8 });
		const listed = listCapsules(root);

		expect(listed).toHaveLength(8);
		// Newest-first: the 8 highest-mtime capsules, latest first.
		expect(listed[0]).toBe('task-0011');
		expect(listed[7]).toBe('task-0004');
		for (const dropped of [
			'task-0000',
			'task-0001',
			'task-0002',
			'task-0003',
		]) {
			expect(listed).not.toContain(dropped);
		}
		// Sanity: nothing was deleted — the cap bounds the LISTING only.
		expect(existsSync(path.join(capsulesDir, 'task-0000.json'))).toBe(true);
	});
});

describe('sweep cancellation token (review FB-10 round-2 regression)', () => {
	it('records sweep_cancelled and prunes nothing when the token is already expired', async () => {
		const root = makeRoot('cancel-immediate');
		const staleRun = path.join(root, '.swarm', 'runs', 'stale.json');
		mkdirSync(path.dirname(staleRun), { recursive: true });
		writeFileSync(staleRun, '{}');
		utimesSync(
			staleRun,
			new Date(NOW - 40 * 24 * 60 * 60 * 1000),
			new Date(NOW - 40 * 24 * 60 * 60 * 1000),
		);

		const result = await runRetentionSweep(root, {
			now: NOW,
			shouldContinue: () => false,
		});

		expect(Object.keys(result.pruned)).toEqual([]);
		expect(result.errors.sweep_cancelled).toBeDefined();
		expect(existsSync(staleRun)).toBe(true);
	});

	it('stops before the FIRST post-family pass when the token expires after the directory families', async () => {
		const root = makeRoot('cancel-post-family');
		// familiesFor() currently yields 10 directory families, so polls
		// 1..10 are the family-loop polls; poll 11 is the first post-family
		// pass (review-receipts index). The token allows exactly the family
		// polls and expires there — pinning the round-2 six-pass coverage.
		const staleSummary = path.join(root, '.swarm', 'summaries', 'S1.json');
		mkdirSync(path.dirname(staleSummary), { recursive: true });
		writeFileSync(staleSummary, '{}');
		utimesSync(
			staleSummary,
			new Date(NOW - 40 * 24 * 60 * 60 * 1000),
			new Date(NOW - 40 * 24 * 60 * 60 * 1000),
		);

		let polls = 0;
		const result = await runRetentionSweep(root, {
			now: NOW,
			shouldContinue: () => ++polls <= 10,
		});

		expect(result.errors.sweep_cancelled).toContain('review-receipts-index');
		// The summaries pass was never reached.
		expect(existsSync(staleSummary)).toBe(true);
		expect(result.pruned['summaries-retention']).toBeUndefined();
	});
});
