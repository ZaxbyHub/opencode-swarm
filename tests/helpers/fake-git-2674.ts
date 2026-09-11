/**
 * Shared fake-git harness for the #2674 subprocess-lifetime bounds tests.
 *
 * Builds a REAL fake git executable — a clone of the node binary named
 * git.exe (win32) / git (elsewhere) — whose behavior is selected per test by
 * FAKE_GIT_MODE through a NODE_OPTIONS `--require` preload
 * (tests/fixtures/2674-subprocess-lifetime/fake-git-preload.cjs). The
 * production callers are then driven with the clone seeded via
 * `__seedGitExecutableForTests`, so the REAL spawn sites (their timeouts,
 * kill signals, buffer bounds, and structured failures) are what gets
 * exercised — no spawn mocking.
 *
 * Platform notes (verified on this trace):
 * - node ≥24 resolves the child's main-module path (argv[1] = the git
 *   subcommand) BEFORE running --require preloads, so no-op main-module
 *   stubs (`remote`, `rev-parse`, `log`) must exist in the child cwd.
 * - `copyFileSync` does not preserve mode on POSIX, and the Linux/macOS CI
 *   matrix spawns this clone — hence the explicit `chmodSync(0o755)`.
 * - The two SYNC callers only propagate env to children when they pass an
 *   explicit `env` (the #2674 fix does); that is also what makes this
 *   harness work under the bun:test runner (Bun's spawn inherits a
 *   process-start env snapshot otherwise).
 */

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __seedGitExecutableForTests } from '../../src/utils/git-executable.js';
import { canonicalMkdtemp } from './tmpdir.js';

export const FAKE_GIT_URL = 'https://example.com/fake/repo.git';

export interface FakeGitFixture {
	/** Absolute path to the fake git executable (the node-binary clone). */
	gitPath: string;
	/** Temp "project" directory to pass as the callers' working directory. */
	projectDir: string;
}

let cachedNodeExe: string | null = null;

function resolveNodeExe(): string {
	if (cachedNodeExe) return cachedNodeExe;
	const probe = spawnSync(
		'node',
		['-e', 'process.stdout.write(process.execPath)'],
		{
			encoding: 'utf-8',
			timeout: 15_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		},
	);
	const exe = (probe.stdout || '').trim();
	if (!exe || probe.status !== 0) {
		throw new Error(`fake-git-2674: node not resolvable (${probe.stderr})`);
	}
	cachedNodeExe = exe;
	return exe;
}

/**
 * Creates the fake-git executable + project dir and selects `mode`.
 * `seedMissing` seeds a nonexistent path instead (the missing-executable
 * control) — the clone still exists so its directory is cleaned up.
 *
 * The NODE_OPTIONS/FAKE_GIT_MODE env mutations apply to the spawned fake-git
 * CHILDREN (node binaries), not to this bun:test runner process.
 */
export function setupFakeGit(
	mode: string,
	seedMissing = false,
): FakeGitFixture {
	const binDir = canonicalMkdtemp('sw2674-fakebin-');
	const gitPath = join(
		binDir,
		process.platform === 'win32' ? 'git.exe' : 'git',
	);
	const nodeExe = resolveNodeExe();
	if (process.platform === 'win32') {
		copyFileSync(nodeExe, gitPath);
		chmodSync(gitPath, 0o755);
	} else {
		// Symlink on POSIX: executing a COPIED signed binary can fail macOS
		// code-signature validation, while a symlink resolves to the original
		// (validly signed) inode. The copy+chmod path stays for Windows.
		try {
			symlinkSync(nodeExe, gitPath);
		} catch {
			copyFileSync(nodeExe, gitPath);
			chmodSync(gitPath, 0o755);
		}
	}

	const projectDir = canonicalMkdtemp('sw2674-project-');
	// node resolves argv[1] as its main module before --require preloads run.
	for (const mainModule of ['remote', 'rev-parse', 'log']) {
		writeFileSync(join(projectDir, mainModule), '');
	}

	const here = dirname(fileURLToPath(import.meta.url));
	const preload = join(
		here,
		'..',
		'fixtures',
		'2674-subprocess-lifetime',
		'fake-git-preload.cjs',
	);
	process.env.NODE_OPTIONS = `--require ${preload.replace(/\\/g, '/')}`;
	process.env.FAKE_GIT_MODE = mode;

	__seedGitExecutableForTests(
		seedMissing ? join(binDir, 'definitely-missing-git') : gitPath,
	);
	return { gitPath, projectDir };
}

/** Restores the resolver seed, env, and temp dirs. Call in afterEach. */
export function teardownFakeGit(fixture: FakeGitFixture | null): void {
	__seedGitExecutableForTests('git');
	delete process.env.NODE_OPTIONS;
	delete process.env.FAKE_GIT_MODE;
	if (fixture) {
		for (const dir of [dirname(fixture.gitPath), fixture.projectDir]) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows file-lock races on the exe clone are non-fatal for the suite
			}
		}
	}
}

/** Makes churn-analyzable sources so a normal-mode churn run proves a real
 *  analysis round-trip (hotspots > 0), matching the fake `git log` output. */
export function plantChurnSources(projectDir: string): void {
	mkdirSync(join(projectDir, 'src'), { recursive: true });
	writeFileSync(
		join(projectDir, 'src', 'alpha.ts'),
		'export function alpha(a: number) { if (a > 1) { return a * 2; } return a; }\n',
	);
	writeFileSync(
		join(projectDir, 'src', 'beta.py'),
		'def beta(x):\n    if x > 1:\n        return x * 2\n    return x\n',
	);
	writeFileSync(
		join(projectDir, 'src', 'gamma.rs'),
		'pub fn gamma(x: i32) -> i32 { if x > 1 { x * 2 } else { x } }\n',
	);
}
