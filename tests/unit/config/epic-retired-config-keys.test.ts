/**
 * Epic v2 C5 — `epic.mode.min_commits_for_signal` is retired by
 * accept-and-strip: a config carrying the key loads every Epic setting with
 * NO recovery (not an "unrecognized key" `stripped_keys` recovery), the key
 * is gone from the parsed config, the loader warns once with a precise
 * "retired" message, `/swarm config doctor` reports it (BOM-tolerant, and a
 * non-Epic doctor run reads no extra file), and the generated JSON schema
 * keeps it marked `deprecated` — under top-level `epic` and the legacy
 * `turbo.epic` path alike.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildConfigJsonSchema } from '../../../scripts/generate-config-schema';
import {
	_internals,
	loadPluginConfigWithMeta,
	resetConfigAdvisoryDedup,
} from '../../../src/config/loader';
import {
	EpicConfigSchema,
	findRetiredEpicConfigKeys,
	PluginConfigSchema,
} from '../../../src/config/schema';
import {
	collectRawRetiredEpicKeyFindings,
	runConfigDoctor,
} from '../../../src/services/config-doctor';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let sandbox: string;
let projectDir: string;
let originalXdg: string | undefined;

function writeProjectConfig(config: Record<string, unknown>): void {
	const dir = path.join(projectDir, '.opencode');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

const RETIRED_EPIC = {
	mode: {
		enabled: true,
		activation_threshold: 0.45,
		min_commits_for_signal: 20,
	},
	sizing: { min_tasks: 3 },
};
const RETIRED_CONFIG = { epic: RETIRED_EPIC };
const RETIRED_LEGACY_CONFIG = {
	turbo: { strategy: 'standard', epic: RETIRED_EPIC },
};

function retiredWarnings(): string[] {
	return getDeferredWarnings().filter((w) =>
		w.includes('retired Epic config key'),
	);
}

beforeEach(() => {
	sandbox = canonicalMkdtemp('epic-retired-keys-');
	projectDir = path.join(sandbox, 'repo');
	fs.mkdirSync(projectDir, { recursive: true });
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(sandbox, 'xdg-empty');
	fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
	clearDeferredWarnings();
	_internals.resetRetiredEpicKeyWarning();
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	fs.rmSync(sandbox, { recursive: true, force: true });
	clearDeferredWarnings();
	_internals.resetRetiredEpicKeyWarning();
});

describe('schema — accept-and-strip', () => {
	it('strips the retired key and keeps the strict mode object strict', () => {
		expect(
			EpicConfigSchema.parse({
				mode: { enabled: true, min_commits_for_signal: 5 },
			}).mode,
		).toEqual({ enabled: true, activation_threshold: 0.3 });
		expect(
			EpicConfigSchema.safeParse({ mode: { enabled: true, typo: 1 } }).success,
		).toBe(false);
	});

	it('a config with the retired key keeps the whole epic block', () => {
		const parsed = PluginConfigSchema.parse(RETIRED_CONFIG);
		expect(parsed.epic?.mode).toEqual({
			enabled: true,
			activation_threshold: 0.45,
		});
		expect(parsed.epic?.sizing?.min_tasks).toBe(3);
		const legacy = PluginConfigSchema.parse(RETIRED_LEGACY_CONFIG);
		expect(legacy.turbo?.strategy).toBe('standard');
		expect(legacy.turbo?.epic?.mode).toEqual(parsed.epic?.mode);
	});

	it('findRetiredEpicConfigKeys names each present retired key', () => {
		expect(findRetiredEpicConfigKeys(RETIRED_CONFIG)).toEqual([
			'epic.mode.min_commits_for_signal',
		]);
		expect(findRetiredEpicConfigKeys(RETIRED_LEGACY_CONFIG)).toEqual([
			'turbo.epic.mode.min_commits_for_signal',
		]);
		expect(findRetiredEpicConfigKeys({ epic: { mode: {} } })).toEqual([]);
		expect(
			findRetiredEpicConfigKeys({ turbo: { epic: { mode: {} } } }),
		).toEqual([]);
		expect(findRetiredEpicConfigKeys(null)).toEqual([]);
		expect(findRetiredEpicConfigKeys({ turbo: [] })).toEqual([]);
	});
});

describe('loader — loads the epic block and warns once', () => {
	it('loads every other Epic setting with no recovery, warning once', () => {
		writeProjectConfig(RETIRED_CONFIG);
		const first = loadPluginConfigWithMeta(projectDir);
		expect(first.recovery).toBe('none');
		expect(first.removedKeys).toEqual([]);
		expect(first.config.epic?.mode?.enabled).toBe(true);
		expect(first.config.epic?.mode?.activation_threshold).toBe(0.45);
		expect(first.config.epic?.sizing?.min_tasks).toBe(3);
		expect(
			Object.hasOwn(first.config.epic?.mode ?? {}, 'min_commits_for_signal'),
		).toBe(false);
		loadPluginConfigWithMeta(projectDir);
		const warnings = retiredWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('epic.mode.min_commits_for_signal');
		// A new session (advisory dedup reset) warns again.
		resetConfigAdvisoryDedup();
		loadPluginConfigWithMeta(projectDir);
		expect(retiredWarnings()).toHaveLength(2);
	});

	it('legacy path: migrated, and the warning names the path the user wrote', () => {
		writeProjectConfig(RETIRED_LEGACY_CONFIG);
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('none');
		expect(loaded.config.epic?.mode?.activation_threshold).toBe(0.45);
		expect(retiredWarnings()[0]).toContain(
			'turbo.epic.mode.min_commits_for_signal',
		);
	});

	it('no warning without the retired key', () => {
		writeProjectConfig({ epic: { mode: { enabled: true } } });
		loadPluginConfigWithMeta(projectDir);
		expect(retiredWarnings()).toEqual([]);
	});
});

describe('config doctor — reports the retired key', () => {
	it('emits a retired-config-key finding for the raw project config', () => {
		writeProjectConfig(RETIRED_CONFIG);
		const { config } = loadPluginConfigWithMeta(projectDir);
		const result = runConfigDoctor(config, projectDir);
		const retired = result.findings.filter(
			(f) => f.id === 'retired-config-key',
		);
		expect(retired).toHaveLength(1);
		expect(retired[0]).toMatchObject({
			path: 'epic.mode.min_commits_for_signal',
			severity: 'warn',
			autoFixable: false,
		});
		expect(result.findings.some((f) => f.id === 'unknown-config-key')).toBe(
			false,
		);
	});
});

describe('config doctor collector — BOM and no extra reads', () => {
	it('reads a BOM-prefixed config', () => {
		const dir = path.join(projectDir, '.opencode');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'opencode-swarm.json'),
			`\uFEFF${JSON.stringify(RETIRED_CONFIG)}`,
		);
		const config = PluginConfigSchema.parse(RETIRED_CONFIG);
		expect(
			collectRawRetiredEpicKeyFindings(config, projectDir).map((f) => f.path),
		).toEqual(['epic.mode.min_commits_for_signal']);
	});

	it('without an Epic block in the parsed config it reads no file', () => {
		writeProjectConfig(RETIRED_CONFIG);
		const spy = spyOn(fs, 'readFileSync');
		try {
			const config = PluginConfigSchema.parse({ max_iterations: 7 });
			expect(collectRawRetiredEpicKeyFindings(config, projectDir)).toEqual([]);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('generated JSON schema', () => {
	it('keeps the retired key, marked deprecated, at top level and in both legacy turbo branches', () => {
		const text = JSON.stringify(buildConfigJsonSchema());
		const marked = text.match(/"min_commits_for_signal":\{"deprecated":true/g);
		expect(marked?.length).toBe(3);
	});
});
