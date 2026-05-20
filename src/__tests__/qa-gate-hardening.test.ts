/**
 * QA gate hardening tests.
 *
 * Covers the additions from the QA gate hardening rollout:
 * 1. council_general_review as the 9th and final_council as the 11th QA gate (default OFF, ratchet-tighter, persistence)
 * 2. Behavioral guidance markup is rendered into the architect prompt for SPECIFY,
 *    BRAINSTORM, and PLAN inline gate-selection paths.
 * 3. save_plan blocks with QA_GATE_SELECTION_REQUIRED when context.md has no
 *    `## Pending QA Gate Selection` section AND no existing QaGateProfile.
 * 4. SWARM_SKIP_GATE_SELECTION=1 bypasses the new check.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildQaGateSelectionDialogue,
	createArchitectAgent,
} from '../agents/architect';
import { closeAllProjectDbs, getProjectDb } from '../db/project-db.js';
import {
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getOrCreateProfile,
	getProfile,
	setGates,
} from '../db/qa-gate-profile.js';
import { executeSavePlan } from '../tools/save-plan.js';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), 'qa-gate-hardening-')),
	);
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(tempDir, '.swarm', 'spec.md'), '# Spec\n');
});

afterEach(() => {
	closeAllProjectDbs();
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('council_general_review gate', () => {
	test('DEFAULT_QA_GATES includes council_general_review = false', () => {
		expect(DEFAULT_QA_GATES.council_general_review).toBe(false);
	});

	test('DEFAULT_QA_GATES has exactly eleven fields', () => {
		expect(Object.keys(DEFAULT_QA_GATES).length).toBe(11);
	});

	test('setGates persists council_general_review = true', () => {
		const planId = 'test-plan';
		getOrCreateProfile(tempDir, planId);
		const updated = setGates(tempDir, planId, {
			council_general_review: true,
		});
		expect(updated.gates.council_general_review).toBe(true);

		const reloaded = getProfile(tempDir, planId);
		expect(reloaded?.gates.council_general_review).toBe(true);
	});

	test('setGates ratchet-tighter rejects council_general_review true→false', () => {
		const planId = 'test-plan';
		getOrCreateProfile(tempDir, planId);
		setGates(tempDir, planId, { council_general_review: true });
		expect(() =>
			setGates(tempDir, planId, { council_general_review: false }),
		).toThrow(/ratchet tighter/);
	});

	test('getEffectiveGates carries council_general_review through merge', () => {
		const planId = 'test-plan';
		getOrCreateProfile(tempDir, planId);
		setGates(tempDir, planId, { council_general_review: true });
		const profile = getProfile(tempDir, planId);
		expect(profile).not.toBeNull();
		const effective = getEffectiveGates(profile!, {});
		expect(effective.council_general_review).toBe(true);
	});

	test('getEffectiveGates session override can ratchet tighter', () => {
		const planId = 'test-plan';
		const profile = getOrCreateProfile(tempDir, planId);
		const effective = getEffectiveGates(profile, {
			council_general_review: true,
		});
		expect(effective.council_general_review).toBe(true);
	});
});

describe('buildQaGateSelectionDialogue text', () => {
	test('SPECIFY mode includes eleven gates and council_general_review', () => {
		const text = buildQaGateSelectionDialogue('SPECIFY');
		expect(text).toContain('eleven gates');
		expect(text).toContain('council_general_review');
		expect(text).not.toContain('Present the nine gates');
	});

	test('BRAINSTORM mode includes eleven gates and council_general_review', () => {
		const text = buildQaGateSelectionDialogue('BRAINSTORM');
		expect(text).toContain('eleven gates');
		expect(text).toContain('council_general_review');
	});

	test('PLAN mode includes eleven gates and council_general_review', () => {
		const text = buildQaGateSelectionDialogue('PLAN');
		expect(text).toContain('eleven gates');
		expect(text).toContain('council_general_review');
	});

	test('dialogue includes follow-up commit-frequency question and policy section', () => {
		const text = buildQaGateSelectionDialogue('SPECIFY');
		expect(text).toContain('Commit frequency for completed tasks?');
		expect(text).toContain('## Task Completion Commit Policy');
		expect(text).toContain('commit_after_each_completed_task: true');
	});
});

describe('Architect prompt behavioral guidance markers', () => {
	const renderedPrompt = (() => {
		const agent = createArchitectAgent('test-model');
		return (agent.config as unknown as { prompt: string }).prompt;
	})();

	test('SPECIFY block has GATE SELECTION IS MANDATORY + MANDATORY PAUSE', () => {
		expect(renderedPrompt).toContain('GATE SELECTION IS MANDATORY');
		expect(renderedPrompt).toContain('MANDATORY PAUSE');
		expect(renderedPrompt).toContain(
			'BLOCKED until ALL THREE of these conditions',
		);
	});

	test('PLAN inline path has INLINE GATE SELECTION marker', () => {
		expect(renderedPrompt).toContain('INLINE GATE SELECTION');
	});

	test('Pending QA Gate Selection template includes council_general_review', () => {
		// Both BRAINSTORM (Phase 6) and SPECIFY (5b) have a `## Pending QA Gate Selection`
		// template block — both must list council_general_review with the placeholder.
		const bulletMatches = renderedPrompt.match(
			/- council_general_review: <true\|false>/g,
		);
		expect(bulletMatches).not.toBeNull();
		expect(bulletMatches!.length).toBeGreaterThanOrEqual(2);
	});

	test('Pending QA Gate Selection template includes final_council', () => {
		const bulletMatches = renderedPrompt.match(
			/- final_council: <true\|false>/g,
		);
		expect(bulletMatches).not.toBeNull();
		expect(bulletMatches!.length).toBeGreaterThanOrEqual(2);
	});

	test('prompt includes task-completion commit policy instructions', () => {
		expect(renderedPrompt).toContain('## Task Completion Commit Policy');
		expect(renderedPrompt).toContain('OPTIONAL TASK-COMPLETION COMMIT POLICY');
		expect(renderedPrompt).toContain('checkpoint save task-<task-id>-complete');
	});
});

describe('save_plan QA_GATE_SELECTION_CHECK', () => {
	const minimalPlan = {
		title: 'Hardening Test',
		swarm_id: 'hardening-test',
		phases: [
			{
				id: 1,
				name: 'Setup',
				tasks: [{ id: '1.1', description: 'Task' }],
			},
		],
	};

	test('blocks with QA_GATE_SELECTION_REQUIRED when context.md absent and no profile', async () => {
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_SELECTION_REQUIRED');
		expect(result.errors).toContain(
			'Missing ## Pending QA Gate Selection in .swarm/context.md',
		);
	});

	test('proceeds when context.md has the section', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		// We don't assert success: downstream save_plan may still pass/fail on other
		// criteria. We only assert that we got past the gate-selection check.
		if (result.success === false) {
			expect(result.message ?? '').not.toContain('QA_GATE_SELECTION_REQUIRED');
		}
	});

	test('proceeds when an existing profile is found (replanning path)', async () => {
		// Pre-create a profile matching the formula save-plan derives.
		const candidatePlanId =
			`${minimalPlan.swarm_id}-${minimalPlan.title}`.replace(
				/[^a-zA-Z0-9-_]/g,
				'_',
			);
		// Initialize the project DB so getProfile sees something.
		getProjectDb(tempDir);
		getOrCreateProfile(tempDir, candidatePlanId);

		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		if (result.success === false) {
			expect(result.message ?? '').not.toContain('QA_GATE_SELECTION_REQUIRED');
		}
	});

	test('SWARM_SKIP_GATE_SELECTION=1 bypasses the check entirely', async () => {
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		if (result.success === false) {
			expect(result.message ?? '').not.toContain('QA_GATE_SELECTION_REQUIRED');
		}
	});

	test('section with all gates explicitly false still passes (selection completed)', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n- reviewer: false\n- council_general_review: false\n',
		);
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		if (result.success === false) {
			expect(result.message ?? '').not.toContain('QA_GATE_SELECTION_REQUIRED');
		}
	});
});

describe('qa-gates command ALL_GATE_NAMES includes council_general_review', () => {
	test('council_general_review treated as a known gate by /swarm qa-gates', async () => {
		const { handleQaGatesCommand } = await import('../commands/qa-gates.js');
		// We can't call it without a plan.json; just confirm the import succeeds and
		// the gate list contains the new gate by reading the file source via fs.
		const src = fs.readFileSync(
			path.join(process.cwd(), 'src/commands/qa-gates.ts'),
			'utf8',
		);
		expect(src).toContain("'council_general_review',");
		expect(src).toContain("'final_council',");
		expect(typeof handleQaGatesCommand).toBe('function');
	});
});
