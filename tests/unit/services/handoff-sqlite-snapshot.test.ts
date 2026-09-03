import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	_internals,
	getHandoffData,
} from '../../../src/services/handoff-service.js';
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

	test('falls back to the legacy projection when SQLite snapshot reading fails', async () => {
		const sessionDir = path.join(directory, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, 'state.json'),
			JSON.stringify({
				version: 3,
				writtenAt: 1,
				toolAggregates: {},
				activeAgent: { session: 'legacy-agent' },
				delegationChains: {},
				agentSessions: {},
			}),
		);
		const originalReadSnapshotRows = _internals.readSnapshotRows;
		_internals.readSnapshotRows = () => {
			throw new Error('unsupported SQLite snapshot schema');
		};
		try {
			const handoff = await getHandoffData(directory);
			expect(handoff.activeAgent).toBe('legacy-agent');
		} finally {
			_internals.readSnapshotRows = originalReadSnapshotRows;
		}
	});
});
