import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import { bunSpawn } from '../utils/bun-compat.js';
import { withTimeout } from '../utils/timeout.js';
import { closeAllProjectDbs } from './project-db.js';

let tempDir: string;

function waitForFile(filePath: string): void {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(filePath)) {
		if (Date.now() > deadline)
			throw new Error(`Timed out waiting for ${filePath}`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('project-db-race-');
});

afterEach(() => {
	closeAllProjectDbs();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('project-db first-open contention', () => {
	test('two processes converge on the full migration set', async () => {
		const moduleUrl = pathToFileURL(
			path.resolve(process.cwd(), 'src/db/project-db.ts'),
		).href;
		const go = path.join(tempDir, 'go');
		const children = ['a', 'b'].map((id) => {
			const ready = path.join(tempDir, `${id}.ready`);
			const script = path.join(tempDir, `${id}.ts`);
			fs.writeFileSync(
				script,
				[
					"import { existsSync, writeFileSync } from 'node:fs';",
					`import { closeProjectDb, getProjectDb } from ${JSON.stringify(moduleUrl)};`,
					'const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
					`writeFileSync(${JSON.stringify(ready)}, 'ready');`,
					`while (!existsSync(${JSON.stringify(go)})) sleep(10);`,
					`const db = getProjectDb(${JSON.stringify(tempDir)});`,
					"const version = db.query('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;",
					'if (version !== 28) throw new Error(`unexpected version ${version}`);',
					`closeProjectDb(${JSON.stringify(tempDir)});`,
				].join('\n'),
			);
			return {
				ready,
				process: bunSpawn([process.execPath, script], {
					cwd: tempDir,
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
					timeout: 15_000,
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
				20_000,
				new Error('Timed out waiting for first-open children'),
			);
			for (const result of results) {
				expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
			}
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
