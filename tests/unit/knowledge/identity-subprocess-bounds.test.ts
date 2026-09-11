/**
 * #2674 — bounded-subprocess contract for the identity caller.
 *
 * Drives the REAL `writeProjectIdentity` (→ `getGitRemoteUrl`'s `execFileSync`)
 * against a real fake-git executable whose behavior is selected per test
 * (see tests/helpers/fake-git-2674.ts). No spawn mocking: the production
 * timeout, SIGKILL escalation, buffer bound, and stdin/env handling are what
 * actually run. Failure modes must degrade to `repoUrl: undefined` — bounded,
 * never fabricated, never hanging the runner (the pre-fix tree hangs here).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { writeProjectIdentity } from '../../../src/knowledge/identity.js';
import {
	FAKE_GIT_URL,
	type FakeGitFixture,
	plantChurnSources,
	setupFakeGit,
	teardownFakeGit,
} from '../../helpers/fake-git-2674.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Generous wall-clock slack over the 5 s caller bound so CI load cannot flake
// the termination assertion (repo convention: assert the bound, not ms
// precision — but the hang case must demonstrably not run unbounded).
const BOUND_MS = 5_000;
const TERMINATION_SLACK_MS = 15_000;

describe('identity getGitRemoteUrl subprocess bounds (#2674)', () => {
	let fixture: FakeGitFixture | null = null;
	// Platform-config isolation (same pattern as tests/unit/knowledge/identity.test.ts,
	// required by the prod-store tripwire preload): writeProjectIdentity writes
	// identity.json under getPlatformConfigDir(), so point LOCALAPPDATA /
	// XDG_CONFIG_HOME / HOME at a temp dir for the duration of each test.
	// HOME must be SET (not deleted): getPlatformConfigDir falls back to
	// os.homedir(), which Bun caches after its first call.
	const originalLocalAppData = process.env.LOCALAPPDATA;
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	const originalHome = process.env.HOME;
	let isolatedConfigRoot = '';

	beforeEach(() => {
		isolatedConfigRoot = canonicalMkdtemp('sw2674-config-');
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = isolatedConfigRoot;
		} else {
			process.env.XDG_CONFIG_HOME = isolatedConfigRoot;
			process.env.HOME = isolatedConfigRoot;
		}
	});

	afterEach(() => {
		if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = originalLocalAppData;
		if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		try {
			rmSync(isolatedConfigRoot, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		teardownFakeGit(fixture);
		fixture = null;
	});

	test('normal output: repoUrl is captured from the remote', async () => {
		fixture = setupFakeGit('normal');
		const identity = await writeProjectIdentity(
			fixture.projectDir,
			'deadbeef0000',
			'sw2674-project',
		);
		expect(identity.repoUrl).toBe(FAKE_GIT_URL);
	}, 20000);

	test('nonzero exit: degrades to repoUrl undefined, never throws', async () => {
		fixture = setupFakeGit('nonzero');
		const identity = await writeProjectIdentity(
			fixture.projectDir,
			'deadbeef0000',
			'sw2674-project',
		);
		expect(identity.repoUrl).toBeUndefined();
	}, 20000);

	test('missing executable: degrades to repoUrl undefined', async () => {
		fixture = setupFakeGit('normal', true);
		const identity = await writeProjectIdentity(
			fixture.projectDir,
			'deadbeef0000',
			'sw2674-project',
		);
		expect(identity.repoUrl).toBeUndefined();
	}, 20000);

	test('output above the maxBuffer bound: child killed, repoUrl undefined, bounded', async () => {
		fixture = setupFakeGit('overflow');
		const started = performance.now();
		const identity = await writeProjectIdentity(
			fixture.projectDir,
			'deadbeef0000',
			'sw2674-project',
		);
		expect(performance.now() - started).toBeLessThan(TERMINATION_SLACK_MS);
		expect(identity.repoUrl).toBeUndefined();
	}, 20000);

	test('early EOF then hang: bounded by the caller timeout, repoUrl undefined', async () => {
		fixture = setupFakeGit('eof');
		const started = performance.now();
		const identity = await writeProjectIdentity(
			fixture.projectDir,
			'deadbeef0000',
			'sw2674-project',
		);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 500);
		expect(elapsed).toBeLessThan(TERMINATION_SLACK_MS);
		expect(identity.repoUrl).toBeUndefined();
	}, 20000);

	test('hung child (plain and SIGTERM-trapping): killed at the bound, repoUrl undefined', async () => {
		for (const mode of ['hang', 'hang-trap'] as const) {
			teardownFakeGit(fixture);
			fixture = setupFakeGit(mode);
			const started = performance.now();
			const identity = await writeProjectIdentity(
				fixture.projectDir,
				'deadbeef0000',
				'sw2674-project',
			);
			const elapsed = performance.now() - started;
			// The bound must actually fire (not an early failure) and must
			// terminate the child well before the suite-level slack.
			expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 500);
			expect(elapsed).toBeLessThan(TERMINATION_SLACK_MS);
			expect(identity.repoUrl).toBeUndefined();
		}
	}, 60000);

	test('forking child (grandchild holds stdio): the await still terminates within the bound', async () => {
		fixture = setupFakeGit('fork');
		plantChurnSources(fixture.projectDir);
		const started = performance.now();
		const identity = await writeProjectIdentity(
			fixture.projectDir,
			'deadbeef0000',
			'sw2674-project',
		);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(TERMINATION_SLACK_MS);
		expect(identity.repoUrl).toBeUndefined();
	}, 20000);
});
