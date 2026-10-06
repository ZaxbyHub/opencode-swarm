/**
 * Epic v2 lifecycle probe (`src/epic/lifecycle.ts`): sentinel-first,
 * no memo, no writes; orphan detection; corrupt-state fail-closed.
 *
 * Real temp projects + the real coordination store (swarm.db). The only
 * spies are on `getProjectDb` (to prove the probe never opens the DB when
 * the sentinel is absent, with a positive control) and on the logger.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionCoordinationState } from '../../../src/db/coordination-store';
import * as projectDb from '../../../src/db/project-db';
import {
	_internals,
	EPIC_LIFECYCLE_NAMESPACE,
	EPIC_SENTINEL_RELATIVE_PATH,
	epicSentinelExists,
	getOpenEpic,
	inspectEpic,
	isEpicOpenForProject,
	updateEpicRecord,
} from '../../../src/epic/lifecycle';
import * as logger from '../../../src/utils/logger';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const realInternals = { ..._internals };

function writePlan(title: string): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({ swarm: 'probe-swarm', title, phases: [] }),
	);
}

function writeConfig(enabled: boolean): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			epic: { mode: { enabled } },
		}),
	);
}

beforeEach(() => {
	dir = canonicalMkdtemp('epic-probe-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	writePlan('Probe Plan');
	writeConfig(true);
	_internals.warnedDirectories.clear();
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	projectDb.closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('sentinel-first probe', () => {
	test('EPIC_SENTINEL_RELATIVE_PATH is .swarm/epic/epic.json', () => {
		expect(EPIC_SENTINEL_RELATIVE_PATH).toBe(
			path.join('.swarm', 'epic', 'epic.json'),
		);
	});

	test('no sentinel ⇒ false without opening the DB, reading config, or writing', () => {
		// A real swarm.db exists (another feature created it) — still untouched.
		transitionCoordinationState(dir, {
			namespace: 'other.feature',
			entityKey: 'k',
			expectedRevision: null,
			generation: 1,
			status: 'x',
			payload: '{}',
		});
		projectDb.closeAllProjectDbs();
		const dbSpy = spyOn(projectDb, 'getProjectDb');
		let configReads = 0;
		_internals.isEpicModeConfigEnabledForDirectory = () => {
			configReads += 1;
			return true;
		};
		const before = fs.readdirSync(path.join(dir, '.swarm')).sort();
		try {
			expect(epicSentinelExists(dir)).toBe(false);
			expect(isEpicOpenForProject(dir)).toBe(false);
			expect(getOpenEpic(dir)).toBeNull();
			expect(dbSpy).not.toHaveBeenCalled();
			expect(configReads).toBe(0);
			expect(fs.readdirSync(path.join(dir, '.swarm')).sort()).toEqual(before);

			// Positive control: with an open epic the same probe DOES reach the
			// DB and the config — proving the spy observes the probe's path.
			dbSpy.mockRestore();
			openEpicForTest(dir);
			projectDb.closeAllProjectDbs();
			const controlSpy = spyOn(projectDb, 'getProjectDb');
			try {
				expect(isEpicOpenForProject(dir)).toBe(true);
				expect(controlSpy).toHaveBeenCalled();
				expect(configReads).toBe(1);
			} finally {
				controlSpy.mockRestore();
			}
		} finally {
			dbSpy.mockRestore();
		}
	});

	test('a raw `..` segment never probes an ancestor', () => {
		openEpicForTest(dir);
		expect(isEpicOpenForProject(`${dir}/sub/..`)).toBe(false);
		expect(isEpicOpenForProject(dir)).toBe(true);
	});

	test('open epic ⇒ true; record matches; no memo (closing flips it at once)', () => {
		const epic = openEpicForTest(dir);
		expect(isEpicOpenForProject(dir)).toBe(true);
		expect(getOpenEpic(dir)?.epicKey).toBe(epic.epicKey);
		updateEpicRecord(dir, epic.epicKey, (record) => ({
			...record,
			status: 'closing',
		}));
		expect(isEpicOpenForProject(dir)).toBe(false);
	});

	test('config gate closed ⇒ false (row and sentinel untouched)', () => {
		openEpicForTest(dir);
		writeConfig(false);
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(epicSentinelExists(dir)).toBe(true);
		expect(inspectEpic(dir).record).not.toBeNull();
	});

	test('sentinel without a row ⇒ false', () => {
		fs.mkdirSync(path.join(dir, '.swarm', 'epic'), { recursive: true });
		fs.writeFileSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH), '{}');
		expect(isEpicOpenForProject(dir)).toBe(false);
	});
});

describe('orphan detection', () => {
	test('plan renamed ⇒ orphaned (probe false, inspection explains)', () => {
		openEpicForTest(dir);
		writePlan('Renamed Plan');
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(inspectEpic(dir).orphanReason).toBe('plan-renamed-or-replaced');
	});

	test('plan ledger re-rooted ⇒ orphaned', () => {
		const ledger = path.join(dir, '.swarm', 'plan-ledger.jsonl');
		fs.writeFileSync(ledger, '{"seq":1,"root":"A"}\n');
		openEpicForTest(dir);
		expect(isEpicOpenForProject(dir)).toBe(true);
		// Appends keep the root line: still open.
		fs.appendFileSync(ledger, '{"seq":2}\n');
		expect(isEpicOpenForProject(dir)).toBe(true);
		fs.writeFileSync(ledger, '{"seq":1,"root":"B"}\n');
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(inspectEpic(dir).orphanReason).toBe('plan-ledger-replaced');
	});

	test('plan missing ⇒ orphaned', () => {
		openEpicForTest(dir);
		fs.rmSync(path.join(dir, '.swarm', 'plan.json'));
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(inspectEpic(dir).orphanReason).toBe('plan-missing');
	});

	test('an explicit plan argument is used instead of plan.json', () => {
		openEpicForTest(dir);
		expect(
			getOpenEpic(dir, { swarm: 'probe-swarm', title: 'Other' }),
		).toBeNull();
		expect(
			getOpenEpic(dir, { swarm: 'probe-swarm', title: 'Probe Plan' }),
		).not.toBeNull();
	});
});

describe('corrupt state fails closed', () => {
	test('schema-invalid row ⇒ false + ONE critical warning; getOpenEpic throws', () => {
		const epic = openEpicForTest(dir);
		updateEpicRecord(dir, epic.epicKey, (record) => ({
			...record,
			status: 'bogus' as never,
		}));
		const warn = spyOn(logger, 'criticalWarn').mockImplementation(() => {});
		try {
			expect(isEpicOpenForProject(dir)).toBe(false);
			expect(isEpicOpenForProject(dir)).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain(
				'/swarm epic close --abandon',
			);
			expect(() => getOpenEpic(dir)).toThrow('unexpected shape');
			expect(inspectEpic(dir).unreadable).toContain('unexpected shape');
		} finally {
			warn.mockRestore();
		}
	});

	test('two lifecycle rows ⇒ unreadable', () => {
		openEpicForTest(dir);
		transitionCoordinationState(dir, {
			namespace: EPIC_LIFECYCLE_NAMESPACE,
			entityKey: 'second',
			expectedRevision: null,
			generation: 1,
			status: 'open',
			payload: '{}',
		});
		expect(() => getOpenEpic(dir)).toThrow('multiple Epic lifecycle rows');
		expect(inspectEpic(dir).unreadable).toContain('multiple');
	});
});
