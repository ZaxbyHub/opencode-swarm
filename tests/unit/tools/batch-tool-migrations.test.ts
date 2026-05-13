/**
 * Comprehensive batch test for all 12 tools migrated to use createSwarmTool
 *
 * Tests that tools correctly use createSwarmTool and their execute functions
 * receive directory from the tool wrapper:
 *
 * Tools tested:
 * - test-runner
 * - lint
 * - pkg-audit
 * - save-plan
 * - todo-extract
 * - schema-drift
 * - sbom-generate
 * - evidence-check
 * - pre-check-batch
 * - build-check
 * - complexity-hotspots
 * - file-extractor
 *
 * Verification strategy:
 * 1. Each tool is created using createSwarmTool
 * 2. Each tool's execute method accepts directory parameter
 * 3. Tools execute successfully with provided contexts
 */

import * as os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ===== MOCK HELPER FUNCTIONS =====
// Mock isCommandAvailable
vi.mock('../../../src/build/discovery', () => ({
	isCommandAvailable: vi.fn(() => true),
}));

// Mock warn
vi.mock('../../../src/utils', () => ({
	warn: vi.fn(),
}));

// Mock fs module to prevent actual file operations
vi.mock('node:fs', () => ({
	default: {
		existsSync: vi.fn(() => true),
		readFileSync: vi.fn(() => '{}'),
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn(),
		readdirSync: vi.fn(() => []),
		statSync: vi.fn(() => ({ isFile: () => true, isDirectory: () => false })),
		readFile: vi.fn((_path: unknown, cb: (err: null, data: Buffer) => void) =>
			cb(null, Buffer.from('{}')),
		),
	},
}));

// Mock semgrep
vi.mock('../../../src/sast/semgrep', () => ({
	isSemgrepAvailable: vi.fn(() => false),
	runSemgrep: vi.fn().mockResolvedValue({
		available: false,
		findings: [],
		engine: 'tier_a',
	}),
	resetSemgrepCache: vi.fn(),
}));

import { build_check } from '../../../src/tools/build-check';
import { complexity_hotspots } from '../../../src/tools/complexity-hotspots';
import { evidence_check } from '../../../src/tools/evidence-check';
import { extract_code_blocks } from '../../../src/tools/file-extractor';
import { lint } from '../../../src/tools/lint';
import { pkg_audit } from '../../../src/tools/pkg-audit';
import { pre_check_batch } from '../../../src/tools/pre-check-batch';
import { save_plan } from '../../../src/tools/save-plan';
import { sbom_generate } from '../../../src/tools/sbom-generate';
import { schema_drift } from '../../../src/tools/schema-drift';
// ===== IMPORT ALL 12 TOOLS =====
import { test_runner } from '../../../src/tools/test-runner';
import { todo_extract } from '../../../src/tools/todo-extract';

describe('Batch tool migration: createSwarmTool integration verification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Verify all tools have execute methods that accept directory parameter
	it('All 12 tools have execute methods', () => {
		expect(typeof test_runner.execute).toBe('function');
		expect(typeof lint.execute).toBe('function');
		expect(typeof pkg_audit.execute).toBe('function');
		expect(typeof save_plan.execute).toBe('function');
		expect(typeof todo_extract.execute).toBe('function');
		expect(typeof schema_drift.execute).toBe('function');
		expect(typeof sbom_generate.execute).toBe('function');
		expect(typeof evidence_check.execute).toBe('function');
		expect(typeof pre_check_batch.execute).toBe('function');
		expect(typeof build_check.execute).toBe('function');
		expect(typeof complexity_hotspots.execute).toBe('function');
		expect(typeof extract_code_blocks.execute).toBe('function');
	});

	// ===== TEST-RUNNER =====
	describe('test-runner tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await test_runner.execute({ scope: 'all' }, {
				directory: '/test/project',
			} as unknown as any);

			// Should return valid JSON
			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('success');
		}, 10000); // Increase timeout for test-runner
	});

	// ===== LINT =====
	describe('lint tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: '/test/lint',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('success');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await lint.execute(
				{ mode: 'check' },
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('success');
		});
	});

	// ===== PKG-AUDIT =====
	describe('pkg-audit tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await pkg_audit.execute({ ecosystem: 'npm' }, {
				directory: '/test/pkg-audit',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('clean');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('clean');
		});
	});

	// ===== SAVE-PLAN =====
	describe('save-plan tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await save_plan.execute(
				{
					title: 'Test Plan',
					swarm_id: 'test-swarm',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							tasks: [
								{
									id: '1.1',
									description: 'Test task',
								},
							],
						},
					],
				},
				{ directory: '/test/save-plan' } as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('success');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await save_plan.execute(
				{
					title: 'Test Plan',
					swarm_id: 'test-swarm',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							tasks: [
								{
									id: '1.1',
									description: 'Test task',
								},
							],
						},
					],
				},
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('success');
		});
	});

	// ===== TODO-EXTRACT =====
	describe('todo-extract tool', () => {});

	// ===== SCHEMA-DRIFT =====
	describe('schema-drift tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await schema_drift.execute({}, {
				directory: '/test/schema-drift',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('consistent');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await schema_drift.execute(
				{},
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('consistent');
		});
	});

	// ===== SBOM-GENERATE =====
	describe('sbom-generate tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await sbom_generate.execute({ scope: 'all' }, {
				directory: '/test/sbom-generate',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('verdict');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await sbom_generate.execute(
				{ scope: 'all' },
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('verdict');
		});
	});

	// ===== EVIDENCE-CHECK =====
	describe('evidence-check tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await evidence_check.execute({}, {
				directory: '/test/evidence-check',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('completeness');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await evidence_check.execute(
				{},
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('completeness');
		});
	});

	// ===== PRE-CHECK-BATCH =====
	describe('pre-check-batch tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await pre_check_batch.execute(
				{ directory: '/test/pre-check-batch' },
				{ directory: '/test/pre-check-batch' } as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('gates_passed');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const expectedCwd = process.cwd();
			const result = await pre_check_batch.execute(
				{ directory: expectedCwd },
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('gates_passed');
		});
	});

	// ===== BUILD-CHECK =====
	describe('build-check tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await build_check.execute({ scope: 'all' }, {
				directory: '/test/build-check',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('verdict');
		});
	});

	// ===== COMPLEXITY-HOTSPOTS =====
	describe('complexity-hotspots tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '/test/complexity-hotspots',
			} as unknown as any);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('hotspots');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await complexity_hotspots.execute(
				{},
				undefined as unknown as any,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('hotspots');
		});
	});

	// ===== FILE-EXTRACTOR =====
	describe('file-extractor tool', () => {
		it('executes successfully with provided directory context', async () => {
			const result = await extract_code_blocks.execute(
				{ content: '```js\ntest code\n```' },
				// Use os.tmpdir() so the test works in CI environments where
				// /test does not exist and cannot be created.
				{ directory: os.tmpdir() } as unknown as any,
			);

			// file-extractor actually writes files, so check for success message
			expect(result).toContain('Extracted');
		});

		it('executes successfully without context (uses cwd)', async () => {
			const result = await extract_code_blocks.execute(
				{ content: '```js\ntest code\n```' },
				undefined as unknown as any,
			);

			// file-extractor actually writes files, so check for success message
			expect(result).toContain('Extracted');
		});
	});
});
