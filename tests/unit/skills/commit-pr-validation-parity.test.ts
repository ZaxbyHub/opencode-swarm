import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMMIT_PR_SKILL_PATH = join(
	import.meta.dir,
	'../../../.claude/skills/commit-pr/SKILL.md',
);

const CANONICAL_SCRIPTS = [
	'bun run typecheck',
	'bun run lint:ci',
	'bun run build',
	'scripts/check-tool-registration.ts',
	'scripts/check-mock-cleanup.sh',
	'scripts/check-invariants.sh',
	'scripts/check-cross-contamination.sh',
	'scripts/check-test-clock.sh',
	'bun run test:unit:ci',
] as const;

describe('commit-pr validation suite parity (FR-006)', () => {
	// SC-016: All 9 canonical scripts are referenced in the commit-pr skill
	test('every canonical script appears in the commit-pr mandatory validation suite', () => {
		const content = readFileSync(COMMIT_PR_SKILL_PATH, 'utf-8');
		for (const script of CANONICAL_SCRIPTS) {
			expect(content).toContain(script);
		}
	});

	// SC-017: Canonical script count assertion
	test('canonical script list has exactly 9 entries', () => {
		expect(CANONICAL_SCRIPTS).toHaveLength(9);
	});
});
