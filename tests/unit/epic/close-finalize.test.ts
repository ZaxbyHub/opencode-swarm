/**
 * `/swarm close` finalization of an open epic (finalizeOpenEpicOnSwarmClose):
 * Epic-gated on the config close already loaded (config off ⇒ no I/O, null —
 * leftover state is left for `/swarm epic close --abandon`), sentinel first,
 * and a lost sentinel with a surviving row is still finalized.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	closeEpic,
	finalizeOpenEpicOnSwarmClose,
} from '../../../src/epic/close';
import {
	EPIC_SENTINEL_RELATIVE_PATH,
	epicSentinelExists,
	inspectEpic,
} from '../../../src/epic/lifecycle';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject } from './start-fixture';

const EPIC_ON = {
	epic: { mode: { enabled: true } },
};
let dir: string;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-05-02T08:00:00.000Z' });
	dir = await createStartProject('epic-close-final-', { git: false });
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

function priorReports(): string[] {
	const reportDir = path.join(dir, '.swarm', 'epic-prior', 'reports');
	return fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : [];
}

describe('finalizeOpenEpicOnSwarmClose', () => {
	test('no sentinel and no row ⇒ null and nothing created', async () => {
		expect(
			await finalizeOpenEpicOnSwarmClose(dir, EPIC_ON as never),
		).toBeNull();
		expect(fs.existsSync(path.join(dir, '.swarm', 'epic-prior'))).toBe(false);
	});

	test('open epic ⇒ abandoned-by-swarm-close with a kept report', async () => {
		const epic = openEpicForTest(dir);
		const line = await finalizeOpenEpicOnSwarmClose(dir, EPIC_ON as never);
		expect(line).toContain(
			`Open epic ${epic.epicKey} was closed as abandoned-by-swarm-close`,
		);
		expect(priorReports()).toHaveLength(1);
		expect(epicSentinelExists(dir)).toBe(false);
	});

	test('Epic config off ⇒ leftover epic untouched (strict non-Epic parity); epic close --abandon still works', async () => {
		openEpicForTest(dir);
		expect(await finalizeOpenEpicOnSwarmClose(dir, {})).toBeNull();
		expect(await finalizeOpenEpicOnSwarmClose(dir, undefined)).toBeNull();
		expect(epicSentinelExists(dir)).toBe(true);
		expect(inspectEpic(dir).rowKeys).toHaveLength(1);
		expect(priorReports()).toEqual([]);
		const closed = await closeEpic({ directory: dir, abandon: true });
		expect(closed.status).toBe('closed');
	});

	test('sentinel lost but the row survives ⇒ still finalized', async () => {
		openEpicForTest(dir);
		fs.unlinkSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH));
		const line = await finalizeOpenEpicOnSwarmClose(dir, EPIC_ON as never);
		expect(line).toContain('abandoned-by-swarm-close');
		expect(inspectEpic(dir).rowKeys).toEqual([]);
		expect(priorReports()).toHaveLength(1);
	});
});
