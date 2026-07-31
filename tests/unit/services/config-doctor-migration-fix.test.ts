/**
 * Tests for the deprecated-field migration applier (issue #1667, PRR-003).
 *
 * `/swarm config doctor` advertises available migrations and prints
 * "Run `/swarm config doctor --fix` to apply available migrations." Before this
 * fix, `--fix` never actually applied them: deprecated-field findings carried
 * `autoFixable: false`, so `applySafeAutoFixes` skipped them. These tests pin
 * the migration-applier added to `applySafeAutoFixes`: under the interactive
 * `--fix` path (`applyLossy: true`), a legacy field holding a non-default value
 * is moved to its replacement path and the legacy key is removed. The passive
 * startup path (`applyLossy: false`) must not migrate.
 *
 * New file: src/services/config-doctor.test.ts is over the FR-006 500-line cap
 * and must not grow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import { PluginConfigSchema } from '../../../src/config/schema';
import {
	applySafeAutoFixes,
	runConfigDoctor,
	runConfigDoctorWithFixes,
} from '../../../src/services/config-doctor';

const PROJECT_CONFIG = '.opencode/opencode-swarm.json';

let xdgDir: string;
let originalXDG: string | undefined;

beforeEach(() => {
	// Isolate the USER config path so only our project config is seen.
	xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-mig-xdg-'));
	originalXDG = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdgDir;
});

afterEach(() => {
	if (originalXDG === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXDG;
	}
	fs.rmSync(xdgDir, { recursive: true, force: true });
});

/** Write a project config and return its realpathSync'd directory. */
function writeProject(config: unknown): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-mig-proj-')),
	);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(path.join(dir, PROJECT_CONFIG), JSON.stringify(config));
	return dir;
}

/** Read the on-disk project config back as a parsed object. */
function readProject(dir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(dir, PROJECT_CONFIG), 'utf-8'));
}

describe('config-doctor deprecated-field migration applier (PRR-003, #1667)', () => {
	it('moves a non-default legacy field to its replacement and removes the legacy key under --fix', () => {
		const dir = writeProject({
			config_format_version: 1,
			skill_improver: { model: 'gpt-custom', fallback_models: [] },
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			expect(result.availableMigrations).toBeDefined();
			expect(result.availableMigrations!.length).toBeGreaterThan(0);

			const { appliedFixes } = applySafeAutoFixes(dir, result, {
				applyLossy: true,
			});

			// One update (set replacement) + one remove (drop legacy key).
			expect(appliedFixes.length).toBe(2);
			const onDisk = readProject(dir);

			// The migrated legacy key (`skill_improver.model`) is removed; its
			// non-default value moved to the replacement path. The at-default
			// sibling key (`fallback_models: []`) is left in place.
			const legacySi = onDisk.skill_improver as
				| Record<string, unknown>
				| undefined;
			expect(legacySi?.model).toBeUndefined();
			expect(
				(onDisk.agents as Record<string, unknown>)?.skill_improver,
			).toBeDefined();
			const moved = (onDisk.agents as Record<string, unknown>)
				.skill_improver as Record<string, unknown>;
			expect(moved.model).toBe('gpt-custom');
			// Result still parses as valid config.
			expect(PluginConfigSchema.safeParse(onDisk).success).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does NOT migrate a legacy field that holds its schema default (no-op write)', () => {
		// skill_improver.model default is null; fallback_models default is [].
		const dir = writeProject({
			config_format_version: 1,
			skill_improver: { model: null, fallback_models: [] },
			spec_writer: { model: null, fallback_models: [] },
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			// Migrations are advertised (config predates deprecatedIn)…
			expect(result.availableMigrations).toBeDefined();
			// …but there is nothing to move because every value is at its default.
			const { appliedFixes } = applySafeAutoFixes(dir, result, {
				applyLossy: true,
			});
			expect(appliedFixes.length).toBe(0);
			const onDisk = readProject(dir);
			// Legacy keys untouched.
			expect(onDisk.skill_improver).toBeDefined();
			expect(onDisk.spec_writer).toBeDefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does NOT apply migrations on the passive startup path (applyLossy: false)', () => {
		const dir = writeProject({
			config_format_version: 1,
			skill_improver: { model: 'gpt-custom', fallback_models: [] },
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			expect(result.availableMigrations).toBeDefined();
			// Passive path: no lossy opt-in.
			const { appliedFixes } = applySafeAutoFixes(dir, result, {
				applyLossy: false,
			});
			expect(appliedFixes.length).toBe(0);
			const onDisk = readProject(dir);
			// Legacy key still present, replacement absent.
			expect((onDisk.skill_improver as Record<string, unknown>)?.model).toBe(
				'gpt-custom',
			);
			expect(
				(onDisk.agents as Record<string, unknown> | undefined)?.skill_improver,
			).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('runConfigDoctorWithFixes clears the deprecated-field finding after migration', async () => {
		const dir = writeProject({
			config_format_version: 1,
			skill_improver: { model: 'gpt-custom', fallback_models: [] },
		});
		try {
			// Before fix: a deprecated-field finding is present.
			const before = runConfigDoctor(loadPluginConfig(dir), dir);
			expect(before.findings.some((f) => f.id === 'deprecated-field')).toBe(
				true,
			);

			const fix = await runConfigDoctorWithFixes(
				dir,
				loadPluginConfig(dir),
				true,
				{ applyLossy: true },
			);
			expect(fix.appliedFixes.length).toBe(2);

			// Re-read + re-run: the deprecated-field finding is gone because the
			// legacy key was removed from disk.
			const after = runConfigDoctor(loadPluginConfig(dir), dir);
			expect(after.findings.some((f) => f.id === 'deprecated-field')).toBe(
				false,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('documents the collision behavior: an explicit --fix overwrites an existing replacement value with the legacy one', () => {
		// If a user has set BOTH the legacy field and its replacement to distinct
		// values (a contradictory config), `--fix` is an explicit, confirmed
		// action that treats the legacy value as authoritative and overwrites the
		// replacement. runConfigDoctorWithFixes creates a backup first, so the
		// overwritten value is recoverable. This test pins that design decision.
		const dir = writeProject({
			config_format_version: 1,
			skill_improver: { model: 'legacy-value', fallback_models: [] },
			agents: { skill_improver: { model: 'replacement-value' } },
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const { appliedFixes } = applySafeAutoFixes(dir, result, {
				applyLossy: true,
			});
			// Migration still applies (legacy value is non-default).
			expect(appliedFixes.length).toBe(2);
			const onDisk = readProject(dir);
			const moved = (onDisk.agents as Record<string, unknown>)
				.skill_improver as Record<string, unknown>;
			// Legacy value won — replacement was overwritten.
			expect(moved.model).toBe('legacy-value');
			expect(
				(onDisk.skill_improver as Record<string, unknown> | undefined)?.model,
			).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
