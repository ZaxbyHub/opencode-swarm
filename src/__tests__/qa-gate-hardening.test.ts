/**
 * QA gate hardening tests.
 *
 * Covers the additions from the QA gate hardening rollout:
 * 1. phase_council and final_council as QA gates (default OFF, ratchet-tighter, persistence)
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
	test('SPECIFY mode includes eleven gates and phase_council', () => {
		const text = buildQaGateSelectionDialogue('SPECIFY');
		expect(text).toContain('eleven gates');
		expect(text).toContain('phase_council');
		expect(text).not.toContain('Present the nine gates');
	});

	test('BRAINSTORM mode includes eleven gates and phase_council', () => {
		const text = buildQaGateSelectionDialogue('BRAINSTORM');
		expect(text).toContain('eleven gates');
		expect(text).toContain('phase_council');
	});

	test('PLAN mode includes eleven gates and phase_council', () => {
		const text = buildQaGateSelectionDialogue('PLAN');
		expect(text).toContain('eleven gates');
		expect(text).toContain('phase_council');
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

	test('SPECIFY block references QA gate dialogue from loaded skill', () => {
		expect(renderedPrompt).toContain('QA gate dialogue');
	});

	test('PLAN inline path has INLINE GATE SELECTION marker', () => {
		expect(renderedPrompt).toContain('INLINE GATE SELECTION');
	});

	test('buildQaGateSelectionDialogue includes phase_council', () => {
		const specifyDialogue = buildQaGateSelectionDialogue('SPECIFY');
		expect(specifyDialogue).toContain('phase_council');
		const brainstormDialogue = buildQaGateSelectionDialogue('BRAINSTORM');
		expect(brainstormDialogue).toContain('phase_council');
	});

	test('buildQaGateSelectionDialogue includes final_council', () => {
		const specifyDialogue = buildQaGateSelectionDialogue('SPECIFY');
		expect(specifyDialogue).toContain('final_council');
		const brainstormDialogue = buildQaGateSelectionDialogue('BRAINSTORM');
		expect(brainstormDialogue).toContain('final_council');
	});

	test('buildQaGateSelectionDialogue includes task-completion commit policy', () => {
		const dialogue = buildQaGateSelectionDialogue('SPECIFY');
		expect(dialogue).toContain('## Task Completion Commit Policy');
		expect(dialogue).toContain('commit_after_each_completed_task: true');
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
			'## Pending QA Gate Selection\n- reviewer: false\n- phase_council: false\n',
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
