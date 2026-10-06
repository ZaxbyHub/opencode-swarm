/**
 * Epic C9 — Epic settings live in the top-level `epic` block; the legacy
 * `turbo.epic` path is accepted PERMANENTLY (`src/epic/config.ts`):
 *  - top-level only: loads with no `turbo` block, no warning, no finding;
 *  - legacy only: moved to top-level `epic` before validation (no longer
 *    needs `turbo.strategy`), one advisory warning per dedup window, a
 *    report-only `legacy-epic-config-path` doctor finding;
 *  - both: within one file a per-key deep merge in which top-level `epic`
 *    wins; across files the normal precedence (project over user), whichever
 *    path each file used;
 *  - parsed configs that skip the loader resolve through the same function.
 * Non-Epic config identity against upstream is checked out-of-tree (pristine
 * comparison); here the migration's no-op contract is pinned instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	loadPluginConfigWithMeta,
	resetConfigAdvisoryDedup,
} from '../../../src/config/loader';
import { PluginConfigSchema } from '../../../src/config/schema';
import {
	isEpicModeConfigEnabled,
	LEGACY_EPIC_CONFIG_WARNING,
	migrateLegacyEpicConfig,
	resolveEpicConfig,
} from '../../../src/epic/config';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

let env: ReturnType<typeof createIsolatedTestEnv>;
let projectDir: string;

function writeConfig(file: string, config: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config));
}
const projectConfig = () =>
	path.join(projectDir, '.opencode', 'opencode-swarm.json');
const userConfig = () =>
	path.join(env.configDir, 'opencode', 'opencode-swarm.json');
const legacyWarnings = () =>
	getDeferredWarnings().filter((w) => w.includes('turbo.epic is deprecated'));
const legacyFindings = (config: Parameters<typeof runConfigDoctor>[0]) =>
	runConfigDoctor(config, projectDir).findings.filter(
		(f) => f.id === 'legacy-epic-config-path',
	);

beforeEach(() => {
	env = createIsolatedTestEnv();
	projectDir = path.join(env.configDir, 'repo');
	fs.mkdirSync(projectDir, { recursive: true });
	clearDeferredWarnings();
	_internals.resetLegacyEpicConfigWarning();
	_internals.resetRetiredEpicKeyWarning();
});

afterEach(() => {
	clearDeferredWarnings();
	_internals.resetLegacyEpicConfigWarning();
	_internals.resetRetiredEpicKeyWarning();
	env.cleanup();
});

describe('top-level epic (canonical)', () => {
	it('loads without any turbo block, warns nothing, reports nothing', () => {
		writeConfig(projectConfig(), {
			epic: { mode: { enabled: true }, sizing: { min_tasks: 3 } },
		});
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('none');
		expect(loaded.config.turbo).toBeUndefined();
		expect(loaded.config.epic?.mode).toEqual({
			enabled: true,
			activation_threshold: 0.3,
		});
		expect(loaded.config.epic?.sizing?.min_tasks).toBe(3);
		expect(isEpicModeConfigEnabled(loaded.config)).toBe(true);
		expect(legacyWarnings()).toEqual([]);
		expect(getDeferredWarnings().join('\n')).not.toContain('unknown');
		expect(legacyFindings(loaded.config)).toEqual([]);
	});
});

describe('legacy turbo.epic (accepted permanently)', () => {
	it('is moved to top-level epic, keeps turbo, warns once per dedup window', () => {
		writeConfig(projectConfig(), {
			turbo: {
				strategy: 'standard',
				epic: { mode: { enabled: true, activation_threshold: 0.5 } },
			},
		});
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('none');
		expect(loaded.config.epic?.mode).toEqual({
			enabled: true,
			activation_threshold: 0.5,
		});
		expect(loaded.config.turbo).toEqual({ strategy: 'standard' });
		expect(resolveEpicConfig(loaded.config)).toBe(loaded.config.epic);
		loadPluginConfigWithMeta(projectDir);
		expect(legacyWarnings()).toEqual([LEGACY_EPIC_CONFIG_WARNING]);
		// A new session (advisory dedup reset) warns again.
		resetConfigAdvisoryDedup();
		loadPluginConfigWithMeta(projectDir);
		expect(legacyWarnings()).toHaveLength(2);
	});

	it('no longer needs turbo.strategy: a turbo block holding only epic is dropped', () => {
		writeConfig(projectConfig(), {
			turbo: { epic: { mode: { enabled: true } } },
		});
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('none');
		expect(loaded.removedKeys).toEqual([]);
		expect(loaded.config.turbo).toBeUndefined();
		expect(isEpicModeConfigEnabled(loaded.config)).toBe(true);
	});

	it('keeps a lean turbo block intact', () => {
		const lean = { max_parallel_coders: 2 };
		writeConfig(projectConfig(), {
			turbo: { strategy: 'lean', lean, epic: { mode: { enabled: true } } },
		});
		const { config } = loadPluginConfigWithMeta(projectDir);
		expect(config.turbo?.strategy).toBe('lean');
		expect(config.turbo?.lean?.max_parallel_coders).toBe(2);
		expect(Object.hasOwn(config.turbo ?? {}, 'epic')).toBe(false);
		expect(config.epic?.mode?.enabled).toBe(true);
	});

	it('the doctor reports legacy-epic-config-path (report-only) per file', () => {
		writeConfig(projectConfig(), {
			turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
		});
		const { config } = loadPluginConfigWithMeta(projectDir);
		const findings = legacyFindings(config);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			path: 'turbo.epic',
			severity: 'warn',
			autoFixable: false,
		});
		expect(findings[0]?.proposedFix).toBeUndefined();
		expect(findings[0]?.description).toContain(projectConfig());
	});
});

describe('both paths: top-level wins within a file, project wins across files', () => {
	it('within one file', () => {
		writeConfig(projectConfig(), {
			turbo: {
				strategy: 'standard',
				epic: {
					mode: { enabled: true, activation_threshold: 0.5 },
					retain_refs: true,
					commit_policy: 'current-branch',
				},
			},
			epic: { mode: { enabled: false }, commit_policy: 'epic-branch' },
		});
		const { config } = loadPluginConfigWithMeta(projectDir);
		expect(config.epic?.mode).toEqual({
			enabled: false,
			activation_threshold: 0.5,
		});
		expect(config.epic?.commit_policy).toBe('epic-branch');
		expect(config.epic?.retain_refs).toBe(true);
		expect(isEpicModeConfigEnabled(config)).toBe(false);
		expect(legacyWarnings()).toHaveLength(1);
	});

	it('across user (legacy) and project (top-level) files', () => {
		writeConfig(userConfig(), {
			turbo: {
				strategy: 'standard',
				epic: { mode: { enabled: true }, sizing: { min_tasks: 9 } },
			},
		});
		writeConfig(projectConfig(), {
			epic: { mode: { activation_threshold: 0.7 } },
		});
		const { config } = loadPluginConfigWithMeta(projectDir);
		expect(config.epic?.mode).toEqual({
			enabled: true,
			activation_threshold: 0.7,
		});
		expect(config.epic?.sizing?.min_tasks).toBe(9);
		expect(legacyFindings(config).map((f) => f.description)).toEqual([
			expect.stringContaining(userConfig()),
		]);
	});

	it('project legacy beats user top-level (normal cross-file precedence)', () => {
		writeConfig(userConfig(), { epic: { mode: { enabled: false } } });
		writeConfig(projectConfig(), {
			turbo: { epic: { mode: { enabled: true } } },
		});
		const { config } = loadPluginConfigWithMeta(projectDir);
		expect(isEpicModeConfigEnabled(config)).toBe(true);
		expect(legacyWarnings()).toHaveLength(1);
	});

	it('project top-level beats user legacy', () => {
		writeConfig(userConfig(), {
			turbo: { epic: { mode: { enabled: true }, retain_refs: true } },
		});
		writeConfig(projectConfig(), { epic: { mode: { enabled: false } } });
		const { config } = loadPluginConfigWithMeta(projectDir);
		expect(isEpicModeConfigEnabled(config)).toBe(false);
		expect(config.epic?.retain_refs).toBe(true);
	});

	it('the user-config-alone fallback migrates (and merges) the legacy path too', () => {
		writeConfig(userConfig(), {
			turbo: { epic: { mode: { enabled: true } } },
			epic: { mode: { activation_threshold: 0.7 } },
		});
		// A wrong-type value that targeted recovery cannot strip.
		writeConfig(projectConfig(), { max_iterations: 'many' });
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('user_only');
		// Unmigrated, the strategy-less turbo block would fail the user parse
		// and top-level `epic` would win whole (enabled: false).
		expect(loaded.config.epic?.mode).toEqual({
			enabled: true,
			activation_threshold: 0.7,
		});
		expect(loaded.config.turbo).toBeUndefined();
	});
});

describe('migrateLegacyEpicConfig / resolveEpicConfig contracts', () => {
	it('returns the same object when there is no legacy key (non-Epic no-op)', () => {
		for (const raw of [
			{},
			{ turbo: { strategy: 'standard' } },
			{ epic: { mode: { enabled: true } } },
			{ turbo: 'x' },
			{ max_iterations: 3 },
		]) {
			expect(migrateLegacyEpicConfig(raw)).toBe(raw);
		}
	});

	it('moves a malformed legacy value as-is (validation reports it at epic) unless top-level is set', () => {
		expect(migrateLegacyEpicConfig({ turbo: { epic: 7 } })).toEqual({
			epic: 7,
		});
		expect(
			migrateLegacyEpicConfig({
				turbo: { epic: 7 },
				epic: { retain_refs: true },
			}),
		).toEqual({ epic: { retain_refs: true } });
	});

	it('a parsed config skipping the loader falls back to turbo.epic; top-level wins whole', () => {
		const legacy = PluginConfigSchema.parse({
			turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
		});
		expect(isEpicModeConfigEnabled(legacy)).toBe(true);
		const both = PluginConfigSchema.parse({
			turbo: { strategy: 'standard', epic: { retain_refs: true } },
			epic: { mode: { enabled: true } },
		});
		expect(resolveEpicConfig(both)?.retain_refs).toBeUndefined();
		expect(resolveEpicConfig(undefined)).toBeUndefined();
		expect(resolveEpicConfig({})).toBeUndefined();
	});
});
