import { describe, expect, test } from 'bun:test';
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
 * ADVERSARIAL TESTS: Orchestration Prompt Security (Task 3.2)
 *
 * Attack vectors for orchestration prompt safety and gate bypass attempts:
 * - Sequence bypass (skip critic, skip phases)
 * - Gate skipping (skip tests, skip secretscan)
 * - Secretscan bypass wording
 * - Reviewer-order manipulation
 */

describe('ARCHITECT WORKFLOW: Sequence Bypass Prevention', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: Critic gate MUST run BEFORE implementation (Rule 6)', () => {
		// Verify critic gate is mandatory and non-optional
		expect(prompt).toContain(
			'**CRITIC GATE (Execute BEFORE any implementation work)**',
		);
		expect(prompt).toContain(
			"Delegate plan to the active swarm's critic agent",
		);
		expect(prompt).toContain(
			'ONLY AFTER critic approval: Proceed to implementation (MODE: EXECUTE)',
		);

		// Verify Phase 4.5 explicitly gates Phase 5
		const phase45Pos = prompt.indexOf('### MODE: CRITIC-GATE');
		const phase5Pos = prompt.indexOf('### MODE: EXECUTE');
		expect(phase5Pos).toBeGreaterThan(phase45Pos);
	});

	test('SECURITY: Cannot skip Phase 4.5 Critic Gate to go straight to Phase 5', () => {
		// Verify APPROVED is required to proceed
		expect(prompt).toContain('**APPROVED** → Proceed to MODE: EXECUTE');
		expect(prompt).toContain('**NEEDS_REVISION** → Revise the plan');
		expect(prompt).toContain('**REJECTED** → Inform the user');

		// No bypass path exists
		const between45and5 = prompt.substring(
			prompt.indexOf('### MODE: CRITIC-GATE'),
			prompt.indexOf('### MODE: EXECUTE'),
		);
		const stripped = between45and5
			.replace(/SWARM_SKIP_SPEC_GATE/gi, '')
			.replace(/env var bypass/gi, '')
			.replace(/control-bypass/gi, '');
		const lowerStripped = stripped.toLowerCase();
		expect(lowerStripped).not.toContain('skip');
		expect(lowerStripped).not.toContain('bypass');
	});

	test('SECURITY: Phase sequence cannot be reordered (0→1→2→3→4→4.5→5→6)', () => {
		const p0 = prompt.indexOf('### MODE: RESUME');
		// Use '\n' suffix to distinguish from ### MODE: CLARIFY-SPEC
		const p1 = prompt.indexOf('### MODE: CLARIFY\n');
		const p2 = prompt.indexOf('### MODE: DISCOVER');
		const p3 = prompt.indexOf('### MODE: CONSULT');
		const p4 = prompt.indexOf('### MODE: PLAN');
		const p45 = prompt.indexOf('### MODE: CRITIC-GATE');
		const p5 = prompt.indexOf('### MODE: EXECUTE');
		const p6 = prompt.indexOf('### MODE: PHASE-WRAP');

		expect(p0).toBeLessThan(p1);
		expect(p1).toBeLessThan(p2);
		expect(p2).toBeLessThan(p3);
		expect(p3).toBeLessThan(p4);
		expect(p4).toBeLessThan(p45);
		expect(p45).toBeLessThan(p5);
		expect(p5).toBeLessThan(p6);
	});
});

describe('ARCHITECT WORKFLOW: Gate Skipping Prevention', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;
	const executeProtocol = EXECUTE_PROTOCOL;

	test('SECURITY: Cannot skip verification tests (Phase 5l)', () => {
		expect(prompt).toContain(
			"5l. the active swarm's test_engineer agent - Verification tests",
		);
		expect(prompt).toContain('FAIL → return to coder');

		// Verify step exists in sequence
		const step5l = executeProtocol.substring(
			executeProtocol.indexOf('5l.'),
			executeProtocol.indexOf('5m.'),
		);
		expect(step5l).toContain('Verification tests');
	});

	test('SECURITY: Cannot skip adversarial tests (Phase 5m)', () => {
		expect(prompt).toContain('5m. ADVERSARIAL TEST STEP (config-specific)');
		expect(prompt).toContain('FAIL → return to coder');

		// Verify adversarial tests run AFTER verification tests
		const verifPos = executeProtocol.indexOf('Verification tests');
		const adversPos = executeProtocol.indexOf('ADVERSARIAL TEST STEP');
		expect(adversPos).toBeGreaterThan(verifPos);
	});

	test('SECURITY: Cannot skip secretscan (now inside pre_check_batch at Phase 5i)', () => {
		expect(prompt).toContain('secretscan');

		// In v6.10, secretscan is inside pre_check_batch at step 5i
		// Verify pre_check_batch exists and contains secretscan
		expect(prompt).toContain('5i. Run `pre_check_batch` tool');
		const preCheckBatch = prompt.substring(
			prompt.indexOf('5i.'),
			prompt.indexOf('5j.'),
		);
		expect(preCheckBatch).toContain('secretscan');

		// Verify gates_passed logic controls progression
		expect(prompt).toContain('gates_passed === false');
		expect(prompt).toContain('gates_passed === true');
		expect(prompt).toContain("proceed to the active swarm's reviewer agent");
	});

	test('SECURITY: Cannot skip imports audit (Phase 5f)', () => {
		expect(prompt).toContain('5f. Run `imports` tool');
		expect(prompt).toContain('ISSUES → return to coder');
	});

	test('SECURITY: Cannot skip diff/contract check (Phase 5c)', () => {
		expect(prompt).toContain('Run `diff` tool');
		expect(prompt).toContain('If `hasContractChanges`');
		expect(prompt).toContain('integration analysis');
	});
});

describe('ARCHITECT WORKFLOW: Secretscan Bypass Prevention', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: Secretscan runs unconditionally in QA sequence', () => {
		// Secretscan is now in pre_check_batch (step 5i)
		// Check the detailed step text, not just the sequence summary
		const phase5Section = EXECUTE_PROTOCOL;
		expect(phase5Section).toContain('pre_check_batch');
		expect(phase5Section).toContain('secretscan');

		// Verify it runs before reviewer
		const preCheckPos = phase5Section.indexOf('pre_check_batch');
		const reviewerPos = phase5Section.indexOf(
			"the active swarm's reviewer agent",
		);
		expect(reviewerPos).toBeGreaterThan(preCheckPos);
	});

	test('SECURITY: Secretscan cannot be bypassed by task wording', () => {
		// In v6.10, secretscan runs inside pre_check_batch (step 5i)
		// Check that pre_check_batch step contains secretscan in the detailed section
		const phase5Section = EXECUTE_PROTOCOL;
		// Find the pre_check_batch section and check what tools it runs
		expect(phase5Section).toContain('5i. Run `pre_check_batch`');
		expect(phase5Section).toContain('secretscan');
	});

	test('SECURITY: Secretscan FINDINGS block progression to reviewer', () => {
		// In v6.10, secretscan is in pre_check_batch; gates_passed controls flow
		expect(prompt).toContain('gates_passed === false');
		expect(prompt).toContain('gates_passed === true');

		// Verify the pre_check_batch section contains secretscan and the flow control
		const phase5Section = EXECUTE_PROTOCOL;
		expect(phase5Section).toContain('secretscan');
		expect(phase5Section).toContain('gates_passed');
	});
});

describe('ARCHITECT WORKFLOW: Reviewer Order Manipulation Prevention', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: General reviewer runs AFTER all pre-review tools', () => {
		const diffPos = prompt.indexOf('Run `diff`');
		const importsPos = prompt.indexOf('Run `imports`');
		const lintPos = prompt.indexOf('lint');
		const secretscanPos = prompt.indexOf('secretscan');
		const reviewerPos = prompt.indexOf(
			"the active swarm's reviewer agent - General review",
		);

		expect(reviewerPos).toBeGreaterThan(diffPos);
		expect(reviewerPos).toBeGreaterThan(importsPos);
		expect(reviewerPos).toBeGreaterThan(lintPos);
		expect(reviewerPos).toBeGreaterThan(secretscanPos);
	});

	test('SECURITY: Security review runs AFTER general review (Phase 5k)', () => {
		const generalReviewPos = prompt.indexOf(
			"5j. the active swarm's reviewer agent - General review",
		);
		const securityReviewPos = prompt.indexOf('Security gate');

		expect(securityReviewPos).toBeGreaterThan(generalReviewPos);

		// Security gate can still reject after general approval
		expect(prompt).toContain('REJECTED before the configured QA retry limit');
	});

	test('SECURITY: Reviewer cannot run before diff tool', () => {
		// The workflow explicitly requires diff first
		expect(prompt).toContain('5c. Run `diff` tool');
		expect(prompt).toContain('5f. Run `imports` tool');
		expect(prompt).toContain('5g. Run `lint`');
		expect(prompt).toContain('5i. Run `pre_check_batch`');
		expect(prompt).toContain("5j. the active swarm's reviewer agent");

		// Sequential numbering enforces order
		const phase5Section = EXECUTE_PROTOCOL;

		const stepC = phase5Section.indexOf('5c.');
		const stepD = phase5Section.indexOf('5d.');
		const stepE = phase5Section.indexOf('5e.');
		const stepF = phase5Section.indexOf('5f.');
		const stepG = phase5Section.indexOf('5g.');
		const stepH = phase5Section.indexOf('5h.');
		const stepI = phase5Section.indexOf('5i.');
		const stepJ = phase5Section.indexOf('5j.');

		expect(stepC).toBeLessThan(stepD);
		expect(stepD).toBeLessThan(stepE);
		expect(stepE).toBeLessThan(stepF);
		expect(stepF).toBeLessThan(stepG);
		expect(stepG).toBeLessThan(stepH);
		expect(stepH).toBeLessThan(stepI);
		expect(stepI).toBeLessThan(stepJ);
	});
});

describe('ARCHITECT WORKFLOW: UI Gate Bypass Prevention', () => {
	const prompt = createArchitectAgent(
		'test-model',
		undefined,
		undefined,
		undefined,
		undefined,
		{
			enabled: true,
		},
	).config.prompt;

	test('SECURITY: Designer must run BEFORE coder for UI tasks', () => {
		expect(prompt).toContain('**UI/UX DESIGN GATE**');
		expect(prompt).toContain('delegate to {{AGENT_PREFIX}}designer FIRST');
		expect(prompt).toContain('Then pass the scaffold to {{AGENT_PREFIX}}coder');
	});

	test('SECURITY: UI trigger keywords are comprehensive (cannot be avoided)', () => {
		const uiKeywords = [
			'new page',
			'new screen',
			'new component',
			'redesign',
			'layout change',
			'form',
			'modal',
			'dialog',
			'dropdown',
			'sidebar',
			'navbar',
			'dashboard',
			'landing page',
			'signup',
			'login form',
			'settings page',
			'profile page',
		];

		uiKeywords.forEach((keyword) => {
			expect(prompt.toLowerCase()).toContain(keyword);
		});
	});

	test('SECURITY: UI file path triggers are comprehensive', () => {
		const paths = [
			'pages/',
			'components/',
			'views/',
			'screens/',
			'ui/',
			'layouts/',
		];
		paths.forEach((path) => {
			expect(prompt).toContain(path);
		});
	});

	test('SECURITY: Designer produces scaffold that coder must follow', () => {
		expect(prompt).toContain('produce a code scaffold');
		expect(prompt).toContain(
			'pass the scaffold to {{AGENT_PREFIX}}coder as INPUT',
		);
		// The coder implements TODOs in the scaffold
		expect(prompt).toContain('The coder implements the TODOs');
	});
});

describe('ARCHITECT WORKFLOW: Memory/Swarm Identity Protection', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: Must NOT store swarm identity in memory blocks (Rule 5)', () => {
		expect(prompt).toContain('NEVER store your swarm identity');
		expect(prompt).toContain('swarm ID, or agent prefix in memory blocks');
		expect(prompt).toContain(
			'Your identity comes ONLY from your system prompt',
		);
		expect(prompt).toContain('Memory blocks are for project knowledge only');
	});

	test('SECURITY: Phase 0 purges stale memory on swarm resume', () => {
		expect(prompt).toContain('Purge any memory blocks');
		expect(prompt).toContain("that reference a different swarm's identity");
	});
});

describe('ARCHITECT WORKFLOW: Delegation Safety', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: Must delegate ALL coding to coder (Rule 1)', () => {
		expect(prompt).toContain('DELEGATE all coding to {{AGENT_PREFIX}}coder');
		expect(prompt).toContain('You do NOT write code');
	});

	test('SECURITY: Fallback only after QA_RETRY_LIMIT failures (Rule 4)', () => {
		expect(prompt).toContain('Fallback: Only code yourself');
		expect(prompt).toContain(
			'after {{QA_RETRY_LIMIT}} {{AGENT_PREFIX}}coder failures',
		);
		expect(prompt).toContain('on same task');
	});

	test('SECURITY: One agent per message (Rule 2)', () => {
		expect(prompt).toContain('ONE agent per message');
		expect(prompt).toContain('Send, STOP, wait for response');
	});

	test('SECURITY: Stage B parallel exception is narrow and does not weaken coder task isolation', () => {
		expect(prompt).toContain(
			'Exception: Stage B reviewer/test_engineer gate agents for the SAME completed coder task',
		);
		expect(prompt).toContain(
			'This exception NEVER applies to coder delegations',
		);
		expect(prompt).toContain('ONE task per {{AGENT_PREFIX}}coder call');
		expect(prompt).toContain('Never batch');
	});

	test('SECURITY: One task per coder call (Rule 3)', () => {
		expect(prompt).toContain('ONE task per {{AGENT_PREFIX}}coder call');
		expect(prompt).toContain('Never batch');
	});

	test('SECURITY: CONSTRAINT field enforces restrictions in delegation', () => {
		// CONSTRAINT appears in actual delegation examples, not as a format template
		// (format template was refactored to [agent-specific fields required by INPUT FORMAT])
		expect(prompt).toContain('CONSTRAINT: Focus on auth only');
		expect(prompt).toContain('CONSTRAINT: Do not modify other functions');
	});
});

describe('ARCHITECT WORKFLOW: Adversarial Test Constraints', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: Adversarial tests restricted to attack vectors only', () => {
		// In Rule 7 (MANDATORY QA GATE)
		expect(prompt).toContain('adversarial tests');
		expect(prompt).toContain('attack vectors only');

		// In delegation example
		expect(prompt).toContain('CONSTRAINT: ONLY attack vectors');
		expect(prompt).toContain(
			'malformed inputs, oversized payloads, injection attempts',
		);
	});

	test('SECURITY: Verification tests have different constraint than adversarial', () => {
		// Verification tests are for functional correctness
		const verifSection = prompt.substring(
			prompt.indexOf('verification tests'),
			prompt.indexOf('verification tests') + 100,
		);
		// Should NOT say "attack vectors" for verification
		expect(verifSection.toLowerCase()).not.toContain('attack');
	});
});

describe('ARCHITECT WORKFLOW: Retrospective Tracking', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('SECURITY: Phase metrics tracked at end of EVERY phase', () => {
		expect(prompt).toContain('**RETROSPECTIVE TRACKING**');
		expect(prompt).toContain('At the end of every phase');
	});

	test('SECURITY: Evidence written BEFORE user summary in Phase 6', () => {
		const phase6Start = prompt.indexOf('### MODE: PHASE-WRAP');
		const blockersStart = prompt.indexOf('### Blockers');
		const phase6Section = prompt.slice(phase6Start, blockersStart);

		const evidencePos = phase6Section.indexOf('Write retrospective evidence');
		const summarizePos = phase6Section.indexOf('6. Summarize to user');

		expect(evidencePos).toBeGreaterThan(-1);
		expect(summarizePos).toBeGreaterThan(-1);
		expect(evidencePos).toBeLessThan(summarizePos);
	});

	test('SECURITY: Phase metrics reset after writing', () => {
		expect(prompt).toContain('Reset Phase Metrics');
		expect(prompt).toContain('Reset Phase Metrics to 0');
	});
});

describe('ARCHITECT WORKFLOW: Task Granularity Anti-Bypass (Phase 4)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt!;

	test('SECURITY: MEDIUM tasks must be split before writing to plan', () => {
		// The rule must explicitly require splitting before writing to plan
		expect(prompt).toContain('SPLIT into sequential');
		expect(prompt).toContain('before writing to plan');
	});

	test('SECURITY: Large tasks cannot be written to plan', () => {
		// "A LARGE task in the plan is a planning error" blocks the bypass
		expect(prompt).toContain('LARGE task');
		expect(prompt).toContain('planning error');
	});

	test('SECURITY: Compound verbs must be detected as multiple tasks', () => {
		// The rule must explicitly forbid compound verbs
		expect(prompt).toContain('compound verbs');
	});

	test('SECURITY: Coder cannot receive scope decisions', () => {
		// The rule must explicitly state "Coder makes zero scope decisions"
		expect(prompt).toContain('Coder makes zero scope decisions');
	});

	test('SECURITY: Litmus test blocks oversized task descriptions', () => {
		// Tasks that can't fit in 3 bullet points are too large
		expect(prompt).toContain('Litmus test');
		expect(prompt).toContain('3 bullet points');
		expect(prompt).toContain('too large');
	});

	test('SECURITY: "Just a refactor" cannot bypass task splitting', () => {
		// MEDIUM tasks must be split regardless of refactor classification
		const granularitySection = prompt.substring(
			prompt.indexOf('TASK GRANULARITY RULES'),
			prompt.indexOf('### MODE: CRITIC-GATE'),
		);
		// No exemption for refactors exists
		expect(granularitySection.toLowerCase()).not.toContain('refactor exempt');
		expect(granularitySection.toLowerCase()).not.toContain('refactor skip');
	});
});

describe('ARCHITECT WORKFLOW: Failure Counting Anti-Bypass (Phase 6)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt!;

	test('SECURITY: Failure counter cannot be bypassed by simple change claims', () => {
		// Counter must increment on ANY gate failure, regardless of change complexity
		expect(prompt).toContain('increment the counter when');
		expect(prompt).toContain('gates_passed === false');

		// Verify there's no "simple change" bypass
		const retrySection = prompt.substring(
			prompt.indexOf('QA_RETRY_LIMIT'),
			prompt.indexOf('QA_RETRY_LIMIT') + 500,
		);
		expect(retrySection.toLowerCase()).not.toContain('simple change bypass');
		expect(retrySection.toLowerCase()).not.toContain('skip counter for');
	});

	test('SECURITY: Escalation required after limit reached', () => {
		// Must escalate, not silently continue
		expect(prompt).toContain('escalate to user');
		expect(prompt).toContain('before writing code yourself');

		// Verify fallback is explicit about the condition
		expect(prompt).toContain('after {{QA_RETRY_LIMIT}}');
		expect(prompt).toContain('failures');
	});

	test('SECURITY: Retry must use structured rejection format', () => {
		// Structured format required for clarity - prevents vague rejections
		expect(prompt).toContain('GATE FAILED:');
		expect(prompt).toContain('REASON:');
		expect(prompt).toContain('REQUIRED FIX');
	});

	test('SECURITY: Cannot resume at step 5a after retry', () => {
		// Must resume at failed step, not restart from beginning
		expect(prompt).toContain('do not restart from 5a');
	});

	test('SECURITY: Re-entry point is step 5b (coder)', () => {
		// Must re-enter through coder, not skip to later step
		expect(prompt).toContain('Re-enter at step 5b');
		expect(prompt).toContain('{{AGENT_PREFIX}}coder');
	});

	test('SECURITY: Counter cannot be reset mid-retry', () => {
		// Counter persists until escalation or success - no manual reset
		const retrySection = prompt.substring(
			prompt.indexOf('QA_RETRY_LIMIT'),
			prompt.indexOf('Fallback:') + 200,
		);
		// Should not allow counter reset bypass
		expect(retrySection.toLowerCase()).not.toContain('reset counter');
		expect(retrySection.toLowerCase()).not.toContain('clear counter');
	});

	test('SECURITY: Gated step cannot be skipped after retry', () => {
		// All gates must pass before proceeding - retry doesn't skip gates
		expect(prompt).toContain('gates_passed === true');
		expect(prompt).toContain("proceed to the active swarm's reviewer agent");

		// Verify gates are re-checked after retry
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);
		expect(phase5Section).toContain('gates_passed');
	});
});

describe('ARCHITECT Anti-Rationalization Gate Hardening (Phase 7)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt!;

	test('SECURITY: "simple change" rationalization addressed', () => {
		expect(prompt).toContain("It's a simple change");
		expect(prompt).toContain('gates are mandatory for ALL changes');
	});

	test('SECURITY: "just a rename" rationalization addressed', () => {
		expect(prompt).toContain('just a rename');
	});

	test('SECURITY: "authors are blind" principle stated', () => {
		expect(prompt).toContain('authors are blind to their own mistakes');
	});

	test('SECURITY: "no simple changes" rule present', () => {
		expect(prompt).toContain('There are NO simple changes');
	});

	test('SECURITY: "pre_check_batch will catch" rationalization addressed', () => {
		expect(prompt).toContain('pre_check_batch will catch any issues');
	});

	test('SECURITY: PRE-COMMIT RULE blocks commits without reviewer', () => {
		expect(prompt).toContain('PRE-COMMIT RULE');
		expect(prompt).toContain('not "I reviewed it" — the agent must have run');
	});

	test('SECURITY: Commit without QA gate is named a violation', () => {
		expect(prompt).toContain(
			'A commit without a completed QA gate is a workflow violation',
		);
	});
});
