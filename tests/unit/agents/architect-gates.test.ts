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
 * QA GATE TESTS: pre_check_batch Integration (v6.10)
 *
 * Tests for pre_check_batch gate in the QA sequence:
 * - Gate ordering (pre_check_batch after build_check, before reviewer)
 * - Contains lint:check, secretscan, sast_scan, quality_budget in parallel
 * - Error handling (gates_passed === false returns to coder, no reviewer)
 * - Success path (gates_passed === true proceeds to reviewer)
 */

describe('ARCHITECT QA GATE: pre_check_batch Integration', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('pre_check_batch is in TIERED QA GATE sequence (Rule 7)', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';
		expect(qaGate).toContain('build_check');
		expect(qaGate).toContain('pre_check_batch');
		expect(qaGate).toContain('reviewer');

		// Verify ordering: build_check → pre_check_batch → reviewer
		const buildPos = qaGate.indexOf('build_check');
		const preCheckPos = qaGate.indexOf('pre_check_batch');
		const reviewerPos = qaGate.indexOf('reviewer →');

		expect(buildPos).toBeLessThan(preCheckPos);
		expect(preCheckPos).toBeLessThan(reviewerPos);
	});

	test('pre_check_batch runs lint:check, secretscan, sast_scan, quality_budget in parallel', () => {
		// Check the prompt contains all four tools as part of pre_check_batch
		expect(prompt).toContain('lint:check');
		expect(prompt).toContain('secretscan');
		expect(prompt).toContain('sast_scan');
		expect(prompt).toContain('quality_budget');
		expect(prompt).toContain('parallel');
	});

	test('pre_check_batch returns gates_passed boolean', () => {
		expect(prompt).toContain('gates_passed');
		expect(prompt).toContain('lint');
		expect(prompt).toContain('secretscan');
		expect(prompt).toContain('sast_scan');
		expect(prompt).toContain('quality_budget');
		expect(prompt).toContain('total_duration_ms');
	});

	test('pre_check_batch has explicit branching language (gates_passed === false vs true)', () => {
		// Must have gates_passed === false branch (return to coder, no reviewer)
		expect(prompt).toContain('gates_passed === false');
		expect(prompt).toContain('return to coder');
		expect(prompt).toContain("Do NOT call the active swarm's reviewer agent");

		// Must have gates_passed === true branch (proceed to reviewer)
		expect(prompt).toContain('gates_passed === true');
		expect(prompt).toContain("proceed to the active swarm's reviewer agent");
	});

	test('pre_check_batch runs AFTER build_check in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const buildPos = phase5Section.indexOf('5h.');
		const preCheckPos = phase5Section.indexOf('5i.');

		expect(buildPos).toBeLessThan(preCheckPos);
		expect(phase5Section).toContain('pre_check_batch');
	});

	test('pre_check_batch runs BEFORE reviewer in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const preCheckPos = phase5Section.indexOf('5i.');
		const reviewerPos = phase5Section.indexOf('5j.');

		expect(preCheckPos).toBeLessThan(reviewerPos);
		expect(phase5Section).toContain('reviewer');
	});

	test('pre_check_batch gates_failed === false returns to coder (no reviewer)', () => {
		// In Phase 5i
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const preCheckStep = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);

		expect(preCheckStep).toContain('gates_passed === false');
		expect(preCheckStep).toContain("the active swarm's coder agent"); // "return structured rejection to coder"
		expect(preCheckStep).toContain(
			"Do NOT call the active swarm's reviewer agent",
		);
	});

	test('pre_check_batch gates_passed === true proceeds to reviewer', () => {
		// In Phase 5i
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const preCheckStep = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);

		expect(preCheckStep).toContain('gates_passed === true');
		expect(preCheckStep).toContain(
			"proceed to the active swarm's reviewer agent",
		);
	});

	test('pre_check_batch cannot be skipped in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// pre_check_batch is mandatory, not optional
		expect(qaGate.toLowerCase()).not.toContain('optional');

		// Must run after build_check
		const buildPos = qaGate.indexOf('build_check');
		const preCheckPos = qaGate.indexOf('pre_check_batch');
		expect(preCheckPos).toBeGreaterThan(buildPos);

		// Must run before reviewer
		const reviewerPos = qaGate.indexOf('reviewer →');
		expect(reviewerPos).toBeGreaterThan(preCheckPos);
	});

	test('pre_check_batch runs BEFORE test_engineer in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		const preCheckPos = qaGate.indexOf('pre_check_batch');
		const testPos = qaGate.indexOf('test_engineer verification');

		expect(testPos).toBeGreaterThan(preCheckPos);
	});
});

describe('ARCHITECT QA GATE: pre_check_batch Tool Reference', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('Available Tools includes pre_check_batch', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('pre_check_batch');
	});

	test('pre_check_batch description includes parallel verification', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		// Should mention it runs verification tools in parallel
		expect(toolsSection).toContain('parallel');
		expect(toolsSection).toContain('lint');
		expect(toolsSection).toContain('secretscan');
		expect(toolsSection).toContain('sast_scan');
		expect(toolsSection).toContain('quality_budget');
	});
});

describe('ARCHITECT QA GATE: pre_check_batch Anti-Bypass', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('pre_check_batch is mandatory (not skippable)', () => {
		// Check in Rule 7 sequence
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// Must appear in the sequence
		expect(qaGate).toContain('pre_check_batch');

		// Cannot be skipped
		expect(qaGate.toLowerCase()).not.toMatch(/pre_check_batch.*skip/);
		expect(qaGate.toLowerCase()).not.toMatch(/optional.*pre_check_batch/);
	});

	test('pre_check_batch ordering cannot be bypassed by reviewer coming earlier', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// Get positions
		const buildPos = qaGate.indexOf('build_check');
		const preCheckPos = qaGate.indexOf('pre_check_batch');
		const reviewerPos = qaGate.indexOf('reviewer →');

		// pre_check_batch MUST be between build_check and reviewer
		expect(buildPos).toBeLessThan(preCheckPos);
		expect(preCheckPos).toBeLessThan(reviewerPos);
	});

	test('build_check proceeds to pre_check_batch (not directly to reviewer)', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// 5h is build_check
		const buildStep = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);

		// build_check should proceed to pre_check_batch, not to reviewer
		expect(buildStep).toContain('proceed to pre_check_batch');
		expect(buildStep).not.toContain('proceed to reviewer');
	});

	test('pre_check_batch gating is distinct from build_check gating', () => {
		// pre_check_batch has different gating logic than build_check
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// build_check step (5h)
		const buildStep = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);

		// pre_check_batch step (5i)
		const preCheckStep = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);

		// build_check: BUILD FAILS → return to coder (two paths in v6.10)
		expect(buildStep).toContain('BUILD FAILS');
		expect(buildStep).toContain('SUCCESS');

		// pre_check_batch: gates_passed === false → return to coder (no reviewer)
		expect(preCheckStep).toContain('gates_passed === false');
		expect(preCheckStep).toContain(
			"Do NOT call the active swarm's reviewer agent",
		);

		// pre_check_batch: gates_passed === true → proceed to reviewer
		expect(preCheckStep).toContain('gates_passed === true');
		expect(preCheckStep).toContain(
			"proceed to the active swarm's reviewer agent",
		);
	});

	test('pre_check_batch runs four tools in parallel (not sequential)', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const preCheckStep = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);

		// Should mention parallel execution
		expect(preCheckStep.toLowerCase()).toContain('parallel');

		// Should list all four tools
		expect(preCheckStep).toContain('lint:check');
		expect(preCheckStep).toContain('secretscan');
		expect(preCheckStep).toContain('sast_scan');
		expect(preCheckStep).toContain('quality_budget');
	});

	test('pre_check_batch returns structured results', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const preCheckStep = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);

		// Should return structured results
		expect(preCheckStep).toContain('gates_passed');
		expect(preCheckStep).toContain('lint');
		expect(preCheckStep).toContain('secretscan');
		expect(preCheckStep).toContain('sast_scan');
		expect(preCheckStep).toContain('quality_budget');
		expect(preCheckStep).toContain('total_duration_ms');
	});
});

/**
 * QA GATE TESTS: build_check Integration (v6.10 - now at step 5h)
 *
 * Tests for build_check gate in the QA sequence:
 * - Gate ordering (build_check after lint, before pre_check_batch)
 * - Error handling (BUILD FAILS return to coder)
 * - Success path (SUCCESS proceeds to pre_check_batch)
 */

describe('ARCHITECT QA GATE: build_check Integration (v6.10)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('build_check is in TIERED QA GATE sequence (Rule 7)', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';
		expect(qaGate).toContain('lint');
		expect(qaGate).toContain('build_check');
		expect(qaGate).toContain('pre_check_batch');
		expect(qaGate).toContain('reviewer');

		// Verify ordering: lint → build_check → pre_check_batch → reviewer
		const lintPos = qaGate.indexOf('lint');
		const buildPos = qaGate.indexOf('build_check');
		const preCheckPos = qaGate.indexOf('pre_check_batch');
		const reviewerPos = qaGate.indexOf('reviewer →');

		expect(lintPos).toBeLessThan(buildPos);
		expect(buildPos).toBeLessThan(preCheckPos);
		expect(preCheckPos).toBeLessThan(reviewerPos);
	});

	test('build_check has explicit branching language with two paths', () => {
		// Must have BUILD FAILS branch (note: v6.10 uses "BUILD FAILS" not "BUILD FAILURES")
		expect(prompt).toContain('BUILD FAILS');
		expect(prompt).toContain('return to coder');

		// Must have SUCCESS branch (v6.10 removed SKIPPED path)
		expect(prompt).toContain('SUCCESS');
		expect(prompt).toContain('proceed to pre_check_batch');
	});

	test('build_check runs AFTER lint in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const lintPos = phase5Section.indexOf('5g.');
		const buildPos = phase5Section.indexOf('5h.');

		expect(lintPos).toBeLessThan(buildPos);
		expect(phase5Section).toContain('build_check');
	});

	test('build_check runs BEFORE pre_check_batch in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const buildPos = phase5Section.indexOf('5h.');
		const preCheckPos = phase5Section.indexOf('5i.');

		expect(buildPos).toBeLessThan(preCheckPos);
		expect(phase5Section).toContain('pre_check_batch');
	});

	test('build_check failures triggers coder retry', () => {
		// In Phase 5h
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const buildStep = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);

		expect(buildStep).toContain('BUILD FAILS');
		expect(buildStep).toContain('return to coder');
	});

	test('build_check success proceeds to pre_check_batch', () => {
		// In Phase 5h
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const buildStep = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);

		expect(buildStep).toContain('SUCCESS');
		expect(buildStep).toContain('proceed to pre_check_batch');
	});

	test('build_check cannot be skipped in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// build_check is mandatory in sequence
		expect(qaGate).toContain('build_check');

		// Must run after lint
		const lintPos = qaGate.indexOf('lint');
		const buildPos = qaGate.indexOf('build_check');
		expect(buildPos).toBeGreaterThan(lintPos);

		// Must run before reviewer
		const reviewerPos = qaGate.indexOf('reviewer →');
		expect(reviewerPos).toBeGreaterThan(buildPos);
	});

	test('build_check runs BEFORE test_engineer in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		const buildPos = qaGate.indexOf('build_check');
		const testPos = qaGate.indexOf('test_engineer verification');

		expect(testPos).toBeGreaterThan(buildPos);
	});
});

describe('ARCHITECT QA GATE: build_check Tool Reference', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('Available Tools includes build_check', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('build_check');
	});

	test('build_check description includes build verification', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		// Should mention it's for build verification
		expect(toolsSection).toContain('build');
	});
});

describe('ARCHITECT QA GATE: build_check Anti-Bypass (v6.10)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('build_check is mandatory (not skippable)', () => {
		// Check in Rule 7 sequence
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// Must appear in the sequence
		expect(qaGate).toContain('build_check');

		// Check detailed branching in Phase 5
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const buildStep = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);

		// Cannot be bypassed - must have two distinct paths (v6.10)
		expect(buildStep).toContain('BUILD FAILS');
		expect(buildStep).toContain('SUCCESS');
	});

	test('build_check ordering cannot be bypassed by reviewer coming earlier', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// Get positions
		const lintPos = qaGate.indexOf('lint');
		const buildPos = qaGate.indexOf('build_check');
		const reviewerPos = qaGate.indexOf('reviewer →');

		// build_check MUST be between lint and reviewer
		expect(lintPos).toBeLessThan(buildPos);
		expect(buildPos).toBeLessThan(reviewerPos);
	});

	test('lint proceeds to build_check (in Rule 7 detailed steps)', () => {
		// In Rule 7 detailed steps, lint says SUCCESS → proceed to build_check
		const rule7Section = prompt.substring(
			prompt.indexOf('TIERED QA GATE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// lint should proceed to build_check in Rule 7
		expect(rule7Section).toContain('lint fix → build_check');
	});

	test('build_check gating has two distinct paths', () => {
		// build_check has two paths in v6.10: failures, success
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// build_check step (5h)
		const buildStep = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);

		// BUILD FAILS → return to coder
		expect(buildStep).toContain('BUILD FAILS');

		// SUCCESS → proceed to pre_check_batch (not directly to reviewer)
		expect(buildStep).toContain('SUCCESS');
		expect(buildStep).toContain('proceed to pre_check_batch');
	});
});

/**
 * QA GATE TESTS: placeholder_scan Integration (Task 2.3)
 *
 * Tests for placeholder_scan gate in the QA sequence:
 * - Gate ordering (placeholder_scan after syntax_check, before imports)
 * - Error handling (placeholder findings return to coder)
 * - Success path (clean scan proceeds to imports)
 */

describe('ARCHITECT QA GATE: placeholder_scan Integration', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('placeholder_scan is in TIERED QA GATE sequence (Rule 7)', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';
		expect(qaGate).toContain('placeholder_scan');
		expect(qaGate).toContain('syntax_check');

		// Verify ordering: syntax_check → placeholder_scan → ... (imports is in detailed steps)
		const syntaxPos = qaGate.indexOf('syntax_check');
		const placeholderPos = qaGate.indexOf('placeholder_scan');

		expect(syntaxPos).toBeLessThan(placeholderPos);
	});

	test('placeholder_scan has explicit branching language (PLACEHOLDER FINDINGS vs NO FINDINGS)', () => {
		// Must have PLACEHOLDER FINDINGS branch
		expect(prompt).toContain('PLACEHOLDER FINDINGS');
		expect(prompt).toContain('return to coder');

		// Must have NO FINDINGS branch
		expect(prompt).toContain('NO FINDINGS');
		expect(prompt).toContain('proceed to imports');
	});

	test('placeholder_scan runs AFTER syntax_check in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const syntaxPos = phase5Section.indexOf('5d.');
		const placeholderPos = phase5Section.indexOf('5e.');

		expect(syntaxPos).toBeLessThan(placeholderPos);
		expect(phase5Section).toContain('placeholder_scan');
	});

	test('placeholder_scan runs BEFORE imports in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const placeholderPos = phase5Section.indexOf('5e.');
		const importsPos = phase5Section.indexOf('5f.');

		expect(placeholderPos).toBeLessThan(importsPos);
		expect(phase5Section).toContain('imports');
	});

	test('placeholder_scan findings triggers coder retry', () => {
		// In Phase 5e
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const placeholderStep = phase5Section.substring(
			phase5Section.indexOf('5e.'),
			phase5Section.indexOf('5f.'),
		);

		expect(placeholderStep).toContain('PLACEHOLDER FINDINGS');
		expect(placeholderStep).toContain('return to coder');
	});

	test('placeholder_scan clean proceeds to imports', () => {
		// In Phase 5e
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const placeholderStep = phase5Section.substring(
			phase5Section.indexOf('5e.'),
			phase5Section.indexOf('5f.'),
		);

		expect(placeholderStep).toContain('NO FINDINGS');
		expect(placeholderStep).toContain('proceed to imports');
	});

	test('placeholder_scan cannot be skipped in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// placeholder_scan is mandatory, not optional
		expect(qaGate.toLowerCase()).not.toContain('optional');

		// Must run after syntax_check
		const syntaxPos = qaGate.indexOf('syntax_check');
		const placeholderPos = qaGate.indexOf('placeholder_scan');
		expect(placeholderPos).toBeGreaterThan(syntaxPos);

		// Must run before pre_check_batch
		const preCheckPos = qaGate.indexOf('pre_check_batch');
		expect(preCheckPos).toBeGreaterThan(placeholderPos);
	});

	test('placeholder_scan runs BEFORE reviewer in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		const placeholderPos = qaGate.indexOf('placeholder_scan');
		const reviewerPos = qaGate.indexOf('reviewer →');

		expect(reviewerPos).toBeGreaterThan(placeholderPos);
	});
});

describe('ARCHITECT QA GATE: placeholder_scan Tool Reference', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('Available Tools includes placeholder_scan', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('placeholder_scan');
	});
});

describe('ARCHITECT QA GATE: syntax_check Integration', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('syntax_check is in TIERED QA GATE sequence (Rule 7)', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';
		expect(qaGate).toContain('syntax_check');
		expect(qaGate).toContain('diff');

		// Verify ordering: diff → syntax_check → placeholder_scan
		const diffPos = qaGate.indexOf('diff');
		const syntaxPos = qaGate.indexOf('syntax_check');
		const placeholderPos = qaGate.indexOf('placeholder_scan');

		expect(diffPos).toBeLessThan(syntaxPos);
		expect(syntaxPos).toBeLessThan(placeholderPos);
	});

	test('syntax_check has explicit branching language (SYNTACTIC ERRORS vs NO ERRORS)', () => {
		// Must have SYNTACTIC ERRORS branch
		expect(prompt).toContain('SYNTACTIC ERRORS');
		expect(prompt).toContain('return to coder');

		// Must have NO ERRORS branch
		expect(prompt).toContain('NO ERRORS');
		expect(prompt).toContain('proceed to placeholder_scan');
	});

	test('syntax_check runs AFTER diff in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const diffPos = phase5Section.indexOf('5c.');
		const syntaxPos = phase5Section.indexOf('5d.');

		expect(diffPos).toBeLessThan(syntaxPos);
		expect(phase5Section).toContain('syntax_check');
	});

	test('syntax_check runs BEFORE placeholder_scan in Phase 5', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const syntaxPos = phase5Section.indexOf('5d.');
		const placeholderPos = phase5Section.indexOf('5e.');

		expect(syntaxPos).toBeLessThan(placeholderPos);
		expect(phase5Section).toContain('placeholder_scan');
	});

	test('syntax_check error triggers coder retry', () => {
		// In Phase 5d
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const syntaxStep = phase5Section.substring(
			phase5Section.indexOf('5d.'),
			phase5Section.indexOf('5e.'),
		);

		expect(syntaxStep).toContain('SYNTACTIC ERRORS');
		expect(syntaxStep).toContain('return to coder');
	});

	test('syntax_check clean proceeds to placeholder_scan', () => {
		// In Phase 5d
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		const syntaxStep = phase5Section.substring(
			phase5Section.indexOf('5d.'),
			phase5Section.indexOf('5e.'),
		);

		expect(syntaxStep).toContain('NO ERRORS');
		expect(syntaxStep).toContain('proceed to placeholder_scan');
	});

	test('syntax_check cannot be skipped in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// syntax_check is mandatory, not optional
		expect(qaGate.toLowerCase()).not.toContain('optional');

		// Must run before pre_check_batch
		const syntaxPos = qaGate.indexOf('syntax_check');
		const preCheckPos = qaGate.indexOf('pre_check_batch');
		expect(preCheckPos).toBeGreaterThan(syntaxPos);
	});

	test('syntax_check runs BEFORE reviewer in QA sequence', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		const syntaxPos = qaGate.indexOf('syntax_check');
		const reviewerPos = qaGate.indexOf('reviewer →');

		expect(reviewerPos).toBeGreaterThan(syntaxPos);
	});
});

describe('ARCHITECT QA GATE: syntax_check Tool Reference', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('Available Tools includes syntax_check', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('syntax_check');
	});

	test('syntax_check is not in SECURITY_KEYWORDS (it is a pre-review gate)', () => {
		// syntax_check is a gate, not a security trigger
		const securityKeywordsMatch =
			prompt.match(/SECURITY_KEYWORDS:[^`]*$/m)?.[0] || '';
		// Note: syntax_check should NOT be in SECURITY_KEYWORDS
		// It's checked separately as a gate, not as a security-triggering keyword
	});
});

/**
 * QA GATE TESTS: Security Tools (secretscan, sast_scan) now inside pre_check_batch
 *
 * These tests verify that secretscan and sast_scan are still present in the prompt
 * but now run inside pre_check_batch as parallel tools, not as standalone steps.
 */

describe('ARCHITECT QA GATE: secretscan and sast_scan in pre_check_batch', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('secretscan is in Available Tools', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('secretscan');
	});

	test('sast_scan is in Available Tools', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('sast_scan');
	});

	test('secretscan runs inside pre_check_batch (not as standalone step 5h)', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// 5h should be build_check, NOT secretscan
		const step5h = phase5Section.substring(
			phase5Section.indexOf('5h.'),
			phase5Section.indexOf('5i.'),
		);
		expect(step5h).toContain('build_check');
		expect(step5h).not.toContain('secretscan');

		// pre_check_batch (5i) should contain secretscan
		const step5i = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);
		expect(step5i).toContain('secretscan');
	});

	test('sast_scan runs inside pre_check_batch (not as standalone step 5i)', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// 5i should be pre_check_batch, NOT standalone sast_scan
		const step5i = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);
		expect(step5i).toContain('pre_check_batch');
		expect(step5i).toContain('sast_scan');
	});

	test('secretscan and sast_scan mentioned in Security gate trigger', () => {
		// Security gate should still trigger on secretscan and sast_scan findings
		const securityGate = prompt.match(/Security gate:[^`]*/)?.[0] || '';
		expect(securityGate).toContain('secretscan');
		expect(securityGate).toContain('sast_scan');
		expect(securityGate).toContain('ANY findings');
	});

	test('secretscan and sast_scan are in the prompt (Rule 7 detailed steps)', () => {
		// The detailed steps after Rule 7 sequence should mention these tools
		// Look for pre_check_batch description which contains all four tools
		expect(prompt).toContain('secretscan');
		expect(prompt).toContain('sast_scan');

		// pre_check_batch description should contain secretscan and sast_scan
		// Look in the full prompt for the pre_check_batch section
		expect(prompt).toMatch(/pre_check_batch[^`]*secretscan/s);
		expect(prompt).toMatch(/pre_check_batch[^`]*sast_scan/s);
	});

	test('quality_budget runs inside pre_check_batch (not as standalone step 5k)', () => {
		const phase5Section = prompt.substring(
			prompt.indexOf('### MODE: EXECUTE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);

		// There should be no standalone quality_budget step at 5k
		// 5k should be Security gate
		const step5k = phase5Section.substring(
			phase5Section.indexOf('5k.'),
			phase5Section.indexOf('5l.'),
		);
		expect(step5k).toContain('Security gate');

		// pre_check_batch (5i) should contain quality_budget
		const step5i = phase5Section.substring(
			phase5Section.indexOf('5i.'),
			phase5Section.indexOf('5j.'),
		);
		expect(step5i).toContain('quality_budget');
	});

	test('quality_budget is in Available Tools', () => {
		const toolsSection = prompt.match(/Available Tools:[^`]*$/m)?.[0] || '';
		expect(toolsSection).toContain('quality_budget');
	});
});

describe('ARCHITECT QA GATE: Full Sequence Verification (v6.10)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	test('Phase 5 maintains correct step ordering (v6.10)', () => {
		const phase5Section = EXECUTE_PROTOCOL;

		// Verify each step exists and is ordered correctly
		// v6.10 step map:
		// 5a = UI DESIGN GATE (conditional)
		// 5b = coder
		// 5c = diff
		// 5d = syntax_check
		// 5e = placeholder_scan
		// 5f = imports
		// 5g = lint
		// 5h = build_check
		// 5i = pre_check_batch (lint:check + secretscan + sast_scan + quality_budget)
		// 5j = reviewer
		// 5k = Security gate
		// 5l = test_engineer - Verification tests
		// 5m = test_engineer - Adversarial tests
		// 5n = COVERAGE CHECK
		// 5o = update_task_status

		const step5c = phase5Section.indexOf('5c.');
		const step5d = phase5Section.indexOf('5d.');
		const step5e = phase5Section.indexOf('5e.');
		const step5f = phase5Section.indexOf('5f.');
		const step5g = phase5Section.indexOf('5g.');
		const step5h = phase5Section.indexOf('5h.');
		const step5i = phase5Section.indexOf('5i.');
		const step5j = phase5Section.indexOf('5j.');
		const step5k = phase5Section.indexOf('5k.');
		const step5l = phase5Section.indexOf('5l.');
		const step5m = phase5Section.indexOf('5m.');

		expect(step5c).toBeLessThan(step5d); // diff < syntax_check
		expect(step5d).toBeLessThan(step5e); // syntax_check < placeholder_scan
		expect(step5e).toBeLessThan(step5f); // placeholder_scan < imports
		expect(step5f).toBeLessThan(step5g); // imports < lint
		expect(step5g).toBeLessThan(step5h); // lint < build_check
		expect(step5h).toBeLessThan(step5i); // build_check < pre_check_batch
		expect(step5i).toBeLessThan(step5j); // pre_check_batch < reviewer
		expect(step5j).toBeLessThan(step5k); // reviewer < security
		expect(step5k).toBeLessThan(step5l); // security < verification
		expect(step5l).toBeLessThan(step5m); // verification < adversarial
	});

	test('Full QA sequence in Rule 7 includes pre_check_batch', () => {
		const qaGate =
			prompt.match(/7\. \*\*TIERED QA GATE\*\*.*?(?=6f\.)/s)?.[0] || '';

		// Verify the sequence contains all required tools
		expect(qaGate).toContain('diff → syntax_check → placeholder_scan');
		expect(qaGate).toContain('lint');
		expect(qaGate).toContain('build_check');
		expect(qaGate).toContain('pre_check_batch');
		expect(qaGate).toContain('reviewer');
		expect(qaGate).toContain('security review');
		expect(qaGate).toContain('test_engineer verification');
		expect(qaGate).toContain('test_engineer adversarial');
	});

	test('Rule 7 sequence mentions lint:check as part of pre_check_batch', () => {
		// Look for lint:check in the pre_check_batch description
		// The prompt contains "lint:check (code quality verification)" after pre_check_batch
		expect(prompt).toContain('lint:check');
	});

	test('imports is in detailed Rule 7 steps', () => {
		// The detailed steps after the short sequence should mention imports
		const rule7Section = prompt.substring(
			prompt.indexOf('TIERED QA GATE'),
			prompt.indexOf('### MODE: PHASE-WRAP'),
		);
		expect(rule7Section).toContain('imports');
	});
});
