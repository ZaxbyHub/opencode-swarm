import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/config/index';
import { loadPluginConfigWithMetaAsync } from '../../../src/config/loader';

/**
 * FR-001 regression tests: metadata exposure for loadPluginConfigWithMeta.
 * Issue #1690 - SC-001.1 through SC-001.7.
 *
 * The 5 strict sections are: gates, council, checkpoint, pr_monitor, turbo.epic.
 *
 * NOTE: gates uses pre-Zod sanitizeGatesConfig (loader.ts:210-289) which
 * strips unknown keys before Zod sees them. Recovery metadata (stripped_keys)
 * is NOT produced for gates - unknown keys are silently removed and the
 * config parses cleanly. The other 4 sections (council, checkpoint,
 * pr_monitor, turbo.epic) use .strict() Zod schemas and DO produce
 * recovery metadata when unknown keys are encountered.
 */

function writeProjectConfig(cfg: unknown): string {
	const projectDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'meta-test-project-'),
	);
	fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(cfg),
	);
	return projectDir;
}

describe('config/loader -- FR-001 metadata exposure (#1690)', () => {
	let tempDir: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-test-xdg-'));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = tempDir;
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// SC-001.4: clean parse
	describe('SC-001.4 -- clean load produces empty recovery fields', () => {
		it('recovery === none, removedKeys === [], warnings === [] on valid config', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				memory: { enabled: true },
				gates: { enabled: true },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('none');
			expect(result.removedKeys).toEqual([]);
			expect(result.warnings).toEqual([]);
			expect(result.config.max_iterations).toBe(9);
			expect(result.config.memory?.enabled).toBe(true);
		});

		it('clean load with only optional sections present', () => {
			const projectDir = writeProjectConfig({
				gates: { syntax_check: { enabled: true } },
				council: { enabled: false },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('none');
			expect(result.removedKeys).toEqual([]);
			expect(result.warnings).toEqual([]);
			expect(result.config.gates?.syntax_check?.enabled).toBe(true);
		});
	});

	// SC-001.1: council is the clearest example of the strict-schema recovery
	describe('SC-001.1 -- council section malformed key (strict-schema recovery)', () => {
		it('strips the unknown council key and returns stripped_keys recovery', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				council: { enabled: true, maxRounds: 4, unknownCouncilKey: 1 },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys).toContain('council.unknownCouncilKey');
			expect(result.removedKeys.length).toBeGreaterThan(0);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings[0]).toContain('council');
			expect(result.config.max_iterations).toBe(9);
			expect(result.config.council?.enabled).toBe(true);
		});
	});

	// SC-001.2: gates uses pre-Zod sanitization (no recovery metadata)
	describe('SC-001.2 -- gates section uses pre-Zod sanitization (no recovery metadata)', () => {
		it('strips unknown gates key silently without recovery metadata', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				gates: { enabled: true, totallyBogusGateKey: true },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			// gates uses sanitizeGatesConfig before Zod: no recovery metadata produced
			expect(result.recovery).toBe('none');
			expect(result.removedKeys).toEqual([]);
			expect(result.warnings).toEqual([]);
			// valid sections still preserved
			expect(result.config.max_iterations).toBe(9);
		});

		it('nested unknown key in gate subsection is also sanitized silently', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 5,
				gates: { syntax_check: { enabled: true, bogusNestedKey: 1 } },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('none');
			expect(result.removedKeys).toEqual([]);
			expect(result.config.max_iterations).toBe(5);
		});
	});

	// SC-001.3: non-stripped recovery paths (user_only, guardrails_defaults)
	describe('SC-001.3 -- non-stripped recovery: user_only and guardrails_defaults', () => {
		it('user_only: project has type error; user config valid → falls back to user alone', () => {
			// User config (via XDG_CONFIG_HOME) is minimal valid.
			const userConfigPath = path.join(
				tempDir,
				'opencode',
				'opencode-swarm.json',
			);
			fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
			fs.writeFileSync(
				userConfigPath,
				JSON.stringify({ max_iterations: 7, gates: { enabled: true } }),
				'utf-8',
			);
			// Project config has a Zod type error (council.enabled: "yes" instead of boolean)
			// that survives the unrecognized_keys strip.
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				council: { enabled: 'yes' as unknown as boolean },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('user_only');
			expect(result.warnings.length).toBeGreaterThan(0);
			const warningsText = result.warnings.join(' ');
			expect(warningsText).toMatch(/user config|Project config ignored/i);
			// user config is applied (not project overrides)
			expect(result.config.max_iterations).toBe(7);
		});

		it('guardrails_defaults: project config file exists with invalid JSON → ultimate fallback', () => {
			// XDG_CONFIG_HOME has no user config (clean).
			// Project config file exists but contains INVALID JSON (not parseable),
			// which sets configHadErrors=true and triggers guardrails_defaults fallback.
			const projectDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'meta-test-guardrails-'),
			);
			fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, '.opencode', 'opencode-swarm.json'),
				'this is not valid JSON at all { unclosed',
				'utf-8',
			);
			try {
				const result = _internals.loadPluginConfigWithMeta(projectDir);
				// guardrails_defaults recovery (file existed, content invalid, ultimate fallback)
				expect(result.recovery).toBe('guardrails_defaults');
				expect(result.warnings.length).toBeGreaterThan(0);
				const warningsText = result.warnings.join(' ');
				expect(warningsText).toMatch(/SECURITY|Falling back|guardrails/i);
				// guardrails ENABLED forced
				expect(result.config.guardrails?.enabled).toBe(true);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	// SC-001.5: backward compat — configHadErrors + loadedFromFile still present
	describe('SC-001.5 -- backward compat: existing metadata fields retained', () => {
		it('configHadErrors and loadedFromFile are present alongside the new recovery fields', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				gates: { enabled: true },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			// existing fields present
			expect(typeof result.configHadErrors).toBe('boolean');
			expect(typeof result.loadedFromFile).toBe('boolean');
			// new fields present (SC-001.1/SC-001.3/...)
			expect([
				'none',
				'stripped_keys',
				'user_only',
				'guardrails_defaults',
			]).toContain(result.recovery);
			expect(Array.isArray(result.removedKeys)).toBe(true);
			expect(Array.isArray(result.warnings)).toBe(true);
		});
	});

	// SC-001.6: 4 strict sections (gates excluded - uses pre-Zod sanitization)
	describe('SC-001.6 -- regression: malformed key in each of 4 Zod-strict sections', () => {
		it('metadata lists all 4 stripped keys; gates sanitized silently', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				gates: { enabled: true, gatesBogusKey: 'val' },
				council: { enabled: true, councilBogusKey: 1 },
				checkpoint: { enabled: true, checkpointBogusKey: 1 },
				pr_monitor: { enabled: true, prMonitorBogusKey: 1 },
				turbo: {
					strategy: 'standard',
					epic: {
						enabled: false,
						mode: { enabled: false },
						calibration: { enabled: true },
						turboEpicBogusKey: 'val',
					},
				},
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			// 4 strict sections produce removedKeys
			expect(result.removedKeys).toContain('council.councilBogusKey');
			expect(result.removedKeys).toContain('checkpoint.checkpointBogusKey');
			expect(result.removedKeys).toContain('pr_monitor.prMonitorBogusKey');
			expect(result.removedKeys).toContain('turbo.epic.turboEpicBogusKey');
			// gates is sanitized pre-Zod: no recovery metadata
			expect(result.removedKeys.some((k) => k.includes('gates'))).toBe(false);
			// warnings cite the 4 strict sections
			const warningsText = result.warnings.join(' ');
			expect(warningsText).toContain('council');
			expect(warningsText).toContain('checkpoint');
			expect(warningsText).toContain('pr_monitor');
			expect(warningsText).toContain('turbo');
			// valid sections survive
			expect(result.config.max_iterations).toBe(9);
			expect(result.config.council?.enabled).toBe(true);
			expect(result.config.checkpoint?.enabled).toBe(true);
		});
	});

	// SC-001.7: per-section tests for non-gates strict sections
	describe('SC-001.7 -- per-section malformed key: checkpoint', () => {
		it('checkpoint with unknown key triggers stripped_keys recovery', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 7,
				checkpoint: { enabled: true, checkpointBogusKey: 1 },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys).toContain('checkpoint.checkpointBogusKey');
			expect(result.warnings[0]).toContain('checkpoint');
			expect(result.config.max_iterations).toBe(7);
		});
	});

	describe('SC-001.7 -- per-section malformed key: pr_monitor', () => {
		it('pr_monitor with unknown key triggers stripped_keys recovery', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 6,
				pr_monitor: { enabled: true, prMonitorBogusKey: true },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys).toContain('pr_monitor.prMonitorBogusKey');
			expect(result.warnings[0]).toContain('pr_monitor');
			expect(result.config.max_iterations).toBe(6);
		});
	});

	describe('SC-001.7 -- per-section malformed key: turbo.epic', () => {
		it('turbo.epic with unknown key triggers stripped_keys recovery', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 5,
				turbo: {
					strategy: 'standard',
					epic: {
						enabled: false,
						mode: { enabled: false },
						calibration: { enabled: true },
						epicBogusKey: 'val',
					},
				},
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys.some((k) => k.includes('turbo'))).toBe(true);
			expect(result.warnings[0]).toContain('turbo');
			expect(result.config.max_iterations).toBe(5);
		});
	});

	describe('SC-001.7 -- per-section malformed key: council', () => {
		it('council with unknown key triggers stripped_keys recovery', () => {
			const projectDir = writeProjectConfig({
				max_iterations: 4,
				council: { enabled: false, councilBogusKey: 1 },
			});
			const result = _internals.loadPluginConfigWithMeta(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys).toContain('council.councilBogusKey');
			expect(result.warnings[0]).toContain('council');
			expect(result.config.max_iterations).toBe(4);
		});
	});

	// Async variant
	describe('SC-001 async -- loadPluginConfigWithMetaAsync parity', () => {
		it('async: clean load returns same metadata shape as sync', async () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				memory: { enabled: true },
			});
			const syncResult = _internals.loadPluginConfigWithMeta(projectDir);
			const asyncResult = await loadPluginConfigWithMetaAsync(projectDir);
			expect(asyncResult.recovery).toBe('none');
			expect(asyncResult.removedKeys).toEqual([]);
			expect(asyncResult.warnings).toEqual([]);
			expect(asyncResult.recovery).toBe(syncResult.recovery);
			expect(asyncResult.config.max_iterations).toBe(9);
		});

		it('async: council typo returns stripped_keys with correct removedKeys', async () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				council: { enabled: true, asyncCouncilBogus: 1 },
			});
			const result = await loadPluginConfigWithMetaAsync(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys).toContain('council.asyncCouncilBogus');
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings[0]).toContain('council');
			expect(result.config.max_iterations).toBe(9);
		});

		it('async: 4 Zod-strict sections malformed -- all keys listed in removedKeys', async () => {
			const projectDir = writeProjectConfig({
				max_iterations: 9,
				council: { enabled: true, asyncCouncilBogus: 1 },
				checkpoint: { enabled: true, asyncCheckpointBogus: 1 },
				pr_monitor: { enabled: true, asyncPrMonitorBogus: 1 },
				turbo: {
					strategy: 'standard',
					epic: {
						enabled: false,
						mode: { enabled: false },
						calibration: { enabled: true },
						asyncTurboEpicBogus: 'val',
					},
				},
			});
			const result = await loadPluginConfigWithMetaAsync(projectDir);
			expect(result.recovery).toBe('stripped_keys');
			expect(result.removedKeys).toContain('council.asyncCouncilBogus');
			expect(result.removedKeys).toContain('checkpoint.asyncCheckpointBogus');
			expect(result.removedKeys).toContain('pr_monitor.asyncPrMonitorBogus');
			expect(result.removedKeys.some((k) => k.includes('turbo.epic'))).toBe(
				true,
			);
			expect(result.warnings.length).toBeGreaterThan(0);
		});

		it('async: guardrails_defaults recovery surfaces SECURITY warning (parity with sync)', async () => {
			// Project config file exists but contains invalid JSON — configHadErrors=true.
			const projectDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'meta-async-guard-'),
			);
			fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, '.opencode', 'opencode-swarm.json'),
				'this is not valid JSON { unclosed',
				'utf-8',
			);
			try {
				const result = await loadPluginConfigWithMetaAsync(projectDir);
				expect(result.recovery).toBe('guardrails_defaults');
				expect(result.warnings.length).toBeGreaterThan(0);
				expect(result.warnings[0]).toMatch(/SECURITY|Falling back|guardrails/i);
				expect(result.config.guardrails?.enabled).toBe(true);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});
});
