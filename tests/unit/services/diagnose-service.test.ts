import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../../../src/config/plan-schema.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';

// Mock all the imported modules
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: vi.fn(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
vi.mock('../../../src/evidence/manager.js', () => ({
	listEvidenceTaskIds: vi.fn(),
}));
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: vi.fn(),
}));
vi.mock('../../../src/config/loader.js', () => ({
	loadPluginConfig: vi.fn(),
}));
vi.mock('../../../src/sdd/effective-spec.js', () => ({
	readEffectiveSpecSync: vi.fn(),
}));
vi.mock('node:fs', () => ({
	readdirSync: vi.fn(),
	existsSync: vi.fn(),
	statSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { loadPluginConfig } from '../../../src/config/loader.js';
import { listEvidenceTaskIds } from '../../../src/evidence/manager.js';
import { readSwarmFileAsync } from '../../../src/hooks/utils.js';
// Import mocked modules
import { loadPlanJsonOnly } from '../../../src/plan/manager.js';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec.js';

// Type assertions for mocks
const mockLoadPlanJsonOnly = loadPlanJsonOnly as ReturnType<typeof vi.fn>;
const mockListEvidenceTaskIds = listEvidenceTaskIds as ReturnType<typeof vi.fn>;
const mockReadSwarmFileAsync = readSwarmFileAsync as ReturnType<typeof vi.fn>;
const mockLoadPluginConfig = loadPluginConfig as ReturnType<typeof vi.fn>;
const mockReadEffectiveSpecSync = readEffectiveSpecSync as ReturnType<
	typeof vi.fn
>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockExecSync = execSync as ReturnType<typeof vi.fn>;

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

function effectiveSpec(content: string) {
	return {
		source: 'swarm',
		content,
		hash: 'test-hash',
		mtime: null,
		sourcePaths: ['.swarm/spec.md'],
		warnings: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadPlanJsonOnly.mockResolvedValue(null);
	mockListEvidenceTaskIds.mockResolvedValue([]);
	mockReadSwarmFileAsync.mockResolvedValue(null);
	mockLoadPluginConfig.mockReturnValue(null);
	mockReadEffectiveSpecSync.mockReturnValue(null);
	mockReaddirSync.mockReturnValue([]);
	mockExistsSync.mockReturnValue(true);
	mockStatSync.mockReturnValue({ isDirectory: () => true });
	mockExecSync.mockReturnValue(Buffer.from('.git'));
	// restore env var
	delete process.env.OPENCODE_SWARM_ID;
});

afterEach(() => {
	delete process.env.OPENCODE_SWARM_ID;
});

describe('checkSwarmIdentity', () => {
	it('should pass with no plan and no env var', async () => {
		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Swarm Identity');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No conflict detected');
	});

	it('should fail with plan exists but no env var', async () => {
		mockLoadPlanJsonOnly.mockResolvedValue(makePlan());

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Swarm Identity');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('OPENCODE_SWARM_ID not set');
	});

	it('should pass with no plan but env var set', async () => {
		process.env.OPENCODE_SWARM_ID = 'test-swarm';

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Swarm Identity');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('No plan, but OPENCODE_SWARM_ID');
		expect(check.detail).toContain('test-swarm');
	});

	it('should pass when plan.swarm matches env var', async () => {
		process.env.OPENCODE_SWARM_ID = 'mega';
		mockLoadPlanJsonOnly.mockResolvedValue(makePlan({ swarm: 'mega' }));

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Swarm Identity');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('consistent');
		expect(check.detail).toContain('mega');
	});

	it('should fail when plan.swarm mismatches env var', async () => {
		process.env.OPENCODE_SWARM_ID = 'different-swarm';
		mockLoadPlanJsonOnly.mockResolvedValue(makePlan({ swarm: 'mega' }));

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Swarm Identity');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('mismatch');
		expect(check.detail).toContain('mega');
		expect(check.detail).toContain('different-swarm');
	});
});

describe('checkPhaseBoundaries', () => {
	it('should pass with no plan', async () => {
		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Phase Boundaries');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No plan to validate');
	});

	it('should pass when all tasks correctly aligned', async () => {
		const plan = makePlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Task 2',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Phase Boundaries');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
	});

	it('should fail when task 2.3 found in phase 1', async () => {
		const plan = makePlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending' as const,
					tasks: [
						{
							id: '2.3',
							phase: 2,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'Wrong Phase Task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Phase Boundaries');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('Task 2.3 found under Phase 1');
	});

	it('should fail when task has non-numeric ID', async () => {
		const plan = makePlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending' as const,
					tasks: [
						{
							id: 'invalid-id',
							phase: 1,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'Invalid Task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Phase Boundaries');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('invalid phase number');
	});
});

describe('checkOrphanedEvidence', () => {
	it('should pass with no plan', async () => {
		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Orphaned Evidence');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No plan to cross-reference');
	});

	it('should pass when all evidence IDs in plan', async () => {
		const plan = makePlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'completed' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed' as const,
							size: 'small' as const,
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2']);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Orphaned Evidence');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain(
			'All evidence entries reference valid plan tasks',
		);
	});

	it('should pass when retro-1 not in plan (excluded by filter)', async () => {
		const plan = makePlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1', 'retro-1']);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Orphaned Evidence');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain(
			'All evidence entries reference valid plan tasks',
		);
	});

	it('should fail when orphaned evidence ID not in plan', async () => {
		const plan = makePlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1', 'orphaned-task']);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Orphaned Evidence');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('orphaned-task');
	});
});

describe('checkPlanSync', () => {
	it('should pass with no plan', async () => {
		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Plan Sync');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No plan.json present');
	});

	it('should pass when plan exists but no plan.md', async () => {
		const plan = makePlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Plan Sync');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('plan.md not present');
	});

	it('should pass when counts match', async () => {
		const plan = makePlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockReadSwarmFileAsync.mockImplementation(async (_dir, file) => {
			if (file === 'plan.md') {
				return '- [ ] Task 1 [SMALL]\n- [ ] Task 2 [MEDIUM]\n';
			}
			return null;
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Plan Sync');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('both have 2 tasks');
	});

	it('should fail when counts mismatch', async () => {
		const plan = makePlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockReadSwarmFileAsync.mockImplementation(async (_dir, file) => {
			if (file === 'plan.md') {
				return '- [ ] Task 1 [SMALL]\n- [ ] Task 2 [MEDIUM]\n';
			}
			return null;
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Plan Sync');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('run /swarm sync-plan');
	});
});

describe('checkConfigBackups', () => {
	it('should pass with 0 backup files', async () => {
		mockReaddirSync.mockReturnValue([]);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Backups');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('0 backup file(s)');
	});

	it('should pass with 5 backup files', async () => {
		mockReaddirSync.mockReturnValue([
			'.opencode-swarm.yaml.bak1',
			'.opencode-swarm.yaml.bak2',
			'.opencode-swarm.yaml.bak3',
			'.opencode-swarm.yaml.bak4',
			'.opencode-swarm.yaml.bak5',
		]);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Backups');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('5 backup file(s)');
	});

	it('should fail with 6 backup files', async () => {
		mockReaddirSync.mockReturnValue(
			Array.from({ length: 6 }, (_, i) => `.opencode-swarm.yaml.bak${i + 1}`),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Backups');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('consider cleanup');
	});

	it('should fail with 20 backup files', async () => {
		mockReaddirSync.mockReturnValue(
			Array.from({ length: 20 }, (_, i) => `.opencode-swarm.yaml.bak${i + 1}`),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Backups');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('cleanup required');
	});
});

describe('checkGitRepository', () => {
	it('should pass when execSync succeeds', async () => {
		mockExecSync.mockReturnValue(Buffer.from('.git'));

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Git Repository');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('Git repository detected');
	});

	it('should fail when execSync throws', async () => {
		mockExecSync.mockImplementation(() => {
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

describe('checkSpecStaleness', () => {
	it('should pass with no spec', async () => {
		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Spec Staleness');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No effective spec present');
	});

	it('should pass with spec but no plan', async () => {
		mockReadEffectiveSpecSync.mockReturnValue(
			effectiveSpec('# My Spec\n\nSome content'),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Spec Staleness');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No plan to compare spec against');
	});

	it('should pass when spec title matches plan title (case-insensitive)', async () => {
		const plan = makePlan({ title: 'Test Project' });
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockReadEffectiveSpecSync.mockReturnValue(
			effectiveSpec('# test project\n\nSome content'),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Spec Staleness');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('aligned');
	});

	it('should fail when spec title mismatches plan title', async () => {
		const plan = makePlan({ title: 'Test Project' });
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockReadEffectiveSpecSync.mockReturnValue(
			effectiveSpec('# Different Title\n\nSome content'),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Spec Staleness');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('mismatch');
	});

	it('should pass when spec has no H1 title', async () => {
		const plan = makePlan({ title: 'Test Project' });
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockReadEffectiveSpecSync.mockReturnValue(
			effectiveSpec('## Subheading\n\nSome content without H1'),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Spec Staleness');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('not detectable');
	});
});
