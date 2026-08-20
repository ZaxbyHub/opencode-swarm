/**
 * Self-test for tests/helpers/git-executable-fixtures.ts.
 *
 * Recurrence guard for the host-dependence class that has now bitten issue
 * #2236 four times — most recently the resolver fixtures being joined with the
 * HOST separator while the resolver itself joins with the SIMULATED platform's,
 * which was green on Windows and red on both ubuntu-latest and macos-latest.
 *
 * These rows touch NO filesystem, so neither is vacuous on any host: together
 * they pin the candidate strings the resolver actually emits under BOTH
 * simulated platforms and check `simJoin` — the mirror every on-disk fixture is
 * built from — against them. On a Windows dev box the `linux` row is what fails
 * if the mirror drifts back to `path.join`; on POSIX CI it is the `win32` row.
 * Three earlier instances in this issue carried an explanatory comment and
 * recurred anyway, so this is a test rather than a note.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import {
	_internals,
	describeGitResolution,
	resetGitExecutableCache,
	resolveGitExecutable,
} from '../../src/utils/git-executable';
import {
	SIM_GIT_NAME,
	SIM_PLATFORM,
	simJoin,
	writeSimFixture,
} from './git-executable-fixtures.js';
import { canonicalMkdtemp } from './tmpdir.js';

const ORIGINAL_INTERNALS = { ..._internals };

function rejectingSpawnResult(): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from(''), Buffer.from('')],
		stdout: Buffer.from(''),
		stderr: Buffer.from(''),
		status: 1,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<Buffer>;
}

let tmpDir: string;

beforeEach(() => {
	// tests/preload/executable-resolver-pin.ts seeds the resolver cache for
	// every test file; clear it so these tests exercise a real probe cycle.
	resetGitExecutableCache();
	tmpDir = canonicalMkdtemp('git-exec-fixtures-');
});
afterEach(() => {
	_internals.spawnSync = ORIGINAL_INTERNALS.spawnSync;
	_internals.platform = ORIGINAL_INTERNALS.platform;
	_internals.env = ORIGINAL_INTERNALS.env;
	resetGitExecutableCache();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('git-executable fixtures — candidate shaping is host-independent', () => {
	const rows: Array<[NodeJS.Platform, string, string, string, string]> = [
		['linux', '/opt/tools', 'git', '/opt/tools/git', '\\'],
		['win32', 'D:\\tools', 'git.exe', 'D:\\tools\\git.exe', '/'],
	];

	for (const [platform, dir, name, expected, foreign] of rows) {
		test(`a PATH entry yields a ${platform}-shaped candidate on any host`, () => {
			_internals.platform = () => platform;
			_internals.env = () => ({ PATH: dir });
			// Reject everything: these assertions are about the strings the
			// resolver GENERATES, which are recorded whether or not a candidate
			// is accepted, so a real git on the host cannot perturb them.
			_internals.spawnSync = () => rejectingSpawnResult();

			expect(resolveGitExecutable()).toBe('git');
			const generated = describeGitResolution()
				.attempts.filter((a) => a.source === 'path')
				.map((a) => a.candidate);

			expect(generated.length).toBeGreaterThan(0); // never vacuous
			expect(generated).toContain(expected);
			// The mirror the fixture helper joins with must agree with the
			// resolver for this platform, on whatever host is running.
			expect(simJoin(dir, platform, name)).toBe(expected);
			expect(generated.every((c) => !c.includes(foreign))).toBe(true);
		});
	}
});

describe('git-executable fixtures — writeSimFixture', () => {
	test('materializes a file the resolver can actually reach and enumerate', () => {
		const { dir, candidate } = writeSimFixture(tmpDir, 'pathbin');

		// Shaped for the SIMULATED platform, not the host that wrote it...
		expect(candidate).toBe(simJoin(dir, SIM_PLATFORM, SIM_GIT_NAME));
		// ...and still reachable through the host's own filesystem.
		expect(fs.existsSync(candidate)).toBe(true);

		_internals.platform = () => SIM_PLATFORM;
		_internals.env = () => ({ PATH: dir });
		_internals.spawnSync = () => rejectingSpawnResult();

		resolveGitExecutable();
		const attempt = describeGitResolution().attempts.find(
			(a) => a.candidate === candidate,
		);
		// The resolver generated this exact string AND got past the stat
		// pre-check — the two properties a host-shaped fixture silently loses.
		expect(attempt).toBeDefined();
		expect(attempt?.reason).not.toBe('no such file');
		expect(attempt?.reason).not.toBe('not an absolute path');
	});

	test('refuses to hand back a fixture outside the caller tmpdir', () => {
		// On POSIX a win32-shaped tail is a literal filename, so the HOST parent
		// of the candidate is the fixture dir's PARENT — an escaping label would
		// write into the shared system temp root on CI rather than fail.
		expect(() => writeSimFixture(tmpDir, '../escape')).toThrow(
			/outside the test tmpdir/,
		);
	});
});
