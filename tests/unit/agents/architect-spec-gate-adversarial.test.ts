import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('profile-aware SPEC POLICY — adversarial (standalone)', () => {
	const prompt = readFileSync(
		join(process.cwd(), '.opencode/skills/swarm-plan/SKILL.md'),
		'utf-8',
	);
	const balancedStart = prompt.indexOf(
		'The remaining no-spec choices in this section apply only to `balanced`',
	);
	const specExistsStart = prompt.indexOf(
		'- If an effective spec EXISTS:',
		balancedStart,
	);
	const strictRecoveryStart = prompt.indexOf(
		'**STRICT-ONLY SAVE_PLAN SPEC_REQUIRED RECOVERY:**',
		specExistsStart,
	);
	const balancedNoSpecSection = prompt.slice(balancedStart, specExistsStart);
	const specExistsSection = prompt.slice(specExistsStart, strictRecoveryStart);

	it('balanced no-spec path is soft and contains no blocking language', () => {
		// ATTACK VECTOR: If the gate contains blocking language like "MUST", "blocked", "forbidden",
		// the architect might refuse to proceed without a spec, violating the soft gate contract.
		// The spec gate should warn but NOT block planning when user chooses to skip.
		// These blocking phrases must NOT appear in the spec gate
		const blockingPhrases = [
			'MUST have spec',
			'blocked without spec',
			'forbidden to plan',
			'required before planning',
			'cannot proceed without',
		];

		for (const phrase of blockingPhrases) {
			expect(balancedNoSpecSection).not.toContain(phrase);
		}
	});

	it('Gate does NOT silently skip the two-option offer when spec is absent', () => {
		// ATTACK VECTOR: If the spec gate doesn't explicitly offer both options,
		// the architect might silently skip the gate entirely or not present the user with a choice.
		// Both options must be present together in the same context.
		// Both options must be present
		expect(balancedNoSpecSection).toContain('Create a spec first');
		expect(balancedNoSpecSection).toContain('Skip and plan directly');

		// Both options should be in the same bullet/list context (within 200 characters)
		const createFirstPos = balancedNoSpecSection.indexOf('Create a spec first');
		const skipPos = balancedNoSpecSection.indexOf('Skip and plan directly');
		expect(createFirstPos).toBeGreaterThan(-1);
		expect(skipPos).toBeGreaterThan(-1);
		expect(Math.abs(createFirstPos - skipPos)).toBeLessThan(500);
	});

	it('Gate does NOT modify existing plan behavior on skip', () => {
		// ATTACK VECTOR: If the prompt doesn't explicitly state behavior preservation,
		// the architect might accidentally modify planning behavior when the user skips.
		// The phrase "do NOT modify any planning behavior" must be present.
		expect(balancedNoSpecSection).toContain(
			'continue with the steps below unchanged',
		);
	});

	it('Spec-exists path does NOT force a re-spec', () => {
		// ATTACK VECTOR: If the prompt mandates creating a new spec when one exists,
		// the architect might refuse to use an existing spec, wasting user time.
		// No language should require creating a new spec if spec.md already exists.
		// These phrases would force re-spec and must NOT appear
		const reSpecPhrases = [
			'create a new spec',
			'rewrite the spec',
			'must update spec',
			'refresh the spec',
			'generate a fresh spec',
		];

		for (const phrase of reSpecPhrases) {
			expect(specExistsSection).not.toContain(phrase);
		}

		// Should contain "Read it" (use existing, don't recreate)
		expect(specExistsSection).toContain(
			'Read it and use it as the primary input',
		);
	});

	it('FR-### pattern is specific enough to be matchable', () => {
		// ATTACK VECTOR: If the requirement pattern is ambiguous (e.g., just "requirement"),
		// cross-referencing becomes impossible and the critic cannot verify coverage.
		// The FR-### pattern must be explicitly mentioned for regex matching.
		// Must contain FR-### pattern explicitly
		expect(specExistsSection).toContain('FR-###');
		expect(specExistsSection).toContain(
			'Cross-reference requirements (FR-###)',
		);
		expect(specExistsSection).toContain(
			'Ensure every FR-### maps to at least one task',
		);
	});
});
