/**
 * Adversarial security tests for drift_check QA gate in phase-complete.ts
 * Tests: JSON injection, prototype pollution, path traversal, oversized payloads,
 *        ReDoS, race conditions, boundary violations, missing fields, type confusion
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../src/db/project-db';
import type { QaGateProfile } from '../../../src/db/qa-gate-profile';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

// Mutable state for mock
let mockProfileReturnValue: QaGateProfile | null = null;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'Test Plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

/**
 * Mock getProfile function
 */
function mockGetProfile(dir: string, planId: string): QaGateProfile | null {
	return mockProfileReturnValue;
}

// Mock the qa-gate-profile module BEFORE importing phase_complete
mock.module('../../../src/db/qa-gate-profile.js', () => ({
	getProfile: mockGetProfile,
	getOrCreateProfile: mock((dir: string, planId: string) => {
		const {
			getOrCreateProfile: real,
		} = require('../../../src/db/qa-gate-profile.js');
		return real(dir, planId);
	}),
	setGates: mock(
		(dir: string, planId: string, gates: Record<string, boolean>) => {
			const { setGates: real } = require('../../../src/db/qa-gate-profile.js');
			return real(dir, planId, gates);
		},
	),
	getEffectiveGates: mock(
		(profile: QaGateProfile, overrides: Record<string, boolean>) => {
			const {
				getEffectiveGates: real,
			} = require('../../../src/db/qa-gate-profile.js');
			return real(profile, overrides);
		},
	),
	computeProfileHash: mock((profile: QaGateProfile) => {
		const {
			computeProfileHash: real,
		} = require('../../../src/db/qa-gate-profile.js');
		return real(profile);
	}),
	lockProfile: mock((dir: string, planId: string, snapshotSeq: number) => {
		const { lockProfile: real } = require('../../../src/db/qa-gate-profile.js');
		return real(dir, planId, snapshotSeq);
	}),
	DEFAULT_QA_GATES: {
		reviewer: true,
		test_engineer: true,
		council_mode: false,
		sme_enabled: true,
		critic_pre_plan: true,
		hallucination_guard: false,
		sast_enabled: true,
		mutation_test: false,
		council_general_review: false,
		drift_check: true,
	},
}));

function createMockProfile(driftCheckValue: boolean): QaGateProfile {
	return {
		id: 1,
		plan_id: PLAN_ID,
		created_at: new Date().toISOString(),
		project_type: null,
		gates: {
			reviewer: true,
			test_engineer: true,
			council_mode: false,
			sme_enabled: true,
			critic_pre_plan: true,
			hallucination_guard: false,
			sast_enabled: true,
			mutation_test: false,
			council_general_review: false,
			drift_check: driftCheckValue,
		},
		locked_at: null,
		locked_by_snapshot_seq: null,
	};
}

function setupBaseDir(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });

	const planJson = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				type: 'code',
				tasks: [{ id: '1.1', status: 'pending', description: 'Test task' }],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson, null, 2),
	);

	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
		}),
	);
}

function writeRetroBundle(dir: string, phase: number): void {
	const retroDir = path.join(dir, '.swarm', 'evidence', `retro-${phase}`);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}),
	);
}

function writeSpecMd(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
	);
}

function writeDriftEvidence(
	directory: string,
	phaseNumber: number,
	verdict: 'approved' | 'rejected',
	summary: string,
): void {
	const driftDir = path.join(
		directory,
		'.swarm',
		'evidence',
		String(phaseNumber),
	);
	fs.mkdirSync(driftDir, { recursive: true });

	const driftEvidence = {
		schema_version: '1.0.0',
		task_id: `drift-verifier-${phaseNumber}`,
		entries: [
			{
				task_id: `drift-verifier-${phaseNumber}`,
				type: 'drift',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: verdict,
				summary: summary,
			},
		],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};

	fs.writeFileSync(
		path.join(driftDir, 'drift-verifier.json'),
		JSON.stringify(driftEvidence, null, 2),
	);
}

describe('phase-complete drift_check adversarial tests', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		closeAllProjectDbs();
		mockProfileReturnValue = createMockProfile(true);

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'drift-check-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupBaseDir(tempDir);
		writeRetroBundle(tempDir, 1);

		ensureAgentSession('test-session');
		recordPhaseAgentDispatch('test-session', 'coder');
		swarmState.agentSessions.get('test-session')!.turboMode = false;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		closeAllProjectDbs();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	// ========== GROUP 1: Path Traversal in Phase Number ==========
	describe('Group 1: Path traversal in phase number', () => {
		it('blocks phase with "../" path traversal in phase number', async () => {
			const phaseArg = '../1';

			const result = await executePhaseComplete(
				{ phase: phaseArg as unknown as number, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Should be blocked - invalid phase number
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.message).toContain('Invalid phase number');
		});

		it('blocks Windows-style path traversal "..\\.." in phase number', async () => {
			const phaseArg = '..\\..\\etc';

			const result = await executePhaseComplete(
				{ phase: phaseArg as unknown as number, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks null byte injection in phase number', async () => {
			const phaseArg = '1\x00/../../etc';

			const result = await executePhaseComplete(
				{ phase: phaseArg as unknown as number, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks absolute path as phase number', async () => {
			const phaseArg = '/etc/passwd';

			const result = await executePhaseComplete(
				{ phase: phaseArg as unknown as number, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});
	});

	// ========== GROUP 2: Boundary Values for Phase ==========
	describe('Group 2: Boundary values for phase number', () => {
		it('blocks phase=0', async () => {
			const result = await executePhaseComplete(
				{ phase: 0, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.message).toContain('Invalid phase number');
		});

		it('blocks phase=-1 (negative)', async () => {
			const result = await executePhaseComplete(
				{ phase: -1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks phase=Infinity', async () => {
			const result = await executePhaseComplete(
				{ phase: Infinity, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks phase=-Infinity', async () => {
			const result = await executePhaseComplete(
				{ phase: -Infinity, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks phase=NaN', async () => {
			const result = await executePhaseComplete(
				{ phase: NaN, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks non-integer phase (float)', async () => {
			const result = await executePhaseComplete(
				{ phase: 1.5, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});

		it('blocks extremely large phase number', async () => {
			const result = await executePhaseComplete(
				{ phase: Number.MAX_SAFE_INTEGER, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});
	});

	// ========== GROUP 3: Prototype Pollution in plan.json ==========
	describe('Group 3: Prototype pollution in plan.json', () => {
		it('rejects plan.json with __proto__ pollution', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						type: 'code',
						tasks: [{ id: '1.1', status: 'completed', description: 'test' }],
					},
				],
				__proto__: {
					isAdmin: true,
					drift_check: false,
				},
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Should still block because drift evidence is missing
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});

		it('rejects plan.json with constructor property pollution', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						type: 'code',
						tasks: [{ id: '1.1', status: 'completed', description: 'test' }],
					},
				],
				constructor: {
					prototype: {
						drift_check: false,
					},
				},
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});

		it('handles plan.json with hasOwnProperty as key', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						type: 'code',
						tasks: [{ id: '1.1', status: 'completed', description: 'test' }],
					},
				],
			};
			// Add hasOwnProperty as a phase property
			(planJson as Record<string, unknown>)['hasOwnProperty'] = {
				pollute: true,
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Should not crash - should handle gracefully
			expect(parsed.phase).toBe(1);
		});
	});

	// ========== GROUP 4: Oversized plan.json ==========
	describe('Group 4: Oversized plan.json payloads', () => {
		it('handles extremely large plan.json without memory crash', async () => {
			// Create a plan with many phases and tasks
			const phases = [];
			for (let p = 1; p <= 100; p++) {
				const tasks = [];
				for (let t = 1; t <= 100; t++) {
					tasks.push({
						id: `${p}.${t}`,
						phase: p,
						status: 'completed',
						description: 'X'.repeat(1000),
						depends: [],
						files_touched: [],
					});
				}
				phases.push({
					id: p,
					name: `Phase ${p}`,
					status: 'completed',
					type: 'code',
					tasks,
				});
			}

			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 100,
				phases,
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeRetroBundle(tempDir, 100);
			writeSpecMd(tempDir);
			writeDriftEvidence(tempDir, 100, 'approved', 'No drift detected');

			const result = await executePhaseComplete(
				{ phase: 100, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Should not crash - result should be valid JSON
			expect(parsed).toBeDefined();
			expect(typeof parsed.success).toBe('boolean');
		}, 30000);
	});

	// ========== GROUP 5: ReDoS in Phase Type ==========
	describe('Group 5: ReDoS-prone phase type strings', () => {
		it('handles regex-problematic phase type without ReDoS', async () => {
			const dangerousType = '(\n?|[^\\n]*)+';

			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						type: dangerousType,
						tasks: [{ id: '1.1', status: 'completed', description: 'test' }],
					},
				],
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const startTime = Date.now();
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const elapsed = Date.now() - startTime;

			expect(elapsed).toBeLessThan(5000);

			const parsed = JSON.parse(result);
			expect(parsed).toBeDefined();
		});

		it('handles deeply nested JSON without crashing', async () => {
			let nested: Record<string, unknown> = { phase: 1 };
			for (let i = 0; i < 100; i++) {
				nested = { nested };
			}

			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						type: 'code',
						tasks: [
							{
								id: '1.1',
								status: 'completed',
								description: 'test',
								...nested,
							},
						],
					},
				],
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.phase).toBe(1);
		});
	});

	// ========== GROUP 6: Missing/Partial Fields in drift-verifier.json ==========
	describe('Group 6: Missing fields in drift-verifier.json', () => {
		it('blocks when drift-verifier.json has missing verdict field', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			// Missing verdict field
			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'drift-verifier-1',
					entries: [
						{
							task_id: 'drift-verifier-1',
							type: 'drift',
							timestamp: new Date().toISOString(),
							agent: 'critic',
							summary: 'No verdict provided',
						},
					],
				}),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		it('blocks when drift-verifier.json has missing type field', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			// Missing type field
			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'drift-verifier-1',
					entries: [
						{
							task_id: 'drift-verifier-1',
							timestamp: new Date().toISOString(),
							agent: 'critic',
							verdict: 'approved',
							summary: 'Missing type field',
						},
					],
				}),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});

		it('blocks when drift-verifier.json has empty entries array', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'drift-verifier-1',
					entries: [],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});

		it('blocks when drift-verifier.json entries have null values', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'drift-verifier-1',
					entries: [
						{
							task_id: null,
							type: null,
							verdict: null,
							timestamp: null,
							agent: null,
							summary: null,
						},
					],
				}),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		it('blocks when drift-verifier.json has type not containing "drift"', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'drift-verifier-1',
					entries: [
						{
							task_id: 'drift-verifier-1',
							type: 'review',
							timestamp: new Date().toISOString(),
							agent: 'critic',
							verdict: 'approved',
							summary: 'Not a drift entry',
						},
					],
				}),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});
	});

	// ========== GROUP 7: Type Confusion - plan.json phases as string ==========
	describe('Group 7: Type confusion - phases as string instead of array', () => {
		it('handles plan.json with phases as string gracefully', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: 'not an array',
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
			expect(typeof parsed.success).toBe('boolean');
		});

		it('handles plan.json with phases as number', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: 123,
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
		});

		it('handles plan.json with null phases', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: null,
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
		});
	});

	// ========== GROUP 8: Invalid JSON in drift-verifier.json ==========
	describe('Group 8: Invalid JSON in drift-verifier.json', () => {
		it('handles drift-verifier.json that is not valid JSON', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			// Write invalid JSON
			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				'{ this is not valid JSON',
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		it('handles empty drift-verifier.json', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			fs.writeFileSync(path.join(driftDir, 'drift-verifier.json'), '');

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});
	});

	// ========== GROUP 9: Unicode/Encoding Attacks ==========
	describe('Group 9: Unicode and encoding attacks', () => {
		it('handles plan.json with Unicode null byte equivalent', async () => {
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase\u00001',
						status: 'in_progress',
						type: 'code',
						tasks: [{ id: '1.1', status: 'completed', description: 'test' }],
					},
				],
			};

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
		});

		it('handles drift-verifier.json with RTL override characters', async () => {
			const driftDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(driftDir, { recursive: true });

			fs.writeFileSync(
				path.join(driftDir, 'drift-verifier.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'drift-verifier-1',
					entries: [
						{
							task_id: 'drift-verifier-1',
							type: 'drift',
							timestamp: new Date().toISOString(),
							agent: 'architect',
							verdict: 'approved',
							summary: 'Test\u202Esummary',
						},
					],
				}),
			);

			writeSpecMd(tempDir);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});

	// ========== GROUP 10: Drift Evidence with Wrong Phase Number ==========
	describe('Group 10: Drift evidence phase number mismatch', () => {
		it('blocks when drift-verifier.json is from wrong phase', async () => {
			// Create plan with phase 2
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						type: 'code',
						tasks: [{ id: '1.1', status: 'completed', description: 'test' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'pending',
						type: 'code',
						tasks: [],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson),
			);

			writeRetroBundle(tempDir, 1);
			writeSpecMd(tempDir);

			// Write drift evidence for phase 2 (not phase 1)
			writeDriftEvidence(tempDir, 2, 'approved', 'Phase 2 drift check passed');

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});
	});
});
