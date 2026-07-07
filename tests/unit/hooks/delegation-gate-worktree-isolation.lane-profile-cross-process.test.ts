/**
 * Worktree isolation lane profile — cross-process PORT computation unit test (FR-201 SC-122, FR-204 SC-131)
 *
 * Covers:
 * - SC-122: PORT env var derivation for multiple lanes is correct.
 * - SC-129/SC-130: No PORT injection when disabled or port_base undefined.
 * - SC-131: Profile works on each OS (PORT is always a string on every platform).
 *
 * Uses `_internals.spawnSync` DI seam from src/mutation/engine.ts to intercept
 * child process spawns and verify the PORT env var is set correctly.
 *
 * Per AGENTS.md invariant 7: mock.module is NOT used; we use the _internals
 * DI seam to avoid mock.module leakage across Bun's shared test-runner process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorktreeIsolationConfig } from '../../../src/config';
import {
	computeLaneRuntimeProfile,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { _internals as engineInternals } from '../../../src/mutation/engine';
import { resetSwarmState } from '../../../src/state';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
	const dir = realChildProcess.mkdtempSync(path.join(os.tmpdir(), prefix));
	return dir;
}

// ─── SC-122: PORT env var derivation across lanes ───────────────────────────────

describe('SC-122: PORT env var derivation across lanes', () => {
	const worktreePath = '/tmp/test-lane';

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		// Restore original spawnSync
		engineInternals.spawnSync = originalSpawnSync;
	});

	let originalSpawnSync: typeof engineInternals.spawnSync;

	beforeEach(() => {
		originalSpawnSync = engineInternals.spawnSync;
	});

	it('lane 0 with port_base=8000, stride=1 → PORT=8000', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile?.envOverrides['PORT']).toBe('8000');
	});

	it('lane 1 with port_base=8000, stride=1 → PORT=8001', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const profile = computeLaneRuntimeProfile(config, 1, worktreePath);
		expect(profile?.envOverrides['PORT']).toBe('8001');
	});

	it('lane 0 and lane 1 both get unique ports (no collision)', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		const profile1 = computeLaneRuntimeProfile(config, 1, worktreePath);

		expect(profile0?.envOverrides['PORT']).toBe('8000');
		expect(profile1?.envOverrides['PORT']).toBe('8001');
		expect(profile0?.envOverrides['PORT']).not.toBe(
			profile1?.envOverrides['PORT'],
		);
	});

	it('five lanes with stride=10 → ports 8000,8010,8020,8030,8040', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 10,
		};

		const expected = ['8000', '8010', '8020', '8030', '8040'];
		for (let i = 0; i < 5; i++) {
			const profile = computeLaneRuntimeProfile(config, i, worktreePath);
			expect(profile?.envOverrides['PORT']).toBe(expected[i]);
		}
	});

	it('spawnSync is called with correct PORT env var via _internals seam', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		const capturedEnv: Record<string, string>[] = [];

		// Save original and replace with spy
		const original = engineInternals.spawnSync;
		engineInternals.spawnSync = (command, args, options) => {
			capturedEnv.push(options?.env as Record<string, string>);
			return original(command, args, options);
		};

		// Call engineInternals.spawnSync directly (simulating what sandbox does)
		if (profile?.envOverrides) {
			engineInternals.spawnSync('echo', ['test'], {
				env: { ...process.env, ...profile.envOverrides },
			});
		}

		expect(capturedEnv).toHaveLength(1);
		expect(capturedEnv[0]?.['PORT']).toBe('8000');

		// Restore
		engineInternals.spawnSync = original;
	});

	it('spawnSync receives correct PORT for lane 1 via _internals seam', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const profile = computeLaneRuntimeProfile(config, 1, worktreePath);
		const capturedEnv: Record<string, string>[] = [];

		const original = engineInternals.spawnSync;
		engineInternals.spawnSync = (command, args, options) => {
			capturedEnv.push(options?.env as Record<string, string>);
			return original(command, args, options);
		};

		if (profile?.envOverrides) {
			engineInternals.spawnSync('echo', ['test'], {
				env: { ...process.env, ...profile.envOverrides },
			});
		}

		expect(capturedEnv).toHaveLength(1);
		expect(capturedEnv[0]?.['PORT']).toBe('8001');

		engineInternals.spawnSync = original;
	});
});

// ─── SC-129/SC-130: no PORT injection when disabled or port_base undefined ────

describe('SC-129/SC-130: no PORT injection when disabled or port_base undefined', () => {
	const worktreePath = '/tmp/test-lane';

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('runtime_isolation disabled → no PORT env var', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: false,
			port_base: 8000,
			port_stride: 1,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile).toBeUndefined();
	});

	it('runtime_isolation undefined → no PORT env var', () => {
		const profile = computeLaneRuntimeProfile(undefined, 0, worktreePath);
		expect(profile).toBeUndefined();
	});

	it('port_base undefined (but enabled=true) → no PORT in envOverrides', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			// port_base deliberately omitted
			port_stride: 1,
			env_overrides: { CUSTOM_VAR: 'hello' },
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile?.envOverrides).not.toHaveProperty('PORT');
		expect(profile?.envOverrides['CUSTOM_VAR']).toBe('hello');
	});

	it('profile with no PORT → spawnSync receives env without PORT key', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			// port_base omitted — no PORT derived
			env_overrides: { MY_VAR: 'value' },
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);

		let receivedEnv: Record<string, string> | undefined;
		const originalSpawnSync = engineInternals.spawnSync;
		engineInternals.spawnSync = (command, args, options) => {
			receivedEnv = options?.env as Record<string, string>;
			return originalSpawnSync(command, args, options);
		};

		// Call engineInternals.spawnSync directly (simulating what sandbox does)
		if (profile?.envOverrides) {
			engineInternals.spawnSync('echo', ['test'], {
				env: { ...process.env, ...profile.envOverrides },
			});
		}

		// Restore
		engineInternals.spawnSync = originalSpawnSync;

		expect(receivedEnv).toBeDefined();
		expect(receivedEnv).not.toHaveProperty('PORT');
		expect(receivedEnv?.['MY_VAR']).toBe('value');
	});

	it('default runtime_isolation (enabled=false) → no profile', () => {
		// SC-129: default is enabled=false — zero behavior change when off
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: false,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile).toBeUndefined();
	});
});

// ─── SC-131: PORT is always a string (cross-platform) ─────────────────────────

describe('SC-131: PORT env var is always a string', () => {
	const worktreePath = '/tmp/test-lane';

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('PORT is always a string (not a number)', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(typeof profile?.envOverrides['PORT']).toBe('string');
		expect(profile?.envOverrides['PORT']).toBe('8000');
	});

	it('PORT computed as port_base + laneIndex * port_stride produces integer string', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 7,
		};

		// lane 0 → 9000 + 0*7 = 9000
		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile0?.envOverrides['PORT']).toBe('9000');

		// lane 3 → 9000 + 3*7 = 9021
		const profile3 = computeLaneRuntimeProfile(config, 3, worktreePath);
		expect(profile3?.envOverrides['PORT']).toBe('9021');

		// Verify it parses back to the correct integer
		expect(parseInt(profile0!.envOverrides['PORT'], 10)).toBe(9000);
		expect(parseInt(profile3!.envOverrides['PORT'], 10)).toBe(9021);
	});

	it('envOverrides can be spread into process.env without type error', () => {
		// Verify the envOverrides shape is compatible with SpawnSyncOptions.env
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 10,
			env_overrides: { NODE_ENV: 'production' },
		};

		const profile = computeLaneRuntimeProfile(config, 2, worktreePath);

		// This should compile without error — envOverrides is Record<string, string>
		const mergedEnv: typeof process.env = {
			...process.env,
			...profile?.envOverrides,
		};

		expect(mergedEnv['PORT']).toBe('8020');
		expect(mergedEnv['NODE_ENV']).toBe('production');
	});
});

// ─── Multiple lanes: verify unique PORT per lane ────────────────────────────────

describe('Multiple lanes: unique PORT per lane', () => {
	const worktreePath = '/tmp/test-lane';

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('lanes 0..9 with port_base=8000 stride=1 have unique ports', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
		};

		const ports = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const profile = computeLaneRuntimeProfile(config, i, worktreePath);
			const port = profile?.envOverrides['PORT'];
			expect(port).toBe(String(8000 + i));
			ports.add(port);
		}

		// All 10 ports should be unique
		expect(ports.size).toBe(10);
	});

	it('adjacent lanes 0 and 1 with stride=100 have ports 8000 and 8100', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 100,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		const profile1 = computeLaneRuntimeProfile(config, 1, worktreePath);

		expect(profile0?.envOverrides['PORT']).toBe('8000');
		expect(profile1?.envOverrides['PORT']).toBe('8100');
	});

	it('port_base=0 with stride=1 gives 0,1,2,...', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 0,
			port_stride: 1,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		const profile1 = computeLaneRuntimeProfile(config, 1, worktreePath);
		const profile9 = computeLaneRuntimeProfile(config, 9, worktreePath);

		expect(profile0?.envOverrides['PORT']).toBe('0');
		expect(profile1?.envOverrides['PORT']).toBe('1');
		expect(profile9?.envOverrides['PORT']).toBe('9');
	});
});
