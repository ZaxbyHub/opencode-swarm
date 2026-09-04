import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { _snapshotCoordinationInternals } from '../../../src/session/snapshot-coordination-init.js';
import type { SnapshotData } from '../../../src/session/snapshot-writer.js';
import { SNAPSHOT_PROJECTION_FILE } from '../../../src/session/snapshot-writer.js';
import { resetSwarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('/swarm recover --coordination (#2481)', () => {
	let directory = '';
	const originalInitialize = _snapshotCoordinationInternals.initialize;

	beforeEach(() => {
		directory = canonicalMkdtemp('recover-coordination-');
		_snapshotCoordinationInternals.entries.clear();
		resetSwarmState();
	});

	afterEach(() => {
		_snapshotCoordinationInternals.initialize = originalInitialize;
		_snapshotCoordinationInternals.entries.clear();
		resetSwarmState();
		closeAllProjectDbs();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('imports legacy coordination durably and archives its source', async () => {
		const sessionDir = path.join(directory, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		const legacyPath = path.join(sessionDir, 'state.json');
		const legacySnapshot: SnapshotData = {
			version: 3,
			writtenAt: 1_700_000_000_000,
			toolAggregates: {
				read: {
					tool: 'read',
					count: 2,
					successCount: 2,
					failureCount: 0,
					totalDuration: 25,
				},
			},
			activeAgent: { 'legacy-session': 'coder' },
			delegationChains: {
				'legacy-session': [
					{ from: 'architect', to: 'coder', timestamp: 1_700_000_000_000 },
				],
			},
			agentSessions: {
				// The strict import boundary needs only these required session fields;
				// the reader supplies migration-safe defaults for older snapshots.
				'legacy-session': {
					agentName: 'coder',
					lastToolCallTime: 1_700_000_000_000,
					lastAgentEventTime: 1_700_000_000_000,
					delegationActive: true,
					currentTaskId: 'task-1',
					gateLog: { 'task-1': ['pre_check'] },
				} as SnapshotData['agentSessions'][string],
			},
		};
		fs.writeFileSync(legacyPath, JSON.stringify(legacySnapshot));

		const output = await handleRecoverCommand(directory, ['--coordination']);

		expect(output).toContain('completed successfully');
		expect(fs.existsSync(path.join(directory, '.swarm', 'swarm.db'))).toBe(
			true,
		);
		const db = getProjectDb(directory);
		const durableRows = db
			.query<{ namespace: string; entity_key: string; status: string }, []>(
				'SELECT namespace, entity_key, status FROM coordination_state ORDER BY namespace, entity_key',
			)
			.all();
		expect(durableRows).toEqual([
			{
				namespace: 'session.snapshot.active-agent',
				entity_key: 'legacy-session',
				status: 'active',
			},
			{
				namespace: 'session.snapshot.agent',
				entity_key: 'legacy-session',
				status: 'active',
			},
			{
				namespace: 'session.snapshot.delegation-chain',
				entity_key: 'legacy-session',
				status: 'active',
			},
			{
				namespace: 'session.snapshot.meta',
				entity_key: 'project',
				status: 'active',
			},
			{
				namespace: 'session.snapshot.tool',
				entity_key: 'read',
				status: 'active',
			},
		]);
		expect(
			db
				.query<{ source: string; row_count: number }, [string]>(
					'SELECT source, row_count FROM coordination_import WHERE source = ?',
				)
				.get('session/state.json'),
		).toEqual({ source: 'session/state.json', row_count: 1 });

		const projectionPath = path.join(
			directory,
			'.swarm',
			SNAPSHOT_PROJECTION_FILE,
		);
		expect(fs.existsSync(projectionPath)).toBe(true);
		const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
		expect(projection.toolAggregates.read.count).toBe(2);
		expect(projection.activeAgent).toEqual({ 'legacy-session': 'coder' });
		expect(projection.agentSessions['legacy-session'].currentTaskId).toBe(
			'task-1',
		);
		expect(fs.existsSync(legacyPath)).toBe(false);
		expect(fs.existsSync(`${legacyPath}.imported`)).toBe(true);
		expect(
			JSON.parse(fs.readFileSync(`${legacyPath}.imported`, 'utf8')),
		).toEqual(legacySnapshot);
	});

	test('runs a fresh bounded coordination initialization attempt', async () => {
		let calls = 0;
		_snapshotCoordinationInternals.initialize = async () => {
			calls += 1;
		};

		const output = await handleRecoverCommand(directory, ['--coordination']);

		expect(calls).toBe(1);
		expect(output).toContain('SQLite Coordination Recovery');
		expect(output).toContain('completed successfully');
	});

	test('reports a failed recovery without falling through to WAL repair', async () => {
		_snapshotCoordinationInternals.initialize = async () => {
			throw new Error('import corrupt');
		};

		const output = await handleRecoverCommand(directory, ['--coordination']);

		expect(output).toContain('Recovery refused or failed');
		expect(output).toContain('import corrupt');
		expect(output).not.toContain('Coder Settlement Recovery');
	});
});
