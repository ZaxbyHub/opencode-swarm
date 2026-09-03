import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	getCoordinationState,
	transitionCoordinationState,
} from '../../../src/db/coordination-store.js';
import {
	closeAllProjectDbs,
	closeProjectDb,
	getProjectDb,
} from '../../../src/db/project-db.js';
import {
	_snapshotStoreInternals,
	claimSnapshotSessionOwnership,
	clearSnapshotSessionOwnerships,
	readSnapshotRows,
	writeSnapshotRows,
} from '../../../src/session/snapshot-store.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { withTimeout } from '../../../src/utils/timeout.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

function waitForFile(filePath: string, timeoutMs = 5_000): void {
	const deadline = performance.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (performance.now() > deadline)
			throw new Error(`Timed out waiting for ${filePath}`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('snapshot-multiprocess-');
});

afterEach(() => {
	closeAllProjectDbs();
	clearSnapshotSessionOwnerships();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLite session snapshot multiprocess coordination', () => {
	test('F10: a local writer cannot overwrite a foreign session owner', () => {
		const sessionId = 'shared-session';
		const foreignPayload = JSON.stringify({
			session: {
				agentName: 'coder',
				lastToolCallTime: 1,
				delegationActive: false,
			},
			ownerToken: 'foreign-owner',
		});
		transitionCoordinationState(tempDir, {
			namespace: 'session.snapshot.agent',
			entityKey: sessionId,
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: foreignPayload,
		});
		claimSnapshotSessionOwnership(sessionId);
		writeSnapshotRows(
			tempDir,
			{
				version: 3,
				writtenAt: 2,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					[sessionId]: {
						agentName: 'architect',
						lastToolCallTime: 2,
						delegationActive: false,
					} as never,
				},
			},
			{ onlyLocallyOwnedSessions: true },
		);
		expect(
			getCoordinationState(tempDir, 'session.snapshot.agent', sessionId)
				?.payload,
		).toBe(foreignPayload);
	});

	test('lets an actual resumed host session take over its durable owner', () => {
		const sessionId = 'resumed-session';
		transitionCoordinationState(tempDir, {
			namespace: 'session.snapshot.agent',
			entityKey: sessionId,
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: JSON.stringify({
				session: { agentName: 'old', lastToolCallTime: 1 },
				ownerToken: 'previous-host',
			}),
		});
		const ownerToken = claimSnapshotSessionOwnership(sessionId, true);
		writeSnapshotRows(
			tempDir,
			{
				version: 3,
				writtenAt: 2,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					[sessionId]: {
						agentName: 'resumed',
						lastToolCallTime: 2,
						delegationActive: false,
					} as never,
				},
			},
			{ onlyLocallyOwnedSessions: true },
		);
		expect(
			JSON.parse(
				getCoordinationState(tempDir, 'session.snapshot.agent', sessionId)!
					.payload,
			),
		).toMatchObject({
			ownerToken,
			session: { agentName: 'resumed' },
		});
	});

	test('retains ownership for every live session until lifecycle cleanup', () => {
		for (let index = 0; index <= 512; index += 1) {
			claimSnapshotSessionOwnership(`live-${index}`);
		}
		writeSnapshotRows(
			tempDir,
			{
				version: 3,
				writtenAt: 1,
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					'live-0': { agentName: 'first' } as never,
					'live-512': { agentName: 'last' } as never,
				},
			},
			{ onlyLocallyOwnedSessions: true },
		);
		expect(readSnapshotRows(tempDir)?.agentSessions['live-0']?.agentName).toBe(
			'first',
		);
		expect(
			readSnapshotRows(tempDir)?.agentSessions['live-512']?.agentName,
		).toBe('last');
	});

	test('F8: reads one committed snapshot while a foreign writer waits after meta', async () => {
		// Before the transaction wrapper, a foreign commit between namespace scans
		// could combine the old meta row with a newer tool row in one read result.
		writeSnapshotRows(tempDir, {
			version: 3,
			writtenAt: 1,
			toolAggregates: { tool: { count: 1 } },
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		});
		const moduleUrl = pathToFileURL(
			path.resolve(process.cwd(), 'src/session/snapshot-store.ts'),
		).href;
		const started = path.join(tempDir, 'foreign-writer-started');
		const script = path.join(tempDir, 'foreign-writer.ts');
		fs.writeFileSync(
			script,
			[
				"import { writeFileSync } from 'node:fs';",
				`import { writeSnapshotRows } from ${JSON.stringify(moduleUrl)};`,
				`writeFileSync(${JSON.stringify(started)}, 'started');`,
				`writeSnapshotRows(${JSON.stringify(tempDir)}, { version: 3, writtenAt: 2, toolAggregates: { tool: { count: 2 } }, activeAgent: {}, delegationChains: {}, agentSessions: {} } as never);`,
			].join('\n'),
		);
		let child: ReturnType<typeof bunSpawn> | undefined;
		const original = _snapshotStoreInternals.afterSnapshotMetaRead;
		_snapshotStoreInternals.afterSnapshotMetaRead = () => {
			child = bunSpawn([process.execPath, script], {
				cwd: tempDir,
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
				timeout: 10_000,
				killProcessTree: true,
			});
			waitForFile(started);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		};
		try {
			expect(readSnapshotRows(tempDir)).toMatchObject({
				writtenAt: 1,
				toolAggregates: { tool: { count: 1 } },
			});
			if (!child) throw new Error('foreign writer was not started');
			expect(await child.exited).toBe(0);
			_snapshotStoreInternals.afterSnapshotMetaRead = original;
			expect(readSnapshotRows(tempDir)).toMatchObject({
				writtenAt: 2,
				toolAggregates: { tool: { count: 2 } },
			});
		} finally {
			_snapshotStoreInternals.afterSnapshotMetaRead = original;
			try {
				child?.kill();
			} catch {
				/* already exited */
			}
		}
	});

	test('preserves independently keyed sessions written by two processes', async () => {
		// Keep this regression focused on concurrent state writes; first-open
		// migration contention has its own project-db test.
		getProjectDb(tempDir);
		closeProjectDb(tempDir);
		const moduleUrl = pathToFileURL(
			path.resolve(process.cwd(), 'src/session/snapshot-store.ts'),
		).href;
		const go = path.join(tempDir, 'go');
		const children = ['session-a', 'session-b'].map((sessionId) => {
			const ready = path.join(tempDir, `${sessionId}.ready`);
			const script = path.join(tempDir, `${sessionId}.ts`);
			fs.writeFileSync(
				script,
				[
					"import { existsSync, writeFileSync } from 'node:fs';",
					`import { writeSnapshotRows } from ${JSON.stringify(moduleUrl)};`,
					'const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
					`writeFileSync(${JSON.stringify(ready)}, 'ready');`,
					`while (!existsSync(${JSON.stringify(go)})) sleep(10);`,
					`writeSnapshotRows(${JSON.stringify(tempDir)}, {`,
					'  version: 3, writtenAt: 1, toolAggregates: {}, activeAgent: {}, delegationChains: {},',
					`  agentSessions: { ${JSON.stringify(sessionId)}: { agentName: 'coder', activeInvocationId: 1 } },`,
					'} as never);',
				].join('\n'),
			);
			return {
				ready,
				process: bunSpawn([process.execPath, script], {
					cwd: tempDir,
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
					timeout: 10_000,
					killProcessTree: true,
				}),
			};
		});
		try {
			for (const child of children) waitForFile(child.ready);
			fs.writeFileSync(go, 'go');
			const results = await withTimeout(
				Promise.all(
					children.map(async ({ process }) => ({
						exitCode: await process.exited,
						stdout: await process.stdout.text(),
						stderr: await process.stderr.text(),
					})),
				),
				15_000,
				new Error('Timed out waiting for snapshot child processes'),
			);
			for (const result of results) {
				if (result.exitCode !== 0)
					throw new Error(`${result.stderr}\n${result.stdout}`);
			}
			const snapshot = readSnapshotRows(tempDir);
			expect(Object.keys(snapshot?.agentSessions ?? {}).sort()).toEqual([
				'session-a',
				'session-b',
			]);
		} finally {
			for (const child of children) {
				try {
					child.process.kill();
				} catch {
					/* already exited */
				}
			}
		}
	});
});
