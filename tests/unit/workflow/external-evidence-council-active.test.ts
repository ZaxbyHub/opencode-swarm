import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { setGatesForIdentity } from '../../../src/db/qa-gate-profile.js';
import {
	computeExternalDeclarationDigest,
	type ExternalEvidenceBundle,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Council-active external completion (plan §4 F3, #3422): a plan whose
 * council gate is FULLY ACTIVE (council.enabled=true AND a council_mode QA
 * gate profile — the AND-gate the unit suite pins) with NO council verdict
 * must NOT block a valid external completion. Declared external_git tasks
 * bypass the pre-lock council gate and reviewer precheck; the under-lock
 * external arm owns admission. Seeding mirrors
 * tests/unit/tools/update-task-status.council-gate.unit.test.ts so the
 * council gate is genuinely active (verified: this test FAILS at the
 * pre-F3-fix head b71f8b755 and PASSES at the fix head).
 */

let tempDir = '';

const TASK_ID = '5.1';
const PLAN_SWARM = 'council-active-probe';
const PLAN_TITLE = 'external-completion';
const PLAN_IDENTITY = { swarm: PLAN_SWARM, title: PLAN_TITLE };

beforeEach(() => {
	tempDir = canonicalMkdtemp('swarm3422-council-active-');
	mkdirSync(join(tempDir, '.git'), { recursive: true });

	// council.enabled=true in the project config (the AND-gate's first leg)
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);

	// plan.json with the DECLARED external task
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: PLAN_TITLE,
			swarm: PLAN_SWARM,
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'release-ops',
					status: 'in_progress',
					tasks: [
						{
							id: TASK_ID,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description:
								'Commit, tag, and push the release, then verify origin advanced',
							depends: [],
							files_touched: [],
							evidence_class: 'external_git',
							evidence_anchors: [
								{ command: 'git rev-parse --verify HEAD', expect_prefix: '1' },
							],
						},
					],
				},
			],
		}),
	);

	// council_mode=true QA gate profile in the project DB (the AND-gate's
	// second leg): checkCouncilGate now reports active and — with no council
	// verdict evidence — blocked, exactly the Round-1 reviewer probe shape.
	setGatesForIdentity(tempDir, PLAN_IDENTITY, { council_mode: true });
});

afterEach(() => {
	try {
		closeProjectDb(tempDir);
	} catch {
		// a fixture that failed before opening the DB has nothing to close
	}
	rmSync(tempDir, { recursive: true, force: true });
});

test('a declared external task completes with an ACTIVE, unsatisfied council gate (F3 bypass)', async () => {
	const anchors = [
		{ command: 'git rev-parse --verify HEAD', expect_prefix: '1' },
	];
	const bundle: ExternalEvidenceBundle = {
		class: 'external_git',
		transitionId: 'attest:5.1:static:0001',
		declarationDigest: computeExternalDeclarationDigest({
			taskId: TASK_ID,
			evidence_class: 'external_git',
			evidence_anchors: anchors,
			plan_title: PLAN_TITLE,
			plan_swarm: PLAN_SWARM,
			generation: 0,
		}),
		anchors: [
			{
				command: 'git rev-parse --verify HEAD',
				expect_prefix: '1',
				matched: true,
				exit_code: 0,
				stdout: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d\n',
			},
		],
		attestedAt: '2026-01-15T00:00:00.000Z',
	};
	await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
		type: 'external_evidence_attested',
		bundle,
		expectedGeneration: 0,
		transitionId: 'attest:5.1:static:0001',
	});

	const result = await executeUpdateTaskStatus(
		{
			task_id: TASK_ID,
			status: 'completed',
			working_directory: tempDir,
			reason: 'council-active external completion probe',
		},
		tempDir,
	);
	expect(result.success).toBe(true);
	expect(result.errors ?? []).toEqual([]);
	const plan = JSON.parse(
		readFileSync(join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
	) as { phases: Array<{ tasks: Array<{ id: string; status: string }> }> };
	const task = plan.phases[0]!.tasks.find((t) => t.id === TASK_ID);
	expect(task?.status).toBe('completed');
});
