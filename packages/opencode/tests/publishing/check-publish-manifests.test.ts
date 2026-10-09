import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Publish-manifest guard tests (issue #3150).
 *
 * The guard (scripts/check-publish-manifests.mjs) is the fail-closed gate that
 * keeps `workspace:` protocol specs and stale internal pins out of published
 * manifests. These tests exercise it as a subprocess the way CI does, plus an
 * isolated --root probe for each violation class.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const GUARD = path.join(REPO_ROOT, 'scripts/check-publish-manifests.mjs');

interface GuardResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runGuard(root?: string): GuardResult {
	const args = [GUARD];
	if (root) args.push('--root', root);
	const res = spawnSync(process.execPath, args, {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Mirror of the four real manifests under a temp root (versions stay real). */
function mirrorRealPackages(): string {
	const root = mkdtempSync(path.join(realpathTmpdir(), 'guard-probe-'));
	const srcRoot = path.join(REPO_ROOT, 'packages');
	for (const name of ['core', 'opencode', 'claude-code', 'telemetry']) {
		const text = readFileSync(path.join(srcRoot, name, 'package.json'), 'utf8');
		const dir = path.join(root, 'packages', name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'package.json'), text);
	}
	return root;
}

function realpathTmpdir(): string {
	// Windows mkdtempSync + later node spawns handle the plain tmpdir fine;
	// avoid realpathSync only because it can mismatch MSYS form on this host.
	return tmpdir();
}

function writeManifest(root: string, name: string, mutate: (m: Record<string, unknown>) => void): void {
	const file = path.join(root, 'packages', name, 'package.json');
	const manifest = JSON.parse(readFileSync(file, 'utf8'));
	mutate(manifest);
	writeFileSync(file, `${JSON.stringify(manifest, null, '\t')}\n`);
}

describe('check-publish-manifests guard (issue #3150)', () => {
	test('clean repo manifests pass (GUARD_OK, exit 0)', () => {
		const res = runGuard();
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('GUARD_OK');
	});

	test('a planted workspace: spec fails closed with GUARD_DETECTED', () => {
		const root = mirrorRealPackages();
		try {
			writeManifest(root, 'core', (m) => {
				const deps = m.dependencies as Record<string, string>;
				deps['@opencode-swarm/telemetry'] = 'workspace:*';
			});
			const res = runGuard(root);
			expect(res.status).toBe(1);
			expect(res.stdout).toContain('GUARD_DETECTED');
			expect(res.stdout).toContain('workspace:');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a stale internal pin (spec != committed version) fails closed', () => {
		const root = mirrorRealPackages();
		try {
			writeManifest(root, 'opencode', (m) => {
				const deps = m.dependencies as Record<string, string>;
				deps['@opencode-swarm/core'] = '0.0.1-stale';
			});
			const res = runGuard(root);
			expect(res.status).toBe(1);
			expect(res.stdout).toContain('GUARD_DETECTED');
			expect(res.stdout).toContain('0.0.1-stale');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a root with no packages directory is a usage error (exit 2)', () => {
		const root = mkdtempSync(path.join(realpathTmpdir(), 'guard-empty-'));
		try {
			const res = runGuard(root);
			expect(res.status).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
