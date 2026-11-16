/**
 * Defaults-flip upgrade-path tests (issue #2504, governed v8 defaults-flip
 * frame).
 *
 * Pins the v7→v8 upgrade contract:
 *  - a v7-era config (config_format_version 1, no preset) gets `defaults-flip`
 *    info findings naming each governed default change, its kill switch, and
 *    the conservative preset;
 *  - `runConfigDoctorWithFixes` with `applyLossy: true` (the interactive
 *    `/swarm config doctor --fix` path) acknowledges the changes by stamping
 *    `config_format_version: 3` on disk — idempotently;
 *  - the passive doctor NEVER writes (negative assertion);
 *  - the legacy rename migrations keep advertising at version 1 and are
 *    unchanged by the defaults-flip rows.
 *
 * New file (FR-006): src/services/config-doctor.test.ts is over the cap.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import {
	CURRENT_CONFIG_FORMAT_VERSION,
	runConfigDoctor,
	runConfigDoctorWithFixes,
} from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PROJECT_CONFIG = '.opencode/opencode-swarm.json';

let xdgDir: string;
let originalXDG: string | undefined;

beforeEach(() => {
	xdgDir = canonicalMkdtemp('flip-upgrade-xdg-');
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

/** Write a project config and return its directory. */
function writeProject(config: unknown): string {
	const dir = canonicalMkdtemp('flip-upgrade-proj-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, PROJECT_CONFIG),
		JSON.stringify(config),
		'utf-8',
	);
	return dir;
}

function readProject(dir: string): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(path.join(dir, PROJECT_CONFIG), 'utf-8'),
	) as Record<string, unknown>;
}

describe('defaults-flip upgrade path (#2504)', () => {
	test('v7-era config gets defaults-flip findings naming the kill switch and preset', () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		const result = runConfigDoctor(config, dir);

		const flipFindings = result.findings.filter(
			(f) => f.id === 'defaults-flip',
		);
		// #3313 added the third governed flip row (lane_liveness_watchdog.enabled,
		// false → true) to DEFAULT_FLIPS; the count pins the full table shape.
		expect(flipFindings.length).toBe(3);
		const autoReviewRow = flipFindings.find((f) =>
			f.path.includes('auto_review'),
		);
		expect(autoReviewRow).toBeDefined();
		expect(autoReviewRow!.severity).toBe('info');
		expect(autoReviewRow!.description).toContain('auto_review.enabled');
		expect(autoReviewRow!.description).toContain('conservative');
		const parallelRow = flipFindings.find((f) =>
			f.path.includes('parallelization_enabled'),
		);
		expect(parallelRow).toBeDefined();
		expect(parallelRow!.description).toContain(
			'execution_profile.parallelization_enabled',
		);
		const watchdogRow = flipFindings.find((f) =>
			f.path.includes('lane_liveness_watchdog'),
		);
		expect(watchdogRow).toBeDefined();
		expect(watchdogRow!.description).toContain(
			'lane_liveness_watchdog.enabled',
		);
	});

	test('v7-era config keeps the legacy rename migrations advertised', () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		const result = runConfigDoctor(config, dir);
		// availableMigrations stays the DEPRECATED_FIELDS rename surface only.
		expect(result.availableMigrations?.length).toBe(4);
		expect(
			result.availableMigrations?.some(
				(m) => m.field === 'skill_improver.model',
			),
		).toBe(true);
	});

	test('--fix (applyLossy) stamps config_format_version on disk', async () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		await runConfigDoctorWithFixes(dir, config, true, { applyLossy: true });
		expect(readProject(dir).config_format_version).toBe(
			CURRENT_CONFIG_FORMAT_VERSION,
		);
	});

	test('passive runConfigDoctor does NOT write config_format_version', () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		runConfigDoctor(config, dir);
		// v7-era file carries no explicit version key — it must stay absent.
		expect(readProject(dir).config_format_version).toBeUndefined();
	});

	test('runConfigDoctorWithFixes without applyLossy does NOT stamp', async () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		await runConfigDoctorWithFixes(dir, config, true, { applyLossy: false });
		expect(readProject(dir).config_format_version).toBeUndefined();
	});

	test('re-running --fix on an acknowledged config does not re-stamp or re-advertise', async () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		const first = await runConfigDoctorWithFixes(dir, config, true, {
			applyLossy: true,
		});
		expect(first.result.findings.some((f) => f.id === 'defaults-flip')).toBe(
			true,
		);

		const reread = loadPluginConfig(dir);
		const second = await runConfigDoctorWithFixes(dir, reread, true, {
			applyLossy: true,
		});
		expect(second.result.findings.some((f) => f.id === 'defaults-flip')).toBe(
			false,
		);
		expect(readProject(dir).config_format_version).toBe(
			CURRENT_CONFIG_FORMAT_VERSION,
		);
	});

	test('a config already at the current format version emits no defaults-flip findings', () => {
		const dir = writeProject({
			automation: { mode: 'manual' },
			config_format_version: CURRENT_CONFIG_FORMAT_VERSION,
		});
		const config = loadPluginConfig(dir);
		const result = runConfigDoctor(config, dir);
		expect(result.findings.some((f) => f.id === 'defaults-flip')).toBe(false);
	});

	test('--fix stamps the USER config when no project config exists (PRR-013)', async () => {
		// Only a user-level config exists (under the isolated XDG dir); the
		// stamp's path derivation must fall back to userConfigPath.
		const userConfigDir = path.join(xdgDir, 'opencode');
		fs.mkdirSync(userConfigDir, { recursive: true });
		const userConfigPath = path.join(userConfigDir, 'opencode-swarm.json');
		fs.writeFileSync(
			userConfigPath,
			JSON.stringify({ automation: { mode: 'manual' } }),
			'utf-8',
		);
		const dir = canonicalMkdtemp('flip-upgrade-noproject-');
		const config = loadPluginConfig(dir);
		await runConfigDoctorWithFixes(dir, config, true, { applyLossy: true });
		const stamped = JSON.parse(
			fs.readFileSync(userConfigPath, 'utf-8'),
		) as Record<string, unknown>;
		expect(stamped.config_format_version).toBe(CURRENT_CONFIG_FORMAT_VERSION);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
