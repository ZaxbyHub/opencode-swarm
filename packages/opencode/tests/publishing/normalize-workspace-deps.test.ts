import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Normalizer tests (PR #3163 feedback FB-003 — release deadlock).
 *
 * scripts/normalize-workspace-deps.mjs is the post-bump sync tool the release
 * workflows run before scripts/check-publish-manifests.mjs fails closed. It
 * must resync not only `workspace:` specs but also stale exact
 * `@opencode-swarm/*` pins to the target workspace package's committed
 * version — otherwise, once every spec is an exact pin, it is a permanent
 * no-op and every post-bump release PR fails the guard forever.
 *
 * These tests exercise it as a subprocess the way the release workflows do.
 * Every run against the REAL repo passes --check (never mutates the
 * worktree); real (mutating) runs are confined to throwaway temp mirrors.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const NORMALIZER = path.join(REPO_ROOT, 'scripts/normalize-workspace-deps.mjs');

interface NormalizerResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runNormalizer(args: string[] = []): NormalizerResult {
	const res = spawnSync(process.execPath, [NORMALIZER, ...args], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function realpathTmpdir(): string {
	// Windows mkdtempSync + later node spawns handle the plain tmpdir fine;
	// avoid realpathSync only because it can mismatch MSYS form on this host.
	return tmpdir();
}

/** Mirror of the four real manifests under a temp root (versions stay real). */
function mirrorRealPackages(): string {
	const root = mkdtempSync(path.join(realpathTmpdir(), 'normalize-probe-'));
	const srcRoot = path.join(REPO_ROOT, 'packages');
	for (const name of ['core', 'opencode', 'claude-code', 'telemetry']) {
		const text = readFileSync(path.join(srcRoot, name, 'package.json'), 'utf8');
		const dir = path.join(root, 'packages', name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'package.json'), text);
	}
	return root;
}

function writeManifest(root: string, name: string, mutate: (m: Record<string, unknown>) => void): void {
	const file = path.join(root, 'packages', name, 'package.json');
	const manifest = JSON.parse(readFileSync(file, 'utf8'));
	mutate(manifest);
	writeFileSync(file, `${JSON.stringify(manifest, null, '\t')}\n`);
}

function committedVersion(pkg: string): string {
	return JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8')).version;
}

describe('normalize-workspace-deps (PR #3163 FB-003)', () => {
	test('clean repo passes --check without mutation (NORMALIZE_CLEAN, exit 0)', () => {
		const res = runNormalizer(['--check']);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('NORMALIZE_CLEAN');
	});

	test('stale exact pin after a core bump is reported as drift (--check exit 1)', () => {
		const root = mirrorRealPackages();
		try {
			const stalePin = committedVersion('core');
			// Simulate the post-release-please state: core's committed version
			// moved forward, dependents' exact pins did not follow.
			writeManifest(root, 'core', (m) => {
				m.version = '999.0.0-beta.0';
			});
			const res = runNormalizer(['--check', '--root', root]);
			expect(res.status).toBe(1);
			expect(res.stdout).toContain('DRIFT');
			expect(res.stdout).toContain(`dependencies["@opencode-swarm/core"] "${stalePin}" -> "999.0.0-beta.0"`);
			expect(res.stderr).toContain('drift');
			// --check must not write: the dependent's manifest is untouched.
			const opencode = readFileSync(path.join(root, 'packages', 'opencode', 'package.json'), 'utf8');
			expect(opencode).toContain(`"@opencode-swarm/core": "${stalePin}"`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('planted workspace: spec is rewritten to the committed pin on a real run', () => {
		const root = mirrorRealPackages();
		try {
			writeManifest(root, 'core', (m) => {
				const deps = m.dependencies as Record<string, string>;
				deps['@opencode-swarm/telemetry'] = 'workspace:*';
			});
			const res = runNormalizer(['--root', root]);
			expect(res.status).toBe(0);
			expect(res.stdout).toContain('NORMALIZE_APPLIED');
			expect(res.stdout).toContain('"workspace:*"');

			const file = path.join(root, 'packages', 'core', 'package.json');
			const text = readFileSync(file, 'utf8');
			expect(text).not.toContain('workspace:');
			const manifest = JSON.parse(text);
			const deps = manifest.dependencies as Record<string, string>;
			expect(deps['@opencode-swarm/telemetry']).toBe(committedVersion('telemetry'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('stale exact pin is resynced to the bumped committed version on a real run', () => {
		const root = mirrorRealPackages();
		try {
			writeManifest(root, 'core', (m) => {
				m.version = '999.0.0-beta.0';
			});
			const res = runNormalizer(['--root', root]);
			expect(res.status).toBe(0);
			expect(res.stdout).toContain('NORMALIZE_APPLIED: 2');

			for (const pkg of ['opencode', 'claude-code']) {
				const manifest = JSON.parse(readFileSync(path.join(root, 'packages', pkg, 'package.json'), 'utf8'));
				const deps = manifest.dependencies as Record<string, string>;
				expect(deps['@opencode-swarm/core']).toBe('999.0.0-beta.0');
			}
			// The guard must now pass on the normalized mirror — the release
			// deadlock (bump -> guard fails forever) is broken.
			const guard = spawnSync(
				process.execPath,
				[path.join(REPO_ROOT, 'scripts/check-publish-manifests.mjs'), '--root', root],
				{ cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
			);
			expect(guard.status).toBe(0);
			expect(guard.stdout).toContain('GUARD_OK');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('unknown argument is a usage error (exit 2)', () => {
		const res = runNormalizer(['--frobnicate']);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain('unknown argument');
	});

	test('a root with no packages directory is an internal error (exit 2)', () => {
		const root = mkdtempSync(path.join(realpathTmpdir(), 'normalize-empty-'));
		try {
			const res = runNormalizer(['--check', '--root', root]);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain('no packages/');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('an unparseable manifest is an internal error (exit 2), not a crash', () => {
		const root = mirrorRealPackages();
		try {
			writeFileSync(path.join(root, 'packages', 'telemetry', 'package.json'), '{ not json');
			const res = runNormalizer(['--check', '--root', root]);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain('cannot parse');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
