/**
 * Issue #2483 (fix-plan §8): the retention sweep — per-family prune/keep,
 * summaries retention_days (default 7 + custom), containment, dry-run,
 * enabled:false, per-family fail-open, the NEGATIVE authoritative-streams
 * guarantee, and the two R4 wiring assertions (post-init task registration in
 * src/index.ts source + the behavioral close-path sweep).
 *
 * The close-path test reuses the harness approach of
 * tests/unit/commands/close-wal-preserve.test.ts (same module mocks, plan
 * written through savePlan, real WAL-mode swarm.db) so the full close
 * pipeline reaches its archive/clean stages where the #2483 sweep runs.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { savePlan } from '../../../src/plan/manager.js';
import * as realSummaries from '../../../src/summaries/manager.js';
import { installCloseCommandMocks } from '../../helpers/close-command-mocks';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

installCloseCommandMocks();

// File-scoped seam for the per-family fail-open test: cleanupSummaries
// delegates to the real implementation by default, so every other test in
// this file (and any co-run file that reaches it through the sweep) observes
// production behavior. The single throw-implementation installed in the
// fail-open test is the only covered deviation; the real retention semantics
// are covered by the summaries family tests below. The real function is
// CAPTURED before mock.module installs — the skill's circular-mock rule: a
// live namespace binding is hot-patched by mock.module, so referencing
// realSummaries.cleanupSummaries inside the factory would recurse forever.
const realCleanupSummaries = realSummaries.cleanupSummaries;
const cleanupSummariesMock = mock(
	(directory: string, retentionDays: number, options?: { now?: number }) =>
		realCleanupSummaries(directory, retentionDays, options),
);
mock.module('../../../src/summaries/manager.js', () => ({
	...realSummaries,
	cleanupSummaries: cleanupSummariesMock,
}));

const { runRetentionSweep } = await import('../../../src/retention/sweep.js');
const { handleCloseCommand } = await import('../../../src/commands/close.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_757_000_000_000; // fixed epoch anchor (check-test-clock-safe); all mtimes are offsets of this
const OLD_40D = NOW - 40 * DAY_MS;
const OLD_100D = NOW - 100 * DAY_MS;

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`sweep-2483-${label}-`);
	tempRoots.push(root);
	return root;
}

function seedFile(
	root: string,
	rel: string,
	mtimeMs: number = NOW,
	content = '{}',
): string {
	const filePath = path.join(root, '.swarm', rel);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
	utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
	return filePath;
}

function seedDir(root: string, rel: string, mtimeMs: number = NOW): string {
	const dirPath = path.join(root, '.swarm', rel);
	mkdirSync(dirPath, { recursive: true });
	utimesSync(dirPath, new Date(mtimeMs), new Date(mtimeMs));
	return dirPath;
}

beforeEach(() => {
	// Re-install the delegating default in case a prior test overrode it.
	cleanupSummariesMock.mockImplementation(
		(directory: string, retentionDays: number, options?: { now?: number }) =>
			realCleanupSummaries(directory, retentionDays, options),
	);
});

afterEach(() => {
	mock.restore();
	for (const root of tempRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('retention sweep families: prune old, keep recent (issue #2483)', () => {
	it('legacy plan-ledger archives keep the newest bounded window and prune older history', async () => {
		const root = makeRoot('legacy-ledger-archives');
		const archiveNames = Array.from(
			{ length: 18 },
			(_, index) =>
				`plan-ledger.legacy-archive.${String(index).padStart(64, '0')}.jsonl`,
		);
		for (const [index, name] of archiveNames.entries()) {
			seedFile(
				root,
				name,
				index < 16 ? NOW - index * DAY_MS : NOW - (40 + index) * DAY_MS,
				`archive-${index}`,
			);
		}

		const result = await runRetentionSweep(root, { now: NOW });

		expect(
			archiveNames
				.slice(0, 16)
				.every((name) => existsSync(path.join(root, '.swarm', name))),
		).toBe(true);
		expect(
			archiveNames
				.slice(16)
				.every((name) => !existsSync(path.join(root, '.swarm', name))),
		).toBe(true);
		expect(result.pruned['legacy-ledger-archives']).toBe(2);
	});

	it.each([
		['pr-feedback-events', 'pr-feedback-events', 'pr-feedback-events'],
		[
			'reentry-shadows',
			'pr-review/reentry-authorizations',
			'pr-review-reentry-shadows',
		],
		['review-receipts', 'review-receipts', 'review-receipts'],
		['lane-results', 'lane-results', 'lane-results'],
		['capsules', 'capsules', 'capsules'],
		['runs', 'runs', 'runs'],
		['skills/proposals', 'skills/proposals', 'skills-proposals'],
		[
			'skill-improver/proposals',
			'skill-improver/proposals',
			'skill-improver-proposals',
		],
		['recovery', 'recovery', 'recovery'],
	])('%s: 40d-old entry pruned, recent entry kept', async (_label, relDir, prunedKey) => {
		const root = makeRoot('family');
		const oldEntry = seedFile(
			root,
			path.join(relDir, 'old-entry.json'),
			OLD_40D,
		);
		const freshEntry = seedFile(root, path.join(relDir, 'fresh-entry.json'));
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(oldEntry)).toBe(false);
		expect(existsSync(freshEntry)).toBe(true);
		expect(result.pruned[prunedKey]).toBe(1);
		expect(result.errors).toEqual({});
	});

	it('skills/proposals 14d pending-review expiry: a 20d-old proposal prunes (a 30d family would keep it); a 10d-old one survives', async () => {
		const root = makeRoot('skills-14d');
		const twentyDays = seedFile(
			root,
			path.join('skills', 'proposals', 'twenty-days.json'),
			NOW - 20 * DAY_MS,
		);
		const tenDays = seedFile(
			root,
			path.join('skills', 'proposals', 'ten-days.json'),
			NOW - 10 * DAY_MS,
		);
		const result = await runRetentionSweep(root, { now: NOW });
		// 20d > the 14d horizon: pruned here even though every 30d family in
		// this suite keeps 20d-old entries — this pins the tighter window.
		expect(existsSync(twentyDays)).toBe(false);
		expect(existsSync(tenDays)).toBe(true);
		expect(result.pruned['skills-proposals']).toBe(1);
	});

	it('pr-review/{run} artifacts: stale run dir pruned, fresh run dir kept', async () => {
		const root = makeRoot('pr-review-runs');
		const oldRun = seedDir(
			root,
			path.join('pr-review', 'run-2020-01'),
			OLD_40D,
		);
		const freshRun = seedDir(root, path.join('pr-review', 'run-recent'));
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(oldRun)).toBe(false);
		expect(existsSync(freshRun)).toBe(true);
		expect(result.pruned['pr-review-run-artifacts']).toBe(1);
	});

	it('epic divergence.jsonl + calibration.json: 40d-old whole files deleted, sibling epic file kept', async () => {
		const root = makeRoot('epic-files');
		const divergence = seedFile(
			root,
			path.join('epic', 'divergence.jsonl'),
			OLD_40D,
			'{"d":1}\n',
		);
		const calibrationFile = seedFile(
			root,
			path.join('epic', 'calibration.json'),
			OLD_40D,
			'{"hotModuleAdditions":[]}',
		);
		const sibling = seedFile(
			root,
			path.join('epic', 'notes.txt'),
			OLD_40D,
			'keep',
		);
		const freshDivergence = seedFile(
			root,
			path.join('epic', 'divergence.recent.jsonl'),
			NOW,
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(divergence)).toBe(false);
		expect(existsSync(calibrationFile)).toBe(false);
		expect(existsSync(sibling)).toBe(true);
		expect(existsSync(freshDivergence)).toBe(true);
		expect(result.pruned['epic-divergence']).toBe(1);
		expect(result.pruned['epic-calibration']).toBe(1);
	});

	it('doc-drift-phase-1.json.imported: 40d-old cold archive pruned; recent .imported and non-imported drift file kept', async () => {
		const root = makeRoot('doc-drift');
		const staleImported = seedFile(
			root,
			'doc-drift-phase-1.json.imported',
			OLD_40D,
		);
		const freshImported = seedFile(
			root,
			'doc-drift-phase-2.json.imported',
			NOW,
		);
		const plainOld = seedFile(root, 'doc-drift-phase-3.json', OLD_40D);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(staleImported)).toBe(false);
		expect(existsSync(freshImported)).toBe(true);
		expect(existsSync(plainOld)).toBe(true);
		expect(result.pruned['doc-drift-imported']).toBe(1);
	});

	it('evolution: terminal 40d candidate pruned from lifecycle.jsonl tail; non-terminal 40d candidate survives; 100d unreadable candidate hits the backstop', async () => {
		const root = makeRoot('evolution');
		const terminal = seedDir(
			root,
			path.join('evolution', 'skills', 'my-skill', 'cand-terminal'),
			OLD_40D,
		);
		writeFileSync(
			path.join(terminal, 'lifecycle.jsonl'),
			'{"type":"state","toState":"active"}\n{"type":"state","toState":"rejected"}\n',
		);
		utimesSync(terminal, new Date(OLD_40D), new Date(OLD_40D));
		// Candidates are aged by CONTENT (newest file in the subtree), so the
		// lifecycle ledger itself must carry the old mtime — the physically
		// consistent shape of a candidate whose last transition was 40d ago.
		utimesSync(
			path.join(terminal, 'lifecycle.jsonl'),
			new Date(OLD_40D),
			new Date(OLD_40D),
		);
		const active = seedDir(
			root,
			path.join('evolution', 'skills', 'my-skill', 'cand-active'),
			OLD_40D,
		);
		writeFileSync(
			path.join(active, 'lifecycle.jsonl'),
			'{"type":"state","toState":"active"}\n',
		);
		utimesSync(active, new Date(OLD_40D), new Date(OLD_40D));
		utimesSync(
			path.join(active, 'lifecycle.jsonl'),
			new Date(OLD_40D),
			new Date(OLD_40D),
		);
		const unreadable = seedDir(
			root,
			path.join('evolution', 'skills', 'my-skill', 'cand-stale'),
			OLD_100D,
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(terminal)).toBe(false);
		expect(existsSync(active)).toBe(true);
		expect(existsSync(unreadable)).toBe(false);
		expect(result.pruned['evolution-terminal-candidates']).toBe(2);
	});
});

describe('summaries retention_days becomes live through the sweep', () => {
	it('default 7d: timestamp-less S1..S3 with old mtimes pruned, recent S4 kept', async () => {
		const root = makeRoot('summaries-default');
		// No timestamp field in the content — cleanup falls back to mtime.
		for (const id of ['S1', 'S2', 'S3']) {
			seedFile(
				root,
				path.join('summaries', `${id}.json`),
				NOW - 10 * DAY_MS,
				'{"fullOutput":"x"}',
			);
		}
		seedFile(
			root,
			path.join('summaries', 'S4.json'),
			NOW,
			'{"fullOutput":"y"}',
		);
		const result = await runRetentionSweep(root, { now: NOW });
		for (const id of ['S1', 'S2', 'S3']) {
			expect(
				existsSync(path.join(root, '.swarm', 'summaries', `${id}.json`)),
			).toBe(false);
		}
		expect(existsSync(path.join(root, '.swarm', 'summaries', 'S4.json'))).toBe(
			true,
		);
		expect(result.pruned['summaries-retention']).toBe(3);
	});

	it('custom retentionDays honored: a 10d-old summary survives a 30d horizon and dies under a 1d horizon', async () => {
		const root = makeRoot('summaries-custom');
		const summary = seedFile(
			root,
			path.join('summaries', 'S5.json'),
			NOW - 10 * DAY_MS,
			'{"fullOutput":"z"}',
		);
		const lenient = await runRetentionSweep(root, {
			now: NOW,
			summariesRetentionDays: 30,
		});
		expect(existsSync(summary)).toBe(true);
		expect(lenient.pruned['summaries-retention']).toBeUndefined();
		const harsh = await runRetentionSweep(root, {
			now: NOW,
			summariesRetentionDays: 1,
		});
		expect(existsSync(summary)).toBe(false);
		expect(harsh.pruned['summaries-retention']).toBe(1);
	});
});

describe('sweep safety modes', () => {
	it('containment: a stale sibling OUTSIDE .swarm/ is never touched', async () => {
		const root = makeRoot('containment');
		const sibling = path.join(root, 'sibling-stale.json');
		writeFileSync(sibling, '{"outside":true}');
		utimesSync(sibling, new Date(OLD_40D), new Date(OLD_40D));
		const staleRun = seedFile(root, path.join('runs', 'old.json'), OLD_40D);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(sibling)).toBe(true);
		expect(existsSync(staleRun)).toBe(false);
	});

	it('dryRun reports would-prune counts without deleting', async () => {
		const root = makeRoot('dry-run');
		const staleRun = seedFile(root, path.join('runs', 'old.json'), OLD_40D);
		const result = await runRetentionSweep(root, { now: NOW, dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(result.pruned['runs']).toBe(1);
		expect(existsSync(staleRun)).toBe(true);
	});

	it('enabled:false is a no-op reporting { disabled: true }', async () => {
		const root = makeRoot('disabled');
		const staleRun = seedFile(root, path.join('runs', 'old.json'), OLD_40D);
		const result = await runRetentionSweep(root, { now: NOW, enabled: false });
		expect(result.disabled).toBe(true);
		expect(result.pruned).toEqual({});
		expect(existsSync(staleRun)).toBe(true);
	});

	it('fail-open: a throwing summaries family records an error and never aborts the other families', async () => {
		const root = makeRoot('fail-open');
		const staleRun = seedFile(root, path.join('runs', 'old.json'), OLD_40D);
		cleanupSummariesMock.mockImplementation(() => {
			throw new Error('simulated summaries store failure');
		});
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(staleRun)).toBe(false);
		expect(result.pruned['runs']).toBe(1);
		expect(result.errors['summaries-retention']).toContain(
			'simulated summaries store failure',
		);
	});

	it('NEGATIVE: authoritative streams are never touched by the sweep', async () => {
		const root = makeRoot('authoritative');
		const ledger = seedFile(
			root,
			'plan-ledger.jsonl',
			OLD_100D,
			'{"type":"plan"}\n',
		);
		const knowledge = seedFile(
			root,
			'knowledge.jsonl',
			OLD_100D,
			'{"lesson":"l"}\n',
		);
		const council = seedFile(root, path.join('council', 'x.json'), OLD_100D);
		const evidence = seedFile(root, path.join('evidence', 'x.json'), OLD_100D);
		const scope = seedFile(root, path.join('scopes', 'x.json'), OLD_100D);
		const db = seedFile(root, 'swarm.db', OLD_100D, 'sqlite-bytes');
		const telemetry = seedFile(
			root,
			'telemetry.jsonl',
			OLD_100D,
			'{"event":"e"}\n',
		);
		const result = await runRetentionSweep(root, { now: NOW });
		for (const survivor of [
			ledger,
			knowledge,
			council,
			evidence,
			scope,
			db,
			telemetry,
		]) {
			expect(existsSync(survivor)).toBe(true);
		}
		expect(Object.keys(result.pruned)).toEqual([]);
	});
});

describe('R4 wiring: the sweep is reachable in production', () => {
	it('src/index.ts registers retentionSweepPostInitTask on the post-resolution queue, withTimeout-bounded', () => {
		const source = readFileSync(path.resolve('src/index.ts'), 'utf-8');
		const registration = source.indexOf('retentionSweepPostInitTask');
		expect(registration).toBeGreaterThanOrEqual(0);
		// The registration window: the push through the post-resolution queue
		// with the withTimeout/RETENTION_SWEEP_INIT_TIMEOUT_MS budget around
		// runRetentionSweep (source-shape assertion; role-contract precedent).
		const window = source.slice(
			Math.max(0, registration - 200),
			registration + 1800,
		);
		expect(window).toContain('postResolutionTasks.push');
		expect(window).toContain('withTimeout');
		expect(window).toContain('RETENTION_SWEEP_INIT_TIMEOUT_MS');
		expect(window).toContain('runRetentionSweep');
	});

	it('behavioral close path: /swarm close sweeps a stale recovery file that no close stage owns', async () => {
		const root = makeRoot('close-path');
		mkdirSync(path.join(root, '.swarm'), { recursive: true });
		await savePlan(root, {
			title: 'Sweep Wiring',
			swarm: 'sweep-wiring',
			schema_version: '1.0.0',
			current_phase: 1,
			phases: [{ id: 1, name: 'P1', status: 'complete', tasks: [] }],
		});
		// recovery/ is deliberately NOT a close artifact (fix-plan R6: the
		// sweep owns it) — so its removal after close can only come from the
		// #2483 close-time sweep pass between the archive and clean stages.
		const staleRecovery = path.join(root, '.swarm', 'recovery', 'lane-a.json');
		mkdirSync(path.dirname(staleRecovery), { recursive: true });
		writeFileSync(staleRecovery, '{"recoverable":true}');
		utimesSync(staleRecovery, new Date(OLD_40D), new Date(OLD_40D));
		const freshRecovery = path.join(root, '.swarm', 'recovery', 'lane-b.json');
		writeFileSync(freshRecovery, '{"recoverable":true}');

		const output = await handleCloseCommand(root, []);

		expect(output).toContain('finalized');
		expect(existsSync(staleRecovery)).toBe(false);
		expect(existsSync(freshRecovery)).toBe(true);
	}, 60_000);
});
