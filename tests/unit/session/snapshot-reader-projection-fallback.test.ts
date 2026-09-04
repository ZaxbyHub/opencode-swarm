import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { readSnapshot } from '../../../src/session/snapshot-reader.js';
import { SNAPSHOT_PROJECTION_FILE } from '../../../src/session/snapshot-writer.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory: string;

const legacySnapshot = {
	version: 3,
	writtenAt: 1,
	toolAggregates: {},
	activeAgent: {},
	delegationChains: {},
	agentSessions: {},
};

beforeEach(() => {
	directory = canonicalMkdtemp('snapshot-projection-fallback-');
	mkdirSync(path.join(directory, '.swarm', 'session'), { recursive: true });
	writeFileSync(
		path.join(directory, '.swarm', 'session', 'state.json'),
		JSON.stringify(legacySnapshot),
	);
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('snapshot reader projection fallback', () => {
	test('falls back when the projection is empty', async () => {
		writeFileSync(
			path.join(directory, '.swarm', SNAPSHOT_PROJECTION_FILE),
			'\n',
		);

		expect(await readSnapshot(directory)).toEqual(legacySnapshot);
	});

	test('falls back when the projection has an unsupported version', async () => {
		const projectionPath = path.join(
			directory,
			'.swarm',
			SNAPSHOT_PROJECTION_FILE,
		);
		writeFileSync(projectionPath, JSON.stringify({ version: 99 }));

		expect(await readSnapshot(directory)).toEqual(legacySnapshot);
		expect(existsSync(`${projectionPath}.quarantine`)).toBe(true);
	});
});
