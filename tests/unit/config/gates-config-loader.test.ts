/**
 * Issue #2524 — loader-side guarantees for the `gates.*` config section:
 *
 *  - `GATE_CONFIG_KNOWN_SECTION_KEYS` is derived from `GATE_SECTION_SCHEMAS`
 *    (the hand-maintained copy omitted `placeholder_scan.sentinel_allowlist`,
 *    which made the loader strip a real schema key as "unknown").
 *  - discarded `gates.*` keys are user-visible: the advisory reaches the
 *    deferred-warning buffer that `/swarm diagnose` renders, and the config
 *    doctor reports them as findings.
 *  - `rawGates` / `loadGateOverrides` expose ONLY the keys the user actually
 *    wrote (no Zod-default materialization) — the parsed `config.gates`
 *    section still materializes defaults, and the contrast is the pin.
 *  - repeated loads dedup identical gates advisories (gate tools self-load
 *    per invocation; without dedup they would flood the 50-slot buffer).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as loaderInternals,
	loadPluginConfigWithMeta,
} from '../../../src/config/loader';
import {
	GATE_CONFIG_KNOWN_SECTION_KEYS,
	GATE_SECTION_SCHEMAS,
} from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let xdgDir: { dir: string; cleanup: () => void } | undefined;
let originalXdg: string | undefined;
let project: { dir: string; cleanup: () => void } | undefined;

beforeAll(() => {
	xdgDir = createSafeTestDir('gates-loader-xdg-');
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdgDir.dir;
});

afterAll(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	xdgDir?.cleanup();
});

beforeEach(() => {
	project = createSafeTestDir('gates-loader-');
	clearDeferredWarnings();
	loaderInternals.resetGatesAdvisoryDedup();
});

afterEach(() => {
	project?.cleanup();
	project = undefined;
	clearDeferredWarnings();
});

function writeGatesConfig(gates: unknown): string {
	const { dir } = project ?? {};
	if (!dir) throw new Error('writeGatesConfig called outside a test body');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ gates }, null, 2),
	);
	return dir;
}

describe('GATE_CONFIG_KNOWN_SECTION_KEYS derivation', () => {
	test('exactly mirrors the GATE_SECTION_SCHEMAS field sets', () => {
		expect(Object.keys(GATE_CONFIG_KNOWN_SECTION_KEYS).sort()).toEqual(
			Object.keys(GATE_SECTION_SCHEMAS).sort(),
		);
		for (const [section, schema] of Object.entries(GATE_SECTION_SCHEMAS)) {
			expect(GATE_CONFIG_KNOWN_SECTION_KEYS[section]).toEqual(
				Object.keys(schema.shape),
			);
		}
	});

	test('includes placeholder_scan.sentinel_allowlist (the false-strip regression)', () => {
		expect(GATE_CONFIG_KNOWN_SECTION_KEYS.placeholder_scan).toContain(
			'sentinel_allowlist',
		);
	});
});

describe('gates sanitize: real keys survive, unknown keys are visible', () => {
	test('placeholder_scan.sentinel_allowlist survives with no warning or doctor finding', () => {
		const dir = writeGatesConfig({
			placeholder_scan: {
				enabled: true,
				sentinel_allowlist: ['ALLOWED-SENTINEL'],
			},
		});
		const meta = loadPluginConfigWithMeta(dir);

		expect(meta.removedKeys).not.toContain(
			'gates.placeholder_scan.sentinel_allowlist',
		);
		expect(meta.config.gates?.placeholder_scan?.sentinel_allowlist).toEqual([
			'ALLOWED-SENTINEL',
		]);
		expect(
			getDeferredWarnings().some((w) => w.includes('sentinel_allowlist')),
		).toBe(false);

		const doctor = runConfigDoctor(meta.config, dir);
		expect(
			doctor.findings.some(
				(f) => f.path === 'gates.placeholder_scan.sentinel_allowlist',
			),
		).toBe(false);
	});

	test('unknown gates section and key are stripped, warned, and reported by the doctor', () => {
		const dir = writeGatesConfig({
			typo_section: { enabled: true },
			placeholder_scan: { enabled: true, patterns: ['TODO'] },
		});
		const meta = loadPluginConfigWithMeta(dir);

		expect(meta.removedKeys).toContain('gates.typo_section');
		expect(meta.removedKeys).toContain('gates.placeholder_scan.patterns');

		// The deferred-warning buffer is what /swarm diagnose renders — the
		// user-visible surface for a discarded key (issue #2524 obligation).
		const warnings = getDeferredWarnings();
		expect(
			warnings.some((w) =>
				w.includes('Unknown gates config section "gates.typo_section"'),
			),
		).toBe(true);
		expect(
			warnings.some((w) =>
				w.includes(
					'Unknown gates config key "gates.placeholder_scan.patterns"',
				),
			),
		).toBe(true);

		const doctor = runConfigDoctor(meta.config, dir);
		expect(
			doctor.findings.some(
				(f) =>
					f.id === 'unknown-gates-section' && f.path === 'gates.typo_section',
			),
		).toBe(true);
		expect(
			doctor.findings.some(
				(f) =>
					f.id === 'unknown-gates-key' &&
					f.path === 'gates.placeholder_scan.patterns',
			),
		).toBe(true);
	});

	test('repeated loads emit each distinct gates advisory once (buffer-flood dedup)', () => {
		const dir = writeGatesConfig({ typo_section: { enabled: true } });
		loadPluginConfigWithMeta(dir);
		loadPluginConfigWithMeta(dir);
		const matching = getDeferredWarnings().filter((w) =>
			w.includes('gates.typo_section'),
		);
		expect(matching).toHaveLength(1);
	});
});

describe('rawGates: only user-written keys, no Zod-default materialization', () => {
	test('user-written keys are exposed as-is while parsed config materializes defaults', () => {
		const dir = writeGatesConfig({
			syntax_check: { enabled: false },
			placeholder_scan: { enabled: true },
		});
		const meta = loadPluginConfigWithMeta(dir);

		expect(meta.rawGates).toEqual({
			syntax_check: { enabled: false },
			placeholder_scan: { enabled: true },
		});
		// The parsed section DOES materialize field defaults — the contrast is
		// the point: tools must consult rawGates, not the parsed section.
		expect(meta.config.gates?.placeholder_scan?.deny_patterns).toBeDefined();
		expect(meta.rawGates?.placeholder_scan).not.toHaveProperty('deny_patterns');
	});

	test('absent when the config has no gates section', () => {
		const { dir } = project ?? {};
		if (!dir) throw new Error('fixture missing');
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ turbo_mode: false }),
		);
		const meta = loadPluginConfigWithMeta(dir);
		expect(meta.rawGates).toBeUndefined();
		expect(meta.config.gates).toBeUndefined();
	});
});
