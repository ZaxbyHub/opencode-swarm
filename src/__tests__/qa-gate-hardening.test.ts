/**
 * QA gate hardening tests.
 *
 * Covers the additions from the QA gate hardening rollout:
 * 1. phase_council and final_council as QA gates (default OFF, ratchet-tighter, persistence)
 * 2. Behavioral guidance markup is rendered into the architect prompt for SPECIFY,
 *    BRAINSTORM, and PLAN inline gate-selection paths.
 * 3. save_plan requires an exact, tool-owned QaGateProfile and never treats
 *    context.md as proof that selection occurred.
 * 4. SWARM_SKIP_GATE_SELECTION=1 bypasses the new check.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeRmRecursive } from '../../tests/helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import {
	buildQaGateSelectionDialogue,
	createArchitectAgent,
} from '../agents/architect';
import { closeAllProjectDbs, getProjectDb } from '../db/project-db.js';
import {
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	getProfile,
	setGates,
} from '../db/qa-gate-profile.js';
import { executeSavePlan } from '../tools/save-plan.js';
import { executeSetQaGates } from '../tools/set-qa-gates.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('qa-gate-hardening-');
	fs.mkdirSync(path.join(tempDir, '.opencode'));
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(tempDir, '.swarm', 'spec.md'), '# Spec\n');
});

afterEach(() => {
	closeAllProjectDbs();
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	safeRmRecursive(tempDir);
});

describe('phase_council gate', () => {
	test('DEFAULT_QA_GATES includes phase_council = false', () => {
		expect(DEFAULT_QA_GATES.phase_council).toBe(false);
	});

	test('DEFAULT_QA_GATES has exactly eleven fields', () => {
		expect(Object.keys(DEFAULT_QA_GATES).length).toBe(11);
	});

	test('setGates persists phase_council = true', () => {
		const planId = 'test-plan';
		getOrCreateProfile(tempDir, planId);
		const updated = setGates(tempDir, planId, {
			phase_council: true,
		});
		expect(updated.gates.phase_council).toBe(true);

		const reloaded = getProfile(tempDir, planId);
		expect(reloaded?.gates.phase_council).toBe(true);
	});

	test('setGates ratchet-tighter rejects phase_council true→false', () => {
		const planId = 'test-plan';
		getOrCreateProfile(tempDir, planId);
		setGates(tempDir, planId, { phase_council: true });
		expect(() => setGates(tempDir, planId, { phase_council: false })).toThrow(
			/ratchet tighter/,
		);
	});

	test('getEffectiveGates carries phase_council through merge', () => {
		const planId = 'test-plan';
		getOrCreateProfile(tempDir, planId);
		setGates(tempDir, planId, { phase_council: true });
		const profile = getProfile(tempDir, planId);
		expect(profile).not.toBeNull();
		const effective = getEffectiveGates(profile!, {});
		expect(effective.phase_council).toBe(true);
	});

	test('getEffectiveGates session override can ratchet tighter', () => {
		const planId = 'test-plan';
		const profile = getOrCreateProfile(tempDir, planId);
		const effective = getEffectiveGates(profile, {
			phase_council: true,
		});
		expect(effective.phase_council).toBe(true);
	});
});

describe('buildQaGateSelectionDialogue text', () => {
	test('SPECIFY mode defers the unified dialogue to PLAN', () => {
		const text = buildQaGateSelectionDialogue('SPECIFY');
		expect(text).toContain('defers');
		expect(text).toContain('MODE: PLAN');
		expect(text).not.toContain('eleven gates');
	});

	test('BRAINSTORM mode defers the unified dialogue to PLAN', () => {
		const text = buildQaGateSelectionDialogue('BRAINSTORM');
		expect(text).toContain('defers');
		expect(text).toContain('exact plan identity');
		expect(text).not.toContain('eleven gates');
	});

	test('PLAN mode includes eleven gates and phase_council', () => {
		const text = buildQaGateSelectionDialogue('PLAN');
		expect(text).toContain('eleven gates');
		expect(text).toContain('phase_council');
	});

	test('dialogue includes follow-up commit-frequency question and policy section', () => {
		const text = buildQaGateSelectionDialogue('PLAN');
		expect(text).toContain('Commit frequency for completed tasks?');
		expect(text).toContain('commit_after_each_completed_task');
	});

	test('dialogue presents parallel coders proactively with worktree concept', () => {
		const text = buildQaGateSelectionDialogue('PLAN');
		expect(text.toLowerCase()).toContain(
			'how many coders should run in parallel',
		);
		expect(text).toContain('isolated git worktree');
		expect(text).toMatch(/recommend/i);
	});

	test('dialogue presents auto_proceed as the fourth item and persists it', () => {
		const text = buildQaGateSelectionDialogue('PLAN');
		expect(text).toContain('all four');
		expect(text).toContain('Auto-proceed');
		expect(text).toContain('auto_proceed');
		expect(text).toContain('complete locked `execution_profile`');
	});
});

describe('Architect prompt behavioral guidance markers', () => {
	const renderedPrompt = (() => {
		const agent = createArchitectAgent('test-model');
		return (agent.config as unknown as { prompt: string }).prompt;
	})();

	test('SPECIFY block references QA gate dialogue from loaded skill', () => {
		expect(renderedPrompt).toContain('QA gate dialogue');
	});

	test('PLAN hard constraint requires exact pre-save QA bootstrap', () => {
		expect(renderedPrompt).toContain(
			'Call `set_qa_gates` with that exact `swarm_id` and `plan_title` before the first `save_plan`',
		);
	});

	test('PLAN dialogue includes phase_council', () => {
		expect(buildQaGateSelectionDialogue('PLAN')).toContain('phase_council');
	});

	test('PLAN dialogue includes final_council', () => {
		expect(buildQaGateSelectionDialogue('PLAN')).toContain('final_council');
	});

	test('buildQaGateSelectionDialogue includes task-completion commit policy', () => {
		const dialogue = buildQaGateSelectionDialogue('PLAN');
		expect(dialogue).toContain('commit_after_each_completed_task');
	});

	test('architect prompt disambiguates worktree isolation from Lean Turbo (#1552)', () => {
		// Regression guard: architects were repeatedly pattern-completing
		// "isolated git worktree" with Lean Turbo. The prompt must now contain
		// an explicit anti-misconception block right next to the positive fact.
		expect(renderedPrompt).toContain('WORKTREE ISOLATION IS BASELINE');
		// Must name BOTH config keys so the architect cannot collapse them.
		expect(renderedPrompt).toContain('worktree.policy');
		expect(renderedPrompt).toContain('turbo.lean.worktree_isolation');
		// Must include the explicit negation (the actual defense).
		expect(renderedPrompt).toMatch(
			/NOT the recommended one|secondary\/legacy path/i,
		);
		// Must keep the existing positive statement intact (sibling of line 135).
		expect(renderedPrompt).toContain('isolated git worktree');
		// Negative assertions — guard against the factual errors the PR_REVIEW
		// round 1 caught (F-001 config path error, F-003 over-absolute advice).
		expect(renderedPrompt).toMatch(/sibling of `parallelization:/i);
		expect(renderedPrompt).toMatch(
			/NOT the recommended one|secondary\/legacy path/i,
		);
		expect(renderedPrompt).not.toMatch(/under the parallel execution profile/);
		expect(renderedPrompt).not.toMatch(/never Lean Turbo/);
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

	test('blocks with actionable QA_GATE_SELECTION_REQUIRED when no profile exists', async () => {
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_SELECTION_REQUIRED');
		expect(result.errors).toContain(
			'No QA gate profile found for the exact plan identity',
		);
		expect(result.recovery_guidance).toContain('set_qa_gates');
		expect(result.recovery_guidance).toContain(minimalPlan.swarm_id);
		expect(result.recovery_guidance).toContain(minimalPlan.title);
	});

	test('legacy context marker cannot bypass tool-owned selection', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_SELECTION_REQUIRED');
	});

	test('pre-plan set_qa_gates then save_plan succeeds for the exact identity', async () => {
		const selection = await executeSetQaGates(
			{
				swarm_id: minimalPlan.swarm_id,
				plan_title: minimalPlan.title,
				reviewer: false,
				critic_pre_plan: false,
			} as Parameters<typeof executeSetQaGates>[0],
			tempDir,
		);
		expect(selection.success).toBe(true);

		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		expect(result.success).toBe(true);
	});

	test('a title change after pre-plan selection remains isolated and fails closed', async () => {
		const selection = await executeSetQaGates(
			{
				swarm_id: minimalPlan.swarm_id,
				plan_title: minimalPlan.title,
			} as Parameters<typeof executeSetQaGates>[0],
			tempDir,
		);
		expect(selection.success).toBe(true);

		const result = await executeSavePlan(
			{
				...minimalPlan,
				title: `${minimalPlan.title} revised`,
				working_directory: tempDir,
			},
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_SELECTION_REQUIRED');
		expect(result.recovery_guidance).toContain('revised');
	});

	test('a sanitization collision still requires the exact raw identity chosen pre-plan', async () => {
		const selection = await executeSetQaGates(
			{
				swarm_id: 'mega one',
				plan_title: 'Plan / 1',
			} as Parameters<typeof executeSetQaGates>[0],
			tempDir,
		);
		expect(selection.success).toBe(true);

		const result = await executeSavePlan(
			{
				...minimalPlan,
				swarm_id: 'mega?one',
				title: 'Plan ? 1',
				working_directory: tempDir,
			},
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_SELECTION_REQUIRED');
	});

	test('rejects an unbound legacy profile on the read-only save_plan path', async () => {
		const candidatePlanId =
			`${minimalPlan.swarm_id}-${minimalPlan.title}`.replace(
				/[^a-zA-Z0-9-_]/g,
				'_',
			);
		getProjectDb(tempDir);
		getOrCreateProfile(tempDir, candidatePlanId);

		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_IDENTITY_UNBOUND');
	});

	test('proceeds when an exact-bound profile is found (replanning path)', async () => {
		getProjectDb(tempDir);
		getOrCreateProfileForIdentity(tempDir, {
			swarm: minimalPlan.swarm_id,
			title: minimalPlan.title,
		});

		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tempDir },
			tempDir,
		);
		if (result.success === false) {
			expect(result.message ?? '').not.toContain('QA_GATE_SELECTION_REQUIRED');
			expect(result.message ?? '').not.toContain('QA_GATE_IDENTITY_UNBOUND');
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
});

describe('qa-gates command ALL_GATE_NAMES includes phase_council', () => {
	test('phase_council treated as a known gate by /swarm qa-gates', async () => {
		const { handleQaGatesCommand } = await import('../commands/qa-gates.js');
		const src = fs.readFileSync(
			path.join(process.cwd(), 'src/commands/qa-gates.ts'),
			'utf8',
		);
		expect(src).toContain("'phase_council',");
		expect(src).toContain("'final_council',");
		expect(typeof handleQaGatesCommand).toBe('function');
	});
});
