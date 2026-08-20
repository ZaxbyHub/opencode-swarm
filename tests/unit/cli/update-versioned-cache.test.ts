/**
 * Tests for the version-pinned cache widening added for issue #2236 RC3:
 *
 *   - isSafeCachePath() accepts the anchored `opencode-swarm@<semver>` leaf
 *     shape (in addition to the two existing literals) — SECURITY-SENSITIVE:
 *     this widens an allowlist guarding a recursive delete.
 *   - `bunx opencode-swarm update` discovers, accepts, and clears a
 *     version-pinned cache directory end to end, and reports the version
 *     that was cleared.
 *
 * Split out of tests/unit/cli/update-command.test.ts (~720 lines already)
 * rather than growing that file past the FR-006 500-line cap.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeCachePath } from '../../../src/cli/index.js';
import { safeRealpathSync } from '../../../src/tools/repo-graph/safe-realpath.js';

const CLI_PATH = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'src',
	'cli',
	'index.ts',
);

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe('isSafeCachePath — widened version-pinned leaf (issue #2236 RC3)', () => {
	test('accepts a plain semver-pinned leaf', () => {
		const p = join(
			process.env.HOME || '/home/user',
			'.cache',
			'opencode',
			'packages',
			'opencode-swarm@7.143.1',
		);
		expect(isSafeCachePath(p)).toBe(true);
	});

	test('accepts pre-release and build-metadata semver leaves', () => {
		const home = process.env.HOME || '/home/user';
		expect(
			isSafeCachePath(
				join(
					home,
					'.cache',
					'opencode',
					'packages',
					'opencode-swarm@1.2.3-rc.1',
				),
			),
		).toBe(true);
		expect(
			isSafeCachePath(
				join(
					home,
					'.cache',
					'opencode',
					'packages',
					'opencode-swarm@1.2.3+build.5',
				),
			),
		).toBe(true);
	});

	test('accepts a version-pinned leaf under node_modules/, not just packages/', () => {
		// Discovery only enumerates packages/, but the safety check itself is
		// leaf-only and does not care which of the two recognized parent dirs
		// (packages, node_modules) it sits under — it must accept both,
		// symmetrically with the two static literals.
		const home = process.env.HOME || '/home/user';
		expect(
			isSafeCachePath(
				join(
					home,
					'.cache',
					'opencode',
					'node_modules',
					'opencode-swarm@7.143.1',
				),
			),
		).toBe(true);
	});

	test('rejects non-version garbage after the @ — proves this is not a startsWith prefix test', () => {
		const home = process.env.HOME || '/home/user';
		const base = (leaf: string) =>
			join(home, '.cache', 'opencode', 'packages', leaf);
		expect(isSafeCachePath(base('opencode-swarm@evil'))).toBe(false);
		expect(isSafeCachePath(base('opencode-swarm@'))).toBe(false);
		expect(isSafeCachePath(base('opencode-swarm@1.2'))).toBe(false);
		expect(isSafeCachePath(base('opencode-swarm@1.2.3.4'))).toBe(false);
	});

	test('rejects a traversal-shaped path segment (opencode-swarm@../../..)', () => {
		// path.resolve() collapses the trailing '..' segments before
		// path.basename() ever sees them, so this is refused structurally
		// regardless of the leaf pattern — but it must still resolve to a
		// SAFE refusal (false), not an accidental accept via canonicalization
		// landing on a legitimate-looking path.
		const home = process.env.HOME || '/home/user';
		const traversal = join(
			home,
			'.cache',
			'opencode',
			'packages',
			'opencode-swarm@../../..',
		);
		expect(isSafeCachePath(traversal)).toBe(false);
	});

	test('rejects a similar-but-wrong package name', () => {
		const home = process.env.HOME || '/home/user';
		expect(
			isSafeCachePath(
				join(home, '.cache', 'opencode', 'packages', 'opencode-swarmx@1.2.3'),
			),
		).toBe(false);
	});

	test('still rejects the pathological XDG_CACHE_HOME=/ shape for a version-pinned leaf', () => {
		// Too few segments below root regardless of leaf shape.
		expect(isSafeCachePath('/opencode/packages/opencode-swarm@7.143.1')).toBe(
			false,
		);
	});

	test('still rejects an unrecognized parent directory for a version-pinned leaf', () => {
		const home = process.env.HOME || '/home/user';
		expect(
			isSafeCachePath(
				join(
					home,
					'.cache',
					'opencode',
					'not-packages',
					'opencode-swarm@1.2.3',
				),
			),
		).toBe(false);
	});
});

describe('M6 realpath canonicalization — extended to version-pinned leaves', () => {
	let tempDir: string;
	const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';

	test('a symlinked version-pinned cache leaf is refused after realpath (final-component swap)', async () => {
		tempDir = await realpath(
			await mkdtemp(join(tmpdir(), 'opencode-swarm-m6-versioned-')),
		);
		try {
			const evilTarget = join(tempDir, 'evil', 'target');
			await mkdir(evilTarget, { recursive: true });
			const linkDir = join(tempDir, 'opencode', 'packages');
			await mkdir(linkDir, { recursive: true });
			const symlinkPath = join(linkDir, 'opencode-swarm@7.143.1');
			await symlink(evilTarget, symlinkPath, symlinkType);

			// Lexical guard (widened leaf check alone) is fooled by the
			// version-pinned-looking name.
			expect(isSafeCachePath(symlinkPath)).toBe(true);

			// M6: canonicalize first, then validate the SAME canonical string.
			const canonical = safeRealpathSync(symlinkPath, symlinkPath);
			expect(canonical).toBe(evilTarget);
			expect(isSafeCachePath(canonical as string)).toBe(false);
		} finally {
			if (existsSync(tempDir)) {
				await rm(tempDir, { recursive: true, force: true });
			}
		}
	});
});

describe('update command — version-pinned cache discovery and clearing', () => {
	let tempDir: string;
	let xdgCacheHome: string;
	let xdgConfigHome: string;

	async function setup(): Promise<void> {
		tempDir = await realpath(
			await mkdtemp(join(tmpdir(), 'opencode-swarm-versioned-update-')),
		);
		xdgCacheHome = join(tempDir, 'cache');
		xdgConfigHome = join(tempDir, 'config');
	}

	async function teardown(): Promise<void> {
		if (tempDir && existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	test('discovers, accepts, and clears a version-pinned cache directory, reporting the before-version', async () => {
		await setup();
		try {
			const pinnedDir = join(
				xdgCacheHome,
				'opencode',
				'packages',
				'opencode-swarm@7.143.1',
			);
			await mkdir(pinnedDir, { recursive: true });
			await writeFile(
				join(pinnedDir, 'package.json'),
				JSON.stringify({ name: 'opencode-swarm', version: '7.143.1' }),
			);

			const result = await runCLI(['update'], {
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('✓ Cleared');
			expect(result.stdout).toContain('opencode-swarm@7.143.1');
			// Before-version reporting (issue #2236 RC3 item 3).
			expect(result.stdout).toContain('(was v7.143.1)');
			expect(existsSync(pinnedDir)).toBe(false);
		} finally {
			await teardown();
		}
	});

	test('clears BOTH a version-pinned dir and the @latest dir when both are present', async () => {
		await setup();
		try {
			const pinnedDir = join(
				xdgCacheHome,
				'opencode',
				'packages',
				'opencode-swarm@7.143.1',
			);
			const latestDir = join(
				xdgCacheHome,
				'opencode',
				'packages',
				'opencode-swarm@latest',
			);
			await mkdir(pinnedDir, { recursive: true });
			await mkdir(latestDir, { recursive: true });

			const result = await runCLI(['update'], {
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			});

			expect(result.exitCode).toBe(0);
			expect(existsSync(pinnedDir)).toBe(false);
			expect(existsSync(latestDir)).toBe(false);
		} finally {
			await teardown();
		}
	});

	test('accepts pre-release and build-metadata version-pinned directories end to end', async () => {
		await setup();
		try {
			const rcDir = join(
				xdgCacheHome,
				'opencode',
				'packages',
				'opencode-swarm@1.2.3-rc.1',
			);
			await mkdir(rcDir, { recursive: true });
			await writeFile(
				join(rcDir, 'package.json'),
				JSON.stringify({ version: '1.2.3-rc.1' }),
			);

			const result = await runCLI(['update'], {
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			});

			expect(result.exitCode).toBe(0);
			expect(existsSync(rcDir)).toBe(false);
			expect(result.stdout).toContain('(was v1.2.3-rc.1)');
		} finally {
			await teardown();
		}
	});

	test('reports the running CLI version at the top of update output', async () => {
		await setup();
		try {
			const packageJson = await import('../../../package.json', {
				with: { type: 'json' },
			});
			const result = await runCLI(['update'], {
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			});
			expect(result.stdout).toContain(
				`opencode-swarm ${packageJson.default.version}`,
			);
		} finally {
			await teardown();
		}
	});

	test('a non-matching directory name in packages/ is left untouched', async () => {
		await setup();
		try {
			const unrelatedDir = join(
				xdgCacheHome,
				'opencode',
				'packages',
				'some-other-plugin@1.0.0',
			);
			await mkdir(unrelatedDir, { recursive: true });

			const result = await runCLI(['update'], {
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			});

			expect(result.exitCode).toBe(0);
			expect(existsSync(unrelatedDir)).toBe(true);
		} finally {
			await teardown();
		}
	});

	test('"Checked locations" lists discovered version-pinned paths when nothing is cleared', async () => {
		// No cache present at all (not even a version-pinned one) — the
		// "Checked locations" listing must not throw and must still list the
		// fixed paths (discovery finds nothing, so the merged list equals the
		// fixed list in this case).
		await setup();
		try {
			const result = await runCLI(['update'], {
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('No cached plugin found');
			expect(result.stdout).toContain('Checked locations:');
		} finally {
			await teardown();
		}
	});
});
