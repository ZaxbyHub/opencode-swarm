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
import * as realFs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_resetSandboxWrapOutcomeState,
	recordSandboxWrapOutcome,
} from '../../../src/sandbox/skip-state';
import {
	_internals,
	getDiagnoseData,
} from '../../../src/services/diagnose-service';

// ---------------------------------------------------------------------------
// Mock the sandbox modules before importing diagnose-service
// ---------------------------------------------------------------------------

interface MockSandboxCapability {
	status: 'enabled' | 'disabled' | 'unsupported';
	strength?: 'strong' | 'advisory';
	mechanism: string;
	platform: 'linux' | 'darwin' | 'win32';
	error?: string;
	v: 1;
	filesystem: 'real' | 'weak' | 'none';
	network: 'real' | 'weak' | 'none';
	process: 'real' | 'weak' | 'none';
	effective: 'real' | 'weak' | 'none';
	reasons: string[];
	identity: string;
}

type MockExecutor = {
	mechanism: string;
	strength?: 'strong' | 'weak' | 'advisory';
	isAvailable: () => boolean;
	wrapCommand: (cmd: string, scopes: string[], tempDir?: string) => string;
	getEnvOverrides: () => Record<string, string | null>;
} | null;

let mockCapability: MockSandboxCapability = {
	status: 'enabled',
	mechanism: 'Bubblewrap',
	platform: 'linux',
	v: 1,
	filesystem: 'real',
	network: 'real',
	process: 'none',
	effective: 'none',
	reasons: ['seccomp unsupported: no filter is installed'],
	identity: 'linux:bubblewrap:enabled:strong:fs=real:net=real:proc=none',
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
	...realFs,
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
	_resetSandboxWrapOutcomeState();
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
			v: 1,
			strength: 'strong',
			filesystem: 'weak',
			network: 'weak',
			process: 'none',
			effective: 'none',
			reasons: [
				'availability only; denial behavior not independently exercised',
			],
			identity: 'linux:bubblewrap',
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
		expect(sandbox.status).toBe('⚠️');

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
			v: 1,
			filesystem: 'none',
			network: 'none',
			process: 'none',
			effective: 'none',
			reasons: ['sandbox mechanism unavailable'],
			identity: 'linux:none',
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
			v: 1,
			filesystem: 'none',
			network: 'none',
			process: 'none',
			effective: 'none',
			reasons: ['probe failed'],
			identity: 'linux:bubblewrap:disabled',
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
			v: 1,
			filesystem: 'real',
			network: 'real',
			process: 'real',
			effective: 'real',
			reasons: ['verified strong boundary'],
			identity: 'linux:bubblewrap',
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
			v: 1,
			status: 'enabled',
			strength: 'strong',
			mechanism: 'Bubblewrap',
			platform: 'linux',
			filesystem: 'weak',
			network: 'weak',
			process: 'none',
			effective: 'none',
			reasons: [
				'availability only; denial behavior not independently exercised',
			],
			identity: 'test-bubblewrap-weak',
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
		expect(sandbox.status).toBe('⚠️');
		expect(sandbox.detail).toContain('fs=weak');
		expect(sandbox.detail).toContain('network=weak');
		expect(sandbox.detail).toContain('Partial boundary');
	});

	test('detail string mentions mechanism + availability for ⚠️ path', async () => {
		mockCapability = {
			status: 'enabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
			v: 1,
			strength: 'strong',
			filesystem: 'weak',
			network: 'weak',
			process: 'none',
			effective: 'none',
			reasons: ['executor unavailable'],
			identity: 'linux:bubblewrap',
		};
		mockExecutor = null;

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.detail).toContain('bubblewrap');
		expect(sandbox.detail).toContain('Available: no');
		expect(sandbox.detail).toContain('executor unavailable');
	});

	test('advisory Windows fallback is downgraded to ⚠️, never green (#1778 H2)', async () => {
		// An available executor whose probe reports advisory strength must NOT be
		// reported as strong containment.
		mockCapability = {
			status: 'enabled',
			strength: 'advisory',
			mechanism: 'PowerShell wrapper',
			platform: 'win32',
			v: 1,
			filesystem: 'none',
			network: 'none',
			process: 'none',
			effective: 'none',
			reasons: ['advisory only'],
			identity: 'win32:powershell-wrapper',
		};
		mockExecutor = {
			mechanism: 'PowerShell wrapper',
			strength: 'weak',
			isAvailable: () => true,
			wrapCommand: (c) => c,
			getEnvOverrides: () => ({}),
		};

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.status).toBe('⚠️');
		expect(sandbox.status).not.toBe('✅');
		expect(sandbox.detail).toContain('fs=none');
		expect(sandbox.detail).toContain('Partial boundary');
	});

	test('regression FB-006: diagnose only surfaces redacted skip reasons for the active session', async () => {
		recordSandboxWrapOutcome({
			sessionID: 'sess-a',
			callID: 'skip-a',
			originalCommandHash: 1,
			finalCommandHash: 1,
			wrapped: false,
			capabilityIdentity: 'cap-a',
			assessmentCacheKey: 'assessment-a',
			reason:
				'configured writable_roots rejected (C:\\Users\\Brett\\secret, ../outside)',
			originalCommand: 'echo a',
			executorMechanism: 'none',
			capabilityMechanism: 'none',
		});
		recordSandboxWrapOutcome({
			sessionID: 'sess-b',
			callID: 'skip-b',
			originalCommandHash: 2,
			finalCommandHash: 2,
			wrapped: false,
			capabilityIdentity: 'cap-b',
			assessmentCacheKey: 'assessment-b',
			reason: 'configured writable_roots rejected (/tmp/private/file)',
			originalCommand: 'echo b',
			executorMechanism: 'none',
			capabilityMechanism: 'none',
		});

		const result = await getDiagnoseData('/test/dir', 'sess-a');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.detail).toContain('observed skips=1');
		expect(sandbox.detail).toContain('[redacted-path]');
		expect(sandbox.detail).not.toContain('C:\\Users\\Brett\\secret');
		expect(sandbox.detail).not.toContain('/tmp/private/file');
	});

	test('strong kernel mechanism stays ✅ with strength in detail (#1778 H2)', async () => {
		mockCapability = {
			status: 'enabled',
			strength: 'strong',
			mechanism: 'Bubblewrap',
			platform: 'linux',
			v: 1,
			filesystem: 'weak',
			network: 'weak',
			process: 'none',
			effective: 'none',
			reasons: [
				'availability only; denial behavior not independently exercised',
			],
			identity: 'linux:bubblewrap',
		};
		mockExecutor = {
			mechanism: 'Bubblewrap',
			strength: 'strong',
			isAvailable: () => true,
			wrapCommand: (c) => c,
			getEnvOverrides: () => ({}),
		};

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.status).toBe('⚠️');
		expect(sandbox.detail).toContain('effective=none');
		expect(sandbox.detail).toContain('Partial boundary');
	});

	test('detail string mentions mechanism for ⬜ path', async () => {
		mockCapability = {
			status: 'unsupported',
			mechanism: 'none',
			platform: 'linux',
			v: 1,
			filesystem: 'none',
			network: 'none',
			process: 'none',
			effective: 'none',
			reasons: ['sandbox mechanism unavailable'],
			identity: 'linux:none',
		};
		mockExecutor = null;

		const result = await getDiagnoseData('/test/dir');
		const sandbox = result.checks.find((c) => c.name === 'Sandbox')!;

		expect(sandbox.detail).toContain('none');
		expect(sandbox.detail).toContain('Commands not sandboxed');
	});
});
