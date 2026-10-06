/**
 * Epic C9 — the legacy `turbo.epic` path in config VALIDATION reporting:
 *  - `/swarm config doctor`'s raw re-reads validate each file as the loader
 *    does (legacy block moved to top-level `epic` first), so a strategy-less
 *    legacy block raises no false `turbo.strategy` error and a problem inside
 *    it is reported at the path the user wrote (`turbo.epic.*`);
 *  - loader recovery labels keys that came from `turbo.epic` with
 *    `(from turbo.epic)`, and only those.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	loadPluginConfigWithMeta,
} from '../../../src/config/loader';
import {
	annotateLegacyEpicKeys,
	legacyEpicIssuePath,
} from '../../../src/epic/config';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

let env: ReturnType<typeof createIsolatedTestEnv>;
let projectDir: string;

function writeProject(config: Record<string, unknown>): void {
	const file = path.join(projectDir, '.opencode', 'opencode-swarm.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config));
}

function doctorFindings() {
	const { config } = loadPluginConfigWithMeta(projectDir);
	return runConfigDoctor(config, projectDir).findings.map((f) => ({
		id: f.id,
		path: f.path,
		severity: f.severity,
	}));
}

beforeEach(() => {
	env = createIsolatedTestEnv();
	projectDir = path.join(env.configDir, 'repo');
	fs.mkdirSync(projectDir, { recursive: true });
	clearDeferredWarnings();
	_internals.resetLegacyEpicConfigWarning();
});

afterEach(() => {
	clearDeferredWarnings();
	_internals.resetLegacyEpicConfigWarning();
	env.cleanup();
});

describe('config doctor validates legacy files as the loader does', () => {
	it('a strategy-less legacy block raises no turbo.strategy error', () => {
		writeProject({ turbo: { epic: { mode: { enabled: true } } } });
		const findings = doctorFindings();
		expect(findings.filter((f) => f.id === 'invalid-config-value')).toEqual([]);
		expect(findings.map((f) => f.id)).toContain('legacy-epic-config-path');
	});

	it('a typo under a legacy block is reported at turbo.epic.*', () => {
		writeProject({
			turbo: { epic: { mode: { enabled: true, typo_key: 1 } } },
		});
		expect(
			doctorFindings().filter((f) => f.id === 'unknown-config-key'),
		).toEqual([
			{
				id: 'unknown-config-key',
				path: 'turbo.epic.mode.typo_key',
				severity: 'warn',
			},
		]);
	});

	it('an invalid value under a legacy block is reported at turbo.epic.*', () => {
		writeProject({
			turbo: { strategy: 'standard', epic: { mode: { enabled: 'yes' } } },
		});
		const invalid = doctorFindings().filter(
			(f) => f.id === 'invalid-config-value',
		);
		expect(invalid.map((f) => f.path)).toEqual(['turbo.epic.mode.enabled']);
	});

	it('a typo under top-level epic keeps its epic.* path', () => {
		writeProject({ epic: { mode: { enabled: true, typo_key: 1 } } });
		expect(
			doctorFindings()
				.filter((f) => f.id === 'unknown-config-key')
				.map((f) => f.path),
		).toEqual(['epic.mode.typo_key']);
	});
});

describe('loader recovery labels keys from turbo.epic', () => {
	it('labels a recovered legacy key and nothing else', () => {
		writeProject({
			max_iterations: 4,
			turbo: { epic: { mode: { enabled: true, typo_key: 1 } } },
			epic: { cochange: { enabled: true, typo_two: 1 } },
		});
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('stripped_keys');
		expect([...loaded.removedKeys].sort()).toEqual([
			'epic.cochange.typo_two',
			'epic.mode.typo_key (from turbo.epic)',
		]);
		expect(loaded.config.max_iterations).toBe(4);
		expect(loaded.config.epic?.mode?.enabled).toBe(true);
	});

	it('annotateLegacyEpicKeys returns the keys untouched without a legacy file', () => {
		const keys = ['epic.mode.x', 'council.y'];
		expect(annotateLegacyEpicKeys(keys, [{ epic: {} }, null])).toBe(keys);
		expect(
			annotateLegacyEpicKeys(
				['epic', 'turbo.lean.z'],
				[{ turbo: { epic: 1 } }],
			),
		).toEqual(['epic (from turbo.epic)', 'turbo.lean.z']);
	});

	it('legacyEpicIssuePath maps back only for a legacy-only file', () => {
		const legacyOnly = { turbo: { epic: {} } };
		expect(legacyEpicIssuePath(legacyOnly, ['epic', 'mode'])).toEqual([
			'turbo',
			'epic',
			'mode',
		]);
		expect(legacyEpicIssuePath(legacyOnly, ['council', 'x'])).toEqual([
			'council',
			'x',
		]);
		expect(
			legacyEpicIssuePath({ ...legacyOnly, epic: {} }, ['epic', 'mode']),
		).toEqual(['epic', 'mode']);
		expect(legacyEpicIssuePath({ epic: {} }, ['epic'])).toEqual(['epic']);
	});
});
