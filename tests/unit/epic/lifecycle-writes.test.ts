/**
 * Epic v2 lifecycle writes under the lifecycle lock (M-d): CAS create (only
 * the winner writes the sentinel), sentinel compare-and-delete, repair, and
 * revision-checked record updates. Real temp project + real swarm.db.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deleteCoordinationState,
	getCoordinationStateRaw,
	listCoordinationStates,
	transitionCoordinationState,
} from '../../../src/db/coordination-store';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import {
	createEpicRecord,
	deleteEpicState,
	EPIC_LIFECYCLE_NAMESPACE,
	EPIC_SENTINEL_RELATIVE_PATH,
	epicSentinelExists,
	inspectEpic,
	markEpicClosing,
	parseEpicRecord,
	readEpicSentinel,
	repairEpicSentinel,
	updateEpicRecord,
} from '../../../src/epic/lifecycle';
import { openEpicForTest, stubEpicRecord } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
let restoreClock: Restore | null = null;

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-03-01T00:00:00.000Z' });
	dir = canonicalMkdtemp('epic-writes-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({ swarm: 'w-swarm', title: 'Writes', phases: [] }),
	);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('CAS create', () => {
	test('second start loses: no second row, sentinel still names the winner', () => {
		const winner = openEpicForTest(dir);
		const loser = createEpicRecord(
			dir,
			stubEpicRecord({ ...winner, token: 'loser-token' }),
		);
		expect(loser).toEqual({
			outcome: 'exists',
			existingKeys: [winner.epicKey],
		});
		const other = createEpicRecord(
			dir,
			stubEpicRecord({ planId: 'other', token: 'other-token' }),
		);
		expect(other.outcome).toBe('exists');
		expect(listCoordinationStates(dir, EPIC_LIFECYCLE_NAMESPACE)).toHaveLength(
			1,
		);
		expect(readEpicSentinel(dir)?.token).toBe(winner.token);
	});

	test('a failed sentinel write rolls the row back (no half-open epic)', () => {
		// A directory where the sentinel file must go makes the write fail.
		fs.mkdirSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH), {
			recursive: true,
		});
		expect(() => createEpicRecord(dir, stubEpicRecord())).toThrow();
		expect(listCoordinationStates(dir, EPIC_LIFECYCLE_NAMESPACE)).toHaveLength(
			0,
		);
	});
});

describe('compare-and-delete', () => {
	test('a stale close (old token) deletes its row but never a newer sentinel', () => {
		const first = openEpicForTest(dir);
		// The sentinel now names a different start of the same epicKey.
		fs.writeFileSync(
			path.join(dir, EPIC_SENTINEL_RELATIVE_PATH),
			JSON.stringify({
				schema: 'epic-sentinel-v1',
				epicKey: first.epicKey,
				token: 'newer-token',
				planId: first.planId,
				startedAt: first.startedAt,
			}),
		);
		const result = deleteEpicState(dir, first.epicKey, first.token);
		expect(result.rowsDeleted).toEqual([first.epicKey]);
		expect(result.sentinelDeleted).toBe(false);
		expect(epicSentinelExists(dir)).toBe(true);
	});

	test('a sentinel naming another epicKey is kept', () => {
		const epic = openEpicForTest(dir);
		const other = stubEpicRecord({ planId: 'zzz', token: epic.token });
		expect(deleteEpicState(dir, other.epicKey, epic.token)).toEqual({
			rowsDeleted: [],
			sentinelDeleted: false,
		});
		expect(epicSentinelExists(dir)).toBe(true);
	});

	test('matching key + token: row then sentinel removed', () => {
		const epic = openEpicForTest(dir);
		expect(deleteEpicState(dir, epic.epicKey, epic.token)).toEqual({
			rowsDeleted: [epic.epicKey],
			sentinelDeleted: true,
		});
		expect(epicSentinelExists(dir)).toBe(false);
	});

	test('corrupt-state repair (null key) deletes rows without parsing them', () => {
		openEpicForTest(dir);
		transitionCoordinationState(dir, {
			namespace: EPIC_LIFECYCLE_NAMESPACE,
			entityKey: 'garbage',
			expectedRevision: null,
			generation: 1,
			status: 'open',
			payload: '{"not":"a record"}',
		});
		const result = deleteEpicState(dir, null, null);
		expect(result.rowsDeleted.sort()).toHaveLength(2);
		expect(result.sentinelDeleted).toBe(true);
		expect(listCoordinationStates(dir, EPIC_LIFECYCLE_NAMESPACE)).toHaveLength(
			0,
		);
	});
});

describe('stale caller vs a re-opened epic with the same epicKey (F1)', () => {
	test('a stale close (token A) neither closes nor deletes re-opened epic B', () => {
		const a = openEpicForTest(dir, { token: 'token-A' });
		deleteEpicState(dir, a.epicKey, a.token);
		const b = openEpicForTest(dir, { token: 'token-B' });
		expect(b.epicKey).toBe(a.epicKey);
		expect(markEpicClosing(dir, a.epicKey, 'abandoned', a.token)).toBeNull();
		expect(
			updateEpicRecord(
				dir,
				a.epicKey,
				(record) => ({ ...record, activeWaveSeq: 99 }),
				a.token,
			),
		).toBeNull();
		expect(deleteEpicState(dir, a.epicKey, a.token)).toEqual({
			rowsDeleted: [],
			sentinelDeleted: false,
		});
		const raw = getCoordinationStateRaw(
			dir,
			EPIC_LIFECYCLE_NAMESPACE,
			b.epicKey,
		);
		expect(raw?.status).toBe('open');
		expect(readEpicSentinel(dir)?.token).toBe('token-B');
	});
});

describe('non-JSON rows (F5)', () => {
	test('a non-JSON row with no sentinel is still removed by corrupt-state repair', () => {
		const epic = openEpicForTest(dir);
		const db = getProjectDb(dir);
		db.run('UPDATE coordination_state SET payload = ? WHERE namespace = ?', [
			'not json',
			EPIC_LIFECYCLE_NAMESPACE,
		]);
		fs.unlinkSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH));
		const inspection = inspectEpic(dir);
		expect(inspection.unreadable).not.toBeNull();
		expect(inspection.rowKeys).toEqual([epic.epicKey]);
		expect(deleteEpicState(dir, null, null).rowsDeleted).toEqual([
			epic.epicKey,
		]);
		expect(inspectEpic(dir).rowKeys).toEqual([]);
	});
});

describe('repairEpicSentinel', () => {
	test('sentinel without a row → removed', () => {
		const epic = openEpicForTest(dir);
		// The row vanishes on its own (crash between row delete and sentinel
		// delete in another process).
		deleteCoordinationState(dir, EPIC_LIFECYCLE_NAMESPACE, epic.epicKey);
		expect(epicSentinelExists(dir)).toBe(true);
		expect(repairEpicSentinel(dir)).toBe('removed-stale-sentinel');
		expect(epicSentinelExists(dir)).toBe(false);
	});

	test('open row without a sentinel → restored from the row', () => {
		const epic = openEpicForTest(dir);
		fs.unlinkSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH));
		expect(repairEpicSentinel(dir)).toBe('restored-sentinel');
		expect(readEpicSentinel(dir)?.token).toBe(epic.token);
	});

	test('sentinel naming another start → rewritten; consistent → none', () => {
		const epic = openEpicForTest(dir);
		fs.writeFileSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH), 'not json');
		expect(repairEpicSentinel(dir)).toBe('rewrote-mismatched-sentinel');
		expect(readEpicSentinel(dir)?.epicKey).toBe(epic.epicKey);
		expect(repairEpicSentinel(dir)).toBe('none');
	});

	test('a closing row without a sentinel is not resurrected', () => {
		const epic = openEpicForTest(dir);
		markEpicClosing(dir, epic.epicKey, 'abandoned');
		fs.unlinkSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH));
		expect(repairEpicSentinel(dir)).toBe('none');
		expect(epicSentinelExists(dir)).toBe(false);
	});
});

describe('record updates', () => {
	test('wave state and closing are revision-checked updates', () => {
		const epic = openEpicForTest(dir);
		const phases = {
			'1': { status: 'active' as const, reviewRuns: 0, verdicts: [] },
		};
		updateEpicRecord(dir, epic.epicKey, (record) => ({ ...record, phases }));
		const closing = markEpicClosing(dir, epic.epicKey, 'completed');
		expect(closing?.phases).toEqual(phases);
		expect(closing?.status).toBe('closing');
		expect(closing?.closing).toEqual({
			requestedAt: '2026-03-01T00:00:00.000Z',
			outcome: 'completed',
			land: null,
			lastLandingAttempt: null,
		});
		// Idempotent: a second completed request changes nothing.
		expect(markEpicClosing(dir, epic.epicKey, 'completed')).toEqual(closing);
		// C1b: an explicit abandon of a close whose landing never finished
		// upgrades the outcome (it will not land); the request time is kept.
		const abandoned = markEpicClosing(dir, epic.epicKey, 'abandoned');
		expect(abandoned?.closing?.outcome).toBe('abandoned');
		expect(abandoned?.closing?.requestedAt).toBe('2026-03-01T00:00:00.000Z');
		// …and is never downgraded back to completed.
		expect(
			markEpicClosing(dir, epic.epicKey, 'completed')?.closing?.outcome,
		).toBe('abandoned');
		const raw = getCoordinationStateRaw(
			dir,
			EPIC_LIFECYCLE_NAMESPACE,
			epic.epicKey,
		);
		expect(raw?.status).toBe('closing');
	});

	test('updating without a row returns null', () => {
		expect(updateEpicRecord(dir, 'missing-key', (record) => record)).toBeNull();
	});

	test('a pre-C2 row (lastDecision, no wave fields) parses with defaults and drops lastDecision', () => {
		const epic = openEpicForTest(dir);
		const raw = getCoordinationStateRaw(
			dir,
			EPIC_LIFECYCLE_NAMESPACE,
			epic.epicKey,
		);
		const legacy = JSON.parse(raw?.payload ?? '{}') as Record<string, unknown>;
		delete legacy.waves;
		delete legacy.activeWaveSeq;
		delete legacy.tasks;
		delete legacy.phases;
		legacy.lastDecision = null;
		const parsed = parseEpicRecord(JSON.stringify(legacy));
		expect(parsed.waves).toEqual([]);
		expect(parsed.activeWaveSeq).toBeNull();
		expect(parsed.tasks).toEqual({});
		expect(parsed.phases).toEqual({});
		expect('lastDecision' in parsed).toBe(false);
	});
});
