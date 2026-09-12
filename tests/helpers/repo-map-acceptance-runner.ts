#!/usr/bin/env bun

/**
 * AC7 checkpoint runner for the retained repo_map action suites.
 *
 * Each file gets a fresh Bun process, matching CI's isolation contract and
 * preventing a module mock in one suite from changing the next suite.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../..',
);
const TEST_FILES = [
	'tests/unit/tools/repo-map.test.ts',
	'tests/unit/tools/repo-map-kg14-search.test.ts',
	'tests/unit/tools/repo-map-kg14-context.test.ts',
	'tests/unit/tools/repo-map-kg14-explain.test.ts',
] as const;
const CHILD_TIMEOUT_MS = 120_000;

function waitForExit(child: ChildProcess): Promise<number> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			resolve(exitCode);
		};

		child.once('error', () => finish(1));
		child.once('close', (exitCode) => finish(exitCode ?? 1));
	});
}

async function runTestFile(file: string): Promise<number> {
	let child: ChildProcess | undefined;
	try {
		child = spawn(
			process.execPath,
			['--smol', 'test', file, '--timeout', '60000'],
			{
				cwd: REPO_ROOT,
				stdio: ['ignore', 'inherit', 'inherit'],
				timeout: CHILD_TIMEOUT_MS,
				windowsHide: true,
			},
		);
		return await waitForExit(child);
	} catch {
		return 1;
	} finally {
		if (child && child.exitCode === null && !child.killed) {
			try {
				child.kill();
			} catch {
				// Best-effort cleanup if the child already exited.
			}
		}
	}
}

async function run(): Promise<number> {
	for (const relativeFile of TEST_FILES) {
		const file = path.join(REPO_ROOT, relativeFile);
		process.stdout.write(`[AC7] running ${relativeFile}\n`);
		const exitCode = await runTestFile(file);

		if (exitCode !== 0) {
			process.stderr.write(`[AC7] failed ${relativeFile} (exit ${exitCode})\n`);
			return exitCode;
		}
		process.stdout.write(`[AC7] passed ${relativeFile}\n`);
	}

	return 0;
}

const exitCode = await run();
process.exitCode = exitCode;
