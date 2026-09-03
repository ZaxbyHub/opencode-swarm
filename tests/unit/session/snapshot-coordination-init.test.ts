import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionCoordinationState } from '../../../src/db/coordination-store.js';
import {
	closeAllProjectDbs,
	projectDbExists,
} from '../../../src/db/project-db.js';
import {
	_snapshotCoordinationInternals,
	beginSnapshotCoordinationReset,
	ensureSnapshotCoordinationReady,
	retrySnapshotCoordinationInitialization,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import {
	clearSnapshotRows,
	deleteSnapshotSessionRows,
	importSnapshotRowsOnce,
	readSnapshotRows,
	writeSnapshotRows,
} from '../../../src/session/snapshot-store.js';
import { SNAPSHOT_PROJECTION_FILE } from '../../../src/session/snapshot-writer.js';
import {
	endAgentSession,
	ensureAgentSession,
	swarmState,
	sweepStaleSessions,
} from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
const originalInitialize = _snapshotCoordinationInternals.initialize;
const originalRenameLegacySnapshot =
	_snapshotCoordinationInternals.renameLegacySnapshot;
const originalTimeout = _snapshotCoordinationInternals.timeoutMs;

beforeEach(() => {
	tempDir = canonicalMkdtemp('snapshot-init-');
	_snapshotCoordinationInternals.entries.clear();
});

afterEach(() => {
	_snapshotCoordinationInternals.initialize = originalInitialize;
	_snapshotCoordinationInternals.renameLegacySnapshot =
		originalRenameLegacySnapshot;
	_snapshotCoordinationInternals.timeoutMs = originalTimeout;
	_snapshotCoordinationInternals.entries.clear();
	closeAllProjectDbs();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('snapshot coordination post-resolution initialization', () => {
	test('deletes only the terminal session rows without erasing siblings', () => {
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: { one: 'coder', two: 'reviewer' },
			delegationChains: { one: [], two: [] },
			agentSessions: {},
		});

		expect(deleteSnapshotSessionRows(tempDir, 'one')).toBe(2);
		const remaining = readSnapshotRows(tempDir)!;
		expect(remaining.activeAgent).toEqual({ two: 'reviewer' });
		expect(remaining.delegationChains).toEqual({ two: [] });

		// A late whole-process snapshot cannot resurrect the deleted session ID.
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 2,
			toolAggregates: {},
			activeAgent: { one: 'stale-coder' },
			delegationChains: { one: [] },
			agentSessions: {},
		});
		expect(readSnapshotRows(tempDir)!.activeAgent.one).toBeUndefined();
	});

	test('session rows remain writable when activeInvocationId drops after an earlier invocation', () => {
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				one: {
					agentName: 'coder',
					activeInvocationId: 5,
				} as never,
			},
		});

		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 2,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				one: {
					agentName: 'coder',
					activeInvocationId: 0,
				} as never,
			},
		});

		expect(
			readSnapshotRows(tempDir)?.agentSessions.one?.activeInvocationId,
		).toBe(0);
	});

	test('endAgentSession tombstones its durable snapshot rows before RAM cleanup', () => {
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: { one: 'coder' },
			delegationChains: { one: [] },
			agentSessions: {
				one: { agentName: 'coder' } as never,
			},
		});

		endAgentSession('one', tempDir);

		const snapshot = readSnapshotRows(tempDir)!;
		expect(snapshot.activeAgent.one).toBeUndefined();
		expect(snapshot.delegationChains.one).toBeUndefined();
		expect(snapshot.agentSessions.one).toBeUndefined();
	});

	test('stale-session eviction tombstones durable rows before RAM cleanup', () => {
		const stale = ensureAgentSession('stale', 'coder');
		stale.lastToolCallTime = 1;
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: { stale: 'coder' },
			delegationChains: { stale: [] },
			agentSessions: { stale: { agentName: 'coder' } as never },
		});

		expect(sweepStaleSessions(10, 100, tempDir)).toEqual(['stale']);
		expect(swarmState.agentSessions.has('stale')).toBe(false);
		expect(readSnapshotRows(tempDir)!.activeAgent.stale).toBeUndefined();
		expect(readSnapshotRows(tempDir)!.delegationChains.stale).toBeUndefined();
		expect(readSnapshotRows(tempDir)!.agentSessions.stale).toBeUndefined();
	});

	test('fails closed on malformed durable snapshot payloads', () => {
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		});
		transitionCoordinationState(tempDir, {
			namespace: 'session.snapshot.active-agent',
			entityKey: 'damaged',
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: '42',
		});

		expect(() => readSnapshotRows(tempDir)).toThrow(
			/invalid SQLite snapshot active-agent payload/i,
		);
	});

	test(
		'reads and clears every snapshot row beyond the former five-thousand-row cap',
		() => {
			// Prior code used listCoordinationStates' 5,000-row default, silently
			// dropping session rows during rehydrate and leaving one on reset.
			const agentSessions: Record<string, never> = {};
			for (let index = 0; index < 5_001; index += 1) {
				agentSessions[`session-${index.toString().padStart(5, '0')}`] = {
					agentName: 'coder',
				} as never;
			}
			writeSnapshotRows(tempDir, {
				version: 3,
				writtenAt: 1,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions,
			});

			expect(
				Object.keys(readSnapshotRows(tempDir)!.agentSessions),
			).toHaveLength(5_001);
			expect(clearSnapshotRows(tempDir)).toBe(5_002);
			expect(readSnapshotRows(tempDir)).toBeNull();
		},
		{ timeout: 30_000 },
	);

	test('reset clears snapshot import markers so a restored legacy file can re-import', () => {
		const snapshot = {
			version: 3,
			writtenAt: 1,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};
		expect(
			importSnapshotRowsOnce(
				tempDir,
				snapshot,
				'digest-1',
				'session/state.json',
			),
		).toBe('imported');
		expect(clearSnapshotRows(tempDir)).toBe(1);
		expect(
			importSnapshotRowsOnce(
				tempDir,
				snapshot,
				'digest-1',
				'session/state.json',
			),
		).toBe('imported');
	});

	test('transactionally imports and cold-archives a valid legacy snapshot', async () => {
		const sessionDir = path.join(tempDir, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, 'state.json'),
			JSON.stringify({
				version: 3,
				writtenAt: 1,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {},
			}),
		);
		expect(projectDbExists(tempDir)).toBe(false);

		await startSnapshotCoordinationInitialization(tempDir);

		expect(projectDbExists(tempDir)).toBe(true);
		expect(fs.existsSync(path.join(sessionDir, 'state.json'))).toBe(false);
		expect(fs.existsSync(path.join(sessionDir, 'state.json.imported'))).toBe(
			true,
		);
		expect(
			fs.existsSync(path.join(tempDir, '.swarm', SNAPSHOT_PROJECTION_FILE)),
		).toBe(true);
	});

	test('fails closed without archiving a corrupt legacy authority', async () => {
		const sessionDir = path.join(tempDir, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		const legacyPath = path.join(sessionDir, 'state.json');
		fs.writeFileSync(legacyPath, '{ corrupt');

		await expect(
			startSnapshotCoordinationInitialization(tempDir),
		).rejects.toThrow();

		expect(fs.existsSync(legacyPath)).toBe(true);
		expect(fs.existsSync(`${legacyPath}.imported`)).toBe(false);
	});

	test('repairs a matching post-commit archive without overwriting an existing cold archive', async () => {
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 2,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		});
		const sessionDir = path.join(tempDir, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		const legacyPath = path.join(sessionDir, 'state.json');
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({
				version: 3,
				writtenAt: 2,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {},
			}),
		);
		fs.writeFileSync(`${legacyPath}.imported`, 'original archive');

		await startSnapshotCoordinationInitialization(tempDir);

		expect(fs.existsSync(legacyPath)).toBe(false);
		expect(fs.readFileSync(`${legacyPath}.imported`, 'utf8')).toBe(
			'original archive',
		);
		expect(
			fs
				.readdirSync(sessionDir)
				.filter((name) => name.startsWith('state.json.imported')),
		).toHaveLength(2);
	});

	test('preserves a divergent legacy snapshot for explicit recovery', async () => {
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 2,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		});
		const sessionDir = path.join(tempDir, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		const legacyPath = path.join(sessionDir, 'state.json');
		fs.writeFileSync(legacyPath, '{"legacy":"newer-peer-state"}');
		fs.writeFileSync(`${legacyPath}.imported`, 'original archive');

		await startSnapshotCoordinationInitialization(tempDir);

		expect(fs.readFileSync(legacyPath, 'utf8')).toBe(
			'{"legacy":"newer-peer-state"}',
		);
		expect(fs.readFileSync(`${legacyPath}.imported`, 'utf8')).toBe(
			'original archive',
		);
	});

	test('keeps committed SQLite authority ready when Windows shadow archival stays busy', async () => {
		const sessionDir = path.join(tempDir, '.swarm', 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
		const legacyPath = path.join(sessionDir, 'state.json');
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({
				version: 3,
				writtenAt: 1,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {},
			}),
		);
		let attempts = 0;
		_snapshotCoordinationInternals.renameLegacySnapshot = () => {
			attempts += 1;
			const error = new Error('sharing violation') as NodeJS.ErrnoException;
			error.code = 'EBUSY';
			throw error;
		};

		await expect(
			startSnapshotCoordinationInitialization(tempDir),
		).resolves.toBeUndefined();

		expect(attempts).toBe(3);
		expect(readSnapshotRows(tempDir)).not.toBeNull();
		expect(fs.existsSync(legacyPath)).toBe(true);
	});

	test('refuses recovery while a timed-out underlying attempt is unsettled', async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		_snapshotCoordinationInternals.timeoutMs = 5;
		_snapshotCoordinationInternals.initialize = async () => {
			calls += 1;
			if (calls === 1) await blocked;
		};
		const underlying = startSnapshotCoordinationInitialization(tempDir);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(() => retrySnapshotCoordinationInitialization(tempDir)).toThrow(
			/unsettled/i,
		);
		expect(calls).toBe(1);

		release();
		await underlying;
		await retrySnapshotCoordinationInitialization(tempDir);
		expect(calls).toBe(2);
	});

	test('blocks fresh initialization until a reset guard releases it', async () => {
		const guard = await beginSnapshotCoordinationReset(tempDir);
		await expect(ensureSnapshotCoordinationReady(tempDir)).rejects.toThrow(
			/closing for reset-session/i,
		);
		guard.release();
		await expect(
			ensureSnapshotCoordinationReady(tempDir),
		).resolves.toBeUndefined();
	});
});
