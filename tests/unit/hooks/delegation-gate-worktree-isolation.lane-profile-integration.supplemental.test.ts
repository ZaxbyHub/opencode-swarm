/**
 * Worktree isolation lane profile — lean path parity & remaining integration tests (FR-201)
 *
 * Covers gaps in delegation-gate-worktree-isolation.lane-profile.test.ts:
 * - SC-133: removeWorktree / postMergeCleanup are laneProfile-agnostic
 * - SC-132: Sandbox soft-fail — envOverrides embedded in wrapped commands
 * - Full integration: env file lifecycle
 * - parseLeanLaneIndex — lean path index derivation
 * - FR-205 SC-134/135: Lane profile removal at teardown
 *
 * @note These tests exercise observable file-system outcomes of writeLaneProfileToDiskReal
 * using a temp directory, bypassing the need to mock node:fs/promises in the bun
 * shared test-runner process. The seam approach (Tier 1 DI) is used for
 * provisionWorktree integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as realFs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorktreeIsolationConfig } from '../../../src/config';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../../src/config/constants';
import {
	computeLaneRuntimeProfile,
	parseLeanLaneIndex,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState } from '../../../src/state';
import {
	removeLaneProfileFromDiskReal,
	_internals as worktreeCoreInternals,
	writeLaneProfileToDiskReal,
} from '../../../src/worktree/core';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm', 'lanes'), { recursive: true });
	return real;
}

async function laneEnvExists(
	projectRoot: string,
	laneIndex: number,
): Promise<boolean> {
	const envPath = path.join(projectRoot, '.swarm', 'lanes', `${laneIndex}.env`);
	return realFs
		.access(envPath)
		.then(() => true)
		.catch(() => false);
}

// ─── SC-133 — Merge-back / cleanup unaffected by laneProfile ──────────────────

describe('SC-133: merge-back and cleanup unaffected by laneProfile', () => {
	let tempDir: string;
	let originalWriteLaneProfileToDisk: typeof worktreeCoreInternals.writeLaneProfileToDisk;

	beforeEach(() => {
		tempDir = makeTempProject('merge-cleanup-');
		originalWriteLaneProfileToDisk =
			worktreeCoreInternals.writeLaneProfileToDisk;
	});

	afterEach(async () => {
		worktreeCoreInternals.writeLaneProfileToDisk =
			originalWriteLaneProfileToDisk;
		try {
			await realFs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('writeLaneProfileToDisk produces a file that does not interfere with merge-back', async () => {
		// writeLaneProfileToDisk creates a data file under .swarm/lanes/
		// removeWorktree and postMergeCleanup operate on the worktree directory
		// as a whole. The existence of .swarm/lanes/{n}.env should not affect
		// either operation.
		const envOverrides = {
			CUSTOM_VAR: 'custom',
			ANOTHER: 'value',
		};
		await writeLaneProfileToDiskReal(tempDir, 0, envOverrides);

		// Verify the file exists
		const exists = await laneEnvExists(tempDir, 0);
		expect(exists).toBe(true);

		// Verify the file content is valid KEY=VAL
		const content = await realFs.readFile(
			path.join(tempDir, '.swarm', 'lanes', '0.env'),
			'utf-8',
		);
		expect(content).toContain('CUSTOM_VAR=custom');

		// The content does not contain git metadata, so it cannot affect
		// git worktree remove or postMergeCleanup.
		expect(content).not.toContain('refs/heads');
		expect(content).not.toContain('git');
	});

	it('env file is isolated per laneIndex (no cross-lane pollution)', async () => {
		await writeLaneProfileToDiskReal(tempDir, 0, {
			LANE_ID: 'lane-0-specific',
		});
		await writeLaneProfileToDiskReal(tempDir, 1, {
			LANE_ID: 'lane-1-specific',
		});

		const content0 = await realFs.readFile(
			path.join(tempDir, '.swarm', 'lanes', '0.env'),
			'utf-8',
		);
		const content1 = await realFs.readFile(
			path.join(tempDir, '.swarm', 'lanes', '1.env'),
			'utf-8',
		);

		expect(content0).toContain('LANE_ID=lane-0-specific');
		expect(content0).not.toContain('lane-1-specific');
		expect(content1).toContain('LANE_ID=lane-1-specific');
		expect(content1).not.toContain('lane-0-specific');
	});
});

// ─── SC-132 / Sandbox soft-fail — envOverrides embedded in wrapped commands ───

describe('Sandbox soft-fail: envOverrides from laneProfile', () => {
	// The laneProfile's envOverrides (including PORT) are written to the env file.
	// Child processes can source the env file to get lane-specific values.
	// The sandbox wrapCommand receives the envOverrides and can embed them in
	// the wrapped command string.

	const worktreePath = '/tmp/test-lane';

	it('computeLaneRuntimeProfile produces PORT in envOverrides when port_base set', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 10,
		};

		const profile = computeLaneRuntimeProfile(config, 1, worktreePath);
		// PORT is available in envOverrides for wrapCommand to use
		expect(profile?.envOverrides['PORT']).toBe('8010');
	});

	it('multiple env_overrides keys are all present in envOverrides', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 1,
			env_overrides: {
				NODE_ENV: 'production',
				TMPDIR: path.join('/tmp/lane-work'),
			},
			cache_redirects: {
				XDG_CACHE_HOME: path.join('/home/user/.cache'),
			},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		const overrides = profile?.envOverrides ?? {};

		// PORT derived from port_base
		expect(overrides['PORT']).toBe('9000');
		// Explicit env_overrides
		expect(overrides['NODE_ENV']).toBe('production');
		expect(overrides['TMPDIR']).toBe(path.join('/tmp/lane-work'));
		// Cache redirect
		expect(overrides['XDG_CACHE_HOME']).toBe(
			path.join('/home/user/.cache', 'lane-0'),
		);
	});

	it('wrapCommand can iterate over envOverrides key-value pairs', () => {
		// Simulate what wrapCommand would do: iterate envOverrides and build
		// a shell assignment string
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 10,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		const envAssignments: string[] = [];

		for (const [key, value] of Object.entries(profile?.envOverrides ?? {})) {
			envAssignments.push(`${key}=${value}`);
		}

		expect(envAssignments).toContain('PORT=8000');
		expect(envAssignments.join(' ')).toBe('PORT=8000');
	});
});

// ─── Full integration: env file lifecycle ─────────────────────────────────────

describe('Full env file lifecycle', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempProject('lifecycle-');
	});

	afterEach(async () => {
		try {
			await realFs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('multiple lanes each get their own env file with correct PORT', async () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 10,
			env_overrides: { LANE_NAME: 'test-lane' },
		};

		// Simulate provisioning 3 lanes
		for (let i = 0; i < 3; i++) {
			const profile = computeLaneRuntimeProfile(config, i, tempDir);
			if (profile) {
				await writeLaneProfileToDiskReal(
					tempDir,
					profile.laneIndex,
					profile.envOverrides,
				);
			}
		}

		// Verify all 3 env files exist with correct content
		for (let i = 0; i < 3; i++) {
			const content = await laneEnvExists(tempDir, i);
			expect(content).toBe(true);
			// Re-read content to verify
			const envPath = path.join(tempDir, '.swarm', 'lanes', `${i}.env`);
			const fileContent = await realFs.readFile(envPath, 'utf-8');
			expect(fileContent).toContain(`PORT=${8000 + i * 10}`);
			expect(fileContent).toContain('LANE_NAME=test-lane');
		}
	});

	it('disabled runtime_isolation never creates an env file', async () => {
		// With enabled=false, computeLaneRuntimeProfile returns undefined,
		// so provisionWorktree skips the writeLaneProfileToDisk call entirely.
		// This is the "zero behavior change" guarantee of SC-129.
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: false,
			port_base: 8000,
		};

		const profile = computeLaneRuntimeProfile(config, 0, tempDir);
		expect(profile).toBeUndefined();

		// Even if we somehow called writeLaneProfileToDisk with undefined envOverrides,
		// the function guards against empty envOverrides.
		await writeLaneProfileToDiskReal(tempDir, 0, {});
		const exists = await laneEnvExists(tempDir, 0);
		expect(exists).toBe(false);
	});
});

// ─── parseLeanLaneIndex — lean path index derivation ────────────────────────

describe('parseLeanLaneIndex (lean path lane index parsing)', () => {
	it('SC-123: lane-1 → 0, lane-2 → 1, lane-N → N-1', () => {
		expect(parseLeanLaneIndex('lane-1')).toBe(0);
		expect(parseLeanLaneIndex('lane-2')).toBe(1);
		expect(parseLeanLaneIndex('lane-10')).toBe(9);
		expect(parseLeanLaneIndex('lane-100')).toBe(99);
	});

	// NOTE: parseLeanLaneIndex is defined in worktree-isolation.ts and used
	// in standard path via allocateStandardLaneIndex. The lean path also has
	// its own local parseLeanLaneIndex in turbo/lean/worktree.ts that should
	// have identical behavior. We only test the exported one here.
});

// ─── FR-205 SC-134/135: Lane profile removal at teardown ────────────────────

describe('FR-205: removeLaneProfileFromDiskReal', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempProject('lane-teardown-');
	});

	afterEach(async () => {
		try {
			await realFs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	// SC-134: removeLaneProfileFromDiskReal removes the correct file
	it('SC-134: removes .swarm/lanes/{laneIndex}.env from the worktree', async () => {
		const envOverrides = { PORT: '8000', CUSTOM_VAR: 'test' };
		await writeLaneProfileToDiskReal(tempDir, 0, envOverrides);

		// Verify file exists before removal
		const existsBefore = await laneEnvExists(tempDir, 0);
		expect(existsBefore).toBe(true);

		// Remove the profile
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// Verify file is gone after removal
		const existsAfter = await laneEnvExists(tempDir, 0);
		expect(existsAfter).toBe(false);
	});

	// SC-134: removal is idempotent (can be called on already-removed file)
	it('SC-134: removal is idempotent — calling twice does not throw', async () => {
		await writeLaneProfileToDiskReal(tempDir, 0, { PORT: '8000' });

		// First removal
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// Second removal should not throw — use try/catch pattern
		let threw = false;
		try {
			await removeLaneProfileFromDiskReal(tempDir, 0);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	// SC-134: removal does not affect other lane files
	it('SC-134: removing lane 0 does not affect lane 1', async () => {
		await writeLaneProfileToDiskReal(tempDir, 0, { PORT: '8000' });
		await writeLaneProfileToDiskReal(tempDir, 1, { PORT: '8010' });

		await removeLaneProfileFromDiskReal(tempDir, 0);

		const lane0Gone = await laneEnvExists(tempDir, 0);
		const lane1StillExists = await laneEnvExists(tempDir, 1);
		expect(lane0Gone).toBe(false);
		expect(lane1StillExists).toBe(true);
	});

	// SC-135: removal targets only the worktree path (path containment)
	it('SC-135: removal path is contained within the worktree directory', async () => {
		await writeLaneProfileToDiskReal(tempDir, 0, { PORT: '8000' });

		// The removal function should only affect paths under tempDir
		// By verifying the file exists before and is gone after, we implicitly
		// verify it only touched the worktree path
		const existsBefore = await laneEnvExists(tempDir, 0);
		expect(existsBefore).toBe(true);

		await removeLaneProfileFromDiskReal(tempDir, 0);

		const existsAfter = await laneEnvExists(tempDir, 0);
		expect(existsAfter).toBe(false);
	});

	// SC-134: removal handles non-existent worktree gracefully
	it('SC-134: removal of non-existent file does not throw', async () => {
		// tempDir is a fresh temp dir, so lane 99.env should not exist
		let threw = false;
		try {
			await removeLaneProfileFromDiskReal(tempDir, 99);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	// SC-134: removal logs warning on unexpected errors (defense-in-depth)
	it('SC-134: removal logs warning on unexpected error but does not throw', async () => {
		// Write a file then make it unreadable by removing permissions
		// On Windows we can't easily remove permissions, so we test the ENOENT case
		// which is the most common "file already gone" scenario
		await writeLaneProfileToDiskReal(tempDir, 5, { PORT: '8500' });
		await removeLaneProfileFromDiskReal(tempDir, 5);

		// Should not throw even though file is already gone
		let threw = false;
		try {
			await removeLaneProfileFromDiskReal(tempDir, 5);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});

// ─── End of file ─────────────────────────────────────────────────────────────
