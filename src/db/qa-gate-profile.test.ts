/**
 * Tests for src/db/qa-gate-profile.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bunSpawn } from '../utils/bun-compat.js';
import { withTimeout } from '../utils/timeout.js';
import { closeAllProjectDbs, getProjectDb } from './project-db.js';
import {
	_internals,
	computeProfileHash,
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getOrCreateProfile,
	getProfile,
	lockProfile,
	setGates,
} from './qa-gate-profile.js';

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
	_internals.afterSetGatesRead = originalAfterSetGatesRead;
	closeAllProjectDbs();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('qa-gate-profile', () => {
	test('getProfile returns null for unknown plan_id', () => {
		expect(getProfile(tempDir, 'missing')).toBeNull();
	});

	test('getProfile does NOT create .swarm/swarm.db on read from fresh dir', () => {
		const dbPath = path.join(tempDir, '.swarm', 'swarm.db');
		// Precondition: fresh dir, no .swarm
		expect(fs.existsSync(path.join(tempDir, '.swarm'))).toBe(false);
		expect(fs.existsSync(dbPath)).toBe(false);

		const result = getProfile(tempDir, 'plan-that-does-not-exist');
		expect(result).toBeNull();

		// Postcondition: read-only call must not have created the DB file
		expect(fs.existsSync(dbPath)).toBe(false);
	});

	test('getOrCreateProfile seeds defaults', () => {
		const p = getOrCreateProfile(tempDir, 'plan-1', 'ts');
		expect(p.plan_id).toBe('plan-1');
		expect(p.project_type).toBe('ts');
		expect(p.gates).toEqual(DEFAULT_QA_GATES);
		expect(p.locked_at).toBeNull();
	});

	test('getOrCreateProfile is idempotent', () => {
		const a = getOrCreateProfile(tempDir, 'plan-1');
		const b = getOrCreateProfile(tempDir, 'plan-1');
		expect(a.id).toBe(b.id);
	});

	test('setGates can enable additional gates (ratchet tighter)', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		const updated = setGates(tempDir, 'plan-1', { council_mode: true });
		expect(updated.gates.council_mode).toBe(true);
		// Defaults preserved
		expect(updated.gates.reviewer).toBe(true);
	});

	test('setGates rejects attempts to disable an enabled gate', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		expect(() => setGates(tempDir, 'plan-1', { reviewer: false })).toThrow(
			/ratchet/i,
		);
	});

	test('setGates allows false on an already-disabled gate (no-op)', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		// council_mode defaults to false; passing false is a no-op, not an error.
		const result = setGates(tempDir, 'plan-1', { council_mode: false });
		expect(result.gates.council_mode).toBe(false);
	});

	test('setGates throws on missing profile', () => {
		expect(() => setGates(tempDir, 'nope', { reviewer: true })).toThrow(
			/No QA gate profile/,
		);
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

	test('lockProfile sets locked_at and snapshot seq', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		const locked = lockProfile(tempDir, 'plan-1', 7);
		expect(locked.locked_at).not.toBeNull();
		expect(locked.locked_by_snapshot_seq).toBe(7);
	});

	test('lockProfile is idempotent (second call returns locked row unchanged)', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		const first = lockProfile(tempDir, 'plan-1', 7);
		const second = lockProfile(tempDir, 'plan-1', 99);
		expect(second.locked_at).toBe(first.locked_at);
		expect(second.locked_by_snapshot_seq).toBe(7);
	});

	test('setGates throws once profile is locked', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		lockProfile(tempDir, 'plan-1', 1);
		expect(() => setGates(tempDir, 'plan-1', { council_mode: true })).toThrow(
			/locked/i,
		);
	});

	test('underlying trigger also rejects raw UPDATE after lock', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		lockProfile(tempDir, 'plan-1', 1);
		const db = getProjectDb(tempDir);
		expect(() => {
			db.run(
				"UPDATE qa_gate_profile SET gates = '{}' WHERE plan_id = 'plan-1'",
			);
		}).toThrow(/locked/i);
	});

	test('computeProfileHash is stable and sensitive to gate changes', () => {
		const p1 = getOrCreateProfile(tempDir, 'plan-1');
		const h1 = computeProfileHash(p1);
		expect(h1).toMatch(/^[0-9a-f]{64}$/);

		const p2 = setGates(tempDir, 'plan-1', { council_mode: true });
		const h2 = computeProfileHash(p2);
		expect(h2).not.toBe(h1);
	});

	test('getEffectiveGates ratchets tighter via session overrides', () => {
		const p = getOrCreateProfile(tempDir, 'plan-1');
		const eff = getEffectiveGates(p, { council_mode: true });
		expect(eff.council_mode).toBe(true);
		expect(eff.reviewer).toBe(true);
	});

	test('getEffectiveGates ignores false overrides (cannot disable)', () => {
		const p = getOrCreateProfile(tempDir, 'plan-1');
		const eff = getEffectiveGates(p, { reviewer: false });
		expect(eff.reviewer).toBe(true);
	});

	test('getEffectiveGates ratchets hallucination_guard via session overrides', () => {
		const p = getOrCreateProfile(tempDir, 'plan-hg');
		// Default is false
		expect(p.gates.hallucination_guard).toBe(false);
		const eff = getEffectiveGates(p, { hallucination_guard: true });
		expect(eff.hallucination_guard).toBe(true);
		// Other gates unchanged
		expect(eff.reviewer).toBe(true);
	});
});
