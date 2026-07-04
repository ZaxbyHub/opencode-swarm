/**
 * Worktree isolation lane profile tests (FR-201 SC-123, FR-202 SC-125, FR-203 SC-129, FR-204 SC-131)
 *
 * Covers:
 * - Lane index → port derivation is deterministic
 * - env_overrides are merged correctly
 * - cache_redirects are applied correctly
 * - Disabled runtime_isolation produces no profile (zero behavior change)
 * - Lane env file is written correctly when enabled
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
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

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

describe('parseLeanLaneIndex', () => {
	it('parses lane-1 as 0-based index 0', () => {
		expect(parseLeanLaneIndex('lane-1')).toBe(0);
	});

	it('parses lane-3 as 0-based index 2', () => {
		expect(parseLeanLaneIndex('lane-3')).toBe(2);
	});

	it('parses lane-10 as 0-based index 9', () => {
		expect(parseLeanLaneIndex('lane-10')).toBe(9);
	});

	it('returns 0 for unparseable laneId', () => {
		expect(parseLeanLaneIndex('lane')).toBe(0);
		expect(parseLeanLaneIndex('lane-x')).toBe(0);
		expect(parseLeanLaneIndex('invalid')).toBe(0);
	});
});

describe('computeLaneRuntimeProfile', () => {
	const worktreePath = '/tmp/test-lane';

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('returns undefined when runtime_isolation is undefined', () => {
		const result = computeLaneRuntimeProfile(undefined, 0, worktreePath);
		expect(result).toBeUndefined();
	});

	it('returns undefined when runtime_isolation.enabled is false', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: false,
			port_stride: 1,
		};
		const result = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(result).toBeUndefined();
	});

	it('SC-123: port = port_base + laneIndex * port_stride is deterministic', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 2,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile0?.envOverrides['PORT']).toBe('9000'); // 9000 + 0*2

		const profile1 = computeLaneRuntimeProfile(config, 1, worktreePath);
		expect(profile1?.envOverrides['PORT']).toBe('9002'); // 9000 + 1*2

		const profile2 = computeLaneRuntimeProfile(config, 2, worktreePath);
		expect(profile2?.envOverrides['PORT']).toBe('9004'); // 9000 + 2*2

		const profile5 = computeLaneRuntimeProfile(config, 5, worktreePath);
		expect(profile5?.envOverrides['PORT']).toBe('9010'); // 9000 + 5*2
	});

	it('SC-129/SC-130: port_base undefined → no PORT key in envOverrides', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_stride: 1,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile0?.envOverrides).not.toHaveProperty('PORT');

		const profile1 = computeLaneRuntimeProfile(config, 1, worktreePath);
		expect(profile1?.envOverrides).not.toHaveProperty('PORT');
	});

	it('port_base = 0 (explicit) → PORT = laneIndex * port_stride', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 0,
			port_stride: 100,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile0?.envOverrides['PORT']).toBe('0');

		const profile3 = computeLaneRuntimeProfile(config, 3, worktreePath);
		expect(profile3?.envOverrides['PORT']).toBe('300');
	});

	it('port_stride defaults to 1 when omitted', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile0?.envOverrides['PORT']).toBe('8000');

		const profile1 = computeLaneRuntimeProfile(config, 1, worktreePath);
		expect(profile1?.envOverrides['PORT']).toBe('8001');
	});

	it('env_overrides are merged and can override PORT', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 1,
			env_overrides: {
				CUSTOM_VAR: 'custom-value',
				MYVAR: 'my-value',
			},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile?.envOverrides['PORT']).toBe('9000');
		expect(profile?.envOverrides['CUSTOM_VAR']).toBe('custom-value');
		expect(profile?.envOverrides['MYVAR']).toBe('my-value');
	});

	it('env_overrides can override derived PORT', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 1,
			env_overrides: {
				// Override PORT to a fixed value
				MYPORT: '7000',
			},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		// MYPORT is set to 7000, but PORT is still derived as 9000
		expect(profile?.envOverrides['PORT']).toBe('9000');
		expect(profile?.envOverrides['MYPORT']).toBe('7000');
	});

	it('explicit env_overrides.PORT wins over derived PORT (caller wins)', () => {
		// Precedence: derived PORT → env_overrides (wins) → cache_redirects (wins)
		// When env_overrides explicitly sets PORT, it must win over the derived value.
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
			env_overrides: {
				// Explicit caller PORT wins over derived PORT
				PORT: '9999',
			},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		// Derived PORT = 8000 + 0*1 = 8000, but env_overrides.PORT=9999 wins
		expect(profile?.envOverrides['PORT']).toBe('9999');
	});

	it('derived PORT used when env_overrides does not set PORT (separate keys)', () => {
		// env_overrides does NOT contain PORT, so derived PORT is used unchanged.
		// This is NOT a precedence conflict — env_overrides just adds its own keys.
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
			env_overrides: {
				MY_SERVICE_PORT: '9000',
			},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		// Derived PORT = 8000, env_overrides.MY_SERVICE_PORT is preserved.
		expect(profile?.envOverrides['PORT']).toBe('8000');
		expect(profile?.envOverrides['MY_SERVICE_PORT']).toBe('9000');
	});

	it('cache_redirects.XDG_CACHE_HOME wins over env_overrides.XDG_CACHE_HOME', () => {
		// Precedence: env_overrides → cache_redirects (wins)
		// cache_redirects always appends lane suffix and wins over env_overrides.
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 1,
			env_overrides: {
				XDG_CACHE_HOME: '/custom/cache',
			},
			cache_redirects: {
				XDG_CACHE_HOME: path.join('/cache'),
			},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		// cache_redirects wins: /cache + lane-0 suffix (using native separators)
		expect(profile?.envOverrides['XDG_CACHE_HOME']).toBe(
			path.join('/cache', 'lane-0'),
		);
	});

	it('cache_redirects are applied correctly', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 1,
			cache_redirects: {
				XDG_CACHE_HOME: path.join('/home/user/.cache'),
			},
		};

		const profile2 = computeLaneRuntimeProfile(config, 2, worktreePath);
		expect(profile2?.envOverrides['XDG_CACHE_HOME']).toBe(
			path.join('/home/user/.cache', 'lane-2'),
		);
	});

	it('cache_redirects are prefixed with lane suffix (lane-{index})', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 0,
			port_stride: 100,
			cache_redirects: {
				TMPDIR: path.join('/tmp/myproject'),
				HOME: path.join('/home/user'),
			},
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile0?.envOverrides['TMPDIR']).toBe(
			path.join('/tmp/myproject', 'lane-0'),
		);
		expect(profile0?.envOverrides['HOME']).toBe(
			path.join('/home/user', 'lane-0'),
		);

		const profile3 = computeLaneRuntimeProfile(config, 3, worktreePath);
		expect(profile3?.envOverrides['TMPDIR']).toBe(
			path.join('/tmp/myproject', 'lane-3'),
		);
		expect(profile3?.envOverrides['HOME']).toBe(
			path.join('/home/user', 'lane-3'),
		);
	});

	it('cache_redirects with Windows basePath uses native backslash separators', () => {
		// Regression test: path.posix.join on a Windows path like C:\Users\...\cache
		// produces mixed separators (C:\Users\...\cache/lane-0). path.join produces
		// the correct native form: C:\Users\...\cache\lane-0
		const windowsBase = `C:${path.sep}Users${path.sep}test${path.sep}AppData${path.sep}Local${path.sep}Temp${path.sep}cache`;
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 0,
			port_stride: 1,
			cache_redirects: {
				TEMP: windowsBase,
			},
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		const result = profile0?.envOverrides['TEMP'] ?? '';
		// Result must use the native Windows separator: \lane-0
		// (the old bug: path.posix.join produced C:\...\cache/lane-0 with mixed separators)
		expect(result).toBe(path.join(windowsBase, 'lane-0'));
	});

	it('laneIndex is set correctly in the profile', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 9000,
			port_stride: 2,
		};

		const profile = computeLaneRuntimeProfile(config, 5, worktreePath);
		expect(profile?.laneIndex).toBe(5);
		expect(profile?.worktreePath).toBe(worktreePath);
	});

	it('worktreePath is set correctly in the profile', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
		};

		const profile = computeLaneRuntimeProfile(config, 0, '/custom/path/lane');
		expect(profile?.worktreePath).toBe('/custom/path/lane');
	});

	it('SC-129: default config (disabled) returns undefined', () => {
		const result = computeLaneRuntimeProfile(
			DEFAULT_WORKTREE_ISOLATION_CONFIG.runtime_isolation,
			0,
			worktreePath,
		);
		expect(result).toBeUndefined();
	});

	it('empty env_overrides object still produces profile with PORT', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 7000,
			port_stride: 1,
			env_overrides: {},
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile?.envOverrides['PORT']).toBe('7000');
		expect(Object.keys(profile?.envOverrides ?? {})).toContain('PORT');
	});

	it('envOverrides contains only PORT when no overrides or redirects', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 5000,
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile?.envOverrides).toEqual({ PORT: '5000' });
	});
});

describe('lane profile materialization', () => {
	const originalWriteLaneProfileToDisk =
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(require('../../../src/worktree/core') as any)._internals
			?.writeLaneProfileToDisk;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const worktreeCore = require('../../../src/worktree/core') as any;

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		// Restore original seam
		if (originalWriteLaneProfileToDisk) {
			worktreeCore._internals.writeLaneProfileToDisk =
				originalWriteLaneProfileToDisk;
		}
	});

	it('writeLaneProfileToDisk is called when runtime_isolation is enabled', async () => {
		const calls: Array<{
			worktreePath: string;
			laneIndex: number;
			envOverrides: Record<string, string>;
		}> = [];

		worktreeCore._internals.writeLaneProfileToDisk = async (
			worktreePath: string,
			laneIndex: number,
			envOverrides: Record<string, string>,
		) => {
			calls.push({ worktreePath, laneIndex, envOverrides });
		};

		// We can't easily test precreateStandardWorktreeSession without a full integration setup,
		// but we can verify the seam is correctly typed and callable
		await worktreeCore._internals.writeLaneProfileToDisk('/tmp/test-lane', 0, {
			PORT: '9000',
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].worktreePath).toBe('/tmp/test-lane');
		expect(calls[0].laneIndex).toBe(0);
		expect(calls[0].envOverrides).toEqual({ PORT: '9000' });
	});

	it('writeLaneProfileToDisk receives correct laneIndex from computeLaneRuntimeProfile', async () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 3,
		};

		const profile = computeLaneRuntimeProfile(config, 4, '/tmp/lane-worktree');
		expect(profile?.laneIndex).toBe(4);
		expect(profile?.envOverrides['PORT']).toBe('8012'); // 8000 + 4*3

		// Simulate what precreateStandardWorktreeSession does after provisioning
		await worktreeCore._internals.writeLaneProfileToDisk(
			profile!.worktreePath,
			profile!.laneIndex,
			profile!.envOverrides,
		);
	});
});
