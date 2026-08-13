/**
 * Concurrency tests for src/db/qa-gate-profile.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bunSpawn } from '../utils/bun-compat.js';
import { withTimeout } from '../utils/timeout.js';
import {
	closeAllProjectDbs,
	projectDbPath,
	runProjectMigrations,
} from './project-db.js';
import {
	_internals,
	DEFAULT_QA_GATES,
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	getProfile,
	setGates,
	setGatesForIdentity,
} from './qa-gate-profile.js';
import { loadDatabaseCtor } from './sqlite-loader.js';

let tempDir: string;
const originalAfterSetGatesRead = _internals.afterSetGatesRead;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath: string, timeoutMs = 5000): void {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		sleepSync(10);
	}
}

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), 'qa-gate-profile-test-')),
	);
});

afterEach(() => {
	delete _internals.afterSetGatesForIdentityRead;
	_internals.afterSetGatesRead = originalAfterSetGatesRead;
	closeAllProjectDbs();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('qa-gate-profile concurrency', () => {
	test('setGatesForIdentity keeps BEGIN IMMEDIATE across the read-update seam', () => {
		const identity = { swarm: 'exact swarm', title: 'Exact Plan' };
		const created = getOrCreateProfileForIdentity(tempDir, identity, 'ts', {
			reviewer: false,
		});
		const Db = loadDatabaseCtor();
		const contender = new Db(projectDbPath(tempDir));
		runProjectMigrations(contender);
		contender.run('PRAGMA busy_timeout = 25;');
		let contenderError: unknown;

		_internals.afterSetGatesForIdentityRead = () => {
			try {
				contender.run('UPDATE qa_gate_profile SET gates = ? WHERE id = ?', [
					JSON.stringify({ ...DEFAULT_QA_GATES, reviewer: true }),
					created.id,
				]);
			} catch (error) {
				contenderError = error;
			}
		};

		try {
			const updated = setGatesForIdentity(tempDir, identity, {
				reviewer: true,
			});
			expect(updated.gates.reviewer).toBe(true);
			expect(String(contenderError)).toMatch(/busy|locked/i);
		} finally {
			contender.close();
		}
	});

	test('setGates serializes concurrent writers across processes and preserves both gate enables', async () => {
		getOrCreateProfile(tempDir, 'plan-1');
		const startMarker = path.join(tempDir, 'qa-gate-race.start');
		const attemptedMarker = path.join(tempDir, 'qa-gate-race.attempted');
		const doneMarker = path.join(tempDir, 'qa-gate-race.done');
		const childScript = path.join(tempDir, 'qa-gate-race-child.ts');
		fs.writeFileSync(
			childScript,
			[
				"import { existsSync, writeFileSync } from 'node:fs';",
				`import { setGates } from ${JSON.stringify(
					pathToFileURL(
						path.resolve(process.cwd(), 'src/db/qa-gate-profile.ts'),
					).href,
				)};`,
				'function sleepSync(ms: number): void {',
				'  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
				'}',
				`while (!existsSync(${JSON.stringify(startMarker)})) sleepSync(10);`,
				`writeFileSync(${JSON.stringify(attemptedMarker)}, '1');`,
				`setGates(${JSON.stringify(tempDir)}, 'plan-1', { hallucination_guard: true });`,
				`writeFileSync(${JSON.stringify(doneMarker)}, '1');`,
			].join('\n'),
			'utf8',
		);

		const child = bunSpawn([process.execPath, childScript], {
			cwd: tempDir,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
			killProcessTree: true,
		});
		try {
			_internals.afterSetGatesRead = () => {
				fs.writeFileSync(startMarker, '1');
				waitForFile(attemptedMarker);
				// Under the broken deferred-transaction path the child can finish
				// its stale write here, so wait briefly for that completion. Under
				// the fixed BEGIN IMMEDIATE path the child remains blocked until
				// the outer writer commits, so this loop naturally times out.
				const childDoneDeadline = Date.now() + 200;
				while (!fs.existsSync(doneMarker) && Date.now() <= childDoneDeadline) {
					sleepSync(10);
				}
			};

			const updated = setGates(tempDir, 'plan-1', { council_mode: true });
			expect(updated.gates.council_mode).toBe(true);

			const [exitCode, childStdout, childStderr] = await withTimeout(
				Promise.all([child.exited, child.stdout.text(), child.stderr.text()]),
				5_000,
				new Error('Timed out waiting for child setGates writer'),
			);
			if (exitCode !== 0) {
				throw new Error(
					`Concurrent child writer exited ${exitCode}: ${childStderr.trim()} ${childStdout.trim()}`,
				);
			}

			waitForFile(doneMarker);
			const profile = getProfile(tempDir, 'plan-1');
			expect(profile).not.toBeNull();
			expect(profile!.gates.council_mode).toBe(true);
			expect(profile!.gates.hallucination_guard).toBe(true);
		} finally {
			_internals.afterSetGatesRead = originalAfterSetGatesRead;
			try {
				child.kill();
			} catch {
				// Child already exited.
			}
		}
	});
});
