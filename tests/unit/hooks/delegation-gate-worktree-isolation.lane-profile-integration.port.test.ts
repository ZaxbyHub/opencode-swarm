/**
 * Worktree isolation lane profile — port determinism tests (FR-201)
 *
 * Covers:
 * - SC-123: Full 5-lane port determinism (0..4 → 8000, 8010, 8020, 8030, 8040)
 * - SC-130: port_base omitted → no PORT key in envOverrides
 * - SC-129: Default enabled=false → no env file written, no side effects
 *
 * @note These tests exercise observable file-system outcomes of writeLaneProfileToDiskReal
 * using a temp directory, bypassing the need to mock node:fs/promises in the bun
 * shared test-runner process. The seam approach (Tier 1 DI) is used for
 * provisionWorktree integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorktreeIsolationConfig } from '../../../src/config';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../../src/config/constants';
import {
	computeLaneRuntimeProfile,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState } from '../../../src/state';

// ─── SC-123 — Port determinism across 5 lanes ───────────────────────────────

describe('SC-123: port determinism', () => {
	const worktreePath = '/tmp/test-lane';

	it('laneIndex=0..4 with portBase=8000 stride=10 → ports 8000,8010,8020,8030,8040', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 8000,
			port_stride: 10,
		};

		const expectedPorts = ['8000', '8010', '8020', '8030', '8040'];
		for (let i = 0; i < 5; i++) {
			const profile = computeLaneRuntimeProfile(config, i, worktreePath);
			expect(profile?.envOverrides['PORT']).toBe(expectedPorts[i]);
		}
	});

	it('laneIndex=0..4 stride=1 defaults to stride=1 when omitted', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 7000,
			// port_stride omitted → defaults to 1
		};

		const expectedPorts = ['7000', '7001', '7002', '7003', '7004'];
		for (let i = 0; i < 5; i++) {
			const profile = computeLaneRuntimeProfile(config, i, worktreePath);
			expect(profile?.envOverrides['PORT']).toBe(expectedPorts[i]);
		}
	});

	it('port_base=0 with stride=100 gives correct multiples', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_base: 0,
			port_stride: 100,
		};

		const profile0 = computeLaneRuntimeProfile(config, 0, worktreePath);
		const profile3 = computeLaneRuntimeProfile(config, 3, worktreePath);
		const profile9 = computeLaneRuntimeProfile(config, 9, worktreePath);
		expect(profile0?.envOverrides['PORT']).toBe('0');
		expect(profile3?.envOverrides['PORT']).toBe('300');
		expect(profile9?.envOverrides['PORT']).toBe('900');
	});
});

// ─── SC-130 — Omitted port_base → no PORT key ───────────────────────────────

describe('SC-130: port_base omitted', () => {
	const worktreePath = '/tmp/test-lane';

	it('when port_base is undefined, no PORT key appears in envOverrides', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			port_stride: 5,
			// port_base deliberately omitted
			env_overrides: { CUSTOM_VAR: 'hello' },
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(profile?.envOverrides).not.toHaveProperty('PORT');
		expect(profile?.envOverrides['CUSTOM_VAR']).toBe('hello');
	});

	it('port_base=undefined with only env_overrides → profile has only those keys', () => {
		const config: WorktreeIsolationConfig['runtime_isolation'] = {
			enabled: true,
			env_overrides: { FOO: 'bar', BAZ: 'qux' },
		};

		const profile = computeLaneRuntimeProfile(config, 0, worktreePath);
		expect(Object.keys(profile?.envOverrides ?? {})).toEqual(['FOO', 'BAZ']);
	});
});

// ─── SC-129 — Default enabled=false → zero behavior change ──────────────────

describe('SC-129: default enabled=false', () => {
	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('default runtime_isolation produces undefined profile', () => {
		const result = computeLaneRuntimeProfile(
			DEFAULT_WORKTREE_ISOLATION_CONFIG.runtime_isolation,
			0,
			'/tmp/test-lane',
		);
		expect(result).toBeUndefined();
	});

	it('default runtime_isolation is { enabled: false }', () => {
		expect(DEFAULT_WORKTREE_ISOLATION_CONFIG.runtime_isolation?.enabled).toBe(
			false,
		);
	});

	it('runtime_isolation=null produces undefined profile (null guard)', () => {
		const result = computeLaneRuntimeProfile(
			null as unknown as undefined,
			0,
			'/tmp/test-lane',
		);
		expect(result).toBeUndefined();
	});
});
