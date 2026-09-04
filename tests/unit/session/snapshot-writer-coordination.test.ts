import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	claimSnapshotSessionOwnership,
	clearSnapshotSessionOwnerships,
} from '../../../src/session/snapshot-store.js';
import {
	flushPendingSnapshot,
	SNAPSHOT_PROJECTION_FILE,
	type SnapshotData,
	writeSnapshot,
} from '../../../src/session/snapshot-writer.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('snapshot writer session ownership', () => {
	let directory = '';

	afterEach(async () => {
		if (directory) await flushPendingSnapshot(directory).catch(() => {});
		closeAllProjectDbs();
		clearSnapshotSessionOwnerships();
		if (directory) fs.rmSync(directory, { recursive: true, force: true });
		directory = '';
	});

	test('writes delegation chains only for the local session owner', async () => {
		directory = canonicalMkdtemp('snapshot-writer-coordination-');
		claimSnapshotSessionOwnership('session-1');

		await writeSnapshot(directory, {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map([
				[
					'session-1',
					[
						{ from: 'architect', to: 'coder', timestamp: 1 },
						{ from: 'coder', to: 'reviewer', timestamp: 2 },
					],
				],
			]),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		});

		const content = await Bun.file(
			path.join(directory, '.swarm', SNAPSHOT_PROJECTION_FILE),
		).text();
		const snapshot = JSON.parse(content) as SnapshotData;
		expect(snapshot.delegationChains['session-1']).toEqual([
			{ from: 'architect', to: 'coder', timestamp: 1 },
			{ from: 'coder', to: 'reviewer', timestamp: 2 },
		]);
	});
});
