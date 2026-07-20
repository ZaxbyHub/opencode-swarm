/**
 * loader.metadata.test.ts
 *
 * Tests for the recovery metadata returned by `loadPluginConfigWithMeta`
 * and `loadPluginConfigWithMetaAsync` (issue #1900).
 *
 * Covers:
 *   - 'none' recovery for a clean config
 *   - 'stripped_keys' recovery for a gates-section typo (FR-3)
 *   - 'stripped_keys' recovery for a Zod strict-section typo
 *   - 'user_only' recovery when project config is irrecoverable
 *   - 'guardrails_defaults' recovery when everything fails
 *   - full_auto.locked OR-merge preserved in sync metadata path
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	loadPluginConfigWithMeta,
	loadPluginConfigWithMetaAsync,
} from '../../../src/config/loader';

describe('config/loader — metadata (issue #1900)', () => {
	let tempXdg: string;
	let originalXDG: string | undefined;

	beforeEach(() => {
		tempXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-xdg-'));
		originalXDG = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = tempXdg;
	});

	afterEach(() => {
		if (originalXDG === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXDG;
		fs.rmSync(tempXdg, { recursive: true, force: true });
	});

	function projectDir(cfg: unknown): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-proj-'));
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(cfg),
		);
		return dir;
	}

	function projectDirWithRaw(rawContent: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-proj-'));
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			rawContent,
		);
		return dir;
	}

	function userConfigDir(): string {
		const dir = path.join(tempXdg, 'opencode');
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	function writeUserConfig(cfg: unknown): void {
		fs.writeFileSync(
			path.join(userConfigDir(), 'opencode-swarm.json'),
			JSON.stringify(cfg),
		);
	}

	function writeRawUserConfig(rawContent: string): void {
		fs.writeFileSync(
			path.join(userConfigDir(), 'opencode-swarm.json'),
			rawContent,
		);
	}

	// 1. Clean config → recovery: 'none', no removedKeys
	describe('clean config', () => {
		it('sync: returns recovery=none and empty removedKeys', () => {
			const dir = projectDir({ max_iterations: 5 });
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.recovery).toBe('none');
				expect(meta.removedKeys).toEqual([]);
				expect(meta.warnings).toEqual([]);
				expect(meta.config.max_iterations).toBe(5);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: returns recovery=none and empty removedKeys', async () => {
			const dir = projectDir({ max_iterations: 5 });
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.recovery).toBe('none');
				expect(meta.removedKeys).toEqual([]);
				expect(meta.warnings).toEqual([]);
				expect(meta.config.max_iterations).toBe(5);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// 2. Zod strict-section typo → recovery: 'stripped_keys'
	describe('strict-section typo (council)', () => {
		it('sync: returns recovery=stripped_keys with the typo key in removedKeys', () => {
			const dir = projectDir({
				max_iterations: 7,
				council: { enabled: true, typoField: 99 },
			});
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.recovery).toBe('stripped_keys');
				expect(meta.removedKeys).toContain('council.typoField');
				expect(meta.warnings.join(' ')).toContain('council.typoField');
				expect(meta.config.max_iterations).toBe(7);
				expect(meta.config.council?.enabled).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: returns recovery=stripped_keys with the typo key in removedKeys', async () => {
			const dir = projectDir({
				max_iterations: 7,
				council: { enabled: true, typoField: 99 },
			});
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.recovery).toBe('stripped_keys');
				expect(meta.removedKeys).toContain('council.typoField');
				expect(meta.warnings.join(' ')).toContain('council.typoField');
				expect(meta.config.max_iterations).toBe(7);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// 3. Gates-section typo → recovery: 'stripped_keys' (FR-3)
	// Previously: sanitizeGatesConfig stripped silently, loadPluginConfigWithMeta
	// returned recovery:'none'. Now it must return recovery:'stripped_keys' with
	// the offending key path in removedKeys.
	describe('gates-section typo (FR-3 regression gate)', () => {
		it('sync: unknown gates section → recovery=stripped_keys with gates key in removedKeys', () => {
			const dir = projectDir({
				max_iterations: 8,
				gates: { unknownGateSection: { enabled: true } },
			});
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.recovery).toBe('stripped_keys');
				expect(meta.removedKeys).toContain('gates.unknownGateSection');
				expect(meta.warnings.join(' ')).toContain('gates.unknownGateSection');
				// Other config is preserved
				expect(meta.config.max_iterations).toBe(8);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: unknown gates section → recovery=stripped_keys with gates key in removedKeys', async () => {
			const dir = projectDir({
				max_iterations: 8,
				gates: { unknownGateSection: { enabled: true } },
			});
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.recovery).toBe('stripped_keys');
				expect(meta.removedKeys).toContain('gates.unknownGateSection');
				expect(meta.warnings.join(' ')).toContain('gates.unknownGateSection');
				expect(meta.config.max_iterations).toBe(8);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('sync: entirely invalid gates value → recovery=stripped_keys with "gates" in removedKeys', () => {
			const dir = projectDir({
				gates: 'not-an-object',
			});
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.recovery).toBe('stripped_keys');
				expect(meta.removedKeys).toContain('gates');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: entirely invalid gates value → recovery=stripped_keys with "gates" in removedKeys', async () => {
			const dir = projectDir({
				gates: 'not-an-object',
			});
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.recovery).toBe('stripped_keys');
				expect(meta.removedKeys).toContain('gates');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// 4. Invalid JSON → configHadErrors=true and fail-secure guardrails defaults.
	describe('invalid JSON in project config', () => {
		it('sync: invalid project JSON with no user config → guardrails_defaults', () => {
			const dir = projectDirWithRaw('{ not valid json');
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.configHadErrors).toBe(true);
				expect(meta.recovery).toBe('guardrails_defaults');
				expect(meta.config.guardrails?.enabled).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: invalid project JSON with no user config → guardrails_defaults', async () => {
			const dir = projectDirWithRaw('{ not valid json');
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.configHadErrors).toBe(true);
				expect(meta.recovery).toBe('guardrails_defaults');
				expect(meta.config.guardrails?.enabled).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// 5. full_auto.locked: user-level locked=true cannot be overridden by project locked=false
	describe('full_auto.locked OR-merge (FR-2)', () => {
		it('sync: user locked=true + project locked=false → merged config has locked=true', () => {
			writeUserConfig({ full_auto: { locked: true } });
			const dir = projectDir({ full_auto: { locked: false } });
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.config.full_auto?.locked).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: user locked=true + project locked=false → merged config has locked=true', async () => {
			writeUserConfig({ full_auto: { locked: true } });
			const dir = projectDir({ full_auto: { locked: false } });
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.config.full_auto?.locked).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('async: project locked=true + user locked=false → merged config has locked=true', async () => {
			writeUserConfig({ full_auto: { locked: false } });
			const dir = projectDir({ full_auto: { locked: true } });
			try {
				const meta = await loadPluginConfigWithMetaAsync(dir);
				expect(meta.config.full_auto?.locked).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('sync: project locked=true + user locked=false → merged config has locked=true', () => {
			writeUserConfig({ full_auto: { locked: false } });
			const dir = projectDir({ full_auto: { locked: true } });
			try {
				const meta = loadPluginConfigWithMeta(dir);
				expect(meta.config.full_auto?.locked).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// 6. Unrecoverable merged config → 'guardrails_defaults'
	describe('guardrails defaults fallback', () => {
		it('sync and async: irrecoverable config returns guardrails_defaults', async () => {
			// Both user and project configs are syntactically invalid JSON.
			writeRawUserConfig('not json at all -- intentionally invalid');
			const dir = projectDirWithRaw('also not json');
			try {
				const [syncMeta, asyncMeta] = await Promise.all([
					Promise.resolve(loadPluginConfigWithMeta(dir)),
					loadPluginConfigWithMetaAsync(dir),
				]);
				for (const meta of [syncMeta, asyncMeta]) {
					expect(meta.configHadErrors).toBe(true);
					expect(meta.recovery).toBe('guardrails_defaults');
					expect(meta.config.guardrails?.enabled).toBe(true);
				}
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe('user-only recovery', () => {
		it('sync and async: valid user config survives an irrecoverable project config', async () => {
			writeUserConfig({ max_iterations: 7 });
			const dir = projectDir({ council: { enabled: 'not-a-boolean' } });
			try {
				const [syncMeta, asyncMeta] = await Promise.all([
					Promise.resolve(loadPluginConfigWithMeta(dir)),
					loadPluginConfigWithMetaAsync(dir),
				]);
				for (const meta of [syncMeta, asyncMeta]) {
					expect(meta.recovery).toBe('user_only');
					expect(meta.config.max_iterations).toBe(7);
					expect(meta.warnings.join(' ')).toMatch(/project config ignored/i);
				}
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe('external_skills stripping', () => {
		it('sync and async: invalid external_skills is surfaced as stripped_keys', async () => {
			const dir = projectDir({
				max_iterations: 5,
				external_skills: { curation_enabled: 'not-a-boolean' },
			});
			try {
				const [syncMeta, asyncMeta] = await Promise.all([
					Promise.resolve(loadPluginConfigWithMeta(dir)),
					loadPluginConfigWithMetaAsync(dir),
				]);
				for (const meta of [syncMeta, asyncMeta]) {
					expect(meta.recovery).toBe('stripped_keys');
					expect(meta.removedKeys).toContain('external_skills');
					expect(meta.warnings.join(' ')).toContain('external_skills');
				}
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
