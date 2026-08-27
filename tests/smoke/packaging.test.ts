import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import {
	captureFileBytes,
	expectFileBytesUnchanged,
} from '../helpers/test-isolation.js';

const ROOT = path.resolve(import.meta.dir, '../../');
const MAIN_BUNDLE_MAX_BYTES = 8.5 * 1024 * 1024;

/**
 * Issue #2010 isolation for the one test below that BOOTS the shipped bundle.
 *
 * `directory: ROOT` is deliberate and load-bearing for a *packaging* smoke
 * test: it proves the published artifact boots against a real checkout — with a
 * real `.opencode/opencode-swarm.json`, a real `.git`, real `node_modules` —
 * not just against an empty temp dir (`tests/unit/build/throw-and-verify-located.test.ts`
 * already covers the bare-temp-dir shape). Keeping ROOT means the boot's side
 * effects have to be contained rather than relocated:
 *
 *   1. `createIsolatedTestEnv()` repoints `XDG_CONFIG_HOME` (and friends) at a
 *      temp root, so config-doctor's global fallback can never read or rewrite
 *      the developer's real `~/.config/opencode/opencode-swarm.json`.
 *   2. `overrideIndexInternalsForTest` — re-exported by `dist/index.js`, so the
 *      seam IS reachable for a bundle import — stubs the post-resolution queue
 *      that is config-doctor's only caller, which also stops the unref'd
 *      background tasks from writing `.swarm/locks/` after teardown.
 *   3. Whatever `.swarm/` state the synchronous init path still creates in the
 *      checkout (`config.example.json`, `evidence/`, `telemetry.jsonl`) is
 *      removed afterwards. Only entries this test introduced are deleted, so a
 *      developer's pre-existing `.swarm/` working state survives untouched.
 *   4. The tracked `.opencode/opencode-swarm.json` is asserted byte-identical.
 */
const SWARM_DIR = path.join(ROOT, '.swarm');
const TRACKED_PROJECT_CONFIG = path.join(
	ROOT,
	'.opencode',
	'opencode-swarm.json',
);

let swarmDirExisted = false;
let swarmEntriesBefore = new Set<string>();
let trackedProjectConfigBefore: Buffer | null = null;
let restoreIsolatedEnv: () => void = () => {};
let restoreBundleInternals: () => void = () => {};

beforeAll(async () => {
	swarmDirExisted = existsSync(SWARM_DIR);
	swarmEntriesBefore = new Set(swarmDirExisted ? readdirSync(SWARM_DIR) : []);
	trackedProjectConfigBefore = captureFileBytes(TRACKED_PROJECT_CONFIG);
	restoreIsolatedEnv = createIsolatedTestEnv().cleanup;
	const mod = await import(path.join(ROOT, 'dist/index.js'));
	restoreBundleInternals = mod.overrideIndexInternalsForTest({
		schedulePostResolutionTasks: () => {},
	});
});

afterAll(() => {
	// Restore the module seam FIRST: if a later step throws, the override must
	// already be off so it cannot leak into the next test file.
	restoreBundleInternals();
	restoreBundleInternals = () => {};
	restoreIsolatedEnv();
	restoreIsolatedEnv = () => {};
	// Best-effort: `initTelemetry` runs on the SYNCHRONOUS init path
	// (src/index.ts), so the post-resolution scheduler stub above does not
	// prevent it, and it holds an open write stream on
	// `<directory>/.swarm/telemetry.jsonl`. Because this file boots the shipped
	// bundle against ROOT, that handle is on the repo's own `.swarm/`, and
	// `resetTelemetryForTesting` is not re-exported from `dist/index.js`, so it
	// cannot be closed from here. Removing a directory that still holds an open
	// handle raises EBUSY/EPERM on Windows — the same failure
	// `src/index.observability-init-resilience.test.ts` documents from a real
	// `unit (windows-latest)` run. Cleanup is a courtesy; the byte guard below
	// is the actual assertion, so it must stay reachable either way.
	const removeQuietly = (target: string): void => {
		try {
			rmSync(target, { recursive: true, force: true, maxRetries: 5 });
		} catch {
			/* leftover artifacts are litter, not a test failure */
		}
	};
	if (existsSync(SWARM_DIR)) {
		if (swarmDirExisted) {
			for (const entry of readdirSync(SWARM_DIR)) {
				if (swarmEntriesBefore.has(entry)) continue;
				removeQuietly(path.join(SWARM_DIR, entry));
			}
		} else {
			removeQuietly(SWARM_DIR);
		}
	}
	expectFileBytesUnchanged(TRACKED_PROJECT_CONFIG, trackedProjectConfigBefore);
});

describe('packaging smoke tests', () => {
	test('dist/index.js exists', () => {
		expect(existsSync(path.join(ROOT, 'dist/index.js'))).toBe(true);
	});

	test('dist/index.d.ts exists', () => {
		expect(existsSync(path.join(ROOT, 'dist/index.d.ts'))).toBe(true);
	});

	test('dist/cli/index.js exists', () => {
		expect(existsSync(path.join(ROOT, 'dist/cli/index.js'))).toBe(true);
	});

	test('dist/index.js is importable and exports a v1 plugin object', async () => {
		const mod = await import(path.join(ROOT, 'dist/index.js'));
		expect(typeof mod.default).toBe('object');
		expect(mod.default).toHaveProperty('id');
		expect(mod.default).toHaveProperty('server');
	});

	test('v1 plugin object has correct id and server properties', async () => {
		const mod = await import(path.join(ROOT, 'dist/index.js'));
		expect(mod.default.id).toBe('opencode-swarm');
		expect(typeof mod.default.server).toBe('function');
	});

	test('server function returns plugin object with config hook', async () => {
		const mod = await import(path.join(ROOT, 'dist/index.js'));
		const plugin = await mod.default.server({ directory: ROOT });
		expect(plugin.config).toBeDefined();
		expect(typeof plugin.config).toBe('function');
	});

	test('dist/index.js file size is reasonable (< 8.5MiB)', () => {
		const stats = Bun.file(path.join(ROOT, 'dist/index.js'));
		// The main bundle is built with identifier-preserving minification
		// (`--minify-whitespace --minify-syntax`, no `--minify-identifiers`).
		// Bumped 7.5 -> 8.5 MiB for issue #2105's durable worktree-recovery
		// infrastructure (see docs/releases/pending/ci-bundle-size-cap-flake.md
		// for the bump history and cross-platform build-variance rationale): the
		// bundle crossed 7.5 MiB after normal source growth, exactly
		// the "will eventually approach the cap and need another bump" case that
		// doc calls out. The exact merged size is still rechecked after every build.
		expect(stats.size).toBeLessThan(MAIN_BUNDLE_MAX_BYTES);
		// But should be at least 10KB (non-empty)
		expect(stats.size).toBeGreaterThan(10 * 1024);
	});

	test('dist/cli/index.js file size is reasonable (< 2.4MB)', () => {
		const stats = Bun.file(path.join(ROOT, 'dist/cli/index.js'));
		// CLI bundle should be under 2.4MB (raised from 2.2MB due to #1234
		// auto-triage commands + success-motif learning machinery plus
		// first-class full-auto toggle — status subcommand, mode parsing)
		expect(stats.size).toBeLessThan(2.4 * 1024 * 1024);
		// But should be at least 1KB (non-empty)
		expect(stats.size).toBeGreaterThan(1 * 1024);
	});

	test('package.json has no postinstall script', async () => {
		const pkg = await import(path.join(ROOT, 'package.json'), {
			with: { type: 'json' },
		});
		expect(pkg.default?.scripts?.postinstall).toBeUndefined();
	});

	test('dist/lang/grammars/ directory exists with WASM files', () => {
		const grammarsDir = path.join(ROOT, 'dist/lang/grammars');
		expect(existsSync(grammarsDir)).toBe(true);
		// Should contain at least one .wasm file
		const { readdirSync } = require('node:fs');
		const wasmFiles = readdirSync(grammarsDir).filter((f: string) =>
			f.endsWith('.wasm'),
		);
		expect(wasmFiles.length).toBeGreaterThan(0);
	});
});
