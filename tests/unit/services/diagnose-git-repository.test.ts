import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import { execFileSync, execSync } from 'node:child_process';

import * as realFs from 'node:fs';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { loadPluginConfig } from '../../../src/config/loader.js';
import type { Plan } from '../../../src/config/plan-schema.js';
import { listEvidenceTaskIds } from '../../../src/evidence/manager.js';
import { readSwarmFileAsync } from '../../../src/hooks/utils.js';
// Import mocked modules
import { loadPlanJsonOnly } from '../../../src/plan/manager.js';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';
import { __seedGitExecutableForTests } from '../../../src/utils/git-executable.js';

// This file holds `checkGitRepository`-related coverage extracted from
// diagnose-service.test.ts and diagnose-service.adversarial.test.ts to keep
// both under the FR-006 line-count ratchet. See .claude/skills/test-file-split/SKILL.md.

// Mock all the imported modules
mock.module('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: mock(() => Promise.resolve(null)),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
mock.module('../../../src/evidence/manager.js', () => ({
	listEvidenceTaskIds: mock(() => Promise.resolve([])),
}));
mock.module('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: mock(() => Promise.resolve(null)),
}));
mock.module('../../../src/config/loader.js', () => ({
	loadPluginConfig: mock(() => null),
}));
mock.module('../../../src/sdd/effective-spec.js', () => ({
	readEffectiveSpecSync: mock(() => null),
}));
mock.module('node:fs', () => ({
	...realFs,
	readdirSync: mock(() => []),
	existsSync: mock(() => true),
	readFileSync: mock(() => '{"version":"7.99.6"}'),
	statSync: mock(() => ({ isDirectory: () => true })),
}));
mock.module('node:child_process', () => ({
	...realChildProcess,
	execSync: mock(() => Buffer.from('.git')),
	execFileSync: mock(() => Buffer.from('.git')),
}));

// Type assertions for mocks
const mockLoadPlanJsonOnly = loadPlanJsonOnly as ReturnType<typeof mock>;
const mockListEvidenceTaskIds = listEvidenceTaskIds as ReturnType<typeof mock>;
const mockReadSwarmFileAsync = readSwarmFileAsync as ReturnType<typeof mock>;
const mockLoadPluginConfig = loadPluginConfig as ReturnType<typeof mock>;
const mockReadEffectiveSpecSync = readEffectiveSpecSync as ReturnType<
	typeof mock
>;
const mockReaddirSync = readdirSync as ReturnType<typeof mock>;
const mockExistsSync = existsSync as ReturnType<typeof mock>;
const mockReadFileSync = readFileSync as ReturnType<typeof mock>;
const mockStatSync = statSync as ReturnType<typeof mock>;
const mockExecSync = execSync as ReturnType<typeof mock>;
const mockExecFileSync = execFileSync as ReturnType<typeof mock>;

// Helper to create minimal valid plan object
function makePlan(
	overrides?: Partial<{ swarm: string; title: string; phases: any[] }>,
): Plan {
	return {
		schema_version: '1.0.0' as const,
		title: overrides?.title ?? 'Test Project',
		swarm: overrides?.swarm ?? 'mega',
		current_phase: 1,
		phases: overrides?.phases ?? [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending' as const,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending' as const,
						size: 'small' as const,
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

// Helper to find a check by name
function findCheck(checks: any[], name: string) {
	return checks.find((c) => c.name === name);
}

const testDirectory = '/test/directory';

beforeEach(() => {
	mock.clearAllMocks();
	mockLoadPlanJsonOnly.mockResolvedValue(null);
	mockListEvidenceTaskIds.mockResolvedValue([]);
	mockReadSwarmFileAsync.mockResolvedValue(null);
	mockLoadPluginConfig.mockReturnValue(null);
	mockReadEffectiveSpecSync.mockReturnValue(null);
	mockReaddirSync.mockReturnValue([]);
	mockExistsSync.mockReturnValue(true);
	mockReadFileSync.mockReturnValue('{"version":"7.99.6"}');
	mockStatSync.mockReturnValue({ isDirectory: () => true });
	mockExecSync.mockReturnValue(Buffer.from('.git'));
	mockExecFileSync.mockReturnValue(Buffer.from('.git'));
	// The resolver's own probing is unrelated to this suite's fixtures; seed
	// it so `checkGitRepository`'s execFileSync call goes through the mock
	// deterministically instead of a real probe.
	__seedGitExecutableForTests('git');
	// restore env var
	delete process.env.OPENCODE_SWARM_ID;
});

afterEach(() => {
	mock.restore();
	delete process.env.OPENCODE_SWARM_ID;
});

describe('checkGitRepository', () => {
	it('should pass when execFileSync succeeds', async () => {
		mockExecFileSync.mockReturnValue(Buffer.from('.git'));

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Git Repository');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('Git repository detected');
	});

	it('should fail when execFileSync throws', async () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error('Not a git repo');
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Git Repository');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toBe(
			'Not a git repository — version control recommended',
		);
	});

	it('should fail when invalid directory', async () => {
		mockExistsSync.mockReturnValue(false);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Git Repository');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toBe('Invalid directory — cannot check git status');
	});
});

describe('DiagnoseService Adversarial Security Tests', () => {
	describe('ATTACK VECTOR 4: plan.swarm with shell metacharacters', () => {
		it('should treat swarm ID with shell metacharacters as plain string', async () => {
			const maliciousPlan: Plan = makePlan({
				swarm: '"; rm -rf /; echo "',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending' as const,
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending' as const,
								size: 'small' as const,
								description: 'Task 1.1',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			});

			mockLoadPlanJsonOnly.mockResolvedValue(maliciousPlan);

			process.env.OPENCODE_SWARM_ID = '"; rm -rf /; echo "';

			const result = await getDiagnoseData(testDirectory);

			const identityCheck = findCheck(result.checks, 'Swarm Identity');
			expect(identityCheck).toBeDefined();
			expect(identityCheck?.status).toBe('✅');
			expect(identityCheck?.detail).toContain('; rm -rf /; echo ');

			// Verify git was invoked in array-argv form (never through a shell
			// string), so the malicious swarm ID has no shell-metacharacter
			// interpretation surface at all.
			expect(mockExecSync).not.toHaveBeenCalled();
			expect(mockExecFileSync).toHaveBeenCalledTimes(1);
			expect(mockExecFileSync).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--git-dir'],
				{
					cwd: testDirectory,
					stdio: 'pipe',
				},
			);
		});
	});
});
