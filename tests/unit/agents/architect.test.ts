import { describe, expect, it } from 'bun:test';
import { createArchitectAgent as baseCreateArchitectAgent } from '../../../src/agents/architect';
import {
	EXECUTE_PROTOCOL,
	withExtractedModeProtocols,
} from './architect-mode-skill-helpers';

const createArchitectAgent = (
	...args: Parameters<typeof baseCreateArchitectAgent>
) => {
	const agent = baseCreateArchitectAgent(...args);
	return {
		...agent,
		config: {
			...agent.config,
			prompt: withExtractedModeProtocols(agent.config.prompt ?? ''),
		},
	};
};

/**
 * Task 6.3: Focused tests for adversarial testing checklist output
 *
 * Verifies:
 * - disabled: checklist shows SKIPPED — disabled by config
 * - security-only: checklist allows PASS / FAIL / SKIP — not security-sensitive
 * - all/default: checklist allows PASS / FAIL
 */

describe('Task 6.3: Adversarial testing checklist behavior', () => {
	describe('Checklist output for disabled adversarial testing', () => {
		it('enabled=false shows SKIPPED — disabled by config in checklist', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: false,
				scope: 'all',
			});
			const prompt = agent.config.prompt!;

			// Checklist should show SKIPPED — disabled by config
			expect(prompt).toContain(
				'test_engineer-adversarial: SKIPPED — disabled by config — value: ___',
			);
		});

		it('enabled=false removes step 5m entirely', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: false,
				scope: 'all',
			});
			const prompt = agent.config.prompt!;

			// Step 5m should be removed
			expect(prompt).not.toContain('{{ADVERSARIAL_TEST_STEP}}');
			expect(prompt).not.toContain('5m. {{AGENT_PREFIX}}test_engineer');
		});
	});

	describe('Checklist output for security-only scope', () => {
		it('scope=security-only shows PASS / FAIL / SKIP — not security-sensitive', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: true,
				scope: 'security-only',
			});
			const prompt = agent.config.prompt!;

			// Checklist should show all three options with security-sensitive qualifier
			expect(prompt).toContain(
				'test_engineer-adversarial: PASS / FAIL / SKIP — not security-sensitive — value: ___',
			);
		});

		it('scope=security-only includes conditional step 5m', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: true,
				scope: 'security-only',
			});
			const prompt = agent.config.prompt!;

			// Step should be present with conditional language
			expect(prompt).toContain(
				'5m. {{AGENT_PREFIX}}test_engineer - Adversarial tests (conditional: security-sensitive only)',
			);
			expect(prompt).toContain('If NOT security-sensitive → SKIP this step');
		});
	});

	describe('Checklist output for default (all) scope', () => {
		it('scope=all shows PASS / FAIL without security qualifiers', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: true,
				scope: 'all',
			});
			const prompt = agent.config.prompt!;

			// Checklist should show PASS / FAIL (no SKIP option for default)
			expect(prompt).toContain(
				'test_engineer-adversarial: PASS / FAIL — value: ___',
			);
			// Should NOT contain security-sensitive qualifier
			expect(prompt).not.toContain('SKIP — not security-sensitive');
		});

		it('scope=all includes unconditional step 5m', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: true,
				scope: 'all',
			});
			const prompt = agent.config.prompt!;

			// Step should be present as unconditional
			expect(prompt).toContain(
				'5m. {{AGENT_PREFIX}}test_engineer - Adversarial tests. FAIL',
			);
			expect(prompt).not.toContain('(conditional: security-sensitive only)');
		});
	});

	describe('Default behavior when no config provided', () => {
		it('defaults to enabled=true, scope=all', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Should behave like enabled=true, scope='all'
			expect(prompt).toContain(
				'test_engineer-adversarial: PASS / FAIL — value: ___',
			);
			expect(prompt).not.toContain('SKIPPED — disabled by config');
			expect(prompt).not.toContain('SKIP — not security-sensitive');
		});
	});

	describe('Stale expectation corrections', () => {
		// These test cases verify the CORRECT implementation matches task 6.2 spec
		// and correct previously stale expectations in other test files

		it('security-only checklist format matches spec: PASS / FAIL / SKIP — not security-sensitive', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: true,
				scope: 'security-only',
			});
			const prompt = agent.config.prompt!;

			// Correct format: includes FAIL, not just PASS/SKIP
			expect(prompt).toMatch(
				/test_engineer-adversarial: PASS \/ FAIL \/ SKIP — not security-sensitive/,
			);
		});

		it('default/all checklist format matches spec: PASS / FAIL', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: true,
				scope: 'all',
			});
			const prompt = agent.config.prompt!;

			// Correct format: only PASS / FAIL, no SKIP option
			expect(prompt).toMatch(
				/test_engineer-adversarial: PASS \/ FAIL — value: ___/,
			);
		});

		it('disabled checklist format matches spec: SKIPPED — disabled by config', () => {
			const agent = createArchitectAgent('test-model', undefined, undefined, {
				enabled: false,
				scope: 'all',
			});
			const prompt = agent.config.prompt!;

			// Correct format: includes "disabled by config"
			expect(prompt).toMatch(
				/test_engineer-adversarial: SKIPPED — disabled by config/,
			);
		});
	});
});

/**
 * Task 5.1: Regression sweep prompt content tests
 *
 * Verifies:
 * - regression-sweep appears AFTER test_engineer-verification in prompt
 * - regression-sweep appears in TASK COMPLETION GATE checklist
 * - regression-sweep appears in PRE-COMMIT RULE
 * - Step text includes scope:"graph" and files: parameters
 * - Step text preserves exact per-file skip/error reasons
 */
describe('Task 5.1: Regression sweep prompt content', () => {
	describe('regression-sweep step appears in prompt after test_engineer-verification', () => {
		it('prompt contains regression-sweep step (5l-bis) after test_engineer-verification (5l)', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find positions of both steps in the prompt
			const verificationPos = prompt.indexOf('test_engineer-verification');
			const regressionPos = prompt.indexOf('regression-sweep');

			expect(verificationPos).toBeGreaterThan(0);
			expect(regressionPos).toBeGreaterThan(0);
			expect(regressionPos).toBeGreaterThan(verificationPos);
		});

		it('regression-sweep step text includes scope:"graph"', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('scope: "graph"');
		});

		it('regression-sweep step text includes files: parameter', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Should mention files array in the context of regression sweep
			expect(prompt).toContain('files:');
		});

		it('regression-sweep step text preserves the actual tool reason for skips', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('SKIPPED — [actual tool reason]');
			expect(prompt).toContain(
				'SKIPPED — N per-file sweeps with exact reasons',
			);
		});
	});

	describe('regression-sweep appears in TASK COMPLETION GATE checklist', () => {
		it('TASK COMPLETION GATE checklist includes regression-sweep', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find the TASK COMPLETION GATE section
			const gateStart = EXECUTE_PROTOCOL.indexOf('TASK COMPLETION GATE');
			expect(gateStart).toBeGreaterThan(0);

			// Extract the gate section (next 500 chars should contain it)
			const gateSection = EXECUTE_PROTOCOL.slice(gateStart, gateStart + 800);
			expect(gateSection).toContain('regression-sweep');
		});

		it('TASK COMPLETION GATE shows regression-sweep: PASS / SKIPPED format', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			const gateStart = EXECUTE_PROTOCOL.indexOf('TASK COMPLETION GATE');
			const gateSection = EXECUTE_PROTOCOL.slice(gateStart, gateStart + 800);

			// Should show the format: [GATE] regression-sweep: PASS / SKIPPED — value: ___
			expect(gateSection).toMatch(/regression-sweep:\s*PASS\s*\/\s*SKIPPED/);
		});
	});

	describe('regression-sweep appears in PRE-COMMIT RULE', () => {
		it('PRE-COMMIT RULE checklist includes regression-sweep', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find the PRE-COMMIT RULE section
			const precommitStart = prompt.indexOf('PRE-COMMIT RULE');
			expect(precommitStart).toBeGreaterThan(0);

			// Extract the precommit section
			const precommitSection = prompt.slice(
				precommitStart,
				precommitStart + 800,
			);
			expect(precommitSection).toContain('regression-sweep');
		});

		it('PRE-COMMIT RULE requires evidence or exact per-file skip/error reasons', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			const precommitStart = prompt.indexOf('PRE-COMMIT RULE');
			const precommitSection = prompt.slice(
				precommitStart,
				precommitStart + 800,
			);

			// Should contain the full question about regression-sweep
			expect(precommitSection).toContain(
				'Did regression-sweep record per-file regression-sweep evidence',
			);
			expect(precommitSection).toContain('exact per-file skip/error reasons');
		});
	});

	describe('Step 5l-bis text content verification', () => {
		it('step 5l-bis is labeled as REGRESSION SWEEP', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('REGRESSION SWEEP');
		});

		it('step mentions running test_runner with scope:"graph" on changed files', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Should mention the graph scope for regression testing
			expect(prompt).toContain('scope: "graph"');
			// Should require one graph sweep for every changed source file.
			expect(prompt).toContain(
				'one `test_runner` call per changed source file',
			);
		});

		it('step includes pass, regression, and honest per-file skip outcomes', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find the regression sweep step section
			const sweepStart = prompt.indexOf('REGRESSION SWEEP');
			const sweepSection = prompt.slice(sweepStart, sweepStart + 1800);

			// Aggregate outcomes and the per-source skip evidence format are explicit.
			expect(sweepSection).toContain(
				'[source]: SKIPPED — [actual tool reason]',
			);
			expect(sweepSection).toContain('PASS');
			expect(sweepSection).toContain('REGRESSION DETECTED');
			expect(sweepSection).toContain(
				'SKIPPED — N per-file sweeps with exact reasons',
			);
		});
	});
});

/**
 * Task 5.l-ter: Test drift check prompt content tests
 *
 * Verifies:
 * - test-drift appears AFTER regression-sweep in prompt
 * - test-drift has correct trigger conditions
 * - test-drift prints "test-drift: NOT TRIGGERED" when no drift-prone change
 * - test-drift appears in TASK COMPLETION GATE checklist
 * - test-drift appears in PRE-COMMIT RULE checklist
 */
describe('Task 5.l-ter: Test drift check prompt content', () => {
	describe('test-drift step appears in prompt after regression-sweep', () => {
		it('prompt contains test-drift step (5l-ter) after regression-sweep (5l-bis)', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find positions of both steps in the prompt
			const regressionPos = prompt.indexOf('regression-sweep');
			const testDriftPos = prompt.indexOf('test-drift');

			expect(regressionPos).toBeGreaterThan(0);
			expect(testDriftPos).toBeGreaterThan(0);
			expect(testDriftPos).toBeGreaterThan(regressionPos);
		});

		it('test-drift step is labeled as TEST DRIFT CHECK', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('TEST DRIFT CHECK');
		});

		it('test-drift step includes all six trigger conditions', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// All six trigger conditions should be present
			expect(prompt).toContain('Command/CLI behavior changed');
			expect(prompt).toContain('Parsing or routing logic changed');
			expect(prompt).toContain('User-visible output changed');
			expect(prompt).toContain('Public contracts or schemas changed');
			expect(prompt).toContain(
				'Assertion-heavy areas where output strings are tested',
			);
			expect(prompt).toContain(
				'Helper behavior or lifecycle semantics changed',
			);
		});

		it('test-drift step includes scope:"convention" for running related tests', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// The actual text in the file uses scope:"convention" (no space after colon)
			expect(prompt).toContain('scope:"convention"');
		});
	});

	describe('test-drift prints NOT TRIGGERED when no drift-prone change', () => {
		it('prompt contains "test-drift: NOT TRIGGERED" for non-triggered case', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('test-drift: NOT TRIGGERED');
		});

		it('NOT TRIGGERED message includes reason "no drift-prone change detected"', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('no drift-prone change detected');
		});
	});

	describe('test-drift shows correct outcomes when triggered', () => {
		it('triggered outcome includes "DRIFT DETECTED" when tests fail', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('DRIFT DETECTED');
		});

		it('triggered outcome includes "related tests verified" when all pass', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('related tests verified');
		});

		it('triggered outcome includes "NO RELATED TESTS FOUND" (not a failure)', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('NO RELATED TESTS FOUND');
		});
	});

	describe('test-drift appears in TASK COMPLETION GATE checklist', () => {
		it('TASK COMPLETION GATE checklist includes test-drift', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find the TASK COMPLETION GATE section
			const gateStart = EXECUTE_PROTOCOL.indexOf('TASK COMPLETION GATE');
			expect(gateStart).toBeGreaterThan(0);

			// Extract the gate section
			const gateSection = EXECUTE_PROTOCOL.slice(gateStart, gateStart + 1000);
			expect(gateSection).toContain('test-drift');
		});

		it('TASK COMPLETION GATE shows test-drift: TRIGGERED / NOT TRIGGERED format', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			const gateStart = EXECUTE_PROTOCOL.indexOf('TASK COMPLETION GATE');
			const gateSection = EXECUTE_PROTOCOL.slice(gateStart, gateStart + 1000);

			// Should show the format: [GATE] test-drift: TRIGGERED / NOT TRIGGERED — value: ___
			expect(gateSection).toMatch(
				/test-drift:\s*TRIGGERED\s*\/\s*NOT\s*TRIGGERED/,
			);
		});
	});

	describe('test-drift appears in PRE-COMMIT RULE', () => {
		it('PRE-COMMIT RULE checklist includes test-drift check', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Find the PRE-COMMIT RULE section
			const precommitStart = prompt.indexOf('PRE-COMMIT RULE');
			expect(precommitStart).toBeGreaterThan(0);

			// Extract the precommit section
			const precommitSection = prompt.slice(
				precommitStart,
				precommitStart + 700,
			);
			expect(precommitSection).toContain('test-drift');
		});

		it('PRE-COMMIT RULE asks "Did test-drift check run (or NOT TRIGGERED)?"', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			const precommitStart = prompt.indexOf('PRE-COMMIT RULE');
			const precommitSection = prompt.slice(
				precommitStart,
				precommitStart + 700,
			);

			// Should contain the question about test-drift check
			expect(precommitSection).toContain('test-drift check run');
			expect(precommitSection).toContain('NOT TRIGGERED');
		});
	});

	describe('Step 5l-ter text content verification', () => {
		it('step 5l-ter is labeled as TEST DRIFT CHECK (conditional)', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			expect(prompt).toContain('5l-ter. TEST DRIFT CHECK (conditional)');
		});

		it('step uses grep/search to find test files that cover affected functionality', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// Should mention using grep/search to find related tests
			expect(prompt).toContain('grep/search');
			expect(prompt).toContain('test files that cover');
		});

		it('step includes all four possible outcomes', () => {
			const agent = createArchitectAgent('test-model');
			const prompt = agent.config.prompt!;

			// All outcomes should be mentioned
			expect(prompt).toContain('NOT TRIGGERED');
			expect(prompt).toContain('DRIFT DETECTED');
			expect(prompt).toContain('related tests verified');
			expect(prompt).toContain('NO RELATED TESTS FOUND');
		});
	});
});
