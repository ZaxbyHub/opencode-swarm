import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	closeAllProjectDbs,
	closeProjectDb,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { readSnapshotRows } from '../../../src/session/snapshot-store.js';
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
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLite session snapshot multiprocess coordination', () => {
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
