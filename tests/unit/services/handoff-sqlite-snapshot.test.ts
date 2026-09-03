import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { getHandoffData } from '../../../src/services/handoff-service.js';
import { writeSnapshotRows } from '../../../src/session/snapshot-store.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('handoff SQLite snapshot authority (#2481)', () => {
	let directory = '';

	beforeEach(() => {
		directory = canonicalMkdtemp('handoff-sqlite-');
	});

	afterEach(() => {
		closeProjectDb(directory);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('reads the authoritative snapshot when no legacy state.json exists', async () => {
		writeSnapshotRows(directory, {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: { session: 'sqlite-agent' },
			delegationChains: {},
			agentSessions: {},
		});

		const handoff = await getHandoffData(directory);

		expect(handoff.activeAgent).toBe('sqlite-agent');
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'session', 'state.json')),
		).toBe(false);
	});
});
