import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILL_PATH = resolve('.opencode/skills/generated/pr-readiness/SKILL.md');

describe('pr-readiness skill file', () => {
	let content: string;

	test('file exists', () => {
		expect(() => readFileSync(SKILL_PATH, 'utf-8')).not.toThrow();
		content = readFileSync(SKILL_PATH, 'utf-8');
	});

	test('contains all 12 checklist items', () => {
		const items = [
			'1. Lint pass',
			'2. Build pass',
			'3. Test pass',
			'4. Pre-check batch green',
			'5. CI green',
			'6. Release fragment present',
			'7. Invariant audit',
			'8. No TODOs',
			'9. Secret scan clean',
			'10. SAST scan clean',
			'11. Review state',
			'12. No merge conflicts',
		];
		for (const item of items) {
			expect(content).toContain(item);
		}
	});

	test('references required tools', () => {
		const tools = [
			'lint',
			'build_check',
			'test_runner',
			'pre_check_batch',
			'placeholder_scan',
			'secretscan',
			'sast_scan',
		];
		for (const tool of tools) {
			expect(content).toContain(tool);
		}
	});

	test('references gh CLI commands', () => {
		expect(content).toContain('gh pr checks');
		expect(content).toContain('gh pr view');
		expect(content).toContain('--json statusCheckRollup');
		expect(content).toContain('reviewDecision');
		expect(content).toContain('--json mergeable');
	});

	test('contains invariant audit template', () => {
		expect(content).toContain('## Invariant audit');
		expect(content).toContain('- 1 (plugin init):');
		expect(content).toContain('- 2 (runtime portability):');
		expect(content).toContain('- 3 (subprocesses):');
		expect(content).toContain('- 4 (.swarm containment):');
		expect(content).toContain('- 5 (plan durability):');
		expect(content).toContain('- 6 (test_runner safety):');
		expect(content).toContain('- 7 (test writing):');
		expect(content).toContain('- 8 (session state):');
		expect(content).toContain('- 9 (guardrails/retry):');
		expect(content).toContain('- 10 (chat/system msg):');
		expect(content).toContain('- 11 (tool registration):');
		expect(content).toContain('- 12 (release/cache):');
	});
});
