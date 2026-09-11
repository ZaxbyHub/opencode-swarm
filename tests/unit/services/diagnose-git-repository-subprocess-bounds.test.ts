/**
 * #2674 — bounded-subprocess contract for the diagnose caller.
 *
 * Drives the REAL `getDiagnoseData` 'Git Repository' row (→
 * `checkGitRepository`'s `execFileSync`) against a real fake-git executable
 * (tests/helpers/fake-git-2674.ts), plus DI-injected timeout-shaped throws
 * through the `_internals.execFileSync` seam (no `mock.module`). Failure
 * modes must never render `✅` or the false "Not a git repository" claim.
 *
 * Slow tests carry explicit timeouts: bun:test's 5000 ms default would flake
 * against the real 5000 ms caller bound (repo convention for real-subprocess
 * tests).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import {
	_internals,
	getDiagnoseData,
} from '../../../src/services/diagnose-service.js';
import {
	type FakeGitFixture,
	setupFakeGit,
	teardownFakeGit,
} from '../../helpers/fake-git-2674.js';

const BOUND_MS = 5_000;
const TERMINATION_SLACK_MS = 15_000;

async function gitRow(projectDir: string) {
	const data = await getDiagnoseData(projectDir);
	const row = data.checks.find((c) => c.name === 'Git Repository');
	expect(row).toBeDefined();
	return row!;
}

describe('diagnose checkGitRepository subprocess bounds (#2674)', () => {
	let fixture: FakeGitFixture | null = null;
	const originalExecFileSync = _internals.execFileSync;

	afterEach(() => {
		_internals.execFileSync = originalExecFileSync;
		teardownFakeGit(fixture);
		fixture = null;
	});

	test('normal output: row reports ✅ Git repository detected', async () => {
		fixture = setupFakeGit('normal');
		const row = await gitRow(fixture.projectDir);
		expect(row.status).toBe('✅');
		expect(row.detail).toBe('Git repository detected');
	}, 20_000);

	test('nonzero exit: row reports ❌ (existing rendering preserved)', async () => {
		fixture = setupFakeGit('nonzero');
		const row = await gitRow(fixture.projectDir);
		expect(row.status).toBe('❌');
		expect(row.detail).toBe(
			'Not a git repository — version control recommended',
		);
	}, 20_000);

	test('missing executable: row reports ❌', async () => {
		fixture = setupFakeGit('normal', true);
		const row = await gitRow(fixture.projectDir);
		expect(row.status).toBe('❌');
	}, 20_000);

	test('output volume: output is ignored, so an overflowing child still renders ✅ and terminates', async () => {
		fixture = setupFakeGit('overflow');
		const started = performance.now();
		const row = await gitRow(fixture.projectDir);
		expect(performance.now() - started).toBeLessThan(TERMINATION_SLACK_MS);
		expect(row.status).toBe('✅');
	}, 20_000);

	test('hung child: bounded, row renders ⬜ with the ms detail — not "Not a git repository"', async () => {
		fixture = setupFakeGit('hang');
		const started = performance.now();
		const row = await gitRow(fixture.projectDir);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 500);
		expect(elapsed).toBeLessThan(TERMINATION_SLACK_MS);
		expect(row.status).toBe('⬜');
		expect(row.detail).toContain('did not answer within 5000 ms');
	}, 30_000);

	test('early EOF then hang: bounded, ⬜ timeout rendering', async () => {
		fixture = setupFakeGit('eof');
		const row = await gitRow(fixture.projectDir);
		expect(row.status).toBe('⬜');
	}, 30_000);

	test('SIGTERM-trapping hung child: the SIGKILL escalation still bounds it (⬜)', async () => {
		fixture = setupFakeGit('hang-trap');
		const row = await gitRow(fixture.projectDir);
		expect(row.status).toBe('⬜');
	}, 30_000);

	test('DI: every timeout-shaped throw renders ⬜; plain Error and ENOENT stay ❌', async () => {
		fixture = setupFakeGit('normal');
		const timeoutShapes: unknown[] = [
			Object.assign(new Error('killed'), { killed: true }),
			Object.assign(new Error('signal'), { signal: 'SIGKILL' }),
			Object.assign(new Error('signal'), { signal: 'SIGTERM' }),
			Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
		];
		for (const shape of timeoutShapes) {
			_internals.execFileSync = (() => {
				throw shape;
			}) as typeof _internals.execFileSync;
			const row = await gitRow(fixture.projectDir);
			expect(row.status).toBe('⬜');
			expect(row.detail).toContain('did not answer within 5000 ms');
		}
		for (const plain of [
			new Error('plain failure'),
			Object.assign(new Error('enoent'), { code: 'ENOENT' }),
		]) {
			_internals.execFileSync = (() => {
				throw plain;
			}) as typeof _internals.execFileSync;
			const row = await gitRow(fixture.projectDir);
			expect(row.status).toBe('❌');
			expect(row.detail).toBe(
				'Not a git repository — version control recommended',
			);
		}
	}, 20_000);
});
