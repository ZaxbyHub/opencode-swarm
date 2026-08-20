/**
 * `git --version` OUTPUT-FORMAT validation for src/utils/git-executable.ts.
 *
 * Why this file exists (CWE-427). An accepted candidate becomes the executable
 * this process spawns for every host-side git call. Before this check, the
 * probe accepted any regular file that exited 0 — `/bin/true`, a shell shim, a
 * downloaded helper — so "is it git?" was never actually asked. Requiring
 * git's own `git version <n>.<n>` output closes that for EVERY candidate
 * source, including `OPENCODE_SWARM_GIT_BINARY`, which the loader-level
 * provenance gate (tests/unit/config/loader-git-binary-provenance.test.ts)
 * deliberately does not cover.
 *
 * See git-executable.test.ts for lazy-load/candidate-ordering coverage and
 * git-executable-override.test.ts for precedence/TTL/budget coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_internals,
	describeGitResolution,
	GIT_BINARY_ENV_VAR,
	resetGitExecutableCache,
	resolveGitExecutable,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';
import {
	SIM_PLATFORM,
	writeSimFixture,
} from '../../helpers/git-executable-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ORIGINAL_INTERNALS = { ..._internals };

/** ESC, built at runtime so no literal control byte lives in this source. */
const ESC = String.fromCharCode(27);

const GIT_VERSION_LINE = 'git version 2.43.0\n';

function restoreInternals(): void {
	_internals.spawnSync = ORIGINAL_INTERNALS.spawnSync;
	_internals.platform = ORIGINAL_INTERNALS.platform;
	_internals.env = ORIGINAL_INTERNALS.env;
	_internals.now = ORIGINAL_INTERNALS.now;
	_internals.yieldToEventLoop = ORIGINAL_INTERNALS.yieldToEventLoop;
}

function spawnResult(
	stdout: string,
	overrides: Partial<SpawnSyncReturns<Buffer>> = {},
): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from(stdout), Buffer.from('')],
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(''),
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	} as SpawnSyncReturns<Buffer>;
}

function enoentResult(): SpawnSyncReturns<Buffer> {
	return spawnResult('', {
		status: null,
		error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
	});
}

let tmpDir: string;

beforeEach(() => {
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	clearDeferredWarnings();
	tmpDir = canonicalMkdtemp('git-exec-version-');
});

afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	clearDeferredWarnings();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Writes a stand-in executable and returns its path, shaped for the SIMULATED
 * platform rather than for the host running the suite. Every test here
 * simulates `SIM_PLATFORM`, so a host-shaped `path.join` fixture would be a
 * different string from the candidate the resolver DERIVES for a PATH entry —
 * see tests/helpers/git-executable-fixtures.ts for why that passes on Windows
 * and fails on POSIX CI.
 */
function writeCandidate(name: string): string {
	return writeSimFixture(tmpDir, name).candidate;
}

/** The directory to hand to `PATH`, plus the candidate derived from it. */
function writePathFixture(name: string): { dir: string; candidate: string } {
	return writeSimFixture(tmpDir, name);
}

/** Drives one probe cycle in which `candidate` is the only override. */
function resolveWithOverrideOutput(
	candidate: string,
	stdout: string,
): { resolved: string; reason?: string; accepted?: boolean } {
	_internals.platform = () => SIM_PLATFORM;
	_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: candidate, PATH: '' });
	_internals.spawnSync = (cmd) =>
		cmd === candidate ? spawnResult(stdout) : enoentResult();

	const resolved = resolveGitExecutable();
	const attempt = describeGitResolution().attempts.find(
		(a) => a.candidate === candidate,
	);
	// Self-verifying precondition: the candidate must actually have been
	// PROBED. If it were skipped (wrong path shape for the simulated platform,
	// budget exhaustion), `attempt` would be undefined and a "was not accepted"
	// assertion would pass vacuously.
	expect(attempt).toBeDefined();
	return { resolved, reason: attempt?.reason, accepted: attempt?.accepted };
}

describe('git --version output must actually be git', () => {
	test('rejects a candidate that exits 0 but prints something that is not a git version', () => {
		const shim = writeCandidate('shim');
		const { resolved, reason, accepted } = resolveWithOverrideOutput(
			shim,
			'pwned\n',
		);

		expect(accepted).toBe(false);
		expect(resolved).not.toBe(shim);
		expect(resolved).toBe('git');
		expect(reason).toContain('not git');
		expect(reason).toContain('pwned');
	});

	test('rejects a candidate that exits 0 and prints nothing at all', () => {
		const silent = writeCandidate('silent');
		const { resolved, reason } = resolveWithOverrideOutput(silent, '');

		expect(resolved).toBe('git');
		expect(reason).toBe('not git: --version printed nothing');
	});

	test('rejects output that merely CONTAINS a git version line', () => {
		const liar = writeCandidate('liar');
		const { resolved, accepted } = resolveWithOverrideOutput(
			liar,
			`hello from my shim\n${GIT_VERSION_LINE}`,
		);

		expect(accepted).toBe(false);
		expect(resolved).toBe('git');
	});

	test('rejects a version-like line carrying no numeric version', () => {
		const liar = writeCandidate('nonnumeric');
		const { resolved, accepted } = resolveWithOverrideOutput(
			liar,
			'git version tip\n',
		);

		expect(accepted).toBe(false);
		expect(resolved).toBe('git');
	});

	test('strips terminal-control characters out of the rejection reason', () => {
		// A rejected candidate's own output is echoed into a warning that gets
		// rendered on the user's terminal, so the excerpt must not carry ANSI
		// escapes.
		const hostile = writeCandidate('ansi');
		const { reason } = resolveWithOverrideOutput(
			hostile,
			`${ESC}[2Jcleared your screen\n`,
		);

		expect(reason).toBeDefined();
		expect(reason).not.toContain(ESC);
		expect(reason).toContain('cleared your screen');
	});

	test('a rejected override warns and resolution continues down the candidate list', () => {
		const shim = writeCandidate('warned');
		// The fall-through target is a PATH candidate, which the resolver
		// DERIVES by joining with the simulated separator — so the fixture must
		// be built the same way, not with the host's `path.join`.
		const realGit = writePathFixture('real');

		_internals.platform = () => SIM_PLATFORM;
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: shim,
			PATH: realGit.dir,
		});
		_internals.spawnSync = (cmd) => {
			if (cmd === shim) return spawnResult('definitely not git\n');
			if (cmd === realGit.candidate) return spawnResult(GIT_VERSION_LINE);
			return enoentResult();
		};

		// The fall-through contract: a bad override must never make git
		// unreachable.
		const resolved = resolveGitExecutable();
		// Recurrence guard: assert the resolver actually GENERATED the fixture
		// path before asserting it was chosen, so a host-shaped fixture fails
		// naming the mismatch instead of as an opaque `Received: "git"`.
		expect(describeGitResolution().attempts.map((a) => a.candidate)).toContain(
			realGit.candidate,
		);
		expect(resolved).toBe(realGit.candidate);
		expect(
			getDeferredWarnings().filter((w) => w.includes('git.binary')).length,
		).toBe(1);
	});
});

describe('genuine git is still accepted', () => {
	test('accepts the canonical git version line', () => {
		const gitPath = writeCandidate('genuine');
		const { resolved } = resolveWithOverrideOutput(gitPath, GIT_VERSION_LINE);

		expect(resolved).toBe(gitPath);
		expect(describeGitResolution().resolved).toBe(true);
	});

	test('accepts the Windows build-suffix form with CRLF', () => {
		const gitPath = writeCandidate('windows');
		const { resolved } = resolveWithOverrideOutput(
			gitPath,
			'git version 2.43.0.windows.1\r\n',
		);

		expect(resolved).toBe(gitPath);
	});

	test('accepts a wrapper that prints its own banner after the git line', () => {
		const gitPath = writeCandidate('wrapper');
		const { resolved } = resolveWithOverrideOutput(
			gitPath,
			`${GIT_VERSION_LINE}hub version 2.14.2\n`,
		);

		expect(resolved).toBe(gitPath);
	});

	test('OPENCODE_SWARM_GIT_BINARY is still honored end to end', () => {
		const envGit = writeCandidate('env');
		const configGit = writeCandidate('config');
		// A config override is registered too, so this proves the env var WINS
		// rather than merely being the only candidate present.
		setGitBinaryOverride(configGit);

		_internals.platform = () => SIM_PLATFORM;
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: envGit, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === envGit || cmd === configGit
				? spawnResult(GIT_VERSION_LINE)
				: enoentResult();

		expect(resolveGitExecutable()).toBe(envGit);
		expect(describeGitResolution().overrideSource).toBe('env');
	});

	test('a user-level config git.binary is still honored when no env var is set', () => {
		const configGit = writeCandidate('config-only');
		setGitBinaryOverride(configGit);

		_internals.platform = () => SIM_PLATFORM;
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === configGit ? spawnResult(GIT_VERSION_LINE) : enoentResult();

		expect(resolveGitExecutable()).toBe(configGit);
		expect(describeGitResolution().overrideSource).toBe('config');
	});
});
