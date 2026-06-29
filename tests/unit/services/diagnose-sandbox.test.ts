/**
 * Tests for src/services/diagnose-service.ts — Sandbox HealthCheck (Task 1.2)
 *
 * Covers:
 * - getDiagnoseData includes a HealthCheck with name 'Sandbox'
 * - status is NEVER '❌' for any probe outcome
 * - When probe/executor throws, diagnose does NOT crash (returns ⬜ advisory)
 * - detail string mentions mechanism + availability + sandboxing status
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	getDiagnoseData,
} from '../../../src/services/diagnose-service';

// ---------------------------------------------------------------------------
// Mock the sandbox modules before importing diagnose-service
// ---------------------------------------------------------------------------

interface MockSandboxCapability {
	status: 'enabled' | 'disabled' | 'unsupported';
	mechanism: string;
	platform: 'linux' | 'darwin' | 'win32';
	error?: string;
}

type MockExecutor = {
	mechanism: string;
	isAvailable: () => boolean;
	wrapCommand: (cmd: string, scopes: string[], tempDir?: string) => string;
	getEnvOverrides: () => Record<string, string | null>;
} | null;

let mockCapability: MockSandboxCapability = {
	status: 'enabled',
	mechanism: 'Bubblewrap',
	platform: 'linux',
};
let mockExecutor: MockExecutor = {
	mechanism: 'Bubblewrap',
	isAvailable: () => true,
	wrapCommand: (cmd) => cmd,
	getEnvOverrides: () => ({}),
};
let probeThrows = false;
let executorThrows = false;

const mockDetect = mock(async (): Promise<MockSandboxCapability> => {
	if (probeThrows) throw new Error('probe failure');
	return mockCapability;
});

const mockGetExecutor = mock(async (): Promise<MockExecutor> => {
	if (executorThrows) throw new Error('executor failure');
	return mockExecutor;
});

const realDetectSandboxCapability = _internals.detectSandboxCapability;
const realGetSandboxExecutor = _internals.getSandboxExecutor;

// ---------------------------------------------------------------------------
// Also mock the other modules that diagnose-service imports
// ---------------------------------------------------------------------------

mock.module('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: mock(async () => null),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));

mock.module('../../../src/evidence/manager.js', () => ({
	listEvidenceTaskIds: mock(async () => []),
}));

mock.module('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: mock(async () => null),
}));

mock.module('../../../src/config/loader.js', () => ({
	loadPluginConfig: mock(() => ({ curator: { enabled: false } })),
}));

mock.module('../../../src/sdd/effective-spec.js', () => ({
	readEffectiveSpecSync: () => null,
}));

mock.module('node:fs', () => ({
	readdirSync: () => [],
	existsSync: (p: string) => {
		if (typeof p !== 'string') return false;
		// Only the directory itself exists
		return (
			p === '/test/dir' || p.endsWith('/test/dir') || p.endsWith('\\test\\dir')
		);
	},
	statSync: () => ({ isDirectory: () => true }),
	readFileSync: () => '{}',
}));

import * as realChildProcess from 'node:child_process';

mock.module('node:child_process', () => ({
	...realChildProcess,
	execSync: () => Buffer.from('.git'),
}));

beforeEach(() => {
	_internals.detectSandboxCapability =
		mockDetect as typeof _internals.detectSandboxCapability;
	_internals.getSandboxExecutor =
		mockGetExecutor as typeof _internals.getSandboxExecutor;
});

afterEach(() => {
	_internals.detectSandboxCapability = realDetectSandboxCapability;
	_internals.getSandboxExecutor = realGetSandboxExecutor;
	mock.restore();
	probeThrows = false;
	executorThrows = false;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sandbox HealthCheck in getDiagnoseData', () => {
	test('getDiagnoseData includes a Sandbox HealthCheck', async () => {
		const result = await getDiagnoseData('/test/dir');
		const sandboxCheck = result.checks.find((c) => c.name === 'Sandbox');
		expect(sandboxCheck).toBeDefined();
		expect(sandboxCheck!.name).toBe('Sandbox');
	});

	test('Sandbox status is NEVER ❌ for any probe outcome', async () => {
		// Scenario 1: capability enabled, executor available → ✅
		mockCapability = {
			status: 'enabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
		};
		mockExecutor = {
			mechanism: 'Bubblewrap',
			isAvailable: () => true,
			wrapCommand: (c) => c,
			getEnvOverrides: () => ({}),
		};
		executorThrows = false;
		probeThrows = false;

		let result = await getDiagnoseData('/test/dir');
		let sandbox = result.checks.find((c) => c.name === 'Sandbox')!;
		expect(sandbox.status).not.toBe('❌');
		expect(sandbox.status).toBe('✅');

		// Scenario 2: capability enabled, executor NOT available → ⚠️
		mockExecutor = null;
		result = await getDiagnoseData('/test/dir');
		sandbox = result.checks.find((c) => c.name === 'Sandbox')!;
		expect(sandbox.status).not.toBe('❌');
		expect(sandbox.status).toBe('⚠️');

		// Scenario 3: mechanism='none' (unsupported) → ⬜
		mockExecutor = null;
		mockCapability = {
			status: 'unsupported',
			mechanism: 'none',
			platform: 'linux',
		};
		result = await getDiagnoseData('/test/dir');
		sandbox = result.checks.find((c) => c.name === 'Sandbox')!;
		expect(sandbox.status).not.toBe('❌');
		expect(sandbox.status).toBe('⬜');

		// Scenario 4: mechanism disabled (capability.status='disabled') with mechanism name → ⚠️
		// (mechanism !== 'none', hasExecutor=false → ⚠️)
		mockCapability = {
			status: 'disabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
		};
		mockExecutor = null;
		result = await getDiagnoseData('/test/dir');
		sandbox = result.checks.find((c) => c.name === 'Sandbox')!;
		expect(sandbox.status).not.toBe('❌');
		expect(sandbox.status).toBe('⚠️');
	});

	test('When probe throws, getDiagnoseData does NOT crash — returns ⬜ advisory', async () => {
		probeThrows = true;
		mockExecutor = null;

		// Should not throw
		let threw = false;
		try {
			await getDiagnoseData('/test/dir');
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;
		expect(sandbox.status).toBe('⬜');
		expect(sandbox.detail).toContain('unknown');
	});

	test('When executor acquisition throws, getDiagnoseData does NOT crash', async () => {
		probeThrows = false;
		mockCapability = {
			status: 'enabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
		};
		executorThrows = true;

		let threw = false;
		try {
			await getDiagnoseData('/test/dir');
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;
		expect(sandbox.status).toBe('⬜');
	});

	test('detail string mentions mechanism + availability + sandboxing status (✅ path)', async () => {
		mockCapability = {
			status: 'enabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
		};
		mockExecutor = {
			mechanism: 'Bubblewrap',
			isAvailable: () => true,
			wrapCommand: (c) => c,
			getEnvOverrides: () => ({}),
		};

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.detail).toContain('bubblewrap');
		expect(sandbox.detail).toContain('Available: yes');
		expect(sandbox.detail).toContain('Sandboxing commands: yes');
	});

	test('detail string mentions mechanism + availability for ⚠️ path', async () => {
		mockCapability = {
			status: 'enabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
		};
		mockExecutor = null;

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.detail).toContain('bubblewrap');
		expect(sandbox.detail).toContain('Available: no');
		expect(sandbox.detail).toContain('Commands NOT sandboxed');
	});

	test('detail string mentions mechanism for ⬜ path', async () => {
		mockCapability = {
			status: 'unsupported',
			mechanism: 'none',
			platform: 'linux',
		};
		mockExecutor = null;

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.detail).toContain('none');
		expect(sandbox.detail).toContain('Commands not sandboxed');
	});
});
