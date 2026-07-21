/**
 * loader.metadata.parity.test.ts
 *
 * Property test: both `loadPluginConfigWithMeta` (sync) and
 * `loadPluginConfigWithMetaAsync` (async) must produce deep-equal
 * `recovery`, `removedKeys`, `warnings`, and `config` for every fixture
 * in the battery.
 *
 * Purpose: Guards against future re-divergence in the I/O layer (sync vs async
 * file reads) and ensures the shared `buildConfigWithMeta` core produces identical
 * outputs for both entry points. If separate sync/async logic is ever reintroduced
 * or the I/O wiring drifts, this test fires immediately. It is the regression
 * guard for issue #1900 FR-4 and the architectural invariant in FR-1.
 *
 * Fixtures:
 *   1. clean config
 *   2. single typo in council (strict section)
 *   3. single typo in checkpoint (strict section)
 *   4. single typo in pr_monitor (strict section)
 *   5. invalid JSON (file-exists-but-unreadable / parse error)
 *   6. single typo in gates section
 *   7. full_auto.locked user=true / project=false
 *   8. no config files at all (defaults only)
 *   9. invalid external_skills section
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	loadPluginConfigWithMeta,
	loadPluginConfigWithMetaAsync,
} from '../../../src/config/loader';

type ParityFixture = {
	name: string;
	/** Writes the config files and returns the project directory to pass to the loaders. */
	setup: (xdgDir: string) => string;
};

describe('config/loader — sync/async parity (issue #1900 FR-4)', () => {
	let tempXdg: string;
	let originalXDG: string | undefined;

	beforeEach(() => {
		tempXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-xdg-'));
		originalXDG = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = tempXdg;
	});

	afterEach(() => {
		if (originalXDG === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXDG;
		fs.rmSync(tempXdg, { recursive: true, force: true });
	});

	function makeProjectDir(xdgDir: string, cfg: unknown): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-proj-'));
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(cfg),
		);
		return dir;
	}

	function writeUserConfigIn(xdgDir: string, cfg: unknown): void {
		const dir = path.join(xdgDir, 'opencode');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'opencode-swarm.json'),
			JSON.stringify(cfg),
		);
	}

	function makeEmptyProjectDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'parity-empty-'));
	}

	const fixtures: ParityFixture[] = [
		{
			name: 'clean config',
			setup: (xdg) => makeProjectDir(xdg, { max_iterations: 3 }),
		},
		{
			name: 'typo in council (strict section)',
			setup: (xdg) =>
				makeProjectDir(xdg, {
					council: { enabled: true, bogusCouncilKey: 42 },
				}),
		},
		{
			name: 'typo in checkpoint (strict section)',
			setup: (xdg) =>
				makeProjectDir(xdg, {
					checkpoint: { enabled: true, bogusCheckpointKey: true },
				}),
		},
		{
			name: 'typo in pr_monitor (strict section)',
			setup: (xdg) =>
				makeProjectDir(xdg, {
					pr_monitor: { enabled: false, noSuchField: 'x' },
				}),
		},
		{
			name: 'invalid JSON in project config',
			setup: (_xdg) => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-badjson-'));
				fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
				fs.writeFileSync(
					path.join(dir, '.opencode', 'opencode-swarm.json'),
					'{ this is not json',
				);
				return dir;
			},
		},
		{
			name: 'typo in gates section',
			setup: (xdg) =>
				makeProjectDir(xdg, {
					max_iterations: 6,
					gates: { unknownGateKey: { enabled: true } },
				}),
		},
		{
			name: 'full_auto.locked user=true / project=false',
			setup: (xdg) => {
				writeUserConfigIn(xdg, { full_auto: { locked: true } });
				return makeProjectDir(xdg, { full_auto: { locked: false } });
			},
		},
		{
			name: 'no config files (defaults only)',
			setup: (_xdg) => makeEmptyProjectDir(),
		},
		{
			name: 'invalid external_skills section',
			setup: (xdg) =>
				makeProjectDir(xdg, {
					max_iterations: 5,
					external_skills: { curation_enabled: 'not-a-boolean' },
				}),
		},
	];

	for (const fixture of fixtures) {
		it(`sync and async produce identical results for: ${fixture.name}`, async () => {
			// Each test gets a fresh XDG to avoid cross-fixture user-config pollution.
			const freshXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-xdg2-'));
			const savedXDG = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = freshXdg;
			let dir: string | undefined;
			try {
				dir = fixture.setup(freshXdg);
				const syncResult = loadPluginConfigWithMeta(dir);
				const asyncResult = await loadPluginConfigWithMetaAsync(dir);

				// config must be deeply equal
				expect(syncResult.config).toEqual(asyncResult.config);
				// loader-level metadata must match
				expect(syncResult.loadedFromFile).toBe(asyncResult.loadedFromFile);
				expect(syncResult.configHadErrors).toBe(asyncResult.configHadErrors);
				// recovery metadata must match
				expect(syncResult.recovery).toBe(asyncResult.recovery);
				expect(syncResult.removedKeys.sort()).toEqual(
					asyncResult.removedKeys.sort(),
				);
				expect(syncResult.warnings).toEqual(asyncResult.warnings);
			} finally {
				if (dir) fs.rmSync(dir, { recursive: true, force: true });
				process.env.XDG_CONFIG_HOME = savedXDG;
				fs.rmSync(freshXdg, { recursive: true, force: true });
			}
		});
	}
});
