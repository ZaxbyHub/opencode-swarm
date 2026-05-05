import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DriftReport } from '../../../src/hooks/curator-types';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';

// Mock curator functions BEFORE importing the module under test
const mockRunCuratorPhase = mock(async () => ({
	phase: 1,
	agents_dispatched: ['coder'],
	compliance: [],
	knowledge_recommendations: [],
	summary: 'Test curator phase result',
	timestamp: new Date().toISOString(),
}));

const mockApplyCuratorKnowledgeUpdates = mock(async () => ({
	applied: 0,
	skipped: 0,
}));

const mockRunDeterministicDriftCheck = mock(async () => {
	return {
		phase: 1,
		report: {
			schema_version: 1 as const,
			phase: 1,
			timestamp: new Date().toISOString(),
			alignment: 'ALIGNED' as const,
			drift_score: 0,
			first_deviation: null,
			compounding_effects: [],
			corrections: [],
			requirements_checked: 0,
			requirements_satisfied: 0,
			scope_additions: [],
			injection_summary: '',
		},
		report_path: '',
		injection_text: '',
	};
});

const mockReadPriorDriftReports = mock(async (): Promise<DriftReport[]> => []);

mock.module('../../../src/hooks/curator', () => ({
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mockReadPriorDriftReports,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

/**
 * Helper: write retrospective evidence bundle
 */
function writeRetroBundle(
	directory: string,
	phaseNumber: number,
	verdict: 'pass' | 'fail' = 'pass',
): void {
	const retroDir = path.join(
		directory,
		'.swarm',
		'evidence',
		`retro-${phaseNumber}`,
	);
	fs.mkdirSync(retroDir, { recursive: true });

	const retroBundle = {
		schema_version: '1.0.0',
		task_id: `retro-${phaseNumber}`,
		entries: [
			{
				task_id: `retro-${phaseNumber}`,
				type: 'retrospective',
				timestamp: new Date().toISOString(),
				agent: 'architect',
				verdict: verdict,
				summary: 'Phase retrospective',
				phase_number: phaseNumber,
				total_tool_calls: 10,
				coder_revisions: 1,
				reviewer_rejections: 0,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_count: 5,
				task_complexity: 'moderate',
				top_rejection_reasons: [],
				lessons_learned: ['Lesson 1'],
			},
		],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};

	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify(retroBundle, null, 2),
	);
}

/**
 * Helper: write completion-verify.json evidence
 */
function writeCompletionVerify(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });

	const completionVerify = {
		status: 'passed',
		tasksChecked: 1,
		tasksPassed: 1,
		tasksBlocked: 0,
		reason: 'All task identifiers found in source files',
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify(completionVerify, null, 2),
	);
}

/**
 * Helper: create permissive config with optional curator settings
 */
function createConfig(
	curatorConfig?: {
		enabled?: boolean;
		phase_enabled?: boolean;
	},
	phaseCompleteConfig?: {
		required_agents?: string[];
		policy?: 'enforce' | 'warn';
	},
): string {
	const config: Record<string, unknown> = {
		phase_complete: {
			enabled: true,
			required_agents: phaseCompleteConfig?.required_agents ?? ['coder'],
			require_docs: false,
			policy: phaseCompleteConfig?.policy ?? 'enforce',
		},
		curator: {
			enabled: curatorConfig?.enabled ?? false,
			phase_enabled: curatorConfig?.phase_enabled ?? true,
			init_enabled: true,
			max_summary_tokens: 2000,
			min_knowledge_confidence: 0.7,
			compliance_report: true,
			suppress_warnings: true,
			drift_inject_max_chars: 500,
		},
	};

	return JSON.stringify(config);
}

/**
 * Task 2.4: Tighten missing-spec enforcement
 *
 * When spec.md is absent and drift-verifier.json is missing:
 * - If plan.json exists with the phase having incomplete tasks → warning mentions incomplete
 *   task(s) and suggests running critic_drift_verifier, phase succeeds
 * - If plan.json exists with all tasks completed → info message about drift being skipped
 * - If plan.json doesn't exist → warning to consider running critic_drift_verifier
 * - Does NOT block phase completion when spec.md is absent
 * - Blocking behavior when spec.md EXISTS is unchanged
 */
describe('Task 2.4: Tighten missing-spec enforcement in phase-complete', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();
		mockReadPriorDriftReports.mockClear();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-task2-4-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		writeRetroBundle(tempDir, 1, 'pass');
		writeCompletionVerify(tempDir, 1);

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			createConfig(),
		);

		// Set up session with required agents
		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	describe('1. Missing spec.md + missing drift evidence + plan.json with incomplete tasks', () => {
		test('warning mentions "incomplete task(s)" and "consider running critic_drift_verifier", phase succeeds', async () => {
			// Write plan.json with phase 1 having incomplete tasks
			// No tasks are 'completed' to avoid triggering completion-verify blocks
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								description: 'done',
							},
							{
								id: '1.2',
								phase: 1,
								status: 'in_progress',
								description: 'Incomplete task',
							},
							{
								id: '1.3',
								phase: 1,
								status: 'pending',
								description: 'Another incomplete task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Ensure NO spec.md and NO drift-verifier.json
			const specPath = path.join(tempDir, '.swarm', 'spec.md');
			expect(fs.existsSync(specPath)).toBe(false);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed (advisory-only mode)
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Warning should mention incomplete tasks and suggest running critic_drift_verifier
			const warning = parsed.warnings.find((w: string) =>
				w.includes('incomplete task'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('incomplete task(s)');
			expect(warning).toContain('consider running critic_drift_verifier');
			expect(warning).toContain('3 incomplete task(s)'); // all 3 tasks are non-completed
		});

		test('phase with incomplete tasks shows correct count', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								description: 'One incomplete task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const warning = parsed.warnings.find((w: string) =>
				w.includes('incomplete task'),
			);
			expect(warning).toContain('1 incomplete task(s)');
		});
	});

	describe('2. Missing spec.md + missing drift evidence + plan.json with all tasks completed', () => {
		test('warning includes "Drift verification was skipped", phase succeeds', async () => {
			// Write plan.json with phase 1 having all tasks completed
			// Create a source file so completion-verify can find identifiers
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() { return true; }\n',
			);

			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
							{
								id: '1.2',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Warning should indicate drift verification was skipped
			const warning = parsed.warnings.find((w: string) =>
				w.includes('Drift verification was skipped'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('Drift verification was skipped');
			expect(warning).toContain('all completed');
		});
	});

	describe('3. Missing spec.md + missing drift evidence + no plan.json', () => {
		test('warning includes "No spec.md found" and "consider running critic_drift_verifier", phase succeeds', async () => {
			// Ensure NO plan.json exists
			const planPath = path.join(tempDir, '.swarm', 'plan.json');
			if (fs.existsSync(planPath)) {
				fs.unlinkSync(planPath);
			}

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed (advisory-only mode)
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Warning should mention no spec.md and suggest running critic_drift_verifier
			const warning = parsed.warnings.find((w: string) =>
				w.includes('No spec.md found'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('No spec.md found');
			expect(warning).toContain('consider running critic_drift_verifier');
		});

		test('plan.json exists but phase not found in plan -> completion-verify blocks (pre-existing behavior)', async () => {
			// Write plan.json with different phase (phase 2 instead of 1)
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 2,
				phases: [
					{
						id: 2,
						name: 'Phase 2',
						status: 'pending',
						tasks: [
							{
								id: '2.1',
								phase: 2,
								status: 'completed',
								description: 'Phase 2 task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Completion-verify blocks when phase is not found in plan.json
			// This is pre-existing behavior, not related to Task 2.4 drift enforcement
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('COMPLETION_INCOMPLETE');
			expect(parsed.message).toContain('Phase 1 not found in plan.json');
		});
	});

	describe('4. Existing behavior preserved: spec.md exists + missing drift evidence', () => {
		test('BLOCKED with DRIFT_VERIFICATION_MISSING when spec.md exists', async () => {
			// Create spec.md
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\nSome requirements for the phase.',
			);

			// Ensure NO drift-verifier.json
			const driftPath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				'1',
				'drift-verifier.json',
			);
			expect(fs.existsSync(driftPath)).toBe(false);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
			expect(parsed.message).toContain('.swarm/evidence/1/drift-verifier.json');
		});

		test('BLOCKED even when plan.json has all tasks completed and spec.md exists', async () => {
			// Create spec.md
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\nSome requirements.',
			);

			// Create a source file so completion-verify passes
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() { return true; }\n',
			);

			// Write plan.json with all tasks completed
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should still be blocked because spec.md exists and drift evidence is missing
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});
	});

	describe('Edge cases for advisory-only warnings', () => {
		test('phase with no tasks in plan.json -> warning includes critic_drift_verifier', async () => {
			// Write plan.json with phase 1 having empty tasks array
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed
			expect(parsed.success).toBe(true);

			// Warning should mention critic_drift_verifier since 0 incomplete but planPhaseFound=true
			// Actually 0 incomplete AND planPhaseFound=true means the "all completed" path
			// But since tasks array is empty (not "all completed"), let's check
			const driftWarning = parsed.warnings.find((w: string) =>
				w.includes('Drift verification was skipped'),
			);
			expect(driftWarning).toBeDefined();
		});

		test('malformed plan.json is treated as missing -> warning includes critic_drift_verifier', async () => {
			// Write malformed JSON to plan.json
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				'{ invalid json } garbage',
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed (advisory-only mode)
			expect(parsed.success).toBe(true);

			// Warning should mention no spec.md and suggest running critic_drift_verifier
			const warning = parsed.warnings.find((w: string) =>
				w.includes('No spec.md found'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('No spec.md found');
			expect(warning).toContain('consider running critic_drift_verifier');
		});
	});
});
