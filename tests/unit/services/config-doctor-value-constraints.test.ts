/**
 * Tests for the config-doctor value-constraint detection + opt-in lossy autofix
 * (issue #1886 follow-up).
 *
 * `/swarm doctor` previously only surfaced unrecognized config keys, so a
 * value-constraint failure (e.g. an agent's `fallback_models` array exceeding the
 * schema max of FALLBACK_MODELS_MAX) produced no finding and no fix — the config
 * stayed broken. This adds:
 *   - detection of every value-constraint failure (so the doctor says WHY the
 *     config is rejected), and
 *   - an opt-in autofix that trims over-length `fallback_models`, applied ONLY
 *     when the caller passes `{ applyLossy: true }` (the `/swarm config doctor
 *     --fix` command) — never by the passive startup autofix path.
 *
 * New file: src/services/config-doctor.test.ts is over the FR-006 500-line cap
 * and must not grow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import {
	FALLBACK_MODELS_MAX,
	PluginConfigSchema,
} from '../../../src/config/schema';
import {
	applySafeAutoFixes,
	runConfigDoctor,
	runConfigDoctorWithFixes,
	writeDoctorArtifact,
} from '../../../src/services/config-doctor';

let xdgDir: string;
let originalXDG: string | undefined;

beforeEach(() => {
	// Isolate the USER config path so only our project config is seen.
	xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-xdg-'));
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

function writeProject(config: unknown): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-proj-')),
	);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
	return dir;
}

function overLongFallback(): string[] {
	return Array.from({ length: FALLBACK_MODELS_MAX + 2 }, (_v, i) => `m${i}`);
}

describe('config-doctor value-constraint detection (#1886)', () => {
	it('reports over-length fallback_models with an opt-in lossy autofix', () => {
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
				coder: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const fb = result.findings.filter(
				(f) => f.id === 'fallback-models-too-many',
			);
			expect(fb.length).toBe(2);
			const architect = fb.find(
				(f) => f.path === 'agents.architect.fallback_models',
			);
			expect(architect).toBeDefined();
			expect(architect?.severity).toBe('error');
			expect(architect?.autoFixable).toBe(true);
			expect(architect?.proposedFix?.type).toBe('update');
			expect(architect?.proposedFix?.risk).toBe('low');
			expect(architect?.proposedFix?.lossy).toBe(true);
			expect((architect?.proposedFix?.value as string[]).length).toBe(
				FALLBACK_MODELS_MAX,
			);
			expect(result.hasAutoFixableIssues).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reports non-fallback value errors as report-only (not auto-fixable)', () => {
		// max_iterations: 999 exceeds the schema max of 10.
		const dir = writeProject({ max_iterations: 999 });
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const invalid = result.findings.filter(
				(f) => f.id === 'invalid-config-value',
			);
			expect(invalid.length).toBeGreaterThan(0);
			expect(invalid.some((f) => f.path === 'max_iterations')).toBe(true);
			expect(invalid.every((f) => f.autoFixable === false)).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('produces no value-constraint findings for a valid config', () => {
		const dir = writeProject({
			agents: { architect: { model: 'k', fallback_models: ['a', 'b'] } },
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const noise = result.findings.filter(
				(f) =>
					f.id === 'invalid-config-value' ||
					f.id === 'fallback-models-too-many',
			);
			expect(noise.length).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does not duplicate unrecognized-key or gates findings', () => {
		const dir = writeProject({
			totally_unknown_key: true,
			gates: { placeholder_scan: { deny_patterns: 'not-an-array' } },
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			// The new collector must not emit an invalid-config-value for the
			// unrecognized key or for anything under gates.*.
			const invalid = result.findings.filter(
				(f) => f.id === 'invalid-config-value',
			);
			expect(invalid.some((f) => f.path.startsWith('gates'))).toBe(false);
			expect(invalid.some((f) => f.path === 'totally_unknown_key')).toBe(false);
			// The fallback finding still fires.
			expect(
				result.findings.some((f) => f.id === 'fallback-models-too-many'),
			).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('config-doctor lossy autofix gating (#1886)', () => {
	it('on a dual-config same-path collision, --fix trims the apply-target (project) file', () => {
		// Both the user AND project configs carry the same over-long array at the
		// same path. The finding must be reported once and remain FIXABLE (the
		// apply-target/project variant), and `--fix` must trim the project file
		// (the write target and the deep-merge winner) — not no-op while pointing
		// at the merge-losing user file.
		const overLong = overLongFallback();
		const userCfgDir = path.join(xdgDir, 'opencode');
		fs.mkdirSync(userCfgDir, { recursive: true });
		fs.writeFileSync(
			path.join(userCfgDir, 'opencode-swarm.json'),
			JSON.stringify({
				agents: { architect: { model: 'k', fallback_models: overLong } },
			}),
		);
		const dir = writeProject({
			agents: { architect: { model: 'k', fallback_models: overLong } },
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const fb = result.findings.filter(
				(f) => f.id === 'fallback-models-too-many',
			);
			expect(fb.length).toBe(1);
			expect(fb[0]?.autoFixable).toBe(true);

			const { appliedFixes } = applySafeAutoFixes(dir, result, {
				applyLossy: true,
			});
			expect(appliedFixes.length).toBe(1);
			const projectOnDisk = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(projectOnDisk.agents.architect.fallback_models.length).toBe(
				FALLBACK_MODELS_MAX,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('applySafeAutoFixes SKIPS the lossy trim by default', () => {
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const { appliedFixes } = applySafeAutoFixes(dir, result);
			expect(appliedFixes.length).toBe(0);
			const onDisk = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(onDisk.agents.architect.fallback_models.length).toBe(
				FALLBACK_MODELS_MAX + 2,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('applySafeAutoFixes APPLIES the lossy trim when applyLossy is true', () => {
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const { appliedFixes } = applySafeAutoFixes(dir, result, {
				applyLossy: true,
			});
			expect(appliedFixes.length).toBe(1);
			const onDisk = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(onDisk.agents.architect.fallback_models.length).toBe(
				FALLBACK_MODELS_MAX,
			);
			expect(PluginConfigSchema.safeParse(onDisk).success).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('startup-style runConfigDoctorWithFixes(autoFix) does NOT trim silently', async () => {
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			// No applyLossy option — mirrors the src/index.ts startup call.
			await runConfigDoctorWithFixes(dir, loadPluginConfig(dir), true);
			const onDisk = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(onDisk.agents.architect.fallback_models.length).toBe(
				FALLBACK_MODELS_MAX + 2,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('--fix-style runConfigDoctorWithFixes(autoFix, {applyLossy:true}) trims and validates', async () => {
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
				coder: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const fix = await runConfigDoctorWithFixes(
				dir,
				loadPluginConfig(dir),
				true,
				{
					applyLossy: true,
				},
			);
			expect(fix.appliedFixes.length).toBe(2);
			const onDisk = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(onDisk.agents.architect.fallback_models.length).toBe(
				FALLBACK_MODELS_MAX,
			);
			expect(onDisk.agents.coder.fallback_models.length).toBe(
				FALLBACK_MODELS_MAX,
			);
			expect(PluginConfigSchema.safeParse(onDisk).success).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('config-doctor artifact + schema sync (#1886)', () => {
	it('serializes the lossy flag into the config-doctor artifact', () => {
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const artifactPath = writeDoctorArtifact(dir, result);
			const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
			const fb = artifact.findings.find(
				(f: { id: string }) => f.id === 'fallback-models-too-many',
			);
			expect(fb?.proposedFix?.lossy).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('excludes currentValue from the serialized artifact (PR #1890 review, security-2)', () => {
		// writeDoctorArtifact whitelists which ConfigFinding fields it serializes
		// for the GUI. currentValue can hold raw config content (e.g. the
		// over-length fallback_models array); confirm it never reaches the
		// on-disk artifact, not just that `lossy` happens to be present.
		const dir = writeProject({
			agents: {
				architect: { model: 'k', fallback_models: overLongFallback() },
			},
		});
		try {
			const result = runConfigDoctor(loadPluginConfig(dir), dir);
			const fbFinding = result.findings.find(
				(f) => f.id === 'fallback-models-too-many',
			);
			// Sanity: the in-memory finding DOES carry currentValue (so this test
			// actually exercises the artifact-serialization whitelist, not an
			// already-absent value).
			expect(fbFinding?.currentValue).toBeDefined();

			const artifactPath = writeDoctorArtifact(dir, result);
			const rawArtifact = fs.readFileSync(artifactPath, 'utf-8');
			expect(rawArtifact).not.toContain('currentValue');

			const artifact = JSON.parse(rawArtifact);
			const fb = artifact.findings.find(
				(f: { id: string }) => f.id === 'fallback-models-too-many',
			);
			expect(fb.currentValue).toBeUndefined();
			expect(Object.keys(fb)).not.toContain('currentValue');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('FALLBACK_MODELS_MAX matches the schema constraint', () => {
		const okList = Array.from(
			{ length: FALLBACK_MODELS_MAX },
			(_v, i) => `m${i}`,
		);
		const tooMany = [...okList, 'one-too-many'];
		const base = { agents: { architect: { model: 'k' } } };
		expect(
			PluginConfigSchema.safeParse({
				agents: { architect: { model: 'k', fallback_models: okList } },
			}).success,
		).toBe(true);
		expect(
			PluginConfigSchema.safeParse({
				...base,
				agents: { architect: { model: 'k', fallback_models: tooMany } },
			}).success,
		).toBe(false);
	});
});
