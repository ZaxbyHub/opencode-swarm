import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	getOrCreateProfile,
	lockProfile,
	setGates,
	setGatesForIdentity,
} from '../../../src/db/qa-gate-profile';
import { executeSetQaGates } from '../../../src/tools/set-qa-gates';
import { checkCouncilGate } from '../../../src/tools/update-task-status';

type CouncilGate = {
	verdict?: 'APPROVE' | 'CONCERNS' | 'REJECT';
	sessionId?: string;
	timestamp?: string;
	agent?: string;
	quorumSize?: number;
	workflowGeneration?: number;
};

type CouncilEnabledValue = boolean | undefined;

interface FixtureOptions {
	councilEnabled: CouncilEnabledValue;
	councilGate?: CouncilGate | null;
	/** When true, writes plan.json and creates a QA gate profile with council_mode=true */
	councilModeEnabled?: boolean;
}

let tempDir: string;

const TASK_ID = '1.1';

// plan_id derived by the same formula as derivePlanIdFromPlan in state.ts
const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const PLAN_IDENTITY = { swarm: PLAN_SWARM, title: PLAN_TITLE };

function writeFixture(opts: FixtureOptions): void {
	// .opencode/opencode-swarm.json
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	const configBody: Record<string, unknown> = {};
	if (opts.councilEnabled !== undefined) {
		configBody.council = { enabled: opts.councilEnabled };
	}
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(configBody),
	);

	// .swarm/plan.json — required for the AND-gate council_mode check
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: PLAN_SWARM,
			title: PLAN_TITLE,
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: TASK_ID,
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		}),
	);

	// QA gate profile in the project DB — write council_mode if requested
	if (opts.councilModeEnabled) {
		setGatesForIdentity(tempDir, PLAN_IDENTITY, { council_mode: true });
	}

	// .swarm/evidence/1.1.json
	mkdirSync(join(tempDir, '.swarm', 'evidence'), { recursive: true });
	const gates: Record<string, unknown> = {
		reviewer: {
			sessionId: 'swarm-1',
			timestamp: '2026-04-13T00:00:00.000Z',
			agent: 'reviewer',
		},
		test_engineer: {
			sessionId: 'swarm-1',
			timestamp: '2026-04-13T00:00:00.000Z',
			agent: 'test_engineer',
		},
	};
	if (opts.councilGate) {
		gates.council = {
			sessionId: 'swarm-1',
			timestamp: '2026-04-13T00:00:00.000Z',
			agent: 'architect',
			workflowGeneration: 1,
			...opts.councilGate,
		};
	}
	writeFileSync(
		join(tempDir, '.swarm', 'evidence', `${TASK_ID}.json`),
		JSON.stringify({
			taskId: TASK_ID,
			required_gates: ['reviewer', 'test_engineer'],
			gates,
			workflow: {
				schema: 'exact-task-v1',
				generation: 1,
				state: 'pre_check_passed',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'stage_a_passed',
				lastTransitionId: 'fixture-stage-a',
				updatedAt: '2026-04-13T00:00:00.000Z',
			},
		}),
	);
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'update-task-status-council-'));
});

afterEach(() => {
	// Close project DB before deleting temp dir to avoid EBUSY on Windows
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('checkCouncilGate — council.enabled=true AND council_mode=true (fully active)', () => {
	test('gates.council absent → blocked with "council gate required" reason', () => {
		writeFixture({
			councilEnabled: true,
			councilModeEnabled: true,
			councilGate: null,
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/council gate required/);
	});

	test('gates.council.verdict=REJECT → blocked with "council gate blocked" reason', () => {
		writeFixture({
			councilEnabled: true,
			councilModeEnabled: true,
			councilGate: { verdict: 'REJECT' },
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/council gate blocked/);
	});

	test('gates.council.verdict=APPROVE with quorumSize=3 (default minimum) → allowed', () => {
		writeFixture({
			councilEnabled: true,
			councilModeEnabled: true,
			councilGate: { verdict: 'APPROVE', quorumSize: 3 },
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	test('gates.council.verdict=CONCERNS with quorumSize=5 → allowed', () => {
		writeFixture({
			councilEnabled: true,
			councilModeEnabled: true,
			councilGate: { verdict: 'CONCERNS', quorumSize: 5 },
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	test('gates.council.verdict=APPROVE without quorumSize (legacy evidence) → blocked (quorum gate)', () => {
		// Pre-fix bad evidence: APPROVE recorded without quorumSize. Treated as
		// quorumSize: 1 — fails the default minimumMembers=3 quorum gate.
		writeFixture({
			councilEnabled: true,
			councilModeEnabled: true,
			councilGate: { verdict: 'APPROVE' },
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/insufficient quorum/);
	});

	test('gates.council.verdict=APPROVE with quorumSize=1 → blocked (quorum gate)', () => {
		// Single-member APPROVE — does not satisfy default minimumMembers=3.
		writeFixture({
			councilEnabled: true,
			councilModeEnabled: true,
			councilGate: { verdict: 'APPROVE', quorumSize: 1 },
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/insufficient quorum/);
		expect(result.reason).toContain('1 of 3');
	});
});

describe('checkCouncilGate — council.enabled=true BUT council_mode=false (AND gate: not active)', () => {
	// Regression: council gate must NOT block when council_mode is false in the
	// QA gate profile, even when council.enabled is true in the plugin config.
	// Without the AND check, the old code would block here — that was the bug.
	test('council_mode=false, no evidence → NOT blocked', () => {
		// councilModeEnabled omitted (defaults false — profile not created)
		writeFixture({ councilEnabled: true, councilGate: null });
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	test('council_mode=false explicitly in profile, no evidence → NOT blocked', () => {
		// Create profile but leave council_mode at its default (false)
		setGatesForIdentity(tempDir, PLAN_IDENTITY, {});
		writeFixture({ councilEnabled: true, councilGate: null });
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	test('legacy unbound council_mode=true row blocks fail-closed with an exact-bind reason', () => {
		writeFixture({ councilEnabled: true, councilGate: null });
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { council_mode: true });

		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/not exact-bound/i);
	});

	test('binding-only adoption lets a locked legacy council profile resume enforcement', async () => {
		writeFixture({
			councilEnabled: true,
			councilGate: { verdict: 'APPROVE', quorumSize: 3 },
		});
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { council_mode: true });
		lockProfile(tempDir, PLAN_ID, 7);

		const blocked = checkCouncilGate(tempDir, TASK_ID);
		expect(blocked.blocked).toBe(true);
		expect(blocked.reason).toContain('adopt_legacy_binding_only');

		const adopted = await executeSetQaGates(
			{
				swarm_id: PLAN_SWARM,
				plan_title: PLAN_TITLE,
				adopt_legacy_binding_only: true,
			},
			tempDir,
		);
		expect(adopted.success).toBe(true);
		expect(adopted.profile?.locked_by_snapshot_seq).toBe(7);

		const resumed = checkCouncilGate(tempDir, TASK_ID);
		expect(resumed.blocked).toBe(false);
		expect(resumed.reason).toBe('');
	});

	test('council_mode=false, verdict=REJECT → NOT blocked (gate inactive)', () => {
		writeFixture({
			councilEnabled: true,
			councilGate: { verdict: 'REJECT' },
		});
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});
});

describe('checkCouncilGate — council.enabled=false (feature off, no regression)', () => {
	test('gates.council absent → allowed', () => {
		writeFixture({ councilEnabled: false, councilGate: null });
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	test('gates.council.verdict=REJECT → allowed (feature off, no regression)', () => {
		writeFixture({ councilEnabled: false, councilGate: { verdict: 'REJECT' } });
		const result = checkCouncilGate(tempDir, TASK_ID);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});
});
