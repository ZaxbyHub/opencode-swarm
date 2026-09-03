import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listCoordinationStates } from '../../../../src/db/coordination-store.js';
import { closeAllProjectDbs } from '../../../../src/db/project-db.js';
import {
	emptyPersisted,
	emptyRunState,
	loadLeanTurboRunState,
	repairStateUnreadable,
	saveLeanTurboRunState,
	writePersisted,
} from '../../../../src/turbo/lean/state';
import { bunSpawn } from '../../../../src/utils/bun-compat.js';
import { withTimeout } from '../../../../src/utils/timeout.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

const COORDINATION_NAMESPACE = 'turbo.lean.session';

let dir: string;

function waitForFile(filePath: string): void {
	const deadline = performance.now() + 5_000;
	while (!fs.existsSync(filePath)) {
		if (performance.now() > deadline) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
}

beforeEach(() => {
	dir = canonicalMkdtemp('lean-state-sqlite-');
	repairStateUnreadable(dir);
});

afterEach(() => {
	repairStateUnreadable(dir);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('lean state SQLite authority', () => {
	test('writePersisted stores one coordination row per session and refreshes the projection', () => {
		const persisted = emptyPersisted();
		const sessionA = emptyRunState('sess-a', 2);
		sessionA.status = 'running';
		const sessionB = emptyRunState('sess-b', 4);
		sessionB.status = 'paused';
		persisted.sessions[sessionA.sessionID] = sessionA;
		persisted.sessions[sessionB.sessionID] = sessionB;

		writePersisted(dir, persisted);

		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.entityKey).sort()).toEqual([
			'sess-a',
			'sess-b',
		]);

		const projected = JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', 'turbo-state.json'), 'utf-8'),
		);
		expect(Object.keys(projected.sessions).sort()).toEqual([
			'sess-a',
			'sess-b',
		]);
		expect(projected.sessions['sess-a'].status).toBe('running');
		expect(projected.sessions['sess-b'].status).toBe('paused');
	});

	test('loading a legacy JSON file imports once into SQLite and archives the source file', () => {
		const legacy = emptyPersisted();
		const state = emptyRunState('legacy-session', 3);
		state.status = 'running';
		legacy.sessions[state.sessionID] = state;

		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'turbo-state.json'),
			`${JSON.stringify(legacy, null, 2)}\n`,
			'utf-8',
		);

		const loaded = loadLeanTurboRunState(dir, 'legacy-session');

		expect(loaded?.status).toBe('running');
		expect(listCoordinationStates(dir, COORDINATION_NAMESPACE)).toHaveLength(1);
		expect(fs.existsSync(path.join(dir, '.swarm', 'turbo-state.json'))).toBe(
			true,
		);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'turbo-state.json.imported')),
		).toBe(true);
	});

	test('repairs a mismatched projection without overwriting the cold archive', () => {
		const state = emptyRunState('archive-collision', 2);
		saveLeanTurboRunState(dir, state);
		const filePath = path.join(dir, '.swarm', 'turbo-state.json');
		const archivePath = `${filePath}.imported`;
		fs.writeFileSync(archivePath, 'original archive', 'utf-8');
		fs.writeFileSync(
			filePath,
			`${JSON.stringify(emptyPersisted())}\n`,
			'utf-8',
		);

		expect(loadLeanTurboRunState(dir, state.sessionID)?.sessionID).toBe(
			state.sessionID,
		);
		expect(fs.readFileSync(archivePath, 'utf-8')).toBe('original archive');
		expect(fs.existsSync(`${archivePath}.1`)).toBe(true);
		expect(
			JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions[state.sessionID],
		).toBeDefined();
	});

	test('writePersisted deletes rows for sessions removed from the desired state', () => {
		const persisted = emptyPersisted();
		const keep = emptyRunState('keep-session', 2);
		const drop = emptyRunState('drop-session', 2);
		persisted.sessions[keep.sessionID] = keep;
		persisted.sessions[drop.sessionID] = drop;
		writePersisted(dir, persisted);

		delete persisted.sessions[drop.sessionID];
		writePersisted(dir, persisted);

		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.entityKey).toBe('keep-session');
	});

	test('saving the same session twice advances revision/generation without duplicating rows', () => {
		const state = emptyRunState('dup-session', 2);
		saveLeanTurboRunState(dir, state);
		const first = listCoordinationStates(dir, COORDINATION_NAMESPACE)[0];

		state.status = 'paused';
		state.pauseReason = 'second write';
		saveLeanTurboRunState(dir, state);
		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		const second = rows[0];

		expect(rows).toHaveLength(1);
		expect(second?.revision).toBeGreaterThan(first?.revision ?? 0);
		expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);
		expect(loadLeanTurboRunState(dir, 'dup-session')?.pauseReason).toBe(
			'second write',
		);
	});

	test('two processes saving disjoint sessions do not erase each other', async () => {
		const stateModuleUrl = pathToFileURL(
			path.resolve(process.cwd(), 'src/turbo/lean/state.ts'),
		).href;
		const projectDbModuleUrl = pathToFileURL(
			path.resolve(process.cwd(), 'src/db/project-db.ts'),
		).href;
		const go = path.join(dir, 'go');
		const children = [
			{ id: 'a', sessionID: 'session-a', status: 'running' },
			{ id: 'b', sessionID: 'session-b', status: 'paused' },
		].map(({ id, sessionID, status }) => {
			const ready = path.join(dir, `${id}.ready`);
			const script = path.join(dir, `${id}.ts`);
			fs.writeFileSync(
				script,
				[
					"import { existsSync, writeFileSync } from 'node:fs';",
					`import { closeAllProjectDbs } from ${JSON.stringify(projectDbModuleUrl)};`,
					`import { emptyCounters, saveLeanTurboRunState } from ${JSON.stringify(stateModuleUrl)};`,
					'const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
					'const [directory, readyFile, goFile, currentSessionId, currentStatus] = process.argv.slice(2);',
					'writeFileSync(readyFile, "ready");',
					'while (!existsSync(goFile)) sleep(10);',
					'const runState = {',
					'  status: currentStatus,',
					'  sessionID: currentSessionId,',
					'  strategy: "lean",',
					'  maxParallelCoders: 2,',
					'  lanes: [],',
					'  degradedTasks: [],',
					'  serializedTasks: [],',
					'  counters: emptyCounters(),',
					'};',
					'saveLeanTurboRunState(directory, runState);',
					'closeAllProjectDbs();',
				].join('\n'),
				'utf-8',
			);
			return {
				ready,
				process: bunSpawn(
					[process.execPath, script, dir, ready, go, sessionID, status],
					{
						cwd: dir,
						stdin: 'ignore',
						stdout: 'pipe',
						stderr: 'pipe',
						timeout: 15_000,
						killProcessTree: true,
					},
				),
			};
		});

		try {
			for (const child of children) waitForFile(child.ready);
			fs.writeFileSync(go, 'go', 'utf-8');
			const results = await withTimeout(
				Promise.all(
					children.map(async ({ process }) => ({
						exitCode: await process.exited,
						stdout: await process.stdout.text(),
						stderr: await process.stderr.text(),
					})),
				),
				20_000,
				new Error('Timed out waiting for Lean state child processes'),
			);
			for (const result of results) {
				expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
			}
		} finally {
			for (const child of children) {
				try {
					child.process.kill();
				} catch {
					// already exited
				}
			}
		}

		expect(loadLeanTurboRunState(dir, 'session-a')?.status).toBe('running');
		expect(loadLeanTurboRunState(dir, 'session-b')?.status).toBe('paused');
		expect(listCoordinationStates(dir, COORDINATION_NAMESPACE)).toHaveLength(2);
	});
});
