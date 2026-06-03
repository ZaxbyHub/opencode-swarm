import {
	AUTONOMOUS_OVERSIGHT_PROMPT,
	type CriticRole,
	createCriticAgent,
	createCriticAutonomousOversightAgent,
	createCriticDriftVerifierAgent,
	HALLUCINATION_VERIFIER_PROMPT,
	PHASE_DRIFT_VERIFIER_PROMPT,
	PLAN_CRITIC_PROMPT,
	SOUNDING_BOARD_PROMPT,
} from '../../../src/agents/critic';

// NOTE: createCriticDriftAgent is expected to NOT exist (dead code removed)

const TEST_MODEL = 'test-model';

describe('critic.ts prompt overhaul', () => {
	// ============================================================
	// TEST 1: Verify createCriticAgent returns correct prompt based on role
	// ============================================================
	describe('createCriticAgent prompt selection by role', () => {
		test('role=plan_critic (explicit) -> prompt is PLAN_CRITIC_PROMPT', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'plan_critic',
			);
			expect(agent.config.prompt).toBe(PLAN_CRITIC_PROMPT);
		});

		test('role=sounding_board -> prompt is SOUNDING_BOARD_PROMPT', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'sounding_board',
			);
			expect(agent.config.prompt).toBe(SOUNDING_BOARD_PROMPT);
		});

		test('role=phase_drift_verifier -> prompt is PHASE_DRIFT_VERIFIER_PROMPT', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'phase_drift_verifier',
			);
			expect(agent.config.prompt).toBe(PHASE_DRIFT_VERIFIER_PROMPT);
		});

		test('no role (default) -> prompt is PLAN_CRITIC_PROMPT', () => {
			const agent = createCriticAgent(TEST_MODEL);
			expect(agent.config.prompt).toBe(PLAN_CRITIC_PROMPT);
		});
	});

	// ============================================================
	// TEST 2: Verify agent name is set correctly based on role
	// ============================================================
	describe('createCriticAgent name selection by role', () => {
		test('plan_critic -> name "critic"', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'plan_critic',
			);
			expect(agent.name).toBe('critic');
		});

		test('sounding_board -> name "critic_sounding_board"', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'sounding_board',
			);
			expect(agent.name).toBe('critic_sounding_board');
		});

		test('phase_drift_verifier -> name "critic_drift_verifier"', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'phase_drift_verifier',
			);
			expect(agent.name).toBe('critic_drift_verifier');
		});
	});

	// ============================================================
	// TEST 3: Verify backward compatibility
	// ============================================================
	describe('createCriticAgent backward compatibility', () => {
		test('createCriticAgent(model, customPrompt) works', () => {
			const customPrompt = 'Custom prompt content';
			const agent = createCriticAgent(TEST_MODEL, customPrompt);

			// Should use custom prompt, not role-based prompt
			expect(agent.config.prompt).toBe(customPrompt);
			// Name should still be "critic" (default role)
			expect(agent.name).toBe('critic');
		});

		test('createCriticAgent(model) uses default role (plan_critic)', () => {
			const agent = createCriticAgent(TEST_MODEL);

			expect(agent.config.prompt).toBe(PLAN_CRITIC_PROMPT);
			expect(agent.name).toBe('critic');
		});
	});

	// ============================================================
	// TEST 4: Verify customAppendPrompt works with role selection
	// ============================================================
	describe('createCriticAgent customAppendPrompt with role selection', () => {
		test('customAppendPrompt appends to PLAN_CRITIC_PROMPT when role=plan_critic', () => {
			const appendPrompt = 'Appended content';
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				appendPrompt,
				'plan_critic',
			);

			expect(agent.config.prompt).toBe(
				`${PLAN_CRITIC_PROMPT}\n\n${appendPrompt}`,
			);
		});

		test('customAppendPrompt appends to SOUNDING_BOARD_PROMPT when role=sounding_board', () => {
			const appendPrompt = 'Appended content';
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				appendPrompt,
				'sounding_board',
			);

			expect(agent.config.prompt).toBe(
				`${SOUNDING_BOARD_PROMPT}\n\n${appendPrompt}`,
			);
		});

		test('customAppendPrompt appends to PHASE_DRIFT_VERIFIER_PROMPT when role=phase_drift_verifier', () => {
			const appendPrompt = 'Appended content';
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				appendPrompt,
				'phase_drift_verifier',
			);

			expect(agent.config.prompt).toBe(
				`${PHASE_DRIFT_VERIFIER_PROMPT}\n\n${appendPrompt}`,
			);
		});

		test('customAppendPrompt is ignored when customPrompt is provided', () => {
			const customPrompt = 'Custom prompt';
			const appendPrompt = 'Appended content';
			const agent = createCriticAgent(TEST_MODEL, customPrompt, appendPrompt);

			// customPrompt is a complete replacement — append is ignored
			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toContain(appendPrompt);
		});
	});

	// ============================================================
	// TEST 5: Verify each prompt contains expected sections
	// ============================================================
	describe('prompt content verification', () => {
		test('PLAN_CRITIC_PROMPT contains required sections', () => {
			const requiredSections = [
				'Feasibility',
				'Completeness',
				'Dependency ordering',
				'Scope containment',
				'Risk assessment',
				'MODE: ANALYZE',
			];

			for (const section of requiredSections) {
				expect(PLAN_CRITIC_PROMPT).toContain(section);
			}
		});

		test('SOUNDING_BOARD_PROMPT contains required sections', () => {
			const requiredSections = [
				'SOUNDING_BOARD',
				'UNNECESSARY',
				'REPHRASE',
				'APPROVED',
				'RESOLVE',
			];

			for (const section of requiredSections) {
				expect(SOUNDING_BOARD_PROMPT).toContain(section);
			}
		});

		test('PHASE_DRIFT_VERIFIER_PROMPT contains required sections', () => {
			const requiredSections = [
				'File Change',
				'Spec Alignment',
				'Integrity',
				'Drift Detection',
				'VERIFIED',
				'MISSING',
				'DRIFTED',
			];

			for (const section of requiredSections) {
				expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain(section);
			}
		});
	});

	// ============================================================
	// TEST 6: Verify createCriticDriftAgent no longer exists
	// ============================================================
	describe('dead code removal verification', () => {
		test('createCriticDriftAgent is not exported (should not exist)', async () => {
			const mod = await import('../../../src/agents/critic');
			expect(Object.keys(mod)).not.toContain('createCriticDriftAgent');
		});
	});

	// ============================================================
	// NEW: Verify createCriticDriftVerifierAgent (separate factory)
	// ============================================================
	describe('createCriticDriftVerifierAgent', () => {
		test('returns agent with name "critic" (not critic_drift_verifier)', () => {
			const agent = createCriticDriftVerifierAgent(TEST_MODEL);
			expect(agent.name).toBe('critic');
		});

		test('uses PHASE_DRIFT_VERIFIER_PROMPT by default', () => {
			const agent = createCriticDriftVerifierAgent(TEST_MODEL);
			expect(agent.config.prompt).toBe(PHASE_DRIFT_VERIFIER_PROMPT);
		});

		test('appends customAppendPrompt to PHASE_DRIFT_VERIFIER_PROMPT', () => {
			const appendPrompt = 'Custom drift context';
			const agent = createCriticDriftVerifierAgent(TEST_MODEL, appendPrompt);
			expect(agent.config.prompt).toBe(
				`${PHASE_DRIFT_VERIFIER_PROMPT}\n\n${appendPrompt}`,
			);
		});

		test('uses the provided model', () => {
			const agent = createCriticDriftVerifierAgent('my-custom-model');
			expect(agent.config.model).toBe('my-custom-model');
		});

		test('has temperature 0.1', () => {
			const agent = createCriticDriftVerifierAgent(TEST_MODEL);
			expect(agent.config.temperature).toBe(0.1);
		});

		test('has tools with write:false, edit:false, patch:false', () => {
			const agent = createCriticDriftVerifierAgent(TEST_MODEL);
			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('has drift verifier description', () => {
			const agent = createCriticDriftVerifierAgent(TEST_MODEL);
			expect(agent.description).toContain('Phase drift verifier');
			expect(agent.description).toContain('Independently verifies');
		});

		test('no customAppendPrompt uses base prompt only', () => {
			const agent = createCriticDriftVerifierAgent(TEST_MODEL);
			// Should use the base PHASE_DRIFT_VERIFIER_PROMPT
			expect(agent.config.prompt).toContain('PHASE VERIFICATION');
			// Should NOT contain any appended custom content
			expect(agent.config.prompt).not.toContain('CUSTOM APPENDED');
		});
	});

	// ============================================================
	// TEST 7: Verify tools config has write:false, edit:false, patch:false
	// ============================================================
	describe('tools configuration verification', () => {
		test('plan_critic role has tools with write:false, edit:false, patch:false', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'plan_critic',
			);

			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('sounding_board role has tools with write:false, edit:false, patch:false', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'sounding_board',
			);

			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('phase_drift_verifier role has tools with write:false, edit:false, patch:false', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'phase_drift_verifier',
			);

			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});
	});

	// ============================================================
	// TEST 8: Verify CriticRole type exports
	// ============================================================
	describe('CriticRole type export verification', () => {
		test('CriticRole is exported and contains all three roles', () => {
			const roles: CriticRole[] = [
				'plan_critic',
				'sounding_board',
				'phase_drift_verifier',
			];

			expect(roles).toHaveLength(3);
			expect(roles).toContain('plan_critic');
			expect(roles).toContain('sounding_board');
			expect(roles).toContain('phase_drift_verifier');
		});
	});

	// ============================================================
	// TEST 9: Verify all three prompt constants are exported
	// ============================================================
	describe('prompt constant exports verification', () => {
		test('PLAN_CRITIC_PROMPT, SOUNDING_BOARD_PROMPT, PHASE_DRIFT_VERIFIER_PROMPT are all exported', () => {
			expect(typeof PLAN_CRITIC_PROMPT).toBe('string');
			expect(typeof SOUNDING_BOARD_PROMPT).toBe('string');
			expect(typeof PHASE_DRIFT_VERIFIER_PROMPT).toBe('string');

			expect(PLAN_CRITIC_PROMPT.length).toBeGreaterThan(0);
			expect(SOUNDING_BOARD_PROMPT.length).toBeGreaterThan(0);
			expect(PHASE_DRIFT_VERIFIER_PROMPT.length).toBeGreaterThan(0);
		});

		test('each prompt is distinct (no aliasing)', () => {
			expect(PLAN_CRITIC_PROMPT).not.toBe(SOUNDING_BOARD_PROMPT);
			expect(PLAN_CRITIC_PROMPT).not.toBe(PHASE_DRIFT_VERIFIER_PROMPT);
			expect(SOUNDING_BOARD_PROMPT).not.toBe(PHASE_DRIFT_VERIFIER_PROMPT);
		});
	});

	// ============================================================
	// TEST 10: Verify agent description is set correctly per role
	// ============================================================
	describe('agent description verification', () => {
		test('plan_critic has appropriate description', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'plan_critic',
			);

			expect(agent.description).toContain('Plan critic');
			expect(agent.description).toContain('feasibility');
		});

		test('sounding_board has appropriate description', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'sounding_board',
			);

			expect(agent.description).toContain('Sounding board');
			expect(agent.description).toContain('pushback');
		});

		test('phase_drift_verifier has appropriate description', () => {
			const agent = createCriticAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'phase_drift_verifier',
			);

			expect(agent.description).toContain('Phase drift verifier');
			expect(agent.description).toContain('Independently verifies');
		});
	});

	// ============================================================
	// TEST 11: Verify createCriticAutonomousOversightAgent
	// ============================================================
	describe('createCriticAutonomousOversightAgent', () => {
		test('returns agent with name "critic_oversight"', () => {
			const agent = createCriticAutonomousOversightAgent(TEST_MODEL);
			expect(agent.name).toBe('critic_oversight');
		});

		test('uses AUTONOMOUS_OVERSIGHT_PROMPT by default', () => {
			const agent = createCriticAutonomousOversightAgent(TEST_MODEL);
			expect(agent.config.prompt).toBe(AUTONOMOUS_OVERSIGHT_PROMPT);
		});

		test('has read-only tools (write:false, edit:false, patch:false)', () => {
			const agent = createCriticAutonomousOversightAgent(TEST_MODEL);
			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('appends customAppendPrompt to base prompt', () => {
			const customAppend = 'Additional oversight instructions';
			const agent = createCriticAutonomousOversightAgent(
				TEST_MODEL,
				customAppend,
			);
			expect(agent.config.prompt).toBe(
				`${AUTONOMOUS_OVERSIGHT_PROMPT}\n\n${customAppend}`,
			);
		});
	});

	// ============================================================
	// TEST 12: Verify PLAN_CRITIC_PROMPT contains BASELINE COMPARISON
	// ============================================================
	describe('PLAN_CRITIC_PROMPT baseline comparison requirements', () => {
		test('contains get_approved_plan call instruction', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('get_approved_plan');
		});

		test('contains BASELINE COMPARISON section', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('BASELINE COMPARISON');
		});

		test('contains approved baseline or approved plan reference', () => {
			const hasApprovedReference =
				PLAN_CRITIC_PROMPT.includes('approved baseline') ||
				PLAN_CRITIC_PROMPT.includes('approved_plan');
			expect(hasApprovedReference).toBe(true);
		});

		test('contains drift_detected or drift handling', () => {
			const hasDriftHandling =
				PLAN_CRITIC_PROMPT.includes('drift_detected') ||
				PLAN_CRITIC_PROMPT.includes('drift');
			expect(hasDriftHandling).toBe(true);
		});

		test('contains spec-intent divergence or spec intent', () => {
			const hasSpecIntent =
				PLAN_CRITIC_PROMPT.includes('spec-intent divergence') ||
				PLAN_CRITIC_PROMPT.includes('spec intent');
			expect(hasSpecIntent).toBe(true);
		});

		test('contains no_approved_snapshot handling', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('no_approved_snapshot');
		});

		test('contains CRITICAL finding for unauthorized mutation', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('CRITICAL finding');
		});

		test('HALLUCINATION_VERIFIER_PROMPT does NOT contain get_approved_plan', () => {
			// BASELINE COMPARISON is only for plan review, not hallucination verification
			expect(HALLUCINATION_VERIFIER_PROMPT).not.toContain('get_approved_plan');
		});

		test('AUTONOMOUS_OVERSIGHT_PROMPT does NOT contain get_approved_plan', () => {
			// Autonomous oversight operates OUTSIDE the council/live plan-review baseline
			// enforcement path. It performs its own review based on constitution rules
			// and evidence verification, not by comparing against an approved baseline.
			// This is intentional — full-auto intercept is a separate oversight path.
			expect(AUTONOMOUS_OVERSIGHT_PROMPT).not.toContain('get_approved_plan');
		});

		test('PHASE_DRIFT_VERIFIER_PROMPT still contains BASELINE COMPARISON', () => {
			// Ensure we didn't remove it from phase drift verifier
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('BASELINE COMPARISON');
		});

		// --------------------------------------------------------
		// Behavioral assertions for all 4 BASELINE COMPARISON branches
		// --------------------------------------------------------
		test('branch 1: no_approved_snapshot → first-plan / no prior approval + proceed', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('no_approved_snapshot');
			const hasFirstPlanOrNoPrior =
				PLAN_CRITIC_PROMPT.includes('first plan') ||
				PLAN_CRITIC_PROMPT.includes('no prior approval');
			expect(hasFirstPlanOrNoPrior).toBe(true);
			const hasProceed =
				PLAN_CRITIC_PROMPT.includes('proceed with plan review') ||
				PLAN_CRITIC_PROMPT.includes('Proceed with plan review');
			expect(hasProceed).toBe(true);
		});

		test('branch 2: drift_detected false → baseline integrity confirmed + proceed', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('baseline integrity confirmed');
			const hasProceed =
				PLAN_CRITIC_PROMPT.includes('Proceed with plan review') ||
				PLAN_CRITIC_PROMPT.includes('proceed with plan review');
			expect(hasProceed).toBe(true);
		});

		test('branch 3: drift_detected true (approved_plan defined) → CRITICAL finding + compare + ## BASELINE DRIFT', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('CRITICAL finding');
			const hasCompare =
				PLAN_CRITIC_PROMPT.includes('Compare `approved_plan` vs `current_plan`') ||
				PLAN_CRITIC_PROMPT.includes('compare `approved_plan` vs `current_plan`');
			expect(hasCompare).toBe(true);
			expect(PLAN_CRITIC_PROMPT).toContain('## BASELINE DRIFT');
		});

		test('branch 3b: drift_detected true + approved_plan undefined → tampering + current_plan_error as evidence', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('approved_plan` is undefined');
			expect(PLAN_CRITIC_PROMPT).toContain('current_plan_error');
			expect(PLAN_CRITIC_PROMPT).toContain('tampering detected');
			expect(PLAN_CRITIC_PROMPT).toContain('identity mutation');
		});

		test('branch 4: drift_detected unknown → warning + proceed with caution', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('drift_detected: "unknown"');
			const hasWarning =
				PLAN_CRITIC_PROMPT.includes('warning') ||
				PLAN_CRITIC_PROMPT.includes('Warning');
			expect(hasWarning).toBe(true);
			expect(PLAN_CRITIC_PROMPT).toContain('proceed with caution');
		});

		// Same 4-branch behavioral assertions for PHASE_DRIFT_VERIFIER_PROMPT
		test('PHASE_DRIFT_VERIFIER: branch 1 → no_approved_snapshot + first phase/no prior approval + proceed', () => {
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('no_approved_snapshot');
			const hasFirstOrNoPrior =
				PHASE_DRIFT_VERIFIER_PROMPT.includes('first phase') ||
				PHASE_DRIFT_VERIFIER_PROMPT.includes('no prior approval');
			expect(hasFirstOrNoPrior).toBe(true);
		});

		test('PHASE_DRIFT_VERIFIER: branch 2 → drift_detected false + baseline integrity confirmed', () => {
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('baseline integrity confirmed');
		});

		test('PHASE_DRIFT_VERIFIER: branch 3 → drift_detected true (approved_plan defined) + compare + ## BASELINE DRIFT', () => {
			const hasCompare =
				PHASE_DRIFT_VERIFIER_PROMPT.includes('Compare `approved_plan` vs `current_plan`') ||
				PHASE_DRIFT_VERIFIER_PROMPT.includes('compare `approved_plan` vs `current_plan`');
			expect(hasCompare).toBe(true);
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('## BASELINE DRIFT');
		});

		test('PHASE_DRIFT_VERIFIER: branch 3b → approved_plan undefined + tampering + current_plan_error', () => {
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('approved_plan` is undefined');
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('current_plan_error');
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('tampering detected');
		});

		test('PHASE_DRIFT_VERIFIER: branch 4 → drift_detected unknown + warning + proceed', () => {
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('drift_detected: "unknown"');
			expect(PHASE_DRIFT_VERIFIER_PROMPT).toContain('warning');
		});
	});

	// ============================================================
	// TEST 13: Invalid input and edge case handling
	// ============================================================
	describe('invalid input and edge case handling', () => {
		test('PLAN_CRITIC_PROMPT contains no_approved_snapshot handling for first-plan scenario', () => {
			expect(PLAN_CRITIC_PROMPT).toContain('no_approved_snapshot');
		});

		test('PLAN_CRITIC_PROMPT instructs handling of missing plan fields', () => {
			const hasMissingFieldHandling =
				PLAN_CRITIC_PROMPT.includes('missing') ||
				PLAN_CRITIC_PROMPT.includes('incomplete') ||
				PLAN_CRITIC_PROMPT.includes('empty');
			expect(hasMissingFieldHandling).toBe(true);
		});

		test('createCriticAgent with empty model string still returns valid config', () => {
			const agent = createCriticAgent('');
			expect(agent.config.model).toBe('');
			expect(agent.config.prompt).toBe(PLAN_CRITIC_PROMPT);
			expect(agent.name).toBe('critic');
		});

		test('createCriticAgent with all undefined optional params uses defaults', () => {
			const agent = createCriticAgent('test', undefined, undefined, undefined);
			expect(agent.config.prompt).toBe(PLAN_CRITIC_PROMPT);
			expect(agent.name).toBe('critic');
		});
	});
});
