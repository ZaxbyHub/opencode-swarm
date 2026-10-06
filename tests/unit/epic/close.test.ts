/**
 * `/swarm epic close` (closeEpic) and `/swarm close` finalization (C1a: no
 * landing): refusals, abandon, interrupted-close resume, the two report
 * copies, the newest-50 epic-prior cap, and corrupt-state repair. Real temp
 * projects, real lifecycle rows, frozen clock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionCoordinationState } from '../../../src/db/coordination-store';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	closeEpic,
	EPIC_PRIOR_REPORTS_KEEP,
	pruneEpicPriorReports,
} from '../../../src/epic/close';
import {
	EPIC_LIFECYCLE_NAMESPACE,
	epicSentinelExists,
	inspectEpic,
	markEpicClosing,
} from '../../../src/epic/lifecycle';
import { savePlan } from '../../../src/plan/manager';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject, sizedPlan } from './start-fixture';

let dir: string;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-05-01T08:00:00.000Z' });
	dir = await createStartProject('epic-close-', { git: false });
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

async function completeAll(count = 6): Promise<void> {
	const plan = sizedPlan('Start Plan', count);
	for (const task of plan.phases[0].tasks) task.status = 'completed';
	await savePlan(dir, plan);
}

function reportFiles(rel: string[]): string[] {
	const reportDir = path.join(dir, ...rel);
	return fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : [];
}

describe('closeEpic refusals', () => {
	test('no epic ⇒ no-epic', async () => {
		expect(await closeEpic({ directory: dir, abandon: false })).toEqual({
			status: 'no-epic',
			repairedSentinel: false,
		});
	});

	test('pending tasks ⇒ epic-incomplete unless --abandon', async () => {
		openEpicForTest(dir);
		const refused = await closeEpic({ directory: dir, abandon: false });
		expect(refused).toMatchObject({
			status: 'refused',
			reason: 'epic-incomplete',
		});
		if (refused.status === 'refused') {
			expect(refused.details[0]).toContain(
				'6 task(s) are not completed or closed',
			);
		}
		expect(epicSentinelExists(dir)).toBe(true);
		const abandoned = await closeEpic({ directory: dir, abandon: true });
		expect(abandoned.status).toBe('closed');
		if (abandoned.status === 'closed') {
			expect(abandoned.report.outcome).toBe('abandoned');
			expect(abandoned.report.tasks?.pending).toHaveLength(6);
		}
	});

	test('orphaned epic ⇒ epic-orphaned unless --abandon (tasks not summarized)', async () => {
		openEpicForTest(dir);
		await savePlan(dir, sizedPlan('Replacement Plan', 6));
		expect(await closeEpic({ directory: dir, abandon: false })).toMatchObject({
			reason: 'epic-orphaned',
		});
		const abandoned = await closeEpic({ directory: dir, abandon: true });
		expect(abandoned.status).toBe('closed');
		if (abandoned.status === 'closed')
			expect(abandoned.report.tasks).toBeNull();
	});

	test('unreadable state ⇒ refused; --abandon deletes every row and the sentinel', async () => {
		const epic = openEpicForTest(dir);
		transitionCoordinationState(dir, {
			namespace: EPIC_LIFECYCLE_NAMESPACE,
			entityKey: 'junk',
			expectedRevision: null,
			generation: 1,
			status: 'open',
			payload: '{"junk":true}',
		});
		expect(await closeEpic({ directory: dir, abandon: false })).toMatchObject({
			reason: 'epic-state-unreadable',
		});
		const repaired = await closeEpic({ directory: dir, abandon: true });
		expect(repaired).toMatchObject({
			status: 'repaired-unreadable',
			sentinelDeleted: true,
		});
		if (repaired.status === 'repaired-unreadable') {
			expect(repaired.rowsDeleted.sort()).toEqual(
				[epic.epicKey, 'junk'].sort(),
			);
		}
		expect(inspectEpic(dir).rowKeys).toEqual([]);
	});
});

describe('successful close', () => {
	test('completed epic: report in .swarm/epic/reports and .swarm/epic-prior/reports; row + sentinel gone', async () => {
		const epic = openEpicForTest(dir, {
			startedAt: '2026-05-01T07:00:00.000Z',
		});
		await completeAll();
		const result = await closeEpic({ directory: dir, abandon: false });
		expect(result.status).toBe('closed');
		if (result.status !== 'closed') return;
		const key = `${epic.epicKey}-20260501T070000Z`;
		expect(result.report).toMatchObject({
			schema: 'epic-report-v2',
			reportKey: key,
			outcome: 'completed',
			closedAt: '2026-05-01T08:00:00.000Z',
			tasks: { total: 6, completed: 6, closed: 0, pending: [] },
			// v2 embeds the scorecard (the start facts moved into it).
			scorecard: {
				schema: 'epic-scorecard-v1',
				epicKey: epic.epicKey,
				outcome: 'completed',
				closedAt: '2026-05-01T08:00:00.000Z',
				forced: false,
				tasks: { total: 6, completedInEpic: 0 },
			},
		});
		expect(result.report).not.toHaveProperty('sizingAtStart');
		expect(reportFiles(['.swarm', 'epic', 'reports'])).toEqual([`${key}.json`]);
		expect(reportFiles(['.swarm', 'epic-prior', 'reports'])).toEqual([
			`${key}.json`,
		]);
		expect(result.sentinelDeleted).toBe(true);
		expect(inspectEpic(dir).rowKeys).toEqual([]);
	});

	test('an interrupted close (row left closing) resumes with its first outcome', async () => {
		const epic = openEpicForTest(dir);
		markEpicClosing(dir, epic.epicKey, 'abandoned');
		// Pending tasks no longer block: the close was already decided.
		const result = await closeEpic({ directory: dir, abandon: false });
		expect(result.status).toBe('closed');
		if (result.status === 'closed')
			expect(result.report.outcome).toBe('abandoned');
	});

	test('a stale sentinel without a row is repaired by close', async () => {
		const epic = openEpicForTest(dir);
		await closeEpic({ directory: dir, abandon: true });
		fs.mkdirSync(path.join(dir, '.swarm', 'epic'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic', 'epic.json'),
			JSON.stringify({
				schema: 'epic-sentinel-v1',
				epicKey: epic.epicKey,
				token: 't',
				planId: 'p',
				startedAt: 's',
			}),
		);
		expect(await closeEpic({ directory: dir, abandon: false })).toEqual({
			status: 'no-epic',
			repairedSentinel: true,
		});
	});
});

describe('epic-prior cap', () => {
	test(`keeps the newest ${EPIC_PRIOR_REPORTS_KEEP} report files only`, () => {
		const priorDir = path.join(dir, '.swarm', 'epic-prior', 'reports');
		fs.mkdirSync(priorDir, { recursive: true });
		for (let index = 0; index < EPIC_PRIOR_REPORTS_KEEP + 3; index += 1) {
			const name = `k-202601${String(index).padStart(2, '0')}T000000Z.json`;
			const file = path.join(priorDir, name);
			fs.writeFileSync(file, '{}');
			const when = new Date(1_767_225_600_000 + index * 60_000);
			fs.utimesSync(file, when, when);
		}
		fs.writeFileSync(path.join(priorDir, 'README.txt'), 'not a report');
		expect(pruneEpicPriorReports(dir)).toBe(3);
		const left = fs.readdirSync(priorDir);
		expect(left).toHaveLength(EPIC_PRIOR_REPORTS_KEEP + 1);
		expect(left).toContain('README.txt');
		expect(left).not.toContain('k-20260100T000000Z.json');
	});
});
