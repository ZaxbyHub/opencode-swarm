import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	closeAllProjectDbs,
	projectDbExists,
} from '../../../src/db/project-db.js';
import {
	_snapshotCoordinationInternals,
	getSnapshotCoordinationStatus,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import { readSnapshot } from '../../../src/session/snapshot-reader.js';
import { writeSnapshotRows } from '../../../src/session/snapshot-store.js';
import { SNAPSHOT_PROJECTION_FILE } from '../../../src/session/snapshot-writer.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const baseSnapshot = {
	version: 3 as const,
	writtenAt: 1,
	toolAggregates: {},
	activeAgent: {},
	delegationChains: {},
	agentSessions: {},
};

let directory: string;
const originalWriteProjection = _snapshotCoordinationInternals.writeProjection;

beforeEach(() => {
	directory = canonicalMkdtemp('snapshot-coordination-source-');
	_snapshotCoordinationInternals.entries.clear();
});

afterEach(() => {
	_snapshotCoordinationInternals.writeProjection = originalWriteProjection;
	_snapshotCoordinationInternals.entries.clear();
	closeAllProjectDbs();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('snapshot coordination source and projection boundaries', () => {
	test('uses the projection when legacy and projection snapshots diverge', async () => {
		const sessionDir = path.join(directory, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		const projection = { ...baseSnapshot, writtenAt: 2 };
		fs.writeFileSync(
			path.join(sessionDir, 'state.json'),
			JSON.stringify({
				...baseSnapshot,
				writtenAt: 1,
				activeAgent: { legacy: 'coder' },
			}),
		);
		fs.writeFileSync(
			path.join(directory, '.swarm', SNAPSHOT_PROJECTION_FILE),
			JSON.stringify(projection),
		);

		expect(await readSnapshot(directory)).toEqual(projection);
		await startSnapshotCoordinationInitialization(directory);

		expect(projectDbExists(directory)).toBe(true);
		expect((await readSnapshot(directory))?.writtenAt).toBe(2);
	});

	test('keeps SQLite readiness successful when projection writing fails', async () => {
		writeSnapshotRows(directory, baseSnapshot);
		_snapshotCoordinationInternals.writeProjection = async () => {
			throw new Error('projection unavailable');
		};

		await expect(
			startSnapshotCoordinationInitialization(directory),
		).resolves.toBeUndefined();
		expect(getSnapshotCoordinationStatus(directory).state).toBe('succeeded');
	});
});
