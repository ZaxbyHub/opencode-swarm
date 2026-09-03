import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _internals as coordinationInternals } from '../../../src/db/coordination-store.js';
import {
	closeAllProjectDbs,
	getProjectDb,
	projectDbExists,
} from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	clearPrWorkflowGateState,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	readPrWorkflowGateStateFromDisk,
	workflowGateStatePath,
	workflowGateStateRelativePath,
} from '../../../src/pr-review/persistence.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { withTimeout } from '../../../src/utils/timeout.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

function makeDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	directories.push(dir);
	return dir;
}

function waitForFile(filePath: string, timeoutMs = 5_000): void {
	const gate = new Int32Array(new SharedArrayBuffer(4));
	const deadline = performance.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (performance.now() > deadline) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		Atomics.wait(gate, 0, 0, 10);
	}
}

async function seedLegacyWorkflowProjection(
	sessionID: string,
): Promise<string> {
	const seedDir = makeDir('pr-workflow-gate-seed-');
	await activatePrWorkflow(seedDir, sessionID, 'PR_REVIEW');
	return fsp.readFile(workflowGateStatePath(seedDir, sessionID), 'utf8');
}

beforeEach(() => {
	coordinationInternals.coordinationFaultInjector = undefined;
});

afterEach(async () => {
	coordinationInternals.coordinationFaultInjector = undefined;
	closeAllProjectDbs();
	for (const dir of directories.splice(0)) {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

describe('pr-workflow gate SQLite authority (#2481)', () => {
	test('legacy import archives original bytes and refreshes the projection non-destructively', async () => {
		const directory = makeDir('pr-workflow-gate-sqlite-');
		const sessionID = 'workflow-import';
		const legacyPath = workflowGateStatePath(directory, sessionID);
		const legacyRaw = await seedLegacyWorkflowProjection(sessionID);
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, legacyRaw, 'utf8');

		const state = await readPrWorkflowGateStateFromDisk(directory, sessionID);

		expect(state?.sessionID).toBe(sessionID);
		expect(await fsp.readFile(`${legacyPath}.imported`, 'utf8')).toBe(
			legacyRaw,
		);
		expect(fs.existsSync(legacyPath)).toBe(true);
		expect(
			getProjectDb(directory)
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_import WHERE source = ?',
				)
				.get(workflowGateStateRelativePath(sessionID))?.count,
		).toBe(1);
	});

	test('corrupt legacy authority fails closed without archival or SQLite import', async () => {
		const directory = makeDir('pr-workflow-gate-sqlite-');
		const sessionID = 'workflow-corrupt';
		const legacyPath = workflowGateStatePath(directory, sessionID);
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, '{ corrupt', 'utf8');

		await expect(
			readPrWorkflowGateStateFromDisk(directory, sessionID),
		).rejects.toThrow(/not valid JSON|invalid/i);

		expect(fs.existsSync(`${legacyPath}.imported`)).toBe(false);
		expect(projectDbExists(directory)).toBe(false);
	});

	test('import crash after commit is repaired on replay without duplicating the row', async () => {
		const directory = makeDir('pr-workflow-gate-sqlite-');
		const sessionID = 'workflow-crash';
		const legacyPath = workflowGateStatePath(directory, sessionID);
		const legacyRaw = await seedLegacyWorkflowProjection(sessionID);
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, legacyRaw, 'utf8');
		let injected = false;
		coordinationInternals.coordinationFaultInjector = (point) => {
			if (!injected && point === 'after_commit_before_archive') {
				injected = true;
				throw new Error('simulated archive crash');
			}
		};

		await expect(
			readPrWorkflowGateStateFromDisk(directory, sessionID),
		).rejects.toThrow(/archive crash/i);

		coordinationInternals.coordinationFaultInjector = undefined;
		const repaired = await readPrWorkflowGateStateFromDisk(
			directory,
			sessionID,
		);
		expect(repaired?.sessionID).toBe(sessionID);
		expect(await fsp.readFile(`${legacyPath}.imported`, 'utf8')).toBe(
			legacyRaw,
		);
		expect(
			getProjectDb(directory)
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_import WHERE source = ?',
				)
				.get(workflowGateStateRelativePath(sessionID))?.count,
		).toBe(1);
	});

	test('reappeared legacy source preserves the canonical archive and is re-archived collision-safely', async () => {
		const directory = makeDir('pr-workflow-gate-sqlite-');
		const sessionID = 'workflow-reappeared';
		const legacyPath = workflowGateStatePath(directory, sessionID);
		const firstLegacyRaw = await seedLegacyWorkflowProjection(sessionID);
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, firstLegacyRaw, 'utf8');
		const imported = await readPrWorkflowGateStateFromDisk(
			directory,
			sessionID,
		);
		if (!imported) throw new Error('expected imported workflow state');

		const reappearedLegacyRaw = JSON.stringify(
			{ ...imported, updatedAt: '1999-01-01T00:00:00.000Z' },
			null,
			2,
		);
		await fsp.writeFile(legacyPath, reappearedLegacyRaw, 'utf8');
		const repaired = await readPrWorkflowGateStateFromDisk(
			directory,
			sessionID,
		);
		expect(repaired?.updatedAt).toBe(imported.updatedAt);
		expect(await fsp.readFile(`${legacyPath}.imported`, 'utf8')).toBe(
			firstLegacyRaw,
		);
		expect(await fsp.readFile(`${legacyPath}.imported.1`, 'utf8')).toBe(
			reappearedLegacyRaw,
		);
	});

	test(
		'real two-process workflow advancement races terminal clear and leaves one authoritative outcome',
		{ timeout: 30_000 },
		async () => {
			const directory = makeDir('pr-workflow-gate-sqlite-');
			const sessionID = 'workflow-race';
			await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
			const snapshot = await readPrWorkflowGateState(directory, sessionID);
			if (!snapshot) throw new Error('expected workflow snapshot');

			const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
			const persistenceUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'pr-review', 'persistence.ts'),
			).href;
			const projectDbUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'db', 'project-db.ts'),
			).href;
			const readyPath = path.join(directory, 'advance.ready');
			const goPath = path.join(directory, 'advance.go');
			const workerPath = path.join(directory, 'advance-worker.ts');
			fs.writeFileSync(
				workerPath,
				`import { existsSync, writeFileSync } from 'node:fs';
import { closeAllProjectDbs } from ${JSON.stringify(projectDbUrl)};
import { readPrWorkflowGateStateFromDisk, withSessionStateMutation, writeStateWhileLocked } from ${JSON.stringify(persistenceUrl)};
const [directory, sessionID, readyPath, goPath] = process.argv.slice(2);
writeFileSync(readyPath, 'ready');
const gate = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goPath)) Atomics.wait(gate, 0, 0, 10);
let result;
try {
	result = await withSessionStateMutation(directory, sessionID, async () => {
		const current = await readPrWorkflowGateStateFromDisk(directory, sessionID);
		if (!current) return { status: 'missing' };
		const next = await writeStateWhileLocked(directory, { ...current, updatedAt: '2999-01-01T00:00:00.000Z' });
		return { status: 'advanced', revision: next.revision };
	});
} catch (error) {
	result = { status: 'rejected', message: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(result));
closeAllProjectDbs();
`,
				'utf8',
			);

			const child = bunSpawn(
				[process.execPath, workerPath, directory, sessionID, readyPath, goPath],
				{
					cwd: repoRoot,
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
					timeout: 15_000,
					killProcessTree: true,
				},
			);

			try {
				waitForFile(readyPath);
				fs.writeFileSync(goPath, 'go', 'utf8');
				let clearOutcome: 'cleared' | 'rejected';
				try {
					await clearPrWorkflowGateState(
						directory,
						sessionID,
						snapshot.revision,
					);
					clearOutcome = 'cleared';
				} catch (error) {
					expect((error as Error).message).toMatch(
						/state changed during terminal completion/i,
					);
					clearOutcome = 'rejected';
				}
				const [exitCode, stdout, stderr] = await withTimeout(
					Promise.all([child.exited, child.stdout.text(), child.stderr.text()]),
					20_000,
					new Error('Timed out waiting for workflow race child'),
				);
				expect(exitCode, stderr).toBe(0);
				const childResult = JSON.parse(stdout) as
					| { status: 'advanced'; revision: number }
					| { status: 'missing' }
					| { status: 'rejected'; message: string };

				if (clearOutcome === 'cleared') {
					expect(
						childResult.status === 'missing' ||
							childResult.status === 'rejected',
					).toBe(true);
					await expect(
						readPrWorkflowGateState(directory, sessionID),
					).resolves.toBeNull();
				} else {
					expect(childResult.status).toBe('advanced');
					const current = await readPrWorkflowGateState(directory, sessionID);
					expect(current?.revision).toBe(snapshot.revision + 1);
				}
			} finally {
				child.kill();
			}
		},
	);
});
